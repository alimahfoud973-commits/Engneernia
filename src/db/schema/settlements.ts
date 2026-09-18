import { relations } from 'drizzle-orm';
import {
  bigint, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, utcTimestamp } from './columns';

/**
 * ===========================================================================
 * MONTHLY SETTLEMENT (specification §15, §16, §18 — decisions §8, §9)
 * ===========================================================================
 *
 * The owner's rule, restated so the schema can be read against it:
 *
 *   "The platform will NOT transfer the engineer's share after every sale.
 *    Instead, sales are accumulated during the month. At the beginning of the
 *    following month, the owner reviews and settles the accumulated balance."
 *
 * A settlement is therefore two things at once, and the columns say which is
 * which:
 *
 *   A STATEMENT of one accounting month — what sold, what was refunded, what
 *   the engineer earned in it. These are the `period*` columns, and they exist
 *   because decisions §9 asks for them by name.
 *
 *   A PAYMENT DECISION about everything still owed — which is not the same
 *   number. A balance under the threshold rolls forward (decisions §8), and a
 *   refund approved after its month was settled rolls forward as a DEBT. So
 *   `netDueMinor` is computed from the whole ledger up to the period's end,
 *   not from the period alone.
 *
 * Nothing here is a source of truth. Every figure is derived from the ledger
 * at generation time and then FROZEN, so a statement issued in October still
 * reads in March exactly as the engineer received it — while the ledger, which
 * remains the authority, can be recomputed independently to check it.
 * ===========================================================================
 */

/**
 * PENDING → APPROVED → PAID is the owner's proposed lifecycle (decisions §9),
 * with two states their own rules require:
 *
 *   CARRIED_FORWARD — the statement exists and the engineer can read it, but
 *                     nothing is paid: the balance is under the threshold, or
 *                     negative after a late refund. Decisions §8 requires this
 *                     to APPEAR ("ويظهر ذلك في كشفه"), not to be silently
 *                     skipped.
 *   CANCELLED       — generated in error, withdrawn before payment. The row
 *                     stays; specification §15 forbids deleting settlement
 *                     history.
 */
export const settlementStatusEnum = pgEnum('settlement_status', [
  'PENDING',
  'APPROVED',
  'PAID',
  'CARRIED_FORWARD',
  'CANCELLED',
]);

/** What a statement line represents. */
export const settlementLineKindEnum = pgEnum('settlement_line_kind', [
  'SALE',
  'REFUND',
  'ADJUSTMENT',
]);

