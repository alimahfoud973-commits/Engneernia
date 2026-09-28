import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { insertProductsWithVersion } from '@/db/testing/product-versions';
import { withFinancialPurge } from '@/db/testing/financial-purge';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements, invoices,
  ledgerLines, orderItemContributors, orderItems, orders, paymentMethods, payments,
  productContributors, productPrices, products, productVersions, settings, settlements, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { myPurchases, purchaseState } from '@/commerce/queries';
import { changeProductStatus, setProductContributors } from '@/catalog/products';
import { productBySlug } from '@/catalog/public-queries';
import { saveCommissionAgreement } from '@/finance/commissions';
import { contributorSaleLines, contributorStatement } from '@/finance/balances';
import { salesHistory } from '@/finance/sales-history';
import { setEngineerActive } from '@/contributors/admin';
import { myStatements, statementDocument } from '@/settlements/queries';
import { NotFoundError } from '@/lib/errors';
import { GUEST, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * STAGE 5 — THE OWNER'S FINAL DECISIONS, PROVEN THROUGH THE SALE PATH
 * ===========================================================================
 *   Test A      the price is the final price, tax included
 *   Tests B–E   fixed commissions under the 50% upgrade discount, co-authored,
 *               and a fixed amount for both sides at once (FIXED_BOTH)
 *   Tests F–G   a deactivated engineer: a month on the platform unsellable,
 *               then owner-only deletion that removes no financial record
 *
 * The 50% cases are REAL upgrades: a buyer of version 1 buys version 2 at the
 * price `catalog.upgradeDiscountBp` gives, and the owner approves the payment.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  discipline: randomUUID(),
  method: randomUUID(),
  userT: randomUUID(), contribT: randomUUID(),   // percentage, for the tax test
  userP: randomUUID(), contribP: randomUUID(),   // fixed platform $20          — B
  userE: randomUUID(), contribE: randomUUID(),   // fixed engineer $30          — C
  userA: randomUUID(), contribA: randomUUID(),   // fixed engineer $20, 60%     — D
  userB: randomUUID(), contribB: randomUUID(),   // fixed engineer $20, 40%     — D
  userX: randomUUID(), contribX: randomUUID(),   // platform $20 + engineer $30 — E
  userD: randomUUID(), contribD: randomUUID(),   // deactivated                 — F, G
  userO: randomUUID(), contribO: randomUUID(),   // another engineer            — F
  pTax: randomUUID(), pB: randomUUID(), pC: randomUUID(), pD: randomUUID(), pE: randomUUID(),
  pCap: randomUUID(), pDeact: randomUUID(), pNew: randomUUID(),
  stmtD: randomUUID(),
};
const slug = (key: string) => `s5f-${key}-${suffix}`;

const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
} as const;
let owner: Actor;
let OWNER_RAW: { actorId: string; actorRole: string };
const engineer = (userId: string, contributorId: string, active = true): Actor => ({
  ...base, userId, role: 'CONTRIBUTOR', contributorId, contributorActive: active,
});
const buyers: string[] = [];
let seededTax: unknown = null;

async function newBuyer(): Promise<Actor> {
  const id = randomUUID();
  buyers.push(id);
  await withRawActorContext(OWNER_RAW, (tx) => tx.insert(users).values({
    id, email: `s5f-c${buyers.length}+${suffix}@test.local`, passwordHash: 'x',
    role: 'CUSTOMER', status: 'ACTIVE', displayName: `Customer ${buyers.length}`, countryCode: 'SY',
  }));
  return { ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false };
}

async function buyAndApprove(buyer: Actor, key: string): Promise<string> {
  const { orderId } = await createOrder(buyer, { productSlugs: [slug(key)] });
  await placeOrder(buyer, { orderId, paymentMethodId: ids.method });
  const [p] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)));
  await approvePayment(owner, { paymentId: p!.id });
  return orderId;
}

/** A full-price sale of V1, then version 2, then the same buyer's upgrade. */
async function fullThenUpgrade(key: string, productId: string) {
  const buyer = await newBuyer();
  const full = await buyAndApprove(buyer, key);
  await withRawActorContext(OWNER_RAW, async (tx) => {
    const [v2] = await tx.insert(productVersions)
      .values({ productId, versionNo: 2, activatedAt: new Date() })
      .returning({ id: productVersions.id });
    await tx.update(products).set({ currentVersionId: v2!.id }).where(eq(products.id, productId));
  });
  const upgrade = await buyAndApprove(buyer, key);
  return { buyer, full, upgrade };
}

