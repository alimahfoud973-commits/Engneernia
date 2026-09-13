import { beforeAll, describe, expect, it } from 'vitest';
import { routing } from '@/i18n/routing';
import {
  CRAWL_TRAP_PREFIXES,
  disallowedPaths,
  languageAlternates,
  PRIVATE_PREFIXES,
  PRIVATE_ROBOTS,
} from './config';

beforeAll(() => {
  process.env.APP_URL ??= 'https://example.test';
  process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
  process.env.SESSION_SECRET ??= 'x'.repeat(48);
  process.env.CONFIG_ENCRYPTION_KEY ??= 'y'.repeat(48);
  process.env.STORAGE_ENDPOINT ??= 'file:///tmp/storage';
  process.env.STORAGE_REGION ??= 'us-east-1';
  process.env.STORAGE_ACCESS_KEY_ID ??= 'a';
  process.env.STORAGE_SECRET_ACCESS_KEY ??= 'b';
  process.env.STORAGE_BUCKET_ORIGINALS ??= 'originals';
  process.env.STORAGE_BUCKET_DERIVATIVES ??= 'derivatives';
  process.env.MAIL_TRANSPORT_URL ??= 'log://test';
  process.env.MAIL_FROM ??= 'Enginora <no-reply@example.test>';
});

describe('disallowedPaths', () => {
  const paths = disallowedPaths();

  it('covers every private area', () => {
    for (const prefix of PRIVATE_PREFIXES) expect(paths).toContain(prefix);
  });

  /**
   * The regression this file exists for. The first version of robots.ts wrote
   * every rule with a trailing slash, which matches `/search/...` and NOT
   * `/search?discipline=civil` — i.e. it blocked nothing that the rule was
   * written to block.
   */
  it('writes bare prefixes, so a query string is still matched', () => {
    for (const path of paths) {
      expect(path.endsWith('/')).toBe(false);
    }
    for (const prefix of CRAWL_TRAP_PREFIXES) expect(paths).toContain(prefix);
  });

  it('repeats every rule under each non-default locale prefix', () => {
    const extra = routing.locales.filter((l) => l !== routing.defaultLocale);
    for (const locale of extra) {
      for (const prefix of PRIVATE_PREFIXES) {
        expect(paths).toContain(`/${locale}${prefix}`);
      }
    }
    // With one locale configured there is nothing to prefix, and the list is
    // exactly the bare rules — asserted so the test still means something today.
    if (extra.length === 0) {
      expect(paths).toHaveLength(PRIVATE_PREFIXES.length + CRAWL_TRAP_PREFIXES.length);
    }
  });

  it('never disallows the catalogue itself', () => {
    for (const path of paths) {
      expect(path).not.toBe('/');
      expect(path.startsWith('/products')).toBe(false);
      expect(path.startsWith('/contributors')).toBe(false);
    }
  });
});

describe('languageAlternates', () => {
  it('declares only locales that are configured', () => {
    expect(Object.keys(languageAlternates('/'))).toEqual([...routing.locales]);
  });

  it('leaves the default locale unprefixed', () => {
    expect(languageAlternates('/')[routing.defaultLocale]).toBe('/');
    expect(languageAlternates('/products/x')[routing.defaultLocale]).toBe('/products/x');
  });
});

describe('PRIVATE_ROBOTS', () => {
  it('is never conditional on the deployment flag', () => {
    expect(PRIVATE_ROBOTS.index).toBe(false);
    expect(PRIVATE_ROBOTS.follow).toBe(false);
  });
});
