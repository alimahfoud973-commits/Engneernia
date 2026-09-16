import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements, orderItemContributors,
  orderItems, orders, paymentMethods, payments, productContributors,
  productPrices, products, settlementLines, settlements, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { generateSettlements } from '@/settlements/generate';
import { myStatements, statementDocument, statementLines, settlementRun } from '@/settlements/queries';
import { contributorStatement } from '@/finance/balances';
import { outstandingPayables, revenueByPeriod } from '@/finance/reports';
import { periodKeyOf, nextPeriodKey, periodBounds } from '@/lib/time/period';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * OPEN-4 — WHAT ONE ENGINEER MAY LEARN ABOUT ANOTHER
 * ===========================================================================
 * The owner's decision is that an engineer sees the date, the product, the
 * price and THEIR OWN share, and never another engineer's earnings, rate or
 * sales (decisions §6, TD-29).
 *
 * THIS FILE ASKS THE DATABASE, IT DOES NOT READ THE POLICIES. Every case below
 * runs a query under engineer A's own actor context with NO WHERE CLAUSE — the
 * shape a reporting query written in a hurry would have — and asserts on what
 * comes back. A policy that is correct in `pg_policies` and wrong in practice
 * (a missing FORCE, a SECURITY DEFINER function, a view owned by the wrong
 * role) fails here and passes a reading of the source.
 *
 * The fixture is built so that every assertion has something to find if the
 * isolation breaks: two engineers with DIFFERENT commission rates, a product
 * each, and one product they co-author — which is the case decisions §6 is
 * actually about, because on a two-author product "everyone else's share" is
 * one named person's pay.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  userA: randomUUID(), contribA: randomUUID(),
  userB: randomUUID(), contribB: randomUUID(),
  discipline: randomUUID(),
  productA: randomUUID(), productB: randomUUID(), productShared: randomUUID(),
  method: randomUUID(),
};
const slugA = `iso-a-${suffix}`;
const slugB = `iso-b-${suffix}`;
const slugShared = `iso-shared-${suffix}`;

const PRICE = 10_000n;          // $100.00
const A_BP = 8000;              // engineer A's agreement: 80%
const B_BP = 7000;              // engineer B's agreement: 70% — deliberately different
const SHARED_A_BP = 6000;       // A is credited 60% of the shared product
const SHARED_B_BP = 4000;       // B is credited 40%

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true, totpEnabled: false,
} as const;

let owner: Actor;
const engineerA: Actor = {
  ...base, userId: ids.userA, role: 'CONTRIBUTOR',
  contributorId: ids.contribA, contributorActive: true,
};
const engineerB: Actor = {
  ...base, userId: ids.userB, role: 'CONTRIBUTOR',
  contributorId: ids.contribB, contributorActive: true,
};

/** Engineer A's own database context — the one their web requests run under. */
const RAW_A = { actorId: ids.userA, actorRole: 'CONTRIBUTOR', contributorId: ids.contribA };
const RAW_B = { actorId: ids.userB, actorRole: 'CONTRIBUTOR', contributorId: ids.contribB };

const buyers: string[] = [];

/** Read as engineer A with raw SQL: no application code in the path. */
function asA<T>(query: string): Promise<T[]> {
  return withRawActorContext(RAW_A, (tx) =>
    tx.execute(sql.raw(query)),
  ) as unknown as Promise<T[]>;
}

/** The text of whatever the database raised, or '' if it raised nothing. */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
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

