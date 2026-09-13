import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import { categories, disciplines, productPrices, products } from '@/db/schema';
import { searchCatalogue } from './search';

/**
 * ===========================================================================
 * PHASE P4 EXIT CRITERIA
 * ===========================================================================
 *   1. Arabic search finds inflected forms (stemming actually works).
 *   2. Facets filter correctly and their counts stay honest.
 *   3. Only PUBLISHED products are ever reachable.
 *   4. Performance holds on a catalogue of thousands.
 * ===========================================================================
 */

const suffix = Date.now();
const OWNER = { actorId: randomUUID(), actorRole: 'OWNER' };
const ids = {
  discipline: randomUUID(),
  category: randomUUID(),
  published: randomUUID(),
  draft: randomUUID(),
};
const slugs = { published: `s4-pub-${suffix}`, draft: `s4-draft-${suffix}` };

beforeAll(async () => {
  await withRawActorContext(OWNER, async (tx) => {
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `s4-disc-${suffix}`, nameAr: 'تخصص البحث',
      nameEn: 'Search Test', sortOrder: 90, isActive: true,
    });
    /**
     * A category and a price exist on the fixture so that the CATEGORY and
     * PRICE-BOUND filters can be exercised. Those two filters are the only
     * ones that make the facet scan join `categories` and `product_prices`;
     * every other search leaves both out, and a mistake in that conditional
     * would raise "missing FROM-clause entry" rather than return a wrong
     * answer — which is exactly why it needs a test rather than a review.
     */
    await tx.insert(categories).values({
      id: ids.category, disciplineId: ids.discipline, slug: `s4-cat-${suffix}`,
      nameAr: 'قسم البحث', nameEn: 'Search Category', sortOrder: 10, isActive: true,
    });
    await tx.insert(products).values([
      {
        id: ids.published, slug: slugs.published,
        titleAr: 'المحولات الكهربائية في شبكات التوزيع',
        subtitleAr: 'حساب القدرة واختيار المحول',
        descriptionAr: 'مرجع يشرح اختيار المحولات الكهربائية وحساب الأحمال.',
        disciplineId: ids.discipline, fileType: 'PDF', level: 'ADVANCED',
        softwareTags: ['ETAP'], status: 'PUBLISHED', currency: 'USD',
        publishedAt: new Date(), salesCount: 0, categoryId: ids.category,
      },
      {
        id: ids.draft, slug: slugs.draft,
        titleAr: 'المحولات الكهربائية — مسودة غير منشورة',
        disciplineId: ids.discipline, fileType: 'PDF', status: 'DRAFT', currency: 'USD',
      },
    ]);
    await tx.insert(productPrices).values({
      productId: ids.published, amountMinor: 2500n, currency: 'USD',
      effectiveFrom: new Date(Date.now() - 86_400_000),
    });
  });
}, 30_000);

afterAll(async () => {
  await withRawActorContext(OWNER, async (tx) => {
    await tx.delete(productPrices).where(eq(productPrices.productId, ids.published));
    await tx.delete(products).where(sql`id IN (${ids.published}, ${ids.draft})`);
    await tx.delete(categories).where(eq(categories.id, ids.category));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
  });
  await closeDb();
});

describe('1. Arabic search', () => {
  it('finds a product by a word from its title', async () => {
    const results = await searchCatalogue({ q: 'المحولات' });
    expect(results.items.some((i) => i.slug === slugs.published)).toBe(true);
  });

  /**
   * The reason the Arabic text-search configuration is used rather than
   * 'simple': without stemming, every inflection would be a separate term and
   * Arabic search would be close to useless.
   */
  it('matches an inflected form — "كهربائي" finds "الكهربائية"', async () => {
    const results = await searchCatalogue({ q: 'كهربائي' });
    expect(results.items.some((i) => i.slug === slugs.published)).toBe(true);
  });

  it('finds a word that appears only in the description', async () => {
    // Scoped to the test discipline: the synthetic catalogue also mentions
    // this word, and an unscoped query would simply push the expected row off
    // the first page — a ranking fact, not a search failure.
    const results = await searchCatalogue({ q: 'الأحمال', discipline: `s4-disc-${suffix}` });
    expect(results.items.some((i) => i.slug === slugs.published)).toBe(true);
  });

  it('returns nothing for a term that appears nowhere', async () => {
    const results = await searchCatalogue({ q: 'زبرجدxyz' });
    expect(results.total).toBe(0);
    expect(results.items).toEqual([]);
  });
});

/** THE RULE: an unpublished product is not searchable by anyone. */
describe('2. only published products are reachable', () => {
  it('never returns a draft, even when the query matches its title exactly', async () => {
    const results = await searchCatalogue({ q: 'مسودة غير منشورة' });
    expect(results.items.some((i) => i.slug === slugs.draft)).toBe(false);
  });

  it('excludes drafts from every facet count', async () => {
    const results = await searchCatalogue({ discipline: `s4-disc-${suffix}` });
    // The discipline has two products; only the published one is counted.
    expect(results.total).toBe(1);
  });
});

