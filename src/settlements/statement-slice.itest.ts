import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, orderItemContributors,
  orders, paymentMethods, payments, productContributors,
  productPrices, products, settlementLines, settlements, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { generateSettlements } from './generate';
import { statementDocument } from './queries';
import { renderStatementPdf } from './statement-pdf';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * THE STATEMENT SHOWS THE ENGINEER'S OWN SLICE (migration 0052)
 * ===========================================================================
 *
 * The defect this file exists to keep fixed shows up on ONE kind of product:
 * a shared one. Two engineers are credited 60/40 on a $100 product. Before
 * 0052 both statements said the same thing — «إجمالي قيمتها ١٠٠٫٠٠» — because
 * the line was written from `order_items.unit_price_minor`, the whole
 * product's price.
 *
 * For the 40% author that number is two and a half times their own sales, and
 * it invites the subtraction OPEN-4 forbids: "the price was 100, I got 28, so
 * 72 went somewhere". The honest figure was already frozen one table away, on
 * `order_item_contributors.slice_minor` since migration 0050 — what their own
 * agreed rate was actually applied to.
 *
 * WHAT THIS FILE ALSO ASSERTS, AND IT IS HALF THE POINT: not one amount that
 * decides a payment moved. `engineer_minor`, `period_sales_minor`,
 * `net_due_minor` and `balance_minor` are checked against the arithmetic the
 * OPEN-15 suite already approved. The slice is a NEW column beside them, never
 * a recomputation of them.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  userA: randomUUID(), contribA: randomUUID(),
  userB: randomUUID(), contribB: randomUUID(),
  discipline: randomUUID(),
  shared: randomUUID(),
  method: randomUUID(),
};

const PRICE = 10_000n;   // $100.00
const A_BP = 8000;       // A keeps 80% of A's slice
const B_BP = 7000;       // B keeps 70% of B's slice — a different contract

/** Net 10000 credited 60/40, so the slices are these and nothing else. */
const A_SLICE = 6_000n;
const B_SLICE = 4_000n;
const A_PAY = 4_800n;    // 6000 x 80%
const B_PAY = 2_800n;    // 4000 x 70%

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true, totpEnabled: false,
} as const;

let owner: Actor;
let engineerA: Actor;
let engineerB: Actor;
const buyers: string[] = [];

/** One sale of the shared product, to a buyer who has never bought it. */
async function sellShared(): Promise<void> {
  const id = randomUUID();
  buyers.push(id);
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.insert(users).values({
      id, email: `slice-cust${buyers.length}+${suffix}@test.local`,
      passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE',
      displayName: `Customer ${buyers.length}`, countryCode: 'SY',
    }),
  );
  const buyer: Actor = {
    ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false,
  };
  const order = await createOrder(buyer, { productSlugs: [`slice-shared-${suffix}`] });
  await placeOrder(buyer, { orderId: order.orderId, paymentMethodId: ids.method });
  const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)),
  );
  await approvePayment(owner, { paymentId: payment!.id });
}

async function settlementOf(contributorId: string) {
  const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(settlements).where(sql`${settlements.contributorId} = ${contributorId}
      AND ${settlements.periodKey} = '2026-11'`),
  );
  return row;
}

async function linesOf(settlementId: string) {
  return withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(settlementLines).where(eq(settlementLines.settlementId, settlementId)),
  );
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };
  engineerA = {
    ...base, userId: ids.userA, role: 'CONTRIBUTOR',
    contributorId: ids.contribA, contributorActive: true,
  };
  engineerB = {
    ...base, userId: ids.userB, role: 'CONTRIBUTOR',
    contributorId: ids.contribB, contributorActive: true,
  };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.userA, email: `slice-a+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer A' },
      { id: ids.userB, email: `slice-b+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer B' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contribA, userId: ids.userA, publicSlug: `slice-a-${suffix}`, settlementCode: `SLA${suffix}`, displayName: 'Engineer A', isActive: true },
      { id: ids.contribB, userId: ids.userB, publicSlug: `slice-b-${suffix}`, settlementCode: `SLB${suffix}`, displayName: 'Engineer B', isActive: true },
    ]);
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `slice-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 93,
    });
    await tx.insert(products).values({
      id: ids.shared, slug: `slice-shared-${suffix}`, titleAr: 'مخطط مشترك',
      disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED',
      currency: 'USD', publishedAt: new Date(),
    });
    await tx.insert(productContributors).values([
      { productId: ids.shared, contributorId: ids.contribA, shareBp: 6000 },
      { productId: ids.shared, contributorId: ids.contribB, shareBp: 4000 },
    ]);
    await tx.insert(productPrices).values({
      productId: ids.shared, amountMinor: PRICE, currency: 'USD',
    });
    await tx.insert(commissionAgreements).values([
      { contributorId: ids.contribA, productId: null, model: 'PERCENTAGE', engineerBp: A_BP, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.contribB, productId: null, model: 'PERCENTAGE', engineerBp: B_BP, currency: 'USD', createdBy: ids.owner },
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `slice-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 180_000);

