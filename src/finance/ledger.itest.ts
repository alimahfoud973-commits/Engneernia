import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements,
  orderItems, orders, paymentMethods, payments, productContributors,
  productPrices, products, refundRequestItems, refundRequests, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { approveRefund, markRefundPaid, rejectRefund, requestRefund } from '@/commerce/refunds';
import { checkLedgerHealth } from '@/ledger/verify';
import { contributorStatement } from './balances';
import { outstandingPayables, revenueByPeriod } from './reports';
import { CONTRIBUTOR_SCOPED_ACCOUNTS, LEDGER_ACCOUNTS } from '@/ledger/accounts';
import { PLATFORM_TIMEZONE } from '@/lib/time/period';
import { RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * The full text of a rejection, driver wrapper included.
 *
 * postgres.js reports a failed statement as "Failed query: …" and hangs the
 * real PostgreSQL error off `cause`. Asserting on `message` alone would match
 * the wrapper and pass for ANY failure — including the wrong one.
 */
async function rejectionText(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('Expected the operation to be refused, but it succeeded');
}

/**
 * ===========================================================================
 * PHASE P6 EXIT CRITERIA
 * ===========================================================================
 *   1. The ledger sums to zero in every currency, always.
 *   2. A refund reverses the sale exactly, without touching it.
 *   3. The hash chain detects tampering performed with DIRECT DATABASE
 *      ACCESS — not through the application, which cannot tamper at all.
 *   4. A contributor reads their own ledger lines and nobody else's, with
 *      the application's own filtering bypassed.
 *   5. Balances are derived, and survive a refund landing after a payout.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: randomUUID(), customer: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(),
  otherEngineerUser: randomUUID(), otherContributor: randomUUID(),
  discipline: randomUUID(), product: randomUUID(), otherProduct: randomUUID(),
  method: randomUUID(),
};
const slug = `p6-prod-${suffix}`;
const otherSlug = `p6-other-${suffix}`;

const OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
const base = {
  kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true,
} as const;

const owner: Actor = {
  ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false,
};
const customer: Actor = {
  ...base, userId: ids.customer, role: 'CUSTOMER', contributorId: null, contributorActive: false,
};
const engineer: Actor = {
  ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR',
  contributorId: ids.contributor, contributorActive: true,
};

const PRICE = 2000n; // $20.00 — 80/20 gives $16.00 / $4.00

/** Buy the product and have the owner approve it. Returns the order id. */
async function completeAPurchase(productSlug = slug): Promise<string> {
  const order = await createOrder(customer, { productSlugs: [productSlug] });
  await placeOrder(customer, { orderId: order.orderId, paymentMethodId: ids.method });

  const payment = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)),
  );

  await approvePayment(owner, { paymentId: payment[0]!.id });
  return order.orderId;
}

beforeAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.owner, email: `p6-owner+${suffix}@test.local`, passwordHash: 'x', role: 'OWNER', status: 'ACTIVE', displayName: 'Owner' },
      { id: ids.customer, email: `p6-cust+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer', countryCode: 'SY' },
      { id: ids.engineerUser, email: `p6-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer One' },
      { id: ids.otherEngineerUser, email: `p6-eng2+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer Two' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contributor, userId: ids.engineerUser, publicSlug: `p6-eng-${suffix}`, settlementCode: `P6A${suffix}`, displayName: 'Engineer One', isActive: true },
      { id: ids.otherContributor, userId: ids.otherEngineerUser, publicSlug: `p6-eng2-${suffix}`, settlementCode: `P6B${suffix}`, displayName: 'Engineer Two', isActive: true },
    ]);
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `p6-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 94,
    });
    await tx.insert(products).values([
      { id: ids.product, slug, titleAr: 'مخطط الاختبار', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
      { id: ids.otherProduct, slug: otherSlug, titleAr: 'مخطط آخر', disciplineId: ids.discipline, fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date() },
    ]);
    await tx.insert(productContributors).values([
      { productId: ids.product, contributorId: ids.contributor, shareBp: 10000 },
      { productId: ids.otherProduct, contributorId: ids.otherContributor, shareBp: 10000 },
    ]);
    await tx.insert(productPrices).values([
      { productId: ids.product, amountMinor: PRICE, currency: 'USD' },
      { productId: ids.otherProduct, amountMinor: PRICE, currency: 'USD' },
    ]);
    await tx.insert(commissionAgreements).values([
      { contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner },
      { contributorId: ids.otherContributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner },
    ]);
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `p6-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل بنكي', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 120_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    /*
     * Ledger rows are NOT deleted, and cannot be: they are append-only, and
     * migration 0026 deliberately removed the foreign key that would have made
     * this cleanup delete them. The books keep this run's entries forever,
     * which is the behaviour under test.
     */
    const requestIds = await tx
      .select({ id: refundRequests.id })
      .from(refundRequests)
      .where(eq(refundRequests.customerId, ids.customer));

    if (requestIds.length > 0) {
      await tx.delete(refundRequestItems).where(
        sql`refund_request_id IN (${sql.join(requestIds.map((r) => sql`${r.id}`), sql`, `)})`,
      );
      await tx.delete(refundRequests).where(eq(refundRequests.customerId, ids.customer));
    }

    await tx.delete(entitlements).where(eq(entitlements.customerId, ids.customer));
    await tx.delete(orders).where(eq(orders.customerId, ids.customer));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(
      sql`contributor_id IN (${ids.contributor}, ${ids.otherContributor})`,
    );
    await tx.delete(productContributors).where(
      sql`product_id IN (${ids.product}, ${ids.otherProduct})`,
    );
    await tx.delete(products).where(sql`id IN (${ids.product}, ${ids.otherProduct})`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(
      sql`id IN (${ids.contributor}, ${ids.otherContributor})`,
    );
    await tx.delete(users).where(
      sql`id IN (${ids.owner}, ${ids.customer}, ${ids.engineerUser}, ${ids.otherEngineerUser})`,
    );
  });
  await closeDb();
}, 60_000);

// ===========================================================================
describe('1. a sale reaches the books', () => {
  let orderId: string;

  it('posts a balanced entry when the owner approves', async () => {
    orderId = await completeAPurchase();

    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT l.account_code, l.amount_minor::text AS amount, l.contributor_id,
               l.contributor_name, l.currency, t.kind::text AS kind, t.period_key
          FROM ledger_lines l
          JOIN ledger_transactions t ON t.id = l.transaction_id
         WHERE t.reference_id = ${orderId}
         ORDER BY l.line_no
      `),
    ) as unknown as Array<Record<string, string>>;

    expect(lines).toHaveLength(3);
    expect(lines.map((l) => [l.account_code, l.amount])).toEqual([
      [LEDGER_ACCOUNTS.PLATFORM_CASH, '2000'],
      [LEDGER_ACCOUNTS.ENGINEER_PAYABLE, '-1600'],
      [LEDGER_ACCOUNTS.PLATFORM_REVENUE, '-400'],
    ]);

    // The name is copied at posting time so a statement survives the profile.
    expect(lines[1]!.contributor_name).toBe('Engineer One');
    expect(lines.every((l) => l.kind === 'SALE')).toBe(true);
  });

  it('assigns the accounting month in Damascus time, not UTC', async () => {
    // Not a claim about this run's date — a claim about the RULE. The database
    // is asked directly what month it would assign to an instant that falls on
    // opposite sides of midnight in the two zones.
    const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT to_char(timezone(app_accounting_timezone(),
                 timestamptz '2026-09-30 21:30:00+00'), 'YYYY-MM') AS damascus,
               to_char(timezone('UTC',
                 timestamptz '2026-09-30 21:30:00+00'), 'YYYY-MM')  AS utc,
               app_accounting_timezone() AS zone
      `),
    ) as unknown as Array<Record<string, string>>;

    expect(row!.damascus).toBe('2026-10');
    expect(row!.utc).toBe('2026-09');
    // One timezone constant, shared by the database and the application.
    expect(row!.zone).toBe(PLATFORM_TIMEZONE);
  });

  it('the whole ledger balances to zero in every currency', async () => {
    const health = await checkLedgerHealth(owner);
    expect(health.balances.length).toBeGreaterThan(0);
    for (const balance of health.balances) {
      expect(balance.totalMinor).toBe(0n);
    }
    expect(health.isHealthy).toBe(true);
  });

  it('credits the engineer a balance derived from the ledger', async () => {
    const statement = await contributorStatement(engineer);
    const usd = statement.balances.find((b) => b.currency === 'USD');

    expect(usd?.earnedMinor).toBe(1600n);
    expect(usd?.reversedMinor).toBe(0n);
    expect(usd?.balanceMinor).toBe(1600n);
    // Read from settings (5000 = $50), never a constant in the code.
    expect(usd?.minimumPayoutMinor).toBe(5000n);
    expect(usd?.meetsMinimum).toBe(false);
  });
});

// ===========================================================================
describe('2. the application cannot write the books by hand', () => {
  it('refuses a direct INSERT from the application role', async () => {
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.execute(sql`
          INSERT INTO ledger_transactions
            (kind, currency, occurred_at, period_key, reference_type,
             prev_hash, payload_hash, entry_hash)
          VALUES ('ADJUSTMENT', 'USD', now(), '2026-01', 'manual',
                  repeat('0', 64), repeat('a', 64), repeat('b', 64))
        `),
      ),
    );
    // Not a policy refusal — there is no INSERT privilege to exercise.
    expect(message).toMatch(/permission denied/i);
  });

  it('refuses an unbalanced entry even through the posting function', async () => {
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.execute(sql`
          SELECT app_post_ledger_transaction(
            'ADJUSTMENT', 'USD', now(), 'manual', NULL, 'off by one',
            '[{"account":"PLATFORM_CASH","amountMinor":"100"},
              {"account":"PLATFORM_REVENUE","amountMinor":"-99"}]'::jsonb)
        `),
      ),
    );
    expect(message).toMatch(/does not balance/i);
  });

  it('refuses a posting from a non-owner actor', async () => {
    const message = await rejectionText(
      withRawActorContext({ actorId: ids.customer, actorRole: 'CUSTOMER' }, (tx) =>
        tx.execute(sql`
          SELECT app_post_ledger_transaction(
            'ADJUSTMENT', 'USD', now(), 'manual', NULL, NULL,
            '[{"account":"PLATFORM_CASH","amountMinor":"100"},
              {"account":"PLATFORM_REVENUE","amountMinor":"-100"}]'::jsonb)
        `),
      ),
    );
    expect(message).toMatch(/owner/i);
  });

  it('refuses to update or delete a posted line', async () => {
    const message = await rejectionText(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.execute(sql`UPDATE ledger_lines SET amount_minor = 1 WHERE amount_minor = -1600`),
      ),
    );
    expect(message).toMatch(/permission denied|append-only/i);
  });
});

// ===========================================================================
describe('3. a refund reverses the sale exactly, without touching it', () => {
  let orderId: string;
  let refundRequestId: string;

  it('the customer asks and the owner has not yet decided', async () => {
    orderId = await completeAPurchase();

    const request = await requestRefund(customer, {
      orderId,
      reason: 'CORRUPT_FILE',
      customerNote: 'الملف لا يفتح في أي برنامج جربته.',
    });
    refundRequestId = request.refundRequestId;

    expect(request.amountMinor).toBe(PRICE);
    expect(request.reference).toMatch(/^RF-\d{6}$/);

    // Nothing financial has happened yet.
    const health = await checkLedgerHealth(owner);
    expect(health.isHealthy).toBe(true);
  });

  it('a second open request for the same order is refused', async () => {
    await expect(
      requestRefund(customer, {
        orderId, reason: 'DUPLICATE_PAYMENT', customerNote: 'طلب مكرر للاختبار فقط.',
      }),
    ).rejects.toThrow(RuleViolationError);
  });

  it('approval posts the reversal and leaves the sale untouched', async () => {
    const before = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    );
    expect(before[0]!.engineerAmountMinor).toBe(1600n);

    const result = await approveRefund(owner, { refundRequestId });
    expect(result.amountMinor).toBe(PRICE);

    const after = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    );

    // THE SALE IS UNCHANGED. Only the refund marks were written.
    expect(after[0]!.engineerAmountMinor).toBe(1600n);
    expect(after[0]!.platformAmountMinor).toBe(400n);
    expect(after[0]!.unitPriceMinor).toBe(PRICE);
    expect(after[0]!.snapshotTakenAt).toEqual(before[0]!.snapshotTakenAt);
    expect(after[0]!.refundedAt).not.toBeNull();

    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT account_code, amount_minor::text AS amount
          FROM ledger_lines
         WHERE transaction_id = ${result.ledgerTransactionId}
         ORDER BY line_no
      `),
    ) as unknown as Array<Record<string, string>>;

    // Exactly the sale's numbers with the sign flipped — and against the
    // liability, not cash, because the transfer has not happened yet.
    expect(lines.map((l) => [l.account_code, l.amount])).toEqual([
      [LEDGER_ACCOUNTS.ENGINEER_PAYABLE, '1600'],
      [LEDGER_ACCOUNTS.PLATFORM_REVENUE_REVERSED, '400'],
      [LEDGER_ACCOUNTS.CUSTOMER_REFUNDS_PAYABLE, '-2000'],
    ]);
  });

  it('closes the file and stops counting the sale', async () => {
    // Scoped to THIS order: the customer has bought several times in this run,
    // and an unscoped query would answer about whichever row came back first.
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT e.revoked_at, e.revoked_reason
          FROM entitlements e
          JOIN order_items oi ON oi.id = e.order_item_id
         WHERE oi.order_id = ${orderId}
      `),
    ) as unknown as Array<Record<string, string | null>>;

    expect(rows).toHaveLength(1);
    // Revoked, never deleted (§37).
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[0]!.revoked_reason).toMatch(/^استرجاع RF-/);

    const [order] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)),
    );
    expect(order!.status).toBe('REFUNDED');
  });

  it('the books still balance after the reversal', async () => {
    const health = await checkLedgerHealth(owner);
    for (const balance of health.balances) expect(balance.totalMinor).toBe(0n);
    expect(health.isHealthy).toBe(true);
  });

  it('recording the transfer moves the cash and balances again', async () => {
    const payout = await markRefundPaid(owner, {
      refundRequestId, payoutReference: 'TRX-123',
    });

    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT account_code, amount_minor::text AS amount
          FROM ledger_lines WHERE transaction_id = ${payout.ledgerTransactionId}
         ORDER BY line_no
      `),
    ) as unknown as Array<Record<string, string>>;

    expect(lines.map((l) => [l.account_code, l.amount])).toEqual([
      [LEDGER_ACCOUNTS.CUSTOMER_REFUNDS_PAYABLE, '2000'],
      [LEDGER_ACCOUNTS.PLATFORM_CASH, '-2000'],
    ]);

    const health = await checkLedgerHealth(owner);
    expect(health.isHealthy).toBe(true);
  });

  it('refusing to approve twice', async () => {
    await expect(approveRefund(owner, { refundRequestId })).rejects.toThrow(RuleViolationError);
  });

  it('the engineer sees the claw-back in their own balance', async () => {
    const statement = await contributorStatement(engineer);
    const usd = statement.balances.find((b) => b.currency === 'USD');

    // Two sales earned, one reversed.
    expect(usd?.earnedMinor).toBe(3200n);
    expect(usd?.reversedMinor).toBe(1600n);
    expect(usd?.balanceMinor).toBe(1600n);
  });
});

