import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor, type Transaction } from '@/db/actor-context';
import { activeContributorId, isOwner, type Actor } from '@/authz/actor';
import { authorize } from '@/authz/policy';
import { NotFoundError } from '@/lib/errors';
import { LEDGER_ACCOUNTS } from '@/ledger/accounts';
import { readFinancialPolicy } from './policy';

/**
 * ===========================================================================
 * WHAT AN ENGINEER IS OWED (specification §15, §18 — decisions §8, §9)
 * ===========================================================================
 *
 * DERIVED, NEVER STORED. There is no `contributors.balance` column and there
 * will not be one. A stored balance and a stored history disagree eventually,
 * and when they do there is no way to tell which one is lying. The balance is
 * a SUM over the ledger, computed when asked.
 *
 * Three layers keep one contributor out of another's figures:
 *   - the policy layer refuses the question;
 *   - the query scopes itself to one contributor;
 *   - row-level security filters ledger_lines regardless of the query.
 *
 * The third is the one that matters. Delete the first two and a contributor
 * still cannot read another's line.
 * ===========================================================================
 */

export interface ContributorBalance {
  readonly contributorId: string;
  readonly currency: string;
  /** Credited by completed sales. */
  readonly earnedMinor: bigint;
  /** Clawed back by approved refunds. */
  readonly reversedMinor: bigint;
  /** Already paid out in monthly settlements. */
  readonly settledMinor: bigint;
  /** Owner corrections, positive or negative. */
  readonly adjustmentsMinor: bigint;
  /**
   * What is owed right now. CAN BE NEGATIVE — a refund arriving after its
   * month was settled means the engineer was paid for a sale that was undone,
   * and the books say so rather than rounding the debt away.
   */
  readonly balanceMinor: bigint;
  /** From settings, never a constant (decisions §8). */
  readonly minimumPayoutMinor: bigint;
  readonly meetsMinimum: boolean;
}

export interface PeriodEarning {
  readonly periodKey: string;
  readonly currency: string;
  readonly earnedMinor: bigint;
  readonly reversedMinor: bigint;
  readonly netMinor: bigint;
}

export interface ContributorStatement {
  readonly contributorId: string;
  readonly balances: readonly ContributorBalance[];
  readonly byPeriod: readonly PeriodEarning[];
}

/**
 * Resolve which contributor the caller may ask about.
 *
 * An owner may name anyone. A contributor may name only themselves, and
 * naming someone else raises NotFound rather than Forbidden: confirming that
 * another contributor exists is itself a disclosure (§49).
 */
function resolveScope(actor: Actor, requested?: string | null): string {
  const own = activeContributorId(actor);

  if (isOwner(actor)) {
    if (!requested) throw new NotFoundError('لم يُحدَّد المساهم');
    return requested;
  }

  const target = requested ?? own;
  if (target === null) throw new NotFoundError('لا يوجد ملف مساهم لهذا الحساب');

  authorize(actor, 'contributor.readOwnFinancials', { contributorId: target });
  return target;
}

async function readBalances(
  tx: Transaction,
  contributorId: string,
  minimumPayoutMinor: bigint,
): Promise<readonly ContributorBalance[]> {
  /*
   * One scan of ledger_lines. Signed amounts make every figure a conditional
   * SUM of the same column rather than a join between debit and credit sides.
   *
   * The negations turn the accounting sign into the human question: a credit
   * to ENGINEER_PAYABLE is stored negative because it increases a liability,
   * and "earned" is the positive number the engineer expects to read.
   */
  const rows = (await tx.execute(sql`
    SELECT currency,
           COALESCE(SUM(-amount_minor) FILTER (WHERE kind = 'SALE'), 0)::text       AS earned,
           COALESCE(SUM(amount_minor)  FILTER (WHERE kind = 'REFUND'), 0)::text     AS reversed,
           COALESCE(SUM(amount_minor)  FILTER (WHERE kind = 'SETTLEMENT_PAYOUT'), 0)::text AS settled,
           COALESCE(SUM(-amount_minor) FILTER (WHERE kind = 'ADJUSTMENT'), 0)::text AS adjustments,
           COALESCE(SUM(-amount_minor), 0)::text                                    AS balance
      FROM ledger_lines
     WHERE account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE}
       AND contributor_id = ${contributorId}
     GROUP BY currency
     ORDER BY currency
  `)) as unknown as Array<Record<string, string>>;

  return rows.map((row) => {
    const balanceMinor = BigInt(row.balance!);
    return {
      contributorId,
      currency: row.currency!,
      earnedMinor: BigInt(row.earned!),
      reversedMinor: BigInt(row.reversed!),
      settledMinor: BigInt(row.settled!),
      adjustmentsMinor: BigInt(row.adjustments!),
      balanceMinor,
      minimumPayoutMinor,
      meetsMinimum: balanceMinor >= minimumPayoutMinor,
    };
  });
}