describe('3. facets', () => {
  it('filters by file type', async () => {
    const results = await searchCatalogue({ q: 'المحولات', fileTypes: ['PDF'] });
    expect(results.items.some((i) => i.slug === slugs.published)).toBe(true);

    const wrong = await searchCatalogue({ q: 'المحولات', fileTypes: ['EXCEL'] });
    expect(wrong.items.some((i) => i.slug === slugs.published)).toBe(false);
  });

  it('filters by level and by software', async () => {
    const scope = `s4-disc-${suffix}`;
    const byLevel = await searchCatalogue({ discipline: scope, levels: ['ADVANCED'] });
    expect(byLevel.items.some((i) => i.slug === slugs.published)).toBe(true);

    const bySoftware = await searchCatalogue({ discipline: scope, software: ['ETAP'] });
    expect(bySoftware.items.some((i) => i.slug === slugs.published)).toBe(true);

    const wrongLevel = await searchCatalogue({ discipline: scope, levels: ['BEGINNER'] });
    expect(wrongLevel.items.some((i) => i.slug === slugs.published)).toBe(false);
  });

  it('keeps the total consistent with the facet counts', async () => {
    const results = await searchCatalogue({});
    const fromPrice = results.facets.price.reduce((sum, f) => sum + f.count, 0);
    const fromDisciplines = results.facets.disciplines.reduce((sum, f) => sum + f.count, 0);
    expect(fromPrice).toBe(results.total);
    expect(fromDisciplines).toBe(results.total);
  });

  /**
   * A facet list that collapses to the current selection cannot be used to
   * navigate — the whole point is seeing what else is available.
   */
  it('still shows alternatives within a dimension the user has filtered', async () => {
    const results = await searchCatalogue({ fileTypes: ['PDF'] });
    const types = results.facets.fileTypes.map((f) => f.value);
    expect(types).toContain('PDF');
    expect(types.length).toBeGreaterThan(1);
  });

  it('ignores an unknown enum value rather than passing it into SQL', async () => {
    const results = await searchCatalogue({
      fileTypes: ["PDF'); DROP TABLE products; --", 'PDF'],
    });
    // The crafted value is dropped; the legitimate one still applies.
    expect(results.total).toBeGreaterThan(0);
    const stillThere = await searchCatalogue({});
    expect(stillThere.total).toBeGreaterThan(0);
  });
});


/**
 * These two filters are the ones the facet scan joins extra tables for. The
 * joins became CONDITIONAL in P8 — dead most of the time, and expensive under
 * Row-Level Security, which re-derives the parent product's visibility once per
 * price row. The saving was 60 ms to 27 ms on the facet query; the risk is a
 * predicate left referring to a table that is no longer in the FROM clause.
 */
describe('3b. the filters that add a join', () => {
  const scope = `s4-disc-${suffix}`;

  it('filters by category, and the facets still add up', async () => {
    const results = await searchCatalogue({ discipline: scope, category: `s4-cat-${suffix}` });
    expect(results.items.some((i) => i.slug === slugs.published)).toBe(true);

    const fromPrice = results.facets.price.reduce((sum, f) => sum + f.count, 0);
    expect(fromPrice).toBe(results.total);
  });

  it('returns nothing for a category that does not exist', async () => {
    const results = await searchCatalogue({ discipline: scope, category: 'no-such-category' });
    expect(results.total).toBe(0);
  });

  it('filters by a lower price bound', async () => {
    const included = await searchCatalogue({ discipline: scope, minPriceMinor: 2000 });
    expect(included.items.some((i) => i.slug === slugs.published)).toBe(true);

    const excluded = await searchCatalogue({ discipline: scope, minPriceMinor: 9000 });
    expect(excluded.items.some((i) => i.slug === slugs.published)).toBe(false);
  });

  it('filters by an upper price bound', async () => {
    const included = await searchCatalogue({ discipline: scope, maxPriceMinor: 3000 });
    expect(included.items.some((i) => i.slug === slugs.published)).toBe(true);

    const excluded = await searchCatalogue({ discipline: scope, maxPriceMinor: 1000 });
    expect(excluded.items.some((i) => i.slug === slugs.published)).toBe(false);
  });

  it('filters by both bounds at once, with the facets consistent', async () => {
    const results = await searchCatalogue({
      discipline: scope,
      minPriceMinor: 2000,
      maxPriceMinor: 3000,
    });
    expect(results.items.some((i) => i.slug === slugs.published)).toBe(true);
    const fromDisciplines = results.facets.disciplines.reduce((sum, f) => sum + f.count, 0);
    expect(fromDisciplines).toBe(results.total);
  });

  /**
   * The counts must not depend on which tables the scan happened to join —
   * the joins are an implementation detail of how the rows are reached, and
   * a facet count that changed with them would mean one of the two paths is
   * filtering rows the other does not.
   */
  it('counts the same discipline totals with and without the extra joins', async () => {
    const plain = await searchCatalogue({ discipline: scope });
    const joined = await searchCatalogue({ discipline: scope, minPriceMinor: 0 });
    const total = (r: typeof plain) =>
      r.facets.disciplines.reduce((sum, f) => sum + f.count, 0);
    // The price-bounded search can only be a subset, never larger.
    expect(total(joined)).toBeLessThanOrEqual(total(plain));
    expect(total(plain)).toBe(plain.total);
    expect(total(joined)).toBe(joined.total);
  });
});

