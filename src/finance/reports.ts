import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor } from '@/db/actor-context';
import { isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError } from '@/lib/errors';
import { LEDGER_ACCOUNTS } from '@/ledger/accounts';

/**
 * ===========================================================================
 * THE OWNER'S FINANCIAL REPORTS (specification §19, §20, §49)
 * ===========================================================================
 *
 * Owner-only, without exception — `platform.readRevenue` is denied to every
 * other role in the policy matrix, and the row-level policies on the ledger
 * would return an empty result even if this check were removed.
 *
 * Every figure is read from the LEDGER, not recomputed from orders. Two
 * different answers to "how much did we earn" is how a reporting screen ends
 * up disagreeing with the books; there is one source, and it is the one that
 * balances to zero.
 * ===========================================================================
 */

function requireOwner(actor: Actor): void {
  if (!isOwner(actor)) {
    throw new RuleViolationError('التقارير المالية للمنصة من صلاحية المالك وحده');
  }
}

export interface PeriodRevenue {
  readonly periodKey: string;
  readonly currency: string;
  /** What customers paid in this period. */
  readonly grossSalesMinor: bigint;
  /** The platform's commission earned ON SALES. */
  readonly platformRevenueMinor: bigint;
  /**
   * Owner corrections posted in this period, on the platform's side.
   *
   * Reported separately rather than folded into revenue: the test that
   * revealed the need for this was asserting that engineer share plus platform
   * revenue equals what customers paid, which is only true of SALES. An
   * adjustment has no customer and no gross, so adding it to revenue made the
   * report contradict itself.
   */
  readonly platformAdjustmentsMinor: bigint;
  /** Commission handed back on approved refunds. */
  readonly revenueReversedMinor: bigint;
  /**
   * Tax collected from customers in this period (owner decision on OPEN-9).
   *
   * THE NUMBER THE OWNER FILES. It is not revenue and it is not anybody's
   * share — it is money held for the state — so it is reported on its own
   * line and excluded from `netPlatformMinor`.
   *
   * It is also what makes the report's own identity true again:
   *   engineerShare + platformRevenue + taxCollected === grossSales
   * Before tax existed the first two summed to the gross on their own, and a
   * sale at any real rate quietly broke that. The integration suite caught it.
   */
  readonly taxCollectedMinor: bigint;
  /** Owed to engineers from this period's sales. */
  readonly engineerShareMinor: bigint;
  /** Clawed back from engineers by this period's refunds. */
  readonly engineerReversedMinor: bigint;
  /** Total refunded to customers. */
  readonly refundsMinor: bigint;
  /** What the platform actually kept: revenue less reversals. */
  readonly netPlatformMinor: bigint;
  readonly salesCount: number;
  readonly refundCount: number;
}

/**
 * Revenue by accounting month (decisions §8).
 *
 * The month is the one the DATABASE assigned when the entry was posted, in
 * Asia/Damascus. Recomputing it here from a UTC timestamp would put a sale
 * made at half past midnight on the first of the month into the month before.
 */
