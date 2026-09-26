import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import nextConfig from '../../../next.config';
import { buildCsp } from './csp';

/**
 * ===========================================================================
 * WHO MAY FRAME WHAT (Preview Display)
 * ===========================================================================
 * The product page shows its PDF preview in an iframe. The preview was blank
 * on every product page: `X-Frame-Options: DENY`, applied to every response,
 * refused even this origin, and with S3 storage the frame was redirected to
 * the storage host, which the page's `frame-src 'self'` refuses.
 *
 * The fix is one narrow exception, and these tests hold it narrow: exactly the
 * preview path may be framed, only by this origin, and the page's own policy
 * names no new source.
 * ===========================================================================
 */

type Rule = { source: string; headers: Array<{ key: string; value: string }> };

/** The X-Frame-Options values next.config.ts sends for a path, matched by Next's own matcher. */
async function frameOptionsFor(path: string): Promise<string[]> {
  const rules = (await nextConfig.headers!()) as Rule[];
  return rules
    .filter((rule) => getPathMatch(rule.source)(path) !== false)
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key.toLowerCase() === 'x-frame-options')
    .map((header) => header.value);
}

describe('framing, as next.config.ts sends it', () => {
  it.each([
    '/',
    '/products/some-product',
    '/login',
    '/admin/finance',
    '/api/health',
    '/api/files/some-product/original',
    '/api/files/some-product/thumbnail',
    '/api/files/some-product/preview/extra',
    '/api/files/some-product/previewx',
    '/api/files/a/b/preview',
  ])('refuses every frame for %s', async (path) => {
    expect(await frameOptionsFor(path)).toEqual(['DENY']);
  });

  it.each(['/api/files/some-product/preview', '/api/files/some-product/PREVIEW'])(
    'leaves %s to its route, which allows this origin only',
    async (path) => {
      expect(await frameOptionsFor(path)).toEqual([]);
    },
  );

  it('never sends a value other than DENY from the config', async () => {
    const rules = (await nextConfig.headers!()) as Rule[];
    const values = rules
      .flatMap((rule) => rule.headers)
      .filter((header) => header.key.toLowerCase() === 'x-frame-options')
      .map((header) => header.value);
    expect(new Set(values)).toEqual(new Set(['DENY']));
  });
});

describe('the preview route', () => {
  const source = readFileSync(
    join(__dirname, '../../app/api/files/[slug]/[role]/route.ts'),
    'utf8',
  );

  it('lets this origin, and only this origin, frame the preview', () => {
    expect(source).toContain(`'Content-Security-Policy': "frame-ancestors 'self'"`);
    expect(source).toContain(`'X-Frame-Options': 'SAMEORIGIN'`);
    // Granted to the PREVIEW response alone, never to an original.
    expect(source).toMatch(/upper === 'PREVIEW'\s*\?\s*\{\s*'Content-Security-Policy'/);
    expect(source).not.toMatch(/frame-ancestors (\*|https?:)/);
  });
});

describe("the product page's own policy", () => {
  it.each([true, false])('still frames only this origin (development: %s)', (isDevelopment) => {
    const csp = buildCsp('n', isDevelopment);
    expect(csp).toContain("frame-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
