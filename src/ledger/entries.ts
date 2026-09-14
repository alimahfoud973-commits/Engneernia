import { LEDGER_ACCOUNTS, LEDGER_KINDS } from './accounts';
import type { LedgerEntryInput, LedgerLineInput } from './post';
import { MoneyInvariantError, RuleViolationError } from '@/lib/errors';

/**
 * ===========================================================================
 * WHAT A SALE AND A REFUND LOOK LIKE IN THE BOOKS
 * ===========================================================================
 * Pure functions: they take amounts that are already frozen and arrange them
 * into a balanced entry. They perform no division, no percentage, and no
 * rounding — every number here was computed once, at the moment of sale, and
 * is only ever copied afterwards.
 *
 * THERE IS NO REFUND BUILDER. The owner's decision is that a sale is final:
 * "الكتاب الذي يباع لا يسترد أمواله لأي سبب". Nothing in this file can
 * construct a reversal, and `app_post_ledger_transaction` refuses a REFUND
 * entry outright (migration 0035), so the absence is enforced by the database
 * and not merely by this file being short.
 *
 * An owner CORRECTION is a different thing and still exists: `ADJUSTMENT` is
 * the kind for it, it is the owner's own act, and it names a reason.
 * ===========================================================================
 */

/** One contributor's frozen share of one sale. */
export interface ContributorShare {
  readonly contributorId: string;
  readonly amountMinor: bigint;
}

export interface SettledSale {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly currency: string;
  /** What the customer paid. */
  readonly grossMinor: bigint;
  /** The platform's frozen share across all lines. */
  readonly platformMinor: bigint;
  /**
   * Tax contained in `grossMinor` (owner decision on OPEN-9). The displayed
   * price includes it, so this is money that was never anybody's share.
   * Zero when the owner has not set a rate, and a zero produces no line.
   */
  readonly taxMinor: bigint;
  /** Frozen per-contributor shares, already aggregated across lines. */
  readonly contributorShares: readonly ContributorShare[];
  readonly occurredAt: Date;
  readonly itemCount: number;
}

function sumShares(shares: readonly ContributorShare[]): bigint {
  return shares.reduce((total, share) => total + share.amountMinor, 0n);
}

function assertArithmetic(sale: SettledSale): void {
  const engineers = sumShares(sale.contributorShares);

  if (sale.taxMinor < 0n) {
    throw new MoneyInvariantError('Tax on a sale cannot be negative', {
      orderId: sale.orderId,
      taxMinor: sale.taxMinor.toString(),
    });
  }

  // Tax is part of what the customer paid and no part of what was divided, so
  // it belongs on THIS side of the equation. At rate zero the term is 0 and
  // the check is exactly the one that stood before tax existed.
  if (engineers + sale.platformMinor + sale.taxMinor !== sale.grossMinor) {
    // Reaching here means the snapshot itself is inconsistent, which no
    // amount of careful posting can repair. Refuse rather than book it.
    throw new MoneyInvariantError(
      'The frozen split does not re-sum to the amount paid',
      {
        orderId: sale.orderId,
        grossMinor: sale.grossMinor.toString(),
        platformMinor: sale.platformMinor.toString(),
        taxMinor: sale.taxMinor.toString(),
        engineersMinor: engineers.toString(),
      },
    );
  }

  if (sale.grossMinor <= 0n) {
    throw new RuleViolationError('A sale of zero or less cannot be posted', {
      orderId: sale.orderId,
    });
  }

  for (const share of sale.contributorShares) {
    if (share.amountMinor < 0n) {
      throw new MoneyInvariantError('A contributor share cannot be negative', {
        contributorId: share.contributorId,
      });
    }
  }
}

/**
 * A completed sale (specification §14).
 *
 *   DR  PLATFORM_CASH        the whole amount paid
 *   CR  TAX_PAYABLE          the tax inside that amount, owed to the state
 *   CR  ENGINEER_PAYABLE     each contributor's frozen share
 *   CR  PLATFORM_REVENUE     the platform's frozen share
 *
 * The tax line comes first among the credits because that is the order the
 * money is divided in: the state's portion is taken out before anything is
 * anybody's share (owner decision on OPEN-9). At rate zero it is absent and
 * the entry is identical to every sale booked before tax existed.
 *
 * A contributor whose frozen share is zero — a fixed-platform agreement that
 * consumed the whole price — produces no line, because a zero line carries no
 * information and the ledger refuses one.
 */
export function saleEntry(sale: SettledSale): LedgerEntryInput {
  assertArithmetic(sale);

  const lines: LedgerLineInput[] = [
    {
      account: LEDGER_ACCOUNTS.PLATFORM_CASH,
      amountMinor: sale.grossMinor,
      memo: `طلب ${sale.orderNumber}`,
    },
  ];

  if (sale.taxMinor !== 0n) {
    lines.push({
      account: LEDGER_ACCOUNTS.TAX_PAYABLE,
      amountMinor: -sale.taxMinor,
      memo: `ضريبة — طلب ${sale.orderNumber}`,
    });
  }

  for (const share of sale.contributorShares) {
    if (share.amountMinor === 0n) continue;
    lines.push({
      account: LEDGER_ACCOUNTS.ENGINEER_PAYABLE,
      contributorId: share.contributorId,
      amountMinor: -share.amountMinor,
      memo: `حصة المهندس — طلب ${sale.orderNumber}`,
    });
  }

  if (sale.platformMinor !== 0n) {
    lines.push({
      account: LEDGER_ACCOUNTS.PLATFORM_REVENUE,
      amountMinor: -sale.platformMinor,
      memo: `عمولة المنصة — طلب ${sale.orderNumber}`,
    });
  }

  return {
    kind: LEDGER_KINDS.SALE,
    currency: sale.currency,
    occurredAt: sale.occurredAt,
    referenceType: 'order',
    referenceId: sale.orderId,
    memo: `بيع ${sale.itemCount === 1 ? 'منتج' : `${sale.itemCount} منتجات`} — طلب ${sale.orderNumber}`,
    lines,
  };
}
