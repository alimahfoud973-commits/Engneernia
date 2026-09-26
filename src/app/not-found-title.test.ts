import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * EVERY 404 TAB SAYS THE SAME THING (D4)
 * ===========================================================================
 * `[locale]/not-found.tsx` sets the title «الصفحة غير موجودة», which the
 * layout's template completes with the platform name. On a production build
 * that title reached the server's first HTML — and then the browser replaced
 * it with the title from the page's own `generateMetadata`, or the home page's
 * default when the page had none. So the tab of a missing product read
 * «غير موجود», and a missing order or admin record read as the home page.
 *
 * What makes the not-found title stick is raising `notFound()` INSIDE
 * `generateMetadata`: Next then resolves the not-found metadata on both sides.
 * Hence the two rules checked here:
 *
 *   1. A page that can raise `notFound()` has a `generateMetadata` — one that
 *      can raise it too (directly, or through a resolver shared with the page).
 *   2. No page writes a stand-in 404 title of its own.
 *
 * Source-level, so it runs in milliseconds. The tab titles themselves were
 * checked in a browser against a production build (docs/PROJECT_STATE.md, D4).
 * ===========================================================================
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const pages = [...globSync('src/app/[[]locale]/**/page.tsx', { cwd: ROOT })].sort();

/** The body of `generateMetadata`, up to the next top-level declaration. */
function generateMetadataBody(source: string): string | null {
  const start = source.search(/export async function generateMetadata\b/);
  if (start === -1) return null;
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(export |const |function |\/\*\*)/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/** Names of `cache()` resolvers in this file that raise `notFound()`. */
function notFoundResolvers(source: string): string[] {
  return [...source.matchAll(/const (\w+) = cache\(async[\s\S]*?\n\}\);/g)]
    .filter((m) => /notFound\(\)/.test(m[0]))
    .map((m) => m[1]!);
}

describe('D4 — the 404 title comes from not-found.tsx', () => {
  it('found the pages to check', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  it('[locale]/not-found.tsx sets the title', () => {
    expect(read('src/app/[locale]/not-found.tsx')).toMatch(/title: 'الصفحة غير موجودة'/);
  });

  const raising = pages.filter((file) => /notFound\(\)/.test(read(file)));

  it('the pages that raise notFound() are the ones D4 covered', () => {
    expect(raising.map((f) => f.replace('src/app/[locale]/', ''))).toEqual([
      '[discipline]/page.tsx',
      'admin/engineers/[contributorId]/page.tsx',
      'admin/products/[productId]/page.tsx',
      'checkout/[orderId]/page.tsx',
      'contributors/[slug]/page.tsx',
      'products/[slug]/page.tsx',
    ]);
  });

  it.each(raising)('%s raises notFound() from generateMetadata too', (file) => {
    const source = read(file);
    const body = generateMetadataBody(source);
    expect(body, 'no generateMetadata').not.toBeNull();
    const direct = /notFound\(\)/.test(body!);
    const viaResolver = notFoundResolvers(source).some((name) => body!.includes(`${name}(`));
    expect(direct || viaResolver, 'generateMetadata cannot raise notFound()').toBe(true);
  });

  it.each(pages)('%s writes no stand-in 404 title', (file) => {
    expect(read(file)).not.toMatch(/title: ['"]غير موجود['"]/);
  });
});
