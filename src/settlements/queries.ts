import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor } from '@/db/actor-context';
import { activeContributorId, isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError } from '@/lib/errors';
import { requireDate, toDate } from '@/db';
import { periodKeyOf, previousPeriodKey, type PeriodKey } from '@/lib/time/period';

/**
 * Read models for the settlement screens.
 *
 * Both queries go through row-level security under the caller's own actor, so
 * the contributor version needs no `WHERE contributor_id = …` to be safe — it
 * has one anyway, because a query that depends solely on a policy for its
 * correctness is hard to read and easy to mis-copy.
 */

export interface SettlementSummary {
  readonly id: string;
  readonly reference: string;
  readonly periodKey: string;
  readonly status: string;
  readonly currency: string;
  readonly periodSalesMinor: bigint;
  readonly periodRefundsMinor: bigint;
  readonly periodUnitsSold: number;
  readonly periodGrossSalesMinor: bigint;
  /** The engineer's own share of that value. Null on statements issued
   *  before migration 0052, or covering a sale that predates 0050. */
  readonly periodSliceSalesMinor: bigint | null;
  readonly carriedForwardMinor: bigint;
  readonly balanceMinor: bigint;
  readonly netDueMinor: bigint;
  readonly minimumPayoutMinor: bigint;
  readonly generatedAt: Date;
  readonly approvedAt: Date | null;
  readonly paidAt: Date | null;
  readonly payoutReference: string | null;
  readonly note: string | null;
}

function mapSummary(row: Record<string, unknown>): SettlementSummary {
  return {
    id: row.id as string,
    reference: row.reference as string,
    periodKey: row.period_key as string,
    status: row.status as string,
    currency: row.currency as string,
    periodSalesMinor: BigInt(row.period_sales_minor as string),
    periodRefundsMinor: BigInt(row.period_refunds_minor as string),
    periodUnitsSold: Number(row.period_units_sold),
    periodGrossSalesMinor: BigInt(row.period_gross_sales_minor as string),
    periodSliceSalesMinor: row.period_slice_sales_minor == null
      ? null
      : BigInt(row.period_slice_sales_minor as string),
    carriedForwardMinor: BigInt(row.carried_forward_minor as string),
    balanceMinor: BigInt(row.balance_minor as string),
    netDueMinor: BigInt(row.net_due_minor as string),
    minimumPayoutMinor: BigInt(row.minimum_payout_minor as string),
    generatedAt: requireDate(row.generated_at as string, 'generated_at'),
    approvedAt: toDate(row.approved_at as string | null),
    paidAt: toDate(row.paid_at as string | null),
    payoutReference: (row.payout_reference as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  };
}

const SUMMARY_COLUMNS = sql`
  id, reference, period_key, status::text AS status, currency,
  period_sales_minor, period_refunds_minor, period_units_sold,
  period_gross_sales_minor, period_slice_sales_minor,
  carried_forward_minor, balance_minor,
  net_due_minor, minimum_payout_minor,
  generated_at, approved_at, paid_at, payout_reference, note
`;

/** The engineer's own monthly statements (§18). */
export async function myStatements(actor: Actor): Promise<readonly SettlementSummary[]> {
  const contributorId = activeContributorId(actor);
  if (contributorId === null) return [];

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${SUMMARY_COLUMNS} FROM settlements
       WHERE contributor_id = ${contributorId}
       ORDER BY period_key DESC
       LIMIT 36
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map(mapSummary);
  });
}

export interface StatementLine {
  readonly kind: string;
  readonly occurredAt: Date;
  readonly productTitle: string;
  readonly currency: string;
  readonly grossMinor: bigint;
  /** What this engineer's rate was applied to. Null before migration 0052,
   *  and on adjustment lines, which describe no sale. */
  readonly sliceMinor: bigint | null;
  readonly engineerMinor: bigint;
  readonly note: string | null;
}

/** The detail behind one statement. RLS decides whether it resolves at all. */
export async function statementLines(
  actor: Actor,
  settlementId: string,
): Promise<readonly StatementLine[]> {
  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT kind::text AS kind, occurred_at, product_title, currency,
             gross_minor, slice_minor, engineer_minor, note
        FROM settlement_lines
       WHERE settlement_id = ${settlementId}
       ORDER BY occurred_at, id
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      kind: row.kind as string,
      occurredAt: requireDate(row.occurred_at as string, 'occurred_at'),
      productTitle: row.product_title as string,
      currency: row.currency as string,
      grossMinor: BigInt(row.gross_minor as string),
      sliceMinor: row.slice_minor == null ? null : BigInt(row.slice_minor as string),
      engineerMinor: BigInt(row.engineer_minor as string),
      note: (row.note as string | null) ?? null,
    }));
  });
}

export interface OwnerSettlementRow extends SettlementSummary {
  readonly contributorId: string;
  readonly contributorName: string | null;
}

/** The owner's settlement run for one period (§15, §20). */
export async function settlementRun(
  actor: Actor,
  periodKey: PeriodKey,
): Promise<readonly OwnerSettlementRow[]> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('شاشة التسوية من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${SUMMARY_COLUMNS}, contributor_id, contributor_name
        FROM settlements
       WHERE period_key = ${periodKey}
       ORDER BY
         CASE status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,
         net_due_minor DESC
       LIMIT 500
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...mapSummary(row),
      contributorId: row.contributor_id as string,
      contributorName: (row.contributor_name as string | null) ?? null,
    }));
  });
}

/**
 * The period the owner is most likely to be settling: the one that just
 * closed. Computed in Asia/Damascus, so on the first of the month it is
 * already the previous month even while UTC still says otherwise.
 */
export function defaultSettlementPeriod(now: Date = new Date()): PeriodKey {
  return previousPeriodKey(periodKeyOf(now));
}

/**
 * One settlement with its lines, for the statement document.
 *
 * Returns null when the settlement does not resolve FOR THIS ACTOR — which
 * covers both "no such settlement" and "not yours", deliberately
 * indistinguishable (CLAUDE.md rule 5). Row-level security does the deciding;
 * this function never compares ids itself.
 */
export async function statementDocument(
  actor: Actor,
  settlementId: string,
): Promise<{
  settlement: SettlementSummary;
  lines: readonly StatementLine[];
  contributorName: string | null;
} | null> {
  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${SUMMARY_COLUMNS}, contributor_name
        FROM settlements WHERE id = ${settlementId}
    `)) as unknown as Array<Record<string, unknown>>;

    const row = rows[0];
    if (!row) return null;

    const lineRows = (await tx.execute(sql`
      SELECT kind::text AS kind, occurred_at, product_title, currency,
             gross_minor, slice_minor, engineer_minor, note
        FROM settlement_lines
       WHERE settlement_id = ${settlementId}
       ORDER BY occurred_at, id
    `)) as unknown as Array<Record<string, unknown>>;

    return {
      settlement: mapSummary(row),
      contributorName: (row.contributor_name as string | null) ?? null,
      lines: lineRows.map((line) => ({
        kind: line.kind as string,
        occurredAt: requireDate(line.occurred_at as string, 'occurred_at'),
        productTitle: line.product_title as string,
        currency: line.currency as string,
        grossMinor: BigInt(line.gross_minor as string),
        sliceMinor: line.slice_minor == null ? null : BigInt(line.slice_minor as string),
        engineerMinor: BigInt(line.engineer_minor as string),
        note: (line.note as string | null) ?? null,
      })),
    };
  });
}
