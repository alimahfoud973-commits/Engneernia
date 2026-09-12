import { ValidationError } from '@/lib/errors';

/**
 * ===========================================================================
 * ACCOUNTING PERIODS (decisions §8)
 * ===========================================================================
 * Every sale date, month close, report boundary and monthly settlement is
 * computed in the platform accounting timezone — Asia/Damascus — while every
 * timestamp is STORED in UTC.
 *
 * This distinction matters: a sale at 23:30 on 30 September Damascus time is
 * 20:30 UTC the same day, but a sale at 00:30 on 1 October Damascus time is
 * 21:30 UTC on 30 September. Treating UTC as the boundary would put that
 * second sale in the wrong month and in the wrong contributor settlement.
 *
 * The offset is derived from the IANA database via Intl rather than hard-coded,
 * so historical dates (Syria observed DST until 2022) resolve correctly and no
 * future rule change requires a code edit.
 * ===========================================================================
 */

export const PLATFORM_TIMEZONE = 'Asia/Damascus';

/** A calendar month in the accounting timezone, e.g. "2026-09". */
export type PeriodKey = string;

const PERIOD_KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const MONTH_ABBREVIATIONS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zonedPartsOf(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new ValidationError('Unable to resolve timezone parts', { type, timeZone });
    // Intl renders midnight as hour "24" in some engines; normalise it.
    const value = Number(found.value);
    return type === 'hour' && value === 24 ? 0 : value;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset in milliseconds of `timeZone` at a given instant (east of UTC positive). */
function offsetMsAt(instant: Date, timeZone: string): number {
  const p = zonedPartsOf(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

/**
 * Convert a wall-clock time in `timeZone` to the UTC instant it denotes.
 * The two-pass correction handles the case where the first guess lands on the
 * other side of a DST transition.
 */
export function zonedWallTimeToUtc(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string = PLATFORM_TIMEZONE,
): Date {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const firstOffset = offsetMsAt(new Date(guess), timeZone);
  const firstPass = guess - firstOffset;
  const secondOffset = offsetMsAt(new Date(firstPass), timeZone);
  return new Date(secondOffset === firstOffset ? firstPass : guess - secondOffset);
}

/** The accounting period a given instant falls into. */
export function periodKeyOf(instant: Date, timeZone: string = PLATFORM_TIMEZONE): PeriodKey {
  const { year, month } = zonedPartsOf(instant, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function parsePeriodKey(key: PeriodKey): { year: number; month: number } {
  const match = PERIOD_KEY_PATTERN.exec(key);
  if (!match) {
    throw new ValidationError('Period key must be formatted as YYYY-MM', { key });
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

/**
 * UTC instants bounding an accounting period.
 * The end is EXCLUSIVE — queries use `sold_at >= start AND sold_at < end`,
 * which cannot double-count or drop a sale on the boundary second.
 */
export function periodBounds(
  key: PeriodKey,
  timeZone: string = PLATFORM_TIMEZONE,
): { readonly startUtc: Date; readonly endUtcExclusive: Date } {
  const { year, month } = parsePeriodKey(key);
  const startUtc = zonedWallTimeToUtc({ year, month, day: 1 }, timeZone);
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const endUtcExclusive = zonedWallTimeToUtc({ ...nextMonth, day: 1 }, timeZone);
  return Object.freeze({ startUtc, endUtcExclusive });
}

export function previousPeriodKey(key: PeriodKey): PeriodKey {
  const { year, month } = parsePeriodKey(key);
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function nextPeriodKey(key: PeriodKey): PeriodKey {
  const { year, month } = parsePeriodKey(key);
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** True once the period has fully elapsed and may be settled (decisions §8). */
export function isPeriodClosed(
  key: PeriodKey,
  now: Date = new Date(),
  timeZone: string = PLATFORM_TIMEZONE,
): boolean {
  return now.getTime() >= periodBounds(key, timeZone).endUtcExclusive.getTime();
}

/**
 * Human-facing settlement reference, e.g. "SEP-2026-CIVIL" (specification §16).
 * `contributorCode` is the contributor's stable short code, uppercased.
 */
export function settlementReference(key: PeriodKey, contributorCode: string): string {
  const { year, month } = parsePeriodKey(key);
  const abbreviation = MONTH_ABBREVIATIONS[month - 1];
  const code = contributorCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (code.length === 0) {
    throw new ValidationError('Contributor code cannot be empty', { contributorCode });
  }
  return `${abbreviation}-${year}-${code}`;
}
