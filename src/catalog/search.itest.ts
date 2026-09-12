import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import { disciplines, products } from '@/db/schema';
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
const ids = { discipline: randomUUID(), published: randomUUID(), draft: randomUUID() };
const slugs = { published: `s4-pub-${suffix}`, draft: `s4-draft-${suffix}` };

beforeAll(async () => {
  await withRawActorContext(OWNER, async (tx) => {
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `s4-disc-${suffix}`, nameAr: 'تخصص البحث',
      nameEn: 'Search Test', sortOrder: 90, isActive: true,
    });
    await tx.insert(products).values([
      {
        id: ids.published, slug: slugs.published,
        titleAr: 'المحولات الكهربائية في شبكات التوزيع',
        subtitleAr: 'حساب القدرة واختيار المحول',
        descriptionAr: 'مرجع يشرح اختيار المحولات الكهربائية وحساب الأحمال.',
        disciplineId: ids.discipline, fileType: 'PDF', level: 'ADVANCED',
        softwareTags: ['ETAP'], status: 'PUBLISHED', currency: 'USD',
        publishedAt: new Date(), salesCount: 0,
      },
      {
        id: ids.draft, slug: slugs.draft,
        titleAr: 'المحولات الكهربائية — مسودة غير منشورة',
        disciplineId: ids.discipline, fileType: 'PDF', status: 'DRAFT', currency: 'USD',
      },
    ]);
  });
}, 30_000);

afterAll(async () => {
  await withRawActorContext(OWNER, async (tx) => {
    await tx.delete(products).where(sql`id IN (${ids.published}, ${ids.draft})`);
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
