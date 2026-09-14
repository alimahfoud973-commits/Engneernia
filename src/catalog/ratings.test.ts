import { describe, expect, it } from 'vitest';
import { ratingCountLabel } from './ratings';

/**
 * The counted noun in Arabic changes with the number. A template that appends
 * one fixed word — "(1 تقييماً)" — is correct for exactly one case out of four,
 * and it was on the product page.
 */
describe('ratingCountLabel', () => {
  it.each([
    [1, 'تقييم واحد'],
    [2, 'تقييمان'],
    [3, '3 تقييمات'],
    [10, '10 تقييمات'],
    [11, '11 تقييماً'],
    [100, '100 تقييماً'],
  ])('%i reads as "%s"', (count, expected) => {
    expect(ratingCountLabel(count)).toBe(expected);
  });

  it('never appends the 11-and-up form to one or two', () => {
    // The specific defect: one word for every number.
    expect(ratingCountLabel(1)).not.toContain('تقييماً');
    expect(ratingCountLabel(2)).not.toContain('تقييماً');
  });
});
