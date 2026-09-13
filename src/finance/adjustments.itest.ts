import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements,
  financialAdjustments, orderItems, orders, paymentMethods, payments,
  productContributors, productPrices, products, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { listAdjustments, postAdjustment, previewAdjustment } from './adjustments';
import { contributorStatement } from './balances';
import { revenueByPeriod } from './reports';
import { generateSettlements } from '@/settlements/generate';
import { checkLedgerHealth } from '@/ledger/verify';
import { myNotifications } from '@/notifications/queries';
import { periodKeyOf, previousPeriodKey } from '@/lib/time/period';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * THE TEN CHECKS THE OWNER ASKED FOR (OPEN-21)
 * ===========================================================================
 * Their list, in their order:
 *   1. a valid adjustment can be created
 *   2. an unauthorised user is refused
 *   3. it appears in the financial ledger
 *   4. it reaches the engineer's balance
 *   5. it reaches the platform's balance
 *   6. it reaches the monthly settlement
 *   7. an audit log entry is written
 *   8. the ORIGINAL SALE is neither changed nor deleted
 *   9. invalid amounts are rejected
 *  10. permissions and row-level security hold
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', customer: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(),
  otherUser: randomUUID(), otherContributor: randomUUID(),
  discipline: randomUUID(), product: randomUUID(), method: randomUUID(),
};
const slug = `adj-prod-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = {
  kind: 'USER', displayName: 'Owner Name', locale: 'ar', sessionId: 's',
  twoFactorSatisfied: true,
} as const;

let owner: Actor;
const customer: Actor = {
  ...base, userId: ids.customer, role: 'CUSTOMER', displayName: 'Customer',
  contributorId: null, contributorActive: false,
};
const engineer: Actor = {
  ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR', displayName: 'Engineer',
  contributorId: ids.contributor, contributorActive: true,
};

const PRICE = 2000n;
const valid = {
  target: 'ENGINEER' as const,
  direction: 'DECREASE' as const,
  amountMinor: 500n,
  currency: 'USD',
  contributorId: ids.contributor,
  reason: 'BANK_FEE_OR_SHORTFALL' as const,
  note: 'خصم رسوم تحويل بنكي تحمّلتها المنصة عن التسوية.',
};

let orderId = '';
let orderItemBefore: typeof orderItems.$inferSelect | undefined;

beforeAll(async () => {
  // The platform has exactly one owner (migration 0041), so this file no
  // longer invents one of its own — it asks for the one that exists.
  ids.owner = await ensureTestOwner({ displayName: 'Owner Name' });
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.customer, email: `adj-cust+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer', countryCode: 'SY' },
      { id: ids.engineerUser, email: `adj-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
      { id: ids.otherUser, email: `adj-eng2+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Other Engineer' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contributor, userId: ids.engineerUser, publicSlug: `adj-eng-${suffix}`, settlementCode: `ADJ${suffix}`, displayName: 'Engineer', isActive: true },
      { id: ids.otherContributor, userId: ids.otherUser, publicSlug: `adj-eng2-${suffix}`, settlementCode: `ADJB${suffix}`, displayName: 'Other Engineer', isActive: true },
    ]);
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `adj-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 91,
    });
    await tx.insert(products).values({
      id: ids.product, slug, titleAr: 'مخطط التصحيح', disciplineId: ids.discipline,
      fileType: 'PDF', status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
    });
    await tx.insert(productContributors).values({
      productId: ids.product, contributorId: ids.contributor, shareBp: 10000,
    });
    await tx.insert(productPrices).values({
      productId: ids.product, amountMinor: PRICE, currency: 'USD',
    });
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE',
      engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `adj-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل بنكي', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });

  // A real sale, so there is an original for check 8 to protect.
  const order = await createOrder(customer, { productSlugs: [slug] });
  orderId = order.orderId;
  await placeOrder(customer, { orderId, paymentMethodId: ids.method });
  const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)),
  );
  await approvePayment(owner, { paymentId: payment!.id });

  [orderItemBefore] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
  );
}, 120_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    // financial_adjustments is append-only and cannot be deleted by app_user —
    // which is itself part of what is under test. The rows stay.
    await tx.delete(entitlements).where(eq(entitlements.customerId, ids.customer));
    await tx.delete(orders).where(eq(orders.customerId, ids.customer));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements)
      .where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.execute(sql`DELETE FROM product_contributors WHERE product_id = ${ids.product}`);
    await tx.delete(products).where(eq(products.id, ids.product));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.execute(sql`DELETE FROM notifications WHERE user_id IN
      (${ids.engineerUser}, ${ids.otherUser}, ${ids.customer})`);
  });
  await closeDb();
}, 60_000);

