import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, entitlements,
  orders, paymentMethods, payments, productContributors,
  productPrices, products, settlementLines, settlements, users,
} from '@/db/schema';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { generateSettlements } from './generate';
import { approveSettlement, cancelSettlement, markSettlementPaid } from './lifecycle';
import { contributorStatement } from '@/finance/balances';
import { statementDocument } from './queries';
import { renderStatementPdf } from './statement-pdf';
import { checkLedgerHealth } from '@/ledger/verify';
import { RuleViolationError } from '@/lib/errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * PHASE P7 EXIT CRITERION
 * ===========================================================================
 * "Three simulated months settle correctly, including a refund that arrives
 *  after its own month has been settled."
 *
 * The three months are chosen so that each exercises one rule the owner wrote:
 *
 *   JULY      — earns 48.00, below the 50.00 threshold. Decisions §8: the
 *               balance rolls forward AND appears on the statement. Nothing
 *               is paid, and the statement still exists.
 *   AUGUST    — earns 32.00 more. The balance is now 80.00, which includes
 *               July's carry-forward, so the payment is for both months.
 *               Approved and paid.
 *   SEPTEMBER — earns 16.00, and the owner posts a 32.00 ADJUSTMENT against
 *               an engineer who was already paid for August. The balance goes
 *               NEGATIVE, nothing is paid, and the debt rolls into October.
 *
 *               This used to be a refund. The owner has since removed refunds
 *               from the platform entirely, so the scenario is reproduced with
 *               the mechanism that remains — an owner correction. The property
 *               under test is unchanged and still matters: a debit landing
 *               after its month was settled must not reopen that month, and
 *               must not be rounded away.
 *
 * Time is simulated by faking `Date` only. Every timestamp that decides an
 * accounting month — the order's paid_at and the ledger entry's occurred_at —
 * is produced in application code, and PostgreSQL derives the month from the
 * timestamp it is given. Timers are left real so the driver keeps working.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: randomUUID(), customer: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(),
  discipline: randomUUID(), method: randomUUID(),
  products: [randomUUID(), randomUUID(), randomUUID(), randomUUID(),
             randomUUID(), randomUUID()],
};
const slugs = ids.products.map((_, index) => `p7-prod-${index}-${suffix}`);

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

const PRICE = 2000n;            // $20.00
const ENGINEER_SHARE = 1600n;   // 80%
/*
 * This suite SETS the threshold it tests rather than reading whatever the
 * database happens to be seeded with. The owner has since removed the minimum
 * (it is zero in `settings`), but "below the threshold rolls forward" remains
 * a supported behaviour they can switch back on — and a test of that behaviour
 * must not depend on a value someone else is free to change.
 *
 * Integration files run in sequence (`fileParallelism: false`), so changing a
 * global setting here cannot race another file. It is restored in afterAll.
 */
const MINIMUM = 5000n;          // $50.00, set by this suite for its own run

/** Buy one product and have the owner approve it, at the current fake time. */
async function sell(productIndex: number): Promise<string> {
  const order = await createOrder(customer, { productSlugs: [slugs[productIndex]!] });
  await placeOrder(customer, { orderId: order.orderId, paymentMethodId: ids.method });
  const [payment] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)),
  );
  await approvePayment(owner, { paymentId: payment!.id });
  return order.orderId;
}

/**
 * An owner correction against the engineer's balance.
 *
 * Posted through the trusted path as the owner, which is exactly how a
 * correction reaches the books today — there is no screen for it yet.
 */
async function adjust(amountMinor: bigint, memo: string): Promise<void> {
  await withRawActorContext(OWNER_RAW, (tx) =>
    tx.execute(sql`
      SELECT app_post_ledger_transaction(
        'ADJUSTMENT', 'USD', ${new Date().toISOString()}::timestamptz,
        'correction', NULL, ${memo},
        ${JSON.stringify([
          { account: 'ENGINEER_PAYABLE', contributorId: ids.contributor,
            amountMinor: amountMinor.toString() },
          { account: 'PLATFORM_REVENUE', amountMinor: (-amountMinor).toString() },
        ])}::jsonb)
    `),
  );
}

