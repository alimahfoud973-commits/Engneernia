import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { withRawActorContext } from '@/db/actor-context';
import { ensureTestOwner } from '@/db/testing/single-owner';
import { closeDb } from '@/db';
import { contributors, disciplines, downloadEvents, entitlements, productContributors, productFiles, productPrices, products, users } from '@/db/schema';
import { getStorage } from './storage';
import { ingestProductFile } from './ingest';
import { deliverProductFile } from './deliver';
import { changeProductStatus } from '@/catalog/products';
import { GUEST, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError } from '@/lib/errors';

/**
 * ===========================================================================
 * PHASE P3 EXIT CRITERIA
 * ===========================================================================
 *   1. A real PDF ingests, stores privately, and yields a 5-page preview.
 *   2. DWG, Revit and archive files ingest — with no preview, by decision.
 *   3. The PUBLIC can fetch the preview and can NEVER fetch the original.
 *   4. Every delivery of an original is recorded.
 * ===========================================================================
 */

const suffix = Date.now();
const ids = {
  owner: '', engineerUser: randomUUID(), contributor: randomUUID(),
  discipline: randomUUID(),
  pdfProduct: randomUUID(), dwgProduct: randomUUID(), zipProduct: randomUUID(),
};
const slugs = {
  pdf: `p3-pdf-${suffix}`, dwg: `p3-dwg-${suffix}`, zip: `p3-zip-${suffix}`,
};

let OWNER_RAW: { actorId: string; actorRole: string };
const base = { kind: 'USER', displayName: 'T', locale: 'ar', sessionId: 's', twoFactorSatisfied: true, totpEnabled: false } as const;
let owner: Actor;
const engineer: Actor = { ...base, userId: ids.engineerUser, role: 'CONTRIBUTOR', contributorId: ids.contributor, contributorActive: true };

async function buildPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    doc.addPage([595, 842]).drawText(`P3 PAGE-${i} TOKEN${i}Z`, {
      x: 50, y: 700, size: 26, font, color: rgb(0, 0, 0),
    });
  }
  return doc.save();
}

const pad = (bytes: number[], size = 4096) =>
  Uint8Array.from([...bytes, ...new Array(size - bytes.length).fill(0x41)]);

