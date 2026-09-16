import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, orderItemContributors,
  orderItems, orders, paymentMethods, payments, productContributors,
  productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { setCommissionAgreement } from '@/finance/commission-resolver';
import { commissionOverview, parsePercentToBp, saveCommissionAgreement } from '@/finance/commissions';
import { contributorSales } from '@/finance/balances';
import { RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * OPEN-15 — A COMMISSION RATE PER ENGINEER
 * ===========================================================================
 * The owner's decision: each credited engineer is paid under THEIR OWN
 * agreement, applied to THEIR OWN slice of the sale.
 *
 *     price → less discount → less tax → NET
 *     NET   → split by credit          → a slice per engineer
 *     slice → that engineer's agreement → their pay + the platform's cut
 *
 * The fixture is deliberately arithmetically awkward: a price that does not
 * divide evenly by the credit split, two different rates, and a third engineer
 * on a fixed agreement. A model that only works on round numbers is a model
 * that will be discovered to be wrong by an accountant.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  userA: randomUUID(), contribA: randomUUID(),
  userB: randomUUID(), contribB: randomUUID(),
  userC: randomUUID(), contribC: randomUUID(),
  discipline: randomUUID(),
  shared: randomUUID(), solo: randomUUID(), trio: randomUUID(), later: randomUUID(),
  method: randomUUID(),
};

/** $100.00, and 3333/6667 of it is not a round number of cents. */
const PRICE = 10_000n;
const A_BP = 8000;   // engineer A keeps 80%
const B_BP = 7000;   // engineer B keeps 70% — a different contract entirely
const C_FIXED = 500n; // engineer C is paid a flat $5.00 of their own slice

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true, totpEnabled: false,
} as const;

let owner: Actor;
const buyers: string[] = [];

async function sell(productId: string, slug: string): Promise<string> {
  const id = randomUUID();
  buyers.push(id);
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.insert(users).values({
      id, email: `pc-cust${buyers.length}+${suffix}@test.local`,
      passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE',
      displayName: `Customer ${buyers.length}`, countryCode: 'SY',
    }),
  );
  const buyer: Actor = {
    ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false,
  };
  const order = await createOrder(buyer, { productSlugs: [slug] });
  await placeOrder(buyer, { orderId: order.orderId, paymentMethodId: ids.method });
  const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)),
  );
  await approvePayment(owner, { paymentId: payment!.id });

  const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, productId))
      .orderBy(sql`created_at DESC`).limit(1),
  );
  return item!.id;
}

/** Every engineer's frozen row for one sold line, keyed by contributor. */
async function splitOf(orderItemId: string) {
  const rows = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItemContributors)
      .where(eq(orderItemContributors.orderItemId, orderItemId)),
  );
  return new Map(rows.map((r) => [r.contributorId, r]));
}

