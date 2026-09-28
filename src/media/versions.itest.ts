import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import postgres from 'postgres';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import {
  auditLogs, commissionAgreements, contributors, disciplines, downloadEvents, entitlements,
  invoices, orderItems, orders, paymentMethods, payments, productContributors, productFiles,
  productPrices, products, productVersions, settings, users,
} from '@/db/schema';
import { serverEnv } from '@/lib/config/env';
import { approvePayment, createOrder, placeOrder } from '@/commerce/orders';
import { myPurchases, purchaseState } from '@/commerce/queries';
import { changeProductStatus, updateProductDetails } from '@/catalog/products';
import { productBySlug } from '@/catalog/public-queries';
import { deliverProductFile } from './deliver';
import { ingestProductFile } from './ingest';
import { activateVersion, deleteVersion, purgeRetiredVersionFiles } from './versions';
import { getStorage, type BucketName } from './storage';
import { GUEST, type Actor } from '@/authz/actor';
import { withFinancialPurge } from '@/db/testing/financial-purge';

/**
 * ===========================================================================
 * STAGE 4 REPAIR — VERSIONS, THE SIX-MONTH WINDOW, UPGRADES, DELETION
 * ===========================================================================
 *   S4-03  a buyer downloads for six months from THEIR purchase, whatever
 *          happens to the product, and not a day after;
 *   S4-04  a file replaced on a product on sale is a new version that waits
 *          for the owner's release, under the same checks as a publication;
 *   S4-05  a refused or failed upload leaves no object behind, and a retired
 *          version's objects go only when nobody can still claim them;
 *   S4-06  a title of spaces is refused by the service and by the database;
 *   S4-07  a download is counted only once the bytes are in hand;
 *   S4-08  the Stage 4 definer functions cannot be shadowed by a temp table;
 *   S4-09  a V1 buyer keeps V1 and may buy V2 at the configured upgrade price;
 *   S4-10  only the owner deletes a version, history stays, buyers keep access.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '',
  buyerA: randomUUID(), buyerB: randomUUID(), buyerC: randomUUID(), buyerD: randomUUID(),
  engineerUser: randomUUID(), contributor: randomUUID(),
  outsiderUser: randomUUID(), outsider: randomUUID(),
  discipline: randomUUID(), product: randomUUID(), scratch: randomUUID(), doomed: randomUUID(),
  method: randomUUID(),
};
const slug = `s4-prod-${suffix}`;
const PRICE = 2000n;

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'مشترٍ', locale: 'ar', sessionId: 's' } as const;
let owner: Actor;
const customer = (userId: string): Actor => ({ ...base, userId, role: 'CUSTOMER', contributorId: null, contributorActive: false });
const buyerA = customer(ids.buyerA);
const buyerB = customer(ids.buyerB);
const buyerC = customer(ids.buyerC);
const buyerD = customer(ids.buyerD);
const engineer: Actor = { ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR', contributorId: ids.contributor, contributorActive: true };
const outsider: Actor = { ...base, userId: ids.outsiderUser, role: 'CONTRIBUTOR', contributorId: ids.outsider, contributorActive: true };

const asOwner = <T>(fn: Parameters<typeof withRawActorContext<T>>[1]) => withRawActorContext(OWNER_RAW, fn);

async function buildPdf(label: string, pages = 8): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    doc.addPage([595, 842]).drawText(`${label} PAGE-${i}`, { x: 50, y: 700, size: 24, font });
  }
  return doc.save();
}

/** Every object in both buckets, whichever adapter the environment uses. */
async function objectCount(): Promise<number> {
  const env = serverEnv();
  if (env.STORAGE_ENDPOINT.startsWith('file:')) {
    let total = 0;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else total += 1;
      }
    };
    const root = env.STORAGE_ENDPOINT.replace(/^file:\/\//, '');
    walk(join(root, 'originals'));
    walk(join(root, 'derivatives'));
    return total;
  }
  const client = new S3Client({
    endpoint: env.STORAGE_ENDPOINT, region: env.STORAGE_REGION, forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY },
  });
  let total = 0;
  for (const bucket of [env.STORAGE_BUCKET_ORIGINALS, env.STORAGE_BUCKET_DERIVATIVES]) {
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      total += page.KeyCount ?? 0;
      token = page.NextContinuationToken;
    } while (token);
  }
  return total;
}