// ===========================================================================
describe('4. a rejected refund changes nothing financial', () => {
  it('records the refusal and leaves the books alone', async () => {
    const orderId = await completeAPurchase();
    const before = await checkLedgerHealth(owner);

    const request = await requestRefund(customer, {
      orderId, reason: 'NOT_AS_DESCRIBED', customerNote: 'ليس ما توقعته من الوصف.',
    });

    await rejectRefund(owner, {
      refundRequestId: request.refundRequestId,
      decisionNote: 'المحتوى مطابق للوصف المنشور.',
    });

    const after = await checkLedgerHealth(owner);
    expect(after.balances.map((b) => b.lineCount)).toEqual(
      before.balances.map((b) => b.lineCount),
    );

    const [order] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)),
    );
    expect(order!.status).toBe('COMPLETED');

    const [entitlement] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(entitlements).where(eq(entitlements.orderItemId,
        sql`(SELECT id FROM order_items WHERE order_id = ${orderId} LIMIT 1)` as never)),
    );
    expect(entitlement?.revokedAt ?? null).toBeNull();
  });
});

// ===========================================================================
describe('5. the hash chain detects tampering (§37, §48)', () => {
  it('verifies clean today', async () => {
    const health = await checkLedgerHealth(owner);
    expect(health.chainProblems).toEqual([]);
  });

  it('names the first altered entry when history is rewritten directly', async () => {
    /*
     * This test does what the append-only trigger and the missing INSERT grant
     * are designed to prevent — by connecting as a SUPERUSER and switching the
     * trigger off. That is the threat model: somebody with the database
     * password, not somebody using the application.
     *
     * It runs in a transaction that is rolled back, so the dev database is
     * left exactly as it was.
     */
    const postgres = (await import('postgres')).default;
    const superUrl = process.env.DATABASE_SUPERUSER_URL;
    if (!superUrl) {
      throw new Error('DATABASE_SUPERUSER_URL must be set for the tamper test');
    }

    const client = postgres(superUrl, { max: 1 });

    /*
     * The rollback must be forced by THROWING. `client.begin` commits when the
     * callback returns normally — returning the rows from inside would leave
     * the tampered amount in the database permanently, and the ledger is
     * append-only, so nothing in the application could undo it afterwards.
     */
    class Rollback extends Error {
      constructor(readonly problems: ReadonlyArray<Record<string, unknown>>) {
        super('rollback');
      }
    }

    let problems: ReadonlyArray<Record<string, unknown>> = [];
    try {
      await client.begin(async (tx) => {
        await tx`SELECT set_config('app.actor_role', 'OWNER', true)`;
        await tx`ALTER TABLE ledger_lines DISABLE TRIGGER ledger_lines_no_update`;
        await tx`
          UPDATE ledger_lines SET amount_minor = amount_minor - 1
           WHERE seq = (SELECT MIN(seq) FROM ledger_lines
                         WHERE account_code = ${LEDGER_ACCOUNTS.PLATFORM_REVENUE})
        `;
        await tx`ALTER TABLE ledger_lines ENABLE TRIGGER ledger_lines_no_update`;
        const found = await tx`
          SELECT seq::text AS seq, problem FROM app_verify_ledger_chain()
        `;
        throw new Rollback([...found] as Array<Record<string, unknown>>);
      });
      throw new Error('The tampering transaction was expected to roll back');
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
      problems = error.problems;
    } finally {
      await client.end();
    }

    const messages = problems.map((row) => row.problem as string);
    expect(messages.some((m) => /content altered/.test(m))).toBe(true);

    // The break propagates: the altered entry fails its own content hash, and
    // every entry after it loses its link — which is what makes a quiet edit
    // to one old row impossible to hide.
    expect(messages.some((m) => /entry_hash does not match/.test(m))).toBe(true);
  });

  it('is intact again once that transaction is rolled back', async () => {
    const health = await checkLedgerHealth(owner);
    expect(health.chainProblems).toEqual([]);
  });
});

