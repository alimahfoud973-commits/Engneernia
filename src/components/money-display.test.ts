import { describe, it, expect } from 'vitest';
import { formatMinor, isolateAmount } from './money-display';
import { formatPrice } from './product-card';

/**
 * S5-10: an amount inside an Arabic sentence read "$US 25.59". The formatted
 * text was right; the bidirectional algorithm pulled it apart because it was
 * not isolated from the right-to-left text around it.
 */
const LRI = '⁦';
const PDI = '⁩';

describe('amounts are isolated from the text around them (S5-10)', () => {
  it('wraps the amount in a left-to-right isolate, with no stray direction marks inside', () => {
    const shown = formatMinor(2559n, 'USD');
    expect(shown.startsWith(LRI)).toBe(true);
    expect(shown.endsWith(PDI)).toBe(true);
    expect(shown).not.toMatch(/[‎‏؜]/);
    // The digits and the symbol are Intl's own, in Intl's own order (with its
    // no-break space between them).
    expect(shown.slice(1, -1)).toBe('25.59\u00a0US$');
  });

  it('keeps the sign inside the isolate, so a negative balance cannot lose its minus', () => {
    const shown = formatMinor(-2559n, 'USD');
    expect(shown).toBe(`${LRI}−25.59\u00a0US$${PDI}`);
  });

  it('isolates catalogue prices the same way, so every amount on the site reads alike', () => {
    expect(formatPrice('2559', 'USD', false)).toBe(formatMinor(2559n, 'USD'));
    expect(formatPrice('0', 'USD', true)).toBe('مجاني');
  });

  it('is idempotent on marks it removes', () => {
    expect(isolateAmount('‏25.59 US$')).toBe(`${LRI}25.59 US$${PDI}`);
  });
});
