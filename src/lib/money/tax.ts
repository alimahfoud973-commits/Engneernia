import { MoneyInvariantError, ValidationError } from '@/lib/errors';
import { divRoundHalfAwayFromZero, money, subtract, type Money } from './money';

/**
 * ===========================================================================
 * TAX, EXTRACTED FROM A TAX-INCLUSIVE PRICE (owner decision on OPEN-9)
 * ===========================================================================
 * The owner decided the displayed price INCLUDES the tax. So the price is not
 * a base to add to — it is a total to divide. Given a rate r expressed in
 * basis points, a gross G already containing the tax breaks down as:
 *
 *     tax = G × r / (10000 + r)          ← rounded
 *     net = G − tax                      ← the remainder, never rounded again
 *
 * ONE SIDE IS ROUNDED AND THE OTHER IS THE REMAINDER. That is the project's
 * third non-negotiable rule, and it is what guarantees `tax + net === gross`
 * exactly, for every amount and every rate, with no drift to reconcile later.
 * Computing `net = G × 10000/(10000+r)` independently would round twice and
 * the two halves would occasionally fail to re-add to what the customer paid —
 * a discrepancy that would then have to live somewhere in the books.
 *
 * WHY basis points AND NOT A PERCENTAGE: 15% is 1500, and a rate of 7.5% is
 * 750 rather than a float nobody can add up exactly.
 *
 * AT RATE ZERO THIS IS AN EXACT NO-OP: tax is 0 and net is the gross,
 * unchanged, so the sale splits exactly as it did before tax existed. The
 * owner asked for it to ship disabled, and this is what makes "disabled" mean
 * "identical" rather than "nearly identical".
 * ===========================================================================
 */

/** The rate an invoice was issued under, kept beside its amounts. */
export interface TaxBreakdown {
  /** What the customer paid — the displayed price, unchanged. */
  readonly grossMinor: bigint;
  /** Held for the tax authority. Never income, never part of the split. */
  readonly taxMinor: bigint;
  /** What is left to divide between the platform and the engineer. */
  readonly netMinor: bigint;
  /** Frozen onto the sale so a later rate change cannot rewrite this one. */
  readonly rateBp: number;
}

const BASIS_POINTS_SCALE = 10_000n;

/**
 * A tax rate may legitimately exceed 100% nowhere on earth, but it is also not
 * bounded by it the way a commission share is: `assertBasisPoints` caps at
 * 10000 because a commission cannot exceed the whole. Tax gets its own check
 * with its own, looser, still-sane ceiling.
 */
const MAX_TAX_BP = 10_000;

export function assertTaxRateBp(bp: number): number {
  if (!Number.isInteger(bp)) {
    throw new ValidationError('نسبة الضريبة تُكتب بنقاط الأساس (١٥٪ = 1500)', { bp });
  }
  if (bp < 0 || bp > MAX_TAX_BP) {
    throw new ValidationError('نسبة الضريبة يجب أن تكون بين 0 و 10000 نقطة أساس', { bp });
  }
  return bp;
}

/**
 * Split a tax-inclusive amount into the tax it contains and the rest.
 *
 * @param gross  what the customer pays — the price as displayed
 * @param rateBp the rate in basis points; 0 disables tax entirely
 */
export function extractTax(gross: Money, rateBp: number): TaxBreakdown {
  assertTaxRateBp(rateBp);

  if (gross.amountMinor < 0n) {
    throw new MoneyInvariantError('لا تُستخرج ضريبة من مبلغ سالب', {
      grossMinor: gross.amountMinor.toString(),
    });
  }

  if (rateBp === 0) {
    // Not merely a shortcut: it states the guarantee. Nothing is divided,
    // nothing is rounded, and the net is the gross bit for bit.
    return {
      grossMinor: gross.amountMinor,
      taxMinor: 0n,
      netMinor: gross.amountMinor,
      rateBp: 0,
    };
  }

  const rate = BigInt(rateBp);
  const taxMinor = divRoundHalfAwayFromZero(
    gross.amountMinor * rate,
    BASIS_POINTS_SCALE + rate,
  );
  const netMinor = subtract(gross, money(taxMinor, gross.currency)).amountMinor;

  /**
   * Asserted, not assumed. The arithmetic above cannot fail — but a future
   * edit to it can, and a tax split that does not re-add to what was charged
   * would be discovered by an auditor rather than by us.
   */
  if (taxMinor + netMinor !== gross.amountMinor) {
    throw new MoneyInvariantError('الضريبة والصافي لا يساويان المبلغ المدفوع', {
      grossMinor: gross.amountMinor.toString(),
      taxMinor: taxMinor.toString(),
      netMinor: netMinor.toString(),
    });
  }

  return { grossMinor: gross.amountMinor, taxMinor, netMinor, rateBp };
}

/**
 * The tax-exclusive counterpart, for display only: what the price would be
 * called if it were quoted without tax. Used on the invoice, never in a split.
 */
export function netOf(gross: Money, rateBp: number): Money {
  return money(extractTax(gross, rateBp).netMinor, gross.currency);
}