// ===========================================================================
describe('6. what each party may read (§12, §49)', () => {
  it('a contributor reads only their own ledger lines', async () => {
    // Sell the OTHER engineer's product so there are two parties in the books.
    await completeAPurchase(otherSlug);

    const mine = await withRawActorContext(
      { actorId: ids.engineerUser, actorRole: 'CONTRIBUTOR', contributorId: ids.contributor },
      (tx) => tx.execute(sql`SELECT contributor_id, account_code FROM ledger_lines`),
    ) as unknown as Array<Record<string, string>>;

    // Raw SQL with NO WHERE CLAUSE, under the contributor's own context. The
    // database still returns nothing but their own rows.
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.contributor_id === ids.contributor)).toBe(true);
    expect(mine.every((row) => row.account_code === LEDGER_ACCOUNTS.ENGINEER_PAYABLE)).toBe(true);
  });

  it('a customer reads no ledger lines at all', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.customer, actorRole: 'CUSTOMER' },
      (tx) => tx.execute(sql`SELECT * FROM ledger_lines`),
    ) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('a contributor cannot read another contributor\'s statement', async () => {
    // Not Forbidden — NotFound. Confirming the other contributor exists would
    // itself be a disclosure (CLAUDE.md rule 5).
    await expect(contributorStatement(engineer, ids.otherContributor)).rejects.toThrow();
  });

  it('a contributor cannot read the platform report', async () => {
    await expect(revenueByPeriod(engineer)).rejects.toThrow(RuleViolationError);
    await expect(outstandingPayables(engineer)).rejects.toThrow(RuleViolationError);
    await expect(checkLedgerHealth(engineer)).rejects.toThrow(RuleViolationError);
  });

  it('the owner sees both engineers in the payables list', async () => {
    const payables = await outstandingPayables(owner, { minimumPayoutMinor: 5000n });
    const mine = payables.find((p) => p.contributorId === ids.contributor);
    const theirs = payables.find((p) => p.contributorId === ids.otherContributor);

    expect(mine?.balanceMinor).toBe(3200n); // three sales, one reversed
    expect(theirs?.balanceMinor).toBe(1600n);
    expect(mine?.meetsMinimum).toBe(false);
  });

  it('the platform report reads its figures from the ledger', async () => {
    const periods = await revenueByPeriod(owner, { periods: 24 });
    const usd = periods.filter((p) => p.currency === 'USD');
    expect(usd.length).toBeGreaterThan(0);

    for (const period of usd) {
      // Internal consistency of every reported month: what customers paid is
      // what the two sides of the split add up to.
      expect(period.engineerShareMinor + period.platformRevenueMinor)
        .toBe(period.grossSalesMinor);
      expect(period.netPlatformMinor)
        .toBe(period.platformRevenueMinor - period.revenueReversedMinor);
    }
  });
});

