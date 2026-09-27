import 'server-only';
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  entitlements, orderItems, orders, productFiles, products, productVersions,
} from '@/db/schema';
import { withActor, type Transaction } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { serverEnv } from '@/lib/config/env';
import { getStorage, type BucketName } from './storage';
import { isServable } from './scanner';
import { supportsPreview, type ProductFileType } from './file-types';

/**
 * ===========================================================================
 * PRODUCT VERSIONS (Stage 4 repair — S4-04, S4-05, S4-09, S4-10)
 * ===========================================================================
 * A file replaced on a product is a new version (migration 0059):
 *
 *   - a product that has never been on sale and has no buyer takes the new
 *     version at once, and the unsold one it replaces is discarded;
 *   - a product that is on sale, or whose version has been sold, keeps selling
 *     the version it has. The new one WAITS until the owner releases it, and
 *     releasing runs the same file checks as a first publication;
 *   - only the owner deletes a version. Deleting the version on sale takes the
 *     product off sale in the same transaction (owner decision);
 *   - a version's stored objects are removed only when nobody can still claim
 *     them: no buyer inside their six-month window and no order still waiting
 *     for its payment on that version.
 * ===========================================================================
 */

/** The file checks a version must pass to go on sale — the file half of publishBlockers. */
export function versionFileBlockers(input: {
  readonly fileType: ProductFileType;
  readonly files: ReadonlyArray<{ role: string; scanStatus: string }>;
}): readonly string[] {
  const blockers: string[] = [];
  const original = input.files.find((f) => f.role === 'ORIGINAL');
  if (!original) blockers.push('لم يُرفع الملف الأصلي');
  if (supportsPreview(input.fileType) && !input.files.some((f) => f.role === 'PREVIEW')) {
    blockers.push('لم تُولَّد معاينة الصفحات الخمس');
  }
  if (original && !isServable(original.scanStatus as never, serverEnv().NODE_ENV === 'production')) {
    blockers.push('الملف الأصلي لم يجتز فحص البرمجيات الخبيثة');
  }
  return blockers;
}

/** Whether anyone can still claim a version's file: a live window or an open order. */
async function versionStillClaimed(tx: Transaction, versionId: string): Promise<boolean> {
  const [held] = await tx
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(and(
      eq(entitlements.versionId, versionId),
      isNull(entitlements.revokedAt),
      gt(entitlements.expiresAt, sql`now()`),
    ))
    .limit(1);
  if (held) return true;
  const [waiting] = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(orderItems.versionId, versionId),
      notInArray(orders.status, ['CANCELLED', 'COMPLETED']),
    ))
    .limit(1);
  return Boolean(waiting);
}

/** Whether a version has ever been sold (a line or a grant names it). */
export async function versionEverSold(tx: Transaction, versionId: string): Promise<boolean> {
  const [line] = await tx.select({ id: orderItems.id }).from(orderItems)
    .where(eq(orderItems.versionId, versionId)).limit(1);
  if (line) return true;
  const [grant] = await tx.select({ id: entitlements.id }).from(entitlements)
    .where(eq(entitlements.versionId, versionId)).limit(1);
  return Boolean(grant);
}

/**
 * Remove the stored objects of retired versions nobody can still claim.
 *
 * Retired = deleted, superseded, or a pending version that was discarded. The
 * version on sale is never touched. Storage removal happens AFTER the rows
 * that make an object unreachable are committed; a removal that fails leaves
 * `files_purged_at` NULL, so the next run tries again — an object is only ever
 * left behind, never removed while something still points at it.
 */
export async function purgeRetiredVersionFiles(
  actor: Actor,
  scope?: { productId: string },
): Promise<{ purgedVersions: number; removedObjects: number; failedObjects: number }> {
  if (!isOwner(actor)) throw new RuleViolationError('حذف الملفات من صلاحية مالك المنصة وحده');

  const candidates = await withActor(actor, async (tx) => {
    const rows = await tx
      .select({ id: productVersions.id, productId: productVersions.productId })
      .from(productVersions)
      .innerJoin(products, eq(products.id, productVersions.productId))
      .where(and(
        isNull(productVersions.filesPurgedAt),
        or(sql`${productVersions.deletedAt} IS NOT NULL`, sql`${productVersions.supersededAt} IS NOT NULL`),
        or(isNull(products.currentVersionId), ne(products.currentVersionId, productVersions.id)),
        scope ? eq(productVersions.productId, scope.productId) : sql`true`,
      ));
    const out: Array<{ id: string; files: Array<{ bucket: string; storageKey: string }> }> = [];
    for (const row of rows) {
      if (await versionStillClaimed(tx, row.id)) continue;
      const files = await tx
        .select({ bucket: productFiles.bucket, storageKey: productFiles.storageKey })
        .from(productFiles)
        .where(eq(productFiles.versionId, row.id));
      out.push({ id: row.id, files });
    }
    return out;
  });

  let purgedVersions = 0, removedObjects = 0, failedObjects = 0;
  for (const version of candidates) {
    let allRemoved = true;
    for (const file of version.files) {
      try {
        await getStorage().remove(file.bucket as BucketName, file.storageKey);
        removedObjects += 1;
      } catch (error) {
        allRemoved = false;
        failedObjects += 1;
        logger.error({ err: error, versionId: version.id, key: file.storageKey }, 'Version file purge failed');
      }
    }
    if (!allRemoved) continue;
    await withActor(actor, async (tx) => {
      await tx.update(productVersions)
        .set({ filesPurgedAt: new Date() })
        .where(and(eq(productVersions.id, version.id), isNull(productVersions.filesPurgedAt)));
    });
    purgedVersions += 1;
  }
  return { purgedVersions, removedObjects, failedObjects };
}

