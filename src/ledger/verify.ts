import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor, type Transaction } from '@/db/actor-context';
import { isOwner, type Actor } from '@/authz/actor';
import { RuleViolationError } from '@/lib/errors';
import { requireDate } from '@/db';

/**
 * Integrity checks on the books (specification §37, §48).
 *
 * Two questions, both owner-only, both answered by the database rather than
 * by recomputing in application code — checking the ledger with the same code
 * that wrote it would only prove the code agrees with itself.
 */

export interface ChainProblem {
  readonly seq: bigint;
  readonly transactionId: string;
  readonly problem: string;
}

export interface CurrencyBalance {
  readonly currency: string;
  /** Must be zero. Anything else means money was created or destroyed. */
  readonly totalMinor: bigint;
  readonly lineCount: bigint;
}

export interface LedgerHealth {
  readonly checkedAt: Date;
  readonly balances: readonly CurrencyBalance[];
  readonly chainProblems: readonly ChainProblem[];
  readonly isHealthy: boolean;
}

async function readHealth(tx: Transaction): Promise<LedgerHealth> {
  const balanceRows = (await tx.execute(
    sql`SELECT currency, total_minor, line_count FROM app_ledger_balance_check()`,
  )) as unknown as Array<{ currency: string; total_minor: string; line_count: string }>;

  const problemRows = (await tx.execute(
    sql`SELECT seq, transaction_id, problem FROM app_verify_ledger_chain()`,
  )) as unknown as Array<{ seq: string; transaction_id: string; problem: string }>;

  const balances = balanceRows.map((row) => ({
    currency: row.currency,
    totalMinor: BigInt(row.total_minor),
    lineCount: BigInt(row.line_count),
  }));

  const chainProblems = problemRows.map((row) => ({
    seq: BigInt(row.seq),
    transactionId: row.transaction_id,
    problem: row.problem,
  }));

  return {
    checkedAt: new Date(),
    balances,
    chainProblems,
    isHealthy: chainProblems.length === 0 && balances.every((b) => b.totalMinor === 0n),
  };
}

export async function checkLedgerHealth(actor: Actor): Promise<LedgerHealth> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('فحص سلامة الدفتر من صلاحية مالك المنصة وحده');
  }
  return withActor(actor, readHealth);
}

export interface LedgerTransactionSummary {
  readonly seq: bigint;
  readonly id: string;
  readonly kind: string;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly periodKey: string;
  readonly referenceType: string;
  readonly referenceId: string | null;
  readonly memo: string | null;
  readonly entryHash: string;
}

/**
 * The owner's view of the journal, newest first.
 *
 * Deliberately NOT filtered by contributor here: this function is owner-only
 * and the policies would filter it anyway. A contributor's own view of the
 * ledger is built in `src/finance/balances.ts`, which reads the same tables
 * under their own actor and therefore under their own policies.
 */
export async function listLedgerTransactions(
  actor: Actor,
  options: { limit?: number; periodKey?: string } = {},
): Promise<readonly LedgerTransactionSummary[]> {
  if (!isOwner(actor)) {
    throw new RuleViolationError('دفتر القيود من صلاحية مالك المنصة وحده');
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT seq, id, kind::text AS kind, currency, occurred_at, period_key,
             reference_type, reference_id, memo, entry_hash
        FROM ledger_transactions
       WHERE ${options.periodKey ? sql`period_key = ${options.periodKey}` : sql`true`}
       ORDER BY seq DESC
       LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      seq: BigInt(row.seq as string),
      id: row.id as string,
      kind: row.kind as string,
      currency: row.currency as string,
      occurredAt: requireDate(row.occurred_at as string, 'occurred_at'),
      periodKey: row.period_key as string,
      referenceType: row.reference_type as string,
      referenceId: (row.reference_id as string | null) ?? null,
      memo: (row.memo as string | null) ?? null,
      entryHash: row.entry_hash as string,
    }));
  });
}
