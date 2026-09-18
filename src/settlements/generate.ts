import 'server-only';
import { sql } from 'drizzle-orm';
import { settlementLines, settlements } from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { notifyUser } from '@/notifications/notify';
import { isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import { LEDGER_ACCOUNTS } from '@/ledger/accounts';
import { readFinancialPolicy } from '@/finance/policy';
import {
  isPeriodClosed, periodBounds, settlementReference, type PeriodKey,
} from '@/lib/time/period';
import { requireDate } from '@/db';

/**
 * ===========================================================================
 * GENERATING THE MONTHLY SETTLEMENT (specification §15, §16 — decisions §8, §9)
 * ===========================================================================
 *
 * The arithmetic that matters, and why it is not simply "this month's sales":
 *
 *   netDue = (everything earned up to the end of the period)
 *          − (everything refunded up to the end of the period)
 *          − (everything ALREADY PAID OUT, whenever it was paid)
 *
 * Three consequences fall out of that shape, each of which the specification
 * asks for separately and none of which needs its own special case:
 *
 *   A BALANCE UNDER THE THRESHOLD rolls forward (decisions §8). It was never
 *   paid, so it is still inside "earned − paid" next month.
 *
 *   A REFUND APPROVED AFTER ITS MONTH WAS SETTLED becomes a debt. The payout
 *   for that month is in "already paid", the refund is in "refunded", and the
 *   difference is negative — which is the truth, and the next settlement nets
 *   it off rather than paying on top of it.
 *
 *   GENERATING TWICE IS SAFE. A settlement that has been paid appears in
 *   "already paid", so regenerating produces zero rather than a second payment.
 *
 * THE TWO CUTOFFS ARE DIFFERENT, and it took a bug to see why.
 *
 * Earnings and refunds are cut off BY DATE: what was earned by the end of the
 * period. Payouts cannot be, because a payout for September happens in
 * October — excluding it by date would make September look unpaid forever.
 *
 * But "every payout ever" is wrong too. Settle July in December, after August
 * through November have been paid, and July's statement subtracts four months
 * of payments it has nothing to do with and reports a large false debt.
 *
 * So payouts are cut off BY THE PERIOD THEY SETTLED: money already paid on
 * account of this period or an earlier one. The link is the payout entry's
 * reference to its settlement, which carries the period it was for.
 * ===========================================================================
 */

export interface GeneratedSettlement {
  readonly settlementId: string;
  readonly reference: string;
  readonly contributorId: string;
  readonly contributorName: string | null;
  readonly currency: string;
  readonly netDueMinor: bigint;
  readonly balanceMinor: bigint;
  readonly status: 'PENDING' | 'CARRIED_FORWARD';
  readonly lineCount: number;
}

export interface GenerationResult {
  readonly periodKey: PeriodKey;
  readonly generated: readonly GeneratedSettlement[];
  readonly skipped: readonly { contributorId: string; reason: string }[];
  /**
   * Statements that needed a balancing line because their sale records could
   * not be itemised. The amounts are still correct — they come from the
   * ledger — but the owner should know which statements have a gap in them.
   */
  readonly unexplained: readonly {
    contributorId: string; reference: string; amountMinor: string;
  }[];
}

interface LedgerTotals {
  readonly contributorId: string;
  readonly contributorName: string | null;
  readonly currency: string;
  /** Earned up to the cutoff, refunds already netted off. */
  readonly earnedToDateMinor: bigint;
  readonly refundedToDateMinor: bigint;
  readonly adjustmentsToDateMinor: bigint;
  /** Paid out at any time, no cutoff — see the header. */
  readonly paidOutMinor: bigint;
  // --- this period alone, for the statement (decisions §9) ---
  readonly periodSalesMinor: bigint;
  readonly periodRefundsMinor: bigint;
  readonly periodAdjustmentsMinor: bigint;
}

/**
 * One query per contributor-currency pair, over the engineer payable account.
 *
 * `FILTER` rather than several round trips: the figures must all describe the
 * same instant, and three separate queries could straddle a concurrent sale.
 */
async function readLedgerTotals(
  tx: Transaction,
  periodKey: PeriodKey,
  cutoff: Date,
  contributorId?: string,
): Promise<readonly LedgerTotals[]> {
  const rows = (await tx.execute(sql`
    SELECT contributor_id,
           MAX(contributor_name)                                        AS contributor_name,
           currency,
           COALESCE(SUM(-amount_minor) FILTER (
             WHERE kind = 'SALE' AND occurred_at < ${cutoff.toISOString()}::timestamptz
           ), 0)::text AS earned_to_date,
           COALESCE(SUM(amount_minor) FILTER (
             WHERE kind = 'REFUND' AND occurred_at < ${cutoff.toISOString()}::timestamptz
           ), 0)::text AS refunded_to_date,
           COALESCE(SUM(-amount_minor) FILTER (
             WHERE kind = 'ADJUSTMENT' AND occurred_at < ${cutoff.toISOString()}::timestamptz
           ), 0)::text AS adjustments_to_date,
           -- Cut off by the period the payout SETTLED, not by its date: a
           -- payout for September happens in October, and a payout for
           -- November has nothing to do with settling July.
           COALESCE(SUM(amount_minor) FILTER (
             WHERE kind = 'SETTLEMENT_PAYOUT'
               AND COALESCE(
                     (SELECT s.period_key FROM settlements s
                       JOIN ledger_transactions t ON t.id = ledger_lines.transaction_id
                      WHERE s.id = t.reference_id AND t.reference_type = 'settlement'),
                     ${periodKey}
                   ) <= ${periodKey}
           ), 0)::text AS paid_out,
           COALESCE(SUM(-amount_minor) FILTER (
             WHERE kind = 'SALE' AND period_key = ${periodKey}
           ), 0)::text AS period_sales,
           COALESCE(SUM(amount_minor) FILTER (
             WHERE kind = 'REFUND' AND period_key = ${periodKey}
           ), 0)::text AS period_refunds,
           COALESCE(SUM(-amount_minor) FILTER (
             WHERE kind = 'ADJUSTMENT' AND period_key = ${periodKey}
           ), 0)::text AS period_adjustments
      FROM ledger_lines
     WHERE account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE}
       AND ${contributorId ? sql`contributor_id = ${contributorId}` : sql`true`}
     GROUP BY contributor_id, currency
     ORDER BY contributor_id, currency
  `)) as unknown as Array<Record<string, string | null>>;

  return rows.map((row) => ({
    contributorId: row.contributor_id!,
    contributorName: row.contributor_name ?? null,
    currency: row.currency!,
    earnedToDateMinor: BigInt(row.earned_to_date!),
    refundedToDateMinor: BigInt(row.refunded_to_date!),
    adjustmentsToDateMinor: BigInt(row.adjustments_to_date!),
    paidOutMinor: BigInt(row.paid_out!),
    periodSalesMinor: BigInt(row.period_sales!),
    periodRefundsMinor: BigInt(row.period_refunds!),
    periodAdjustmentsMinor: BigInt(row.period_adjustments!),
  }));
}

/** The sales and corrections behind the statement, for the engineer (§18). */
async function readStatementDetail(
  tx: Transaction,
  contributorId: string,
  periodKey: PeriodKey,
): Promise<{
  lines: Array<typeof settlementLines.$inferInsert>;
  grossSalesMinor: bigint;
  /**
   * The engineer's own share of the sales value — null the moment ONE sale in
   * the period predates migration 0050 and has no frozen slice. Null, not a
   * partial sum: a total that silently omits some of its months' sales is a
   * wrong number, and the statement's fallback wording is the honest answer.
   */
  sliceSalesMinor: bigint | null;
  unitsSold: number;
}> {
  /*
   * Sales come from the order lines — the ledger carries money, not products,
   * and the engineer's question is "which of my products sold". Refund lines
   * come from the refund records for the same reason.
   *
   * Both are attributed to the period the LEDGER assigned, so the detail and
   * the totals cannot disagree about which month something belongs to.
   */
  const rows = (await tx.execute(sql`
    SELECT 'SALE'::text AS kind, o.paid_at AS occurred_at, oi.title_snapshot AS title,
           oi.currency, oi.unit_price_minor::text AS gross,
           oic.slice_minor::text AS slice,
           oic.amount_minor::text AS engineer, NULL::text AS note
      FROM order_item_contributors oic
      JOIN order_items oi ON oi.id = oic.order_item_id
      JOIN orders o       ON o.id = oi.order_id
     WHERE oic.contributor_id = ${contributorId}
       AND o.paid_at IS NOT NULL
       AND to_char(timezone(app_accounting_timezone(), o.paid_at), 'YYYY-MM') = ${periodKey}

     UNION ALL

    /*
     * Owner corrections (OPEN-21). Read from the LEDGER LINE, not from the
     * financial_adjustments table — that table is owner-only, and a statement
     * is generated for the engineer. The line carries the reference and the
     * public reason in its memo, which is exactly what the engineer should
     * see: a balance that moves with no visible entry is the thing the
     * adjustment feature exists to avoid.
     */
    SELECT 'ADJUSTMENT'::text, l.occurred_at, 'تصحيح مالي',
           l.currency, '0'::text, NULL::text, (-l.amount_minor)::text, l.memo
      FROM ledger_lines l
     WHERE l.account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE}
       AND l.contributor_id = ${contributorId}
       AND l.kind = 'ADJUSTMENT'
       AND l.period_key = ${periodKey}

     ORDER BY 2
  `)) as unknown as Array<Record<string, string>>;

  const lines: Array<typeof settlementLines.$inferInsert> = [];
  let grossSalesMinor = 0n;
  let sliceSalesMinor: bigint | null = 0n;
  let unitsSold = 0;

  for (const row of rows) {
    const gross = BigInt(row.gross!);
    const isSale = row.kind === 'SALE';
    // Frozen since migration 0050; absent on older sales, and on the
    // adjustment lines, which describe no sale at all.
    const slice = isSale && row.slice != null ? BigInt(row.slice) : null;

    if (isSale) {
      grossSalesMinor += gross;
      unitsSold += 1;
      // One sale without a slice makes the PERIOD total unanswerable. It does
      // not make the line's own slice unanswerable, so the lines that have one
      // keep it — the detail stays as complete as the data allows while the
      // headline refuses to be a half-truth.
      sliceSalesMinor = slice === null || sliceSalesMinor === null
        ? null
        : sliceSalesMinor + slice;
    }

    lines.push({
      settlementId: '',
      // Sales and owner corrections. There are no refund lines: the platform
      // issues none.
      kind: isSale ? 'SALE' : 'ADJUSTMENT',
      occurredAt: requireDate(row.occurred_at!, 'occurred_at'),
      productTitle: row.title!,
      currency: row.currency!,
      grossMinor: gross,
      sliceMinor: slice,
      engineerMinor: BigInt(row.engineer!),
      note: row.note ?? null,
    });
  }

  return { lines, grossSalesMinor, sliceSalesMinor, unitsSold };
}

/**
 * Generate the settlements for a closed accounting month.
 *
 * Refuses an open period. Decisions §8 is explicit that the month closes at
 * the end of its last day in Asia/Damascus and settlement begins on the first
 * of the next — settling a month still in progress would issue a statement
 * that the month itself then contradicts.
 */
export async function generateSettlements(
  actor: Actor,
  input: { periodKey: PeriodKey; contributorId?: string; now?: Date },
): Promise<GenerationResult> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('توليد التسويات من صلاحية مالك المنصة وحده');
  }

  const now = input.now ?? new Date();
  const bounds = periodBounds(input.periodKey);

  if (!isPeriodClosed(input.periodKey, now)) {
    throw new RuleViolationError(
      'لا تُسوّى فترة لم تُغلق بعد — تبدأ التسوية في اليوم الأول من الشهر التالي',
      { periodKey: input.periodKey, closesAt: bounds.endUtcExclusive.toISOString() },
    );
  }

  return withActor(actor, async (tx) => {
    const policy = await readFinancialPolicy(tx);
    const totals = await readLedgerTotals(
      tx, input.periodKey, bounds.endUtcExclusive, input.contributorId,
    );

    const generated: GeneratedSettlement[] = [];
    const skipped: Array<{ contributorId: string; reason: string }> = [];
    /** Statements whose detail could not be fully rebuilt — reported to the owner. */
    const unexplained: Array<{ contributorId: string; reference: string; amountMinor: string }> = [];

    for (const row of totals) {
      const existing = await tx
        .select({ id: settlements.id, status: settlements.status })
        .from(settlements)
        .where(sql`${settlements.contributorId} = ${row.contributorId}
                   AND ${settlements.periodKey} = ${input.periodKey}
                   AND ${settlements.currency} = ${row.currency}`)
        .limit(1);

      if (existing.length > 0) {
        // Idempotent by refusal rather than by overwriting: a statement the
        // engineer has already read must not silently change under them.
        skipped.push({
          contributorId: row.contributorId,
          reason: `يوجد كشف لهذه الفترة بالحالة ${existing[0]!.status}`,
        });
        continue;
      }

      const balanceMinor =
        row.earnedToDateMinor
        + row.adjustmentsToDateMinor
        - row.refundedToDateMinor
        - row.paidOutMinor;

      const periodMovement =
        row.periodSalesMinor + row.periodAdjustmentsMinor - row.periodRefundsMinor;
      const carriedForwardMinor = balanceMinor - periodMovement;

      // Nothing at all happened and nothing is owed: no statement to issue.
      if (balanceMinor === 0n && periodMovement === 0n) {
        skipped.push({ contributorId: row.contributorId, reason: 'لا حركة ولا رصيد' });
        continue;
      }

      const meetsMinimum =
        balanceMinor > 0n && balanceMinor >= policy.settlement.minimumPayoutMinor;

      const netDueMinor = meetsMinimum ? balanceMinor : 0n;
      const status: 'PENDING' | 'CARRIED_FORWARD' = meetsMinimum
        ? 'PENDING'
        : 'CARRIED_FORWARD';

      const detail = await readStatementDetail(tx, row.contributorId, input.periodKey);

      /*
       * RECONCILING THE DETAIL AGAINST THE TOTALS.
       *
       * The totals come from the ledger; the detail comes from the order and
       * refund records. For an ordinary month they agree exactly. They can
       * legitimately disagree in one case: the ledger outlives what it
       * describes — an order the owner deleted leaves its earnings in the
       * books with no sale row left to itemise.
       *
       * Refusing to issue the statement was the first thing this code did, and
       * it was wrong: it would block a payment for money that is genuinely
       * owed, permanently, because a CONVENIENCE could not be rebuilt. The
       * ledger is the authority — that is the whole premise of P6 — so the
       * total stands and the gap is shown rather than hidden, as one labelled
       * line the engineer can see and ask about.
       */
      const detailSum = detail.lines.reduce((total, line) => total + line.engineerMinor, 0n);
      // The detail now itemises corrections as well as sales, so it is
      // compared against the whole period movement rather than sales alone.
      const expectedDetail = periodMovement;
      const unexplainedMinor = expectedDetail - detailSum;

      if (unexplainedMinor !== 0n) {
        detail.lines.push({
          settlementId: '',
          kind: 'ADJUSTMENT',
          occurredAt: bounds.endUtcExclusive,
          productTitle: 'تسوية فرق غير مفصّل',
          currency: row.currency,
          grossMinor: 0n,
          // A balancing line describes no product, so it has no slice.
          sliceMinor: null,
          engineerMinor: unexplainedMinor,
          note:
            'فرقٌ بين إجمالي الدفتر وتفاصيل المبيعات المتاحة. الدفتر هو المرجع؛ '
            + 'يحدث هذا عادةً حين تُحذف سجلات طلب بعد تسجيل أثره المالي.',
        });
      }

      // The adjustments the OWNER posted to the ledger are separate from the
      // balancing line above, and are reported on their own.
      const periodAdjustmentsMinor = row.periodAdjustmentsMinor;

      const code = await resolveSettlementCode(tx, row.contributorId);
      const reference = settlementReference(input.periodKey, code);

      const [created] = await tx
        .insert(settlements)
        .values({
          reference,
          contributorId: row.contributorId,
          contributorName: row.contributorName,
          settlementCode: code,
          periodKey: input.periodKey,
          periodStart: bounds.startUtc,
          periodEndExclusive: bounds.endUtcExclusive,
          currency: row.currency,
          status,
          periodSalesMinor: row.periodSalesMinor,
          periodRefundsMinor: row.periodRefundsMinor,
          periodAdjustmentsMinor,
          periodGrossSalesMinor: detail.grossSalesMinor,
          periodSliceSalesMinor: detail.sliceSalesMinor,
          periodUnitsSold: detail.unitsSold,
          carriedForwardMinor,
          netDueMinor,
          balanceMinor,
          // Frozen: changing the setting later cannot rewrite the reason an
          // old statement paid nothing (decisions §8).
          minimumPayoutMinor: policy.settlement.minimumPayoutMinor,
          generatedBy: actor.kind === 'USER' ? actor.userId : null,
        })
        .returning({ id: settlements.id });

      if (!created) {
        // RLS refuses a write by returning no rows, not by raising.
        throw new RuleViolationError('تعذّر إنشاء كشف التسوية', {
          contributorId: row.contributorId,
        });
      }

      if (detail.lines.length > 0) {
        await tx.insert(settlementLines).values(
          detail.lines.map((line) => ({ ...line, settlementId: created.id })),
        );
      }

      await notifyContributor(tx, row.contributorId, reference, input.periodKey);

      if (unexplainedMinor !== 0n) {
        unexplained.push({
          contributorId: row.contributorId,
          reference,
          amountMinor: unexplainedMinor.toString(),
        });
      }

      generated.push({
        settlementId: created.id,
        reference,
        contributorId: row.contributorId,
        contributorName: row.contributorName,
        currency: row.currency,
        netDueMinor,
        balanceMinor,
        status,
        lineCount: detail.lines.length,
      });
    }

    await recordAudit(tx, actor, {
      action: 'SETTLEMENT_GENERATED',
      entityType: 'settlement_run',
      entityId: input.periodKey,
      after: {
        periodKey: input.periodKey,
        generated: generated.length,
        skipped: skipped.length,
        payable: generated.filter((row) => row.netDueMinor > 0n).length,
        carriedForward: generated.filter((row) => row.status === 'CARRIED_FORWARD').length,
        // Not an error, but the owner should know: these statements carry a
        // balancing line because their sale records could not be itemised.
        unexplained,
      },
    });

    return { periodKey: input.periodKey, generated, skipped, unexplained };
  });
}

