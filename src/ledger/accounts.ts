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
  /**
   * HISTORICAL. The platform issues no refunds (owner decision), and the
   * posting function refuses a REFUND entry. These two accounts remain in the
   * chart because ledger lines written before that decision reference them,
   * and the ledger is append-only — a chart of accounts cannot forget an
   * account its own history names.
   */
  PLATFORM_REVENUE_REVERSED: 'PLATFORM_REVENUE_REVERSED',
  CUSTOMER_REFUNDS_PAYABLE: 'CUSTOMER_REFUNDS_PAYABLE',
  /** Transfer costs. Who bears them is OPEN-2. */
  PAYMENT_FEES: 'PAYMENT_FEES',
  /**
   * Tax collected from customers and owed onward (owner decision on OPEN-9).
   *
   * A LIABILITY, deliberately — not income. This money is held on behalf of
   * the state; booking it as revenue would overstate what the platform earned
   * in every report the owner reads, and would put it in the pot that gets
   * divided with the engineer.
   */
  TAX_PAYABLE: 'TAX_PAYABLE',
} as const;

export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[keyof typeof LEDGER_ACCOUNTS];

/** Accounts that must name a contributor — enforced again by the database. */
export const CONTRIBUTOR_SCOPED_ACCOUNTS: ReadonlySet<LedgerAccount> = new Set([
  LEDGER_ACCOUNTS.ENGINEER_PAYABLE,
]);

export const LEDGER_KINDS = {
  SALE: 'SALE',
  /** Historical only — refused by the posting function (migration 0035). */
  REFUND: 'REFUND',
  /** Historical only — refused by the posting function (migration 0035). */
  REFUND_PAYOUT: 'REFUND_PAYOUT',
  SETTLEMENT_PAYOUT: 'SETTLEMENT_PAYOUT',
  /** The owner's correction. Not a refund: no customer, and it names a reason. */
  ADJUSTMENT: 'ADJUSTMENT',
} as const;

export type LedgerKind = (typeof LEDGER_KINDS)[keyof typeof LEDGER_KINDS];