async function balanceOf(): Promise<bigint> {
  const statement = await contributorStatement(engineer);
  return statement.balances.find((b) => b.currency === 'USD')?.balanceMinor ?? 0n;
}

async function settlementRow(periodKey: string) {
  const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
    tx.select().from(settlements).where(sql`${settlements.contributorId} = ${ids.contributor}
      AND ${settlements.periodKey} = ${periodKey}`),
  );
  return row;
}

let seededMinimum: unknown = null;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });

  await withRawActorContext(OWNER_RAW, async (tx) => {
    const [current] = (await tx.execute(sql`
      SELECT value FROM settings WHERE key = 'settlement.minimumPayoutMinor'
    `)) as unknown as Array<{ value: unknown }>;
    seededMinimum = current?.value ?? null;

    await tx.execute(sql`
      UPDATE settings SET value = ${String(MINIMUM)}::jsonb
       WHERE key = 'settlement.minimumPayoutMinor'
    `);

    await tx.insert(users).values([
      { id: ids.owner, email: `p7-owner+${suffix}@test.local`, passwordHash: 'x', role: 'OWNER', status: 'ACTIVE', displayName: 'Owner' },
      { id: ids.customer, email: `p7-cust+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer', countryCode: 'SY' },
      { id: ids.engineerUser, email: `p7-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `p7-eng-${suffix}`,
      settlementCode: 'CIVIL', displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `p7-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 93,
    });
    await tx.insert(products).values(
      ids.products.map((id, index) => ({
        id, slug: slugs[index]!, titleAr: `مخطط ${index + 1}`, disciplineId: ids.discipline,
        fileType: 'PDF' as const, status: 'PUBLISHED' as const, currency: 'USD',
        publishedAt: new Date(),
      })),
    );
    await tx.insert(productContributors).values(
      ids.products.map((id) => ({ productId: id, contributorId: ids.contributor, shareBp: 10000 })),
    );
    await tx.insert(productPrices).values(
      ids.products.map((id) => ({ productId: id, amountMinor: PRICE, currency: 'USD' })),
    );
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE',
      engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `p7-bank-${suffix}`, type: 'MANUAL',
      displayNameAr: 'تحويل بنكي', instructionsAr: 'حوّل', requiresProof: false,
      countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();

  await withRawActorContext(OWNER_RAW, async (tx) => {
    // Restore whatever the database had before this suite ran.
    if (seededMinimum !== null) {
      await tx.execute(sql`
        UPDATE settings SET value = ${JSON.stringify(seededMinimum)}::jsonb
         WHERE key = 'settlement.minimumPayoutMinor'
      `);
    }

    // Ledger rows stay: they are append-only, which is the behaviour under test.
    await tx.execute(sql`DELETE FROM settlement_lines WHERE settlement_id IN
      (SELECT id FROM settlements WHERE contributor_id = ${ids.contributor})`);
    await tx.delete(settlements).where(eq(settlements.contributorId, ids.contributor));

    await tx.delete(entitlements).where(eq(entitlements.customerId, ids.customer));
    await tx.delete(orders).where(eq(orders.customerId, ids.customer));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements)
      .where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.execute(sql`DELETE FROM product_contributors WHERE contributor_id = ${ids.contributor}`);
    await tx.execute(sql`DELETE FROM products WHERE discipline_id = ${ids.discipline}`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(
      sql`id IN (${ids.owner}, ${ids.customer}, ${ids.engineerUser})`,
    );
  });
  await closeDb();
}, 60_000);

// ===========================================================================
describe('JULY — below the threshold, the balance rolls forward (decisions §8)', () => {
  const augustOrders: string[] = [];

  it('three sales earn 48.00, which is under the 50.00 minimum', async () => {
    vi.setSystemTime(new Date('2026-07-10T09:00:00Z'));
    await sell(0);
    await sell(1);
    await sell(2);

    expect(await balanceOf()).toBe(3n * ENGINEER_SHARE); // 4800
    expect(3n * ENGINEER_SHARE).toBeLessThan(MINIMUM);
  });

  it('refuses to settle a month that has not closed yet', async () => {
    // Still inside July. Decisions §8: settlement begins on the first of the
    // following month, so a statement issued now could be contradicted by
    // sales the same month still makes.
    await expect(
      generateSettlements(owner, { periodKey: '2026-07', contributorId: ids.contributor }),
    ).rejects.toThrow(RuleViolationError);
  });

  it('issues a statement that pays nothing and says why', async () => {
    vi.setSystemTime(new Date('2026-08-01T06:00:00Z'));
    const run = await generateSettlements(owner, { periodKey: '2026-07', contributorId: ids.contributor });

    expect(run.generated).toHaveLength(1);
    const generated = run.generated[0]!;

    expect(generated.reference).toBe('JUL-2026-CIVIL');
    expect(generated.status).toBe('CARRIED_FORWARD');
    expect(generated.netDueMinor).toBe(0n);
    expect(generated.balanceMinor).toBe(4800n);

    const row = await settlementRow('2026-07');
    expect(row!.periodSalesMinor).toBe(4800n);
    expect(row!.periodUnitsSold).toBe(3);
    expect(row!.periodGrossSalesMinor).toBe(3n * PRICE);
    expect(row!.carriedForwardMinor).toBe(0n);
    // The threshold is FROZEN onto the statement, so changing the setting
    // later cannot rewrite the reason this month paid nothing.
    expect(row!.minimumPayoutMinor).toBe(MINIMUM);
  });

  it('the statement carries the three sales behind it (§18)', async () => {
    const row = await settlementRow('2026-07');
    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(settlementLines).where(eq(settlementLines.settlementId, row!.id)),
    );

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.kind === 'SALE')).toBe(true);
    expect(lines.reduce((total, line) => total + line.engineerMinor, 0n)).toBe(4800n);
  });

  it('a carried-forward statement can be neither approved nor paid', async () => {
    const row = await settlementRow('2026-07');
    await expect(
      approveSettlement(owner, { settlementId: row!.id }),
    ).rejects.toThrow(RuleViolationError);
    await expect(
      markSettlementPaid(owner, { settlementId: row!.id }),
    ).rejects.toThrow(RuleViolationError);
  });

  it('generating July again refuses rather than issuing a second statement', async () => {
    const run = await generateSettlements(owner, { periodKey: '2026-07', contributorId: ids.contributor });
    expect(run.generated).toHaveLength(0);
    expect(run.skipped).toHaveLength(1);
  });

  // Shared with the August block.
  it('records August sales for the next month', async () => {
    vi.setSystemTime(new Date('2026-08-12T09:00:00Z'));
    augustOrders.push(await sell(3));
    augustOrders.push(await sell(4));

    expect(await balanceOf()).toBe(5n * ENGINEER_SHARE); // 8000
  });

  it('exposes the August orders to the next describe block', () => {
    expect(augustOrders).toHaveLength(2);
    Object.assign(globalThis, { __p7AugustOrders: augustOrders });
  });
});

// ===========================================================================
describe('AUGUST — the balance clears the threshold and is paid', () => {
  it('the statement pays July and August together', async () => {
    vi.setSystemTime(new Date('2026-09-01T06:00:00Z'));
    const run = await generateSettlements(owner, { periodKey: '2026-08', contributorId: ids.contributor });

    expect(run.generated).toHaveLength(1);
    const generated = run.generated[0]!;

    expect(generated.reference).toBe('AUG-2026-CIVIL');
    expect(generated.status).toBe('PENDING');
    // 3200 earned in August, 4800 carried in from July.
    expect(generated.netDueMinor).toBe(8000n);

    const row = await settlementRow('2026-08');
    expect(row!.periodSalesMinor).toBe(3200n);
    expect(row!.carriedForwardMinor).toBe(4800n);
    expect(row!.balanceMinor).toBe(8000n);
  });

  it('the owner approves, then records the transfer', async () => {
    const row = await settlementRow('2026-08');

    const approved = await approveSettlement(owner, {
      settlementId: row!.id, note: 'مراجعة شهر آب',
    });
    expect(approved.netDueMinor).toBe(8000n);

    const paid = await markSettlementPaid(owner, {
      settlementId: row!.id,
      payoutMethod: 'تحويل بنكي',
      payoutReference: 'TRX-AUG-001',
    });
    expect(paid.amountMinor).toBe(8000n);
    expect(paid.ledgerTransactionId).toBeTruthy();
  });

  it('the payout is in the ledger and clears the balance', async () => {
    const row = await settlementRow('2026-08');
    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.execute(sql`
        SELECT l.account_code, l.amount_minor::text AS amount, l.kind::text AS kind
          FROM ledger_lines l
         WHERE l.transaction_id = ${row!.ledgerTransactionId}
         ORDER BY l.line_no
      `),
    ) as unknown as Array<Record<string, string>>;

    expect(lines.map((l) => [l.account_code, l.amount])).toEqual([
      ['ENGINEER_PAYABLE', '8000'],
      ['PLATFORM_CASH', '-8000'],
    ]);
    expect(await balanceOf()).toBe(0n);
  });

  it('the books still balance', async () => {
    const health = await checkLedgerHealth(owner);
    for (const balance of health.balances) expect(balance.totalMinor).toBe(0n);
  });

  it('a paid settlement cannot be edited, even by the owner', async () => {
    const row = await settlementRow('2026-08');
    await expect(
      withRawActorContext(OWNER_RAW, (tx) =>
        tx.update(settlements).set({ netDueMinor: 1n }).where(eq(settlements.id, row!.id)),
      ),
    ).rejects.toThrow();
  });

  it('a paid settlement cannot be cancelled', async () => {
    const row = await settlementRow('2026-08');
    await expect(
      cancelSettlement(owner, { settlementId: row!.id, reason: 'تجربة' }),
    ).rejects.toThrow(RuleViolationError);
  });
});

// ===========================================================================
describe('SEPTEMBER — a debit lands after its month was settled', () => {
  it('one sale, then an owner correction against a paid month', async () => {
    vi.setSystemTime(new Date('2026-09-14T09:00:00Z'));
    await sell(5);
    expect(await balanceOf()).toBe(1600n);

    await adjust(3200n, 'تصحيح: خصم عن شهر آب');

    // Earned 1600 this month, 3200 taken back for a month already paid.
    expect(await balanceOf()).toBe(-1600n);
  });

  it('the statement reports a negative balance and pays nothing', async () => {
    vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
    const run = await generateSettlements(owner, { periodKey: '2026-09', contributorId: ids.contributor });

    expect(run.generated).toHaveLength(1);
    const generated = run.generated[0]!;

    expect(generated.status).toBe('CARRIED_FORWARD');
    expect(generated.netDueMinor).toBe(0n);
    // THE EXIT CRITERION: the debt is stated, not rounded away.
    expect(generated.balanceMinor).toBe(-1600n);

    const row = await settlementRow('2026-09');
    expect(row!.periodSalesMinor).toBe(1600n);
    expect(row!.periodAdjustmentsMinor).toBe(-3200n);
    // August's settlement paid everything owed, so nothing carried IN.
    expect(row!.carriedForwardMinor).toBe(0n);
  });

  it('the statement shows the sale, and the detail adds up', async () => {
    const row = await settlementRow('2026-09');
    const lines = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(settlementLines)
        .where(eq(settlementLines.settlementId, row!.id)),
    );

    expect(lines.filter((line) => line.kind === 'SALE')).toHaveLength(1);
    // No refund lines can exist any more: the platform issues none.
    expect(lines.filter((line) => line.kind === 'REFUND')).toHaveLength(0);
    // The sale detail matches the period's SALES, and the adjustment is
    // reported separately rather than as a statement line.
    expect(lines.reduce((total, line) => total + line.engineerMinor, 0n)).toBe(1600n);
  });

  it('AUGUST\'s paid statement is untouched by the later correction', async () => {
    // §48: a settled month is settled. The reversal lands in the open month.
    const august = await settlementRow('2026-08');
    expect(august!.status).toBe('PAID');
    expect(august!.netDueMinor).toBe(8000n);
    expect(august!.periodSalesMinor).toBe(3200n);
    expect(august!.periodAdjustmentsMinor).toBe(0n);
  });

  it('the debt rolls into October rather than disappearing', async () => {
    vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
    await sell(0); // the customer buys again; a second entitlement is granted
    expect(await balanceOf()).toBe(0n); // −1600 + 1600

    vi.setSystemTime(new Date('2026-11-01T06:00:00Z'));
    const run = await generateSettlements(owner, { periodKey: '2026-10', contributorId: ids.contributor });
    const october = run.generated[0]!;

    // The October statement carried in the September debt and netted it off.
    const row = await settlementRow('2026-10');
    expect(row!.carriedForwardMinor).toBe(-1600n);
    expect(row!.periodSalesMinor).toBe(1600n);
    expect(october.balanceMinor).toBe(0n);
  });

  it('the ledger balances through all of it', async () => {
    const health = await checkLedgerHealth(owner);
    expect(health.isHealthy).toBe(true);
    for (const balance of health.balances) expect(balance.totalMinor).toBe(0n);
  });
});

// ===========================================================================
describe('back-settling a month that was skipped', () => {
  /*
   * The bug this covers, found by reading the dev database rather than by a
   * failing test: the payout total used to have no cutoff at all, so settling
   * an OLD month after newer ones had been paid subtracted payments that had
   * nothing to do with it and reported a large false debt.
   *
   * June 2026 is before every sale in this file, so its true balance is zero —
   * and by then August's 80.00 has been paid. The unfixed code reported
   * −8000; the fixed code reports nothing owed and issues no statement.
   */
  it('a period earlier than an already-paid one is not charged for it', async () => {
    vi.setSystemTime(new Date('2026-12-01T06:00:00Z'));

    const run = await generateSettlements(owner, {
      periodKey: '2026-06', contributorId: ids.contributor,
    });

    // Nothing was earned in June and nothing was owed at its close, so there
    // is no statement to issue — rather than one claiming an 80.00 debt.
    expect(run.generated).toHaveLength(0);
    expect(run.skipped[0]?.reason).toBe('لا حركة ولا رصيد');
  });

  it('still counts a payout made FOR the period being settled', async () => {
    // August was paid in September. Regenerating August must see that payment
    // and produce nothing further — the idempotence the run depends on.
    vi.setSystemTime(new Date('2026-12-01T06:00:00Z'));
    const run = await generateSettlements(owner, {
      periodKey: '2026-08', contributorId: ids.contributor,
    });
    expect(run.generated).toHaveLength(0);
    expect(run.skipped).toHaveLength(1);
  });
});

// ===========================================================================
describe('the monthly statement as a PDF (owner decision)', () => {
  it('renders a real PDF from the frozen statement', async () => {
    const row = await settlementRow('2026-08');
    const document = await statementDocument(engineer, row!.id);
    expect(document).not.toBeNull();

    const pdf = await renderStatementPdf({
      settlement: document!.settlement,
      lines: document!.lines,
      contributorName: document!.contributorName,
      platformName: 'Engineernia',
    });

    // A real PDF, not an empty buffer or an error page.
    expect(pdf.byteLength).toBeGreaterThan(5_000);
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');

    // It is a single page, and mupdf can open what we produced.
    const mupdf = await import('mupdf');
    const opened = mupdf.Document.openDocument(Buffer.from(pdf), 'application/pdf');
    expect(opened.countPages()).toBe(1);
  });

  it('the document resolves for the engineer it belongs to', async () => {
    const row = await settlementRow('2026-08');
    const document = await statementDocument(engineer, row!.id);

    expect(document!.settlement.reference).toBe('AUG-2026-CIVIL');
    expect(document!.settlement.netDueMinor).toBe(8000n);
    expect(document!.lines.length).toBeGreaterThan(0);
  });

  it('and not for a customer, who gets the same answer as for a missing one',
    async () => {
      const row = await settlementRow('2026-08');

      // Row-level security decides. The route turns null into 404, so a
      // customer asking for a real settlement and one asking for a uuid that
      // never existed cannot tell the two cases apart.
      expect(await statementDocument(customer, row!.id)).toBeNull();
      expect(
        await statementDocument(customer, '00000000-0000-4000-8000-000000000000'),
      ).toBeNull();
    });
});

// ===========================================================================
describe('who may read a statement (§12, §49)', () => {
  it('the engineer reads their own settlements', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.engineerUser, actorRole: 'CONTRIBUTOR', contributorId: ids.contributor },
      // No WHERE clause: row-level security is what scopes this.
      (tx) => tx.execute(sql`SELECT contributor_id, reference FROM settlements`),
    ) as unknown as Array<Record<string, string>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.contributor_id === ids.contributor)).toBe(true);
  });

  it('a customer reads none', async () => {
    const rows = await withRawActorContext(
      { actorId: ids.customer, actorRole: 'CUSTOMER' },
      (tx) => tx.execute(sql`SELECT * FROM settlements`),
    ) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('an unscoped run issues statements for everyone owed, gaps included', async () => {
    /*
     * The regression this covers: generation used to REFUSE a statement whose
     * sale records could not be itemised — which permanently blocked payment
     * for money the ledger says is owed. Earlier test runs leave exactly that
     * shape behind (append-only ledger rows, deleted orders), so an unscoped
     * run over the whole database is the honest way to exercise it.
     */
    vi.setSystemTime(new Date('2026-12-01T06:00:00Z'));
    const run = await generateSettlements(owner, { periodKey: '2026-11' });

    // It completed rather than throwing, which is the point.
    expect(Array.isArray(run.generated)).toBe(true);

    for (const generated of run.generated) {
      const lines = await withRawActorContext(OWNER_RAW, (tx) =>
        tx.select().from(settlementLines)
          .where(eq(settlementLines.settlementId, generated.settlementId)),
      );
      const detailSum = lines.reduce((total, line) => total + line.engineerMinor, 0n);
      const [row] = await withRawActorContext(OWNER_RAW, (tx) =>
        tx.select().from(settlements).where(eq(settlements.id, generated.settlementId)),
      );
      // Every statement adds up to its own total, balancing line included.
      const movement = row!.periodSalesMinor - row!.periodRefundsMinor;
      expect(detailSum, `statement ${generated.reference} does not add up`).toBe(movement);
    }

    // Clean up the statements this unscoped run created for other contributors.
    await withRawActorContext(OWNER_RAW, async (tx) => {
      await tx.execute(sql`DELETE FROM settlement_lines WHERE settlement_id IN
        (SELECT id FROM settlements WHERE period_key = '2026-11')`);
      await tx.execute(sql`DELETE FROM settlements WHERE period_key = '2026-11'`);
    });
  });

  it('a contributor cannot generate, approve or pay a settlement', async () => {
    await expect(
      generateSettlements(engineer, { periodKey: '2026-07', contributorId: ids.contributor }),
    ).rejects.toThrow(RuleViolationError);

    const row = await settlementRow('2026-07');
    await expect(
      approveSettlement(engineer, { settlementId: row!.id }),
    ).rejects.toThrow(RuleViolationError);
    await expect(
      markSettlementPaid(engineer, { settlementId: row!.id }),
    ).rejects.toThrow(RuleViolationError);
  });
});
