import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withActor, withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import { disciplines } from '@/db/schema';
import { GUEST } from '@/authz/actor';
import { navDisciplines } from './public-queries';

/**
 * ===========================================================================
 * THE HEADER'S DISCIPLINES ARE THE TABLE'S (D3)
 * ===========================================================================
 * The header used to list four disciplines in its own source. The owner's
 * decision (§12, D-12) is that disciplines are data: added, renamed, disabled
 * and reordered without touching code. `navDisciplines` is what the header
 * now renders; these tests change the table and check the function follows.
 *
 * The catalogue holds other disciplines (the seeded four), so every assertion
 * looks only at this file's own rows, in the order the function returned them.
 * ===========================================================================
 */

const suffix = Date.now().toString(36);
const slug = (name: string) => `d3-${name}-${suffix}`;
const rows = {
  first: { id: randomUUID(), slug: slug('first'), nameAr: 'تخصص أول', sortOrder: 9001 },
  second: { id: randomUUID(), slug: slug('second'), nameAr: 'تخصص ثانٍ', sortOrder: 9002 },
  third: { id: randomUUID(), slug: slug('third'), nameAr: 'تخصص ثالث', sortOrder: 9003 },
  // Shares a position with `third` and is inserted AFTER it, but its slug
  // sorts first ('a' < 't'): only the slug tiebreaker puts it ahead, so the
  // row order the table happens to return cannot pass for a correct result.
  tieA: { id: randomUUID(), slug: slug('a-tie'), nameAr: 'تعادل أ', sortOrder: 9003 },
};
const ids = Object.values(rows).map((r) => r.id);
const ours = new Set(Object.values(rows).map((r) => r.slug));

let OWNER_RAW: { actorId: string; actorRole: string };

/** The function's output, reduced to this file's rows, order preserved. */
async function ourNav() {
  return (await navDisciplines()).filter((d) => ours.has(d.slug));
}

async function asOwner(write: Parameters<typeof withRawActorContext>[1]) {
  await withRawActorContext(OWNER_RAW, write);
}

beforeAll(async () => {
  OWNER_RAW = { actorId: (await ensureTestOwner({ displayName: 'Owner' })).id, actorRole: 'OWNER' };
  await asOwner((tx) =>
    tx.insert(disciplines).values(
      Object.values(rows).map((r) => ({ ...r, nameEn: r.slug, isActive: true })),
    ),
  );
});

afterAll(async () => {
  await asOwner((tx) => tx.delete(disciplines).where(inArray(disciplines.id, ids)));
  await closeDb();
});

describe('navDisciplines (D3)', () => {
  it('returns slug and name_ar only, in sort_order, with the slug breaking a tie', async () => {
    const nav = await ourNav();
    expect(nav).toEqual([
      { slug: rows.first.slug, nameAr: rows.first.nameAr },
      { slug: rows.second.slug, nameAr: rows.second.nameAr },
      // Both at 9003: `d3-a-tie-…` before `d3-third-…`, by slug.
      { slug: rows.tieA.slug, nameAr: rows.tieA.nameAr },
      { slug: rows.third.slug, nameAr: rows.third.nameAr },
    ]);
    for (const entry of nav) expect(Object.keys(entry).sort()).toEqual(['nameAr', 'slug']);
  });

  it('follows a reorder', async () => {
    await asOwner((tx) => tx.update(disciplines).set({ sortOrder: 9000 }).where(eq(disciplines.id, rows.third.id)));
    expect((await ourNav()).map((d) => d.slug)).toEqual([
      rows.third.slug, rows.first.slug, rows.second.slug, rows.tieA.slug,
    ]);
    await asOwner((tx) => tx.update(disciplines).set({ sortOrder: 9003 }).where(eq(disciplines.id, rows.third.id)));
  });

  it('shows a rename exactly as written — no shortening', async () => {
    const renamed = 'الهندسة المدنية والإنشائية (اختبار)';
    await asOwner((tx) => tx.update(disciplines).set({ nameAr: renamed }).where(eq(disciplines.id, rows.second.id)));
    const entry = (await ourNav()).find((d) => d.slug === rows.second.slug);
    expect(entry?.nameAr).toBe(renamed);
  });

  it('drops a disabled discipline, and brings it back when re-enabled', async () => {
    await asOwner((tx) => tx.update(disciplines).set({ isActive: false }).where(eq(disciplines.id, rows.first.id)));
    expect((await ourNav()).map((d) => d.slug)).not.toContain(rows.first.slug);

    await asOwner((tx) => tx.update(disciplines).set({ isActive: true }).where(eq(disciplines.id, rows.first.id)));
    expect((await ourNav()).map((d) => d.slug)).toContain(rows.first.slug);
  });

  it('includes a discipline added after the fact', async () => {
    const added = { id: randomUUID(), slug: slug('added'), nameAr: 'تخصص مضاف', nameEn: 'Added', sortOrder: 9004, isActive: true };
    ids.push(added.id);
    ours.add(added.slug);
    await asOwner((tx) => tx.insert(disciplines).values(added));
    expect((await ourNav()).at(-1)).toEqual({ slug: added.slug, nameAr: added.nameAr });
  });

  it('reads as a visitor: the GUEST policy alone already hides a disabled discipline', async () => {
    // The function filters `is_active` itself; this checks the second layer
    // underneath it — a visitor's connection cannot see the row at all.
    await asOwner((tx) => tx.update(disciplines).set({ isActive: false }).where(eq(disciplines.id, rows.tieA.id)));
    const visible = await withActor(GUEST, (tx) =>
      tx.select({ slug: disciplines.slug }).from(disciplines).where(eq(disciplines.id, rows.tieA.id)),
    );
    expect(visible).toEqual([]);
    expect((await ourNav()).map((d) => d.slug)).not.toContain(rows.tieA.slug);
  });
});
