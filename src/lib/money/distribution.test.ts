import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { assertSharesValid, distributeEngineerAmount, distributeAsMoney } from './distribution';
import { money } from './money';
import { RuleViolationError } from '@/lib/errors';

const usd = (minor: bigint) => money(minor, 'USD');
const total = (allocations: readonly { amountMinor: bigint }[]) =>
  allocations.reduce((acc, a) => acc + a.amountMinor, 0n);

describe('share validation — decisions §6', () => {
  it('accepts shares totalling exactly 100%', () => {
    expect(() =>
      assertSharesValid([
        { contributorId: 'a', shareBp: 6000 },
        { contributorId: 'b', shareBp: 4000 },
      ]),
    ).not.toThrow();
  });

  it('rejects shares that do not total 100%', () => {
    expect(() =>
      assertSharesValid([
        { contributorId: 'a', shareBp: 6000 },
        { contributorId: 'b', shareBp: 3000 },
      ]),
    ).toThrow(RuleViolationError);
  });

  it('rejects an empty contributor set', () => {
    expect(() => assertSharesValid([])).toThrow(RuleViolationError);
  });

  it('rejects a duplicated contributor', () => {
    expect(() =>
      assertSharesValid([
        { contributorId: 'a', shareBp: 5000 },
        { contributorId: 'a', shareBp: 5000 },
      ]),
    ).toThrow(RuleViolationError);
  });

  it('rejects a zero share', () => {
    expect(() =>
      assertSharesValid([
        { contributorId: 'a', shareBp: 10_000 },
        { contributorId: 'b', shareBp: 0 },
      ]),
    ).toThrow(RuleViolationError);
  });
});

describe('distribution', () => {
  it('splits evenly when it divides cleanly', () => {
    const result = distributeEngineerAmount(usd(1000n), [
      { contributorId: 'a', shareBp: 5000 },
      { contributorId: 'b', shareBp: 5000 },
    ]);
    expect(result.map((r) => r.amountMinor)).toEqual([500n, 500n]);
  });

  it('gives the indivisible remainder to the largest fractional share', () => {
    // 100 minor units split three ways: 33.33 / 33.33 / 33.33 -> one unit spare
    const result = distributeEngineerAmount(usd(100n), [
      { contributorId: 'a', shareBp: 3333 },
      { contributorId: 'b', shareBp: 3333 },
      { contributorId: 'c', shareBp: 3334 },
    ]);
    expect(total(result)).toBe(100n);
    const byId = Object.fromEntries(result.map((r) => [r.contributorId, r.amountMinor]));
    expect(byId['c']).toBe(34n);
  });

  it('is independent of the order shares are supplied in', () => {
    const shares = [
      { contributorId: 'zed', shareBp: 3333 },
      { contributorId: 'amy', shareBp: 3333 },
      { contributorId: 'bob', shareBp: 3334 },
    ];
    const forward = distributeEngineerAmount(usd(1001n), shares);
    const reversed = distributeEngineerAmount(usd(1001n), [...shares].reverse());
    expect(forward).toEqual(reversed);
  });

  it('mirrors exactly for a reversal (refund)', () => {
    const shares = [
      { contributorId: 'a', shareBp: 3333 },
      { contributorId: 'b', shareBp: 3333 },
      { contributorId: 'c', shareBp: 3334 },
    ];
    const sale = distributeEngineerAmount(usd(1007n), shares);
    const refund = distributeEngineerAmount(usd(-1007n), shares);
    for (const [i, allocation] of sale.entries()) {
      expect(refund[i]?.amountMinor).toBe(-allocation.amountMinor);
    }
    expect(total(sale) + total(refund)).toBe(0n);
  });

  it('returns Money objects carrying the source currency', () => {
    const map = distributeAsMoney(usd(1000n), [
      { contributorId: 'a', shareBp: 7000 },
      { contributorId: 'b', shareBp: 3000 },
    ]);
    expect(map.get('a')).toEqual(money(700n, 'USD'));
    expect(map.get('b')?.currency).toBe('USD');
  });
});

describe('distribution invariants', () => {
  /** Generates a share table that always totals exactly 10000 basis points. */
  const sharesArb = fc
    .array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 8 })
    .map((weights) => {
      const weightTotal = weights.reduce((a, b) => a + b, 0);
      const shares = weights.map((w, i) => ({
        contributorId: `c${String(i).padStart(2, '0')}`,
        shareBp: Math.max(1, Math.floor((w / weightTotal) * 10_000)),
      }));
      const assigned = shares.reduce((a, s) => a + s.shareBp, 0);
      const first = shares[0];
      if (first) first.shareBp += 10_000 - assigned;
      return shares.filter((s) => s.shareBp > 0);
    })
    .filter((shares) => shares.reduce((a, s) => a + s.shareBp, 0) === 10_000);

  it('allocations always re-sum to the engineer amount, for any amount and any split', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000_000_000n }), sharesArb, (amount, shares) => {
        const result = distributeEngineerAmount(usd(amount), shares);
        expect(total(result)).toBe(amount);
      }),
      { numRuns: 2000 },
    );
  });

  it('never allocates a negative amount from a positive total', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), sharesArb, (amount, shares) => {
        for (const allocation of distributeEngineerAmount(usd(amount), shares)) {
          expect(allocation.amountMinor).toBeGreaterThanOrEqual(0n);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('no contributor is ever more than one minor unit from their exact share', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10_000_000n }), sharesArb, (amount, shares) => {
        for (const allocation of distributeEngineerAmount(usd(amount), shares)) {
          const exact = (amount * BigInt(allocation.shareBp)) / 10_000n;
          const drift = allocation.amountMinor - exact;
          expect(drift >= -1n && drift <= 1n).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
