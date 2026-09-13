import 'server-only';
import { serverEnv } from '@/lib/config/env';
import { routing } from '@/i18n/routing';

/**
 * ===========================================================================
 * WHAT MAY BE INDEXED, AND FROM WHICH ADDRESS
 * ===========================================================================
 * One module decides both questions, because getting either wrong is not the
 * kind of mistake that shows up in testing.
 *
 * THE PRIVATE AREAS ARE LISTED ONCE, HERE. `robots.ts` refuses them to
 * crawlers and each page under them sends `noindex` of its own. Two layers,
 * for two different failure modes: a crawler that ignores robots.txt is
 * stopped by the page's own header, and a page whose metadata was forgotten is
 * still excluded by the path rule. Neither is the security boundary — that is
 * Row-Level Security, and a crawler is refused the DATA long before either of
 * these matters. These stop a private URL from appearing in a search result,
 * which is a different problem from reading it.
 * ===========================================================================
 */

/** Path prefixes that must never appear in a search index. */
export const PRIVATE_PREFIXES = [
  '/admin',
  '/account',
  '/checkout',
  '/login',
  '/api',
] as const;

/**
 * Faceted search is excluded too, for a reason that is not privacy: the filter
 * combinations multiply into tens of thousands of near-identical URLs, and a
 * crawler that follows them spends its budget there instead of on the products
 * those pages exist to lead to.
 */
export const CRAWL_TRAP_PREFIXES = ['/search'] as const;

/** Everything a crawler must not index, private or merely worthless. */
export const DISALLOWED_PREFIXES = [...PRIVATE_PREFIXES, ...CRAWL_TRAP_PREFIXES];

/**
 * The same prefixes, written the way robots.txt actually matches.
 *
 * TWO MISTAKES ARE FIXED HERE, both of which produced a file that LOOKED
 * correct and blocked nothing:
 *
 *   1. No trailing slash. `Disallow: /search/` matches only paths that begin
 *      with "/search/" — it does NOT match `/search?discipline=civil`, which
 *      is every faceted URL the rule exists to stop. The bare prefix matches
 *      the path, the query form, and everything below it.
 *
 *   2. Every locale prefix, derived rather than typed. Arabic is served
 *      without a prefix today, so `/admin` is the whole story — but `routing`
 *      says adding English is a one-line change, and the day it is made
 *      `/en/admin` would be crawlable with nothing in this file to notice.
 */
export function disallowedPaths(): string[] {
  const prefixed = routing.locales
    .filter((locale) => locale !== routing.defaultLocale)
    .flatMap((locale) => DISALLOWED_PREFIXES.map((path) => `/${locale}${path}`));

  return [...DISALLOWED_PREFIXES, ...prefixed];
}

/**
 * The `alternates.languages` map, derived from the locales that EXIST.
 *
 * Hard-coding an entry for a locale that is not configured advertises a URL
 * that answers 404, which is worse than declaring no alternate at all.
 */
export function languageAlternates(path = '/'): Record<string, string> {
  return Object.fromEntries(
    routing.locales.map((locale) => [
      locale,
      locale === routing.defaultLocale ? path : `/${locale}${path === '/' ? '' : path}`,
    ]),
  );
}

/**
 * The site's own address, from configuration.
 *
 * Never guessed and never hard-coded: the production domain is the owner's to
 * choose (OPEN-8), and a canonical URL pointing at the wrong host is worse
 * than none — it tells search engines that the real site is a copy of
 * something else.
 */
export function siteUrl(): URL {
  return new URL(serverEnv().APP_URL);
}

export function absoluteUrl(path: string): string {
  return new URL(path, siteUrl()).toString();
}

/** Whether THIS deployment may be indexed at all. Defaults to no. */
export function isIndexable(): boolean {
  return serverEnv().SEO_INDEXABLE;
}

/**
 * The robots directive for a public page.
 *
 * A page that may be indexed also gets the large-preview hints, which is what
 * makes a result show a snippet worth clicking rather than a bare title.
 */
export function publicRobots() {
  return isIndexable()
    ? {
        index: true,
        follow: true,
        googleBot: {
          index: true,
          follow: true,
          'max-image-preview': 'large' as const,
          'max-snippet': -1,
          'max-video-preview': -1,
        },
      }
    : { index: false, follow: false };
}

/** The robots directive for anything private. Never conditional. */
export const PRIVATE_ROBOTS = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: { index: false, follow: false },
} as const;
