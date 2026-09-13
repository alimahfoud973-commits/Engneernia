import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { contributors, disciplines, products } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { GUEST } from '@/authz/actor';

/**
 * What belongs in the sitemap.
 *
 * Read as GUEST, deliberately. The sitemap must contain exactly what an
 * anonymous visitor can reach, and the surest way to guarantee that is to ask
 * the database as one: Row-Level Security then removes anything that is not
 * public, so a draft product cannot leak into the sitemap even if someone
 * later changes the filter below.
 */

export interface SitemapEntry {
  readonly path: string;
  readonly lastModified: Date | null;
}

const SITEMAP_PRODUCT_LIMIT = 45_000;

export async function sitemapEntries(): Promise<readonly SitemapEntry[]> {
  return withActor(GUEST, async (tx) => {
    const disciplineRows = await tx
      .select({ slug: disciplines.slug })
      .from(disciplines)
      .where(eq(disciplines.isActive, true))
      .orderBy(disciplines.sortOrder);

    const productRows = await tx
      .select({ slug: products.slug, updatedAt: products.updatedAt, publishedAt: products.publishedAt })
      .from(products)
      .where(eq(products.status, 'PUBLISHED'))
      .orderBy(desc(products.publishedAt), desc(products.id))
      // A sitemap file may hold 50,000 URLs. Past that the file must be split,
      // which is a different shape of code; the cap makes the day that becomes
      // necessary an obvious one rather than a silently truncated file.
      .limit(SITEMAP_PRODUCT_LIMIT);

    const contributorRows = await tx
      .select({ slug: contributors.publicSlug, updatedAt: contributors.updatedAt })
      .from(contributors)
      .where(eq(contributors.isActive, true));

    return [
      ...disciplineRows.map((row) => ({ path: `/${row.slug}`, lastModified: null })),
      ...productRows.map((row) => ({
        path: `/products/${row.slug}`,
        lastModified: row.updatedAt ?? row.publishedAt ?? null,
      })),
      ...contributorRows.map((row) => ({
        path: `/contributors/${row.slug}`,
        lastModified: row.updatedAt ?? null,
      })),
    ];
  });
}