const DWG_BYTES = pad([...Buffer.from('AC1032', 'latin1')]);
const ZIP_BYTES = pad([0x50, 0x4b, 0x03, 0x04]);
const RVT_BYTES = pad([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

beforeAll(async () => {
  // The platform has exactly one owner (migration 0041), so this file no
  // longer invents one of its own — it asks for the one that exists.
  ids.owner = (await ensureTestOwner({ displayName: 'Owner' })).id;
  OWNER_RAW = { actorId: ids.owner, actorRole: 'OWNER' };
  owner = { ...base, userId: ids.owner, role: 'OWNER', contributorId: null, contributorActive: false };

  await withRawActorContext(OWNER_RAW, async (tx) => {
    await tx.insert(users).values([
      { id: ids.engineerUser, email: `p3-eng+${suffix}@test.local`, passwordHash: 'x', role: 'CONTRIBUTOR', status: 'ACTIVE', displayName: 'Engineer' },
    ]);
    await tx.insert(contributors).values({
      id: ids.contributor, userId: ids.engineerUser, publicSlug: `p3-eng-${suffix}`,
      settlementCode: `P3E${suffix}`, displayName: 'Engineer', isActive: true,
    });
    await tx.insert(disciplines).values({
      id: ids.discipline, slug: `p3-disc-${suffix}`, nameAr: 'تخصص', nameEn: 'T', sortOrder: 98,
    });
    await tx.insert(products).values([
      { id: ids.pdfProduct, slug: slugs.pdf, titleAr: 'كتاب PDF', disciplineId: ids.discipline, fileType: 'PDF', status: 'APPROVED', currency: 'USD' },
      { id: ids.dwgProduct, slug: slugs.dwg, titleAr: 'مخطط أوتوكاد', disciplineId: ids.discipline, fileType: 'CAD', status: 'APPROVED', currency: 'USD' },
      { id: ids.zipProduct, slug: slugs.zip, titleAr: 'مشروع مضغوط', disciplineId: ids.discipline, fileType: 'ARCHIVE', status: 'APPROVED', currency: 'USD' },
    ]);
    for (const productId of [ids.pdfProduct, ids.dwgProduct, ids.zipProduct]) {
      await tx.insert(productContributors).values({ productId, contributorId: ids.contributor, shareBp: 10000 });
      await tx.insert(productPrices).values({ productId, amountMinor: 1000n, currency: 'USD' });
    }
  });
}, 60_000);

afterAll(async () => {
  await withRawActorContext(OWNER_RAW, async (tx) => {
    // Entitlements restrict the product delete (ON DELETE RESTRICT, so a
    // purchase can never be erased by removing a product). Section 5 creates
    // them, so teardown clears them first.
    await tx.delete(entitlements)
      .where(sql`product_id IN (${ids.pdfProduct}, ${ids.dwgProduct}, ${ids.zipProduct})`);
    await tx.delete(products).where(sql`id IN (${ids.pdfProduct}, ${ids.dwgProduct}, ${ids.zipProduct})`);
    await tx.delete(disciplines).where(eq(disciplines.id, ids.discipline));
    await tx.delete(contributors).where(eq(contributors.id, ids.contributor));
    await tx.delete(users).where(sql`id IN (${ids.engineerUser})`);
    await tx.delete(users).where(sql`email LIKE ${`p3-buyer-${suffix}%`}`);
  });
  await closeDb();
});

describe('1. PDF ingest produces a private original and a public preview', () => {
  it('stores the original and derives a 5-page preview', async () => {
    const result = await ingestProductFile(owner, {
      productId: ids.pdfProduct,
      filename: 'handbook.pdf',
      declaredType: 'PDF',
      body: await buildPdf(60),
      contentType: 'application/pdf',
    });

    expect(result.pageCount).toBe(60);
    expect(result.previewPageCount).toBe(5);
    expect(result.previewFileId).not.toBeNull();
    expect(result.scanStatus).toBe('SKIPPED'); // no scanner configured locally
  }, 120_000);

  it('records both files with random, unguessable storage keys', async () => {
    const files = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productFiles).where(eq(productFiles.productId, ids.pdfProduct)),
    );
    expect(files.map((f) => f.role).sort()).toEqual(['ORIGINAL', 'PREVIEW']);
    for (const file of files) {
      // The key must not contain the title or the uploaded filename.
      expect(file.storageKey).not.toContain('handbook');
      expect(file.storageKey).toMatch(/^(original|preview)\/[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    }
  });
});

describe('2. the formats the owner asked for', () => {
  it('accepts a DWG drawing, and derives no preview for it', async () => {
    const result = await ingestProductFile(owner, {
      productId: ids.dwgProduct, filename: 'floorplan.dwg', declaredType: 'CAD',
      body: DWG_BYTES, contentType: 'image/vnd.dwg',
    });
    expect(result.previewFileId).toBeNull();
    expect(result.pageCount).toBeNull();
  });

  it('accepts a compressed archive', async () => {
    const result = await ingestProductFile(owner, {
      productId: ids.zipProduct, filename: 'project.zip', declaredType: 'ARCHIVE',
      body: ZIP_BYTES, contentType: 'application/zip',
    });
    expect(result.previewFileId).toBeNull();
  });

  it('accepts a Revit model declared as such', async () => {
    const result = await ingestProductFile(owner, {
      productId: ids.dwgProduct, filename: 'tower.rvt', declaredType: 'REVIT_BIM',
      body: RVT_BYTES, contentType: 'application/octet-stream',
    });
    expect(result.previewFileId).toBeNull();
  });

  it('refuses an executable wearing a Revit extension', async () => {
    await expect(
      ingestProductFile(owner, {
        productId: ids.dwgProduct, filename: 'evil.rvt', declaredType: 'REVIT_BIM',
        body: pad([0x7f, 0x45, 0x4c, 0x46]), contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow();
  });

  it('refuses an upload from anyone but the owner', async () => {
    await expect(
      ingestProductFile(engineer, {
        productId: ids.pdfProduct, filename: 'x.pdf', declaredType: 'PDF',
        body: await buildPdf(2), contentType: 'application/pdf',
      }),
    ).rejects.toThrow(RuleViolationError);
  }, 30_000);
});

/**
 * THE RULE THE WHOLE PHASE EXISTS FOR.
 */
describe('3. the public reaches the preview and never the original', () => {
  beforeAll(async () => {
    await changeProductStatus(owner, { productId: ids.pdfProduct, to: 'PUBLISHED' });
  }, 30_000);

  it('lets an anonymous visitor fetch the preview', async () => {
    const result = await deliverProductFile(GUEST, { productSlug: slugs.pdf, role: 'PREVIEW' });
    expect(result.grant.kind).toBe('stream');
    if (result.grant.kind !== 'stream') return;
    expect(Buffer.from(result.grant.body.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('REFUSES an anonymous visitor the original', async () => {
    await expect(
      deliverProductFile(GUEST, { productSlug: slugs.pdf, role: 'ORIGINAL' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses a signed-in contributor another product they are not credited on', async () => {
    const stranger: Actor = { ...base, userId: randomUUID(), role: 'CONTRIBUTOR', contributorId: randomUUID(), contributorActive: true };
    await expect(
      deliverProductFile(stranger, { productSlug: slugs.pdf, role: 'ORIGINAL' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('allows the credited contributor and the owner', async () => {
    await expect(
      deliverProductFile(engineer, { productSlug: slugs.pdf, role: 'ORIGINAL' }),
    ).resolves.toBeDefined();
    await expect(
      deliverProductFile(owner, { productSlug: slugs.pdf, role: 'ORIGINAL' }),
    ).resolves.toBeDefined();
  });

  it('hides even the preview once the product is unpublished', async () => {
    await changeProductStatus(owner, { productId: ids.pdfProduct, to: 'UNPUBLISHED' });
    await expect(
      deliverProductFile(GUEST, { productSlug: slugs.pdf, role: 'PREVIEW' }),
    ).rejects.toThrow(NotFoundError);
    await changeProductStatus(owner, { productId: ids.pdfProduct, to: 'PUBLISHED' });
  }, 30_000);

  it('the delivered preview carries no text from any withheld page', async () => {
    const result = await deliverProductFile(GUEST, { productSlug: slugs.pdf, role: 'PREVIEW' });
    if (result.grant.kind !== 'stream') throw new Error('expected a stream');
    const raw = Buffer.from(result.grant.body).toString('latin1');
    for (let page = 6; page <= 60; page += 1) {
      expect(raw.includes(`PAGE-${page}`), `page ${page} leaked`).toBe(false);
    }
  });
});

describe('4. every delivery of an original leaves a trail', () => {
  it('records who took it and why it was permitted', async () => {
    await deliverProductFile(owner, {
      productSlug: slugs.pdf, role: 'ORIGINAL', ip: '203.0.113.9', userAgent: 'test-agent',
    });

    const events = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(downloadEvents).orderBy(sql`created_at DESC`).limit(5),
    );
    const mine = events.filter((e) => e.userId === ids.owner);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.grantReason).toBe('OWNER');
    // The address is hashed, never stored raw.
    expect(mine[0]?.ipHash).not.toBe('203.0.113.9');
    expect(mine[0]?.ipHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('records nothing for a preview fetch — previews are public', async () => {
    const before = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ c: sql<number>`count(*)::int` }).from(downloadEvents),
    );
    await deliverProductFile(GUEST, { productSlug: slugs.pdf, role: 'PREVIEW' });
    const after = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select({ c: sql<number>`count(*)::int` }).from(downloadEvents),
    );
    expect(Number(after[0]?.c)).toBe(Number(before[0]?.c));
  });
});

/**
 * ===========================================================================
 * 5. THE BUYER'S COPY (OPEN-5)
 * ===========================================================================
 * `personalise.test.ts` proves the stamping function itself. This proves the
 * DELIVERY PATH — which is where the feature can be lost without the function
 * ever being wrong: by handing the buyer a signed URL to the master, by
 * stamping the wrong people's downloads, or by writing the stamped bytes back
 * over the original.
 * ===========================================================================
 */
describe('5. the buyer gets a personalised copy, and storage keeps the original', () => {
  const buyerId = randomUUID();
  const buyer: Actor = {
    ...base, userId: buyerId, role: 'CUSTOMER', displayName: 'محمد الأحمد',
    contributorId: null, contributorActive: false,
  };

  let masterKey = '';
  let masterBefore = '';

  beforeAll(async () => {
    await withRawActorContext(OWNER_RAW, async (tx) => {
      await tx.insert(users).values({
        id: buyerId, email: `p3-buyer-${suffix}@test.local`, passwordHash: 'x',
        role: 'CUSTOMER', status: 'ACTIVE', displayName: 'محمد الأحمد',
      });
      // A grant with no order behind it — `order_item_id` is nullable, and the
      // stamp has to cope with a missing reference rather than invent one.
      await tx.insert(entitlements).values({
        customerId: buyerId, productId: ids.pdfProduct,
      });
    });

    const [file] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productFiles)
        .where(eq(productFiles.productId, ids.pdfProduct)).limit(50),
    ).then((rows) => rows.filter((r) => r.role === 'ORIGINAL'));

    masterKey = file!.storageKey;
    masterBefore = createHash('sha256')
      .update(await getStorage().get('originals', masterKey)).digest('hex');
  }, 30_000);

  it('streams a stamped copy rather than redirecting to the master', async () => {
    /**
     * A redirect here would be the whole feature lost in one line: the signed
     * URL points at the unstamped original in storage.
     */
    const result = await deliverProductFile(buyer, { productSlug: slugs.pdf, role: 'ORIGINAL' });
    expect(result.grant.kind).toBe('stream');
    if (result.grant.kind !== 'stream') return;

    const stored = await getStorage().get('originals', masterKey);
    expect(Buffer.from(result.grant.body).equals(Buffer.from(stored))).toBe(false);
    expect(Buffer.from(result.grant.body.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('leaves the stored original byte-for-byte as it was', async () => {
    // The owner's condition on OPEN-5, asserted after a real download.
    await deliverProductFile(buyer, { productSlug: slugs.pdf, role: 'ORIGINAL' });

    const after = createHash('sha256')
      .update(await getStorage().get('originals', masterKey)).digest('hex');
    expect(after).toBe(masterBefore);
  });

  it('records the download as an entitlement, not as a contributor', async () => {
    await deliverProductFile(buyer, { productSlug: slugs.pdf, role: 'ORIGINAL' });

    const events = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(downloadEvents).orderBy(sql`created_at DESC`).limit(20),
    );
    const mine = events.filter((e) => e.userId === buyerId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.grantReason).toBe('ENTITLEMENT');
  });

  it('does not stamp the owner or the engineer — neither is a buyer to trace', async () => {
    /**
     * Stamping their downloads would put a customer's name on a file the
     * customer never received, and would make the mark useless as evidence of
     * where a leak came from.
     */
    const stored = await getStorage().get('originals', masterKey);

    for (const actor of [owner, engineer]) {
      const result = await deliverProductFile(actor, { productSlug: slugs.pdf, role: 'ORIGINAL' });
      if (result.grant.kind !== 'stream') continue; // an S3 redirect is also unstamped
      expect(Buffer.from(result.grant.body).equals(Buffer.from(stored))).toBe(true);
    }
  });

  it('delivers a non-PDF original unchanged, because nothing can mark it', async () => {
    await withRawActorContext(OWNER_RAW, (tx) =>
      tx.insert(entitlements).values({ customerId: buyerId, productId: ids.dwgProduct }),
    );
    await changeProductStatus(owner, { productId: ids.dwgProduct, to: 'PUBLISHED' });

    const [dwg] = await withRawActorContext(OWNER_RAW, (tx) =>
      tx.select().from(productFiles).where(eq(productFiles.productId, ids.dwgProduct)),
    ).then((rows) => rows.filter((r) => r.role === 'ORIGINAL'));

    const result = await deliverProductFile(buyer, { productSlug: slugs.dwg, role: 'ORIGINAL' });
    if (result.grant.kind !== 'stream') return;

    const stored = await getStorage().get('originals', dwg!.storageKey);
    expect(Buffer.from(result.grant.body).equals(Buffer.from(stored))).toBe(true);
  }, 30_000);
});
