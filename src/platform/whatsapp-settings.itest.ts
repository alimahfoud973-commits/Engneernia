import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, orders, paymentMethods,
  productContributors, productPrices, products, settings, users,
} from '@/db/schema';
import { getPublicSettings } from './settings';
import { updateWhatsappNumber, whatsappSettingForOwner } from './settings-admin';
import { createOrder, placeOrder } from '@/commerce/orders';
import { checkoutView } from '@/commerce/queries';
import { RuleViolationError, ValidationError } from '@/lib/errors';
import { GUEST, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * WHATSAPP ASSISTANCE WORKS WHEN THE OWNER SETS A NUMBER (Stage 2 audit, W2)
 * ===========================================================================
 * Found by the W2 audit:
 *   W2-2  a number stored as wa.me needs it ("963933123456") was READ as
 *         absent — Drizzle parses jsonb twice and made it a number;
 *   W2-3  no screen set the number, and nothing recorded a change;
 *   W2-4  nothing checked it — "0933…" built a link to nobody;
 *   W2-1  choosing WhatsApp returned no link at all;
 *   W2-5  no "having trouble?" link on the order;
 *   W2-6  a placeholder used twice was filled once.
 * The number is always today's setting, never copied onto an order.
 * ===========================================================================
 */

const suffix = Date.now();
const KEY = 'support.whatsapp';
const ids = {
  owner: '', engineerUser: randomUUID(), contributor: randomUUID(), discipline: randomUUID(),
  product: randomUUID(), method: randomUUID(),
  b1: randomUUID(), b2: randomUUID(), b3: randomUUID(), b4: randomUUID(),
};
const SLUG = `w2-prod-${suffix}`;
let OWNER_RAW: { actorId: string; actorRole: string };
let originalJson = '""';
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const buyer = (id: string): Actor => ({ ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false });
const engineer: Actor = { ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR', contributorId: ids.contributor, contributorActive: true };
const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);

/** Store a raw value exactly as a console would, bypassing the screen. */
const storeRaw = (value: string) =>
  asOwner((tx) => tx.execute(sql`UPDATE settings SET value = to_jsonb(${value}::text) WHERE key = ${KEY}`));

const stored = async () => {
  const [row] = (await asOwner((tx) => tx.execute(sql`
    SELECT value #>> '{}' AS text, jsonb_typeof(value) AS type, is_public FROM settings WHERE key = ${KEY}`))) as unknown as
    Array<{ text: string; type: string; is_public: boolean }>;
  return row!;
};

const settingAudits = () =>
  asOwner((tx) => tx.select().from(auditLogs)
    .where(and(eq(auditLogs.action, 'SETTINGS_CHANGED'), eq(auditLogs.entityId, KEY))));

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  const [row] = (await asOwner((tx) => tx.execute(sql`SELECT value::text AS json FROM settings WHERE key = ${KEY}`))) as unknown as Array<{ json: string }>;
  originalJson = row?.json ?? '""';

  const people = [ids.b1, ids.b2, ids.b3, ids.b4];
  await asOwner(async (tx) => {
    await tx.insert(users).values([
      ...people.map((id, i) => ({
        id, email: `w2-b${i}+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER' as const, status: 'ACTIVE' as const, displayName: `B${i}`,
      })),
      { id: ids.engineerUser, email: `w2-e+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'E' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `w2-eng-${suffix}`,
      settlementCode: `W2E${suffix}`, displayName: 'E', isActive: true,
    });
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `w2-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 93 });
    await tx.insert(products).values({
      id: ids.product, slug: SLUG, titleAr: 'دليل مدفوع', disciplineId: ids.discipline, fileType: 'PDF',
      status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
    });
    await tx.insert(productContributors).values({ productId: ids.product, contributorId: ids.contributor, shareBp: 10000 });
    await tx.insert(productPrices).values({ productId: ids.product, amountMinor: 2500n, currency: 'USD' });
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `w2-wa-${suffix}`, type: 'ASSISTED', displayNameAr: 'المساعدة عبر واتساب',
      instructionsAr: 'سيتم تحويلك إلى محادثة واتساب تحمل تفاصيل طلبك.',
      supportMessageAr: 'طلب {{order}} — أكرر: {{order}} — {{amount}} {{currency}}',
      requiresProof: false, countries: [], currencies: [], isActive: true, sortOrder: 0,
    });
  });
}, 60_000);

afterAll(async () => {
  await asOwner(async (tx) => {
    await tx.execute(sql`UPDATE settings SET value = ${originalJson}::jsonb WHERE key = ${KEY}`);
    const people = [ids.b1, ids.b2, ids.b3, ids.b4];
    await tx.delete(orders).where(inArray(orders.customerId, people));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productContributors).where(eq(productContributors.productId, ids.product));
    await tx.delete(productPrices).where(eq(productPrices.productId, ids.product));
    await tx.delete(products).where(eq(products.id, ids.product));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(inArray(users.id, [...people, ids.engineerUser]));
  });
  await closeDb();
});

// ===========================================================================
describe('1. W2-2 — a stored number is read as the string it is', () => {
  it.each(['963933123456', '+963933123456', '0933123456'])('reads %s back unchanged', async (value) => {
    await storeRaw(value);
    expect((await getPublicSettings()).whatsapp).toBe(value);
  });

  it('other public settings keep their types', async () => {
    const s = await getPublicSettings();
    expect(typeof s.previewPageCount).toBe('number');
    expect(typeof s.showSalesCount).toBe('boolean');
    expect(typeof s.platformName).toBe('string');
  });
});

// ===========================================================================
describe('2. W2-3/W2-4 — the owner sets the number; it is checked, stored for wa.me, audited', () => {
  beforeAll(async () => { await storeRaw(''); });

  it('stores an international number as digits, keeps the row public, and records the change', async () => {
    const before = (await settingAudits()).length;
    await expect(updateWhatsappNumber(owner, '+963 933 123 456')).resolves.toEqual({ changed: true, number: '963933123456' });
    expect(await stored()).toEqual({ text: '963933123456', type: 'string', is_public: true });

    const audits = await settingAudits();
    expect(audits.length).toBe(before + 1);
    const last = audits.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(last.before).toEqual({ value: '' });
    expect(last.after).toEqual({ value: '963933123456' });
    expect(last.actorRole).toBe('OWNER');
    await expect(whatsappSettingForOwner(owner)).resolves.toEqual({ number: '963933123456', usable: true });
  });

  it('the same number written another way changes nothing and records nothing', async () => {
    const before = (await settingAudits()).length;
    await expect(updateWhatsappNumber(owner, '00963933123456')).resolves.toEqual({ changed: false, number: '963933123456' });
    expect((await settingAudits()).length).toBe(before);
  });

  it.each(['0933123456', 'call us', '+963 93'])('refuses %s and keeps the stored number', async (raw) => {
    const before = (await settingAudits()).length;
    await expect(updateWhatsappNumber(owner, raw)).rejects.toThrow(ValidationError);
    expect((await stored()).text).toBe('963933123456');
    expect((await settingAudits()).length).toBe(before);
  });

  it('nobody but the owner can read or set it — through the service or the database', async () => {
    for (const actor of [buyer(ids.b1), engineer, GUEST]) {
      await expect(updateWhatsappNumber(actor, '+966501234567')).rejects.toThrow(RuleViolationError);
      await expect(whatsappSettingForOwner(actor)).rejects.toThrow(RuleViolationError);
    }
    for (const ctx of [
      { actorId: ids.b1, actorRole: 'CUSTOMER', contributorId: '' },
      { actorId: ids.engineerUser, actorRole: 'CONTRIBUTOR', contributorId: ids.contributor },
    ]) {
      await withRawActorContext(ctx, (tx) => tx.update(settings).set({ value: sql`to_jsonb('966501234567'::text)` }).where(eq(settings.key, KEY)));
    }
    expect((await stored()).text).toBe('963933123456');
  });
});

// ===========================================================================
describe('3. the buyer reaches WhatsApp when — and only when — a number is set', () => {
  it('W2-1/W2-6 — choosing WhatsApp returns the chat link, every placeholder filled', async () => {
    const order = await createOrder(buyer(ids.b1), { productSlugs: [SLUG] });
    const view = await checkoutView(buyer(ids.b1), order.orderId);
    expect(view!.methods.map((m) => m.id)).toContain(ids.method);

    const init = await placeOrder(buyer(ids.b1), { orderId: order.orderId, paymentMethodId: ids.method });
    expect(init.kind).toBe('ASSISTED');
    if (init.kind !== 'ASSISTED') return;
    expect(init.url.startsWith('https://wa.me/963933123456?text=')).toBe(true);
    expect(init.messageAr).toBe(`طلب ${order.orderNumber} — أكرر: ${order.orderNumber} — 25.00 USD`);

    // The order page afterwards: no transfer to annotate, and the chat link.
    const after = await checkoutView(buyer(ids.b1), order.orderId);
    expect(after!.payment).toMatchObject({ requiresProof: false, accountDetailsAr: null });
    expect(after!.whatsappHelp).toContain('https://wa.me/963933123456?text=');
    expect(decodeURIComponent(after!.whatsappHelp!.split('text=')[1]!)).toContain(order.orderNumber);
  });

  it('W2-5 — an order waiting for payment carries the "having trouble?" link', async () => {
    const order = await createOrder(buyer(ids.b2), { productSlugs: [SLUG] });
    const view = await checkoutView(buyer(ids.b2), order.orderId);
    expect(view!.whatsappHelp).toMatch(/^https:\/\/wa\.me\/963933123456\?text=/);
  });

  it('an order placed earlier reaches TODAY\'s number — it is never copied onto the order', async () => {
    const [o] = await asOwner((tx) => tx.select({ id: orders.id }).from(orders).where(eq(orders.customerId, ids.b1)));
    await updateWhatsappNumber(owner, '+966 50 123 4567');
    const view = await checkoutView(buyer(ids.b1), o!.id);
    expect(view!.whatsappHelp).toMatch(/^https:\/\/wa\.me\/966501234567\?text=/);
  });

  it('a number no chat can reach (set by hand before this screen) offers nothing', async () => {
    await storeRaw('0933123456');
    const order = await createOrder(buyer(ids.b3), { productSlugs: [SLUG] });
    const view = await checkoutView(buyer(ids.b3), order.orderId);
    expect(view!.methods.map((m) => m.id)).not.toContain(ids.method);
    expect(view!.whatsappHelp).toBeNull();
    await expect(placeOrder(buyer(ids.b3), { orderId: order.orderId, paymentMethodId: ids.method }))
      .rejects.toThrow('طريقة الدفع غير متاحة لهذا الطلب');
    await expect(whatsappSettingForOwner(owner)).resolves.toEqual({ number: '0933123456', usable: false });
  });

  it('clearing the number turns WhatsApp off everywhere — and is recorded', async () => {
    await updateWhatsappNumber(owner, '+963933123456');
    const before = (await settingAudits()).length;
    await expect(updateWhatsappNumber(owner, '   ')).resolves.toEqual({ changed: true, number: '' });
    expect((await settingAudits()).length).toBe(before + 1);

    const order = await createOrder(buyer(ids.b4), { productSlugs: [SLUG] });
    const view = await checkoutView(buyer(ids.b4), order.orderId);
    expect(view!.methods.map((m) => m.id)).not.toContain(ids.method);
    expect(view!.whatsappHelp).toBeNull();
  });
});
