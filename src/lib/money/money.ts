import { MoneyInvariantError, ValidationError } from '@/lib/errors';
import { assertCurrency, minorDigitsOf, type CurrencyCode } from './currency';

/**
 * ===========================================================================
 * THE MONEY RULES (specification §14, §48 — additional decisions §4)
 * ===========================================================================
 *
 *  1. Every monetary value is an INTEGER number of minor units (cents), held
 *     as a `bigint`. No IEEE-754 float ever touches an amount.
 *  2. Every amount carries its currency. Cross-currency arithmetic throws.
 *  3. Percentages are integer BASIS POINTS (80% === 8000), never decimals.
 *  4. When a value must be split, exactly ONE side is rounded and the other
 *     is the remainder, so the parts always re-sum to the whole. Money is
 *     never created or destroyed by rounding.
 *
 * These rules exist because the ledger is the product. A half-cent drift that
 * is invisible in a single order becomes an unexplainable settlement dispute
 * across ten thousand of them.
 * ===========================================================================
 */

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export const BASIS_POINTS_SCALE = 10_000n;
/** Basis points: 0 = 0%, 10000 = 100%. */
export type BasisPoints = number;

export function money(amountMinor: bigint | number, currency: string): Money {
  // Validate BEFORE converting: BigInt() throws a bare RangeError on a
  // fractional input, which would escape the domain error taxonomy.
  if (typeof amountMinor === 'number' && !Number.isSafeInteger(amountMinor)) {
    throw new ValidationError('Monetary amounts must be safe integers in minor units', {
      amountMinor,
    });
  }
  const minor = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  return Object.freeze({ amountMinor: minor, currency: assertCurrency(currency) });
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyInvariantError('Cannot combine amounts in different currencies', {
      left: a.currency,
      right: b.currency,
    });
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function sum(items: readonly Money[], currency: string): Money {
  return items.reduce<Money>((acc, m) => add(acc, m), zero(currency));
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/**
 * Integer division rounding half away from zero.
 *
 * Half-away-from-zero (rather than half-up) keeps the operation symmetric:
 * `round(-x) === -round(x)`. That symmetry is what lets a refund reverse a
 * sale to the cent when a reversal is recomputed rather than negated.
 *
 * @param numerator   may be negative
 * @param denominator must be strictly positive
 */
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new MoneyInvariantError('Denominator must be positive', { denominator });
  }
  const half = denominator / 2n;
  return numerator >= 0n
    ? (numerator + half) / denominator
    : -((-numerator + half) / denominator);
}

/**
 * Take `bp` basis points of an amount, rounded. Used for the commission split
 * and nothing else — callers must always derive the counterpart side by
 * subtraction, never by a second `percentOf` call, or the two rounded halves
 * may not re-sum to the whole.
 */
export function percentOf(amount: Money, bp: BasisPoints): Money {
  assertBasisPoints(bp);
  return money(
    divRoundHalfAwayFromZero(amount.amountMinor * BigInt(bp), BASIS_POINTS_SCALE),
    amount.currency,
  );
}

export function assertBasisPoints(bp: number): BasisPoints {
  if (!Number.isInteger(bp)) {
    throw new ValidationError('Basis points must be an integer (80% === 8000)', { bp });
  }
  if (bp < 0 || bp > 10_000) {
    throw new ValidationError('Basis points must be between 0 and 10000 inclusive', { bp });
  }
  return bp;
}

/**
 * Render for display only. Never use the returned string in a calculation,
 * and never parse a display string back into an amount.
 */
export function formatMoney(
  amount: Money,
  locale = 'ar',
  options: { readonly withSymbol?: boolean } = {},
): string {
  const digits = minorDigitsOf(amount.currency);
  const divisor = 10 ** digits;
  // Safe: display only. The division happens after the value is final.
  const asNumber = Number(amount.amountMinor) / divisor;
  return new Intl.NumberFormat(locale, {
    style: options.withSymbol === false ? 'decimal' : 'currency',
    currency: amount.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(asNumber);
}

/** Parse a human-entered major-unit string ("10.50") into minor units. */
export function parseMajorUnits(input: string, currency: string): Money {
  const code = assertCurrency(currency);
  const digits = minorDigitsOf(code);
  const trimmed = input.trim().replace(/[٫٬,]/g, (m) => (m === ',' ? '' : '.'));
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new ValidationError('Amount must be a plain decimal number', { input });
  }
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > digits) {
    throw new ValidationError(`Amount has more than ${digits} decimal places`, { input });
  }
  const padded = fraction.padEnd(digits, '0');
  const minor = BigInt(whole) * BigInt(10 ** digits) + BigInt(padded === '' ? '0' : padded);
  return money(sign === '-' ? -minor : minor, code);
}
