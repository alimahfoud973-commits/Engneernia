import { describe, it, expect } from 'vitest';
import { parseUpgradeDiscountBp } from './version-policy';
import { RuleViolationError } from '@/lib/errors';

describe('parseUpgradeDiscountBp (S4-09)', () => {
  it('accepts whole basis points 0..10000', () => {
    expect(parseUpgradeDiscountBp(5000)).toBe(5000);
    expect(parseUpgradeDiscountBp(0)).toBe(0);
    expect(parseUpgradeDiscountBp(10_000)).toBe(10_000);
  });

  it('refuses anything else rather than guess a price', () => {
    for (const bad of [undefined, null, '5000', 50.5, -1, 10_001, Number.NaN]) {
      expect(() => parseUpgradeDiscountBp(bad), String(bad)).toThrow(RuleViolationError);
    }
  });
});