async function readByPeriod(
  tx: Transaction,
  contributorId: string,
): Promise<readonly PeriodEarning[]> {
  const rows = (await tx.execute(sql`
    SELECT period_key, currency,
           COALESCE(SUM(-amount_minor) FILTER (WHERE kind = 'SALE'), 0)::text   AS earned,
           COALESCE(SUM(amount_minor)  FILTER (WHERE kind = 'REFUND'), 0)::text AS reversed
      FROM ledger_lines
     WHERE account_code = ${LEDGER_ACCOUNTS.ENGINEER_PAYABLE}
       AND contributor_id = ${contributorId}
       AND kind IN ('SALE', 'REFUND')
     GROUP BY period_key, currency
     ORDER BY period_key DESC, currency
  `)) as unknown as Array<Record<string, string>>;

  return rows.map((row) => {
    const earnedMinor = BigInt(row.earned!);
    const reversedMinor = BigInt(row.reversed!);
    return {
      periodKey: row.period_key!,
      currency: row.currency!,
      earnedMinor,
      reversedMinor,
      netMinor: earnedMinor - reversedMinor,
    };
  });
}

/**
 * The engineer's own statement (§18), or the owner's view of one engineer.
 *
 * A refund is attributed to the period IT WAS APPROVED IN, not the period of
 * the sale it reverses. That is deliberate: a settled month is settled, and
 * reaching back to restate it would contradict §48. The reversal lands in the
 * open month, which is where it can still be collected — and where a
 * negative balance becomes visible rather than hidden.
 */
export async function contributorStatement(
  actor: Actor,
  contributorId?: string | null,
): Promise<ContributorStatement> {
  const scope = resolveScope(actor, contributorId);

  return withActor(actor, async (tx) => {
    const policy = await readFinancialPolicy(tx);
    const [balances, byPeriod] = await Promise.all([
      readBalances(tx, scope, policy.settlement.minimumPayoutMinor),
      readByPeriod(tx, scope),
    ]);
    return { contributorId: scope, balances, byPeriod };
  });
}

export interface ContributorSalesSummary {
  readonly periodKey: string;
  readonly currency: string;
  readonly unitsSold: number;
  readonly grossMinor: bigint;
  readonly engineerMinor: bigint;
  /**
   * The platform's share — counted ONLY over sales where this contributor is
   * the sole credited author. See the query for why.
   */
  readonly platformMinor: bigint;
  /** How many of `unitsSold` are excluded from `platformMinor`. */
  readonly coAuthoredUnits: number;
  readonly refundedUnits: number;
}

/**
 * The sales behind the balance (§18): what sold, for how much, and how the
 * price split.
 *
 * ON SHOWING THE PLATFORM'S SHARE. Specification §18 puts "Platform Share" on
 * the engineer's own dashboard, and for a product they wrote alone that
 * discloses nothing: they know the price and their own share, so the
 * remainder is arithmetic they can already do.
 *
 * A CO-AUTHORED product is different. There, price minus platform share minus
 * their own share equals what the OTHER authors were paid — and decisions §6
 * says a contributor must not learn the other contributors' shares. Showing
 * the platform's share on a co-authored sale would hand them that subtraction.
 *
 * So the platform's share is summed only over sales where this contributor is
 * the sole credited author, and `coAuthoredUnits` says how many sales were
 * left out, so the figure explains itself instead of looking like an error.
 */
export async function contributorSales(
  actor: Actor,
  contributorId?: string | null,
): Promise<readonly ContributorSalesSummary[]> {
  const scope = resolveScope(actor, contributorId);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      WITH mine AS (
        SELECT oi.id, oi.currency, oi.unit_price_minor, oi.platform_amount_minor,
               oi.refunded_at, o.paid_at, oic.amount_minor AS my_share,
               -- Counted with the owner's reach, not the contributor's: the
               -- contributor's own policy hides the other authors' rows, which
               -- would make every co-authored sale look sole-authored.
               app_order_item_author_count(oi.id) AS author_count
          FROM order_item_contributors oic
          JOIN order_items oi ON oi.id = oic.order_item_id
          JOIN orders o       ON o.id = oi.order_id
         WHERE oic.contributor_id = ${scope}
           AND o.paid_at IS NOT NULL
      )
      SELECT to_char(timezone(app_accounting_timezone(), paid_at), 'YYYY-MM') AS period_key,
             currency,
             COUNT(*)::int                                           AS units_sold,
             COALESCE(SUM(unit_price_minor), 0)::text                AS gross,
             COALESCE(SUM(my_share), 0)::text                        AS engineer,
             COALESCE(SUM(platform_amount_minor)
                        FILTER (WHERE author_count = 1), 0)::text    AS platform,
             COUNT(*) FILTER (WHERE author_count > 1)::int           AS co_authored_units,
             COUNT(*) FILTER (WHERE refunded_at IS NOT NULL)::int    AS refunded_units
        FROM mine
       GROUP BY 1, 2
       ORDER BY 1 DESC, 2
    `)) as unknown as Array<Record<string, string | number>>;

    return rows.map((row) => ({
      periodKey: row.period_key as string,
      currency: row.currency as string,
      unitsSold: Number(row.units_sold),
      grossMinor: BigInt(row.gross as string),
      engineerMinor: BigInt(row.engineer as string),
      platformMinor: BigInt(row.platform as string),
      coAuthoredUnits: Number(row.co_authored_units),
      refundedUnits: Number(row.refunded_units),
    }));
  });
}
