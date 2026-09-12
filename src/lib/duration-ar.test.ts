import { describe, expect, it } from 'vitest';
import { waitLabelAr } from './duration-ar';

describe('waitLabelAr', () => {
  it.each([
    [1, 'ثانية واحدة'],
    [2, 'ثانيتين'],
    [5, '5 ثوانٍ'],
    [10, '10 ثوانٍ'],
    [11, '11 ثانية'],
    [59, '59 ثانية'],
  ])('says %i seconds as %s', (seconds, expected) => {
    expect(waitLabelAr(seconds)).toBe(expected);
  });

  it.each([
    [60, 'دقيقة واحدة'],
    [61, 'دقيقتين'],
    [120, 'دقيقتين'],
    [300, '5 دقائق'],
    [600, '10 دقائق'],
    [601, '11 دقيقة'],
    [900, '15 دقيقة'],
  ])('says %i seconds as %s', (seconds, expected) => {
    expect(waitLabelAr(seconds)).toBe(expected);
  });

  it('rounds up rather than down, so nobody is told to return too early', () => {
    expect(waitLabelAr(301)).toBe('6 دقائق');
    expect(waitLabelAr(0.2)).toBe('ثانية واحدة');
  });

  it('never says zero or a negative wait', () => {
    expect(waitLabelAr(0)).toBe('ثانية واحدة');
    expect(waitLabelAr(-30)).toBe('ثانية واحدة');
  });
});
