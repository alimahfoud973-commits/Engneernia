import { RuleViolationError, MoneyInvariantError } from '@/lib/errors';
import { assertBasisPoints, money, BASIS_POINTS_SCALE, type BasisPoints, type Money } from './money';

/**
 * ===========================================================================
 * MULTI-CONTRIBUTOR REVENUE SPLIT (decisions §6)
 * ===========================================================================
 * A product may be credited to more than one engineer. Per the owner's
 * decision:
 *   - only the platform owner creates the link and sets each share;
 *   - the shares must be validated to total exactly 100%;
 *   - the distribution is snapshotted at the time of sale;
 *   - changing the distribution later does not affect past sales.
 *
 * This module owns the last of those guarantees at the arithmetic level: the
 * engineer's total share is divided among contributors WITHOUT losing or
 * inventing a single minor unit, using the largest-remainder (Hamilton)
 * method with a deterministic tie-break.
 * ===========================================================================
 */

export interface ContributorShare {
  readonly contributorId: string;
  readonly shareBp: BasisPoints;
}

export interface ContributorAllocation {
  readonly contributorId: string;
  readonly shareBp: BasisPoints;
  readonly amountMinor: bigint;
}

/**
 * Validates a share table. Called by the owner-facing service whenever the
 * contributor set of a product is created or edited — never at sale time,
 * where it is already too late to reject bad data.
 */
export function assertSharesValid(shares: readonly ContributorShare[]): void {
  if (shares.length === 0) {
    throw new RuleViolationError('A product must have at least one contributor');
  }

  const seen = new Set<string>();
  let totalBp = 0;

  for (const share of shares) {
    if (seen.has(share.contributorId)) {
      throw new RuleViolationError('A contributor may appear only once on a product', {
        contributorId: share.contributorId,
      });
    }
    seen.add(share.contributorId);

    assertBasisPoints(share.shareBp);
    if (share.shareBp <= 0) {
      throw new RuleViolationError('Each contributor share must be greater than zero', {
        contributorId: share.contributorId,
        shareBp: share.shareBp,
      });
    }
    totalBp += share.shareBp;
  }

  if (totalBp !== 10_000) {
    throw new RuleViolationError('Contributor shares must total exactly 100% (10000 basis points)', {
      totalBp,
      shortfallBp: 10_000 - totalBp,
    });
  }
}

/**
 * Divide the engineer side of a sale among its contributors.
 *
 * Properties guaranteed (all property-tested):
 *   - the allocations always re-sum to exactly `engineerAmount`;
 *   - the result is deterministic for a given input, independent of the
 *     order the shares are supplied in;
 *   - `distribute(-x) === -distribute(x)`, so a refund reversal mirrors the
 *     original sale to the minor unit.
 */
export function distributeEngineerAmount(
  engineerAmount: Money,
  shares: readonly ContributorShare[],
): readonly ContributorAllocation[] {
  assertSharesValid(shares);

  // Work on the magnitude so that negative (reversal) amounts mirror positives
  // exactly rather than rounding in the opposite direction.
  const sign = engineerAmount.amountMinor < 0n ? -1n : 1n;
  const magnitude = sign === -1n ? -engineerAmount.amountMinor : engineerAmount.amountMinor;

  // Deterministic order: largest remainder first, then contributor id.
  // Sorting up front also makes the result independent of input order.
  const ordered = [...shares].sort((a, b) => a.contributorId.localeCompare(b.contributorId));

  const floors = ordered.map((share) => {
    const exactNumerator = magnitude * BigInt(share.shareBp);
    return {
      share,
      floor: exactNumerator / BASIS_POINTS_SCALE,
      remainder: exactNumerator % BASIS_POINTS_SCALE,
    };
  });

  const distributed = floors.reduce((acc, f) => acc + f.floor, 0n);
  let leftover = magnitude - distributed;

  if (leftover < 0n || leftover >= BigInt(ordered.length)) {
    throw new MoneyInvariantError('Largest-remainder leftover out of expected range', {
      leftover: leftover.toString(),
      contributors: ordered.length,
    });
  }

  // Hand the leftover minor units to the largest remainders, one each.
  const byRemainder = [...floors].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.share.contributorId.localeCompare(b.share.contributorId);
  });

  const bonus = new Map<string, bigint>();
  for (const entry of byRemainder) {
    if (leftover === 0n) break;
    bonus.set(entry.share.contributorId, 1n);
    leftover -= 1n;
  }

  const allocations = floors.map((f) => {
    const extra = bonus.get(f.share.contributorId) ?? 0n;
    return Object.freeze({
      contributorId: f.share.contributorId,
      shareBp: f.share.shareBp,
      amountMinor: sign * (f.floor + extra),
    });
  });

  const total = allocations.reduce((acc, a) => acc + a.amountMinor, 0n);
  if (total !== engineerAmount.amountMinor) {
    throw new MoneyInvariantError('Contributor allocations do not re-sum to the engineer amount', {
      expected: engineerAmount.amountMinor.toString(),
      actual: total.toString(),
    });
  }

  return Object.freeze(allocations);
}

/** Convenience wrapper returning `Money` objects rather than raw minor units. */
export function distributeAsMoney(
  engineerAmount: Money,
  shares: readonly ContributorShare[],
): ReadonlyMap<string, Money> {
  const result = new Map<string, Money>();
  for (const allocation of distributeEngineerAmount(engineerAmount, shares)) {
    result.set(allocation.contributorId, money(allocation.amountMinor, engineerAmount.currency));
  }
  return result;
}