async function buy(buyer: Actor): Promise<{ orderId: string; totalMinor: bigint }> {
  const order = await createOrder(buyer, { productSlugs: [slug] });
  await placeOrder(buyer, { orderId: order.orderId, paymentMethodId: ids.method });
  const [payment] = await asOwner((tx) =>
    tx.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order.orderId)));
  await approvePayment(owner, { paymentId: payment!.id });
  return { orderId: order.orderId, totalMinor: order.totalMinor };
}

async function versionsOf(productId: string) {
  return asOwner((tx) => tx.select().from(productVersions)
    .where(eq(productVersions.productId, productId)).orderBy(productVersions.versionNo));
}

async function currentVersionId(productId: string): Promise<string | null> {
  const [row] = await asOwner((tx) => tx.select({ v: products.currentVersionId }).from(products).where(eq(products.id, productId)));
  return row?.v ?? null;
}

async function filesOf(versionId: string) {
  return asOwner((tx) => tx.select().from(productFiles).where(eq(productFiles.versionId, versionId)));
}

async function trail(customerId: string) {
  const [grant] = await asOwner((tx) => tx.select({ n: sql<number>`coalesce(sum(download_count), 0)::int` })
    .from(entitlements).where(eq(entitlements.customerId, customerId)));
  const [events] = await asOwner((tx) => tx.select({ n: sql<number>`count(*)::int` })
    .from(downloadEvents).where(eq(downloadEvents.userId, customerId)));
  return { counted: grant?.n ?? 0, events: events?.n ?? 0 };
}

let V1 = '';
let V2 = '';

