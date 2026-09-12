import { MoneyInvariantError, RuleViolationError, ValidationError } from '@/lib/errors';
import type { CurrencyCode } from './currency';
import {
  assertBasisPoints,
  money,
  percentOf,
  subtract,
  zero,
  type BasisPoints,
  type Money,
} from './money';

/**
 * ===========================================================================
 * DYNAMIC COMMISSION ENGINE (specification §11, §13 — decisions §5)
 * ===========================================================================
 * Commission is never a hard-coded amount. Three models are supported, chosen
 * per agreement by the platform owner, with a contributor-level default and a
 * product-level override resolved before this function is ever called.
 *
 * The object this returns is the FINANCIAL SNAPSHOT: it is copied verbatim
 * onto the order item at the moment payment is confirmed and is thereafter
 * immutable (enforced by a database trigger, phase P6). Changing a price or an
 * agreement later cannot reach it.
 * ===========================================================================
 */

export type CommissionModel = 'PERCENTAGE' | 'FIXED_ENGINEER' | 'FIXED_PLATFORM';

/**
 * A discriminated union so that illegal combinations — a percentage agreement
 * carrying a fixed amount, say — cannot be represented at all.
 */
export type CommissionAgreement =
  | { readonly model: 'PERCENTAGE'; readonly engineerBp: BasisPoints; readonly currency: CurrencyCode }
  | { readonly model: 'FIXED_ENGINEER'; readonly engineerFixedMinor: bigint; readonly currency: CurrencyCode }
  | { readonly model: 'FIXED_PLATFORM'; readonly platformFixedMinor: bigint; readonly currency: CurrencyCode };

/** Exactly the shape persisted onto `order_items`. */
export interface CommissionSnapshot {
  readonly currency: CurrencyCode;
  readonly listPriceMinor: bigint;
  readonly discountMinor: bigint;
  readonly netPriceMinor: bigint;
  readonly model: CommissionModel;
  readonly engineerBp: BasisPoints | null;
  readonly engineerFixedMinor: bigint | null;
  readonly platformFixedMinor: bigint | null;
  readonly engineerAmountMinor: bigint;
  readonly platformAmountMinor: bigint;
  /**
   * True when a fixed agreement exceeded the sale price and had to be capped.
   * The sale still completes; the owner is alerted, because a fixed engineer
   * share larger than the price means the agreement needs revisiting.
   */
  readonly clamped: boolean;
}

export interface SplitInput {
  readonly listPrice: Money;
  /**
   * Reserved for the future discount/coupon feature (spec §43). It is part of
   * the snapshot shape from day one so enabling discounts later needs no
   * migration of historical rows — but see OPEN-1: whether commission is
   * computed before or after a discount is an undecided business rule, so a
   * non-zero discount is rejected rather than guessed at.
   */
  readonly discount?: Money | undefined;
  readonly agreement: CommissionAgreement;
}

