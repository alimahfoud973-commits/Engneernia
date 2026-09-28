import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { insertProductsWithVersion } from '@/db/testing/product-versions';
import { withFinancialPurge } from '@/db/testing/financial-purge';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements,
  orderItemContributors, orderItems, orders, paymentMethods, payments,
  productContributors, productPrices, products, productVersions, settings,
  settlements, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { changeProductPrice, setProductContributors } from '@/catalog/products';
import { saveCommissionAgreement } from '@/finance/commissions';
import {
  productCommissionCapWarnings, productSaleBlockers, resolveTermsForSale,
} from '@/finance/commission-resolver';
import { contributorSaleLines, contributorSales, contributorStatement } from '@/finance/balances';
import { outstandingPayables, revenueByContributor, revenueByDiscipline } from '@/finance/reports';
import { salesHistory } from '@/finance/sales-history';
import { setEngineerActive } from '@/contributors/admin';
import { cancelSettlement } from '@/settlements/lifecycle';
import { myStatements, statementDocument } from '@/settlements/queries';
import { NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * STAGE 5 REPAIR — THE OWNER'S DECISIONS AND THE AUDIT'S FINDINGS, PROVEN
 * ===========================================================================
 * Each scenario the owner wrote (A–F) runs through the real sale path —
 * createOrder → placeOrder → approvePayment — against the real database, and
 * each finding (S5-01 … S5-11) has a case that fails on the code before the
 * repair. The money is in minor units; the fixture's tax rate is zero so the
 * owner's round numbers are the numbers on the rows.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  discipline: randomUUID(),
  method: randomUUID(),
  // engineers
  userA: randomUUID(), contribA: randomUUID(),     // 30% — scenarios A, B
  userF1: randomUUID(), contribF1: randomUUID(),   // $20 fixed — scenario C (60%)
  userF2: randomUUID(), contribF2: randomUUID(),   // $20 fixed — scenario C (40%)
  userX: randomUUID(), contribX: randomUUID(),     // $30 fixed on a $10 product — D
  userH: randomUUID(), contribH: randomUUID(),     // terms change around a sale — E
  userD: randomUUID(), contribD: randomUUID(),     // deactivated — F
  // products
  pA: randomUUID(), pCo: randomUUID(), pCap: randomUUID(), pH: randomUUID(),
  pD: randomUUID(), pD2: randomUUID(), pSpare: randomUUID(),
  // statements
  stmtD: randomUUID(), stmtA: randomUUID(),
};
const slug = (key: string) => `s5-${key}-${suffix}`;

const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true, totpEnabled: true,
} as const;

let owner: Actor;
let OWNER_RAW: { actorId: string; actorRole: string };
const engineer = (userId: string, contributorId: string, active = true): Actor => ({
  ...base, userId, role: 'CONTRIBUTOR', contributorId, contributorActive: active,
});
const buyers: string[] = [];
let seededTaxRate: unknown = null;

async function newBuyer(): Promise<Actor> {
  const id = randomUUID();
  buyers.push(id);
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.insert(users).values({
      id, email: `s5-cust${buyers.length}+${suffix}@test.local`,
      passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE',
      displayName: `Customer ${buyers.length}`, countryCode: 'SY',
    }),
  );
  return { ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false };
}

async function paymentOf(orderId: string): Promise<string> {
  const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)),
  );
  return row!.id;
}

/** Order and choose how to pay — the sale is then waiting for the owner. */
async function orderAndPlace(buyer: Actor, key: string): Promise<string> {
  const { orderId } = await createOrder(buyer, { productSlugs: [slug(key)] });
  await placeOrder(buyer, { orderId, paymentMethodId: ids.method });
  return orderId;
}

async function lineOf(orderId: string) {
  const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
  );
  return row!;
}

async function splitOf(orderId: string) {
  const line = await lineOf(orderId);
  const rows = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItemContributors).where(eq(orderItemContributors.orderItemId, line.id)),
  );
  return { line, split: new Map(rows.map((r) => [r.contributorId, r])) };
}

async function sell(key: string): Promise<string> {
  const buyer = await newBuyer();
  const orderId = await orderAndPlace(buyer, key);
  await approvePayment(owner, { paymentId: await paymentOf(orderId) });
  return orderId;
}

/** The message and detail of a database refusal, however it is wrapped. */
function messageOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return '';
  } catch (error) {
    return messageOf(error);
  }
}

