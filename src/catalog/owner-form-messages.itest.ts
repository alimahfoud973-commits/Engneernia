import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  commissionAgreements, contributors, disciplines, productPrices, products, users,
} from '@/db/schema';
import { changeProductPrice, createProduct } from './products';
import { saveCommissionAgreement } from '@/finance/commissions';
import { addEngineer } from '@/contributors/admin';
import { toUserMessage } from '@/lib/action-errors';
import type { Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * WHAT THE OWNER IS TOLD WHEN A FORM IS REFUSED (Stage 3, W8–W10)
 * ===========================================================================
 * Each case goes through the domain function a form calls, and then through
 * `toUserMessage` — the one place that decides what a user reads — so what is
 * asserted is the sentence on the screen, not an exception class.
 *
 *   W8  money: a refusal is explained in Arabic, and a value the platform
 *       cannot use is refused where it is entered (a negative price reached a
 *       database constraint and came back as "try again"; a negative fixed
 *       commission was SAVED, to fail at the first sale).
 *   W9  a product address already in use says so.
 *   W10 adding an engineer asks for a step that exists (no email to confirm).
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', customer: randomUUID(), engineerUser: randomUUID(), contributor: randomUUID(),
  discipline: randomUUID(), product: randomUUID(),
};
const slug = `w9-prod-${suffix}`;

let OWNER_RAW: { actorId: string; actorRole: string };
let owner: Actor;

/** The sentence the owner reads for whatever the call raised. */
async function shown(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return toUserMessage(error, 'owner-form-messages test');
  }
}
const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = {
    kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's',
    userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false,
  };
  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.customer, email: `w10-cust+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER', status: 'ACTIVE', displayName: 'Customer' },
      { id: ids.engineerUser, email: `w8-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `w8-eng-${suffix}`,
      settlementCode: `W8E${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `w8-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 92,
    });
    await tx.insert(products).values({
      id: ids.product, slug, titleAr: 'المنتج الأصلي', disciplineId: ids.discipline, fileType: 'PDF', status: 'DRAFT', currency: 'USD',
    });
  });
}, 120_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(products).where(eq(products.disciplineId, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.userId, ids.customer));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(users).where(inArray(users.id, [ids.customer, ids.engineerUser]));
  });
  await closeDb();
}, 60_000);

describe('W8 — money refusals are explained in Arabic, where the value is entered', () => {
  it('a negative price is refused by the price change itself, in Arabic, and nothing is stored', async () => {
    const message = await shown(changeProductPrice(owner, { productId: ids.product, newAmountMinor: -500n, currency: 'USD' }));
    expect(message).toMatch(ARABIC);
    expect(message).not.toMatch(LATIN_WORD);
    expect(message).not.toBe('تعذّر إتمام العملية. حاول مرة أخرى.');
    const prices = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productPrices).where(eq(productPrices.productId, ids.product)));
    expect(prices).toHaveLength(0);
  });

  it('a negative fixed commission is refused when saved, in Arabic — not stored to fail at the first sale', async () => {
    for (const agreement of [
      { model: 'FIXED_ENGINEER', engineerFixedMinor: -100n, currency: 'USD' },
      { model: 'FIXED_PLATFORM', platformFixedMinor: -100n, currency: 'USD' },
    ] as const) {
      const message = await shown(saveCommissionAgreement(owner, { contributorId: ids.contributor, productId: null, agreement }));
      expect(message, agreement.model).toMatch(ARABIC);
      expect(message, agreement.model).not.toMatch(LATIN_WORD);
    }
    const saved = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor)));
    expect(saved).toHaveLength(0);
  });

  it('a valid price still saves', async () => {
    await changeProductPrice(owner, { productId: ids.product, newAmountMinor: 3500n, currency: 'USD' });
    const [open] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ amount: productPrices.amountMinor }).from(productPrices).where(eq(productPrices.productId, ids.product)));
    expect(open?.amount).toBe(3500n);
  });
});

describe('W9 — a product address already in use says so', () => {
  const input = (s: string) => ({ slug: s, titleAr: 'منتج آخر', disciplineId: ids.discipline, fileType: 'PDF' as const, currency: 'USD' });

  it('a new address is created', async () => {
    const created = await createProduct(owner, input(`w9-new-${suffix}`));
    expect(created.slug).toBe(`w9-new-${suffix}`);
  });

  it('a duplicate is refused with a specific Arabic message, and no product is added or changed', async () => {
    const message = await shown(createProduct(owner, input(slug)));
    expect(message).toMatch(/مستخدم/);
    expect(message).not.toBe('تعذّر إتمام العملية. حاول مرة أخرى.');
    const rows = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ title: products.titleAr }).from(products).where(eq(products.slug, slug)));
    expect(rows).toEqual([{ title: 'المنتج الأصلي' }]);
  });

  it('the same address differing only in case or spaces is the same address', async () => {
    const message = await shown(createProduct(owner, input(`  ${slug.toUpperCase()}  `)));
    expect(message).toMatch(/مستخدم/);
  });
});

describe('W10 — adding an engineer asks only for steps that exist', () => {
  it('an unknown email is refused without asking for an email confirmation', async () => {
    const message = await shown(addEngineer(owner, {
      email: `nobody-w10-${suffix}@test.local`, displayName: 'مهندس', publicSlug: `w10-nobody-${suffix}`, settlementCode: `W10N${suffix}`,
    }));
    expect(message).toMatch(/لا يوجد حساب بهذا البريد/);
    expect(message).not.toMatch(/تأكيد/);
  });

  it('the account it asks for is enough: once registered, the same email is added', async () => {
    const [user] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ email: users.email }).from(users).where(eq(users.id, ids.customer)));
    const added = await addEngineer(owner, {
      email: user!.email!, displayName: 'مهندس جديد', publicSlug: `w10-eng-${suffix}`, settlementCode: `W10E${suffix}`,
    });
    expect(added.contributorId).toBeTruthy();
  });
});
