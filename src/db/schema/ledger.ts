import { relations } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, utcTimestamp } from './columns';

/**
 * ===========================================================================
 * THE DOUBLE-ENTRY LEDGER (specification §14, §17, §48 — decisions §7)
 * ===========================================================================
 *
 * Everything the platform knows about money is DERIVED from this ledger. No
 * balance is stored anywhere else, because a stored balance and a stored
 * history eventually disagree and there is no way to tell which one lied.
 *
 * Four rules, each enforced by the database rather than by application code:
 *
 *   1. EVERY transaction balances to zero, per currency. A posting that does
 *      not sum to zero is rejected by `app_post_ledger_transaction`, which is
 *      the only way in — the application role holds no INSERT privilege on
 *      these tables at all.
 *
 *   2. AMOUNTS ARE SIGNED. Positive is a debit, negative is a credit. One
 *      signed column instead of a debit/credit pair makes the central
 *      invariant a single `SUM(amount_minor) = 0` that any reader can check,
 *      rather than a comparison between two columns that can each be right on
 *      their own.
 *
 *   3. APPEND-ONLY. A mistake is corrected by posting the reversing entry,
 *      never by editing the original. `UPDATE` and `DELETE` are refused by a
 *      trigger and the privilege is not granted.
 *
 *   4. TAMPER-EVIDENT. Each transaction carries the hash of its own content
 *      and the hash of the transaction before it. Editing any historical row
 *      — with direct database access, bypassing the application entirely —
 *      breaks the chain from that row onwards, and `app_verify_ledger_chain()`
 *      names the first row that broke.
 *
 * The ledger never recomputes a number. A sale posts the amounts frozen on
 * the order line at sale time; a refund posts exactly those same amounts with
 * the sign flipped. Rounding therefore cannot drift between a sale and its
 * reversal, because no rounding happens twice.
 * ===========================================================================
 */

/**
 * How an account behaves, and hence what a positive balance means.
 *   DEBIT  — assets and expenses: value held or spent.
 *   CREDIT — liabilities and income: value owed or earned.
 */
export const ledgerNormalBalanceEnum = pgEnum('ledger_normal_balance', ['DEBIT', 'CREDIT']);

export const ledgerAccountTypeEnum = pgEnum('ledger_account_type', [
  'ASSET',
  'LIABILITY',
  'INCOME',
  'CONTRA_INCOME',
  'EXPENSE',
]);

/**
 * What caused a posting. Kept as an enum, not free text, so a report can
 * separate a sale from its reversal without parsing a memo.
 */
export const ledgerTransactionKindEnum = pgEnum('ledger_transaction_kind', [
  /** An order reached PAID: cash in, engineer owed, platform earned. */
  'SALE',
  /** The owner approved a refund: the sale's amounts, reversed exactly. */
  'REFUND',
  /** The money actually went back to the customer. */
  'REFUND_PAYOUT',
  /** A monthly settlement was paid to a contributor (phase P7). */
  'SETTLEMENT_PAYOUT',
  /** An owner correction. Never an edit — always a new, explained entry. */
  'ADJUSTMENT',
]);

/**
 * The chart of accounts (§14).
 *
 * A table rather than a code constant so a report can join a readable Arabic
 * name, and so adding an account is a migration that the ledger's own
 * validation immediately understands.
 */
