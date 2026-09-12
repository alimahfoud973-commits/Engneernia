import { minorDigitsOf, type CurrencyCode } from '@/lib/money/currency';

/**
 * Formatting for financial screens.
 *
 * Display only. Nothing here is ever fed back into a calculation — every
 * amount arrives as minor units already computed on the server (CLAUDE.md
 * rule 2), and the only thing this file decides is where the decimal point
 * goes and whether a minus sign is shown.
 *
 * Separate from `formatPrice` in product-card because a catalogue price is
 * always positive and a ledger figure is not: a contributor whose refund
 * arrived after their settlement has a negative balance, and rendering that
 * as a positive number would be a lie on the one screen where it matters.
 */
export function formatMinor(amountMinor: bigint, currency: string): string {
  const digits = minorDigitsOf(currency as CurrencyCode);
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;

  const scale = 10n ** BigInt(digits);
  const whole = absolute / scale;
  const fraction = absolute % scale;

  const decimal =
    digits === 0
      ? whole.toString()
      : `${whole}.${fraction.toString().padStart(digits, '0')}`;

  // Formatted from the STRING, not from a Number. Intl accepts a decimal
  // string and formats it at full precision; routing it through a double
  // first would quietly corrupt any total above 2^53 minor units — and a
  // platform-wide report is exactly where such a total appears.
  const formatted = new Intl.NumberFormat('ar', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(decimal as unknown as number);

  return negative ? `−${formatted}` : formatted;
}