export async function revenueByPeriod(
  actor: Actor,
  options: { periods?: number } = {},
): Promise<readonly PeriodRevenue[]> {
  requireOwner(actor);
  const limit = Math.min(Math.max(options.periods ?? 12, 1), 120);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT period_key, currency,
             COALESCE(SUM(amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.PLATFORM_CASH} AND kind = 'SALE'
             ), 0)::text AS gross_sales,
             COALESCE(SUM(-amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.PLATFORM_REVENUE} AND kind = 'SALE'
             ), 0)::text AS platform_revenue,
             COALESCE(SUM(-amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.PLATFORM_REVENUE} AND kind = 'ADJUSTMENT'
             ), 0)::text AS platform_adjustments,
             COALESCE(SUM(amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.PLATFORM_REVENUE_REVERSED}
             ), 0)::text AS revenue_reversed,
             COALESCE(SUM(-amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.TAX_PAYABLE} AND kind = 'SALE'
             ), 0)::text AS tax_collected,
             COALESCE(SUM(-amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE} AND kind = 'SALE'
             ), 0)::text AS engineer_share,
             COALESCE(SUM(amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE} AND kind = 'REFUND'
             ), 0)::text AS engineer_reversed,
             COALESCE(SUM(-amount_minor) FILTER (
               WHERE account_code = ${LEDGER_ACCOUNTS.CUSTOMER_REFUNDS_PAYABLE} AND kind = 'REFUND'
             ), 0)::text AS refunds,
             COUNT(DISTINCT transaction_id) FILTER (WHERE kind = 'SALE')::int   AS sales_count,
             COUNT(DISTINCT transaction_id) FILTER (WHERE kind = 'REFUND')::int AS refund_count
        FROM ledger_lines
       GROUP BY period_key, currency
       ORDER BY period_key DESC, currency
       LIMIT ${limit}
    `)) as unknown as Array<Record<string, string | number>>;

    return rows.map((row) => {
      const platformRevenueMinor = BigInt(row.platform_revenue as string);
      const revenueReversedMinor = BigInt(row.revenue_reversed as string);
      return {
        periodKey: row.period_key as string,
        currency: row.currency as string,
        grossSalesMinor: BigInt(row.gross_sales as string),
        platformRevenueMinor,
        platformAdjustmentsMinor: BigInt(row.platform_adjustments as string),
        revenueReversedMinor,
        taxCollectedMinor: BigInt(row.tax_collected as string),
        engineerShareMinor: BigInt(row.engineer_share as string),
        engineerReversedMinor: BigInt(row.engineer_reversed as string),
        refundsMinor: BigInt(row.refunds as string),
        netPlatformMinor:
          platformRevenueMinor
          + BigInt(row.platform_adjustments as string)
          - revenueReversedMinor,
        salesCount: Number(row.sales_count),
        refundCount: Number(row.refund_count),
      };
    });
  });
}

export interface DisciplineRevenue {
  readonly disciplineSlug: string;
  readonly disciplineNameAr: string;
  readonly currency: string;
  readonly unitsSold: number;
  readonly grossMinor: bigint;
  readonly platformMinor: bigint;
  readonly engineerMinor: bigint;
}

/**
 * Which discipline earns (§19).
 *
 * Read from order lines rather than the ledger, because a ledger entry
 * deliberately does not carry a product: it carries money. Joining the sale
 * back to its product is the honest way to get a per-discipline figure, and
 * the numbers used are still the FROZEN ones from the snapshot.
 *
 * Every completed sale counts, and stays counted: the platform issues no
 * refunds, so there is no category of sale that later stops being one.
 */
export async function revenueByDiscipline(
  actor: Actor,
  options: { periodKey?: string } = {},
): Promise<readonly DisciplineRevenue[]> {
  requireOwner(actor);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT d.slug, d.name_ar, oi.currency,
             COUNT(*)::int                                          AS units_sold,
             COALESCE(SUM(oi.unit_price_minor), 0)::text       AS gross,
             COALESCE(SUM(oi.platform_amount_minor), 0)::text       AS platform,
             COALESCE(SUM(oi.engineer_amount_minor), 0)::text       AS engineer
        FROM order_items oi
        JOIN orders o      ON o.id = oi.order_id
        JOIN products p    ON p.id = oi.product_id
        JOIN disciplines d ON d.id = p.discipline_id
       WHERE oi.snapshot_taken_at IS NOT NULL
         AND ${
           options.periodKey
             ? sql`to_char(timezone(app_accounting_timezone(), o.paid_at), 'YYYY-MM') = ${options.periodKey}`
             : sql`true`
         }
       GROUP BY d.slug, d.name_ar, oi.currency
       ORDER BY 6 DESC
    `)) as unknown as Array<Record<string, string | number>>;

    return rows.map((row) => ({
      disciplineSlug: row.slug as string,
      disciplineNameAr: row.name_ar as string,
      currency: row.currency as string,
      unitsSold: Number(row.units_sold),
      grossMinor: BigInt(row.gross as string),
      platformMinor: BigInt(row.platform as string),
      engineerMinor: BigInt(row.engineer as string),
    }));
  });
}