/** Purge after a change, without letting a storage failure undo the committed change. */
export async function purgeQuietly(actor: Actor, productId: string): Promise<void> {
  try {
    await purgeRetiredVersionFiles(actor, { productId });
  } catch (error) {
    logger.error({ err: error, productId }, 'Version purge after change failed; objects kept for the next run');
  }
}

/**
 * The owner releases a waiting version: it becomes the version on sale.
 *
 * The same file checks as a first publication — an original, a clean scan, a
 * preview for a PDF — are run on THIS version. A release that fails them
 * changes nothing: the version on sale keeps selling.
 */
export async function activateVersion(
  actor: Actor,
  input: { productId: string; versionId: string },
): Promise<{ versionNo: number }> {
  if (!isOwner(actor)) throw new RuleViolationError('اعتماد الإصدارات من صلاحية مالك المنصة وحده');

  const result = await withActor(actor, async (tx) => {
    const [product] = await tx
      .select({ id: products.id, fileType: products.fileType, currentVersionId: products.currentVersionId })
      .from(products)
      .where(eq(products.id, input.productId))
      .for('update')
      .limit(1);
    if (!product) throw new NotFoundError('المنتج غير موجود');

    const [version] = await tx
      .select()
      .from(productVersions)
      .where(and(eq(productVersions.id, input.versionId), eq(productVersions.productId, product.id)))
      .limit(1);
    if (!version) throw new NotFoundError('الإصدار غير موجود');
    if (version.deletedAt) throw new RuleViolationError('هذا الإصدار محذوف');
    if (product.currentVersionId === version.id) throw new RuleViolationError('هذا هو الإصدار المعروض بالفعل');
    if (version.supersededAt) throw new RuleViolationError('لا يُعاد إصدار قديم إلى البيع؛ ارفع ملفه إصداراً جديداً');

    const files = await tx
      .select({ role: productFiles.role, scanStatus: productFiles.scanStatus })
      .from(productFiles)
      .where(eq(productFiles.versionId, version.id));
    const blockers = versionFileBlockers({ fileType: product.fileType as ProductFileType, files });
    if (blockers.length > 0) {
      throw new RuleViolationError(`لا يمكن اعتماد الإصدار ${version.versionNo}: ${blockers.join('، ')}`, { blockers });
    }

    const now = new Date();
    if (product.currentVersionId) {
      await tx.update(productVersions).set({ supersededAt: now })
        .where(eq(productVersions.id, product.currentVersionId));
    }
    await tx.update(productVersions).set({ activatedAt: now }).where(eq(productVersions.id, version.id));
    const updated = await tx.update(products)
      .set({ currentVersionId: version.id, updatedAt: now })
      .where(eq(products.id, product.id))
      .returning({ id: products.id });
    if (updated.length === 0) throw new RuleViolationError('لم يُطبَّق اعتماد الإصدار');

    await recordAudit(tx, actor, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product_version',
      entityId: version.id,
      before: { currentVersionId: product.currentVersionId },
      after: { productId: product.id, activatedVersionNo: version.versionNo },
    });
    return { versionNo: version.versionNo };
  });

  await purgeQuietly(actor, input.productId);
  return result;
}

/**
 * The owner deletes a version from the platform (S4-10).
 *
 * The row stays — orders, invoices and grants point at it — and so do the
 * stored files while any buyer is inside their window. Deleting the version on
 * sale takes the product off sale in the same transaction (owner decision), so
 * nothing is left on sale with no file behind it.
 */
