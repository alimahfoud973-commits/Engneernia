import type { MetadataRoute } from 'next';
import { absoluteUrl, isIndexable } from '@/seo/config';
import { sitemapEntries } from '@/seo/sitemap-queries';

export const dynamic = 'force-dynamic';

/**
 * sitemap.xml — the catalogue, and nothing else.
 *
 * Empty while the deployment is not indexable, so a staging copy cannot hand a
 * crawler a list of URLs that robots.txt has just refused.
 *
 * The entries come from a GUEST-scoped query, so what a crawler is offered is
 * exactly what an anonymous visitor can open. No private path is filtered out
 * here, because none can be selected in the first place.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isIndexable()) return [];

  const entries = await sitemapEntries();

  return [
    { url: absoluteUrl('/'), changeFrequency: 'daily', priority: 1 },
    ...entries.map((entry) => ({
      url: absoluteUrl(entry.path),
      ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
      changeFrequency: 'weekly' as const,
      priority: entry.path.startsWith('/products/') ? 0.8 : 0.6,
    })),
  ];
}
