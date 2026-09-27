import { describe, it, expect } from 'vitest';
import { isProviderRefTaken, normalizeProviderRef } from './provider-ref';

describe('normalizeProviderRef — the optional bank reference (W13)', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['   ', null],
    ['\t\n ', null],
    [' ABC123 ', 'ABC123'],
    ['ABC123', 'ABC123'],
    ['abc123', 'abc123'],
    ['  حوالة 55  ', 'حوالة 55'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeProviderRef(input)).toBe(expected);
  });

  it('keeps letter case: ABC123 and abc123 stay two references', () => {
    expect(normalizeProviderRef('ABC123')).not.toBe(normalizeProviderRef('abc123'));
  });
});

describe('isProviderRefTaken — names only the reference index', () => {
  it('recognises 23505 on payments_provider_ref_unique, wrapped by drizzle or not', () => {
    const pg = { code: '23505', constraint_name: 'payments_provider_ref_unique' };
    expect(isProviderRefTaken(pg)).toBe(true);
    expect(isProviderRefTaken(Object.assign(new Error('Failed query'), { cause: pg }))).toBe(true);
  });

  it('ignores any other unique violation or error', () => {
    expect(isProviderRefTaken({ code: '23505', constraint_name: 'payments_idempotency_unique' })).toBe(false);
    expect(isProviderRefTaken({ code: '23503', constraint_name: 'payments_provider_ref_unique' })).toBe(false);
    expect(isProviderRefTaken(new Error('boom'))).toBe(false);
    expect(isProviderRefTaken(undefined)).toBe(false);
  });
});