async function splitOf(orderId: string) {
  const [line] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)));
  const rows = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItemContributors).where(eq(orderItemContributors.orderItemId, line!.id)));
  return { line: line!, split: new Map(rows.map((r) => [r.contributorId, r])) };
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return ''; } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) { parts.push(current.message); current = (current as { cause?: unknown }).cause; }
    return parts.join(' | ');
  }
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    const [rate] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, 'tax.rateBp'));
    seededTax = rate?.value ?? 0;
    await tx.update(settings).set({ value: 0 }).where(eq(settings.key, 'tax.rateBp'));
    await tx.update(settings).set({ value: 5000 }).where(eq(settings.key, 'catalog.upgradeDiscountBp'));

    const people = [
      [ids.userT, ids.contribT, 'T'], [ids.userP, ids.contribP, 'P'], [ids.userE, ids.contribE, 'E'],
      [ids.userA, ids.contribA, 'A'], [ids.userB, ids.contribB, 'B'], [ids.userX, ids.contribX, 'X'],
      [ids.userD, ids.contribD, 'D'], [ids.userO, ids.contribO, 'O'],
    ] as const;
    await tx.insert(users).values(people.map(([id, , n]) => ({
      id, email: `s5f-${n.toLowerCase()}+${suffix}@test.local`, passwordHash: 'x',
      role: 'CONTRIBUTOR' as const, status: 'ACTIVE' as const, displayName: `Engineer ${n}`,
    })));
    await tx.insert(contributors).values(people.map(([userId, id, n]) => ({
      id, userId, publicSlug: `s5f-${n.toLowerCase()}-${suffix}`, settlementCode: `SF${n}${suffix}`,
      displayName: `Engineer ${n}`, isActive: true,
    })));
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `s5f-disc-${suffix}`, nameAr: 'تخصص القرارات النهائية', nameEn: 'S5F', sortOrder: 96,
    });
    const product = (id: string, key: string, title: string) => ({
      id, slug: slug(key), titleAr: title, disciplineId: ids.discipline, fileType: 'PDF' as const,
      status: 'PUBLISHED' as const, currency: 'USD', publishedAt: new Date(),
    });
    await insertProductsWithVersion(tx, [
      product(ids.pTax, 'tax', 'منتج بعشرة دولارات'), product(ids.pB, 'b', 'منصة ثابتة'),
      product(ids.pC, 'c', 'مهندس ثابت'), product(ids.pD, 'd', 'مشترك ثابت'),
      product(ids.pE, 'e', 'ثابتان معاً'), product(ids.pCap, 'cap', 'ثابتان يتجاوزان السعر'),
      product(ids.pDeact, 'deact', 'منتج المهندس الموقوف'), product(ids.pNew, 'new', 'منتج جديد'),
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.pTax, contributorId: ids.contribT, shareBp: 10000 },
      { productId: ids.pB, contributorId: ids.contribP, shareBp: 10000 },
      { productId: ids.pC, contributorId: ids.contribE, shareBp: 10000 },
      { productId: ids.pD, contributorId: ids.contribA, shareBp: 6000 },
      { productId: ids.pD, contributorId: ids.contribB, shareBp: 4000 },
      { productId: ids.pE, contributorId: ids.contribX, shareBp: 10000 },
      { productId: ids.pCap, contributorId: ids.contribX, shareBp: 10000 },
      { productId: ids.pDeact, contributorId: ids.contribD, shareBp: 10000 },
      { productId: ids.pNew, contributorId: ids.contribO, shareBp: 10000 },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.pTax, amountMinor: 1_000n, currency: 'USD' },
      ...[ids.pB, ids.pC, ids.pD, ids.pE, ids.pDeact, ids.pNew].map((productId) => ({
        productId, amountMinor: 10_000n, currency: 'USD',
      })),
      { productId: ids.pCap, amountMinor: 1_000n, currency: 'USD' },
    ]);
    const common = { productId: null, currency: 'USD', createdBy: ids.owner };
    await tx.insert(commissionAgreements).values([
      { ...common, contributorId: ids.contribT, model: 'PERCENTAGE', engineerBp: 3000 },
      { ...common, contributorId: ids.contribP, model: 'FIXED_PLATFORM', platformFixedMinor: 2_000n },
      { ...common, contributorId: ids.contribE, model: 'FIXED_ENGINEER', engineerFixedMinor: 3_000n },
      { ...common, contributorId: ids.contribA, model: 'FIXED_ENGINEER', engineerFixedMinor: 2_000n },
      { ...common, contributorId: ids.contribB, model: 'FIXED_ENGINEER', engineerFixedMinor: 2_000n },
      { ...common, contributorId: ids.contribD, model: 'PERCENTAGE', engineerBp: 4000 },
      { ...common, contributorId: ids.contribO, model: 'PERCENTAGE', engineerBp: 5000 },
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `s5f-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل', instructionsAr: 'حوّل', accountDetailsAr: 'IBAN TEST', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });

  // Test E's terms are written through the owner's own service: the new model
  // must be savable the way the owner will save it.
  await saveCommissionAgreement(owner, {
    contributorId: ids.contribX, productId: null,
    agreement: { model: 'FIXED_BOTH', engineerFixedMinor: 3_000n, platformFixedMinor: 2_000n, currency: 'USD' },
  });
}, 180_000);

afterAll(async () => {
  await withFinancialPurge(async (tx) => {
    const contribIds = [ids.contribT, ids.contribP, ids.contribE, ids.contribA, ids.contribB, ids.contribX, ids.contribD, ids.contribO];
    const productIds = [ids.pTax, ids.pB, ids.pC, ids.pD, ids.pE, ids.pCap, ids.pDeact, ids.pNew];
    await tx.update(settings).set({ value: seededTax ?? 0 }).where(eq(settings.key, 'tax.rateBp'));
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
      ...buyers, ids.userT, ids.userP, ids.userE, ids.userA, ids.userB, ids.userX, ids.userD, ids.userO,
    ]));
  });
  await closeDb();
}, 60_000);

// ===========================================================================
describe('Test A — the product price is the final price, tax included', () => {
  it('a $10 product at an 11% tax rate costs the customer $10: the tax is inside it, never added on top', async () => {
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(settings).set({ value: 1100 }).where(eq(settings.key, 'tax.rateBp')));
    try {
      const buyer = await newBuyer();
      const { orderId, totalMinor } = await createOrder(buyer, { productSlugs: [slug('tax')] });
      expect(totalMinor).toBe(1_000n);
      await placeOrder(buyer, { orderId, paymentMethodId: ids.method });
      const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
        tx.select().from(payments).where(eq(payments.orderId, orderId)));
      expect(payment!.amountMinor).toBe(1_000n);
      await approvePayment(owner, { paymentId: payment!.id });

      const { line } = await splitOf(orderId);
      expect(line.unitPriceMinor).toBe(1_000n);
      expect(line.taxMinor! + line.netMinor!).toBe(1_000n);         // tax inside the $10
      expect(line.taxMinor).toBeGreaterThan(0n);
      expect(line.engineerAmountMinor! + line.platformAmountMinor!).toBe(line.netMinor!);
      const [order] = await withRawActorContext(OWNER_RAW, (tx) =>
        tx.select({ total: orders.totalMinor }).from(orders).where(eq(orders.id, orderId)));
      expect(order!.total).toBe(1_000n);
      const [invoice] = await withRawActorContext(OWNER_RAW, (tx) =>
        tx.select().from(invoices).where(eq(invoices.orderId, orderId)));
      expect(invoice!.grossMinor).toBe(1_000n);
      const cash = await withRawActorContext(OWNER_RAW, (tx) => tx.execute(sql`
        SELECT SUM(l.amount_minor)::text AS cash FROM ledger_lines l
          JOIN ledger_transactions t ON t.id = l.transaction_id
         WHERE t.reference_id = ${orderId}::uuid AND l.account_code = 'PLATFORM_CASH'
      `)) as unknown as Array<{ cash: string }>;
      expect(BigInt(cash[0]!.cash)).toBe(1_000n);
    } finally {
      await withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(settings).set({ value: 0 }).where(eq(settings.key, 'tax.rateBp')));
    }
  });
});

// ===========================================================================
describe('Tests B–E — fixed commissions, through a real 50% upgrade', () => {
  it('Test B — fixed platform $20 on $100: $20 at full price, $10 on the $50 upgrade', async () => {
    const { full, upgrade } = await fullThenUpgrade('b', ids.pB);
    expect((await splitOf(full)).line).toMatchObject({ platformAmountMinor: 2_000n, engineerAmountMinor: 8_000n });
    const { line, split } = await splitOf(upgrade);
    expect(line).toMatchObject({ unitPriceMinor: 10_000n, discountMinor: 5_000n, platformAmountMinor: 1_000n, engineerAmountMinor: 4_000n });
    expect(split.get(ids.contribP)!.commissionRequestedMinor).toBe(1_000n);
  });

  it('Test C — fixed engineer $30 on $100: $30 at full price, $15 on the $50 upgrade', async () => {
    const { full, upgrade } = await fullThenUpgrade('c', ids.pC);
    expect((await splitOf(full)).line.engineerAmountMinor).toBe(3_000n);
    const { line } = await splitOf(upgrade);
    expect(line).toMatchObject({ discountMinor: 5_000n, engineerAmountMinor: 1_500n, platformAmountMinor: 3_500n });
  });

  it('Test D — fixed engineer $20 shared 60/40: $12 and $8, then $6 and $4 at half price', async () => {
    const { full, upgrade } = await fullThenUpgrade('d', ids.pD);
    const f = (await splitOf(full)).split;
    expect(f.get(ids.contribA)!.amountMinor).toBe(1_200n);
    expect(f.get(ids.contribB)!.amountMinor).toBe(800n);
    const u = (await splitOf(upgrade)).split;
    expect(u.get(ids.contribA)!.amountMinor).toBe(600n);
    expect(u.get(ids.contribB)!.amountMinor).toBe(400n);
  });

  it('Test E — platform $20 + engineer $30, paid $50: fixed $10 + $15 = $25, and the $50 shared 20:30', async () => {
    const { full, upgrade } = await fullThenUpgrade('e', ids.pE);
    // Full price $100: fixed $20 + $30, the $50 above them shared 20:30.
    expect((await splitOf(full)).line).toMatchObject({ platformAmountMinor: 4_000n, engineerAmountMinor: 6_000n });

    const { line, split } = await splitOf(upgrade);
    const x = split.get(ids.contribX)!;
    expect(line.unitPriceMinor - line.discountMinor).toBe(5_000n);
    // The fixed commissions after the discount: platform $10, engineer $15.
    expect(x.commissionModel).toBe('FIXED_BOTH');
    expect(x.engineerFixedMinor).toBe(3_000n);
    expect(x.platformFixedMinor).toBe(2_000n);
    expect(x.commissionRequestedMinor).toBe(2_500n);
    // Booked: the fixed $10 + $15 plus the remaining $25 in the same ratio.
    expect(x.platformAmountMinor).toBe(2_000n);
    expect(x.amountMinor).toBe(3_000n);
    expect(x.amountMinor + x.platformAmountMinor!).toBeLessThanOrEqual(5_000n);
    expect(x.commissionClamped).toBe(false);
  });

  it('both fixed amounts above what was paid: the sale completes, capped, and the owner sees asked vs given', async () => {
    const buyer = await newBuyer();
    const orderId = await buyAndApprove(buyer, 'cap');
    const { line, split } = await splitOf(orderId);
    const x = split.get(ids.contribX)!;
    expect(x.commissionClamped).toBe(true);
    expect(x.commissionRequestedMinor).toBe(5_000n);          // asked: $50
    expect(x.amountMinor + x.platformAmountMinor!).toBe(1_000n); // given: the $10 paid
    expect(x.amountMinor).toBe(600n);
    expect(x.platformAmountMinor).toBe(400n);
    expect(line.commissionClamped).toBe(true);
    const history = await salesHistory(owner, { contributorId: ids.contribX, cappedOnly: true });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({ clamped: true, requestedMinor: 5_000n, engineerMinor: 600n, platformMinor: 400n });
  });
});

// ===========================================================================
describe('Tests F and G — a deactivated engineer, a month on hold, then owner-only deletion', () => {
  const inactiveD = () => engineer(ids.userD, ids.contribD, false);
  let historicalOrder = '';
  let historicalBuyer: Actor;
  let balanceBefore = 0n;

  it('F1 — the engineer has a product and a historical sale, and a statement', async () => {
    historicalBuyer = await newBuyer();
    historicalOrder = await buyAndApprove(historicalBuyer, 'deact');
    balanceBefore = (await contributorStatement(owner, ids.contribD))
      .balances.find((b) => b.currency === 'USD')!.balanceMinor;
    expect(balanceBefore).toBe(4_000n);
    await withRawActorContext(OWNER_RAW, (tx) => tx.insert(settlements).values({
      id: ids.stmtD, reference: `S5F-D-${suffix}`, contributorId: ids.contribD, contributorName: 'Engineer D',
      periodKey: '2026-03', periodStart: new Date('2026-02-28T21:00:00Z'), periodEndExclusive: new Date('2026-03-31T21:00:00Z'),
      currency: 'USD', status: 'APPROVED', periodSalesMinor: 0n, periodRefundsMinor: 0n, periodAdjustmentsMinor: 0n,
      periodGrossSalesMinor: 0n, carriedForwardMinor: 0n, netDueMinor: 0n, balanceMinor: 0n, minimumPayoutMinor: 0n,
      approvedAt: new Date(), approvedBy: ids.owner,
    }));
  });

  it('F2 — deactivation dates itself, and the date cannot be moved by writing it', async () => {
    await setEngineerActive(owner, { contributorId: ids.contribD, isActive: false });
    const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ at: contributors.deactivatedAt }).from(contributors).where(eq(contributors.id, ids.contribD)));
    expect(row!.at).not.toBeNull();
    expect(Date.now() - row!.at!.getTime()).toBeLessThan(60_000);
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(contributors).set({ deactivatedAt: new Date('2000-01-01') }).where(eq(contributors.id, ids.contribD)));
    const [still] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ at: contributors.deactivatedAt }).from(contributors).where(eq(contributors.id, ids.contribD)));
    expect(still!.at!.getTime()).toBe(row!.at!.getTime());
  });

  it('F3 — the product cannot be purchased, and the page says so to buyers and guests', async () => {
    const buyer = await newBuyer();
    await expect(createOrder(buyer, { productSlugs: [slug('deact')] })).rejects.toThrow('غير متاح للشراء حالياً');
    expect(await purchaseState(buyer, ids.pDeact)).toEqual({ kind: 'ON_HOLD' });
    expect(await purchaseState(GUEST, ids.pDeact)).toEqual({ kind: 'ON_HOLD' });
    // The buyer who already owns it still owns it.
    expect((await purchaseState(historicalBuyer, ids.pDeact)).kind).toBe('OWNED');
    // A product of an active engineer is untouched.
    expect(await purchaseState(buyer, ids.pNew)).toEqual({ kind: 'BUYABLE' });
  });

  it('F4 — the product remains on the platform during the month', async () => {
    const page = await productBySlug(slug('deact'));
    expect(page).not.toBeNull();
    const [p] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ status: products.status }).from(products).where(eq(products.id, ids.pDeact)));
    expect(p!.status).toBe('PUBLISHED');
  });

  it('F5/F6 — the historical sale and the buyer’s entitlement are intact', async () => {
    const { split } = await splitOf(historicalOrder);
    expect(split.get(ids.contribD)).toMatchObject({ amountMinor: 4_000n, platformAmountMinor: 6_000n });
    const mine = await myPurchases(historicalBuyer);
    expect(mine.owned.some((o) => o.productSlug === slug('deact') && o.downloadable)).toBe(true);
    expect((await contributorStatement(owner, ids.contribD)).balances.find((b) => b.currency === 'USD')!.balanceMinor)
      .toBe(balanceBefore);
  });

  it('F7 — the engineer reads their own history, read-only', async () => {
    expect((await contributorStatement(inactiveD())).balances.find((b) => b.currency === 'USD')!.balanceMinor).toBe(4_000n);
    expect((await contributorSaleLines(inactiveD())).map((l) => l.engineerMinor)).toEqual([4_000n]);
    expect((await myStatements(inactiveD())).map((s) => s.id)).toContain(ids.stmtD);
    await withRawActorContext(
      { actorId: ids.userD, actorRole: 'CONTRIBUTOR', contributorId: '', financialContributorId: ids.contribD },
      (tx) => tx.execute(sql`UPDATE settlements SET note = 'x' WHERE id = ${ids.stmtD}`),
    );
    const [s] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ note: settlements.note }).from(settlements).where(eq(settlements.id, ids.stmtD)));
    expect(s!.note).toBeNull();
  });

  it('F8 — no new attribution is possible', async () => {
    await expect(setProductContributors(owner, ids.pNew, [{ contributorId: ids.contribD, shareBp: 10000 }]))
      .rejects.toThrow('لا يُنسب منتج إلى مهندس موقوف');
  });

  it('F9 — another engineer cannot reach the deactivated engineer’s data', async () => {
    const other = engineer(ids.userO, ids.contribO);
    await expect(contributorStatement(other, ids.contribD)).rejects.toBeInstanceOf(NotFoundError);
    await expect(contributorSaleLines(other, ids.contribD)).rejects.toBeInstanceOf(NotFoundError);
    expect(await statementDocument(other, ids.stmtD)).toBeNull();
  });

  it('F10 — only the owner deletes, and only after the month', async () => {
    // Deleting is archiving; a published product is unpublished first.
    await changeProductStatus(owner, { productId: ids.pDeact, to: 'UNPUBLISHED' });

    // Not the other engineer, not the deactivated one, not a buyer.
    for (const actor of [engineer(ids.userO, ids.contribO), inactiveD(), await newBuyer()]) {
      await expect(changeProductStatus(actor, { productId: ids.pDeact, to: 'ARCHIVED' })).rejects.toThrow();
    }
    // Not the owner, within the month — by the service, and by the database
    // on its own.
    await expect(changeProductStatus(owner, { productId: ids.pDeact, to: 'ARCHIVED' }))
      .rejects.toThrow('يبقى على المنصة شهراً');
    expect(await refusal(() => withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(products).set({ status: 'ARCHIVED' }).where(eq(products.id, ids.pDeact)))))
      .toMatch(/stays on the platform for one month/);

    // A month and a day later (the clock moved as a test fixture may move it).
    await withFinancialPurge((tx) => tx.update(contributors)
      .set({ deactivatedAt: sql`now() - interval '1 month' - interval '1 day'` })
      .where(eq(contributors.id, ids.contribD)));
    await expect(changeProductStatus(owner, { productId: ids.pDeact, to: 'ARCHIVED' })).resolves.toBe('ARCHIVED');
  });

  it('Test G — deleting the product removed no financial record', async () => {
    const [p] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ status: products.status }).from(products).where(eq(products.id, ids.pDeact)));
    expect(p!.status).toBe('ARCHIVED');
    expect(await productBySlug(slug('deact'))).toBeNull(); // gone from the platform

    const { line, split } = await splitOf(historicalOrder);                 // the sale
    expect(line.snapshotTakenAt).not.toBeNull();                            // its snapshot
    expect(split.get(ids.contribD)!.amountMinor).toBe(4_000n);              // the commission
    const [stmt] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: settlements.id }).from(settlements).where(eq(settlements.id, ids.stmtD)));
    expect(stmt).toBeDefined();                                             // the settlement
    const ledger = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ amount: ledgerLines.amountMinor }).from(ledgerLines)
        .where(and(eq(ledgerLines.contributorId, ids.contribD), eq(ledgerLines.kind, 'SALE'))));
    expect(ledger.reduce((n, l) => n - l.amount, 0n)).toBe(4_000n);         // the ledger
    const mine = await myPurchases(historicalBuyer);
    expect(mine.owned.some((o) => o.productSlug === slug('deact') && o.downloadable)).toBe(true); // the entitlement
    const trail = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ action: auditLogs.action }).from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'product'), eq(auditLogs.entityId, ids.pDeact))));
    expect(trail.length).toBeGreaterThanOrEqual(2);                          // the audit trail
    expect((await contributorStatement(inactiveD())).balances.find((b) => b.currency === 'USD')!.balanceMinor)
      .toBe(4_000n);
  });
});