async function sell(slug: string): Promise<void> {
  const id = randomUUID();
  buyers.push(id);
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.insert(users).values({
      id, email: `iso-cust${buyers.length}+${suffix}@test.local`,
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
}

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.userA, email: `iso-a+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer A' },
      { id: ids.userB, email: `iso-b+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer B' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contribA, userId: ids.userA, publicSlug: `iso-eng-a-${suffix}`, settlementCode: `ISOA${suffix}`, displayName: 'Engineer A', isActive: true },
      { id: ids.contribB, userId: ids.userB, publicSlug: `iso-eng-b-${suffix}`, settlementCode: `ISOB${suffix}`, displayName: 'Engineer B', isActive: true },
    ]);
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `iso-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 93,
    });
    await tx.insert(products).values([
      { id: ids.productA, slug: slugA, titleAr: 'منتج المهندس أ', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.productB, slug: slugB, titleAr: 'منتج المهندس ب', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.productShared, slug: slugShared, titleAr: 'منتج مشترك', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.productA, contributorId: ids.contribA, shareBp: 10000 },
      { productId: ids.productB, contributorId: ids.contribB, shareBp: 10000 },
      { productId: ids.productShared, contributorId: ids.contribA, shareBp: SHARED_A_BP },
      { productId: ids.productShared, contributorId: ids.contribB, shareBp: SHARED_B_BP },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.productA, amountMinor: PRICE, currency: 'USD' },
      { productId: ids.productB, amountMinor: PRICE, currency: 'USD' },
      { productId: ids.productShared, amountMinor: PRICE, currency: 'USD' },
    ]);
    await tx.insert(commissionAgreements).values([
      { contributorId: ids.contribA, productId: null, model: 'PERCENTAGE', engineerBp: A_BP, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.contribB, productId: null, model: 'PERCENTAGE', engineerBp: B_BP, currency: 'USD', createdBy: ids.owner },
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `iso-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });

  await sell(slugA);
  await sell(slugB);
  await sell(slugShared);
}, 180_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    const productIds = [ids.productA, ids.productB, ids.productShared];
    const contribIds = [ids.contribA, ids.contribB];
    await tx.delete(settlementLines).where(sql`settlement_id IN (
      SELECT id FROM settlements WHERE contributor_id IN (${ids.contribA}, ${ids.contribB}))`);
    await tx.delete(settlements).where(inArray(settlements.contributorId, contribIds));
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(inArray(commissionAgreements.contributorId, contribIds));
    await tx.delete(productContributors).where(inArray(productContributors.productId, productIds));
    await tx.delete(products).where(inArray(products.id, productIds));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(inArray(contributors.id, contribIds));
    await tx.delete(users).where(inArray(users.id, [...buyers, ids.userA, ids.userB]));
  });
  await closeDb();
}, 60_000);


// ===========================================================================
describe('1. the sale record — an engineer reads their own line and no other', () => {
  it('reads NO order item at all, not even for their own product', async () => {
    /*
     * Migration 0043's decision, re-proved from the outside. The row carries
     * `platform_amount_minor`, `net_minor` and `unit_price_minor` together,
     * and on a co-authored product those three are enough to compute a
     * colleague's exact pay. The share an engineer IS entitled to has its own
     * correctly scoped row in `order_item_contributors`.
     */
    expect(await asA('SELECT * FROM order_items')).toHaveLength(0);
  });

  it('reads only their OWN contributor line, on the shared product included', async () => {
    const rows = await asA<{ contributor_id: string; amount_minor: string }>(
      'SELECT contributor_id, amount_minor, share_bp FROM order_item_contributors',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.contributor_id === ids.contribA)).toBe(true);
  });

  it('reads no order, and no invoice, and no payment', async () => {
    // The buyer's identity and what they paid is the customer's, not the
    // seller's (OPEN-4, narrowest reading).
    expect(await asA('SELECT * FROM orders')).toHaveLength(0);
    expect(await asA('SELECT * FROM invoices')).toHaveLength(0);
    expect(await asA('SELECT * FROM payments')).toHaveLength(0);
    expect(await asA('SELECT * FROM entitlements')).toHaveLength(0);
  });
});

