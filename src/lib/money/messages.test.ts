import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMajorUnits } from './money';
import { ValidationError } from '@/lib/errors';
import { toUserMessage } from '@/lib/action-errors';

/**
 * ===========================================================================
 * THE MONEY LAYER EXPLAINS ITSELF IN ARABIC (Stage 3, W8)
 * ===========================================================================
 * `toUserMessage` shows any error below 500 exactly as written, so a
 * `ValidationError` or `RuleViolationError` raised here is a sentence the owner
 * reads — on the price, commission, adjustment and credits forms. They were
 * written in English: "Amount must be a plain decimal number".
 *
 * `MoneyInvariantError` is deliberately left alone: it is a 500, the owner is
 * shown a generic sentence, and its text is for the server log.
 * ===========================================================================
 */

const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

const shown = (fn: () => unknown): string => {
  try {
    fn();
    return '';
  } catch (error) {
    return toUserMessage(error, 'money messages test');
  }
};

describe('W8 — what an owner reads for a mistyped amount', () => {
  it.each([
    ['ten dollars', 'not a number'],
    ['1e5', 'scientific notation'],
    ['', 'empty'],
    ['10.555', 'three decimals'],
  ])('"%s" (%s) is refused, in Arabic', (input) => {
    expect(() => parseMajorUnits(input, 'USD')).toThrow(ValidationError);
    const message = shown(() => parseMajorUnits(input, 'USD'));
    expect(message).toMatch(ARABIC);
    expect(message).not.toMatch(LATIN_WORD);
  });

  it('names the limit in words an owner uses', () => {
    expect(shown(() => parseMajorUnits('10.555', 'USD'))).toContain('خانتين عشريتين');
  });

  it('the valid amounts it parsed before, it still parses', () => {
    expect(parseMajorUnits('35.00', 'USD').amountMinor).toBe(3500n);
    expect(parseMajorUnits('35٫25', 'USD').amountMinor).toBe(3525n);
    expect(parseMajorUnits('1,250.50', 'USD').amountMinor).toBe(125050n);
  });
});

describe('W8 — no user-facing message in src/lib/money is written in English', () => {
  const files = [...globSync('src/lib/money/*.ts', { cwd: process.cwd() })]
    .filter((f) => !f.endsWith('.test.ts'))
    .sort();

  it('found the money modules', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files)('%s', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const messages = [...source.matchAll(/new (ValidationError|RuleViolationError)\(\s*(['`])([\s\S]*?)\2/g)]
      .map((m) => m[3]!.replace(/\$\{[^}]*\}/g, ''));
    for (const message of messages) {
      expect(message, message).toMatch(ARABIC);
      expect(message, message).not.toMatch(LATIN_WORD);
    }
  });
});
