import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withRawActorContext, type Transaction } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, entitlements, orders,
  paymentMethodSecrets, paymentMethods, productContributors, productPrices, products, users,
} from '@/db/schema';
import {
  createPaymentMethod, paymentMethodsForOwner, setPaymentMethodActive, updatePaymentMethod,
  type PaymentMethodFields,
} from './admin';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { checkoutView } from '@/commerce/queries';
import { submitPaymentProof } from '@/commerce/proofs';
import { ConflictError, RuleViolationError, ValidationError } from '@/lib/errors';
import { GUEST, type Actor } from '@/authz/actor';

/**
 * ===========================================================================
 * THE OWNER MANAGES PAYMENT METHODS; ORDERS KEEP WHAT THEY WERE TOLD (F3)
 * ===========================================================================
 * Found by the Stage 2 buyer audit:
 *   F3-1  no screen managed payment methods — only SQL could;
 *   F3-2  the seeded placeholder "يُعبّئها المالك من لوحة الإدارة" was shown
 *         to buyers as the bank account to pay into;
 *   F3-3  the order screen read the method live, so disabling it erased a
 *         waiting order's instructions and receipt upload, and changing the
 *         account silently re-pointed orders already told to pay elsewhere.
 * ===========================================================================
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const suffix = Date.now();
const PRICE = 2500n;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(512).fill(0x20)]);

const ids = {
  owner: '', engineerUser: randomUUID(), contributor: randomUUID(), discipline: randomUUID(), product: randomUUID(),
  a: randomUUID(), b: randomUUID(), c: randomUUID(), d1: randomUUID(), d2: randomUUID(), e: randomUUID(),
};
const SLUG = `f3-prod-${suffix}`;
const createdMethods: string[] = [];

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const buyer = (id: string): Actor => ({ ...base, userId: id, role: 'CUSTOMER', contributorId: null, contributorActive: false });
const engineer: Actor = { ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR', contributorId: ids.contributor, contributorActive: true };
const asOwner = <T,>(fn: (tx: Transaction) => Promise<T>) => withRawActorContext(OWNER_RAW, fn);

const fields = (patch: Partial<PaymentMethodFields> = {}): PaymentMethodFields => ({
  displayNameAr: 'تحويل اختبار F3',
  displayNameEn: null,
  descriptionAr: 'تحويل بنكي للاختبار',
  instructionsAr: 'حوّل المبلغ واكتب رقم الطلب في البيان.',
  accountDetailsAr: 'IBAN SY11 AAAA',
  supportMessageAr: null,
  requiresProof: true,
  countries: [],
  currencies: ['USD'],
  sortOrder: 50,
  ...patch,
});

async function newMethod(code: string, patch: Partial<PaymentMethodFields> = {}, isActive = true): Promise<string> {
  const { id } = await createPaymentMethod(owner, { ...fields(patch), code: `${code}-${suffix}`, type: 'MANUAL', isActive });
  createdMethods.push(id);
  return id;
}

async function auditFor(methodId: string) {
  return asOwner((tx) => tx.select().from(auditLogs)
    .where(and(eq(auditLogs.entityType, 'payment_method'), eq(auditLogs.entityId, methodId)))
    .orderBy(desc(auditLogs.createdAt)));
}

async function orderFor(customerId: string) {
  return createOrder(buyer(customerId), { productSlugs: [SLUG] });
}

const offeredIds = async (customerId: string, orderId: string) =>
  (await checkoutView(buyer(customerId), orderId))!.methods.map((m) => m.id);

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  const customers = [ids.a, ids.b, ids.c, ids.d1, ids.d2, ids.e];
  await asOwner(async (tx) => {
    await tx.insert(users).values([
      ...customers.map((id, i) => ({
        id, email: `f3-c${i}+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER' as const, status: 'ACTIVE' as const, displayName: `C${i}`,
      })),
      { id: ids.engineerUser, email: `f3-e+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `f3-eng-${suffix}`,
      settlementCode: `F3E${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `f3-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 94 });
    await tx.insert(products).values({
      id: ids.product, slug: SLUG, titleAr: 'دليل مدفوع', disciplineId: ids.discipline, fileType: 'PDF',
      status: 'PUBLISHED', currency: 'USD', publishedAt: new Date(),
    });
    await tx.insert(productContributors).values({ productId: ids.product, contributorId: ids.contributor, shareBp: 10000 });
    await tx.insert(productPrices).values({ productId: ids.product, amountMinor: PRICE, currency: 'USD' });
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
  });
}, 60_000);

afterAll(async () => {
  await asOwner(async (tx) => {
    const people = [ids.a, ids.b, ids.c, ids.d1, ids.d2, ids.e];
    await tx.delete(orders).where(inArray(orders.customerId, people));
    await tx.delete(entitlements).where(inArray(entitlements.customerId, people));
    if (createdMethods.length > 0) {
      await tx.delete(paymentMethodSecrets).where(inArray(paymentMethodSecrets.paymentMethodId, createdMethods));
      await tx.delete(paymentMethods).where(inArray(paymentMethods.id, createdMethods));
    }
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
describe('1. the owner manages methods without SQL, and every change is audited', () => {
  let methodId: string;

  it('creates a method — and records it', async () => {
    methodId = await newMethod('f3-admin', {}, false);
    const [row] = await asOwner((tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)));
    expect(row!.isActive).toBe(false);
    expect(row!.accountDetailsAr).toBe('IBAN SY11 AAAA');

    const [audit] = await auditFor(methodId);
    expect(audit!.action).toBe('PAYMENT_METHOD_CHANGED');
    expect(audit!.after).toMatchObject({ event: 'created', type: 'MANUAL', accountDetailsAr: 'IBAN SY11 AAAA' });
  });

  it('edits it — recording exactly what changed', async () => {
    await expect(updatePaymentMethod(owner, methodId, fields({ accountDetailsAr: 'IBAN SY22 BBBB', sortOrder: 7 })))
      .resolves.toEqual({ changed: true });
    const [audit] = await auditFor(methodId);
    expect(audit!.before).toMatchObject({ accountDetailsAr: 'IBAN SY11 AAAA', sortOrder: 50 });
    expect(audit!.after).toMatchObject({ event: 'updated', accountDetailsAr: 'IBAN SY22 BBBB', sortOrder: 7 });
    expect(Object.keys(audit!.after as object).sort()).toEqual(['accountDetailsAr', 'code', 'event', 'sortOrder']);
  });

  it('a save that changes nothing writes nothing', async () => {
    const before = (await auditFor(methodId)).length;
    await expect(updatePaymentMethod(owner, methodId, fields({ accountDetailsAr: 'IBAN SY22 BBBB', sortOrder: 7 })))
      .resolves.toEqual({ changed: false });
    expect((await auditFor(methodId)).length).toBe(before);
  });

  it('enables and disables it — each recorded, a repeated click a no-op', async () => {
    await setPaymentMethodActive(owner, { methodId, isActive: true });
    expect((await auditFor(methodId))[0]!.after).toMatchObject({ event: 'enabled', isActive: true });
    await setPaymentMethodActive(owner, { methodId, isActive: false });
    expect((await auditFor(methodId))[0]!.after).toMatchObject({ event: 'disabled', isActive: false });
    const count = (await auditFor(methodId)).length;
    await expect(setPaymentMethodActive(owner, { methodId, isActive: false })).resolves.toEqual({ changed: false });
    expect((await auditFor(methodId)).length).toBe(count);
  });

  it('refuses a duplicate code, a malformed code and a malformed currency', async () => {
    await expect(createPaymentMethod(owner, { ...fields(), code: `f3-admin-${suffix}`, type: 'MANUAL', isActive: false }))
      .rejects.toThrow(ConflictError);
    await expect(createPaymentMethod(owner, { ...fields(), code: 'Bad Code', type: 'MANUAL', isActive: false }))
      .rejects.toThrow(ValidationError);
    await expect(updatePaymentMethod(owner, methodId, fields({ currencies: ['US DOLLAR'] })))
      .rejects.toThrow(ValidationError);
  });

  it('lists every method with why an active one is not offered', async () => {
    const incomplete = await newMethod('f3-listed', { accountDetailsAr: null });
    const rows = await paymentMethodsForOwner(owner);
    const row = rows.find((r) => r.id === incomplete)!;
    expect(row.isActive).toBe(true);
    expect(row.offeredToBuyers).toBe(false);
    expect(row.gaps).toEqual(['ينقصها: بيانات الحساب']);
    expect(rows.find((r) => r.id === methodId)!.offeredToBuyers).toBe(false); // disabled
  });

  it('nobody but the owner can do any of it', async () => {
    for (const actor of [buyer(ids.a), engineer, GUEST]) {
      await expect(createPaymentMethod(actor, { ...fields(), code: `f3-x-${suffix}`, type: 'MANUAL', isActive: true }))
        .rejects.toThrow(RuleViolationError);
      await expect(updatePaymentMethod(actor, methodId, fields({ accountDetailsAr: 'IBAN ATTACKER' })))
        .rejects.toThrow(RuleViolationError);
      await expect(setPaymentMethodActive(actor, { methodId, isActive: true })).rejects.toThrow(RuleViolationError);
      await expect(paymentMethodsForOwner(actor)).rejects.toThrow(RuleViolationError);
    }
    const [row] = await asOwner((tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)));
    expect(row!.accountDetailsAr).toBe('IBAN SY22 BBBB');
    expect(row!.isActive).toBe(false);
  });
});

// ===========================================================================
describe('2. the buyer sees only complete, active methods', () => {
  it('A — a complete active method is offered, and the buyer can pay by it end to end', async () => {
    const methodId = await newMethod('f3-complete', { accountDetailsAr: 'IBAN SY33 CCCC' });
    const order = await orderFor(ids.a);
    expect(await offeredIds(ids.a, order.orderId)).toContain(methodId);

    const init = await placeOrder(buyer(ids.a), { orderId: order.orderId, paymentMethodId: methodId });
    expect(init).toMatchObject({ kind: 'INSTRUCTIONS', accountDetailsAr: 'IBAN SY33 CCCC', requiresProof: true });

    const view = await checkoutView(buyer(ids.a), order.orderId);
    expect(view!.payment).toMatchObject({
      methodName: 'تحويل اختبار F3', accountDetailsAr: 'IBAN SY33 CCCC', requiresProof: true,
      instructionsAr: 'حوّل المبلغ واكتب رقم الطلب في البيان.',
    });

    await submitPaymentProof(buyer(ids.a), { paymentId: view!.payment!.id, filename: 'r.png', body: PNG });
    await expect(approvePayment(owner, { paymentId: view!.payment!.id })).resolves.toMatchObject({ entitlementsGranted: 1 });
  });

  it('B — an active method missing its account details is not offered, and cannot be forced', async () => {
    const methodId = await newMethod('f3-noaccount', { accountDetailsAr: '   ' });
    const order = await orderFor(ids.b);
    expect(await offeredIds(ids.b, order.orderId)).not.toContain(methodId);
    // E — naming its id directly is refused server-side.
    await expect(placeOrder(buyer(ids.b), { orderId: order.orderId, paymentMethodId: methodId }))
      .rejects.toThrow('طريقة الدفع غير متاحة لهذا الطلب');
  });

  it('B — nor is one missing its instructions', async () => {
    const methodId = await newMethod('f3-noinstructions', { instructionsAr: null });
    const order = await orderFor(ids.e);
    expect(await offeredIds(ids.e, order.orderId)).not.toContain(methodId);
  });

  it('completing it from the owner screen is what makes it appear', async () => {
    const methodId = await newMethod('f3-fillin', { accountDetailsAr: null });
    const [order] = await asOwner((tx) => tx.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.customerId, ids.e), eq(orders.status, 'DRAFT'))));
    expect(await offeredIds(ids.e, order!.id)).not.toContain(methodId);
    await updatePaymentMethod(owner, methodId, fields({ accountDetailsAr: 'IBAN SY44 DDDD' }));
    expect(await offeredIds(ids.e, order!.id)).toContain(methodId);
  });
});

// ===========================================================================
describe('3. disabling a method hides it from new orders, never from placed ones', () => {
  it('C — a waiting order keeps its instructions, account and receipt upload', async () => {
    const methodId = await newMethod('f3-disable', { accountDetailsAr: 'IBAN SY55 EEEE' });
    const placed = await orderFor(ids.c);
    await placeOrder(buyer(ids.c), { orderId: placed.orderId, paymentMethodId: methodId });

    const fresh = await orderFor(ids.d1);
    expect(await offeredIds(ids.d1, fresh.orderId)).toContain(methodId);

    await setPaymentMethodActive(owner, { methodId, isActive: false });

    // New orders: gone, and not reachable by id.
    expect(await offeredIds(ids.d1, fresh.orderId)).not.toContain(methodId);
    await expect(placeOrder(buyer(ids.d1), { orderId: fresh.orderId, paymentMethodId: methodId }))
      .rejects.toThrow('طريقة الدفع غير متاحة لهذا الطلب');

    // The order already told to pay: unchanged, still able to send its receipt.
    const view = await checkoutView(buyer(ids.c), placed.orderId);
    expect(view!.payment).toMatchObject({
      methodName: 'تحويل اختبار F3', accountDetailsAr: 'IBAN SY55 EEEE', requiresProof: true,
      instructionsAr: 'حوّل المبلغ واكتب رقم الطلب في البيان.',
    });
    await submitPaymentProof(buyer(ids.c), { paymentId: view!.payment!.id, filename: 'r.png', body: PNG });
    const [row] = await asOwner((tx) => tx.select({ s: orders.status }).from(orders).where(eq(orders.id, placed.orderId)));
    expect(row!.s).toBe('PROOF_SUBMITTED');
  });
});

// ===========================================================================
describe('4. D — changing the account does not re-point orders already placed', () => {
  it('the old order shows A, the new order B', async () => {
    const methodId = await newMethod('f3-account', { accountDetailsAr: 'IBAN SY66 A' });

    const first = await orderFor(ids.d2);
    await placeOrder(buyer(ids.d2), { orderId: first.orderId, paymentMethodId: methodId });

    await updatePaymentMethod(owner, methodId, fields({ accountDetailsAr: 'IBAN SY77 B', instructionsAr: 'تعليمات جديدة' }));

    const old = await checkoutView(buyer(ids.d2), first.orderId);
    expect(old!.payment!.accountDetailsAr).toBe('IBAN SY66 A');
    expect(old!.payment!.instructionsAr).toBe('حوّل المبلغ واكتب رقم الطلب في البيان.');

    // A new order (d1's, still DRAFT from section 3) is told the current account.
    const [draft] = await asOwner((tx) => tx.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.customerId, ids.d1), eq(orders.status, 'DRAFT'))));
    const init = await placeOrder(buyer(ids.d1), { orderId: draft!.id, paymentMethodId: methodId });
    expect(init).toMatchObject({ kind: 'INSTRUCTIONS', accountDetailsAr: 'IBAN SY77 B' });
    const current = await checkoutView(buyer(ids.d1), draft!.id);
    expect(current!.payment!.accountDetailsAr).toBe('IBAN SY77 B');
    expect(current!.payment!.instructionsAr).toBe('تعليمات جديدة');
  });
});

// ===========================================================================
describe('5. RLS and secrets stay as they were', () => {
  const RAW = (id: string, role = 'CUSTOMER', contributorId = '') => ({ actorId: id, actorRole: role, contributorId });

  it('a customer or engineer writing payment_methods directly changes nothing', async () => {
    const target = createdMethods[0]!;
    for (const ctx of [RAW(ids.a), RAW(ids.engineerUser, 'CONTRIBUTOR', ids.contributor)]) {
      await withRawActorContext(ctx, (tx) =>
        tx.update(paymentMethods).set({ accountDetailsAr: 'IBAN ATTACKER', isActive: true }).where(eq(paymentMethods.id, target)));
      await expect(withRawActorContext(ctx, (tx) => tx.insert(paymentMethods).values({
        code: `f3-evil-${suffix}`, type: 'MANUAL', displayNameAr: 'x', instructionsAr: 'x', accountDetailsAr: 'x', isActive: true,
      }))).rejects.toThrow();
    }
    const [row] = await asOwner((tx) => tx.select().from(paymentMethods).where(eq(paymentMethods.id, target)));
    expect(row!.accountDetailsAr).toBe('IBAN SY22 BBBB');
    expect(row!.isActive).toBe(false);
  });

  it('a customer sees no inactive method and no secret', async () => {
    const target = createdMethods[0]!; // disabled in section 1
    await asOwner((tx) => tx.insert(paymentMethodSecrets).values({ paymentMethodId: target, configEncrypted: 'SECRET-F3-CANARY' }));

    const [hidden, secrets] = await withRawActorContext(RAW(ids.a), (tx) => Promise.all([
      tx.select().from(paymentMethods).where(eq(paymentMethods.id, target)),
      tx.select().from(paymentMethodSecrets),
    ]));
    expect(hidden).toHaveLength(0);
    expect(secrets).toHaveLength(0);
  });

  it('no secret reaches the owner screen or the audit log', async () => {
    const target = createdMethods[0]!;
    await updatePaymentMethod(owner, target, fields({ accountDetailsAr: 'IBAN SY88 AUDIT' }));
    const listed = JSON.stringify(await paymentMethodsForOwner(owner));
    expect(listed).not.toContain('SECRET-F3-CANARY');
    const logged = await asOwner((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(auditLogs)
      .where(sql`${auditLogs.before}::text LIKE '%SECRET-F3-CANARY%' OR ${auditLogs.after}::text LIKE '%SECRET-F3-CANARY%'`));
    expect(logged[0]!.n).toBe(0);
  });
});

// ===========================================================================
describe('6. the seed writes no account and no placeholder (F3-2)', () => {
  const SEED_CODES = ['bank-transfer', 'shamcash', 'whatsapp-assist', 'card-gateway'];

  it('seeded manual methods carry no account details, and are not offered until the owner adds one', async () => {
    const existing = await asOwner((tx) => tx.select({ code: paymentMethods.code }).from(paymentMethods)
      .where(inArray(paymentMethods.code, SEED_CODES)));
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/seed-payment-methods.ts'], {
      cwd: ROOT, env: process.env, stdio: 'pipe',
    });
    try {
      const seeded = await asOwner((tx) => tx.select().from(paymentMethods).where(inArray(paymentMethods.code, SEED_CODES)));
      const added = seeded.filter((m) => !existing.some((e) => e.code === m.code));
      for (const method of added.filter((m) => m.type === 'MANUAL')) {
        expect(method.accountDetailsAr).toBeNull();
      }
      const placeholders = await asOwner((tx) => tx.select({ id: paymentMethods.id }).from(paymentMethods)
        .where(sql`${paymentMethods.accountDetailsAr} LIKE '%يُعبّئها المالك%'`));
      expect(placeholders).toHaveLength(0);

      // Customer b still has a DRAFT order from section 2.
      const [draft] = await asOwner((tx) => tx.select({ id: orders.id }).from(orders)
        .where(and(eq(orders.customerId, ids.b), eq(orders.status, 'DRAFT'))));
      const offered = (await checkoutView(buyer(ids.b), draft!.id))!.methods.map((m) => m.code);
      for (const method of added.filter((m) => m.type === 'MANUAL')) {
        expect(offered).not.toContain(method.code);
      }
    } finally {
      // Leave the database as this file found it.
      const added = SEED_CODES.filter((code) => !existing.some((e) => e.code === code));
      if (added.length > 0) {
        await asOwner((tx) => tx.delete(paymentMethods).where(inArray(paymentMethods.code, added)));
      }
    }
  }, 60_000);
});
