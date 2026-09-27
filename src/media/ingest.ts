import 'server-only';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { productFiles, products, productVersions } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { serverEnv } from '@/lib/config/env';
import { getStorage, newStorageKey, type BucketName } from './storage';
import { purgeQuietly, versionEverSold } from './versions';
import { getScanner } from './scanner';
import { generatePdfPreview, pdfPageCount } from './preview';
import { supportsPreview, validateUpload, type ProductFileType } from './file-types';

/**
 * ===========================================================================
 * UPLOAD PIPELINE
 * ===========================================================================
 *   product + type → validate bytes → analyse PDF + preview → scan
 *     → store privately → record the version (or remove what was stored)
 *
 * Order matters. Nothing is stored before every check that can refuse the
 * file has passed; the preview is rendered in memory and stored beside the
 * original only once the scan has answered.
 * ===========================================================================
 */

export interface IngestInput {
  readonly productId: string;
  readonly filename: string;
  readonly declaredType: ProductFileType;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface IngestResult {
  readonly originalFileId: string;
  readonly previewFileId: string | null;
  readonly scanStatus: string;
  readonly pageCount: number | null;
  readonly previewPageCount: number | null;
  /** The version this upload created (migration 0059). */
  readonly versionId: string;
  readonly versionNo: number;
  /**
   * True when the new version went on sale (or became the draft's file) at
   * once; false when it waits for the owner's release because the product is
   * on sale or its version has been sold (S4-04).
   */
  readonly activated: boolean;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.dwg': 'image/vnd.dwg',
  '.dxf': 'image/vnd.dxf',
  '.rvt': 'application/octet-stream',
  '.rfa': 'application/octet-stream',
  '.rte': 'application/octet-stream',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
};

/**
 * Upload a product file as a NEW VERSION (Stage 4 repair — S4-04, S4-05).
 *
 * Every check that can refuse the file runs BEFORE anything is stored: the
 * product exists and is of the declared type, the bytes match the type, a PDF
 * opens and its preview renders, and the scanner has answered. Only then are
 * the objects written, and if recording them fails the objects just written
 * are removed again — a refused upload leaves nothing behind.
 */
export async function ingestProductFile(actor: Actor, input: IngestInput): Promise<IngestResult> {
  if (!isOwner(actor)) {
    // Contributor uploads arrive through the same service but are gated on
    // the owner having granted draft rights — added with the contributor
    // console in a later phase. Today, uploading is the owner's.
    throw new RuleViolationError('رفع الملفات من صلاحية مالك المنصة');
  }

  // --- 0. The product exists, and the declared type is its type -------------
  const product = await withActor(actor, async (tx) => {
    const [row] = await tx
      .select({ id: products.id, fileType: products.fileType })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    return row ?? null;
  });
  if (!product) throw new NotFoundError('المنتج غير موجود');
  if (product.fileType !== input.declaredType) {
    // The type is the product's, decided when it was created — not a claim
    // the upload request gets to make.
    throw new ValidationError('نوع الملف المرفوع لا يطابق نوع المنتج', {
      declaredType: input.declaredType,
      productType: product.fileType,
    });
  }

  // --- 1. Inspect the bytes ------------------------------------------------
  const verdict = validateUpload({
    filename: input.filename,
    declaredType: input.declaredType,
    byteSize: input.body.byteLength,
    head: input.body.subarray(0, 512),
  });
  const contentType = CONTENT_TYPES[verdict.extension] ?? 'application/octet-stream';
  const env = serverEnv();

  // --- 2. Analyse — PDF only, by the owner's decision — before storage -------
  let pageCount: number | null = null;
  let preview: { pdf: Uint8Array; previewPageCount: number } | null = null;
  if (supportsPreview(input.declaredType)) {
    pageCount = pdfPageCount(input.body);
    preview = await generatePdfPreview(input.body, { maxPages: env.PREVIEW_PAGE_COUNT });
  }

  // --- 3. Scan ----------------------------------------------------------------
  const scan = await getScanner().scan(input.body);
  if (scan.status === 'INFECTED') {
    throw new RuleViolationError('رُفض الملف: كشف الفاحص برمجية خبيثة', {
      signature: scan.detail,
    });
  }
  if (scan.status === 'FAILED') {
    throw new RuleViolationError('تعذّر فحص الملف؛ لم يُحفظ', { detail: scan.detail });
  }

  // --- 4. Store ---------------------------------------------------------------
  const storage = getStorage();
  const written: Array<{ bucket: BucketName; key: string }> = [];
  const removeWritten = async () => {
    for (const object of written) {
      try {
        await storage.remove(object.bucket, object.key);
      } catch (error) {
        // Logged, not thrown: the upload has already failed for its own reason,
        // and that is the error the owner must see.
        logger.error({ err: error, key: object.key }, 'Could not remove an object from a failed upload');
      }
    }
  };

  let stored: { key: string; byteSize: number; sha256: string };
  let storedPreview: { key: string; byteSize: number; sha256: string } | null = null;
  try {
    stored = await storage.put('originals', newStorageKey('original'), input.body, contentType);
    written.push({ bucket: 'originals', key: stored.key });
    if (preview) {
      storedPreview = await storage.put('derivatives', newStorageKey('preview'), preview.pdf, 'application/pdf');
      written.push({ bucket: 'derivatives', key: storedPreview.key });
    }
  } catch (error) {
    await removeWritten();
    throw error;
  }

  // --- 5. Record the version, atomically -----------------------------------
  let result: IngestResult;
  try {
    result = await withActor(actor, async (tx) => {
      const [locked] = await tx
        .select({ id: products.id, status: products.status, currentVersionId: products.currentVersionId })
        .from(products)
        .where(eq(products.id, input.productId))
        .for('update')
        .limit(1);
      if (!locked) throw new NotFoundError('المنتج غير موجود');

      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${productVersions.versionNo}), 0)::int` })
        .from(productVersions)
        .where(eq(productVersions.productId, locked.id));
      const versionNo = (last?.n ?? 0) + 1;

      // On sale, or already sold: the new version waits for the owner's release
      // (S4-04). Otherwise it simply becomes the product's file.
      const currentSold = locked.currentVersionId ? await versionEverSold(tx, locked.currentVersionId) : false;
      const waits = locked.status === 'PUBLISHED' || currentSold;
      const now = new Date();

      // A version still waiting for release is replaced by this upload, and an
      // unsold draft version is replaced when the new one takes its place.
      const discard = await tx
        .select({ id: productVersions.id })
        .from(productVersions)
        .where(and(
          eq(productVersions.productId, locked.id),
          isNull(productVersions.deletedAt),
          isNull(productVersions.activatedAt),
          locked.currentVersionId ? ne(productVersions.id, locked.currentVersionId) : sql`true`,
        ));
      const discardIds = discard.map((d) => d.id);
      if (!waits && locked.currentVersionId) discardIds.push(locked.currentVersionId);

      const [version] = await tx
        .insert(productVersions)
        .values({
          productId: locked.id,
          versionNo,
          createdBy: actor.kind === 'USER' ? actor.userId : null,
          activatedAt: waits ? null : now,
        })
        .returning({ id: productVersions.id });
      if (!version) throw new RuleViolationError('تعذّر تسجيل الإصدار');

      const [original] = await tx
        .insert(productFiles)
        .values({
          productId: locked.id,
          versionId: version.id,
          version: versionNo,
          role: 'ORIGINAL',
          storageKey: stored.key,
          bucket: 'originals',
          originalFilename: input.filename,
          contentType,
          container: verdict.container,
          byteSize: BigInt(stored.byteSize),
          sha256: stored.sha256,
          pageCount,
          scanStatus: scan.status,
          scanDetail: scan.detail,
          scannedAt: now,
          uploadedBy: actor.kind === 'USER' ? actor.userId : null,
        })
        .returning({ id: productFiles.id });

      let previewId: string | null = null;
      if (storedPreview && preview) {
        const [row] = await tx
          .insert(productFiles)
          .values({
            productId: locked.id,
            versionId: version.id,
            version: versionNo,
            role: 'PREVIEW',
            storageKey: storedPreview.key,
            bucket: 'derivatives',
            originalFilename: `preview-${input.filename}`,
            contentType: 'application/pdf',
            container: 'PDF',
            byteSize: BigInt(storedPreview.byteSize),
            sha256: storedPreview.sha256,
            pageCount: preview.previewPageCount,
            // A derivative the platform generated from an already-scanned file.
            scanStatus: 'CLEAN',
            scannedAt: now,
            uploadedBy: actor.kind === 'USER' ? actor.userId : null,
          })
          .returning({ id: productFiles.id });
        previewId = row?.id ?? null;
      }

      if (discardIds.length > 0) {
        await tx.update(productVersions)
          .set({ deletedAt: now, deletedBy: actor.kind === 'USER' ? actor.userId : null })
          .where(and(inArray(productVersions.id, discardIds), isNull(productVersions.deletedAt)));
      }
      if (!waits) {
        const updated = await tx.update(products)
          .set({ currentVersionId: version.id, updatedAt: now })
          .where(eq(products.id, locked.id))
          .returning({ id: products.id });
        if (updated.length === 0) throw new RuleViolationError('لم يُطبَّق تسجيل الإصدار');
      }

      await recordAudit(tx, actor, {
        action: 'PRODUCT_UPDATED',
        entityType: 'product_file',
        entityId: original?.id ?? null,
        after: {
          productId: input.productId,
          versionNo,
          waitsForRelease: waits,
          filename: input.filename,
          declaredType: input.declaredType,
          container: verdict.container,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          scanStatus: scan.status,
          scanner: scan.scanner,
          previewGenerated: storedPreview !== null,
          previewPageCount: preview?.previewPageCount ?? null,
        },
      });

      return {
        originalFileId: original!.id,
        previewFileId: previewId,
        scanStatus: scan.status,
        pageCount,
        previewPageCount: preview?.previewPageCount ?? null,
        versionId: version.id,
        versionNo,
        activated: !waits,
      };
    });
  } catch (error) {
    // Nothing points at the objects just written: remove them (S4-05).
    await removeWritten();
    throw error;
  }

  // Discarded versions nobody can claim lose their objects now.
  await purgeQuietly(actor, input.productId);
  return result;
}