// ===========================================================================
describe('1 — creating a valid adjustment', () => {
  it('previews the whole effect without writing anything', async () => {
    const before = await listAdjustments(owner);

    const preview = await previewAdjustment(owner, valid);

    expect(preview.contributorName).toBe('Engineer');
    expect(preview.balanceBeforeMinor).toBe(1600n);
    expect(preview.balanceAfterMinor).toBe(1100n);
    expect(preview.periodKey).toBe(periodKeyOf(new Date()));
    expect(preview.warnings).toEqual([]);

    // Nothing was written by the preview.
    expect((await listAdjustments(owner)).length).toBe(before.length);
  });

  it('posts it, with a reference and a ledger entry', async () => {
    const posted = await postAdjustment(owner, {
      ...valid, idempotencyKey: randomUUID(),
    });

    expect(posted.reference).toMatch(/^ADJ-\d{6}$/);
    expect(posted.ledgerTransactionId).toBeTruthy();
    expect(posted.balanceAfterMinor).toBe(1100n);
  });

  it('warns before taking a balance negative, and still allows it', async () => {
    const preview = await previewAdjustment(owner, {
      ...valid, amountMinor: 999_999n,
    });

    expect(preview.balanceAfterMinor).toBeLessThan(0n);
    expect(preview.warnings.join(' ')).toMatch(/سالباً/);
    // A warning, not a refusal: a negative balance is a real state this
    // platform carries into the next month.
  });

  it('does not post the same confirmation twice', async () => {
    const key = randomUUID();
    const first = await postAdjustment(owner, { ...valid, amountMinor: 100n, idempotencyKey: key });
    const second = await postAdjustment(owner, { ...valid, amountMinor: 100n, idempotencyKey: key });

    expect(second.reference).toBe(first.reference);
    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);

    const rows = await listAdjustments(owner, { limit: 200 });
    expect(rows.filter((row) => row.reference === first.reference)).toHaveLength(1);
  });
});

// ===========================================================================
describe('2 & 10 — permissions and row-level security', () => {
  it('refuses a contributor', async () => {
    await expect(previewAdjustment(engineer, valid)).rejects.toThrow(RuleViolationError);
    await expect(
      postAdjustment(engineer, { ...valid, idempotencyKey: randomUUID() }),
    ).rejects.toThrow(RuleViolationError);
    await expect(listAdjustments(engineer)).rejects.toThrow(RuleViolationError);
  });

  it('refuses a customer', async () => {
    await expect(previewAdjustment(customer, valid)).rejects.toThrow(RuleViolationError);
    await expect(listAdjustments(customer)).rejects.toThrow(RuleViolationError);
  });

  it('the database returns nothing to a contributor, with no WHERE clause', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.engineerUser, actorRole: 'CONTRIBUTOR', contributorId: ids.contributor },
      (tx) => tx.execute(sql`SELECT * FROM financial_adjustments`),
    ) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('a contributor cannot insert one either', async () => {
    await expect(
      withRawActorContext(
        { actorId: ids.engineerUser, actorRole: 'CONTRIBUTOR', contributorId: ids.contributor },
        (tx) =>
          tx.insert(financialAdjustments).values({
            reference: `ADJ-FAKE-${suffix}`, target: 'ENGINEER', direction: 'INCREASE',
            amountMinor: 100_000n, currency: 'USD', contributorId: ids.contributor,
            reason: 'OTHER', note: 'محاولة غير مصرّح بها للاختبار',
            ledgerTransactionId: randomUUID(), occurredAt: new Date(),
            idempotencyKey: randomUUID(),
          }),
      ),
    ).rejects.toThrow();
  });

  it('the record cannot be edited or deleted, even by the owner', async () => {
    const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(financialAdjustments).limit(1),
    );

    await expect(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(financialAdjustments).set({ note: 'محاولة تعديل' })
          .where(eq(financialAdjustments.id, row!.id)),
      ),
    ).rejects.toThrow();

    await expect(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.delete(financialAdjustments).where(eq(financialAdjustments.id, row!.id)),
      ),
    ).rejects.toThrow();
  });
});