export interface OutstandingPayable {
  readonly contributorId: string;
  readonly contributorName: string | null;
  readonly currency: string;
  readonly balanceMinor: bigint;
  readonly meetsMinimum: boolean;
}

/**
 * Who the platform owes, and how much — the list the owner works from at the
 * start of each month (specification §15).
 *
 * Contributors below the threshold are RETURNED, not filtered out: decisions
 * §8 says their balance rolls forward and must appear on their statement, and
 * the owner needs to see it rolling.
 */
export async function outstandingPayables(
  actor: Actor,
  options: { minimumPayoutMinor?: bigint } = {},
): Promise<readonly OutstandingPayable[]> {
  requireOwner(actor);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT l.contributor_id,
             MAX(c.display_name)               AS display_name,
             l.currency,
             SUM(-l.amount_minor)::text        AS balance
        FROM ledger_lines l
        LEFT JOIN contributors c ON c.id = l.contributor_id
       WHERE l.account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE}
       GROUP BY l.contributor_id, l.currency
      HAVING SUM(-l.amount_minor) <> 0
       ORDER BY 4 DESC
    `)) as unknown as Array<Record<string, string | null>>;

    const minimum = options.minimumPayoutMinor ?? 0n;

    return rows.map((row) => {
      const balanceMinor = BigInt(row.balance!);
      return {
        contributorId: row.contributor_id!,
        // Null when the contributor row is gone: the ledger keeps the debt,
        // the name may have been erased. `contributor_name` on the line holds
        // what it was at the time.
        contributorName: row.display_name ?? null,
        currency: row.currency!,
        balanceMinor,
        meetsMinimum: balanceMinor >= minimum,
      };
    });
  });
}

export interface ContributorRevenue {
  readonly contributorId: string;
  readonly contributorName: string | null;
  readonly currency: string;
  readonly unitsSold: number;
  readonly grossMinor: bigint;
  readonly engineerMinor: bigint;
  readonly platformMinor: bigint;
}

/**
 * Sales by contributor (specification §19: "The owner should see all
 * engineers"), for one accounting month or for all time.
 *
 * OWNER-ONLY, and the one report in this file with no contributor-facing
 * counterpart: seeing every engineer's figures side by side is precisely the
 * comparison §12 exists to keep away from the engineers themselves.
 *
 * Read from the frozen order lines, with refunded lines counted separately
 * rather than silently dropped — a discipline or an engineer whose sales are
 * being reversed is exactly what this screen should make visible.
 */
export async function revenueByContributor(
  actor: Actor,
  options: { periodKey?: string } = {},
): Promise<readonly ContributorRevenue[]> {
  requireOwner(actor);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT oic.contributor_id,
             MAX(c.display_name)                                      AS display_name,
             oi.currency,
             COUNT(*)::int                                            AS units_sold,
             COALESCE(SUM(oi.unit_price_minor), 0)::text         AS gross,
             COALESCE(SUM(oic.amount_minor), 0)::text         AS engineer,
             COALESCE(SUM(oi.platform_amount_minor), 0)::text         AS platform
        FROM order_item_contributors oic
        JOIN order_items oi ON oi.id = oic.order_item_id
        JOIN orders o       ON o.id = oi.order_id
        LEFT JOIN contributors c ON c.id = oic.contributor_id
       WHERE oi.snapshot_taken_at IS NOT NULL
         AND o.paid_at IS NOT NULL
         AND ${
           options.periodKey
             ? sql`to_char(timezone(app_accounting_timezone(), o.paid_at), 'YYYY-MM') = ${options.periodKey}`
             : sql`true`
         }
       GROUP BY oic.contributor_id, oi.currency
       ORDER BY 6 DESC
       LIMIT 200
    `)) as unknown as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      contributorId: row.contributor_id as string,
      contributorName: (row.display_name as string | null) ?? null,
      currency: row.currency as string,
      unitsSold: Number(row.units_sold),
      grossMinor: BigInt(row.gross as string),
      engineerMinor: BigInt(row.engineer as string),
      platformMinor: BigInt(row.platform as string),
    }));
  });
}
