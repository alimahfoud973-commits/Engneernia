import { defineRouting } from 'next-intl/routing';

/**
 * Decision D-03: Arabic is the primary locale in phase 1.
 *
 * `localePrefix: 'as-needed'` means Arabic URLs stay clean (`/products/...`)
 * while a second locale added later is served from a prefix (`/en/products/...`)
 * — no route rewriting, no UI rebuild. Adding English is a one-line change here
 * plus a message catalogue.
 */
export const routing = defineRouting({
  locales: ['ar'],
  defaultLocale: 'ar',
  localePrefix: 'as-needed',
});

export type AppLocale = (typeof routing.locales)[number];

/** Text direction per locale. Every layout reads this rather than hard-coding RTL. */
export const LOCALE_DIRECTION: Record<string, 'rtl' | 'ltr'> = {
  ar: 'rtl',
  en: 'ltr',
};

export function directionOf(locale: string): 'rtl' | 'ltr' {
  return LOCALE_DIRECTION[locale] ?? 'ltr';
}