export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human reference from §16, e.g. "SEP-2026-CIVIL". */
    reference: text('reference').notNull(),

    /*
     * A bare identifier, not a foreign key, and the name copied beside it.
     * A settlement is history: §15 says it is never deleted, so it must not be
     * the reason a contributor account cannot be. Same rule as the ledger
     * (migration 0026).
     */
    contributorId: uuid('contributor_id').notNull(),
    contributorName: text('contributor_name'),
    settlementCode: text('settlement_code'),

    periodKey: text('period_key').notNull(),
    periodStart: utcTimestamp('period_start').notNull(),
    /** Exclusive: `occurred_at < period_end` never double-counts a boundary. */
    periodEndExclusive: utcTimestamp('period_end_exclusive').notNull(),

    currency: text('currency').notNull(),
    status: settlementStatusEnum('status').notNull().default('PENDING'),

    // --- the STATEMENT: this month alone (decisions §9) ---
    /** The engineer's share of sales made in this period. */
    periodSalesMinor: bigint('period_sales_minor', { mode: 'bigint' }).notNull(),
    /** Clawed back by refunds APPROVED in this period, whenever the sale was. */
    periodRefundsMinor: bigint('period_refunds_minor', { mode: 'bigint' }).notNull(),
    periodAdjustmentsMinor: bigint('period_adjustments_minor', { mode: 'bigint' }).notNull(),
    /** Gross sales value the engineer's share came from, for context (§18). */
    periodGrossSalesMinor: bigint('period_gross_sales_minor', { mode: 'bigint' }).notNull(),
    /**
     * The engineer's OWN share of that sales value (migration 0052).
     *
     * On a product with one author the two are the same number. On a shared
     * product they are not, and the gross is the one that misleads: it is the
     * whole product's price, most of which is a colleague's. Nullable because
     * statements issued before 0052 cannot be given this figure honestly —
     * see the migration for why a title-matched backfill was refused.
     */
    periodSliceSalesMinor: bigint('period_slice_sales_minor', { mode: 'bigint' }),
    periodUnitsSold: integer('period_units_sold').notNull().default(0),

    // --- the PAYMENT DECISION: everything still owed ---
    /** Net due carried in from before this period — positive or negative. */
    carriedForwardMinor: bigint('carried_forward_minor', { mode: 'bigint' }).notNull(),
    /** What this settlement pays. Never negative — a debt carries, it is not billed. */
    netDueMinor: bigint('net_due_minor', { mode: 'bigint' }).notNull(),
    /**
     * The balance as of the period end, which is `carriedForward + period
     * movement`. When it is below the threshold or negative, `netDueMinor` is
     * zero and this number is what rolls into next month.
     */
    balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull(),
    /** The threshold AS IT WAS (decisions §8). Changing the setting later
     *  cannot rewrite the reason an old statement paid nothing. */
    minimumPayoutMinor: bigint('minimum_payout_minor', { mode: 'bigint' }).notNull(),

    generatedAt: utcTimestamp('generated_at').notNull().defaultNow(),
    generatedBy: uuid('generated_by'),
    approvedAt: utcTimestamp('approved_at'),
    approvedBy: uuid('approved_by'),
    paidAt: utcTimestamp('paid_at'),
    paidBy: uuid('paid_by'),

    /** How the money left, and its reference. Free text: the owner transfers
     *  by whatever local method decisions §2 makes available. */
    payoutMethod: text('payout_method'),
    payoutReference: text('payout_reference'),
    /** The SETTLEMENT_PAYOUT entry. A paid settlement the books do not know
     *  about is not a thing this schema permits — see the CHECK in 0032. */
    ledgerTransactionId: uuid('ledger_transaction_id'),

    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('settlements_reference_unique').on(table.reference),
    /** One settlement per contributor per month. Generating twice must not
     *  pay twice, and this is the guarantee that does not depend on code. */
    uniqueIndex('settlements_contributor_period_unique').on(
      table.contributorId,
      table.periodKey,
      table.currency,
    ),
    index('settlements_period_idx').on(table.periodKey, table.status),
    index('settlements_contributor_idx').on(table.contributorId, table.periodKey),
    index('settlements_status_idx').on(table.status, table.generatedAt),
  ],
);

/**
 * The statement's detail — what the engineer is looking at when they ask
 * "where does this number come from?" (§18).
 *
 * A SNAPSHOT, written once at generation. It deliberately carries no order id
 * and no buyer: OPEN-4 keeps the engineer's view to date, product, price and
 * their own share. Reconciliation against the original sale is the owner's
 * job, and the owner has the order lines.
 */
export const settlementLines = pgTable(
  'settlement_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id, { onDelete: 'cascade' }),

    kind: settlementLineKindEnum('kind').notNull(),
    occurredAt: utcTimestamp('occurred_at').notNull(),
    productTitle: text('product_title').notNull(),

    currency: text('currency').notNull(),
    /** What the customer paid for it. */
    grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
    /**
     * What THIS engineer's agreed rate was applied to (migration 0052): the
     * sale's net after discount and tax, sliced by credit. `engineerMinor` is
     * this minus the platform's cut of this — of this slice and no one
     * else's. Null on an adjustment line, and on every line written before
     * 0052.
     */
    sliceMinor: bigint('slice_minor', { mode: 'bigint' }),
    /** The engineer's frozen share. Negative on a REFUND line. */
    engineerMinor: bigint('engineer_minor', { mode: 'bigint' }).notNull(),

    note: text('note'),
    createdAt: createdAt(),
  },
  (table) => [
    index('settlement_lines_settlement_idx').on(table.settlementId, table.occurredAt),
  ],
);

export const settlementsRelations = relations(settlements, ({ many }) => ({
  lines: many(settlementLines),
}));

export const settlementLinesRelations = relations(settlementLines, ({ one }) => ({
  settlement: one(settlements, {
    fields: [settlementLines.settlementId],
    references: [settlements.id],
  }),
}));
