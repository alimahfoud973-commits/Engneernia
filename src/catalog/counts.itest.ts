import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { closeDb } from '@/db';
import { categories, disciplines, products } from '@/db/schema';
import { disciplineBySlug, listDisciplines } from './public-queries';

/**
 * ===========================================================================
 * THE COUNTS ON THE HOME PAGE AND THE PORTALS
 * ===========================================================================
 * Written after both of them silently reported ZERO for months.
 *
 * The counts were correlated subqueries written inside a `sql` fragment:
 *
 *     SELECT count(*) FROM products p WHERE p.discipline_id = ${disciplines.id}
 *
 * With no join in the outer query, Drizzle emits a bare `"id"`, and PostgreSQL
 * resolves an unqualified name against the innermost scope first — where
 * `products p` also has an `id`. The condition compiled to `p.discipline_id =
 * p.id`: never true, never an error. The home page showed "0 مورد منشور" under
 * every discipline while the catalogue held 5,009 products.
 *
 * Nothing caught it. The types were right, the SQL was valid, and zero is a
 * perfectly plausible number for a new platform — which is exactly why the
 * assertions below are not "the query returns something" but "the number
 * EQUALS what the table actually holds".
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  discipline: randomUUID(),
  categoryUsed: randomUUID(),
  categoryEmpty: randomUUID(),
  published: [randomUUID(), randomUUID(), randomUUID()],
  draft: randomUUID(),
};
const slugs = { discipline: `cnt-disc-${suffix}`, categoryUsed: `cnt-cat-${suffix}` };

const OWNER = { actorId: randomUUID(), actorRole: 'OWNER' };

beforeAll(async () => {
  await withRawActorContext(OWNER, async (tx) => {
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: slugs.discipline, nameAr: 'تخصص العدّ',
      nameEn: 'Counting', sortOrder: 98, isActive: true,
    });
    await tx.insert(categories).values([
      { id: ids.categoryUsed, disciplineId: ids.discipline, slug: slugs.categoryUsed,
        nameAr: 'قسم فيه منتجات', nameEn: 'Populated', sortOrder: 1, isActive: true },
      { id: ids.categoryEmpty, disciplineId: ids.discipline, slug: `cnt-empty-${suffix}`,
        nameAr: 'قسم فارغ', nameEn: 'Empty', sortOrder: 2, isActive: true },
    ]);
    await tx.insert(products).values([
      ...ids.published.map((id, index) => ({
        id, slug: `cnt-pub-${index}-${suffix}`, titleAr: `منتج منشور ${index}`,
        disciplineId: ids.discipline, categoryId: ids.categoryUsed,
        fileType: 'PDF' as const, status: 'PUBLISHED' as const, currency: 'USD',
        publishedAt: new Date(),
      })),
      // A draft in the same discipline and category: it must NOT be counted.
      { id: ids.draft, slug: `cnt-draft-${suffix}`, titleAr: 'مسودة',
        disciplineId: ids.discipline, categoryId: ids.categoryUsed,
        fileType: 'PDF', status: 'DRAFT', currency: 'USD' },
    ]);
  });
}, 30_000);

afterAll(async () => {
  await withRawActorContext(OWNER, async (tx) => {
    await tx.delete(products).where(eq(products.disciplineId, ids.discipline));
    await tx.delete(categories).where(eq(categories.disciplineId, ids.discipline));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
  });
  await closeDb();
});

/** The truth, counted directly, with every name qualified. */
async function actualPublished(where: 'discipline' | 'category'): Promise<number> {
  return withRawActorContext(OWNER, async (tx) => {
    const rows = (await tx.execute(
      where === 'discipline'
        ? sql`SELECT count(*)::int AS n FROM products p
               WHERE p.discipline_id = ${ids.discipline}::uuid AND p.status = 'PUBLISHED'`
        : sql`SELECT count(*)::int AS n FROM products p
               WHERE p.category_id = ${ids.categoryUsed}::uuid AND p.status = 'PUBLISHED'`,
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? -1);
  });
}

describe('discipline counts on the home page', () => {
  it('reports the number of published products, not zero', async () => {
    const all = await listDisciplines();
    const mine = all.find((d) => d.slug === slugs.discipline);

    expect(mine).toBeDefined();
    expect(mine!.productCount).toBe(await actualPublished('discipline'));
    expect(mine!.productCount).toBe(ids.published.length);
  });

  it('counts published products only — a draft does not inflate the number', async () => {
    const all = await listDisciplines();
    const mine = all.find((d) => d.slug === slugs.discipline);
    // Four products exist in this discipline; three are published.
    expect(mine!.productCount).toBe(3);
  });

  /**
   * The strongest assertion here, because it is the one the old code failed:
   * SOME discipline on a seeded platform must have work in it. A run where
   * every count is zero is the exact symptom that shipped.
   */
  it('does not report zero for every discipline at once', async () => {
    const all = await listDisciplines();
    expect(all.some((d) => d.productCount > 0)).toBe(true);
  });
});

describe('category counts on a discipline portal', () => {
  it('reports the number of published products in each category', async () => {
    const portal = await disciplineBySlug(slugs.discipline);
    expect(portal).not.toBeNull();

    const used = portal!.categories.find((c) => c.slug === slugs.categoryUsed);
    expect(used).toBeDefined();
    expect(used!.productCount).toBe(await actualPublished('category'));
    expect(used!.productCount).toBe(3);
  });

  it('reports zero for a category that really is empty', async () => {
    const portal = await disciplineBySlug(slugs.discipline);
    const empty = portal!.categories.find((c) => c.slug === `cnt-empty-${suffix}`);
    // A real zero must still be a zero — the fix must not turn every count
    // into a positive number by joining the wrong way round.
    expect(empty?.productCount).toBe(0);
  });

  it('agrees with the portal total', async () => {
    const portal = await disciplineBySlug(slugs.discipline);
    const summed = portal!.categories.reduce((total, c) => total + c.productCount, 0);
    expect(summed).toBe(portal!.totalProducts);
  });
});
