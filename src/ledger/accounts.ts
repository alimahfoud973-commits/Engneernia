/**
 * The chart of accounts, mirrored from migration 0025.
 *
 * The database is the authority — it validates every posted line against the
 * `ledger_accounts` table and rejects a code it does not know. These constants
 * exist so that a typo in application code is a compile error rather than a
 * runtime rejection, and an integration test asserts that the two lists agree.
 */
export const LEDGER_ACCOUNTS = {
  /** What the platform holds. */
  PLATFORM_CASH: 'PLATFORM_CASH',
  /** What is owed to a named engineer. This IS the settlement balance (§15). */
  ENGINEER_PAYABLE: 'ENGINEER_PAYABLE',
  /** Commission earned. */
  PLATFORM_REVENUE: 'PLATFORM_REVENUE',
  /** Commission given back; kept apart so gross and reversed stay separable. */
  PLATFORM_REVENUE_REVERSED: 'PLATFORM_REVENUE_REVERSED',
  /** Approved refunds not yet transferred out. */
  CUSTOMER_REFUNDS_PAYABLE: 'CUSTOMER_REFUNDS_PAYABLE',
  /** Transfer costs. Who bears them is OPEN-2. */
  PAYMENT_FEES: 'PAYMENT_FEES',
} as const;

export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[keyof typeof LEDGER_ACCOUNTS];

/** Accounts that must name a contributor — enforced again by the database. */
export const CONTRIBUTOR_SCOPED_ACCOUNTS: ReadonlySet<LedgerAccount> = new Set([
  LEDGER_ACCOUNTS.ENGINEER_PAYABLE,
]);

export const LEDGER_KINDS = {
  SALE: 'SALE',
  REFUND: 'REFUND',
  REFUND_PAYOUT: 'REFUND_PAYOUT',
  SETTLEMENT_PAYOUT: 'SETTLEMENT_PAYOUT',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;

export type LedgerKind = (typeof LEDGER_KINDS)[keyof typeof LEDGER_KINDS];
