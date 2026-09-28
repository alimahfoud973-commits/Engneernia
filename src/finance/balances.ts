import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor, type Transaction } from '@/db/actor-context';
import { financialContributorId, isOwner, type Actor } from '@/authz/actor';
import { authorize } from '@/authz/policy';
import { NotFoundError } from '@/lib/errors';
import { LEDGER_ACCOUNTS } from '@/ledger/accounts';
import { readFinancialPolicy } from './policy';
import { requireDate } from '@/db';
import { divRoundHalfAwayFromZero } from '@/lib/money/money';

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
 *   - the database decides which rows resolve at all, regardless of the query.
 *
 * The third is the one that matters. Delete the first two and a contributor
 * still cannot read another's line. Since migration 0062 (S5-11) the rows are
 * read through `contributor_ledger_lines`: the seven columns a balance needs,
 * the caller's own contributor only (or everyone, for the owner) — not the
 * ledger itself, whose memo and sequence reveal the platform's order volume.
 * ===========================================================================
 */

export interface ContributorBalance {
  readonly contributorId: string;
  readonly currency: string;
  /** Credited by completed sales. */
  readonly earnedMinor: bigint;
  /**
   * Historical only. The platform issues no refunds, so this is zero for
   * everything sold after that decision — it stays in the shape because the
   * figure is a SUM over the ledger, and the ledger may still contain entries
   * written before it.
   */
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
  // Active or deactivated: the engineer's own record stays theirs to read (D-05).
  const own = financialContributorId(actor);

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
   * One scan of the engineer's ledger lines. Signed amounts make every figure a conditional
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
      FROM contributor_ledger_lines
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
      FROM contributor_ledger_lines
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
   * The platform's cut of THIS engineer's slice, at THIS engineer's rate.
   * Safe on every sale under OPEN-15 — see the query for why it was not before.
   */
  readonly platformMinor: bigint;
  /** How many of `unitsSold` were shared with another engineer. */
  readonly coAuthoredUnits: number;
}

/**
 * The sales behind the balance (§18): what sold, when, and how it split.
 *
 * ONE TABLE, AND IT IS THE ENGINEER'S OWN. `order_item_contributors` holds one
 * row per engineer per sale, and the policy on it resolves exactly their own.
 * Nothing here joins `orders` or `order_items`: both are invisible to a
 * contributor by policy since migration 0043, and an INNER JOIN through an
 * invisible table returns nothing rather than failing — which is how this
 * screen came to render an empty table for every engineer, silently, for as
 * long as 0043 had been in place. The date and currency live on the row
 * itself (migration 0051) for that reason.
 *
 * ON SHOWING THE PLATFORM'S SHARE. Specification §18 puts it on the engineer's
 * dashboard, and under OPEN-15 it is safe to show on EVERY sale, co-authored
 * or not: the figure is the platform's cut of THIS engineer's slice, computed
 * at THIS engineer's rate. Subtracting it yields their own slice and nothing
 * about anybody else — a colleague's pay needs a colleague's rate, which §12
 * keeps private.
 *
 * That is why the `author_count = 1` filter this function used to carry is
 * gone. It existed because one rate governed the whole line, so the platform's
 * share on a co-authored sale WAS the subtraction that reached a colleague's
 * pay. Per-engineer terms removed the reason rather than the symptom.
 */
export async function contributorSales(
  actor: Actor,
  contributorId?: string | null,
): Promise<readonly ContributorSalesSummary[]> {
  const scope = resolveScope(actor, contributorId);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT to_char(timezone(app_accounting_timezone(), oic.occurred_at), 'YYYY-MM')
                                                                  AS period_key,
             oic.currency,
             COUNT(*)::int                                        AS units_sold,
             COALESCE(SUM(oic.slice_minor), 0)::text              AS gross,
             COALESCE(SUM(oic.amount_minor), 0)::text             AS engineer,
             COALESCE(SUM(oic.platform_amount_minor), 0)::text    AS platform,
             COUNT(*) FILTER (WHERE oic.share_bp < 10000)::int    AS co_authored_units
        FROM order_item_contributors oic
       WHERE oic.contributor_id = ${scope}
         AND oic.occurred_at IS NOT NULL
         AND oic.slice_minor IS NOT NULL
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
    }));
  });
}

export interface ContributorSaleLine {
  readonly id: string;
  readonly soldAt: Date;
  readonly periodKey: string;
  /** Null on sales made before migration 0062 copied the title here. */
  readonly productTitle: string | null;
  readonly currency: string;
  /** Their credit on the product at the moment of sale. */
  readonly shareBp: number;
  /** What their terms applied to: their part of what was paid, less tax. */
  readonly sliceMinor: bigint;
  readonly engineerMinor: bigint;
  readonly platformMinor: bigint;
  readonly commissionModel: string | null;
  /**
   * Their rate and the platform's, in basis points of THEIR slice (D-01).
   * A percentage agreement states it; a fixed one is what the fixed amount
   * came to on this sale. Display figures derived from two frozen amounts.
   */
  readonly engineerRateBp: number | null;
  readonly platformRateBp: number | null;
  readonly clamped: boolean;
}

/**
 * The engineer's own sales, one by one (owner decision D-01): their credit,
 * their slice, their rate and the platform's, what each side received.
 *
 * Their OWN rows of `order_item_contributors` and nothing else — the same
 * single table `contributorSales` reads, for the same reason. What another
 * engineer on the same product earned is not on this engineer's row and so
 * is not here. Read-only, and available after deactivation (D-05).
 */
export async function contributorSaleLines(
  actor: Actor,
  contributorId?: string | null,
  options: { limit?: number } = {},
): Promise<readonly ContributorSaleLine[]> {
  const scope = resolveScope(actor, contributorId);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

  return withActor(actor, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT oic.id, oic.occurred_at,
             to_char(timezone(app_accounting_timezone(), oic.occurred_at), 'YYYY-MM') AS period_key,
             oic.product_title, oic.currency, oic.share_bp,
             oic.slice_minor, oic.amount_minor, oic.platform_amount_minor,
             oic.commission_model::text AS commission_model,
             oic.engineer_bp, oic.commission_clamped
        FROM order_item_contributors oic
       WHERE oic.contributor_id = ${scope}
         AND oic.occurred_at IS NOT NULL
         AND oic.slice_minor IS NOT NULL
       ORDER BY oic.occurred_at DESC, oic.id DESC
       LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const slice = BigInt(row.slice_minor as string);
      const engineer = BigInt(row.amount_minor as string);
      const platform = BigInt(row.platform_amount_minor as string);
      const model = (row.commission_model as string | null) ?? null;
      let engineerRateBp: number | null = null;
      if (model === 'PERCENTAGE' && row.engineer_bp != null) {
        engineerRateBp = Number(row.engineer_bp);
      } else if (slice > 0n) {
        engineerRateBp = Number(divRoundHalfAwayFromZero(engineer * 10_000n, slice));
      }
      return {
        id: row.id as string,
        soldAt: requireDate(row.occurred_at as string, 'occurred_at'),
        periodKey: row.period_key as string,
        productTitle: (row.product_title as string | null) ?? null,
        currency: row.currency as string,
        shareBp: Number(row.share_bp),
        sliceMinor: slice,
        engineerMinor: engineer,
        platformMinor: platform,
        commissionModel: model,
        engineerRateBp,
        platformRateBp: engineerRateBp === null ? null : 10_000 - engineerRateBp,
        clamped: row.commission_clamped === true,
      };
    });
  });
}
