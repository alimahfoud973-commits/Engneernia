import { describe, expect, it } from 'vitest';
import { extractTax, assertTaxRateBp } from './tax';
import { money } from './money';

const usd = (n: bigint | number) => money(n, 'USD');

describe('rate zero — the state the platform ships in', () => {
  it('takes nothing and leaves the price untouched', () => {
    const r = extractTax(usd(10_000n), 0);
    expect(r.taxMinor).toBe(0n);
    expect(r.netMinor).toBe(10_000n);
    expect(r.grossMinor).toBe(10_000n);
  });

  it('is an exact identity for every amount, so disabling means unchanged', () => {
    for (const amount of [0n, 1n, 7n, 99n, 12_345n, 999_999_999n]) {
      const r = extractTax(usd(amount), 0);
      expect(r.netMinor).toBe(amount);
      expect(r.taxMinor).toBe(0n);
    }
  });
});

describe('extraction from a tax-inclusive price', () => {
  it('takes 15% out of 115.00 and leaves 100.00', () => {
    // The textbook case: 11500 minor units at 1500bp contains exactly 1500.
    const r = extractTax(usd(11_500n), 1500);
    expect(r.taxMinor).toBe(1_500n);
    expect(r.netMinor).toBe(10_000n);
  });

  it('takes 20% out of 120.00 and leaves 100.00', () => {
    const r = extractTax(usd(12_000n), 2000);
    expect(r.taxMinor).toBe(2_000n);
    expect(r.netMinor).toBe(10_000n);
  });

  it('handles a fractional rate', () => {
    // 7.5% of a 10.75 gross: 1075 × 750 / 10750 = 75 exactly.
    const r = extractTax(usd(1_075n), 750);
    expect(r.taxMinor).toBe(75n);
    expect(r.netMinor).toBe(1_000n);
  });
});

describe('the invariant that matters', () => {
  it('always re-adds to what the customer paid, across amounts and rates', () => {
    const rates = [0, 1, 100, 750, 1500, 1700, 2000, 5000, 9999, 10_000];
    for (let amount = 0n; amount <= 2_000n; amount += 1n) {
      for (const rateBp of rates) {
        const r = extractTax(usd(amount), rateBp);
        expect(r.taxMinor + r.netMinor).toBe(amount);
        expect(r.taxMinor).toBeGreaterThanOrEqual(0n);
        expect(r.netMinor).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('never rounds the same division twice', () => {
    /**
     * The failure this guards, reproduced rather than described: computing the
     * net INDEPENDENTLY as gross × 10000/(10000+r) rounds a second time, and
     * the two halves then over-count the total. 3 minor units at 2000bp is the
     * smallest case — found by searching for one, not by assuming where it
     * would be; the first amount I guessed at did not reproduce it at all.
     */
    const gross = 3n;
    const rate = 2000n;
    const denominator = 10_000n + rate;
    const halfAway = (n: bigint) => (n + denominator / 2n) / denominator;

    const naiveTax = halfAway(gross * rate);   // 1
    const naiveNet = halfAway(gross * 10_000n); // 3
    expect(naiveTax + naiveNet).toBe(4n);       // the bug: 4 ≠ 3
    expect(naiveTax + naiveNet).not.toBe(gross);

    // One division, one rounding, and the other side is the remainder.
    const r = extractTax(usd(gross), Number(rate));
    expect(r.taxMinor + r.netMinor).toBe(gross);
  });

  it('rounds the tax, not the net — a half rounds away from zero', () => {
    // 10 × 1500 / 11500 = 1.304…, so the tax is 1 and the net takes the rest.
    const r = extractTax(usd(10n), 1500);
    expect(r.taxMinor).toBe(1n);
    expect(r.netMinor).toBe(9n);
  });
});

describe('what it refuses', () => {
  it('refuses a negative amount', () => {
    expect(() => extractTax(usd(-1n), 1500)).toThrow(/سالب/);
  });

  it('refuses a fractional rate expressed as a percentage by mistake', () => {
    // Somebody writing 15 meaning "15%" gets 0.15% — so non-integers are
    // refused outright and the basis-point convention is stated in the error.
    expect(() => assertTaxRateBp(15.5)).toThrow(/نقاط الأساس/);
  });

  it('refuses a rate outside the range', () => {
    expect(() => assertTaxRateBp(-1)).toThrow();
    expect(() => assertTaxRateBp(10_001)).toThrow();
  });
});
