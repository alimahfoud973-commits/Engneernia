import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor } from '@/db/actor-context';
import { isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError } from '@/lib/errors';
import { requireDate, toDate } from '@/db';
import { readFinancialPolicy } from '@/finance/policy';

/**
 * Read models for the refund screens.
 *
 * Two audiences, two shapes, one rule: neither query returns a domain entity.
 * The owner's row carries the buyer's note and the download count, because
 * the owner is deciding; the customer's row carries neither, because they
 * wrote the note and it is their own request.
 */

export interface OwnerRefundRow {
  readonly id: string;
  readonly reference: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly reason: string;
  readonly customerNote: string;
  readonly customerName: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly requestedAt: Date;
  readonly itemCount: number;
  /** Evidence, not a gate — see the seed comment in migration 0028. */
  readonly downloadsSoFar: number;
  readonly decisionNote: string | null;
  readonly paidAt: Date | null;
}

/** The owner's refund queue (specification §17, §38). */
export async function refundQueue(
  actor: Actor,
  options: { status?: string } = {},
): Promise<readonly OwnerRefundRow[]> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('طابور الاسترجاع من صلاحية مالك المنصة وحده');
  }

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id, r.reference, r.order_number, r.status::text AS status,
             r.reason::text AS reason, r.customer_note, r.currency, r.amount_minor,
             r.requested_at, r.decision_note, r.paid_at,
             u.display_name AS customer_name,
             (SELECT COUNT(*) FROM refund_request_items i
               WHERE i.refund_request_id = r.id)::int AS item_count,
             COALESCE((
               SELECT SUM(e.download_count)
                 FROM refund_request_items i
                 JOIN entitlements e ON e.order_item_id = i.order_item_id
                WHERE i.refund_request_id = r.id
             ), 0)::int AS downloads_so_far
        FROM refund_requests r
        LEFT JOIN users u ON u.id = r.customer_id
       WHERE ${options.status ? sql`r.status = ${options.status}::refund_status` : sql`true`}
       ORDER BY
         CASE r.status WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,
         r.requested_at DESC
       LIMIT 100
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      reference: row.reference as string,
      orderNumber: row.order_number as string,
      status: row.status as string,
      reason: row.reason as string,
      customerNote: row.customer_note as string,
      customerName: (row.customer_name as string | null) ?? null,
      currency: row.currency as string,
      amountMinor: BigInt(row.amount_minor as string),
      requestedAt: requireDate(row.requested_at as string, 'requested_at'),
      itemCount: Number(row.item_count),
      downloadsSoFar: Number(row.downloads_so_far),
      decisionNote: (row.decision_note as string | null) ?? null,
      paidAt: toDate(row.paid_at as string | null),
    }));
  });
}

export interface CustomerRefundRow {
  readonly id: string;
  readonly reference: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly reason: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly requestedAt: Date;
  readonly decisionNote: string | null;
}

/** A customer's own refund requests. RLS already scopes this to them. */
export async function myRefundRequests(actor: Actor): Promise<readonly CustomerRefundRow[]> {
  if (actor.kind !== 'USER') return [];

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id, reference, order_number, status::text AS status, reason::text AS reason,
             currency, amount_minor, requested_at, decision_note
        FROM refund_requests
       ORDER BY requested_at DESC
       LIMIT 50
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      reference: row.reference as string,
      orderNumber: row.order_number as string,
      status: row.status as string,
      reason: row.reason as string,
      currency: row.currency as string,
      amountMinor: BigInt(row.amount_minor as string),
      requestedAt: requireDate(row.requested_at as string, 'requested_at'),
      decisionNote: (row.decision_note as string | null) ?? null,
    }));
  });
}

export interface RefundableOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly paidAt: Date;
  readonly titles: readonly string[];
}

/**
 * Orders this customer could still ask to have refunded.
 *
 * The window is read from settings and applied HERE as well as in
 * `requestRefund`. Offering a button that the server will refuse is a worse
 * experience than not offering it — and the server still refuses, because an
 * absent button is not a control.
 */
export async function refundableOrders(actor: Actor): Promise<readonly RefundableOrder[]> {
  if (actor.kind !== 'USER') return [];

  return withActor(actor, async (tx) => {
    const policy = await readFinancialPolicy(tx);

    const rows = (await tx.execute(sql`
      SELECT o.id, o.order_number, o.currency, o.total_minor, o.paid_at,
             array_agg(oi.title_snapshot ORDER BY oi.created_at) AS titles
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status = 'COMPLETED'
         AND o.paid_at IS NOT NULL
         AND oi.refunded_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM refund_requests r
            WHERE r.order_id = o.id AND r.status IN ('REQUESTED', 'APPROVED', 'PAID')
         )
         AND ${
           policy.refunds.requestWindowDays === null
             ? sql`true`
             : sql`o.paid_at >= now() - make_interval(days => ${policy.refunds.requestWindowDays})`
         }
       GROUP BY o.id, o.order_number, o.currency, o.total_minor, o.paid_at
       ORDER BY o.paid_at DESC
       LIMIT 20
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      orderId: row.id as string,
      orderNumber: row.order_number as string,
      currency: row.currency as string,
      totalMinor: BigInt(row.total_minor as string),
      paidAt: requireDate(row.paid_at as string, 'paid_at'),
      titles: (row.titles as string[]) ?? [],
    }));
  });
}