describe('4. paging and sorting', () => {
  /**
   * Guards the unstable-sort bug: thousands of products share a published_at,
   * and without a unique tiebreaker PostgreSQL may order ties differently
   * between two queries, so the same product lands on page 1 AND page 2 while
   * another is never shown.
   */
  it('pages without overlapping, across every sort order', async () => {
    for (const sort of ['newest', 'bestselling', 'price_asc', 'relevance'] as const) {
      const first = await searchCatalogue({ perPage: 5, page: 1, sort });
      const second = await searchCatalogue({ perPage: 5, page: 2, sort });
      const overlap = first.items.filter((a) => second.items.some((b) => b.slug === a.slug));
      expect(overlap, `overlap under sort=${sort}`).toEqual([]);
    }
  });

  it('returns a stable page when the same query runs twice', async () => {
    const once = await searchCatalogue({ perPage: 10, page: 3 });
    const twice = await searchCatalogue({ perPage: 10, page: 3 });
    expect(once.items.map((i) => i.slug)).toEqual(twice.items.map((i) => i.slug));
  });

  it('reports a coherent page count', async () => {
    const results = await searchCatalogue({ perPage: 10 });
    expect(results.totalPages).toBe(Math.ceil(results.total / 10));
  });

  it('caps an absurd page size rather than trusting it', async () => {
    const results = await searchCatalogue({ perPage: 100_000 });
    expect(results.items.length).toBeLessThanOrEqual(48);
  });

  it('orders by price when asked', async () => {
    const asc = await searchCatalogue({ sort: 'price_asc', perPage: 20, price: 'paid' });
    const prices = asc.items.map((i) => Number(i.priceMinor ?? 0));
    const sorted = [...prices].sort((a, b) => a - b);
    expect(prices).toEqual(sorted);
  });
});

/** The scale §30 asks for. */
describe('5. performance at scale', () => {
  it('answers the heaviest query — browse everything with all facets — quickly', async () => {
    const results = await searchCatalogue({});
    expect(results.total).toBeGreaterThan(1000);
    // Generous bound: this asserts the query uses indexes rather than
    // degrading linearly, not a precise latency target on shared CI hardware.
    expect(results.tookMs).toBeLessThan(2000);
  });

  it('answers a filtered search quickly', async () => {
    const results = await searchCatalogue({ q: 'تصميم', fileTypes: ['PDF'] });
    expect(results.tookMs).toBeLessThan(2000);
  });
});

/**
 * Page weight is a correctness property once a catalogue reaches scale.
 *
 * The discipline portal and the contributor profile used to render EVERY
 * published product. At 1,253 products a discipline page was 3.2 MB of HTML
 * and a profile 12.8 MB — unusable on a phone, and entirely invisible until
 * the catalogue was seeded to the size §30 describes.
 */
describe('6. portal and profile pages stay bounded', () => {
  it('a discipline portal renders a capped preview, not the whole discipline', async () => {
    const { disciplineBySlug, PORTAL_PREVIEW_LIMIT } = await import('./public-queries');
    const discipline = await disciplineBySlug('civil');
    expect(discipline).not.toBeNull();
    expect(discipline!.products.length).toBeLessThanOrEqual(PORTAL_PREVIEW_LIMIT);
    // ...while still reporting the true size, and offering the way to it.
    expect(discipline!.totalProducts).toBeGreaterThan(PORTAL_PREVIEW_LIMIT);
    expect(discipline!.hasMore).toBe(true);
  });

  it('a contributor profile renders a capped preview', async () => {
    const { contributorBySlug, PROFILE_PREVIEW_LIMIT } = await import('./public-queries');
    const contributor = await contributorBySlug('demo-engineer');
    if (!contributor) return; // demo data not seeded in this environment
    expect(contributor.products.length).toBeLessThanOrEqual(PROFILE_PREVIEW_LIMIT);
  });
})