/**
 * The contributor's stable short code, used to build "SEP-2026-CIVIL" (§16).
 *
 * Read through a trusted path: the contributor row may be gone — the ledger
 * outlives it by design — and a settlement must still be issuable for money
 * that is still owed.
 */
async function resolveSettlementCode(tx: Transaction, contributorId: string): Promise<string> {
  const rows = (await tx.execute(sql`
    SELECT settlement_code FROM contributors WHERE id = ${contributorId}
  `)) as unknown as Array<{ settlement_code: string | null }>;

  const code = rows[0]?.settlement_code?.trim();
  if (code) return code;

  // Not a guess: a stable, unique fallback derived from the identifier, so a
  // settlement can still be referenced for a contributor whose profile was
  // removed. `settlementReference` would otherwise throw on an empty code.
  return `C${contributorId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

async function notifyContributor(
  tx: Transaction,
  contributorId: string,
  reference: string,
  periodKey: PeriodKey,
): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT user_id FROM contributors WHERE id = ${contributorId}
  `)) as unknown as Array<{ user_id: string | null }>;

  const userId = rows[0]?.user_id;
  // A contributor whose account is gone gets no notification, and the absence
  // is not an error: the statement still exists for the owner to act on.
  if (!userId) return;

  await notifyUser(tx, {
    userId,
    type: 'MONTHLY_STATEMENT_AVAILABLE',
    payload: { reference, periodKey },
  });
}

/** Validate a period key before it reaches a query. */
export function assertPeriodKey(value: string): PeriodKey {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new ValidationError('الفترة تُكتب بالصيغة YYYY-MM', { value });
  }
  return value;
}

export async function settlementFor(
  actor: Actor,
  contributorId: string,
  periodKey: PeriodKey,
): Promise<typeof settlements.$inferSelect | null> {
  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select()
      .from(settlements)
      .where(sql`${settlements.contributorId} = ${contributorId}
                 AND ${settlements.periodKey} = ${periodKey}`)
      .limit(1);
    return row ?? null;
  });
}
