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
 * That is what makes a refund exact. `refundEntry` receives the same figures
 * `saleEntry` received and negates them, so the reversal cannot disagree with
 * the original by a cent, however the original was rounded.
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

  if (engineers + sale.platformMinor !== sale.grossMinor) {
    // Reaching here means the snapshot itself is inconsistent, which no
    // amount of careful posting can repair. Refuse rather than book it.
    throw new MoneyInvariantError(
      'The frozen split does not re-sum to the amount paid',
      {
        orderId: sale.orderId,
        grossMinor: sale.grossMinor.toString(),
        platformMinor: sale.platformMinor.toString(),
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
 *   CR  ENGINEER_PAYABLE     each contributor's frozen share
 *   CR  PLATFORM_REVENUE     the platform's frozen share
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

export interface ApprovedRefund {
  readonly refundRequestId: string;
  readonly reference: string;
  readonly orderNumber: string;
  readonly currency: string;
  readonly grossMinor: bigint;
  readonly platformMinor: bigint;
  readonly contributorShares: readonly ContributorShare[];
  readonly occurredAt: Date;
}

/**
 * A refund the owner approved (specification §17).
 *
 *   DR  ENGINEER_PAYABLE             the share is clawed back
 *   DR  PLATFORM_REVERSED            the commission is given back
 *   CR  CUSTOMER_REFUNDS_PAYABLE     the customer is now owed the money
 *
 * Exactly the sale's entry with every sign flipped, except that the credit
 * goes to a liability rather than out of cash: approving a refund creates an
 * obligation, and the cash leaves later, when someone actually makes the
 * transfer. Booking it against cash immediately would report money as gone
 * while it is still in the account.
 *
 * The engineer's payable may go NEGATIVE here, and that is correct: a refund
 * arriving after its month was settled means the engineer has been paid for a
 * sale that was undone, and the books must say so rather than quietly
 * rounding the debt up to zero.
 */
export function refundEntry(refund: ApprovedRefund): LedgerEntryInput {
  const engineers = sumShares(refund.contributorShares);

  if (engineers + refund.platformMinor !== refund.grossMinor) {
    throw new MoneyInvariantError(
      'A refund must reverse exactly what the sale recorded',
      {
        refundRequestId: refund.refundRequestId,
        grossMinor: refund.grossMinor.toString(),
        platformMinor: refund.platformMinor.toString(),
        engineersMinor: engineers.toString(),
      },
    );
  }

  const lines: LedgerLineInput[] = [];

  for (const share of refund.contributorShares) {
    if (share.amountMinor === 0n) continue;
    lines.push({
      account: LEDGER_ACCOUNTS.ENGINEER_PAYABLE,
      contributorId: share.contributorId,
      amountMinor: share.amountMinor,
      memo: `استرجاع ${refund.reference}`,
    });
  }

  if (refund.platformMinor !== 0n) {
    lines.push({
      account: LEDGER_ACCOUNTS.PLATFORM_REVENUE_REVERSED,
      amountMinor: refund.platformMinor,
      memo: `عمولة معادة — ${refund.reference}`,
    });
  }

  lines.push({
    account: LEDGER_ACCOUNTS.CUSTOMER_REFUNDS_PAYABLE,
    amountMinor: -refund.grossMinor,
    memo: `مستحق للعميل — ${refund.reference}`,
  });

  return {
    kind: LEDGER_KINDS.REFUND,
    currency: refund.currency,
    occurredAt: refund.occurredAt,
    referenceType: 'refund_request',
    referenceId: refund.refundRequestId,
    memo: `استرجاع ${refund.reference} — طلب ${refund.orderNumber}`,
    lines,
  };
}

/**
 * The money actually went back to the customer.
 *
 *   DR  CUSTOMER_REFUNDS_PAYABLE   the obligation is discharged
 *   CR  PLATFORM_CASH              and the cash has left
 */
export function refundPayoutEntry(input: {
  readonly refundRequestId: string;
  readonly reference: string;
  readonly currency: string;
  readonly grossMinor: bigint;
  readonly occurredAt: Date;
  readonly payoutReference?: string | null;
}): LedgerEntryInput {
  if (input.grossMinor <= 0n) {
    throw new RuleViolationError('A refund payout must be a positive amount', {
      refundRequestId: input.refundRequestId,
    });
  }

  return {
    kind: LEDGER_KINDS.REFUND_PAYOUT,
    currency: input.currency,
    occurredAt: input.occurredAt,
    referenceType: 'refund_request',
    referenceId: input.refundRequestId,
    memo: input.payoutReference
      ? `تحويل استرجاع ${input.reference} — مرجع ${input.payoutReference}`
      : `تحويل استرجاع ${input.reference}`,
    lines: [
      { account: LEDGER_ACCOUNTS.CUSTOMER_REFUNDS_PAYABLE, amountMinor: input.grossMinor },
      { account: LEDGER_ACCOUNTS.PLATFORM_CASH, amountMinor: -input.grossMinor },
    ],
  };
}
