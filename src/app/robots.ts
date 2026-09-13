import type { MetadataRoute } from 'next';
import { absoluteUrl, disallowedPaths, isIndexable } from '@/seo/config';

export const dynamic = 'force-dynamic';

/**
 * robots.txt.
 *
 * Until this deployment is marked indexable, it refuses EVERYTHING — which is
 * the correct state for a staging copy and for production before launch. After
 * launch it allows the catalogue and refuses the private areas and the faceted
 * search, which are listed once in `src/seo/config.ts`.
 */
export default function robots(): MetadataRoute.Robots {
  if (!isIndexable()) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: disallowedPaths(),
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: absoluteUrl('/'),
  };
}