export async function deleteVersion(
  actor: Actor,
  input: { productId: string; versionId: string },
): Promise<{ versionNo: number; unpublished: boolean }> {
  if (!isOwner(actor)) throw new RuleViolationError('حذف الملفات من صلاحية مالك المنصة وحده');

  const result = await withActor(actor, async (tx) => {
    const [product] = await tx
      .select({ id: products.id, status: products.status, currentVersionId: products.currentVersionId })
      .from(products)
      .where(eq(products.id, input.productId))
      .for('update')
      .limit(1);
    if (!product) throw new NotFoundError('المنتج غير موجود');

    const [version] = await tx
      .select({ id: productVersions.id, versionNo: productVersions.versionNo, deletedAt: productVersions.deletedAt })
      .from(productVersions)
      .where(and(eq(productVersions.id, input.versionId), eq(productVersions.productId, product.id)))
      .limit(1);
    if (!version) throw new NotFoundError('الإصدار غير موجود');
    if (version.deletedAt) throw new RuleViolationError('هذا الإصدار محذوف بالفعل');

    const now = new Date();
    const isCurrent = product.currentVersionId === version.id;
    const unpublish = isCurrent && product.status === 'PUBLISHED';

    if (isCurrent) {
      const updated = await tx.update(products)
        .set({ currentVersionId: null, ...(unpublish ? { status: 'UNPUBLISHED' as const } : {}), updatedAt: now })
        .where(eq(products.id, product.id))
        .returning({ id: products.id });
      if (updated.length === 0) throw new RuleViolationError('لم يُطبَّق حذف الإصدار');
    }
    const marked = await tx.update(productVersions)
      .set({ deletedAt: now, deletedBy: actor.kind === 'USER' ? actor.userId : null })
      .where(and(eq(productVersions.id, version.id), isNull(productVersions.deletedAt)))
      .returning({ id: productVersions.id });
    if (marked.length === 0) throw new RuleViolationError('لم يُطبَّق حذف الإصدار');

    if (unpublish) {
      await recordAudit(tx, actor, {
        action: 'PRODUCT_UNPUBLISHED',
        entityType: 'product',
        entityId: product.id,
        before: { status: product.status },
        after: { status: 'UNPUBLISHED', note: `حُذف ملف الإصدار ${version.versionNo} المعروض` },
      });
    }
    await recordAudit(tx, actor, {
      action: 'PRODUCT_UPDATED',
      entityType: 'product_version',
      entityId: version.id,
      after: { productId: product.id, deletedVersionNo: version.versionNo, wasCurrent: isCurrent },
    });
    return { versionNo: version.versionNo, unpublished: unpublish };
  });

  await purgeQuietly(actor, input.productId);
  return result;
}

/** The versions of a product, newest first, with what the owner needs to decide. */
export async function productVersionsForOwner(tx: Transaction, productId: string, fileType: ProductFileType) {
  const [product] = await tx.select({ currentVersionId: products.currentVersionId })
    .from(products).where(eq(products.id, productId)).limit(1);
  const versions = await tx.select().from(productVersions)
    .where(eq(productVersions.productId, productId))
    .orderBy(desc(productVersions.versionNo));
  if (versions.length === 0) return [];
  const ids = versions.map((v) => v.id);
  const files = await tx
    .select({
      versionId: productFiles.versionId, role: productFiles.role, scanStatus: productFiles.scanStatus,
      originalFilename: productFiles.originalFilename, byteSize: productFiles.byteSize,
    })
    .from(productFiles)
    .where(inArray(productFiles.versionId, ids));
  const buyers = await tx
    .select({ versionId: entitlements.versionId, n: sql<number>`count(*)::int`, live: sql<number>`count(*) filter (where ${entitlements.expiresAt} > now())::int` })
    .from(entitlements)
    .where(and(inArray(entitlements.versionId, ids), isNull(entitlements.revokedAt)))
    .groupBy(entitlements.versionId);
  return versions.map((v) => {
    const own = files.filter((f) => f.versionId === v.id);
    const original = own.find((f) => f.role === 'ORIGINAL');
    const counts = buyers.find((b) => b.versionId === v.id);
    const isCurrent = product?.currentVersionId === v.id;
    const pending = !isCurrent && !v.activatedAt && !v.deletedAt;
    return {
      id: v.id,
      versionNo: v.versionNo,
      createdAt: v.createdAt,
      activatedAt: v.activatedAt,
      supersededAt: v.supersededAt,
      deletedAt: v.deletedAt,
      filesPurged: v.filesPurgedAt !== null,
      isCurrent,
      pending,
      filename: original?.originalFilename ?? null,
      byteSize: original?.byteSize ?? null,
      scanStatus: original?.scanStatus ?? null,
      buyers: counts?.n ?? 0,
      buyersInWindow: counts?.live ?? 0,
      blockers: pending ? versionFileBlockers({ fileType, files: own }) : [],
    };
  });
}
