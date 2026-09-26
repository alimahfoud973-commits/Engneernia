import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * ===========================================================================
 * THE 404 AND ERROR PAGES ARE OURS, AND THEY STAND ON THEIR OWN (D1)
 * ===========================================================================
 * With no `not-found.tsx`, `error.tsx` or `global-error.tsx`, every 404 and
 * every unhandled error fell through to Next's built-in pages: English, no
 * `lang` or `dir`, none of the site's styling, and — for an unmatched address
 * like `/a/b/c` — a prerendered file whose scripts the CSP blocked.
 *
 * Two properties are checked here, from the source, in milliseconds:
 *
 *   1. The files exist in the places Next looks, with the shape Next needs
 *      (error boundaries are client components; the two pages that render
 *      their own document declare Arabic and right-to-left).
 *   2. None of them can reach the database, the settings, the session or the
 *      site header — through ANY import chain. An error page that queries is
 *      an error page that fails with the database it is reporting on.
 *
 * What is actually SERVED — statuses, content, CSP, overflow, the database
 * being down — is checked against a production build (see
 * docs/PROJECT_STATE.md, D1).
 * ===========================================================================
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const PAGES = {
  rootLayout: 'src/app/layout.tsx',
  rootNotFound: 'src/app/not-found.tsx',
  localeNotFound: 'src/app/[locale]/not-found.tsx',
  localeError: 'src/app/[locale]/error.tsx',
  globalError: 'src/app/global-error.tsx',
} as const;

/** Anything that would make a page depend on a working database or session. */
const FORBIDDEN = [
  /^@\/db(\/|$)/,
  /^@\/platform\//,
  /^@\/auth\//,
  /^@\/components\/site-chrome$/,
  /^@\/notifications\//,
  /^next\/headers$/,
  /^next-intl\/server$/,
];

function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

/** Resolves `@/x` and `./x` to a file in the repository, or null for a package. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(join(ROOT, fromFile)), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && !candidate.endsWith('.css')) return candidate.slice(ROOT.length + 1);
  }
  return null;
}

/** Every module specifier reachable from `file` through the repository's own code. */
function reachableImports(file: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>();
  if (seen.has(file)) return found;
  seen.add(file);
  for (const specifier of importsOf(read(file))) {
    found.add(specifier);
    const local = resolveLocal(specifier, file);
    if (local) for (const deeper of reachableImports(local, seen)) found.add(deeper);
  }
  return found;
}

describe('D1 — the files Next looks for exist', () => {
  it.each(Object.entries(PAGES))('%s: %s', (_name, file) => {
    expect(existsSync(join(ROOT, file))).toBe(true);
  });

  it('the root layout renders nothing of its own, so no existing page changes', () => {
    const source = read(PAGES.rootLayout).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).toMatch(/return children;/);
    expect(source).not.toMatch(/<html|<body/);
  });

  it('the error boundaries are client components', () => {
    for (const file of [PAGES.localeError, PAGES.globalError, 'src/components/error-content.tsx']) {
      expect(read(file).trimStart().startsWith("'use client'"), file).toBe(true);
    }
  });

  it('the pages that render their own document declare Arabic, right-to-left, the stylesheet and the fonts', () => {
    for (const file of [PAGES.rootNotFound, PAGES.globalError]) {
      const source = read(file);
      expect(source, file).toMatch(/<html lang="ar" dir="rtl">/);
      expect(source, file).toMatch(/import '\.\/globals\.css';/);
      expect(source, file).toMatch(/className=\{fontVariables\}/);
    }
  });

  it('the root 404 renders per request, so the CSP nonce reaches its scripts', () => {
    expect(read(PAGES.rootNotFound)).toMatch(/await connection\(\);/);
  });

  it('both 404 pages render the same content, and both error pages too', () => {
    expect(read(PAGES.rootNotFound)).toMatch(/<NotFoundContent \/>/);
    expect(read(PAGES.localeNotFound)).toMatch(/<NotFoundContent \/>/);
    expect(read(PAGES.localeError)).toMatch(/<ErrorContent retry=\{retry\} \/>/);
    expect(read(PAGES.globalError)).toMatch(/<ErrorContent retry=\{retry\} \/>/);
  });

  it('the error pages offer a retry and a way home, and print nothing about the error', () => {
    const content = read('src/components/error-content.tsx');
    expect(content).toMatch(/onClick=\{\(\) => retry\(\)\}/);
    expect(content).toMatch(/href="\/"/);
    for (const file of [PAGES.localeError, PAGES.globalError, 'src/components/error-content.tsx']) {
      expect(read(file), file).not.toMatch(/error\.(message|digest|stack)|\{error\}/);
    }
  });

  it('the 404 content links home and to search', () => {
    const content = read('src/components/not-found-content.tsx');
    expect(content).toMatch(/href="\/"/);
    expect(content).toMatch(/href="\/search"/);
  });
});

describe('D1 — no 404 or error page can reach the database, settings, session or header', () => {
  it.each([PAGES.rootNotFound, PAGES.localeNotFound, PAGES.localeError, PAGES.globalError])('%s', (file) => {
    const offending = [...reachableImports(file)].filter((s) => FORBIDDEN.some((rule) => rule.test(s)));
    expect(offending).toEqual([]);
  });

  it('the guard itself sees a forbidden import through a chain (it can fail)', () => {
    // The `[locale]` layout reads settings: if the walker could not see that,
    // the test above would pass on anything.
    const offending = [...reachableImports('src/app/[locale]/layout.tsx')].filter((s) =>
      FORBIDDEN.some((rule) => rule.test(s)),
    );
    expect(offending).toContain('@/platform/settings');
  });
});
