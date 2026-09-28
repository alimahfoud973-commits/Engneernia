import { MoneyInvariantError, RuleViolationError, ValidationError } from '@/lib/errors';
import type { CurrencyCode } from './currency';
import {
  assertBasisPoints,
  divRoundHalfAwayFromZero,
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

export type CommissionModel = 'PERCENTAGE' | 'FIXED_ENGINEER' | 'FIXED_PLATFORM' | 'FIXED_BOTH';

/**
 * A discriminated union so that illegal combinations — a percentage agreement
 * carrying a fixed amount, say — cannot be represented at all.
 */
export type CommissionAgreement =
  | { readonly model: 'PERCENTAGE'; readonly engineerBp: BasisPoints; readonly currency: CurrencyCode }
  | { readonly model: 'FIXED_ENGINEER'; readonly engineerFixedMinor: bigint; readonly currency: CurrencyCode }
  | { readonly model: 'FIXED_PLATFORM'; readonly platformFixedMinor: bigint; readonly currency: CurrencyCode }
  /**
   * A fixed amount for EACH side (owner's final Stage 5 decision). Both are
   * scaled by the discount like any fixed amount, and what was paid is then
   * divided between the two in the ratio of those amounts — so a remainder
   * above the two fixed figures is shared in the same proportion, and a
   * shortfall below them is borne in the same proportion.
   *
   *   $100, platform $20 + engineer $30, paid $50:
   *     fixed commissions after the discount   platform $10, engineer $15 ($25)
   *     the remaining $25, shared 20:30        platform $10, engineer $15
   *     booked                                  platform $20, engineer $30
   */
  | {
    readonly model: 'FIXED_BOTH';
    readonly engineerFixedMinor: bigint;
    readonly platformFixedMinor: bigint;
    readonly currency: CurrencyCode;
  };

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
  /**
   * What a FIXED agreement asked for on this pot before any cap (S5-02): the
   * engineer's side for FIXED_ENGINEER, the platform's for FIXED_PLATFORM.
   * Null on a percentage agreement, which cannot ask for more than the pot.
   *
   * Recorded so a capped sale can say by how much: `clamped` alone told the
   * owner that something was cut, not what the agreement had promised.
   */
  readonly requestedMinor: bigint | null;
  /**
   * The two parts of `requestedMinor` for a fixed agreement: what the terms
   * asked for the engineer and for the platform on this pot, after the
   * discount and before any cap. Null where that side is not fixed. For
   * FIXED_BOTH `requestedMinor` is their sum.
   */
  readonly requestedEngineerMinor: bigint | null;
  readonly requestedPlatformMinor: bigint | null;
}

export interface SplitInput {
  readonly listPrice: Money;
  /**
   * THE OWNER'S DECISION ON OPEN-1: COMMISSION IS COMPUTED AFTER THE DISCOUNT.
   *
   * The pot to divide is what the customer actually paid, so a discount is
   * borne by both sides in the proportion their agreement already names. On an
   * 80/20 agreement a price of 100 discounted by 20 pays the engineer 64 and
   * the platform 16 — not 80 and 0, and not 60 and 20.
   *
   * That is the same shape as the decision on OPEN-9: tax comes out of the
   * price before anything is anybody's share, and so does a discount. Both
   * answer the same question — what is actually there to divide — and a
   * platform that answered them differently would owe two explanations.
   *
   * THE CODE BELOW DID NOT CHANGE WHEN THIS WAS DECIDED. `netPrice` was always
   * `listPrice - discount` and the split was always computed on it; the only
   * thing standing in the path was the refusal this replaces. That is what
   * "refuse rather than guess" buys: the undecided rule left no wrong
   * behaviour behind to unpick.
   *
   * A DISCOUNT IS NEVER A NEGATIVE PRICE. It may equal the list price — the
   * sale is then worth nothing and the ledger refuses to book it, which is the
   * correct place for that refusal — but it may not exceed it. A discount
   * larger than the price would produce a negative pot, and the only way to
   * divide a negative pot is to invoice the engineer.
   */
  readonly discount?: Money | undefined;
  readonly agreement: CommissionAgreement;
  /**
   * THE PRICE A FIXED AMOUNT IS QUOTED AGAINST (owner decisions D-02, D-03).
   *
   * A fixed agreement names an amount for the WHOLE product at its full price.
   * It is therefore a proportion of that price, and the proportion is what
   * survives a discount or a co-author:
   *
   *     share = fixed × pot ÷ base
   *
   *   D-02 — a discount is borne by both sides in their original proportion.
   *          $30 fixed on a $100 product sold at $50 pays $15, not $30.
   *   D-03 — on a co-authored product the fixed engineer amount is the total
   *          for all engineers, divided by contribution. $20 fixed at 60/40
   *          pays $12 and $8, not $20 each.
   *
   * Defaults to `listPrice`, so a single engine call on a whole sale applies
   * D-02 by itself. The sale path, which calls once per engineer's slice,
   * passes the product's whole tax-free list price, which applies D-03 too.
   *
   * At no discount and one author `pot === base`, and the result is exactly
   * the fixed amount — every sale made before these decisions reads the same.
   */
  readonly fixedBaseMinor?: bigint | undefined;
}