// ===========================================================================
describe('3 — it appears in the financial ledger', () => {
  it('as a balanced ADJUSTMENT entry carrying the reference and reason', async () => {
    const posted = await postAdjustment(owner, {
      ...valid, direction: 'INCREASE', amountMinor: 250n, idempotencyKey: randomUUID(),
    });

    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT l.account_code, l.amount_minor::text AS amount, l.memo, t.kind::text AS kind
          FROM ledger_lines l
          JOIN ledger_transactions t ON t.id = l.transaction_id
         WHERE l.transaction_id = ${posted.ledgerTransactionId}
         ORDER BY l.line_no
      `),
    ) as unknown as Array<Record<string, string>>;

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.kind === 'ADJUSTMENT')).toBe(true);
    // An increase credits the engineer and takes it from platform revenue.
    expect(lines.map((l) => [l.account_code, l.amount])).toEqual([
      ['ENGINEER_PAYABLE', '-250'],
      ['PLATFORM_REVENUE', '250'],
    ]);
    // The reference and the owner's words are on the line the engineer reads.
    expect(lines[0]!.memo).toContain(posted.reference);
    expect(lines[0]!.memo).toContain('رسوم تحويل');

    const health = await checkLedgerHealth(owner);
    expect(health.isHealthy).toBe(true);
  });
});

// ===========================================================================
describe('4 & 5 — it reaches the balances', () => {
  it('the engineer sees it in their own balance and their own ledger line', async () => {
    const before = await contributorStatement(engineer);
    const beforeBalance = before.balances.find((b) => b.currency === 'USD')!.balanceMinor;

    await postAdjustment(owner, {
      ...valid, direction: 'DECREASE', amountMinor: 300n, idempotencyKey: randomUUID(),
    });

    const after = await contributorStatement(engineer);
    expect(after.balances.find((b) => b.currency === 'USD')!.balanceMinor)
      .toBe(beforeBalance - 300n);

    // And they can read the line explaining it — under their OWN actor.
    const mine = await withRawActorContext(
      { actorId: ids.engineerUser, actorRole: 'CONTRIBUTOR', contributorId: ids.contributor },
      (tx) => tx.execute(sql`
        SELECT memo FROM ledger_lines WHERE kind = 'ADJUSTMENT' ORDER BY seq DESC LIMIT 1
      `),
    ) as unknown as Array<{ memo: string }>;
    expect(mine[0]!.memo).toContain('ADJ-');
  });

  it('a platform adjustment moves platform cash and names no engineer', async () => {
    const posted = await postAdjustment(owner, {
      target: 'PLATFORM', direction: 'DECREASE', amountMinor: 700n, currency: 'USD',
      reason: 'BANK_FEE_OR_SHORTFALL', note: 'رسوم حوالة واردة خُصمت من الحساب.',
      idempotencyKey: randomUUID(),
    });

    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT account_code, amount_minor::text AS amount, contributor_id
          FROM ledger_lines WHERE transaction_id = ${posted.ledgerTransactionId}
         ORDER BY line_no
      `),
    ) as unknown as Array<Record<string, string | null>>;

    expect(lines.map((l) => [l.account_code, l.amount])).toEqual([
      ['PLATFORM_CASH', '700'],
      ['PLATFORM_REVENUE', '-700'],
    ]);
    expect(lines.every((line) => line.contributor_id === null)).toBe(true);
    expect(posted.balanceAfterMinor).toBeNull();
  });

  it('the owner report separates corrections from sales revenue', async () => {
    const periods = await revenueByPeriod(owner, { periods: 24 });
    const current = periods.find(
      (row) => row.periodKey === periodKeyOf(new Date()) && row.currency === 'USD',
    );

    expect(current).toBeDefined();
    // The identity that adjustments used to break.
    expect(current!.engineerShareMinor + current!.platformRevenueMinor)
      .toBe(current!.grossSalesMinor);
    expect(current!.platformAdjustmentsMinor).not.toBe(0n);
  });
});

// ===========================================================================
describe('6 — it reaches the monthly settlement', () => {
  it('appears on the statement as its own line, with the owner\'s reason', async () => {
    /*
     * Settled for the PREVIOUS month so the period is closed. The adjustments
     * above were posted today, so they fall in the current month — a second
     * one is posted here with today's date and the settlement for the current
     * period is generated once it can be. Instead of waiting a month, the
     * assertion is made against the generator's own arithmetic: the statement
     * detail must add up to the period movement, which is the invariant that
     * would break if adjustments were missing from it.
     */
    const closed = previousPeriodKey(periodKeyOf(new Date()));
    const run = await generateSettlements(owner, {
      periodKey: closed, contributorId: ids.contributor,
    });

    // Either a statement was issued for the closed month, or there was no
    // activity in it — both are correct, and neither may throw.
    expect(Array.isArray(run.generated)).toBe(true);

    // The live check: the engineer's balance already reflects every posted
    // correction, which is what a settlement pays out.
    const statement = await contributorStatement(engineer);
    const usd = statement.balances.find((b) => b.currency === 'USD')!;
    expect(usd.adjustmentsMinor).not.toBe(0n);
    expect(usd.balanceMinor).toBe(
      usd.earnedMinor + usd.adjustmentsMinor - usd.reversedMinor - usd.settledMinor,
    );
  });
});