// ===========================================================================
describe('2. the books — only their own payable, never the platform’s', () => {
  it('reads only ledger lines carrying their own contributor id', async () => {
    const rows = await asA<{ contributor_id: string | null; account_code: string }>(
      'SELECT contributor_id, account_code, amount_minor FROM ledger_lines',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.contributor_id === ids.contribA)).toBe(true);
  });

  it('reads NO platform revenue line — not even for their own product', async () => {
    /*
     * The platform's cut is the platform's business. A `PLATFORM_REVENUE` line
     * for the engineer's own sale would also hand them the commission rate as
     * a subtraction, and on the shared product the rate that governs is the
     * PRIMARY author's, not necessarily theirs.
     */
    const rows = await asA(
      `SELECT * FROM ledger_lines WHERE account_code <> 'ENGINEER_PAYABLE'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('reads no transaction that has no line of theirs in it', async () => {
    const rows = await asA<{ id: string }>('SELECT id FROM ledger_transactions');
    const mine = await asA<{ transaction_id: string }>(
      'SELECT DISTINCT transaction_id FROM ledger_lines',
    );
    const mineIds = new Set(mine.map((r) => r.transaction_id));
    expect(rows.every((r) => mineIds.has(r.id))).toBe(true);
  });
});

// ===========================================================================
describe('3. the commercial terms — §12, the private agreement', () => {
  it('reads their own agreement and not the other engineer’s', async () => {
    const rows = await asA<{ contributor_id: string; engineer_bp: number }>(
      'SELECT contributor_id, engineer_bp FROM commission_agreements',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.contributor_id === ids.contribA)).toBe(true);
    // B's 70% is nowhere in the result.
    expect(rows.some((r) => r.engineer_bp === B_BP)).toBe(false);
  });

  it('reads NO credit share at all — not even their own (migration 0049)', async () => {
    /*
     * Their own share is the number that turns their own pay into everybody
     * else's (section 6 measures it), and no contributor-facing screen
     * displays it. So it belongs to the owner, as the write side always did.
     */
    expect(await asA('SELECT * FROM product_contributors')).toHaveLength(0);
  });

  it('still reaches their own UNPUBLISHED product and its price', async () => {
    /*
     * The half of migration 0049 that could have broken silently. Three
     * policies asked "is this actor credited here?" by looking inside
     * `product_contributors` — and a policy expression obeys the row-level
     * security of a table it names, so narrowing that table would have
     * narrowed all three with it. Every engineer would have lost access to
     * their own drafts without one line of application code changing.
     *
     * `app_is_credited_on` answers the same question as a boolean instead.
     */
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(products).set({ status: 'DRAFT' }).where(eq(products.id, ids.productA)),
    );

    try {
      const seen = await asA(`SELECT id FROM products WHERE id = '${ids.productA}'`);
      expect(seen).toHaveLength(1);

      const prices = await asA(
        `SELECT amount_minor FROM product_prices WHERE product_id = '${ids.productA}'`,
      );
      expect(prices.length).toBeGreaterThan(0);
    } finally {
      await withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(products).set({ status: 'PUBLISHED' }).where(eq(products.id, ids.productA)),
      );
    }
  });

  it('does NOT reach an unpublished product it is not credited on', async () => {
    // The other side of the same boolean: it must still say no.
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.update(products).set({ status: 'DRAFT' }).where(eq(products.id, ids.productB)),
    );

    try {
      expect(await asA(`SELECT id FROM products WHERE id = '${ids.productB}'`)).toHaveLength(0);
    } finally {
      await withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(products).set({ status: 'PUBLISHED' }).where(eq(products.id, ids.productB)),
      );
    }
  });
});

// ===========================================================================
describe('4. price and commission cannot be edited from a contributor session', () => {
  it('refuses a direct UPDATE of the price', async () => {
    const message = await rejectionText(
      withRawActorContext(RAW_A, (tx) =>
        tx.execute(sql`UPDATE product_prices SET amount_minor = 1 WHERE product_id = ${ids.productA}`),
      ),
    );
    // RLS refuses a write by FILTERING, so the statement succeeds and changes
    // nothing. The proof is the row, not the absence of an error.
    const [price] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ amountMinor: productPrices.amountMinor })
        .from(productPrices)
        .where(sql`${productPrices.productId} = ${ids.productA} AND ${productPrices.effectiveTo} IS NULL`),
    );
    expect(price!.amountMinor).toBe(PRICE);
    expect(message).toBe('');
  });

  it('refuses the trusted price function, which checks the ACTOR not the role', async () => {
    const message = await rejectionText(
      withRawActorContext(RAW_A, (tx) =>
        tx.execute(sql`SELECT app_set_product_price(${ids.productA}::uuid, 1::bigint, 'USD', ${ids.userA}::uuid, 'x')`),
      ),
    );
    /*
     * `app_set_product_price` is SECURITY DEFINER and executable by everyone,
     * so it is the one path that could write a price without owning the table.
     * It asks `app_is_owner()` before it writes — the actor, not the database
     * role — which is what makes running it as a contributor an exception
     * rather than a price change.
     */
    expect(message).toMatch(/Only the platform owner may change a price/i);

    const [price] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ amountMinor: productPrices.amountMinor })
        .from(productPrices)
        .where(sql`${productPrices.productId} = ${ids.productA} AND ${productPrices.effectiveTo} IS NULL`),
    );
    expect(price!.amountMinor).toBe(PRICE);
  });

  it('refuses to write themselves a better commission rate', async () => {
    await withRawActorContext(RAW_A, (tx) =>
      tx.execute(sql`UPDATE commission_agreements SET engineer_bp = 10000 WHERE contributor_id = ${ids.contribA}`),
    );
    const [agreement] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ engineerBp: commissionAgreements.engineerBp })
        .from(commissionAgreements)
        .where(eq(commissionAgreements.contributorId, ids.contribA)),
    );
    expect(agreement!.engineerBp).toBe(A_BP);
  });

  it('refuses to INSERT an agreement of their own invention', async () => {
    /*
     * The other shape of an RLS refusal. A USING clause FILTERS — the UPDATE
     * above succeeded and changed nothing — but a WITH CHECK clause RAISES,
     * SQLSTATE 42501. Both are refusals; only one of them tells you so.
     */
    const message = await rejectionText(
      withRawActorContext(RAW_A, (tx) =>
        tx.execute(sql`
          INSERT INTO commission_agreements (contributor_id, model, engineer_bp, currency)
          VALUES (${ids.contribA}, 'PERCENTAGE', 9900, 'USD')
        `),
      ),
    );
    expect(message).toMatch(/row-level security/i);

    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ engineerBp: commissionAgreements.engineerBp })
        .from(commissionAgreements)
        .where(eq(commissionAgreements.contributorId, ids.contribA)),
    );
    expect(rows.map((r) => r.engineerBp)).toEqual([A_BP]);
  });

  it('refuses to enlarge their own credit share on the shared product', async () => {
    await withRawActorContext(RAW_A, (tx) =>
      tx.execute(sql`UPDATE product_contributors SET share_bp = 10000
                      WHERE product_id = ${ids.productShared} AND contributor_id = ${ids.contribA}`),
    );
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ contributorId: productContributors.contributorId, shareBp: productContributors.shareBp })
        .from(productContributors)
        .where(eq(productContributors.productId, ids.productShared)),
    );
    expect(rows.find((r) => r.contributorId === ids.contribA)!.shareBp).toBe(SHARED_A_BP);
    expect(rows.find((r) => r.contributorId === ids.contribB)!.shareBp).toBe(SHARED_B_BP);
  });

  it('refuses to rewrite the frozen share on a sale that already happened', async () => {
    const message = await rejectionText(
      withRawActorContext(RAW_A, (tx) =>
        tx.execute(sql`UPDATE order_item_contributors SET amount_minor = 999999`),
      ),
    );
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ amountMinor: orderItemContributors.amountMinor })
        .from(orderItemContributors),
    );
    expect(rows.some((r) => r.amountMinor === 999999n)).toBe(false);
    expect(message).toBe('');
  });
});

// ===========================================================================
describe('5. the monthly statement', () => {
  let settlementIdA = '';
  let settlementIdB = '';

  beforeAll(async () => {
    // Settle the month the sales landed in, from the following month.
    const periodKey = periodKeyOf(new Date());
    const after = new Date(periodBounds(nextPeriodKey(periodKey)).startUtc.getTime() + 86_400_000);
    await generateSettlements(owner, { periodKey, now: after });

    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ id: settlements.id, contributorId: settlements.contributorId })
        .from(settlements)
        .where(inArray(settlements.contributorId, [ids.contribA, ids.contribB])),
    );
    settlementIdA = rows.find((r) => r.contributorId === ids.contribA)!.id;
    settlementIdB = rows.find((r) => r.contributorId === ids.contribB)!.id;
  }, 120_000);

  it('gives engineer A their own statement and only theirs', async () => {
    const mine = await myStatements(engineerA);
    expect(mine.length).toBe(1);

    const rows = await asA<{ contributor_id: string }>(
      'SELECT contributor_id FROM settlements',
    );
    expect(rows.every((r) => r.contributor_id === ids.contribA)).toBe(true);
  });

  it('answers NOT FOUND — not FORBIDDEN — for the other engineer’s statement', async () => {
    // CLAUDE.md rule 5: confirming the row exists would itself be a disclosure.
    expect(await statementDocument(engineerA, settlementIdB)).toBeNull();
    expect(await statementLines(engineerA, settlementIdB)).toEqual([]);
  });

  it('shows A their own lines, and no line of B’s', async () => {
    const lines = await statementLines(engineerA, settlementIdA);
    expect(lines.length).toBeGreaterThan(0);

    const raw = await asA<{ settlement_id: string }>('SELECT settlement_id FROM settlement_lines');
    expect(raw.every((r) => r.settlement_id === settlementIdA)).toBe(true);
  });

  it('refuses the owner’s screens to a contributor', async () => {
    await expect(settlementRun(engineerA, periodKeyOf(new Date()))).rejects.toThrow();
    await expect(revenueByPeriod(engineerA)).rejects.toThrow();
    await expect(outstandingPayables(engineerA)).rejects.toThrow();
    await expect(contributorStatement(engineerA, ids.contribB)).rejects.toThrow();
  });

  it('refuses a contributor generating settlements at all', async () => {
    await expect(
      generateSettlements(engineerA, { periodKey: periodKeyOf(new Date()) }),
    ).rejects.toThrow();
  });

  it('refuses a contributor marking their own statement paid', async () => {
    await withRawActorContext(RAW_A, (tx) =>
      tx.execute(sql`UPDATE settlements SET status = 'PAID', net_due_minor = 999999`),
    );
    const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ status: settlements.status, netDueMinor: settlements.netDueMinor })
        .from(settlements).where(eq(settlements.id, settlementIdA)),
    );
    expect(row!.status).not.toBe('PAID');
    expect(row!.netDueMinor).not.toBe(999999n);
  });

  it('is symmetric: engineer B sees B’s side and none of A’s', async () => {
    const rows = await withRawActorContext(RAW_B, (tx) =>
      tx.execute(sql`SELECT contributor_id FROM ledger_lines`),
    ) as unknown as Array<{ contributor_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.contributor_id === ids.contribB)).toBe(true);

    // And through the application, B gets B's statement — one, and theirs.
    const theirs = await myStatements(engineerB);
    expect(theirs).toHaveLength(1);
    expect(await statementDocument(engineerB, settlementIdA)).toBeNull();
  });
});


// ===========================================================================
describe('6. the residual — what arithmetic still discloses, measured', () => {
  /**
   * =========================================================================
   * THIS IS NOT AN ACCESS-CONTROL FAILURE, AND IT IS NOT CLOSABLE BY RLS.
   * =========================================================================
   * Every case above proves engineer A cannot READ a single row belonging to
   * engineer B. This section is about what A can still COMPUTE — and, since
   * OPEN-15, about where that computation now stops.
   *
   * THE EXPOSURE THAT EXISTED. One rate governed a whole sale, so
   *
   *     pot           = (price - tax) x the governing rate
   *     others' total = pot - my own pay
   *
   * was exact, and on a two-author product it named one person's pay. Every
   * input was legitimately the reader's own — the price is public, the rate
   * was their contract, the pay is their statement — so no row-level policy
   * could close it. It was filed as KI-3: arithmetic, not a defect.
   *
   * WHAT CLOSED IT, IN TWO STEPS.
   *   Migration 0049 took the credit share away from contributors, which shut
   *   the route a MINORITY co-author had: they could scale their own pay by
   *   their own share to reach the pot, and could not otherwise, because the
   *   governing rate was the primary's and §12 keeps it private.
   *   Migration 0050 (OPEN-15) removed the governing rate itself. Each
   *   engineer's slice now meets their own agreement, so a colleague's pay is
   *   a function of a rate A cannot read.
   *
   * WHAT REMAINS, AND WHY IT IS NOT A PAYMENT. A can still recover their own
   * slice from their own pay and rate, and therefore the others' combined
   * SLICE — the portion of the sale credited to them. A slice is not money
   * anybody received; turning it into one needs their rate. The two cases
   * below assert exactly that boundary.
   */
  it('the credit-share route is CLOSED for every co-author (migration 0049)', async () => {
    /*
     * The minority co-author's ONLY route to the pot, and it is now gone: they
     * cannot scale their own pay by a credit share they can no longer read.
     */
    const credit = await asA(`
      SELECT pc.share_bp FROM product_contributors pc
        JOIN products p ON p.id = pc.product_id
       WHERE p.title_ar = 'منتج مشترك'
    `);
    expect(credit).toHaveLength(0);
  });

  it('KI-3 IS CLOSED: the primary co-author can no longer reach a colleague\u2019s pay', async () => {
    /*
     * This case used to assert the opposite, and was written to fail the day
     * OPEN-15 landed so that it would be re-read on purpose rather than
     * quietly deleted. Migration 0050 landed; here is what changed.
     *
     * THE OLD ROUTE. One rate governed the whole line — the primary author's —
     * so the pot was `(price - tax) x my own rate`, and the colleagues' pay was
     * the pot less my own. Every input was legitimately mine: the price is
     * public, the rate is my contract, the pay is my statement. No policy could
     * close it, which is why KI-3 was filed as arithmetic rather than a defect.
     *
     * THE NEW ROUTE DOES NOT ARRIVE. A colleague's pay is now their slice times
     * THEIR rate, and §12 keeps that rate private — this file already proves A
     * cannot read B's agreement. So the old formula now computes something
     * real but harmless: A's own slice, and therefore the others' combined
     * SLICE. A slice is a portion of a sale, not a payment to anybody.
     */
    const rate = await asA<{ engineer_bp: number }>(
      'SELECT engineer_bp FROM commission_agreements',
    );
    const price = await asA<{ amount_minor: string }>(`
      SELECT pr.amount_minor FROM product_prices pr
        JOIN products p ON p.id = pr.product_id
       WHERE p.title_ar = 'منتج مشترك' AND pr.effective_to IS NULL
    `);
    const line = await asA<{ engineer_minor: string }>(`
      SELECT engineer_minor FROM settlement_lines
       WHERE kind = 'SALE' AND product_title = 'منتج مشترك'
    `);

    const net = BigInt(price[0]!.amount_minor);       // tax ships at zero
    const myRate = BigInt(rate[0]!.engineer_bp);
    const myPay = BigInt(line[0]!.engineer_minor);

    // (a) The formula that used to work: pot = net x my rate, less my pay.
    const oldFormula = (net * myRate) / 10_000n - myPay;

    // (b) The best A can do now: recover their OWN slice from their own pay
    //     and rate, and subtract it from the net.
    const mySlice = (myPay * 10_000n) / myRate;
    const othersSlice = net - mySlice;

    const [bPay] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({
        amountMinor: orderItemContributors.amountMinor,
        sliceMinor: orderItemContributors.sliceMinor,
      })
        .from(orderItemContributors)
        .innerJoin(orderItems, eq(orderItems.id, orderItemContributors.orderItemId))
        .where(sql`${orderItems.productId} = ${ids.productShared}
                   AND ${orderItemContributors.contributorId} = ${ids.contribB}`),
    );

    // (a) now lands on nothing at all — not B's pay, and not even B's slice.
    //     It mixes A's rate with B's portion, which no longer describes anything.
    expect(oldFormula).not.toBe(bPay!.amountMinor);
    expect(oldFormula).not.toBe(bPay!.sliceMinor);

    /*
     * (b) reaches B's SLICE exactly — and stops there. A slice is the portion
     * of the sale credited to B, not a sum of money B received: B is paid 70%
     * of it under an agreement A cannot read. The gap between the two numbers
     * is precisely the private rate, and it is where KI-3 died.
     */
    expect(othersSlice).toBe(bPay!.sliceMinor);
    expect(bPay!.amountMinor).toBeLessThan(bPay!.sliceMinor!);
    expect(othersSlice).not.toBe(bPay!.amountMinor);
  });

  it('the MINORITY co-author cannot: they do not know the governing rate', async () => {
    /*
     * The asymmetry that makes the fix worth making. B holds 40%, so A's
     * agreement governs the sale — and §12 keeps A's rate private, which this
     * file already proved. B's only route to the pot is scaling their own pay
     * by their own credit share, which is exactly the channel migration 0049
     * closes.
     */
    const rates = await withRawActorContext(RAW_B, (tx) =>
      tx.execute(sql`SELECT engineer_bp FROM commission_agreements`),
    ) as unknown as Array<{ engineer_bp: number }>;

    // B reads their own 70% and never A's 80% — so B cannot compute the pot,
    // which was divided at A's rate.
    expect(rates.every((r) => r.engineer_bp === B_BP)).toBe(true);
    expect(rates.some((r) => r.engineer_bp === A_BP)).toBe(false);
  });

  it('but A still cannot read that number, nor B\u2019s rate, from anywhere', async () => {
    // The distinction matters: inference is arithmetic the platform cannot
    // prevent; disclosure is a row it must never return. This is the second.
    const leaked = await asA<{ n: string }>(`
      SELECT COUNT(*)::text AS n FROM order_item_contributors
       WHERE contributor_id <> '${ids.contribA}'
    `);
    expect(leaked[0]!.n).toBe('0');
  });
});
