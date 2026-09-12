import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  add,
  compare,
  divRoundHalfAwayFromZero,
  formatMoney,
  money,
  parseMajorUnits,
  percentOf,
  subtract,
  sum,
  zero,
} from './money';
import { MoneyInvariantError, ValidationError } from '@/lib/errors';

describe('money construction', () => {
  it('accepts integer minor units', () => {
    expect(money(1000n, 'USD').amountMinor).toBe(1000n);
    expect(money(1000, 'USD').amountMinor).toBe(1000n);
  });

  it('rejects an unknown currency', () => {
    expect(() => money(100n, 'XYZ')).toThrow(ValidationError);
  });

  it('rejects a malformed currency code', () => {
    expect(() => money(100n, 'usd')).toThrow(ValidationError);
  });

  it('rejects a non-integer numeric amount', () => {
    expect(() => money(10.5, 'USD')).toThrow(ValidationError);
  });

  it('is frozen', () => {
    const m = money(500n, 'USD');
    expect(Object.isFrozen(m)).toBe(true);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(add(money(1000n, 'USD'), money(500n, 'USD')).amountMinor).toBe(1500n);
    expect(subtract(money(1000n, 'USD'), money(500n, 'USD')).amountMinor).toBe(500n);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100n, 'USD'), money(100n, 'EUR'))).toThrow(MoneyInvariantError);
  });

  it('sums an empty list to zero', () => {
    expect(sum([], 'USD')).toEqual(zero('USD'));
  });

  it('orders amounts', () => {
    expect(compare(money(1n, 'USD'), money(2n, 'USD'))).toBe(-1);
    expect(compare(money(2n, 'USD'), money(2n, 'USD'))).toBe(0);
    expect(compare(money(3n, 'USD'), money(2n, 'USD'))).toBe(1);
  });
});

describe('divRoundHalfAwayFromZero', () => {
  it('rounds halves away from zero', () => {
    expect(divRoundHalfAwayFromZero(5n, 10n)).toBe(1n);
    expect(divRoundHalfAwayFromZero(-5n, 10n)).toBe(-1n);
    expect(divRoundHalfAwayFromZero(4n, 10n)).toBe(0n);
    expect(divRoundHalfAwayFromZero(-4n, 10n)).toBe(0n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => divRoundHalfAwayFromZero(1n, 0n)).toThrow(MoneyInvariantError);
  });

  it('is symmetric under negation for every input', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.bigInt({ min: 1n, max: 100_000n }),
        (n, d) => {
          expect(divRoundHalfAwayFromZero(-n, d)).toBe(-divRoundHalfAwayFromZero(n, d));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('percentOf', () => {
  it('matches the specification worked examples', () => {
    // §11: $10 at 90% engineer => platform takes 10% = $1
    expect(percentOf(money(1000n, 'USD'), 1000).amountMinor).toBe(100n);
    // §11: $20 at 80% engineer => platform takes 20% = $4
    expect(percentOf(money(2000n, 'USD'), 2000).amountMinor).toBe(400n);
  });

  it('rejects out-of-range basis points', () => {
    expect(() => percentOf(money(100n, 'USD'), 10_001)).toThrow(ValidationError);
    expect(() => percentOf(money(100n, 'USD'), -1)).toThrow(ValidationError);
    expect(() => percentOf(money(100n, 'USD'), 12.5)).toThrow(ValidationError);
  });

  it('never exceeds the source amount', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (amount, bp) => {
          const result = percentOf(money(amount, 'USD'), bp);
          expect(result.amountMinor).toBeGreaterThanOrEqual(0n);
          expect(result.amountMinor).toBeLessThanOrEqual(amount);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('parseMajorUnits', () => {
  it('parses plain decimals', () => {
    expect(parseMajorUnits('10.50', 'USD').amountMinor).toBe(1050n);
    expect(parseMajorUnits('10', 'USD').amountMinor).toBe(1000n);
    expect(parseMajorUnits('0.05', 'USD').amountMinor).toBe(5n);
    expect(parseMajorUnits('-3.25', 'USD').amountMinor).toBe(-325n);
  });

  it('rejects excess precision rather than silently rounding it away', () => {
    expect(() => parseMajorUnits('10.555', 'USD')).toThrow(ValidationError);
  });

  it('rejects non-numeric input', () => {
    expect(() => parseMajorUnits('ten dollars', 'USD')).toThrow(ValidationError);
    expect(() => parseMajorUnits('1e5', 'USD')).toThrow(ValidationError);
  });

  it('round-trips through formatting for any representable amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 99_999_999n }), (minor) => {
        const original = money(minor, 'USD');
        const major = formatMoney(original, 'en', { withSymbol: false }).replace(/,/g, '');
        expect(parseMajorUnits(major, 'USD').amountMinor).toBe(original.amountMinor);
      }),
      { numRuns: 300 },
    );
  });
});
