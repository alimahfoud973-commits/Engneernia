import 'server-only';
import { sql } from 'drizzle-orm';
import type { Transaction } from '@/db/actor-context';
import { MoneyInvariantError, ValidationError } from '@/lib/errors';
import { assertCurrency } from '@/lib/money/currency';
import {
  CONTRIBUTOR_SCOPED_ACCOUNTS, type LedgerAccount, type LedgerKind,
} from './accounts';

/**
 * ===========================================================================
 * POSTING TO THE LEDGER
 * ===========================================================================
 * A thin, deliberately boring wrapper over `app_post_ledger_transaction`.
 *
 * The validation below duplicates what the database already enforces. That is
 * intentional and is not defence in depth for its own sake: the database
 * refuses an unbalanced entry with a SQL error at the end of a transaction,
 * which is the worst possible place to discover a programming mistake. These
 * checks fail in the caller's own stack frame, with the lines in hand.
 *
 * The database remains the authority. If these checks were deleted tomorrow,
 * nothing unbalanced would reach the books.
 * ===========================================================================
 */

export interface LedgerLineInput {
  readonly account: LedgerAccount;
  /** Required on contributor-scoped accounts, forbidden on every other. */
  readonly contributorId?: string | null;
  /** Signed minor units: positive debits, negative credits. Never zero. */
  readonly amountMinor: bigint;
  readonly memo?: string | null;
}

export interface LedgerEntryInput {
  readonly kind: LedgerKind;
  readonly currency: string;
  readonly occurredAt: Date;
  /** What this is about: 'order', 'refund_request', 'settlement'. */
  readonly referenceType: string;
  readonly referenceId?: string | null;
  readonly memo?: string | null;
  readonly lines: readonly LedgerLineInput[];
}

export function assertEntryBalances(entry: LedgerEntryInput): void {
  assertCurrency(entry.currency);

  if (entry.lines.length < 2) {
    throw new ValidationError('A ledger entry needs at least two lines', {
      kind: entry.kind,
      lineCount: entry.lines.length,
    });
  }

  let total = 0n;
  for (const [index, line] of entry.lines.entries()) {
    if (line.amountMinor === 0n) {
      throw new ValidationError('A ledger line cannot be zero', { index, account: line.account });
    }

    const needsContributor = CONTRIBUTOR_SCOPED_ACCOUNTS.has(line.account);
    const hasContributor = line.contributorId != null && line.contributorId !== '';

    if (needsContributor && !hasContributor) {
      throw new ValidationError('This account must name the contributor it is owed to', {
        index,
        account: line.account,
      });
    }
    if (!needsContributor && hasContributor) {
      throw new ValidationError('This account must not name a contributor', {
        index,
        account: line.account,
      });
    }

    total += line.amountMinor;
  }

  if (total !== 0n) {
    // The one invariant everything else depends on.
    throw new MoneyInvariantError('Ledger entry does not balance', {
      kind: entry.kind,
      currency: entry.currency,
      residualMinor: total.toString(),
    });
  }
}

/**
 * Post an entry, returning the transaction id.
 *
 * Amounts cross into SQL as STRINGS. A JSON number is a double by the time it
 * has passed through JavaScript, and a double loses integer precision above
 * 2^53 — silently, and only for the largest amounts, which is the worst
 * possible failure mode for money.
 */
export async function postLedgerTransaction(
  tx: Transaction,
  entry: LedgerEntryInput,
): Promise<string> {
  assertEntryBalances(entry);

  const lines = entry.lines.map((line) => ({
    account: line.account,
    contributorId: line.contributorId ?? null,
    amountMinor: line.amountMinor.toString(),
    memo: line.memo ?? null,
  }));

  const rows = (await tx.execute(sql`
    SELECT app_post_ledger_transaction(
      ${entry.kind},
      ${entry.currency},
      -- The driver cannot infer a parameter type inside a function call, so
      -- the instant crosses as an ISO-8601 string and is cast here. It is
      -- always UTC; the accounting month is derived from it by the database.
      ${entry.occurredAt.toISOString()}::timestamptz,
      ${entry.referenceType},
      ${entry.referenceId ?? null},
      ${entry.memo ?? null},
      ${JSON.stringify(lines)}::jsonb
    ) AS transaction_id
  `)) as unknown as Array<{ transaction_id: string }>;

  const transactionId = rows[0]?.transaction_id;
  if (!transactionId) {
    throw new MoneyInvariantError('The ledger returned no transaction id', { kind: entry.kind });
  }
  return transactionId;
}
