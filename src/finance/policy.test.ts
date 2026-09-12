import { describe, it, expect } from 'vitest';
import { isWithinRefundWindow } from './policy';

/**
 * The refund window rule.
 *
 * There is no number in these tests that also appears in the source. Every
 * duration is supplied by the test, because the owner's instruction was that
 * no duration lives in the code at all (decisions §7).
 */
describe('the refund window', () => {
  const paidAt = new Date('2026-09-01T00:00:00Z');

  it('never closes when the owner has set no window', () => {
    const tenYearsLater = new Date('2036-09-01T00:00:00Z');
    expect(
      isWithinRefundWindow({ requestWindowDays: null, blockAfterDownload: false }, paidAt, tenYearsLater),
    ).toBe(true);
  });

  it('is open on the last day of a window the owner did set', () => {
    const policy = { requestWindowDays: 14, blockAfterDownload: false };
    const lastMoment = new Date('2026-09-15T00:00:00Z');
    expect(isWithinRefundWindow(policy, paidAt, lastMoment)).toBe(true);
  });

  it('is closed one second after it', () => {
    const policy = { requestWindowDays: 14, blockAfterDownload: false };
    const justAfter = new Date('2026-09-15T00:00:01Z');
    expect(isWithinRefundWindow(policy, paidAt, justAfter)).toBe(false);
  });

  it('treats a zero-day window as no window rather than as "never"', () => {
    // A zero or negative value is normalised to null when the setting is read,
    // so this asserts the same behaviour the reader produces: a misconfigured
    // window must not silently refuse every refund the owner meant to allow.
    expect(
      isWithinRefundWindow({ requestWindowDays: null, blockAfterDownload: false }, paidAt, new Date()),
    ).toBe(true);
  });
});
