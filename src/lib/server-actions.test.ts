import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * "use server" FILES EXPORT ONLY ASYNC FUNCTIONS
 * ===========================================================================
 * Every export of a "use server" module becomes a callable server endpoint, so
 * Next refuses the whole file at RUNTIME if one of them is anything else:
 *
 *   Error: A "use server" file can only export async functions, found object.
 *
 * That is a 500 on the page, not a build failure and not a type error — and
 * it is exactly how the adjustment tool shipped broken: the action file
 * exported an `INITIAL_ADJUSTMENT` constant, the type checker was happy, the
 * build passed, every integration test passed (they call the service
 * directly), and the screen died the first time a browser submitted the form.
 *
 * This catches it in milliseconds, without a browser.
 * ===========================================================================
 */

const DIRECTIVE = /^\s*(['"])use server\1\s*;?/;

function serverActionFiles(): string[] {
  return [...globSync('src/**/*.ts', { cwd: process.cwd() })].filter((file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    return DIRECTIVE.test(source);
  });
}

/**
 * Value exports, ignoring `export type` and `export interface`, which are
 * erased before the module ever runs.
 *
 * Deliberately simple and line-oriented. The first version of this parser was
 * clever, lazy-matched, and silently matched nothing — it passed against a
 * file that really did export an object. Verified by reintroducing the exact
 * export that caused the outage and checking that this fails.
 */
function valueExports(source: string): Array<{ name: string; isAsyncFn: boolean }> {
  const results: Array<{ name: string; isAsyncFn: boolean }> = [];

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('export')) continue;
    if (/^export\s+(type|interface)\b/.test(line)) continue;

    const declared =
      /^export\s+(async\s+)?(function|const|let|var|class|enum)\s+(\w+)/.exec(line);
    if (declared) {
      const isFunction = declared[2] === 'function';
      results.push({ name: declared[3]!, isAsyncFn: isFunction && declared[1] !== undefined });
      continue;
    }

    // `export { a, b }` and `export * from …` re-export values this module
    // does not declare, and a re-exported constant breaks the file just as
    // surely as a declared one.
    if (/^export\s*\{/.test(line) && !/^export\s*\{\s*type\b/.test(line)) {
      const names = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
      for (const part of names.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name && name !== 'type') results.push({ name, isAsyncFn: false });
      }
      continue;
    }

    if (/^export\s+\*/.test(line) || /^export\s+default\b/.test(line)) {
      results.push({ name: line, isAsyncFn: false });
    }
  }

  return results;
}

describe('server action modules', () => {
  const files = serverActionFiles();

  it('finds the action files at all', () => {
    // If this ever hits zero the rest of the suite passes vacuously.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} exports only async functions`, () => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      const offenders = valueExports(source)
        .filter((exported) => !exported.isAsyncFn)
        .map((exported) => exported.name);

      expect(
        offenders,
        `${file} exports ${offenders.join(', ')} — a "use server" file may export only async `
        + 'functions, and Next fails the page at runtime otherwise. Move constants elsewhere.',
      ).toEqual([]);
    });
  }
});
