import { relations } from 'drizzle-orm';
import { bigint, index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, utcTimestamp } from './columns';
import { orderItems, orders } from './commerce';
import { users } from './identity';

/**
 * ===========================================================================
 * REFUNDS (specification §17 — decisions §7)
 * ===========================================================================
 *
 * The owner's decision, restated so the schema can be read against it:
 *
 *   "لا يوجد Refund تلقائي بعد منح الوصول إلى الملف الكامل" — there is no
 *   automatic refund once the full file has been handed over. A refund is a
 *   REQUEST that the owner reviews, for one of a small set of stated reasons.
 *
 * Consequences visible in this schema:
 *
 *   - The original sale is never deleted or edited. A refund is a separate
 *     record that POINTS AT it (§17), and the reversal in the ledger is a new
 *     transaction, not an amendment of the sale's.
 *
 *   - Refunds are per ORDER LINE, not per arbitrary amount. A line carries a
 *     frozen engineer/platform split; reversing the whole line reverses those
 *     exact numbers, so no second rounding can disagree with the first.
 *     Partial-amount refunds would require a rule for apportioning a fraction
 *     of a cent between the parties, which is the owner's decision to make —
 *     recorded as OPEN-16, not guessed at here.
 *
 *   - No time window is written into the schema or the code. Whether a
 *     request is still in time is read from the `refunds.requestWindowDays`
 *     setting at the moment of asking (decisions §7).
 * ===========================================================================
 */

/**
 * Why a refund was asked for. The list is the owner's, verbatim from
 * decisions §7 — including the escape hatch they wrote for themselves.
 */
export const refundReasonEnum = pgEnum('refund_reason', [
  'DUPLICATE_PAYMENT',
  'CORRUPT_FILE',
  'NOT_AS_DESCRIBED',
  'PLATFORM_ERROR',
  'OWNER_DISCRETION',
]);

/**
 * REQUESTED → APPROVED → PAID   (the money went back)
 *           ↘ REJECTED
 *           ↘ WITHDRAWN         (the customer changed their mind)
 *
 * APPROVED is the accounting moment: it posts the reversal, revokes access
 * and adjusts the engineer's balance. PAID only records that the transfer out
 * actually happened, which on a manual payment method is a separate human act
 * that can lag by days.
 */
export const refundStatusEnum = pgEnum('refund_status', [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PAID',
  'WITHDRAWN',
]);

export const refundRequests = pgTable(
  'refund_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human reference, e.g. "RF-000042", shown to the customer. */
    reference: text('reference').notNull(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** Denormalised so a support conversation does not need a second query. */
    orderNumber: text('order_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    status: refundStatusEnum('status').notNull().default('REQUESTED'),
    reason: refundReasonEnum('reason').notNull(),
    /** The customer's own words. Required: a reason code alone explains nothing. */
    customerNote: text('customer_note').notNull(),

    currency: text('currency').notNull(),
    /** The sum of the requested lines, frozen when the request is made. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),

    requestedAt: utcTimestamp('requested_at').notNull().defaultNow(),

    decidedBy: uuid('decided_by'),
    decidedAt: utcTimestamp('decided_at'),
    /** Why the owner said no, or the condition attached to a yes. */
    decisionNote: text('decision_note'),

    /** Set when APPROVED; the ledger transaction that reversed the sale. */
    reversalTransactionId: uuid('reversal_transaction_id'),
    paidAt: utcTimestamp('paid_at'),
    payoutReference: text('payout_reference'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('refund_requests_reference_unique').on(table.reference),
    index('refund_requests_order_idx').on(table.orderId),
    index('refund_requests_customer_idx').on(table.customerId, table.requestedAt),
    index('refund_requests_status_idx').on(table.status, table.requestedAt),
  ],
);

/**
 * Which lines of the order are being refunded, with the sale's own numbers
 * copied across at request time.
 *
 * The copy is not convenience. It is the record of WHAT WAS REVERSED: if the
 * order line were read again at approval time the answer would be the same
 * today, but the point of a financial record is that it still answers the
 * question in five years, after the line has been read through four schema
 * migrations.
 */
export const refundRequestItems = pgTable(
  'refund_request_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    refundRequestId: uuid('refund_request_id')
      .notNull()
      .references(() => refundRequests.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    productId: uuid('product_id').notNull(),
    titleSnapshot: text('title_snapshot').notNull(),

    currency: text('currency').notNull(),
    /** Exactly the amounts frozen on the sale — never recomputed. */
    grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
    engineerAmountMinor: bigint('engineer_amount_minor', { mode: 'bigint' }).notNull(),
    platformAmountMinor: bigint('platform_amount_minor', { mode: 'bigint' }).notNull(),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('refund_request_items_unique').on(table.refundRequestId, table.orderItemId),
    index('refund_request_items_order_item_idx').on(table.orderItemId),
  ],
);

export const refundRequestsRelations = relations(refundRequests, ({ many, one }) => ({
  items: many(refundRequestItems),
  order: one(orders, { fields: [refundRequests.orderId], references: [orders.id] }),
}));

export const refundRequestItemsRelations = relations(refundRequestItems, ({ one }) => ({
  request: one(refundRequests, {
    fields: [refundRequestItems.refundRequestId],
    references: [refundRequests.id],
  }),
  orderItem: one(orderItems, {
    fields: [refundRequestItems.orderItemId],
    references: [orderItems.id],
  }),
}));
