import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts a uuid as PostgreSQL writes one', () => {
    expect(isUuid('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
  });

  it('accepts upper case', () => {
    expect(isUuid('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not an id at all', 'hello'],
    ['a digit short', '0f8fad5b-d9cb-469f-a165-7086772895'],
    ['a digit long', '0f8fad5b-d9cb-469f-a165-70867728950ee'],
    ['no dashes', '0f8fad5bd9cb469fa16570867728950e'],
    ['a non-hex character', '0f8fad5b-d9cb-469f-a165-70867728950g'],
    ['surrounding whitespace', ' 0f8fad5b-d9cb-469f-a165-70867728950e '],
    // Would reach PostgreSQL as a quoted literal either way, but the point of
    // the check is that nothing shaped like an attack gets that far.
    ["a SQL fragment", "0f8fad5b-d9cb-469f-a165-70867728950e' OR '1'='1"],
    ['a path traversal', '../../etc/passwd'],
  ])('refuses %s', (_label, value) => {
    expect(isUuid(value)).toBe(false);
  });

  it.each([null, undefined, 42, {}, []])('refuses the non-string %s', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});
