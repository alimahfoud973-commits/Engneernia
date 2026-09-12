import { relations } from 'drizzle-orm';
import { bigint, index, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, utcTimestamp } from './columns';

/**
 * ===========================================================================
 * FINANCIAL ADJUSTMENTS (owner decision, OPEN-21)
 * ===========================================================================
 *
 * The owner's words: an adjustment records an exceptional financial correction
 * "بطريقة رسمية وقابلة للتدقيق" — formally and auditably — and explicitly
 * NOT by editing or deleting the original sale.
 *
 * So this table holds the REASON, and the ledger holds the MONEY. Each row
 * points at a ledger transaction that was posted in the same database
 * transaction; neither can exist without the other.
 *
 * WHY A TABLE AND NOT JUST A LEDGER MEMO. The owner asked for a reference id,
 * a reason, a type, an affected account, an optional note, a timestamp and an
 * author. A memo string can hold all of that and none of it can be queried,
 * constrained, or shown as a column. A correction that cannot be listed and
 * filtered is not auditable — it is just a sentence in a log.
 *
 * WHAT THIS TABLE IS NOT: a second source of financial truth. Every amount
 * here is a copy of what the ledger records. If the two ever disagreed, the
 * ledger is right — it is the one that balances to zero and carries the hash
 * chain.
 * ===========================================================================
 */

/** Which side of the books a correction moves. */
export const adjustmentTargetEnum = pgEnum('adjustment_target', [
  /** Changes what a named engineer is owed. Requires a contributor. */
  'ENGINEER',
  /** Changes the platform's own cash position. Names no engineer. */
  'PLATFORM',
]);

/** The owner's "زيادة / خصم". */
export const adjustmentDirectionEnum = pgEnum('adjustment_direction', ['INCREASE', 'DECREASE']);

/**
 * Why. A short list rather than free text, so corrections can be counted and
 * reviewed by kind — with OTHER kept for the case nobody anticipated, which
 * is the case an adjustment usually exists for.
 */
export const adjustmentReasonEnum = pgEnum('adjustment_reason', [
  'DATA_ENTRY_ERROR',
  'DUPLICATE_PAYMENT_RECEIVED',
  'BANK_FEE_OR_SHORTFALL',
  'AGREED_COMPENSATION',
  'SETTLEMENT_CORRECTION',
  'OTHER',
]);

export const financialAdjustments = pgTable(
  'financial_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human reference the owner quotes, e.g. "ADJ-000007". */
    reference: text('reference').notNull(),

    target: adjustmentTargetEnum('target').notNull(),
    direction: adjustmentDirectionEnum('direction').notNull(),

    /**
     * Always POSITIVE. The direction is a separate column rather than the sign
     * of this one, so "decrease" cannot be entered as a negative increase and
     * read back as the wrong thing on a screen.
     */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),

    /** Set exactly when target is ENGINEER. Not a foreign key — see the ledger. */
    contributorId: uuid('contributor_id'),
    contributorName: text('contributor_name'),

    reason: adjustmentReasonEnum('reason').notNull(),
    /** The owner's explanation. Required: a reason code alone explains nothing. */
    note: text('note').notNull(),

    /**
     * The sale, order or settlement this corrects, when it corrects one.
     * Free-form so it can name any of them, and nullable because a correction
     * does not always have an original — a bank fee has no order behind it.
     */
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),

    /** The ledger entry that moved the money. Never null — see migration 0036. */
    ledgerTransactionId: uuid('ledger_transaction_id').notNull(),

    occurredAt: utcTimestamp('occurred_at').notNull(),
    createdBy: uuid('created_by'),
    createdByName: text('created_by_name'),

    /**
     * One adjustment per submission. A double-click, a retried request or a
     * refreshed confirmation page cannot post the correction twice.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('financial_adjustments_reference_unique').on(table.reference),
    uniqueIndex('financial_adjustments_idempotency_unique').on(table.idempotencyKey),
    uniqueIndex('financial_adjustments_ledger_unique').on(table.ledgerTransactionId),
    index('financial_adjustments_contributor_idx').on(table.contributorId, table.occurredAt),
    index('financial_adjustments_created_idx').on(table.occurredAt),
  ],
);

export const financialAdjustmentsRelations = relations(financialAdjustments, () => ({}));
