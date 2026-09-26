import 'server-only';
import { eq, and } from 'drizzle-orm';
import { productFiles, products } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import { serverEnv } from '@/lib/config/env';
import { getStorage, newStorageKey } from './storage';
import { getScanner } from './scanner';
import { generatePdfPreview, pdfPageCount } from './preview';
import { supportsPreview, validateUpload, type ProductFileType } from './file-types';

/**
 * ===========================================================================
 * UPLOAD PIPELINE
 * ===========================================================================
 *   validate bytes → scan → store privately → derive preview (PDF only)
 *
 * Order matters. Nothing is stored before its first bytes have been inspected,
 * and no preview is derived from a file that failed scanning.
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

export async function ingestProductFile(actor: Actor, input: IngestInput): Promise<IngestResult> {
  if (!isOwner(actor)) {
    // Contributor uploads arrive through the same service but are gated on
    // the owner having granted draft rights — added with the contributor
    // console in a later phase. Today, uploading is the owner's.
    throw new RuleViolationError('رفع الملفات من صلاحية مالك المنصة');
  }

  // --- 1. Inspect the bytes before anything touches storage ---------------
  const verdict = validateUpload({
    filename: input.filename,
    declaredType: input.declaredType,
    byteSize: input.body.byteLength,
    head: input.body.subarray(0, 512),
  });

  const contentType = CONTENT_TYPES[verdict.extension] ?? 'application/octet-stream';

  // --- 2. Scan --------------------------------------------------------------
  const scan = await getScanner().scan(input.body);
  if (scan.status === 'INFECTED') {
    throw new RuleViolationError('رُفض الملف: كشف الفاحص برمجية خبيثة', {
      signature: scan.detail,
    });
  }
  if (scan.status === 'FAILED') {
    throw new RuleViolationError('تعذّر فحص الملف؛ لم يُحفظ', { detail: scan.detail });
  }

  const storage = getStorage();
  const env = serverEnv();

  // --- 3. Store the original privately --------------------------------------
  const originalKey = newStorageKey('original');
  const stored = await storage.put('originals', originalKey, input.body, contentType);

  // --- 4. Derive the preview — PDF only, by the owner's decision ------------
  let previewKey: string | null = null;
  let storedPreview: { byteSize: number; sha256: string } | null = null;
  let pageCount: number | null = null;
  let previewPageCount: number | null = null;

  if (supportsPreview(input.declaredType)) {
    pageCount = pdfPageCount(input.body);
    const preview = await generatePdfPreview(input.body, {
      maxPages: env.PREVIEW_PAGE_COUNT,
    });
    previewPageCount = preview.previewPageCount;
    previewKey = newStorageKey('preview');
    storedPreview = await storage.put('derivatives', previewKey, preview.pdf, 'application/pdf');
  }

  // --- 5. Record, atomically -----------------------------------------------
  return withActor(actor, async (tx) => {
    const [product] = await tx
      .select({ id: products.id, titleAr: products.titleAr })
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    if (!product) throw new NotFoundError('المنتج غير موجود');

    // Replacing a file means removing the previous row for that role; the
    // unique index would otherwise reject the insert.
    await tx
      .delete(productFiles)
      .where(and(eq(productFiles.productId, input.productId), eq(productFiles.role, 'ORIGINAL')));
    if (previewKey) {
      await tx
        .delete(productFiles)
        .where(and(eq(productFiles.productId, input.productId), eq(productFiles.role, 'PREVIEW')));
    }

    const now = new Date();

    const [original] = await tx
      .insert(productFiles)
      .values({
        productId: input.productId,
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
    if (previewKey && storedPreview) {
      const [preview] = await tx
        .insert(productFiles)
        .values({
          productId: input.productId,
          role: 'PREVIEW',
          storageKey: previewKey,
          bucket: 'derivatives',
          originalFilename: `preview-${input.filename}`,
          contentType: 'application/pdf',
          container: 'PDF',
          byteSize: BigInt(storedPreview.byteSize),
          sha256: storedPreview.sha256,
          pageCount: previewPageCount,
          // A derivative the platform generated from an already-scanned file.
          scanStatus: 'CLEAN',
          scannedAt: now,
          uploadedBy: actor.kind === 'USER' ? actor.userId : null,
        })
        .returning({ id: productFiles.id });
      previewId = preview?.id ?? null;
    }

    await recordAudit(tx, actor, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product_file',
      entityId: original?.id ?? null,
      after: {
        productId: input.productId,
        filename: input.filename,
        declaredType: input.declaredType,
        container: verdict.container,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        scanStatus: scan.status,
        scanner: scan.scanner,
        previewGenerated: previewKey !== null,
        previewPageCount,
      },
    });

    return {
      originalFileId: original!.id,
      previewFileId: previewId,
      scanStatus: scan.status,
      pageCount,
      previewPageCount,
    };
  });
}