export function computeCommissionSnapshot(input: SplitInput): CommissionSnapshot {
  const { listPrice, agreement } = input;
  const currency = listPrice.currency;
  const discount = input.discount ?? zero(currency);

  if (agreement.currency !== currency) {
    throw new RuleViolationError(
      'Commission agreement currency does not match the sale currency',
      { agreementCurrency: agreement.currency, saleCurrency: currency },
    );
  }
  if (listPrice.amountMinor < 0n) {
    throw new ValidationError('Sale price cannot be negative', {
      listPriceMinor: listPrice.amountMinor.toString(),
    });
  }
  if (discount.currency !== currency) {
    throw new RuleViolationError('Discount currency does not match the sale currency', {
      discountCurrency: discount.currency,
      saleCurrency: currency,
    });
  }
  if (discount.amountMinor !== 0n) {
    throw new RuleViolationError(
      'Discounts are not enabled: the commission base policy (OPEN-1) is undecided',
      { discountMinor: discount.amountMinor.toString() },
    );
  }

  const netPrice = subtract(listPrice, discount);

  let engineer: Money;
  let platform: Money;
  let clamped = false;

  switch (agreement.model) {
    case 'PERCENTAGE': {
      assertBasisPoints(agreement.engineerBp);
      // Round exactly ONE side; the other is the remainder. This is what makes
      // `engineer + platform === netPrice` an identity rather than a hope.
      platform = percentOf(netPrice, 10_000 - agreement.engineerBp);
      engineer = subtract(netPrice, platform);
      break;
    }
    case 'FIXED_ENGINEER': {
      const fixed = money(agreement.engineerFixedMinor, currency);
      if (fixed.amountMinor < 0n) {
        throw new ValidationError('Fixed engineer share cannot be negative', {
          engineerFixedMinor: fixed.amountMinor.toString(),
        });
      }
      clamped = fixed.amountMinor > netPrice.amountMinor;
      engineer = clamped ? netPrice : fixed;
      platform = subtract(netPrice, engineer);
      break;
    }
    case 'FIXED_PLATFORM': {
      const fixed = money(agreement.platformFixedMinor, currency);
      if (fixed.amountMinor < 0n) {
        throw new ValidationError('Fixed platform share cannot be negative', {
          platformFixedMinor: fixed.amountMinor.toString(),
        });
      }
      clamped = fixed.amountMinor > netPrice.amountMinor;
      platform = clamped ? netPrice : fixed;
      engineer = subtract(netPrice, platform);
      break;
    }
  }

  assertSplitIsSound(netPrice, engineer, platform);

  return Object.freeze({
    currency,
    listPriceMinor: listPrice.amountMinor,
    discountMinor: discount.amountMinor,
    netPriceMinor: netPrice.amountMinor,
    model: agreement.model,
    engineerBp: agreement.model === 'PERCENTAGE' ? agreement.engineerBp : null,
    engineerFixedMinor: agreement.model === 'FIXED_ENGINEER' ? agreement.engineerFixedMinor : null,
    platformFixedMinor: agreement.model === 'FIXED_PLATFORM' ? agreement.platformFixedMinor : null,
    engineerAmountMinor: engineer.amountMinor,
    platformAmountMinor: platform.amountMinor,
    clamped,
  });
}

/**
 * The three properties every split must have, checked on every single call.
 * If one of these ever fails, the correct behaviour is to abort the sale —
 * not to record a transaction we cannot explain to a contributor.
 */
function assertSplitIsSound(netPrice: Money, engineer: Money, platform: Money): void {
  const total = engineer.amountMinor + platform.amountMinor;
  if (total !== netPrice.amountMinor) {
    throw new MoneyInvariantError('Split does not re-sum to the net price', {
      netPriceMinor: netPrice.amountMinor.toString(),
      engineerMinor: engineer.amountMinor.toString(),
      platformMinor: platform.amountMinor.toString(),
    });
  }
  if (engineer.amountMinor < 0n || platform.amountMinor < 0n) {
    throw new MoneyInvariantError('Split produced a negative share', {
      engineerMinor: engineer.amountMinor.toString(),
      platformMinor: platform.amountMinor.toString(),
    });
  }
}

/**
 * Reverse a snapshot for a refund (spec §17 — decisions §7).
 *
 * The original sale is never modified or deleted. This produces the mirrored
 * amounts that a reversing ledger transaction will post, derived from the
 * stored snapshot rather than from any current price or agreement.
 */
export function reverseSnapshot(snapshot: CommissionSnapshot): {
  readonly engineerAmountMinor: bigint;
  readonly platformAmountMinor: bigint;
  readonly netPriceMinor: bigint;
} {
  return Object.freeze({
    engineerAmountMinor: -snapshot.engineerAmountMinor,
    platformAmountMinor: -snapshot.platformAmountMinor,
    netPriceMinor: -snapshot.netPriceMinor,
  });
}