beforeAll(async () => {
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await asOwner(async (tx) => {
    await tx.insert(users).values([
      ...[ids.buyerA, ids.buyerB, ids.buyerC, ids.buyerD].map((id, i) => ({
        id, email: `s4-buyer${i}+${suffix}@test.local`, passwordHash: 'x', role: 'CUSTOMER' as const,
        status: 'ACTIVE' as const, displayName: `مشترٍ ${i}`, countryCode: 'SY',
      })),
      { id: ids.engineerUser, email: `s4-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
      { id: ids.outsiderUser, email: `s4-out+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Outsider' },
    ]);
    await tx.insert(contributors).values([
      { id: ids.contributor, userId: ids.engineerUser, publicSlug: `s4-eng-${suffix}`, settlementCode: `S4E${suffix}`, displayName: 'Engineer', isActive: true },
      { id: ids.outsider, userId: ids.outsiderUser, publicSlug: `s4-out-${suffix}`, settlementCode: `S4O${suffix}`, displayName: 'Outsider', isActive: true },
    ]);
    await tx.insert(disciplines).values({ id: ids.discipline, slug: `s4-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 94 });
    await tx.insert(products).values([
      { id: ids.product, slug, titleAr: 'دليل الإصدارات', disciplineId: ids.discipline, fileType: 'PDF', status: 'APPROVED', currency: 'USD' },
      { id: ids.scratch, slug: `s4-scratch-${suffix}`, titleAr: 'مسودة', disciplineId: ids.discipline, fileType: 'PDF', status: 'DRAFT', currency: 'USD' },
      { id: ids.doomed, slug: `s4-doomed-${suffix}`, titleAr: 'يُحذف أثناء الرفع', disciplineId: ids.discipline, fileType: 'PDF', status: 'DRAFT', currency: 'USD' },
    ]);
    await tx.insert(productContributors).values({ productId: ids.product, contributorId: ids.contributor, shareBp: 10000 });
    await tx.insert(productPrices).values({ productId: ids.product, amountMinor: PRICE, currency: 'USD' });
    await tx.insert(commissionAgreements).values({
      contributorId: ids.contributor, productId: null, model: 'PERCENTAGE', engineerBp: 8000, currency: 'USD', createdBy: ids.owner,
    });
    await tx.insert(paymentMethods).values({
      id: ids.method, code: `s4-bank-${suffix}`, type: 'MANUAL', displayNameAr: 'تحويل', instructionsAr: 'حوّل',
      accountDetailsAr: 'IBAN TEST', requiresProof: false, countries: [], currencies: ['USD'], isActive: true, sortOrder: 1,
    });
  });

  // V1 through the real pipeline, before the product is on sale: it becomes
  // the product's file at once, and the publication gate checks it.
  const first = await ingestProductFile(owner, {
    productId: ids.product, filename: 'v1.pdf', declaredType: 'PDF', body: await buildPdf('V1'), contentType: 'application/pdf',
  });
  expect(first.activated).toBe(true);
  V1 = first.versionId;
  await changeProductStatus(owner, { productId: ids.product, to: 'PUBLISHED' });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  const buyers = [ids.buyerA, ids.buyerB, ids.buyerC, ids.buyerD];
  const productIds = [ids.product, ids.scratch, ids.doomed];
  // Superuser + explicit flag: these fixtures became financial history (S5-03).
  await withFinancialPurge(async (tx) => {
    await tx.update(settings).set({ value: 5000 }).where(eq(settings.key, 'catalog.upgradeDiscountBp'));
    await tx.delete(entitlements).where(inArray(entitlements.customerId, buyers));
    await tx.delete(orders).where(inArray(orders.customerId, buyers));
    await tx.delete(paymentMethods).where(eq(paymentMethods.id, ids.method));
    await tx.delete(commissionAgreements).where(eq(commissionAgreements.contributorId, ids.contributor));
    await tx.delete(productContributors).where(inArray(productContributors.productId, productIds));
    await tx.delete(products).where(inArray(products.id, productIds));
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(inArray(contributors.id, [ids.contributor, ids.outsider]));
    await tx.delete(users).where(inArray(users.id, [...buyers, ids.engineerUser, ids.outsiderUser]));
  });
  await closeDb();
});

const original = (actor: Actor, versionId?: string) =>
  deliverProductFile(actor, { productSlug: slug, role: 'ORIGINAL', ...(versionId ? { versionId } : {}) });

describe('S4-03 — six months from the purchase, whatever happens to the product', () => {
  it('1. a buyer who paid downloads the file, and the window is purchase date + the setting', async () => {
    await buy(buyerA);
    const [grant] = await asOwner((tx) => tx.select({
      versionId: entitlements.versionId,
      exact: sql<boolean>`${entitlements.expiresAt} = ${entitlements.grantedAt} + interval '6 months'`,
    }).from(entitlements).where(eq(entitlements.customerId, ids.buyerA)));
    expect(grant).toEqual({ versionId: V1, exact: true });

    const delivery = await original(buyerA);
    expect(delivery.filename).toBe('v1.pdf');
  });

  it('2. while the product is published', async () => {
    expect((await original(buyerA)).grant.kind).toBe('stream');
  });

  it('3. after the product is unpublished, within the window', async () => {
    await changeProductStatus(owner, { productId: ids.product, to: 'UNPUBLISHED' });
    try {
      expect((await original(buyerA)).filename).toBe('v1.pdf');
      // …while it has left the catalogue for everyone else.
      expect(await productBySlug(slug)).toBeNull();
      await expect(deliverProductFile(GUEST, { productSlug: slug, role: 'PREVIEW' })).rejects.toThrow();
      // Seeing it is not buying it: the buyer cannot order an unpublished product.
      await expect(createOrder(buyerB, { productSlugs: [slug] })).rejects.toThrow('غير متاح');
      const mine = await myPurchases(buyerA);
      expect(mine.owned.find((o) => o.versionId === V1)).toMatchObject({ windowOpen: true, downloadable: true });
    } finally {
      await changeProductStatus(owner, { productId: ids.product, to: 'PUBLISHED' });
    }
  });

  it('5. not after the window: a purchase seven months old is history, not access', async () => {
    // A grant dated seven months back, as the trigger would have written it
    // then; the window is computed from that date, never supplied.
    await asOwner((tx) => tx.insert(entitlements).values({
      customerId: ids.buyerC, productId: ids.product, versionId: V1,
      grantedAt: new Date(Date.now() - 212 * 24 * 3600 * 1000),
    }));
    const before = await trail(ids.buyerC);
    await expect(original(buyerC)).rejects.toThrow('الملف غير متاح');
    await expect(original(buyerC, V1)).rejects.toThrow('الملف غير متاح');
    expect(await trail(ids.buyerC)).toEqual(before);

    const mine = await myPurchases(buyerC);
    expect(mine.owned[0]).toMatchObject({ windowOpen: false, downloadable: false });
    expect(await purchaseState(buyerC, ids.product)).toMatchObject({ kind: 'OWNED', windowOpen: false });
    // Bought once per version: no second purchase of V1 (owner decision).
    await expect(createOrder(buyerC, { productSlugs: [slug] })).rejects.toThrow('ضمن مشترياتك');
  });

  it('5b. the counter refuses an expired grant even when called directly', async () => {
    const [grant] = await asOwner((tx) => tx.select({ id: entitlements.id }).from(entitlements)
      .where(eq(entitlements.customerId, ids.buyerC)));
    await expect(withRawActorContext({ actorId: ids.buyerC, actorRole: 'CUSTOMER' }, (tx) =>
      tx.execute(sql`SELECT app_record_entitlement_download(${grant!.id}::uuid)`))).rejects.toThrow();
  });

  it('5c. the window cannot be supplied, stretched by a future date, or moved afterwards', async () => {
    const future = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
    const [row] = await asOwner((tx) => tx.insert(entitlements).values({
      customerId: ids.buyerD, productId: ids.product, versionId: V1, grantedAt: future, expiresAt: future,
    }).returning({ id: entitlements.id, grantedAt: entitlements.grantedAt, expiresAt: entitlements.expiresAt }));
    expect(row!.grantedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row!.expiresAt.getTime()).toBeLessThan(future.getTime());
    await expect(asOwner((tx) => tx.update(entitlements).set({ expiresAt: future }).where(eq(entitlements.id, row!.id))))
      .rejects.toThrow();
    await asOwner((tx) => tx.delete(entitlements).where(eq(entitlements.id, row!.id)));
  });

  it('6. another customer cannot download what A bought — by default or by naming the version', async () => {
    await expect(original(buyerB)).rejects.toThrow('الملف غير متاح');
    await expect(original(buyerB, V1)).rejects.toThrow('الملف غير متاح');
  });

  it('7. a visitor cannot download the original', async () => {
    await expect(original(GUEST)).rejects.toThrow('الملف غير متاح');
  });

  it('8. an engineer not credited on the product cannot download it', async () => {
    await expect(original(outsider)).rejects.toThrow('الملف غير متاح');
  });

  it('9. the owner downloads any version', async () => {
    const delivery = await original(owner, V1);
    expect(delivery.filename).toBe('v1.pdf');
  });
});

describe('S4-04 / S4-05 — a replacement is a new version, and a failed one leaves nothing', () => {
  it('a refused file (a broken PDF) changes nothing and stores nothing', async () => {
    const versionsBefore = (await versionsOf(ids.product)).length;
    const objectsBefore = await objectCount();
    await expect(ingestProductFile(owner, {
      productId: ids.product, filename: 'broken.pdf', declaredType: 'PDF',
      body: new TextEncoder().encode('%PDF-1.7\nthis is not a pdf'), contentType: 'application/pdf',
    })).rejects.toThrow();
    expect((await versionsOf(ids.product)).length).toBe(versionsBefore);
    expect(await currentVersionId(ids.product)).toBe(V1);
    expect(await objectCount()).toBe(objectsBefore);
    expect((await original(buyerA)).filename).toBe('v1.pdf');
  });

  it('a file of another type than the product is refused before anything is stored', async () => {
    const objectsBefore = await objectCount();
    await expect(ingestProductFile(owner, {
      productId: ids.product, filename: 'plan.dwg', declaredType: 'CAD',
      body: new Uint8Array(64), contentType: 'image/vnd.dwg',
    })).rejects.toThrow('نوع الملف المرفوع لا يطابق نوع المنتج');
    expect(await objectCount()).toBe(objectsBefore);
  });

  it('a storage failure half-way removes the object already written', async () => {
    const storage = getStorage();
    const realPut = storage.put.bind(storage);
    const spy = vi.spyOn(storage, 'put').mockImplementation(async (bucket, key, body, type) => {
      if (bucket === 'derivatives') throw new Error('simulated storage outage');
      return realPut(bucket, key, body, type);
    });
    const objectsBefore = await objectCount();
    try {
      await expect(ingestProductFile(owner, {
        productId: ids.product, filename: 'v2.pdf', declaredType: 'PDF', body: await buildPdf('V2'), contentType: 'application/pdf',
      })).rejects.toThrow('simulated storage outage');
    } finally {
      spy.mockRestore();
    }
    expect(await objectCount()).toBe(objectsBefore);
    expect(await currentVersionId(ids.product)).toBe(V1);
  });

  it('a database failure after storage removes both objects', async () => {
    // The product disappears between the upload and its record: the version
    // cannot be written, and nothing may point at the objects just stored.
    const storage = getStorage();
    const realPut = storage.put.bind(storage);
    const spy = vi.spyOn(storage, 'put').mockImplementation(async (bucket, key, body, type) => {
      const written = await realPut(bucket, key, body, type);
      if (bucket === 'derivatives') await asOwner((tx) => tx.delete(products).where(eq(products.id, ids.doomed)));
      return written;
    });
    const objectsBefore = await objectCount();
    try {
      await expect(ingestProductFile(owner, {
        productId: ids.doomed, filename: 'doomed.pdf', declaredType: 'PDF', body: await buildPdf('D'), contentType: 'application/pdf',
      })).rejects.toThrow('المنتج غير موجود');
    } finally {
      spy.mockRestore();
    }
    expect(await objectCount()).toBe(objectsBefore);
  });

  it('a valid replacement on a product on sale WAITS; buyers and new customers still get V1', async () => {
    const uploaded = await ingestProductFile(owner, {
      productId: ids.product, filename: 'v2.pdf', declaredType: 'PDF', body: await buildPdf('V2'), contentType: 'application/pdf',
    });
    expect(uploaded).toMatchObject({ activated: false, versionNo: 2 });
    V2 = uploaded.versionId;
    expect(await currentVersionId(ids.product)).toBe(V1);
    expect((await original(buyerA)).filename).toBe('v1.pdf');
    const [audit] = await asOwner((tx) => tx.select({ after: auditLogs.after }).from(auditLogs)
      .where(eq(auditLogs.entityId, uploaded.originalFileId)));
    expect(audit?.after).toMatchObject({ versionNo: 2, waitsForRelease: true });
  });

  it('release re-runs the publication file checks on the waiting version', async () => {
    // Take the preview away from V2: a PDF without a preview may not go on sale.
    const preview = (await filesOf(V2)).find((f) => f.role === 'PREVIEW')!;
    await asOwner((tx) => tx.delete(productFiles).where(eq(productFiles.id, preview.id)));
    try {
      await expect(activateVersion(owner, { productId: ids.product, versionId: V2 })).rejects.toThrow('معاينة');
      expect(await currentVersionId(ids.product)).toBe(V1);
    } finally {
      await asOwner((tx) => tx.insert(productFiles).values(preview));
    }
  });

  it('only the owner releases a version', async () => {
    for (const actor of [buyerA, engineer, outsider, GUEST]) {
      await expect(activateVersion(actor, { productId: ids.product, versionId: V2 })).rejects.toThrow();
    }
    expect(await currentVersionId(ids.product)).toBe(V1);
  });

  it('the owner releases V2; V1 and its files stay for the buyers inside their window', async () => {
    expect(await activateVersion(owner, { productId: ids.product, versionId: V2 })).toEqual({ versionNo: 2 });
    expect(await currentVersionId(ids.product)).toBe(V2);
    const v1 = (await versionsOf(ids.product)).find((v) => v.id === V1)!;
    expect(v1.supersededAt).not.toBeNull();
    expect(v1.filesPurgedAt).toBeNull();
    for (const f of await filesOf(V1)) {
      expect(await getStorage().exists(f.bucket as BucketName, f.storageKey)).toBe(true);
    }
    // A says: still V1 — they did not buy V2.
    expect((await original(buyerA)).filename).toBe('v1.pdf');
    await expect(original(buyerA, V2)).rejects.toThrow('الملف غير متاح');
  });
});

describe('S4-09 — V1 buyers keep V1 and may buy V2 at the upgrade price', () => {
  it('offers A the upgrade at 50% of the current price, and lists it on "my purchases"', async () => {
    expect(await purchaseState(buyerA, ids.product)).toMatchObject({
      kind: 'UPGRADE', heldVersionNo: 1, listMinor: PRICE, priceMinor: 1000n,
    });
    const mine = await myPurchases(buyerA);
    expect(mine.owned.find((o) => o.versionId === V1)).toMatchObject({ upgradeAvailable: true, downloadable: true });
  });

  it('offers the upgrade even after the V1 window closed (owner decision)', async () => {
    expect(await purchaseState(buyerC, ids.product)).toMatchObject({ kind: 'UPGRADE', priceMinor: 1000n, heldWindowOpen: false });
  });

  it('reads the discount from settings — a changed row changes the price, a missing row refuses', async () => {
    await asOwner((tx) => tx.update(settings).set({ value: 2500 }).where(eq(settings.key, 'catalog.upgradeDiscountBp')));
    try {
      expect(await purchaseState(buyerC, ids.product)).toMatchObject({ kind: 'UPGRADE', priceMinor: 1500n });
    } finally {
      await asOwner((tx) => tx.update(settings).set({ value: 5000 }).where(eq(settings.key, 'catalog.upgradeDiscountBp')));
    }
    await asOwner((tx) => tx.update(settings).set({ value: 'half' }).where(eq(settings.key, 'catalog.upgradeDiscountBp')));
    try {
      await expect(createOrder(buyerC, { productSlugs: [slug] })).rejects.toThrow('catalog.upgradeDiscountBp');
      expect(await purchaseState(buyerC, ids.product)).toMatchObject({ kind: 'UPGRADE', priceMinor: null });
    } finally {
      await asOwner((tx) => tx.update(settings).set({ value: 5000 }).where(eq(settings.key, 'catalog.upgradeDiscountBp')));
    }
  });

  it('A buys V2 as an upgrade: the line names V2, carries the discount, and commission is on the price after it', async () => {
    const { orderId, totalMinor } = await buy(buyerA);
    expect(totalMinor).toBe(1000n);
    const [line] = await asOwner((tx) => tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)));
    expect(line).toMatchObject({ versionId: V2, isUpgrade: true, unitPriceMinor: PRICE, discountMinor: 1000n });
    // The split is taken from what was paid (OPEN-1): tax + engineer + platform = 1000.
    expect((line!.taxMinor ?? 0n) + line!.engineerAmountMinor! + line!.platformAmountMinor!).toBe(1000n);
    const [invoice] = await asOwner((tx) => tx.select().from(invoices).where(eq(invoices.orderId, orderId)));
    expect(invoice).toMatchObject({ listMinor: PRICE, discountMinor: 1000n });

    expect(await purchaseState(buyerA, ids.product)).toMatchObject({ kind: 'OWNED', windowOpen: true });
    // Default is the version on sale now that A holds it; V1 stays reachable by name.
    expect((await original(buyerA)).filename).toBe('v2.pdf');
    expect((await original(buyerA, V1)).filename).toBe('v1.pdf');
    const grants = await asOwner((tx) => tx.select({ v: entitlements.versionId }).from(entitlements)
      .where(eq(entitlements.customerId, ids.buyerA)));
    expect(grants.map((g) => g.v).sort()).toEqual([V1, V2].sort());
  });

  it('a new customer pays the full price for V2', async () => {
    const { totalMinor } = await buy(buyerB);
    expect(totalMinor).toBe(PRICE);
    expect((await original(buyerB)).filename).toBe('v2.pdf');
    await expect(original(buyerB, V1)).rejects.toThrow('الملف غير متاح');
  });

  it('nobody buys the same version twice — in the application and in the database', async () => {
    await expect(createOrder(buyerB, { productSlugs: [slug] })).rejects.toThrow('ضمن مشترياتك');
    const [order] = await asOwner((tx) => tx.insert(orders).values({
      orderNumber: `S4-DUP-${suffix}`, customerId: ids.buyerB, status: 'DRAFT', currency: 'USD',
      subtotalMinor: PRICE, discountMinor: 0n, totalMinor: PRICE,
    }).returning({ id: orders.id }));
    await expect(asOwner((tx) => tx.insert(orderItems).values({
      orderId: order!.id, productId: ids.product, titleSnapshot: 'x', unitPriceMinor: PRICE, currency: 'USD', versionId: V2,
    }))).rejects.toThrow();
    await asOwner((tx) => tx.delete(orders).where(eq(orders.id, order!.id)));
  });

  it('the version a line sold cannot be rewritten afterwards', async () => {
    const [line] = await asOwner((tx) => tx.select({ id: orderItems.id }).from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId)).where(eq(orders.customerId, ids.buyerB)));
    await expect(asOwner((tx) => tx.update(orderItems).set({ versionId: V1 }).where(eq(orderItems.id, line!.id))))
      .rejects.toThrow();
  });
});

describe('S4-07 — a download is counted only once the bytes are in hand', () => {
  it('counts a download that happened', async () => {
    const before = await trail(ids.buyerB);
    await original(buyerB);
    expect(await trail(ids.buyerB)).toEqual({ counted: before.counted + 1, events: before.events + 1 });
  });

  it('a missing object is a 404 and counts nothing', async () => {
    const file = (await filesOf(V2)).find((f) => f.role === 'ORIGINAL')!;
    const storage = getStorage();
    const bytes = await storage.get(file.bucket as BucketName, file.storageKey);
    await storage.remove(file.bucket as BucketName, file.storageKey);
    const before = await trail(ids.buyerB);
    try {
      await expect(original(buyerB)).rejects.toThrow('الملف غير متاح');
      expect(await trail(ids.buyerB)).toEqual(before);
    } finally {
      await storage.put(file.bucket as BucketName, file.storageKey, bytes, file.contentType);
    }
    await original(buyerB);
    expect((await trail(ids.buyerB)).counted).toBe(before.counted + 1);
  });

  it('refused requests count nothing', async () => {
    const before = await trail(ids.buyerC);
    await expect(original(buyerC)).rejects.toThrow();
    await expect(deliverProductFile(buyerC, { productSlug: 'no-such-product', role: 'ORIGINAL' })).rejects.toThrow();
    expect(await trail(ids.buyerC)).toEqual(before);
  });
});

describe('S4-10 — only the owner deletes a version, and history stays', () => {
  it('refuses everyone but the owner', async () => {
    for (const actor of [buyerA, engineer, outsider, GUEST]) {
      await expect(deleteVersion(actor, { productId: ids.product, versionId: V2 })).rejects.toThrow();
    }
    expect(await currentVersionId(ids.product)).toBe(V2);
  });

  it('deleting the version on sale unpublishes the product and keeps every order, grant and invoice', async () => {
    const count = async () => asOwner(async (tx) => ({
      orders: (await tx.select({ n: sql<number>`count(*)::int` }).from(orders).where(inArray(orders.customerId, [ids.buyerA, ids.buyerB])))[0]!.n,
      lines: (await tx.select({ n: sql<number>`count(*)::int` }).from(orderItems).where(eq(orderItems.productId, ids.product)))[0]!.n,
      grants: (await tx.select({ n: sql<number>`count(*)::int` }).from(entitlements).where(eq(entitlements.productId, ids.product)))[0]!.n,
      invoices: (await tx.select({ n: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.customerId, ids.buyerB)))[0]!.n,
    }));
    const before = await count();

    expect(await deleteVersion(owner, { productId: ids.product, versionId: V2 })).toEqual({ versionNo: 2, unpublished: true });
    const [product] = await asOwner((tx) => tx.select({ status: products.status, current: products.currentVersionId })
      .from(products).where(eq(products.id, ids.product)));
    expect(product).toEqual({ status: 'UNPUBLISHED', current: null });
    expect(await count()).toEqual(before);

    const audits = await asOwner((tx) => tx.select({ action: auditLogs.action }).from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.product), eq(auditLogs.action, 'PRODUCT_UNPUBLISHED'))));
    expect(audits.length).toBeGreaterThan(0);
  });

  it('4. buyers of the deleted version keep downloading it inside their window', async () => {
    expect((await original(buyerB)).filename).toBe('v2.pdf');
    expect((await original(buyerA, V2)).filename).toBe('v2.pdf');
    for (const f of await filesOf(V2)) {
      expect(await getStorage().exists(f.bucket as BucketName, f.storageKey)).toBe(true);
    }
  });

  it('10. the purchase records remain, and the product cannot be sold with nothing behind it', async () => {
    const mine = await myPurchases(buyerB);
    expect(mine.owned.find((o) => o.versionId === V2)).toMatchObject({ versionNo: 2, downloadable: true });
    await expect(createOrder(buyerD, { productSlugs: [slug] })).rejects.toThrow('غير متاح');
    await expect(changeProductStatus(owner, { productId: ids.product, to: 'PUBLISHED' })).rejects.toThrow();
  });
});

describe('S4-05 — retired objects go only when nobody can claim them, and a failed removal is retried', () => {
  it('an unsold draft version replaced by a new upload loses its objects', async () => {
    const first = await ingestProductFile(owner, {
      productId: ids.scratch, filename: 's1.pdf', declaredType: 'PDF', body: await buildPdf('S1'), contentType: 'application/pdf',
    });
    const oldFiles = await filesOf(first.versionId);

    const storage = getStorage();
    const realRemove = storage.remove.bind(storage);
    let failed = 0;
    const spy = vi.spyOn(storage, 'remove').mockImplementation(async (bucket, key) => {
      if (failed === 0) {
        failed += 1;
        throw new Error('simulated removal failure');
      }
      return realRemove(bucket, key);
    });
    try {
      const second = await ingestProductFile(owner, {
        productId: ids.scratch, filename: 's2.pdf', declaredType: 'PDF', body: await buildPdf('S2'), contentType: 'application/pdf',
      });
      expect(second.activated).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // The upload itself succeeded; the failed removal left the version unpurged.
    const v1 = (await versionsOf(ids.scratch)).find((v) => v.id === first.versionId)!;
    expect(v1.deletedAt).not.toBeNull();
    expect(v1.filesPurgedAt).toBeNull();

    // The next run finishes the job.
    const run = await purgeRetiredVersionFiles(owner, { productId: ids.scratch });
    expect(run.failedObjects).toBe(0);
    expect((await versionsOf(ids.scratch)).find((v) => v.id === first.versionId)!.filesPurgedAt).not.toBeNull();
    for (const f of oldFiles) {
      expect(await getStorage().exists(f.bucket as BucketName, f.storageKey)).toBe(false);
    }
  });

  it('never removes the version on sale or one a buyer still holds', async () => {
    await purgeRetiredVersionFiles(owner);
    for (const versionId of [V1, V2]) {
      for (const f of await filesOf(versionId)) {
        expect(await getStorage().exists(f.bucket as BucketName, f.storageKey)).toBe(true);
      }
    }
    const current = await currentVersionId(ids.scratch);
    for (const f of await filesOf(current!)) {
      expect(await getStorage().exists(f.bucket as BucketName, f.storageKey)).toBe(true);
    }
  });

  it('is the owner’s alone', async () => {
    await expect(purgeRetiredVersionFiles(buyerA)).rejects.toThrow();
    await expect(purgeRetiredVersionFiles(engineer)).rejects.toThrow();
  });
});

describe('IDOR — uploads, versions and downloads by role', () => {
  it('only the owner uploads a file', async () => {
    const body = await buildPdf('X');
    for (const actor of [buyerA, engineer, outsider, GUEST]) {
      await expect(ingestProductFile(actor, {
        productId: ids.scratch, filename: 'x.pdf', declaredType: 'PDF', body, contentType: 'application/pdf',
      })).rejects.toThrow();
    }
  });

  it('a malformed or foreign version id reveals nothing', async () => {
    await expect(original(buyerB, randomUUID())).rejects.toThrow('الملف غير متاح');
    const scratchVersion = await currentVersionId(ids.scratch);
    await expect(original(buyerB, scratchVersion!)).rejects.toThrow('الملف غير متاح');
  });
});

describe('S4-06 — a title of spaces is not a title', () => {
  it('the service refuses it', async () => {
    await expect(updateProductDetails(owner, { productId: ids.scratch, titleAr: '   ' })).rejects.toThrow('عنوان المنتج مطلوب');
  });

  it('the database refuses it underneath', async () => {
    await expect(asOwner((tx) => tx.update(products).set({ titleAr: ' \t ' }).where(eq(products.id, ids.scratch))))
      .rejects.toThrow();
    const [row] = await asOwner((tx) => tx.select({ t: products.titleAr }).from(products).where(eq(products.id, ids.scratch)));
    expect(row!.t).toBe('مسودة');
  });
});

describe('S4-08 — the Stage 4 definer functions resolve pg_temp last', () => {
  const FUNCTIONS = [
    'app_record_entitlement_download', 'app_set_product_price', 'app_submit_product_for_review',
    'app_public_product_authors', 'app_public_contributor_product_count', 'app_public_contributor_products',
  ];

  it('every one pins search_path = public, pg_temp', async () => {
    const rows = await asOwner((tx) => tx.execute(sql`
      SELECT proname, array_to_string(proconfig, ',') AS config
        FROM pg_proc WHERE proname IN ${FUNCTIONS} AND prosecdef`)) as unknown as Array<{ proname: string; config: string }>;
    expect(rows.map((r) => r.proname).sort()).toEqual([...FUNCTIONS].sort());
    for (const row of rows) expect(row.config, row.proname).toContain('search_path=public, pg_temp');
  });

  it('a temporary table named `entitlements` does not capture the download counter', async () => {
    /*
     * A FRESH connection, not the pool: PL/pgSQL caches a function's plans
     * per session, so a pooled connection that already ran the function keeps
     * resolving the real table and would pass this test even with pg_temp
     * first. The Stage 4 audit's proof ran in a new session; so does this.
     */
    const fake = randomUUID();
    const sqlClient = postgres(serverEnv().DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      const outcome = await sqlClient.begin(async (tx) => {
        await tx`CREATE TEMP TABLE entitlements (
          id uuid, download_count int, last_downloaded_at timestamptz, revoked_at timestamptz,
          max_downloads int, expires_at timestamptz) ON COMMIT DROP`;
        await tx`INSERT INTO entitlements VALUES (${fake}::uuid, 0, null, null, null, now() + interval '1 day')`;
        // With pg_temp first the function updates the temp row and returns 1.
        const [row] = await tx`SELECT app_record_entitlement_download(${fake}::uuid) AS n`;
        return row?.n as number;
      }).then((n) => ({ captured: n }), (error: Error) => ({ refused: error.message }));
      expect(outcome).toEqual({ refused: expect.stringContaining('Entitlement is revoked') });
    } finally {
      await sqlClient.end();
    }
  });
});