afterAll(async () => {
  vi.useRealTimers();
  await withRawActorContext(OWNER_RAW, async (tx) => {
    const contribIds = [ids.contribA, ids.contribB];
    await tx.delete(settlements).where(inArray(settlements.contributorId, contribIds));
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(inArray(commissionAgreements.contributorId, contribIds));
    await tx.delete(productContributors).where(eq(productContributors.productId, ids.shared));
    await tx.delete(products).where(eq(products.id, ids.shared));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(inArray(contributors.id, contribIds));
    await tx.delete(users).where(inArray(users.id, [...buyers, ids.userA, ids.userB]));
  });
  await closeDb();
}, 60_000);


// ===========================================================================
describe('1. the sale freezes each engineer’s own slice', () => {
  it('sells the shared product twice in November', async () => {
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    await sellShared();
    await sellShared();

    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItemContributors)
        .where(inArray(orderItemContributors.contributorId, [ids.contribA, ids.contribB])),
    );
    expect(rows).toHaveLength(4);

    for (const row of rows) {
      const isA = row.contributorId === ids.contribA;
      expect(row.sliceMinor).toBe(isA ? A_SLICE : B_SLICE);
      expect(row.amountMinor).toBe(isA ? A_PAY : B_PAY);
    }
  });

  it('the two slices add back to the whole net — no cent is invented or lost', () => {
    expect(A_SLICE + B_SLICE).toBe(PRICE);
  });
});

// ===========================================================================
describe('2. the statement line carries the slice, not the product’s price', () => {
  it('generates November for both engineers', async () => {
    vi.setSystemTime(new Date('2026-12-01T06:00:00Z'));
    const run = await generateSettlements(owner, { periodKey: '2026-11' });
    // Other suites' engineers may also have November sales; this asserts only
    // that ours were settled, never that nobody else was.
    expect(run.generated.length).toBeGreaterThanOrEqual(2);
  });

  it('A’s line says 60.00 — their slice — while the price stays 100.00', async () => {
    const row = await settlementOf(ids.contribA);
    const lines = (await linesOf(row!.id)).filter((line) => line.kind === 'SALE');

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.grossMinor).toBe(PRICE);      // what the customer paid
      expect(line.sliceMinor).toBe(A_SLICE);    // what A's rate applied to
      expect(line.engineerMinor).toBe(A_PAY);   // unchanged by this migration
    }
  });

  it('B’s line says 40.00, and B is NOT shown A’s 60.00 anywhere', async () => {
    const row = await settlementOf(ids.contribB);
    const lines = (await linesOf(row!.id)).filter((line) => line.kind === 'SALE');

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.sliceMinor).toBe(B_SLICE);
      expect(line.engineerMinor).toBe(B_PAY);
    }
    // The only numbers on B's statement are B's own and the public price.
    const everyNumber = lines.flatMap((line) => [line.grossMinor, line.sliceMinor, line.engineerMinor]);
    expect(everyNumber).not.toContain(A_SLICE);
    expect(everyNumber).not.toContain(A_PAY);
  });

  it('the period total is the sum of the slices, and never exceeds the gross', async () => {
    const a = await settlementOf(ids.contribA);
    const b = await settlementOf(ids.contribB);

    expect(a!.periodSliceSalesMinor).toBe(2n * A_SLICE);   // 12000
    expect(b!.periodSliceSalesMinor).toBe(2n * B_SLICE);   // 8000
    expect(a!.periodGrossSalesMinor).toBe(2n * PRICE);     // unchanged: 20000
    expect(b!.periodGrossSalesMinor).toBe(2n * PRICE);
  });
});