async function lineOf(orderItemId: string) {
  const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItems).where(eq(orderItems.id, orderItemId)),
  );
  return row!;
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.userA, email: `pc-a+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer A' },
      { id: ids.userB, email: `pc-b+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer B' },
      { id: ids.userC, email: `pc-c+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer C' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contribA, userId: ids.userA, publicSlug: `pc-a-${suffix}`, settlementCode: `PCA${suffix}`, displayName: 'Engineer A', isActive: true },
      { id: ids.contribB, userId: ids.userB, publicSlug: `pc-b-${suffix}`, settlementCode: `PCB${suffix}`, displayName: 'Engineer B', isActive: true },
      { id: ids.contribC, userId: ids.userC, publicSlug: `pc-c-${suffix}`, settlementCode: `PCC${suffix}`, displayName: 'Engineer C', isActive: true },
    ]);
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `pc-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 92,
    });
    await tx.insert(products).values([
      { id: ids.shared, slug: `pc-shared-${suffix}`, titleAr: 'مشترك', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.solo, slug: `pc-solo-${suffix}`, titleAr: 'منفرد', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.trio, slug: `pc-trio-${suffix}`, titleAr: 'ثلاثي', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.later, slug: `pc-later-${suffix}`, titleAr: 'لاحق', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
    ]);
    await tx.insert(productContributors).values([
      // 60/40 on the shared product.
      { productId: ids.shared, contributorId: ids.contribA, shareBp: 6000 },
      { productId: ids.shared, contributorId: ids.contribB, shareBp: 4000 },
      { productId: ids.solo, contributorId: ids.contribA, shareBp: 10000 },
      // A three-way split that does NOT divide evenly: 3333/3333/3334.
      { productId: ids.trio, contributorId: ids.contribA, shareBp: 3333 },
      { productId: ids.trio, contributorId: ids.contribB, shareBp: 3333 },
      { productId: ids.trio, contributorId: ids.contribC, shareBp: 3334 },
      { productId: ids.later, contributorId: ids.contribA, shareBp: 5000 },
      { productId: ids.later, contributorId: ids.contribB, shareBp: 5000 },
    ]);
    await tx.insert(productPrices).values(
      [ids.shared, ids.solo, ids.trio, ids.later].map((productId) => ({
        productId, amountMinor: PRICE, currency: 'USD',
      })),
    );
    await tx.insert(commissionAgreements).values([
      { contributorId: ids.contribA, productId: null, model: 'PERCENTAGE', engineerBp: A_BP, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.contribB, productId: null, model: 'PERCENTAGE', engineerBp: B_BP, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.contribC, productId: null, model: 'FIXED_ENGINEER', engineerFixedMinor: C_FIXED, currency: 'USD', createdBy: ids.owner },
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `pc-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 180_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    const productIds = [ids.shared, ids.solo, ids.trio, ids.later];
    const contribIds = [ids.contribA, ids.contribB, ids.contribC];
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(inArray(commissionAgreements.contributorId, contribIds));
    await tx.delete(productContributors).where(inArray(productContributors.productId, productIds));
    await tx.delete(products).where(inArray(products.id, productIds));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(inArray(contributors.id, contribIds));
    await tx.delete(users).where(inArray(users.id, [...buyers, ids.userA, ids.userB, ids.userC]));
  });
  await closeDb();
}, 60_000);


// ===========================================================================
describe('1. each engineer is paid under their own agreement', () => {
  it('pays A at 80% of A’s slice and B at 70% of B’s — on the same sale', async () => {
    const itemId = await sell(ids.shared, `pc-shared-${suffix}`);
    const split = await splitOf(itemId);

    const a = split.get(ids.contribA)!;
    const b = split.get(ids.contribB)!;

    // Net 10000, credited 60/40 → slices of 6000 and 4000.
    expect(a.sliceMinor).toBe(6_000n);
    expect(b.sliceMinor).toBe(4_000n);

    // And each slice meets its OWN rate.
    expect(a.amountMinor).toBe(4_800n);            // 6000 x 80%
    expect(b.amountMinor).toBe(2_800n);            // 4000 x 70%
    expect(a.platformAmountMinor).toBe(1_200n);
    expect(b.platformAmountMinor).toBe(1_200n);

    // The rate each was paid at is frozen beside the money.
    expect(a.engineerBp).toBe(A_BP);
    expect(b.engineerBp).toBe(B_BP);

    /*
     * WHAT THE OLD MODEL WOULD HAVE PAID. The primary author's 80% governed
     * the whole line, so B would have taken 40% of an 8000 pot — 3200 — under
     * a contract B never signed. Stated so the change is visible as a number.
     */
    expect(b.amountMinor).not.toBe(3_200n);
  });

  it('re-adds to the net exactly, and the line agrees with its rows', async () => {
    const itemId = await sell(ids.solo, `pc-solo-${suffix}`);
    const line = await lineOf(itemId);
    const split = await splitOf(itemId);
    const a = split.get(ids.contribA)!;

    // A sole author: the line still carries a model and a rate, because here
    // exactly one agreement governed it.
    expect(line.commissionModel).toBe('PERCENTAGE');
    expect(line.engineerBp).toBe(A_BP);
    expect(a.amountMinor).toBe(8_000n);
    expect(line.engineerAmountMinor).toBe(8_000n);
    expect(line.platformAmountMinor).toBe(2_000n);
  });

  it('leaves the line’s model NULL when no single agreement governed it', async () => {
    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.productId, ids.shared)),
    );
    /*
     * A co-authored line has no model and no rate — there are two. Writing the
     * primary's would name terms that governed only part of the sale, and an
     * auditor reading it would mis-compute every figure beneath it.
     */
    expect(item!.commissionModel).toBeNull();
    expect(item!.engineerBp).toBeNull();
    expect(item!.agreementId).toBeNull();
    // The totals are still there, and still the sum of the rows.
    expect(item!.engineerAmountMinor).toBe(7_600n);   // 4800 + 2800
    expect(item!.platformAmountMinor).toBe(2_400n);   // 1200 + 1200
  });
});

// ===========================================================================
describe('2. the awkward arithmetic', () => {
  it('loses nothing on a 3333/3333/3334 split with three different models', async () => {
    const itemId = await sell(ids.trio, `pc-trio-${suffix}`);
    const line = await lineOf(itemId);
    const split = await splitOf(itemId);

    const rows = [...split.values()];
    // The slices re-add to the net, to the minor unit, despite the thirds.
    expect(rows.reduce((t, r) => t + r.sliceMinor!, 0n)).toBe(10_000n);
    // And every row's own two parts re-add to its own slice.
    for (const r of rows) {
      expect(r.amountMinor + r.platformAmountMinor!).toBe(r.sliceMinor);
    }
    // Which makes the line's totals the sum of the rows, necessarily.
    expect(rows.reduce((t, r) => t + r.amountMinor, 0n)).toBe(line.engineerAmountMinor);
    expect(rows.reduce((t, r) => t + r.platformAmountMinor!, 0n)).toBe(line.platformAmountMinor);
    // The whole equation the database also checks in halves.
    expect(line.engineerAmountMinor! + line.platformAmountMinor! + line.taxMinor!).toBe(PRICE);
  });

  it('caps a fixed agreement against THAT engineer’s slice, not the price', async () => {
    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, ids.trio)),
    );
    const c = (await splitOf(item!.id)).get(ids.contribC)!;

    // C's slice is 3334 and their flat fee is 500, so no cap is needed here —
    // but the fee is taken from their slice and nobody else's.
    expect(c.sliceMinor).toBe(3_334n);
    expect(c.amountMinor).toBe(C_FIXED);
    expect(c.platformAmountMinor).toBe(3_334n - C_FIXED);
    expect(c.commissionClamped).toBe(false);
    expect(c.commissionModel).toBe('FIXED_ENGINEER');
  });

  it('refuses the whole sale when ONE co-author has no agreement', async () => {
    // Not a default rate, and not a sale that pays the others and skips them:
    // §11's rule is that a sale nobody agreed terms for cannot be booked.
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(commissionAgreements)
        .set({ effectiveTo: new Date() })
        .where(eq(commissionAgreements.contributorId, ids.contribB)),
    );

    try {
      await expect(sell(ids.later, `pc-later-${suffix}`)).rejects.toThrow(RuleViolationError);

      // And nothing was half-written: no frozen split for the line.
      const rows = await withRawActorContext(OWNER_RAW, (tx) =>
        tx.select().from(orderItemContributors)
          .innerJoin(orderItems, eq(orderItems.id, orderItemContributors.orderItemId))
          .where(eq(orderItems.productId, ids.later)),
      );
      expect(rows).toHaveLength(0);
    } finally {
      await withRawActorContext(OWNER_RAW, (tx) =>
        tx.insert(commissionAgreements).values({
          contributorId: ids.contribB, productId: null, model: 'PERCENTAGE',
          engineerBp: B_BP, currency: 'USD', createdBy: ids.owner,
        }),
      );
    }
  });
});

// ===========================================================================
describe('3. the owner sets each rate separately, and history does not move', () => {
  it('a product-scoped agreement beats that engineer’s default — for them alone', async () => {
    await withRawActorContext(OWNER_RAW, (tx) =>
      setCommissionAgreement(tx, {
        contributorId: ids.contribA,
        productId: ids.later,
        agreement: { model: 'PERCENTAGE', engineerBp: 9000, currency: 'USD' },
        createdBy: ids.owner,
        note: 'ترقية خاصة بهذا المنتج',
      }),
    );

    const itemId = await sell(ids.later, `pc-later-${suffix}`);
    const split = await splitOf(itemId);

    // A is on 90% for THIS product; B is untouched on their 70% default.
    expect(split.get(ids.contribA)!.engineerBp).toBe(9000);
    expect(split.get(ids.contribA)!.amountMinor).toBe(4_500n);   // 5000 x 90%
    expect(split.get(ids.contribB)!.engineerBp).toBe(B_BP);
    expect(split.get(ids.contribB)!.amountMinor).toBe(3_500n);   // 5000 x 70%
  });

  it('CHANGING A RATE DOES NOT MOVE A SALE ALREADY MADE (§13)', async () => {
    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, ids.shared)),
    );
    const before = await splitOf(item!.id);

    // The owner halves A's rate and raises B's, after the sale happened.
    await withRawActorContext(OWNER_RAW, async (tx) => {
      await setCommissionAgreement(tx, {
        contributorId: ids.contribA, productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: 4000, currency: 'USD' },
        createdBy: ids.owner, note: 'مراجعة سنوية',
      });
      await setCommissionAgreement(tx, {
        contributorId: ids.contribB, productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: 9500, currency: 'USD' },
        createdBy: ids.owner, note: 'مراجعة سنوية',
      });
    });

    const after = await splitOf(item!.id);
    for (const contributorId of [ids.contribA, ids.contribB]) {
      expect(after.get(contributorId)!.amountMinor).toBe(before.get(contributorId)!.amountMinor);
      expect(after.get(contributorId)!.platformAmountMinor).toBe(before.get(contributorId)!.platformAmountMinor);
      expect(after.get(contributorId)!.engineerBp).toBe(before.get(contributorId)!.engineerBp);
    }
  });

  it('closes the old agreement rather than editing it, so the past stays readable', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(commissionAgreements)
        .where(sql`${commissionAgreements.contributorId} = ${ids.contribA}
                   AND ${commissionAgreements.productId} IS NULL`),
    );
    // Two rows: the 80% that governed the sale above, now closed, and the 40%
    // in force from today. The rate on any past date stays reconstructible.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((r) => r.effectiveTo === null)).toHaveLength(1);
    expect(rows.find((r) => r.effectiveTo === null)!.engineerBp).toBe(4000);
    expect(rows.some((r) => r.engineerBp === A_BP && r.effectiveTo !== null)).toBe(true);
  });

  it('refuses to rewrite a frozen per-engineer split, even as the owner', async () => {
    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, ids.shared)),
    );

    let message = '';
    try {
      await withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(orderItemContributors)
          .set({ amountMinor: 1n })
          .where(eq(orderItemContributors.orderItemId, item!.id)),
      );
    } catch (error) {
      let current: unknown = error;
      const parts: string[] = [];
      while (current instanceof Error) { parts.push(current.message); current = current.cause; }
      message = parts.join(' | ');
    }
    expect(message).toMatch(/immutable/i);
  });
});

// ===========================================================================
describe('4. the engineer\u2019s own earnings screen', () => {
  it('shows the sales behind their balance', async () => {
    /*
     * `/account/earnings` calls `contributorSales(actor)` as the engineer.
     * Migration 0043 took `order_items` away from contributors — correctly —
     * and this query inner-joins it, so the table has been empty ever since
     * for the one audience it exists for. Checked here rather than assumed.
     */
    const rows = await contributorSales({
      ...base, userId: ids.userA, role: 'CONTRIBUTOR',
      contributorId: ids.contribA, contributorActive: true,
    } as Actor);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((t, r) => t + r.engineerMinor, 0n)).toBeGreaterThan(0n);
  });
});

// ===========================================================================
describe('5. the owner\u2019s screen, and who may reach it', () => {
  const engineerA: Actor = {
    ...base, userId: ids.userA, role: 'CONTRIBUTOR',
    contributorId: ids.contribA, contributorActive: true,
  };

  it('lists every engineer with the terms in force for them', async () => {
    const { engineers } = await commissionOverview(owner);
    const a = engineers.find((e) => e.contributorId === ids.contribA);
    const c = engineers.find((e) => e.contributorId === ids.contribC);

    expect(a).toBeDefined();
    expect(c!.model).toBe('FIXED_ENGINEER');
    expect(c!.engineerFixedMinor).toBe(C_FIXED);
    // A carries a product-scoped override from the case above.
    expect(a!.overrideCount).toBeGreaterThan(0);
  });

  it('refuses the screen to an engineer', async () => {
    /*
     * Refuses rather than narrows. The policy would hand a contributor their
     * own row, so without the guard the screen would render a one-row table
     * and look like it worked — which is harder to notice than a page that
     * does not open.
     */
    await expect(commissionOverview(engineerA)).rejects.toThrow();
  });

  it('refuses an engineer writing an agreement through the service', async () => {
    await expect(
      saveCommissionAgreement(engineerA, {
        contributorId: ids.contribA,
        productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: 10000, currency: 'USD' },
      }),
    ).rejects.toThrow(RuleViolationError);

    const [current] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ engineerBp: commissionAgreements.engineerBp })
        .from(commissionAgreements)
        .where(sql`${commissionAgreements.contributorId} = ${ids.contribA}
                   AND ${commissionAgreements.productId} IS NULL
                   AND ${commissionAgreements.effectiveTo} IS NULL`),
    );
    expect(current!.engineerBp).not.toBe(10000);
  });

  it('refuses terms for a contributor that does not exist', async () => {
    await expect(
      saveCommissionAgreement(owner, {
        contributorId: randomUUID(),
        productId: null,
        agreement: { model: 'PERCENTAGE', engineerBp: 5000, currency: 'USD' },
      }),
    ).rejects.toThrow(RuleViolationError);
  });

  it('records the change in the audit log, with what it replaced', async () => {
    await saveCommissionAgreement(owner, {
      contributorId: ids.contribC,
      productId: null,
      agreement: { model: 'PERCENTAGE', engineerBp: 6500, currency: 'USD' },
      note: 'تحويل من مبلغ ثابت إلى نسبة',
    });

    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT before, after FROM audit_logs
         WHERE action = 'COMMISSION_CHANGED'
         ORDER BY created_at DESC LIMIT 1
      `),
    ) as unknown as Array<{ before: Record<string, unknown>; after: Record<string, unknown> }>;

    expect(rows).toHaveLength(1);
    // What it was, so a rate change is answerable a year later.
    expect(rows[0]!.before.model).toBe('FIXED_ENGINEER');
    expect(rows[0]!.after.engineerBp).toBe(6500);
  });
});

