import 'server-only';
import { eq } from 'drizzle-orm';
import { settings } from '@/db/schema';
import type { Transaction } from '@/db/actor-context';
import { RuleViolationError } from '@/lib/errors';
import { assertBasisPoints, type BasisPoints } from '@/lib/money/money';

/**
 * ===========================================================================
 * VERSION POLICY, READ FROM THE DATABASE (Stage 4 repair — S4-09)
 * ===========================================================================
 * The upgrade discount is a settings row (`catalog.upgradeDiscountBp`,
 * migration 0059), never a number in this file (CLAUDE.md rule 9 in spirit:
 * a policy number is data). There is no fallback: a sale priced on a guessed
 * discount is the silent financial behaviour the no-guessing rule forbids, so
 * a missing or malformed row refuses the sale with a sentence.
 * ===========================================================================
 */

/** Parse the stored value; anything but a whole 0..10000 is refused. */
export function parseUpgradeDiscountBp(value: unknown): BasisPoints {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RuleViolationError(
      'سعر الترقية غير مضبوط في الإعدادات (catalog.upgradeDiscountBp)، فلا يمكن تسعيرها الآن.',
      { value },
    );
  }
  return assertBasisPoints(value);
}

export async function readUpgradeDiscountBp(tx: Transaction): Promise<BasisPoints> {
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'catalog.upgradeDiscountBp'))
    .limit(1);
  return parseUpgradeDiscountBp(row?.value);
}