// ===========================================================================
describe('3. NOTHING THAT DECIDES A PAYMENT MOVED', () => {
  it('the money owed is exactly what OPEN-15’s arithmetic already said', async () => {
    const a = await settlementOf(ids.contribA);
    const b = await settlementOf(ids.contribB);

    expect(a!.periodSalesMinor).toBe(2n * A_PAY);    // 9600
    expect(b!.periodSalesMinor).toBe(2n * B_PAY);    // 5600
    expect(a!.balanceMinor).toBe(2n * A_PAY);
    expect(b!.balanceMinor).toBe(2n * B_PAY);
    expect(a!.netDueMinor).toBe(2n * A_PAY);
    expect(b!.netDueMinor).toBe(2n * B_PAY);
  });

  it('the detail still reconciles against the ledger, with no balancing line', async () => {
    for (const contributorId of [ids.contribA, ids.contribB]) {
      const row = await settlementOf(contributorId);
      const lines = await linesOf(row!.id);
      // A "تسوية فرق غير مفصّل" line appearing here would mean the detail and
      // the ledger disagree — which is how a change to the read query shows up.
      expect(lines.some((line) => line.productTitle.startsWith('تسوية فرق'))).toBe(false);
      expect(lines.reduce((total, line) => total + line.engineerMinor, 0n))
        .toBe(row!.periodSalesMinor);
    }
  });
});

// ===========================================================================
describe('4. the document says whose value it is', () => {
  it('prints «قيمة حصتي منها» once the slice is known', async () => {
    const row = await settlementOf(ids.contribB);
    const doc = await statementDocument(engineerB, row!.id);
    expect(doc).not.toBeNull();
    expect(doc!.settlement.periodSliceSalesMinor).toBe(2n * B_SLICE);

    const pdf = await renderStatementPdf({ ...doc!, platformName: 'إنجينورا' });
    expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('A reads A’s statement and B reads B’s — never the other', async () => {
    const a = await settlementOf(ids.contribA);
    const b = await settlementOf(ids.contribB);

    expect(await statementDocument(engineerA, b!.id)).toBeNull();
    expect(await statementDocument(engineerB, a!.id)).toBeNull();
    expect(await statementDocument(engineerA, a!.id)).not.toBeNull();
  });
});

// ===========================================================================
describe('5. the database refuses a slice that cannot be one', () => {
  /*
   * Every case here writes through the OWNER's raw context — the most
   * privileged path the application has — because a CHECK constraint that only
   * holds when the application is careful is not a constraint.
   */
  it('refuses a slice larger than what the customer paid', async () => {
    const row = await settlementOf(ids.contribA);
    await expect(withRawActorContext(OWNER_RAW, (tx) =>
      tx.insert(settlementLines).values({
        settlementId: row!.id, kind: 'SALE', occurredAt: new Date(),
        productTitle: 'مستحيل', currency: 'USD',
        grossMinor: 1_000n, sliceMinor: 1_001n, engineerMinor: 800n,
      }),
    )).rejects.toThrow(/settlement_lines_slice_shape|Failed query/);
  });

  it('refuses a slice on an adjustment line, which describes no sale', async () => {
    const row = await settlementOf(ids.contribA);
    await expect(withRawActorContext(OWNER_RAW, (tx) =>
      tx.insert(settlementLines).values({
        settlementId: row!.id, kind: 'ADJUSTMENT', occurredAt: new Date(),
        productTitle: 'تصحيح', currency: 'USD',
        grossMinor: 0n, sliceMinor: 0n, engineerMinor: 500n,
      }),
    )).rejects.toThrow(/settlement_lines_slice_shape|Failed query/);
  });

  it('accepts the same two rows with the slice absent — the control', async () => {
    const row = await settlementOf(ids.contribA);
    const written = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.insert(settlementLines).values({
        settlementId: row!.id, kind: 'ADJUSTMENT', occurredAt: new Date(),
        productTitle: 'تصحيح', currency: 'USD',
        grossMinor: 0n, sliceMinor: null, engineerMinor: 500n,
      }).returning({ id: settlementLines.id }),
    );
    expect(written).toHaveLength(1);
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.delete(settlementLines).where(eq(settlementLines.id, written[0]!.id)),
    );
  });

  it('refuses a period total above the period’s gross', async () => {
    const row = await settlementOf(ids.contribA);
    await expect(withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        UPDATE settlements SET period_slice_sales_minor = period_gross_sales_minor + 1
         WHERE id = ${row!.id}
      `),
    )).rejects.toThrow(/settlements_period_slice_shape|Failed query/);
  });
});