const orderIds: Record<string, string> = {};

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    // The owner's examples are tax-free round numbers; pin the rate for this run.
    const [rate] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, 'tax.rateBp'));
    seededTaxRate = rate?.value ?? null;
    await tx.update(settings).set({ value: 0 }).where(eq(settings.key, 'tax.rateBp'));
    await tx.update(settings).set({ value: 5000 }).where(eq(settings.key, 'catalog.upgradeDiscountBp'));

    const people = [
      [ids.userA, ids.contribA, 'A'], [ids.userF1, ids.contribF1, 'F1'], [ids.userF2, ids.contribF2, 'F2'],
      [ids.userX, ids.contribX, 'X'], [ids.userH, ids.contribH, 'H'], [ids.userD, ids.contribD, 'D'],
    ] as const;
    await tx.insert(users).values(people.map(([id, , n]) => ({
      id, email: `s5-${n.toLowerCase()}+${suffix}@test.local`, passwordHash: 'x',
      role: 'CONTRIBUTOR' as const, status: 'ACTIVE' as const, displayName: `Engineer ${n}`,
    })));
    await tx.insert(contributors).values(people.map(([userId, id, n]) => ({
      id, userId, publicSlug: `s5-${n.toLowerCase()}-${suffix}`, settlementCode: `S5${n}${suffix}`,
      displayName: `Engineer ${n}`, isActive: true,
    })));
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `s5-disc-${suffix}`, nameAr: 'تخصص المرحلة الخامسة', nameEn: 'S5', sortOrder: 95,
    });
    const product = (id: string, key: string, title: string) => ({
      id, slug: slug(key), titleAr: title, disciplineId: ids.discipline, fileType: 'PDF' as const,
      status: 'PUBLISHED' as const, currency: 'USD', publishedAt: new Date(),
    });
    await insertProductsWithVersion(tx, [
      product(ids.pA, 'a', 'منتج أ'), product(ids.pCo, 'co', 'منتج مشترك'),
      product(ids.pCap, 'cap', 'منتج رخيص'), product(ids.pH, 'h', 'منتج التاريخ'),
      product(ids.pD, 'd', 'منتج الموقوف'), product(ids.pD2, 'd2', 'منتج جديد'),
      product(ids.pSpare, 'spare', 'منتج احتياطي'),
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.pA, contributorId: ids.contribA, shareBp: 10000 },
      { productId: ids.pCo, contributorId: ids.contribF1, shareBp: 6000 },
      { productId: ids.pCo, contributorId: ids.contribF2, shareBp: 4000 },
      { productId: ids.pCap, contributorId: ids.contribX, shareBp: 10000 },
      { productId: ids.pH, contributorId: ids.contribH, shareBp: 10000 },
      { productId: ids.pD, contributorId: ids.contribD, shareBp: 10000 },
      { productId: ids.pSpare, contributorId: ids.contribA, shareBp: 10000 },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.pA, amountMinor: 10_000n, currency: 'USD' },
      { productId: ids.pCo, amountMinor: 10_000n, currency: 'USD' },
      { productId: ids.pCap, amountMinor: 1_000n, currency: 'USD' },
      { productId: ids.pH, amountMinor: 10_000n, currency: 'USD' },
      { productId: ids.pD, amountMinor: 10_000n, currency: 'USD' },
      { productId: ids.pD2, amountMinor: 10_000n, currency: 'USD' },
      { productId: ids.pSpare, amountMinor: 10_000n, currency: 'USD' },
    ]);
    const pct = (contributorId: string, engineerBp: number) => ({
      contributorId, productId: null, model: 'PERCENTAGE' as const, engineerBp, currency: 'USD', createdBy: ids.owner,
    });
    const fixed = (contributorId: string, engineerFixedMinor: bigint) => ({
      contributorId, productId: null, model: 'FIXED_ENGINEER' as const, engineerFixedMinor, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(commissionAgreements).values([
      pct(ids.contribA, 3000), fixed(ids.contribF1, 2_000n), fixed(ids.contribF2, 2_000n),
      fixed(ids.contribX, 3_000n), pct(ids.contribH, 5000), pct(ids.contribD, 4000),
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `s5-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل', instructionsAr: 'حوّل', accountDetailsAr: 'IBAN TEST', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 180_000);

afterAll(async () => {
  // Superuser + explicit flag: these fixtures became financial history (S5-03).
  await withFinancialPurge(async (tx) => {
    const contribIds = [ids.contribA, ids.contribF1, ids.contribF2, ids.contribX, ids.contribH, ids.contribD];
    const productIds = [ids.pA, ids.pCo, ids.pCap, ids.pH, ids.pD, ids.pD2, ids.pSpare];
    await tx.update(settings).set({ value: seededTaxRate ?? 0 }).where(eq(settings.key, 'tax.rateBp'));
    await tx.delete(settlements).where(inArray(settlements.contributorId, contribIds));
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(inArray(commissionAgreements.contributorId, contribIds));
    await tx.delete(productContributors).where(inArray(productContributors.productId, productIds));
    await tx.delete(products).where(inArray(products.id, productIds));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(inArray(contributors.id, contribIds));
    await tx.delete(users).where(inArray(users.id, [
      ...buyers, ids.userA, ids.userF1, ids.userF2, ids.userX, ids.userH, ids.userD,
    ]));
  });
  await closeDb();
}, 60_000);

// ===========================================================================
describe('Scenario A — percentage: $100 paid at 70/30', () => {
  it('pays the engineer $30 and the platform $70, frozen on the sale', async () => {
    orderIds.a = await sell('a');
    const { line, split } = await splitOf(orderIds.a);
    expect(line.taxMinor).toBe(0n);
    expect(line.engineerAmountMinor).toBe(3_000n);
    expect(line.platformAmountMinor).toBe(7_000n);
    const a = split.get(ids.contribA)!;
    expect(a).toMatchObject({
      sliceMinor: 10_000n, amountMinor: 3_000n, platformAmountMinor: 7_000n,
      commissionModel: 'PERCENTAGE', engineerBp: 3000, commissionClamped: false,
      commissionRequestedMinor: null, productTitle: 'منتج أ',
    });
  });
});

// ===========================================================================
describe('Scenario B — the 50% upgrade: $100 list, $50 paid, 70/30 kept', () => {
  it('a V1 buyer upgrading to V2 pays $50: platform $35, engineer $15 (D-02)', async () => {
    // The buyer of scenario A holds V1. V2 is released.
    const [order] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, orderIds.a!)));
    const buyer: Actor = { ...base, userId: order!.customerId, role: 'CUSTOMER', contributorId: null, contributorActive: false };
    await withRawActorContext(OWNER_RAW, async (tx) => {
      const [v2] = await tx.insert(productVersions)
        .values({ productId: ids.pA, versionNo: 2, activatedAt: new Date() })
        .returning({ id: productVersions.id });
      await tx.update(products).set({ currentVersionId: v2!.id }).where(eq(products.id, ids.pA));
    });

    const { orderId, totalMinor } = await createOrder(buyer, { productSlugs: [slug('a')] });
    expect(totalMinor).toBe(5_000n);
    await placeOrder(buyer, { orderId, paymentMethodId: ids.method });
    await approvePayment(owner, { paymentId: await paymentOf(orderId) });
    orderIds.upgrade = orderId;

    const { line, split } = await splitOf(orderId);
    expect(line).toMatchObject({ isUpgrade: true, unitPriceMinor: 10_000n, discountMinor: 5_000n });
    expect(line.engineerAmountMinor).toBe(1_500n);
    expect(line.platformAmountMinor).toBe(3_500n);
    expect(split.get(ids.contribA)!.engineerBp).toBe(3000); // the original rate, unchanged
  });

  it('a fixed agreement under the same discount keeps its proportion too (D-02 with D-03)', async () => {
    // The approval path's own resolver, with the upgrade discount on the line.
    const terms = await withActor(owner, (tx) => resolveTermsForSale(tx, ids.pCo, 0, 5_000n));
    const f1 = terms.distribution.find((d) => d.contributorId === ids.contribF1)!;
    const f2 = terms.distribution.find((d) => d.contributorId === ids.contribF2)!;
    // $20 fixed for the product, 60/40, at half price: $6 and $4.
    expect(f1.amountMinor).toBe(600n);
    expect(f2.amountMinor).toBe(400n);
    expect(terms.line.engineerAmountMinor + terms.line.platformAmountMinor).toBe(5_000n);
  });
});

// ===========================================================================
describe('Scenario C — fixed $20 on a product shared 60/40', () => {
  it('pays A $12 and B $8 — the fixed amount is the total for all engineers (D-03)', async () => {
    orderIds.co = await sell('co');
    const { line, split } = await splitOf(orderIds.co);
    const f1 = split.get(ids.contribF1)!;
    const f2 = split.get(ids.contribF2)!;
    expect(f1).toMatchObject({ sliceMinor: 6_000n, amountMinor: 1_200n, platformAmountMinor: 4_800n, commissionRequestedMinor: 1_200n, commissionClamped: false });
    expect(f2).toMatchObject({ sliceMinor: 4_000n, amountMinor: 800n, platformAmountMinor: 3_200n, commissionRequestedMinor: 800n, commissionClamped: false });
    expect(line.engineerAmountMinor).toBe(2_000n);
    expect(line.platformAmountMinor).toBe(8_000n);
  });
});

// ===========================================================================
describe('Scenario D — a fixed amount above what was paid (S5-02)', () => {
  it('is warned about before any sale, on the owner’s product page', async () => {
    const warnings = await withActor(owner, (tx) => productCommissionCapWarnings(tx, ids.pCap, 0));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Engineer X');
    expect(await withActor(owner, (tx) => productCommissionCapWarnings(tx, ids.pA, 0))).toEqual([]);
  });

  it('caps at the paid amount: nothing negative, nothing above the sale, and the sale completes', async () => {
    orderIds.cap = await sell('cap');
    const { line, split } = await splitOf(orderIds.cap);
    const x = split.get(ids.contribX)!;
    expect(x.amountMinor).toBe(1_000n);
    expect(x.platformAmountMinor).toBe(0n);
    expect(x.amountMinor + x.platformAmountMinor!).toBe(line.unitPriceMinor - line.discountMinor);
    expect(x.commissionClamped).toBe(true);
    expect(x.commissionRequestedMinor).toBe(3_000n);
    expect(line.commissionClamped).toBe(true);
  });

  it('shows the owner the capped sale and what the agreement had asked for', async () => {
    const history = await salesHistory(owner, { contributorId: ids.contribX, cappedOnly: true });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({ clamped: true, requestedMinor: 3_000n, engineerMinor: 1_000n, platformMinor: 0n });
    expect(history.totals[0]!.clampedRows).toBe(1);
  });
});

// ===========================================================================
describe('Scenario E — the terms are those in force at payment approval (D-04)', () => {
  it('a change made while the payment waits applies to it; a change after does not', async () => {
    const buyer = await newBuyer();
    const orderId = await orderAndPlace(buyer, 'h');

    // Terms change between order and approval: 50% → 60%.
    await saveCommissionAgreement(owner, {
      contributorId: ids.contribH, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 6000, currency: 'USD' },
    });
    await approvePayment(owner, { paymentId: await paymentOf(orderId) });
    orderIds.h = orderId;

    const frozen = (await splitOf(orderId)).split.get(ids.contribH)!;
    expect(frozen).toMatchObject({ engineerBp: 6000, amountMinor: 6_000n, platformAmountMinor: 4_000n });

    // And after approval: 60% → 20%, and the price moves too.
    await saveCommissionAgreement(owner, {
      contributorId: ids.contribH, productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 2000, currency: 'USD' },
    });
    await changeProductPrice(owner, { productId: ids.pH, newAmountMinor: 20_000n, currency: 'USD', reason: 'S5 test' });

    const after = (await splitOf(orderId)).split.get(ids.contribH)!;
    expect(after).toEqual(frozen);
    const history = await salesHistory(owner, { contributorId: ids.contribH });
    expect(history.rows[0]).toMatchObject({ engineerBp: 6000, engineerMinor: 6_000n, listPriceMinor: 10_000n });
  });

  it('the frozen split cannot be edited, even by the owner', async () => {
    const line = await lineOf(orderIds.h!);
    const message = await refusal(() => withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(orderItemContributors).set({ amountMinor: 9_999n })
        .where(eq(orderItemContributors.orderItemId, line.id))));
    expect(message).toMatch(/immutable/);
  });
});

// ===========================================================================
describe('Scenario F — a deactivated engineer (D-05)', () => {
  const inactiveD = () => engineer(ids.userD, ids.contribD, false);
  let balanceBefore = 0n;

  it('has a sale and a statement before deactivation', async () => {
    orderIds.d = await sell('d');
    const statement = await contributorStatement(engineer(ids.userD, ids.contribD));
    balanceBefore = statement.balances.find((b) => b.currency === 'USD')!.balanceMinor;
    expect(balanceBefore).toBe(4_000n);
    await withRawActorContext(OWNER_RAW, (tx) => tx.insert(settlements).values({
      id: ids.stmtD, reference: `S5-D-${suffix}`, contributorId: ids.contribD, contributorName: 'Engineer D',
      periodKey: '2026-01', periodStart: new Date('2025-12-31T21:00:00Z'), periodEndExclusive: new Date('2026-01-31T21:00:00Z'),
      currency: 'USD', status: 'APPROVED', periodSalesMinor: 0n, periodRefundsMinor: 0n, periodAdjustmentsMinor: 0n,
      periodGrossSalesMinor: 0n, carriedForwardMinor: 0n, netDueMinor: 0n, balanceMinor: 0n, minimumPayoutMinor: 0n,
      approvedAt: new Date(), approvedBy: ids.owner,
    }));
    await setEngineerActive(owner, { contributorId: ids.contribD, isActive: false });
  });

  it('keeps the historical sale, the frozen share and the balance owed', async () => {
    const { split } = await splitOf(orderIds.d!);
    expect(split.get(ids.contribD)!.amountMinor).toBe(4_000n);
    const statement = await contributorStatement(owner, ids.contribD);
    expect(statement.balances.find((b) => b.currency === 'USD')!.balanceMinor).toBe(balanceBefore);
  });

  it('reads their own sales, earnings and statements — read-only', async () => {
    const statement = await contributorStatement(inactiveD());
    expect(statement.balances.find((b) => b.currency === 'USD')!.balanceMinor).toBe(4_000n);
    const sales = await contributorSales(inactiveD());
    expect(sales.reduce((n, s) => n + s.engineerMinor, 0n)).toBe(4_000n);
    const lines = await contributorSaleLines(inactiveD());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ engineerRateBp: 4000, platformRateBp: 6000, engineerMinor: 4_000n, platformMinor: 6_000n });
    expect((await myStatements(inactiveD())).map((s) => s.id)).toContain(ids.stmtD);
    expect(await statementDocument(inactiveD(), ids.stmtD)).not.toBeNull();

    // No write reaches their own financial rows.
    await withRawActorContext(
      { actorId: ids.userD, actorRole: 'CONTRIBUTOR', contributorId: '', financialContributorId: ids.contribD },
      (tx) => tx.execute(sql`UPDATE settlements SET note = 'mine' WHERE id = ${ids.stmtD}`),
    );
    const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ note: settlements.note }).from(settlements).where(eq(settlements.id, ids.stmtD)));
    expect(row!.note).toBeNull();
  });

  it('cannot see another engineer — by service or by the database', async () => {
    await expect(contributorStatement(inactiveD(), ids.contribA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(contributorSaleLines(inactiveD(), ids.contribA)).rejects.toBeInstanceOf(NotFoundError);
    const rows = await withRawActorContext(
      { actorId: ids.userD, actorRole: 'CONTRIBUTOR', contributorId: '', financialContributorId: ids.contribD },
      (tx) => tx.execute(sql`SELECT contributor_id FROM order_item_contributors`),
    ) as unknown as Array<{ contributor_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.contributor_id === ids.contribD)).toBe(true);
  });

  it('is not credited on any NEW sale: the product is unsellable while they are inactive', async () => {
    const buyer = await newBuyer();
    await expect(createOrder(buyer, { productSlugs: [slug('d')] })).rejects.toThrow('غير متاح للشراء حالياً');
    const blockers = await withActor(owner, (tx) => productSaleBlockers(tx, ids.pD));
    expect(blockers.map((b) => b.reason)).toContain('INACTIVE_ENGINEER');
    // The database refuses it on its own, whatever path writes the line.
    const message = await refusal(() => withRawActorContext(OWNER_RAW, async (tx) => {
      const [o] = await tx.insert(orders).values({
        orderNumber: `S5-F-${suffix}`, customerId: buyer.kind === 'USER' ? buyer.userId : '', status: 'DRAFT',
        currency: 'USD', subtotalMinor: 10_000n, discountMinor: 0n, totalMinor: 10_000n,
      }).returning({ id: orders.id });
      await tx.insert(orderItems).values({
        orderId: o!.id, productId: ids.pD, titleSnapshot: 'x', unitPriceMinor: 10_000n, currency: 'USD',
      });
    }));
    expect(message).toMatch(/deactivated engineer/);
  });

  it('is not credited on a NEW product, but keeps the credit they already hold', async () => {
    // Refused by the attribution rule itself — before the published-product
    // guard would have had to catch the unsellable result.
    await expect(setProductContributors(owner, ids.pD2, [{ contributorId: ids.contribD, shareBp: 10000 }]))
      .rejects.toThrow('لا يُنسب منتج إلى مهندس موقوف');
    // Re-saving the credit they already have is not a new attribution.
    await expect(setProductContributors(owner, ids.pD, [{ contributorId: ids.contribD, shareBp: 10000 }]))
      .resolves.toBeUndefined();
  });

  it('reactivated, sells again', async () => {
    await setEngineerActive(owner, { contributorId: ids.contribD, isActive: true });
    const buyer = await newBuyer();
    await expect(createOrder(buyer, { productSlugs: [slug('d')] })).resolves.toMatchObject({ totalMinor: 10_000n });
  });
});

// ===========================================================================
describe('S5-01 — owner reports count what was paid, once', () => {
  it('per engineer: a co-authored sale is split by contribution, not counted twice', async () => {
    const rows = await revenueByContributor(owner);
    const f1 = rows.find((r) => r.contributorId === ids.contribF1)!;
    const f2 = rows.find((r) => r.contributorId === ids.contribF2)!;
    expect(f1.grossMinor).toBe(6_000n);
    expect(f2.grossMinor).toBe(4_000n);
    expect(f1.grossMinor + f2.grossMinor).toBe(10_000n); // the one sale, once
    for (const row of [f1, f2]) expect(row.engineerMinor + row.platformMinor).toBe(row.grossMinor);
    // The upgrade counts at what was paid for it: $100 + $50 for engineer A.
    const a = rows.find((r) => r.contributorId === ids.contribA)!;
    expect(a.grossMinor).toBe(15_000n);
  });

  it('per discipline: the paid amount after discount, equal to the sum of what customers paid', async () => {
    const rows = await revenueByDiscipline(owner);
    const mine = rows.find((r) => r.disciplineSlug === `s5-disc-${suffix}`)!;
    const [paid] = await withRawActorContext(OWNER_RAW, (tx) => tx.execute(sql`
      SELECT SUM(oi.unit_price_minor - oi.discount_minor)::text AS paid,
             SUM(oi.unit_price_minor)::text AS listed
        FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE p.discipline_id = ${ids.discipline} AND oi.snapshot_taken_at IS NOT NULL
    `)) as unknown as Array<{ paid: string; listed: string }>;
    expect(mine.grossMinor).toBe(BigInt(paid!.paid));
    expect(mine.grossMinor).toBeLessThan(BigInt(paid!.listed)); // the upgrade's discount is not income
    expect(mine.engineerMinor + mine.platformMinor).toBe(mine.grossMinor); // tax is zero here
  });
});

// ===========================================================================
describe('S5-05 — report order is by amount, numerically', () => {
  it('every owner report is sorted by the number, not its text', async () => {
    const byEngineer = await revenueByContributor(owner);
    for (let i = 1; i < byEngineer.length; i += 1) {
      expect(byEngineer[i - 1]!.engineerMinor >= byEngineer[i]!.engineerMinor).toBe(true);
    }
    const byDiscipline = await revenueByDiscipline(owner);
    for (let i = 1; i < byDiscipline.length; i += 1) {
      expect(byDiscipline[i - 1]!.platformMinor >= byDiscipline[i]!.platformMinor).toBe(true);
    }
    const payables = await outstandingPayables(owner);
    for (let i = 1; i < payables.length; i += 1) {
      expect(payables[i - 1]!.balanceMinor >= payables[i]!.balanceMinor).toBe(true);
    }
    // The audit's own pair: A earned 30.00 + 15.00 = 45.00, F2 earned 8.00.
    // As text "8.00" sorted above "45.00"; as numbers it does not.
    const a = byEngineer.findIndex((r) => r.contributorId === ids.contribA);
    const f2 = byEngineer.findIndex((r) => r.contributorId === ids.contribF2);
    expect(a).toBeLessThan(f2);
  });
});

// ===========================================================================
describe('S5-03 / D-06 — financial history cannot be deleted', () => {
  it('refuses the owner deleting a completed order, its lines, its splits, or its approved payment', async () => {
    const line = await lineOf(orderIds.a!);
    const paymentId = await paymentOf(orderIds.a!);
    for (const attempt of [
      () => withRawActorContext(OWNER_RAW, (tx) => tx.delete(orders).where(eq(orders.id, orderIds.a!))),
      () => withRawActorContext(OWNER_RAW, (tx) => tx.delete(orderItems).where(eq(orderItems.id, line.id))),
      () => withRawActorContext(OWNER_RAW, (tx) =>
        tx.delete(orderItemContributors).where(eq(orderItemContributors.orderItemId, line.id))),
    ]) {
      expect(await refusal(attempt)).toMatch(/financial history is permanent/);
    }
    const { split } = await splitOf(orderIds.a!);
    expect(split.size).toBe(1);

    // No policy grants DELETE on payments to anyone, so the owner's attempt
    // matches nothing; the guard is the layer under that, for a session row
    // security does not bind (a superuser, below).
    await withRawActorContext(OWNER_RAW, (tx) => tx.delete(payments).where(eq(payments.id, paymentId)));
    const client = postgres(process.env.DATABASE_SUPERUSER_URL!, { max: 1, onnotice: () => {} });
    try {
      expect(await refusal(() => client`DELETE FROM payments WHERE id = ${paymentId}`))
        .toMatch(/financial history is permanent/);
    } finally {
      await client.end({ timeout: 5 });
    }
    const [still] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId)));
    expect(still!.status).toBe('APPROVED');
  });

  it('refuses deleting an issued statement, terms a sale was booked under, or an engineer with history', async () => {
    const [agreement] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: commissionAgreements.id }).from(commissionAgreements)
        .where(eq(commissionAgreements.contributorId, ids.contribA)));
    for (const attempt of [
      () => withRawActorContext(OWNER_RAW, (tx) => tx.delete(settlements).where(eq(settlements.id, ids.stmtD))),
      () => withRawActorContext(OWNER_RAW, (tx) =>
        tx.delete(commissionAgreements).where(eq(commissionAgreements.id, agreement!.id))),
      () => withRawActorContext(OWNER_RAW, (tx) => tx.delete(contributors).where(eq(contributors.id, ids.contribA))),
    ]) {
      expect(await refusal(attempt)).toMatch(/financial history is permanent/);
    }
  });

  it('binds the migrator role and a superuser without the explicit flag too', async () => {
    for (const url of [process.env.DATABASE_MIGRATION_URL!, process.env.DATABASE_SUPERUSER_URL!]) {
      const client = postgres(url, { max: 1, onnotice: () => {} });
      try {
        // Declared as the owner so row security (FORCE on orders) shows the
        // row to the migrator: the refusal must come from the guard, not
        // from a DELETE that matched nothing.
        const message = await refusal(() => client.begin(async (tx) => {
          await tx`SELECT set_config('app.actor_role', 'OWNER', true)`;
          const deleted = await tx`DELETE FROM orders WHERE id = ${orderIds.a!}`;
          return deleted.count;
        }));
        expect(message).toMatch(/financial history is permanent/);
      } finally {
        await client.end({ timeout: 5 });
      }
    }
  });

  it('still lets a draft order go — it is not history yet', async () => {
    const buyer = await newBuyer();
    const { orderId } = await createOrder(buyer, { productSlugs: [slug('spare')] });
    await withRawActorContext(OWNER_RAW, (tx) => tx.delete(orders).where(eq(orders.id, orderId)));
    const left = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)));
    expect(left).toHaveLength(0);
  });
});

// ===========================================================================
describe('S5-04 — a closed commission agreement is history', () => {
  it('refuses editing the terms of a closed agreement, and of an open one in place', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contribH)));
    const closed = rows.find((r) => r.effectiveTo !== null)!;
    const open = rows.find((r) => r.effectiveTo === null)!;
    expect(await refusal(() => withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(commissionAgreements).set({ engineerBp: 9000 }).where(eq(commissionAgreements.id, closed.id)))))
      .toMatch(/closed commission agreement cannot be changed/);
    expect(await refusal(() => withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(commissionAgreements).set({ engineerBp: 9000 }).where(eq(commissionAgreements.id, open.id)))))
      .toMatch(/never edited in place/);
    const [still] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ bp: commissionAgreements.engineerBp }).from(commissionAgreements)
        .where(eq(commissionAgreements.id, closed.id)));
    expect(still!.bp).toBe(closed.engineerBp);
  });
});

// ===========================================================================
describe('S5-06 — the database enforces the shapes the application validates', () => {
  it('refuses an agreement whose fields contradict its model, or a negative fixed amount', async () => {
    const insert = (values: Record<string, unknown>) => refusal(() => withRawActorContext(OWNER_RAW, (tx) =>
      tx.insert(commissionAgreements).values({
        contributorId: ids.contribA, productId: ids.pSpare, currency: 'USD', createdBy: ids.owner,
        ...values,
      } as typeof commissionAgreements.$inferInsert)));
    expect(await insert({ model: 'PERCENTAGE', engineerBp: 5000, engineerFixedMinor: 100n }))
      .toMatch(/commission_agreements_model_shape/);
    expect(await insert({ model: 'FIXED_ENGINEER', engineerFixedMinor: -1n }))
      .toMatch(/commission_agreements_model_shape/);
    expect(await insert({ model: 'FIXED_PLATFORM', platformFixedMinor: 100n, engineerBp: 10 }))
      .toMatch(/commission_agreements_model_shape/);
  });

  it('refuses credits that do not total 100% — checked when the change commits', async () => {
    const message = await refusal(() => withRawActorContext(OWNER_RAW, (tx) =>
      tx.insert(productContributors).values({ productId: ids.pD2, contributorId: ids.contribA, shareBp: 5000 })));
    expect(message).toMatch(/share exactly 100%/);
  });
});

// ===========================================================================
describe('S5-07 — the owner’s input is checked by the server', () => {
  it('refuses a rate override for a product the engineer is not credited on', async () => {
    await expect(saveCommissionAgreement(owner, {
      contributorId: ids.contribF1, productId: ids.pA,
      agreement: { model: 'PERCENTAGE', engineerBp: 5000, currency: 'USD' },
    })).rejects.toThrow('غير منسوب إلى هذا المهندس');
    await expect(saveCommissionAgreement(owner, {
      contributorId: ids.contribF1, productId: randomUUID(),
      agreement: { model: 'PERCENTAGE', engineerBp: 5000, currency: 'USD' },
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses crediting an engineer who does not exist — a message, not a raw foreign-key error', async () => {
    await expect(setProductContributors(owner, ids.pD2, [{ contributorId: randomUUID(), shareBp: 10000 }]))
      .rejects.toBeInstanceOf(ValidationError);
  });
});

// ===========================================================================
describe('S5-08 — a cancelled statement is audited as a cancellation', () => {
  it('writes SETTLEMENT_CANCELLED, not SETTLEMENT_GENERATED', async () => {
    await withRawActorContext(OWNER_RAW, (tx) => tx.insert(settlements).values({
      id: ids.stmtA, reference: `S5-A-${suffix}`, contributorId: ids.contribA, contributorName: 'Engineer A',
      periodKey: '2026-02', periodStart: new Date('2026-01-31T21:00:00Z'), periodEndExclusive: new Date('2026-02-28T21:00:00Z'),
      currency: 'USD', status: 'PENDING', periodSalesMinor: 0n, periodRefundsMinor: 0n, periodAdjustmentsMinor: 0n,
      periodGrossSalesMinor: 0n, carriedForwardMinor: 0n, netDueMinor: 0n, balanceMinor: 0n, minimumPayoutMinor: 0n,
    }));
    await cancelSettlement(owner, { settlementId: ids.stmtA, reason: 'اختبار' });
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ action: auditLogs.action }).from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'settlement'), eq(auditLogs.entityId, ids.stmtA))));
    expect(rows.map((r) => r.action)).toEqual(['SETTLEMENT_CANCELLED']);
  });
});

// ===========================================================================
describe('S5-09 — the owner’s sales history is the frozen record', () => {
  it('counts a co-authored sale once in the totals, and each engineer’s row separately', async () => {
    const history = await salesHistory(owner, { contributorId: ids.contribF1 });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({
      productTitle: 'منتج مشترك', versionNo: 1, listPriceMinor: 10_000n, discountMinor: 0n, paidMinor: 10_000n,
      shareBp: 6000, authorCount: 2, sliceMinor: 6_000n, engineerMinor: 1_200n, platformMinor: 4_800n,
      commissionModel: 'FIXED_ENGINEER', engineerFixedMinor: 2_000n, orderStatus: 'COMPLETED', paymentStatus: 'APPROVED',
    });
    expect(history.totals[0]).toMatchObject({ sales: 1, paidMinor: 10_000n, engineerMinor: 1_200n });
  });

  it('shows the upgrade at what was paid, with its discount and version', async () => {
    const history = await salesHistory(owner, { contributorId: ids.contribA });
    const upgrade = history.rows.find((r) => r.isUpgrade)!;
    expect(upgrade).toMatchObject({ versionNo: 2, listPriceMinor: 10_000n, discountMinor: 5_000n, paidMinor: 5_000n, engineerMinor: 1_500n });
  });

  it('is the owner’s alone', async () => {
    await expect(salesHistory(engineer(ids.userA, ids.contribA))).rejects.toBeInstanceOf(RuleViolationError);
    await expect(salesHistory(await newBuyer())).rejects.toBeInstanceOf(RuleViolationError);
    await expect(salesHistory(owner, { periodKey: '2026-13' })).rejects.toBeInstanceOf(ValidationError);
  });
});

// ===========================================================================
describe('D-01 and isolation — an engineer sees their own terms, and nobody else’s', () => {
  it('sees their own rate, the platform’s, and both amounts on each sale', async () => {
    const lines = await contributorSaleLines(engineer(ids.userF1, ids.contribF1));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      productTitle: 'منتج مشترك', shareBp: 6000, sliceMinor: 6_000n,
      engineerMinor: 1_200n, platformMinor: 4_800n, engineerRateBp: 2000, platformRateBp: 8000,
    });
  });

  it('cannot reach a co-author’s figures — not by service, not by id, not by the database', async () => {
    const f1 = engineer(ids.userF1, ids.contribF1);
    await expect(contributorSaleLines(f1, ids.contribF2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(contributorSales(f1, ids.contribF2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(contributorStatement(f1, ids.contribF2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(revenueByContributor(f1)).rejects.toBeInstanceOf(RuleViolationError);
    expect(await statementDocument(f1, ids.stmtD)).toBeNull();

    const RAW_F1 = { actorId: ids.userF1, actorRole: 'CONTRIBUTOR', contributorId: ids.contribF1 };
    for (const table of ['order_item_contributors', 'settlements', 'commission_agreements', 'contributor_ledger_lines']) {
      const rows = await withRawActorContext(RAW_F1, (tx) =>
        tx.execute(sql`SELECT contributor_id FROM ${sql.identifier(table)}`)) as unknown as Array<{ contributor_id: string }>;
      expect(rows.every((r) => r.contributor_id === ids.contribF1), table).toBe(true);
    }
  });

  it('a buyer reads no engineer’s private financial row', async () => {
    const buyer = await newBuyer();
    const RAW_BUYER = { actorId: buyer.kind === 'USER' ? buyer.userId : '', actorRole: 'CUSTOMER' };
    for (const table of [
      'order_item_contributors', 'settlements', 'settlement_lines', 'commission_agreements',
      'contributor_ledger_lines', 'ledger_lines', 'contributors', 'product_contributors',
    ]) {
      const rows = await withRawActorContext(RAW_BUYER, (tx) =>
        tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)}`)) as unknown as unknown[];
      expect(rows, table).toHaveLength(0);
    }
  });
});