export const ledgerAccounts = pgTable('ledger_accounts', {
  code: text('code').primaryKey(),
  type: ledgerAccountTypeEnum('type').notNull(),
  normalBalance: ledgerNormalBalanceEnum('normal_balance').notNull(),
  nameAr: text('name_ar').notNull(),
  descriptionAr: text('description_ar'),
  /**
   * True for accounts that track what is owed to a specific engineer. The
   * posting function refuses a line on such an account without a contributor,
   * and refuses a contributor on any other account — so "owed to nobody in
   * particular" cannot be recorded.
   */
  requiresContributor: boolean('requires_contributor').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    /**
     * Chain position. Gaps are normal and harmless — a rolled-back posting
     * consumes a sequence value — because the chain is defined by the hashes,
     * not by the numbers being contiguous.
     */
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    id: uuid('id').notNull().defaultRandom(),

    kind: ledgerTransactionKindEnum('kind').notNull(),
    currency: text('currency').notNull(),

    /** When the money moved, in UTC. */
    occurredAt: utcTimestamp('occurred_at').notNull(),
    /**
     * The accounting month, computed in Asia/Damascus by the DATABASE, not by
     * the caller (decisions §8). A sale at 00:30 on the first of the month
     * Damascus time belongs to the new month even though it is still the old
     * month in UTC, and the application cannot get that wrong here.
     */
    periodKey: text('period_key').notNull(),

    /** What this posting is about: 'order', 'refund_request', 'settlement'. */
    referenceType: text('reference_type').notNull(),
    referenceId: uuid('reference_id'),
    memo: text('memo'),
    actorUserId: uuid('actor_user_id'),

    // --- the chain ---
    /** The previous transaction's `entryHash`; 64 zeros for the first. */
    prevHash: text('prev_hash').notNull(),
    /** sha256 of this transaction's canonical content, lines included. */
    payloadHash: text('payload_hash').notNull(),
    /** sha256(prevHash || ':' || payloadHash). */
    entryHash: text('entry_hash').notNull(),

    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('ledger_transactions_id_unique').on(table.id),
    uniqueIndex('ledger_transactions_entry_hash_unique').on(table.entryHash),
    /**
     * A chain must not fork. Without this, two postings could both claim the
     * same predecessor and verification would have to choose a branch.
     */
    uniqueIndex('ledger_transactions_prev_hash_unique').on(table.prevHash),
    index('ledger_transactions_period_idx').on(table.periodKey, table.currency),
    index('ledger_transactions_reference_idx').on(table.referenceType, table.referenceId),
    index('ledger_transactions_kind_idx').on(table.kind, table.occurredAt),
  ],
);

export const ledgerLines = pgTable(
  'ledger_lines',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    transactionId: uuid('transaction_id').notNull(),
    /** Stable order within the transaction, so a printed entry reads the same twice. */
    lineNo: integer('line_no').notNull(),

    accountCode: text('account_code')
      .notNull()
      .references(() => ledgerAccounts.code, { onDelete: 'restrict' }),
    /**
     * Set exactly on accounts that require it — see `requiresContributor`.
     *
     * Deliberately NOT a foreign key (migration 0026). An append-only trail
     * must outlive what it describes: a ledger line referencing contributors
     * made a credited contributor undeletable forever, which is a constraint
     * on the platform, not a requirement of the books. The posting function
     * verifies the contributor exists at the moment of writing instead, so a
     * mistyped id still cannot be booked.
     */
    contributorId: uuid('contributor_id'),
    /** Copied at posting time, so a statement reads without the profile row. */
    contributorName: text('contributor_name'),

    /** Signed: positive debits, negative credits. Never zero. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),

    /*
     * currency, occurredAt, periodKey and kind are copied from the transaction
     * deliberately. A contributor's balance is then a single-table aggregate
     * that row-level security can filter on its own, without consulting a
     * header row and without a join that a policy would have to re-secure.
     * Both tables are append-only and both are written by the same function
     * in the same statement, so the copies cannot drift.
     */
    currency: text('currency').notNull(),
    occurredAt: utcTimestamp('occurred_at').notNull(),
    periodKey: text('period_key').notNull(),
    kind: ledgerTransactionKindEnum('kind').notNull(),

    memo: text('memo'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('ledger_lines_transaction_line_unique').on(table.transactionId, table.lineNo),
    /** The contributor balance query: one index, one scan, no join. */
    index('ledger_lines_contributor_idx').on(
      table.contributorId,
      table.currency,
      table.periodKey,
    ),
    index('ledger_lines_account_idx').on(table.accountCode, table.periodKey, table.currency),
    index('ledger_lines_transaction_idx').on(table.transactionId),
  ],
);

export const ledgerTransactionsRelations = relations(ledgerTransactions, ({ many }) => ({
  lines: many(ledgerLines),
}));

export const ledgerLinesRelations = relations(ledgerLines, ({ one }) => ({
  transaction: one(ledgerTransactions, {
    fields: [ledgerLines.transactionId],
    references: [ledgerTransactions.id],
  }),
  account: one(ledgerAccounts, {
    fields: [ledgerLines.accountCode],
    references: [ledgerAccounts.code],
  }),
}));

/** The `prev_hash` of the first transaction in the chain. */
export const LEDGER_GENESIS_HASH = '0'.repeat(64);
