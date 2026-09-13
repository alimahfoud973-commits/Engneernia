import 'server-only';
import { cache } from 'react';
import { inArray } from 'drizzle-orm';
import { settings } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { GUEST } from '@/authz/actor';

/**
 * Reads platform settings.
 *
 * Runs as GUEST, so RLS returns only rows marked public — a payment
 * credential cannot reach a page through this function even if someone asks
 * for its key by name. Owner-only settings are read through the admin
 * services, with an owner actor.
 *
 * `cache()` deduplicates within one render pass, so a layout and three
 * components all asking for the platform name cost a single query.
 */

export interface PublicSettings {
  readonly platformName: string;
  readonly platformNameAr: string;
  readonly tagline: string;
  readonly previewPageCount: number;
  readonly showSalesCount: boolean;
  readonly whatsapp: string;
}

/**
 * Fallbacks only, for a database that has not been seeded yet. The real
 * values live in the settings table and are the owner's to edit (OPEN-8).
 */
const DEFAULTS: PublicSettings = {
  platformName: 'Enginora',
  platformNameAr: 'إنجينورا',
  tagline: 'المعرفة الهندسية والموارد الرقمية',
  previewPageCount: 5,
  showSalesCount: false,
  whatsapp: '',
};

const KEYS = [
  'platform.name',
  'platform.nameAr',
  'platform.tagline',
  'preview.pageCount',
  'catalog.showSalesCount',
  'support.whatsapp',
] as const;

export const getPublicSettings = cache(async (): Promise<PublicSettings> => {
  try {
    const rows = await withActor(GUEST, (tx) =>
      tx
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(inArray(settings.key, [...KEYS])),
    );

    const map = new Map(rows.map((row) => [row.key, row.value]));
    const str = (key: string, fallback: string) =>
      typeof map.get(key) === 'string' ? (map.get(key) as string) : fallback;
    const num = (key: string, fallback: number) =>
      typeof map.get(key) === 'number' ? (map.get(key) as number) : fallback;
    const bool = (key: string, fallback: boolean) =>
      typeof map.get(key) === 'boolean' ? (map.get(key) as boolean) : fallback;

    return {
      platformName: str('platform.name', DEFAULTS.platformName),
      platformNameAr: str('platform.nameAr', DEFAULTS.platformNameAr),
      tagline: str('platform.tagline', DEFAULTS.tagline),
      previewPageCount: num('preview.pageCount', DEFAULTS.previewPageCount),
      showSalesCount: bool('catalog.showSalesCount', DEFAULTS.showSalesCount),
      whatsapp: str('support.whatsapp', DEFAULTS.whatsapp),
    };
  } catch {
    // A settings outage must not take the storefront down with it.
    return DEFAULTS;
  }
});
