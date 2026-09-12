import { ValidationError } from '@/lib/errors';

/**
 * Currency codes are ISO-4217 strings. The type is deliberately `string`
 * rather than a closed union: decision D-04 requires that adding SAR, SYP or
 * EUR later is *data*, not a code change. The registry below is the phase-1
 * seed; from phase P2 the authoritative registry is the `currencies` table
 * and this object becomes its seed fixture.
 */
export type CurrencyCode = string;

export interface CurrencyDefinition {
  readonly code: CurrencyCode;
  /** Number of decimal places. USD 2 => amounts are stored in cents. */
  readonly minorDigits: number;
  readonly nameAr: string;
  readonly nameEn: string;
}

export const CURRENCY_SEED: Readonly<Record<string, CurrencyDefinition>> = Object.freeze({
  USD: { code: 'USD', minorDigits: 2, nameAr: 'دولار أمريكي', nameEn: 'US Dollar' },
  SAR: { code: 'SAR', minorDigits: 2, nameAr: 'ريال سعودي', nameEn: 'Saudi Riyal' },
  SYP: { code: 'SYP', minorDigits: 2, nameAr: 'ليرة سورية', nameEn: 'Syrian Pound' },
  EUR: { code: 'EUR', minorDigits: 2, nameAr: 'يورو', nameEn: 'Euro' },
});

/** Decision D-04: base accounting currency for phase 1. */
export const BASE_CURRENCY: CurrencyCode = 'USD';

export function isKnownCurrency(code: string): boolean {
  return Object.hasOwn(CURRENCY_SEED, code);
}

export function assertCurrency(code: string): CurrencyCode {
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ValidationError('Currency must be a 3-letter ISO-4217 code', { code });
  }
  if (!isKnownCurrency(code)) {
    throw new ValidationError('Currency is not enabled on this platform', { code });
  }
  return code;
}

export function minorDigitsOf(code: CurrencyCode): number {
  const def = CURRENCY_SEED[code];
  if (!def) throw new ValidationError('Unknown currency', { code });
  return def.minorDigits;
}