// ===========================================================================
describe('6. a percentage is parsed from digits, never through a float', () => {
  it('reads whole and fractional percentages exactly', () => {
    expect(parsePercentToBp('80')).toBe(8000);
    expect(parsePercentToBp('7.25')).toBe(725);
    expect(parsePercentToBp('0.1')).toBe(10);
    expect(parsePercentToBp('100')).toBe(10_000);
    expect(parsePercentToBp(' 62.5 ')).toBe(6250);
  });

  it('refuses what a rate cannot be', () => {
    for (const bad of ['', '-5', '101', '80.123', 'abc', '8e1', '١٠']) {
      expect(() => parsePercentToBp(bad)).toThrow();
    }
  });
});

// ===========================================================================
describe('7. the database refuses a split it cannot explain', () => {
  /*
   * These go in as INSERTs, not UPDATEs. Every UPDATE to this table is refused
   * outright by `order_item_contributors_guard` (migration 0020), so an UPDATE
   * would prove the trigger and say nothing about the CHECK constraints — two
   * different guards, and only one of them is being tested here.
   */
  async function refusalFor(values: Record<string, unknown>): Promise<string> {
    const [item] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.productId, ids.solo)),
    );
    try {
      await withRawActorContext(OWNER_RAW, (tx) =>
        tx.execute(sql`
          INSERT INTO order_item_contributors
            (order_item_id, contributor_id, share_bp, slice_minor, amount_minor,
             platform_amount_minor, commission_model, engineer_bp, currency, occurred_at)
          VALUES (${item!.id}, ${ids.contribC}, 10000,
                  ${values.slice as bigint}, ${values.amount as bigint},
                  ${values.platform as bigint}, ${values.model as string},
                  ${values.bp as number | null}, ${(values.currency as string) ?? 'USD'}, now())
        `),
      );
      return '';
    } catch (error) {
      const parts: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        parts.push(current.message);
        const detail = (current as { detail?: unknown }).detail;
        if (typeof detail === 'string') parts.push(detail);
        current = current.cause;
      }
      return parts.join(' | ');
    }
  }

  it('refuses a split that does not re-add to the slice it came from', async () => {
    const message = await refusalFor({
      slice: 1000n, amount: 800n, platform: 300n, model: 'PERCENTAGE', bp: 8000,
    });
    expect(message).toMatch(/order_item_contributors_split_balances/);
  });

  it('refuses a negative share of a slice', async () => {
    const message = await refusalFor({
      slice: 1000n, amount: -100n, platform: 1100n, model: 'PERCENTAGE', bp: 8000,
    });
    expect(message).toMatch(/order_item_contributors_split_balances/);
  });

  it('refuses a percentage agreement with no rate on it', async () => {
    // A row that names terms which could not have produced its own numbers.
    const message = await refusalFor({
      slice: 1000n, amount: 800n, platform: 200n, model: 'PERCENTAGE', bp: null,
    });
    expect(message).toMatch(/order_item_contributors_model_shape/);
  });

  it('refuses a currency that is not a currency', async () => {
    const message = await refusalFor({
      slice: 1000n, amount: 800n, platform: 200n, model: 'PERCENTAGE', bp: 8000,
      currency: 'dollars',
    });
    expect(message).toMatch(/order_item_contributors_currency_format/);
  });

  it('accepts the same row once its arithmetic is right', async () => {
    // The control. Without it the four refusals above would also pass on a
    // table that rejects every insert for some unrelated reason.
    const message = await refusalFor({
      slice: 1000n, amount: 800n, platform: 200n, model: 'PERCENTAGE', bp: 8000,
    });
    expect(message).toBe('');

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(orderItemContributors)
        .where(sql`${orderItemContributors.contributorId} = ${ids.contribC}
                   AND ${orderItemContributors.sliceMinor} = 1000`),
    );
  });
});