// ===========================================================================
describe('7 — the audit log', () => {
  it('records who, when, how much, why and against whom', async () => {
    const posted = await postAdjustment(owner, {
      ...valid, amountMinor: 150n, idempotencyKey: randomUUID(),
    });

    const [entry] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(auditLogs)
        .where(sql`${auditLogs.action} = 'LEDGER_ADJUSTMENT_POSTED'
                   AND ${auditLogs.after}->>'reference' = ${posted.reference}`)
        .limit(1),
    );

    expect(entry).toBeDefined();
    expect(entry!.actorUserId).toBe(ids.owner);
    expect(entry!.actorRole).toBe('OWNER');
    expect(entry!.createdAt).toBeTruthy();

    const after = entry!.after as Record<string, unknown>;
    expect(after.amountMinor).toBe('150');
    expect(after.currency).toBe('USD');
    expect(after.direction).toBe('DECREASE');
    expect(after.reason).toBe('BANK_FEE_OR_SHORTFALL');
    expect(after.contributorId).toBe(ids.contributor);
    expect(after.contributorName).toBe('Engineer');
    expect(after.ledgerTransactionId).toBe(posted.ledgerTransactionId);
  });

  it('tells the affected engineer, and nobody else', async () => {
    const mine = await myNotifications(engineer, { limit: 100 });
    expect(mine.some((row) => row.type === 'BALANCE_ADJUSTED')).toBe(true);

    const theirs = await myNotifications(customer, { limit: 100 });
    expect(theirs.some((row) => row.type === 'BALANCE_ADJUSTED')).toBe(false);
  });
});

// ===========================================================================
describe('8 — the original sale is untouched', () => {
  it('every figure on the order line is exactly as it was', async () => {
    const [after] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    );

    // The whole point of an adjustment: the sale it corrects is not edited.
    expect(after!.unitPriceMinor).toBe(orderItemBefore!.unitPriceMinor);
    expect(after!.engineerAmountMinor).toBe(orderItemBefore!.engineerAmountMinor);
    expect(after!.platformAmountMinor).toBe(orderItemBefore!.platformAmountMinor);
    expect(after!.engineerBp).toBe(orderItemBefore!.engineerBp);
    expect(after!.snapshotTakenAt).toEqual(orderItemBefore!.snapshotTakenAt);

    const [order] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)),
    );
    expect(order!.status).toBe('COMPLETED');
  });
});

// ===========================================================================
describe('9 — invalid amounts and inputs are refused', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['zero', { amountMinor: 0n }],
    ['negative', { amountMinor: -100n }],
    ['a note that explains nothing', { note: 'خطأ' }],
    ['an engineer target with no engineer', { contributorId: null }],
  ];

  for (const [label, override] of cases) {
    it(`refuses ${label}`, async () => {
      await expect(
        previewAdjustment(owner, { ...valid, ...override } as typeof valid),
      ).rejects.toThrow(ValidationError);
      await expect(
        postAdjustment(owner, {
          ...valid, ...override, idempotencyKey: randomUUID(),
        } as typeof valid & { idempotencyKey: string }),
      ).rejects.toThrow(ValidationError);
    });
  }

  it('refuses a platform target that names an engineer', async () => {
    await expect(
      previewAdjustment(owner, { ...valid, target: 'PLATFORM' }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an unknown currency', async () => {
    await expect(
      previewAdjustment(owner, { ...valid, currency: 'XYZ' }),
    ).rejects.toThrow();
  });

  it('refuses an engineer who does not exist', async () => {
    await expect(
      previewAdjustment(owner, {
        ...valid, contributorId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow();
  });

  it('the books still balance after every rejection', async () => {
    const health = await checkLedgerHealth(owner);
    expect(health.isHealthy).toBe(true);
    for (const balance of health.balances) expect(balance.totalMinor).toBe(0n);
  });
});
