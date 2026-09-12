import { describe, it, expect } from 'vitest';
import { DEFAULT_RETURN_PATH, safeReturnPath } from './return-path';

/**
 * The open-redirect check.
 *
 * Every rejection case below PASSED the original `startsWith('/')` test, which
 * shipped in P1 and survived until the P8 security review. The control
 * characters are written as escapes so this file holds none literally.
 */
describe('safeReturnPath', () => {
  it('accepts a path on this site', () => {
    expect(safeReturnPath('/account')).toBe('/account');
    expect(safeReturnPath('/admin/finance')).toBe('/admin/finance');
    expect(safeReturnPath('/search?q=%D8%AE%D8%B1%D8%B3%D8%A7%D9%86%D8%A9'))
      .toBe('/search?q=%D8%AE%D8%B1%D8%B3%D8%A7%D9%86%D8%A9');
  });

  const attacks: Array<[string, string]> = [
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with a path', '//evil.com/login'],
    ['the backslash variant browsers normalise', '/\\evil.com'],
    ['a backslash anywhere', '/account\\@evil.com'],
    ['an absolute url', 'https://evil.com'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a data url', 'data:text/html,<script>alert(1)</script>'],
    ['a bare host', 'evil.com'],
    ['a tab that splits parsing', '/\tevil.com'],
    ['a newline that could split a header', '/account\nSet-Cookie: x=1'],
    ['a carriage return', '/account\revil'],
    ['a null byte', '/account\u0000'],
    ['empty', ''],
    ['whitespace only', '   '],
  ];

  for (const [label, value] of attacks) {
    it(`refuses ${label}`, () => {
      expect(safeReturnPath(value)).toBe(DEFAULT_RETURN_PATH);
    });
  }

  it('refuses an absurdly long value rather than carrying it', () => {
    expect(safeReturnPath(`/${'a'.repeat(600)}`)).toBe(DEFAULT_RETURN_PATH);
  });

  it('falls back to what the caller asked for', () => {
    expect(safeReturnPath('//evil.com', '/')).toBe('/');
    expect(safeReturnPath(null, '/')).toBe('/');
    expect(safeReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH);
  });
});
