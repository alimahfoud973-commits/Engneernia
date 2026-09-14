import 'server-only';
import { inArray } from 'drizzle-orm';
import { settings } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { assertTaxRateBp } from '@/lib/money/tax';

/**
 * ===========================================================================
 * THE TAX RATE, READ FROM THE DATABASE (owner decision on OPEN-9)
 * ===========================================================================
 * There is no rate in this file. There is a function that asks what it is.
 *
 * The same rule as the minimum payout, and for a stronger reason: a tax rate
 * is a legal figure set by somebody other than us, it changes without the
 * platform changing, and the owner must be able to change it the day it
 * changes — not at the next deploy.
 *
 * THE FALLBACK IS ZERO, AND ZERO IS NOT A GUESS. An unseeded database charges
 * no tax, which is the only safe direction to be wrong in: charging a customer
 * a tax the platform is not liable for is money taken under a false heading,
 * while charging none is a shortfall the owner can see and settle. The owner
 * chose to ship at zero anyway.
 * ===========================================================================
 */

export interface TaxPolicy {
  readonly rateBp: number;
  readonly nameAr: string;
  readonly registration: string;
}

export interface InvoiceIdentity {
  readonly prefix: string;
  readonly sellerNameAr: string;
  readonly sellerAddressAr: string;
}

const KEYS = [
  'tax.rateBp',
  'tax.nameAr',
  'tax.registration',
  'invoice.prefix',
  'invoice.sellerNameAr',
  'invoice.sellerAddressAr',
] as const;

export async function readTaxPolicy(
  tx: Transaction,
): Promise<{ readonly tax: TaxPolicy; readonly invoice: InvoiceIdentity }> {
  const rows = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...KEYS]));

  const map = new Map(rows.map((row) => [row.key, row.value]));
  const str = (key: string, fallback: string) => {
    const value = map.get(key);
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  };

  const rawRate = map.get('tax.rateBp');
  /**
   * A malformed rate is refused, not coerced.
   *
   * `Number(someString)` on a settings row somebody typed as "15%" gives NaN,
   * and NaN quietly becomes 0 under `|| 0` — which would charge no tax while
   * appearing configured. Better to fail the sale and say the row is wrong.
   */
  const rateBp =
    rawRate === undefined || rawRate === null
      ? 0
      : assertTaxRateBp(typeof rawRate === 'number' ? rawRate : Number.NaN);

  return {
    tax: {
      rateBp,
      nameAr: str('tax.nameAr', 'ضريبة'),
      registration: str('tax.registration', ''),
    },
    invoice: {
      prefix: str('invoice.prefix', 'INV'),
      sellerNameAr: str('invoice.sellerNameAr', 'إنجينورا'),
      sellerAddressAr: str('invoice.sellerAddressAr', ''),
    },
  };
}
