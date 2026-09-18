import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * EVERY `pattern` ATTRIBUTE MUST COMPILE THE WAY A BROWSER COMPILES IT
 * ===========================================================================
 *
 * The defect this guards against, found by opening the page and reading the
 * console — nothing else saw it:
 *
 *   <input pattern="[A-Z0-9][A-Z0-9-]{1,23}" />
 *
 *   TypeScript is happy (it is a string), ESLint is happy, every test passed,
 *   and the field renders. But HTML compiles `pattern` with the UNICODE SETS
 *   flag `v`, where an unescaped `-` in that position is a syntax error. The
 *   browser then logs a warning and IGNORES THE ATTRIBUTE ENTIRELY — so the
 *   validation the author wrote simply does not run, and the field accepts
 *   anything. A validation that silently does not exist is worse than none,
 *   because the author stops thinking about it.
 *
 * The server still validates — `addEngineer` re-checks with its own regex, and
 * always would, because a pattern attribute is a courtesy to the typist and
 * never a control. This test keeps the courtesy working.
 * ===========================================================================
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const PATTERN_ATTRIBUTE = /pattern="([^"]+)"/g;

describe('HTML pattern attributes', () => {
  const files = walk('src');

  it('finds the attributes it claims to be checking', () => {
    const found = files.flatMap((file) => [
      ...readFileSync(file, 'utf8').matchAll(PATTERN_ATTRIBUTE),
    ]);
    // A guard that matches nothing passes forever. It must see real ones.
    expect(found.length).toBeGreaterThan(0);
  });

  it('every one of them compiles under the `v` flag, as a browser does', () => {
    const broken: string[] = [];

    for (const file of files) {
      for (const [, source] of readFileSync(file, 'utf8').matchAll(PATTERN_ATTRIBUTE)) {
        try {
          // The browser anchors it, which does not change whether it PARSES.
          new RegExp(source!, 'v');
        } catch (error) {
          broken.push(`${file}: ${source} — ${(error as Error).message}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
