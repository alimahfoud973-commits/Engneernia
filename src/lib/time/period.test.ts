import { describe, it, expect } from 'vitest';
import {
  PLATFORM_TIMEZONE,
  isPeriodClosed,
  nextPeriodKey,
  parsePeriodKey,
  periodBounds,
  periodKeyOf,
  previousPeriodKey,
  settlementReference,
  zonedWallTimeToUtc,
} from './period';
import { ValidationError } from '@/lib/errors';

describe('timezone availability', () => {
  it('has full ICU data for the accounting timezone', () => {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: PLATFORM_TIMEZONE,
      timeZoneName: 'short',
    }).format(new Date('2026-09-15T12:00:00Z'));
    expect(formatted).toMatch(/GMT|\+/);
  });
});

/**
 * THE BOUNDARY TEST — decisions §8.
 * Syria is UTC+3. A sale just before midnight Damascus time on the last day of
 * the month belongs to that month; a sale just after belongs to the next.
 * Using UTC boundaries instead would misfile both.
 */
describe('period boundaries in Asia/Damascus', () => {
  it('places a sale at 23:30 on 30 September Damascus time in September', () => {
    const instant = zonedWallTimeToUtc({ year: 2026, month: 9, day: 30, hour: 23, minute: 30 });
    expect(periodKeyOf(instant)).toBe('2026-09');
  });

  it('places a sale at 00:30 on 1 October Damascus time in October', () => {
    const instant = zonedWallTimeToUtc({ year: 2026, month: 10, day: 1, hour: 0, minute: 30 });
    expect(periodKeyOf(instant)).toBe('2026-10');
    // ...even though that same instant is still 30 September in UTC.
    expect(instant.toISOString().startsWith('2026-09-30')).toBe(true);
  });

  it('produces contiguous, non-overlapping bounds', () => {
    const september = periodBounds('2026-09');
    const october = periodBounds('2026-10');
    expect(september.endUtcExclusive.getTime()).toBe(october.startUtc.getTime());
  });

  it('bounds September 2026 correctly against UTC', () => {
    const { startUtc, endUtcExclusive } = periodBounds('2026-09');
    // Damascus is UTC+3, so local midnight is 21:00 UTC the previous day.
    expect(startUtc.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(endUtcExclusive.toISOString()).toBe('2026-09-30T21:00:00.000Z');
  });

  it('handles the December to January rollover', () => {
    const december = periodBounds('2026-12');
    const january = periodBounds('2027-01');
    expect(december.endUtcExclusive.getTime()).toBe(january.startUtc.getTime());
  });

  it('classifies every instant inside the bounds into that period', () => {
    const key = '2026-09';
    const { startUtc, endUtcExclusive } = periodBounds(key);
    expect(periodKeyOf(startUtc)).toBe(key);
    expect(periodKeyOf(new Date(endUtcExclusive.getTime() - 1))).toBe(key);
    expect(periodKeyOf(endUtcExclusive)).toBe('2026-10');
  });

  it('resolves correctly for a historical date when Syria still observed DST', () => {
    // Syria abolished DST in October 2022. Before that, summer was UTC+3 and
    // winter UTC+2. The offset is read from the IANA database, not assumed.
    const januaryBounds = periodBounds('2021-01');
    const julyBounds = periodBounds('2021-07');
    expect(januaryBounds.startUtc.toISOString()).toBe('2020-12-31T22:00:00.000Z');
    expect(julyBounds.startUtc.toISOString()).toBe('2021-06-30T21:00:00.000Z');
  });
});

describe('period key arithmetic', () => {
  it('parses valid keys', () => {
    expect(parsePeriodKey('2026-09')).toEqual({ year: 2026, month: 9 });
  });

  it('rejects malformed keys', () => {
    expect(() => parsePeriodKey('2026-13')).toThrow(ValidationError);
    expect(() => parsePeriodKey('2026-00')).toThrow(ValidationError);
    expect(() => parsePeriodKey('26-09')).toThrow(ValidationError);
    expect(() => parsePeriodKey('September 2026')).toThrow(ValidationError);
  });

  it('steps backwards and forwards across year boundaries', () => {
    expect(previousPeriodKey('2026-01')).toBe('2025-12');
    expect(nextPeriodKey('2026-12')).toBe('2027-01');
    expect(previousPeriodKey('2026-10')).toBe('2026-09');
    expect(nextPeriodKey('2026-09')).toBe('2026-10');
  });

  it('round-trips in both directions', () => {
    let key = '2024-01';
    for (let i = 0; i < 36; i += 1) key = nextPeriodKey(key);
    for (let i = 0; i < 36; i += 1) key = previousPeriodKey(key);
    expect(key).toBe('2024-01');
  });
});

describe('period closure — settlement runs on the 1st of the following month', () => {
  it('is not closed during the period', () => {
    const during = zonedWallTimeToUtc({ year: 2026, month: 9, day: 30, hour: 23, minute: 59 });
    expect(isPeriodClosed('2026-09', during)).toBe(false);
  });

  it('is closed at the first instant of the next period', () => {
    const after = zonedWallTimeToUtc({ year: 2026, month: 10, day: 1, hour: 0, minute: 0 });
    expect(isPeriodClosed('2026-09', after)).toBe(true);
  });
});

describe('settlement reference — specification §16', () => {
  it('produces the documented format', () => {
    expect(settlementReference('2026-09', 'CIVIL')).toBe('SEP-2026-CIVIL');
  });

  it('normalises contributor codes', () => {
    expect(settlementReference('2026-01', 'civil eng')).toBe('JAN-2026-CIVIL-ENG');
    expect(settlementReference('2026-12', '  mech  ')).toBe('DEC-2026-MECH');
  });

  it('rejects an empty contributor code', () => {
    expect(() => settlementReference('2026-09', '   ')).toThrow(ValidationError);
  });
});