// ===========================================================================
describe('7. the code and the database agree about the chart of accounts', () => {
  it('every account the application can name exists in the database', async () => {
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`SELECT code, requires_contributor FROM ledger_accounts ORDER BY sort_order`),
    ) as unknown as Array<{ code: string; requires_contributor: boolean }>;

    const inDatabase = new Set<string>(rows.map((row) => row.code));
    const inCode = new Set<string>(Object.values(LEDGER_ACCOUNTS));

    // Both directions. An account only in the code is a runtime rejection
    // waiting to happen; one only in the database is a posting route nobody
    // reviewed.
    expect([...inCode].filter((code) => !inDatabase.has(code))).toEqual([]);
    expect([...inDatabase].filter((code) => !inCode.has(code))).toEqual([]);

    // And they agree about WHICH accounts name a person.
    const dbContributorScoped = new Set<string>(
      rows.filter((row) => row.requires_contributor).map((row) => row.code),
    );
    expect([...dbContributorScoped].sort())
      .toEqual([...CONTRIBUTOR_SCOPED_ACCOUNTS].map(String).sort());
  });
});

// ===========================================================================
describe('8. a refund landing after a payout leaves a negative balance', () => {
  it('reports the debt rather than rounding it away', async () => {
    const orderId = await completeAPurchase();

    // Simulate the settlement that P7 will perform: pay out everything owed.
    const statement = await contributorStatement(engineer);
    const owed = statement.balances.find((b) => b.currency === 'USD')!.balanceMinor;
    expect(owed).toBeGreaterThan(0n);

    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT app_post_ledger_transaction(
          'SETTLEMENT_PAYOUT', 'USD', now(), 'settlement', NULL, 'تسوية تجريبية',
          ${JSON.stringify([
            { account: 'ENGINEER_PAYABLE', contributorId: ids.contributor, amountMinor: owed.toString() },
            { account: 'PLATFORM_CASH', amountMinor: (-owed).toString() },
          ])}::jsonb)
      `),
    );

    const settled = await contributorStatement(engineer);
    expect(settled.balances.find((b) => b.currency === 'USD')?.balanceMinor).toBe(0n);

    // NOW the refund arrives, for a sale in an already-settled month.
    const request = await requestRefund(customer, {
      orderId, reason: 'PLATFORM_ERROR', customerNote: 'خطأ تقني عند التنزيل تكرر مراراً.',
    });
    await approveRefund(owner, { refundRequestId: request.refundRequestId });

    const after = await contributorStatement(engineer);
    const usd = after.balances.find((b) => b.currency === 'USD');

    // The engineer was paid for a sale that was undone. The books say so.
    expect(usd?.balanceMinor).toBe(-1600n);
    expect(usd?.meetsMinimum).toBe(false);

    // And the ledger as a whole still sums to zero.
    const health = await checkLedgerHealth(owner);
    for (const balance of health.balances) expect(balance.totalMinor).toBe(0n);
  });
});