export function computeCommissionSnapshot(input: SplitInput): CommissionSnapshot {
  const { listPrice, agreement } = input;
  const currency = listPrice.currency;
  const discount = input.discount ?? zero(currency);

  if (agreement.currency !== currency) {
    throw new RuleViolationError(
      'عملة اتفاق العمولة لا تطابق عملة البيع',
      { agreementCurrency: agreement.currency, saleCurrency: currency },
    );
  }
  if (listPrice.amountMinor < 0n) {
    throw new ValidationError('سعر البيع لا يكون سالباً', {
      listPriceMinor: listPrice.amountMinor.toString(),
    });
  }
  if (discount.currency !== currency) {
    throw new RuleViolationError('عملة الخصم لا تطابق عملة البيع', {
      discountCurrency: discount.currency,
      saleCurrency: currency,
    });
  }
  if (discount.amountMinor < 0n) {
    // A negative discount is a surcharge wearing a discount's name, and it
    // would raise the pot above the price the customer agreed to.
    throw new ValidationError('الخصم لا يكون سالباً', {
      discountMinor: discount.amountMinor.toString(),
    });
  }
  if (discount.amountMinor > listPrice.amountMinor) {
    throw new ValidationError('الخصم لا يتجاوز السعر', {
      discountMinor: discount.amountMinor.toString(),
      listPriceMinor: listPrice.amountMinor.toString(),
    });
  }

  const netPrice = subtract(listPrice, discount);
  const base = input.fixedBaseMinor ?? listPrice.amountMinor;
  if (base < 0n) {
    throw new ValidationError('أساس المبلغ الثابت لا يكون سالباً', {
      fixedBaseMinor: base.toString(),
    });
  }

  let engineer: Money;
  let platform: Money;
  let clamped = false;
  let requestedMinor: bigint | null = null;
  let requestedEngineerMinor: bigint | null = null;
  let requestedPlatformMinor: bigint | null = null;

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
        throw new ValidationError('حصة المهندس الثابتة لا تكون سالبة', {
          engineerFixedMinor: fixed.amountMinor.toString(),
        });
      }
      requestedMinor = scaleFixed(fixed.amountMinor, netPrice.amountMinor, base);
      requestedEngineerMinor = requestedMinor;
      // Capped when the agreement asks for more than the price it is quoted
      // against: then no pot, at any discount, can pay it (S5-02).
      clamped = fixed.amountMinor > base;
      engineer = money(minBig(requestedMinor, netPrice.amountMinor), currency);
      platform = subtract(netPrice, engineer);
      break;
    }
    case 'FIXED_PLATFORM': {
      const fixed = money(agreement.platformFixedMinor, currency);
      if (fixed.amountMinor < 0n) {
        throw new ValidationError('حصة المنصة الثابتة لا تكون سالبة', {
          platformFixedMinor: fixed.amountMinor.toString(),
        });
      }
      requestedMinor = scaleFixed(fixed.amountMinor, netPrice.amountMinor, base);
      requestedPlatformMinor = requestedMinor;
      clamped = fixed.amountMinor > base;
      platform = money(minBig(requestedMinor, netPrice.amountMinor), currency);
      engineer = subtract(netPrice, platform);
      break;
    }
    case 'FIXED_BOTH': {
      const e = agreement.engineerFixedMinor;
      const p = agreement.platformFixedMinor;
      if (e < 0n || p < 0n) {
        throw new ValidationError('المبلغ الثابت للمهندس أو للمنصة لا يكون سالباً', {
          engineerFixedMinor: e.toString(),
          platformFixedMinor: p.toString(),
        });
      }
      if (e + p === 0n) {
        // Nothing to divide the pot in proportion to — refused rather than
        // guessing a split (CLAUDE.md, no-guessing rule).
        throw new ValidationError('اتفاق المبلغين الثابتين يحتاج مبلغاً أكبر من صفر لأحد الطرفين على الأقل');
      }
      requestedEngineerMinor = scaleFixed(e, netPrice.amountMinor, base);
      requestedPlatformMinor = scaleFixed(p, netPrice.amountMinor, base);
      requestedMinor = requestedEngineerMinor + requestedPlatformMinor;
      // Capped when the two fixed amounts together exceed the price they are
      // quoted against: the sale still completes, both sides share the cut.
      clamped = e + p > base;
      // The pot is divided in the ratio of the two fixed amounts: the engineer
      // side is the rounded one, the platform the remainder (rule 3).
      engineer = money(divRoundHalfAwayFromZero(netPrice.amountMinor * e, e + p), currency);
      platform = subtract(netPrice, engineer);
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
    engineerFixedMinor:
      agreement.model === 'FIXED_ENGINEER' || agreement.model === 'FIXED_BOTH'
        ? agreement.engineerFixedMinor
        : null,
    platformFixedMinor:
      agreement.model === 'FIXED_PLATFORM' || agreement.model === 'FIXED_BOTH'
        ? agreement.platformFixedMinor
        : null,
    engineerAmountMinor: engineer.amountMinor,
    platformAmountMinor: platform.amountMinor,
    clamped,
    requestedMinor,
    requestedEngineerMinor,
    requestedPlatformMinor,
  });
}

/**
 * `fixed × pot ÷ base`, rounded half away from zero — the fixed side is the
 * rounded one and the other is the remainder (CLAUDE.md rule 3).
 *
 * A base of zero is a free product: there is no price for the amount to be a
 * proportion of, and nothing in the pot to pay it from.
 */
function scaleFixed(fixedMinor: bigint, potMinor: bigint, baseMinor: bigint): bigint {
  if (baseMinor === 0n || potMinor === 0n) return 0n;
  if (potMinor === baseMinor) return fixedMinor;
  return divRoundHalfAwayFromZero(fixedMinor * potMinor, baseMinor);
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
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
