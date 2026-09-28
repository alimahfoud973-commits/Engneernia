import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor } from '@/db/actor-context';
import { requireDate } from '@/db';
import { isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import type { CommissionModel } from '@/lib/money/commission';

/**
 * ===========================================================================
 * THE OWNER'S SALES AND COMMISSION HISTORY (Stage 5, S5-09)
 * ===========================================================================
 * One row per engineer per sale, read from what was FROZEN when the payment
 * was approved: the line's price, discount, tax and net on `order_items`, and
 * each engineer's credit, slice, terms and pay on `order_item_contributors`.
 *
 * NOTHING HERE IS RECOMPUTED. Not from today's price, not from today's
 * agreement, not from today's credits — owner decision D-04 is that the terms
 * at approval are the terms of the sale, and a history screen that re-derived
 * them would show the owner a sale that did not happen. The one derived
 * figure is the effective rate of a FIXED agreement (its pay over its slice),
 * which is display arithmetic on two frozen numbers.
 *
 * Owner-only, three times over: this function refuses, the page calls
 * `requireOwner`, and `orders` / `order_items` resolve no row for anyone else.
 *
 * Read and review. It changes nothing and offers nothing to change.
 * ===========================================================================
 */

export interface SaleHistoryRow {
  readonly rowId: string;
  readonly orderItemId: string;
  readonly orderNumber: string;
  /** When the payment was approved and the terms were frozen. */
  readonly soldAt: Date;
  readonly periodKey: string;
  readonly productTitle: string;
  readonly versionNo: number | null;
  readonly isUpgrade: boolean;
  readonly currency: string;
  /** The line as the customer was charged for it. */
  readonly listPriceMinor: bigint;
  readonly discountMinor: bigint;
  readonly paidMinor: bigint;
  readonly taxMinor: bigint | null;
  readonly netMinor: bigint | null;
  /** This engineer, as credited at the moment of sale. */
  readonly contributorId: string;
  readonly contributorName: string | null;
  readonly shareBp: number;
  readonly authorCount: number;
  readonly sliceMinor: bigint | null;
  readonly engineerMinor: bigint;
  readonly platformMinor: bigint | null;
  /** The terms that governed this engineer's slice, as frozen. */
  readonly commissionModel: CommissionModel | null;
  readonly engineerBp: number | null;
  readonly engineerFixedMinor: bigint | null;
  readonly platformFixedMinor: bigint | null;
  readonly agreementId: string | null;
  /** S5-02: the fixed agreement asked for more than the sale could pay. */
  readonly clamped: boolean;
  readonly requestedMinor: bigint | null;
  readonly orderStatus: string;
  readonly paymentStatus: string | null;
  /** The engineer's statement for the sale's month, if one has been issued. */
  readonly settlementStatus: string | null;
  readonly settlementReference: string | null;
}

export interface SalesHistoryTotals {
  readonly currency: string;
  /** Distinct sale lines: a co-authored sale is ONE sale. */
  readonly sales: number;
  /** What customers paid, counted once per line however many authors. */
  readonly paidMinor: bigint;
  readonly taxMinor: bigint;
  readonly engineerMinor: bigint;
  readonly platformMinor: bigint;
  readonly clampedRows: number;
}

export interface SalesHistoryFilter {
  /** YYYY-MM, the accounting month (Asia/Damascus). */
  readonly periodKey?: string | null;
  readonly contributorId?: string | null;
  readonly cappedOnly?: boolean;
  readonly page?: number;
}

export const SALES_HISTORY_PAGE_SIZE = 50;

export async function salesHistory(
  actor: Actor,
  filter: SalesHistoryFilter = {},
): Promise<{
  rows: readonly SaleHistoryRow[];
  totals: readonly SalesHistoryTotals[];
  page: number;
  hasMore: boolean;
}> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('سجل المبيعات والعمولات من صلاحية مالك المنصة وحده');
  }

  const periodKey = filter.periodKey?.trim() || null;
  if (periodKey !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) {
    throw new ValidationError('الشهر يُكتب بالصيغة YYYY-MM');
  }
  const contributorId = filter.contributorId?.trim() || null;
  if (contributorId !== null && !isUuid(contributorId)) {
    throw new ValidationError('المهندس المختار غير صالح');
  }
  const page = Number.isInteger(filter.page) && filter.page! > 0 ? filter.page! : 1;
  const offset = (page - 1) * SALES_HISTORY_PAGE_SIZE;

  const where = sql`
        oi.snapshot_taken_at IS NOT NULL
    AND ${periodKey === null
      ? sql`true`
      : sql`to_char(timezone(app_accounting_timezone(), COALESCE(oic.occurred_at, o.paid_at)), 'YYYY-MM') = ${periodKey}`}
    AND ${contributorId === null ? sql`true` : sql`oic.contributor_id = ${contributorId}`}
    AND ${filter.cappedOnly ? sql`oic.commission_clamped` : sql`true`}
  `;

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT oic.id                                  AS row_id,
             oi.id                                   AS order_item_id,
             o.order_number,
             COALESCE(oic.occurred_at, o.paid_at)    AS sold_at,
             to_char(timezone(app_accounting_timezone(), COALESCE(oic.occurred_at, o.paid_at)), 'YYYY-MM')
                                                     AS period_key,
             COALESCE(oic.product_title, oi.title_snapshot) AS product_title,
             pv.version_no,
             oi.is_upgrade,
             oi.currency,
             oi.unit_price_minor, oi.discount_minor, oi.tax_minor, oi.net_minor,
             oic.contributor_id,
             c.display_name                          AS contributor_name,
             oic.share_bp,
             (SELECT COUNT(*)::int FROM order_item_contributors x
               WHERE x.order_item_id = oi.id)        AS author_count,
             oic.slice_minor, oic.amount_minor, oic.platform_amount_minor,
             oic.commission_model::text              AS commission_model,
             oic.engineer_bp, oic.engineer_fixed_minor, oic.platform_fixed_minor,
             oic.agreement_id,
             oic.commission_clamped, oic.commission_requested_minor,
             o.status::text                          AS order_status,
             (SELECT p.status::text FROM payments p
               WHERE p.order_id = o.id
               ORDER BY (p.status = 'APPROVED') DESC, p.created_at DESC
               LIMIT 1)                              AS payment_status,
             st.status                               AS settlement_status,
             st.reference                            AS settlement_reference
        FROM order_item_contributors oic
        JOIN order_items oi ON oi.id = oic.order_item_id
        JOIN orders o       ON o.id = oi.order_id
        LEFT JOIN product_versions pv ON pv.id = oi.version_id
        LEFT JOIN contributors c      ON c.id = oic.contributor_id
        LEFT JOIN LATERAL (
          SELECT s.status::text AS status, s.reference
            FROM settlements s
           WHERE s.contributor_id = oic.contributor_id
             AND s.currency = oi.currency
             AND s.period_key = to_char(timezone(app_accounting_timezone(),
                                        COALESCE(oic.occurred_at, o.paid_at)), 'YYYY-MM')
             AND s.status <> 'CANCELLED'
           ORDER BY s.generated_at DESC
           LIMIT 1
        ) st ON true
       WHERE ${where}
       ORDER BY COALESCE(oic.occurred_at, o.paid_at) DESC, oic.id DESC
       LIMIT ${SALES_HISTORY_PAGE_SIZE + 1} OFFSET ${offset}
    `)) as unknown as Array<Record<string, unknown>>;

    /*
     * Totals over the WHOLE filter, not the page. Paid and tax are summed per
     * LINE — a sale shared by two engineers was paid for once — and the pay
     * and cuts per engineer row, which add up to the lines' net by the
     * database rule of migration 0062.
     */
    const totals = (await tx.execute(sql`
      WITH picked AS (
        SELECT oic.*, oi.currency AS line_currency
          FROM order_item_contributors oic
          JOIN order_items oi ON oi.id = oic.order_item_id
          JOIN orders o       ON o.id = oi.order_id
         WHERE ${where}
      ),
      lines AS (
        SELECT DISTINCT oi.id, oi.currency,
               oi.unit_price_minor - oi.discount_minor AS paid,
               COALESCE(oi.tax_minor, 0)               AS tax
          FROM order_items oi
          JOIN picked ON picked.order_item_id = oi.id
      )
      SELECT l.currency,
             (SELECT COUNT(*) FROM lines x WHERE x.currency = l.currency)::int AS sales,
             (SELECT COALESCE(SUM(x.paid), 0) FROM lines x WHERE x.currency = l.currency) AS paid,
             (SELECT COALESCE(SUM(x.tax), 0) FROM lines x WHERE x.currency = l.currency)  AS tax,
             (SELECT COALESCE(SUM(p.amount_minor), 0) FROM picked p WHERE p.line_currency = l.currency) AS engineer,
             (SELECT COALESCE(SUM(p.platform_amount_minor), 0) FROM picked p WHERE p.line_currency = l.currency) AS platform,
             (SELECT COUNT(*) FROM picked p
               WHERE p.line_currency = l.currency AND p.commission_clamped)::int AS clamped_rows
        FROM (SELECT DISTINCT currency FROM lines) l
       ORDER BY l.currency
    `)) as unknown as Array<Record<string, unknown>>;

    const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string));

    return {
      page,
      hasMore: rows.length > SALES_HISTORY_PAGE_SIZE,
      rows: rows.slice(0, SALES_HISTORY_PAGE_SIZE).map((row) => ({
        rowId: row.row_id as string,
        orderItemId: row.order_item_id as string,
        orderNumber: row.order_number as string,
        soldAt: requireDate(row.sold_at as string, 'sold_at'),
        periodKey: row.period_key as string,
        productTitle: row.product_title as string,
        versionNo: row.version_no == null ? null : Number(row.version_no),
        isUpgrade: row.is_upgrade === true,
        currency: row.currency as string,
        listPriceMinor: big(row.unit_price_minor)!,
        discountMinor: big(row.discount_minor)!,
        paidMinor: big(row.unit_price_minor)! - big(row.discount_minor)!,
        taxMinor: big(row.tax_minor),
        netMinor: big(row.net_minor),
        contributorId: row.contributor_id as string,
        contributorName: (row.contributor_name as string | null) ?? null,
        shareBp: Number(row.share_bp),
        authorCount: Number(row.author_count),
        sliceMinor: big(row.slice_minor),
        engineerMinor: big(row.amount_minor)!,
        platformMinor: big(row.platform_amount_minor),
        commissionModel: (row.commission_model as CommissionModel | null) ?? null,
        engineerBp: row.engineer_bp == null ? null : Number(row.engineer_bp),
        engineerFixedMinor: big(row.engineer_fixed_minor),
        platformFixedMinor: big(row.platform_fixed_minor),
        agreementId: (row.agreement_id as string | null) ?? null,
        clamped: row.commission_clamped === true,
        requestedMinor: big(row.commission_requested_minor),
        orderStatus: row.order_status as string,
        paymentStatus: (row.payment_status as string | null) ?? null,
        settlementStatus: (row.settlement_status as string | null) ?? null,
        settlementReference: (row.settlement_reference as string | null) ?? null,
      })),
      totals: totals.map((row) => ({
        currency: row.currency as string,
        sales: Number(row.sales),
        paidMinor: BigInt(row.paid as string),
        taxMinor: BigInt(row.tax as string),
        engineerMinor: BigInt(row.engineer as string),
        platformMinor: BigInt(row.platform as string),
        clampedRows: Number(row.clamped_rows),
      })),
    };
  });
}

/** Engineers to filter by — every one who has ever been credited on a sale. */
export async function salesHistoryEngineers(
  actor: Actor,
): Promise<ReadonlyArray<{ id: string; name: string; isActive: boolean }>> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('سجل المبيعات والعمولات من صلاحية مالك المنصة وحده');
  }
  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT c.id, c.display_name, c.is_active
        FROM contributors c
       WHERE EXISTS (SELECT 1 FROM order_item_contributors oic WHERE oic.contributor_id = c.id)
       ORDER BY c.display_name, c.id
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      name: r.display_name as string,
      isActive: r.is_active === true,
    }));
  });
}
