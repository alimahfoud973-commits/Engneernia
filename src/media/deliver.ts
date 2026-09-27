import 'server-only';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  downloadEvents, entitlements, orderItems, orders, productFiles, products, productVersions,
} from '@/db/schema';
import { withActor } from '@/db/actor-context';
// Timestamps from SQL arrive as Date or string depending on the client (TD-11).
import { toDate } from '@/db';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError } from '@/lib/errors';
import { serverEnv } from '@/lib/config/env';
import { hashIp } from '@/auth/crypto';
import { logger } from '@/lib/logger';
import { getStorage, type BucketName, type DeliveryGrant } from './storage';
import { isServable } from './scanner';
import { stampPdfForBuyer, type BuyerStamp } from './personalise';

/**
 * ===========================================================================
 * AUTHORISED DELIVERY (specification §27, §41)
 * ===========================================================================
 * The only way bytes leave private storage.
 *
 * Authorisation is not re-implemented here. The file row is fetched inside an
 * actor-scoped transaction, so Row-Level Security decides what resolves: an
 * ORIGINAL simply does not exist for a caller who may not have it, and the
 * route cannot distinguish "absent" from "not yours" even if it wanted to.
 *
 * On top of that, two gates this layer owns:
 *   - a file that failed or skipped scanning is not served in production;
 *   - every delivery of an original is recorded before the bytes go out —
 *     and only once they are in hand (S4-07): authorise, read, record, send.
 * ===========================================================================
 */

/** Short by design: long enough to start a download, too short to share. */
export const ORIGINAL_URL_TTL_SECONDS = 60;
export const PREVIEW_URL_TTL_SECONDS = 600;

export interface DeliveryRequest {
  readonly productSlug: string;
  readonly role: 'ORIGINAL' | 'PREVIEW' | 'THUMBNAIL';
  /** A specific version (the buyer's own, from "my purchases"); absent = the default below. */
  readonly versionId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface DeliveryResponse {
  readonly grant: DeliveryGrant;
  readonly filename: string;
  readonly contentType: string;
}

/**
 * Read an object, telling "gone" apart from "storage failed".
 *
 * A missing object is a 404 like any other absence (the row outlived its
 * bytes — S4-07 found this counted as a download). Any other failure stays an
 * error: a storage outage reported as "not found" would hide itself.
 */
async function readObject(bucket: BucketName, key: string): Promise<Uint8Array> {
  const storage = getStorage();
  try {
    return await storage.get(bucket, key);
  } catch (error) {
    if (await storage.exists(bucket, key).catch(() => true)) throw error;
    logger.warn({ key }, 'File row has no stored object; answered as not found');
    throw new NotFoundError('الملف غير متاح');
  }
}

export async function deliverProductFile(
  actor: Actor,
  request: DeliveryRequest,
): Promise<DeliveryResponse> {
  const env = serverEnv();

  /** Set only for a buyer taking their own original — see OPEN-5 below. */
  let stamp: BuyerStamp | null = null;
  /** The grant a buyer's download is counted against, once the bytes are in hand. */
  let entitlementId: string | null = null;
  let grantReason = 'OWNER';

  /*
   * PHASE 1 — AUTHORISE. Nothing is recorded here (S4-07): a request that
   * ends in a 404, for any reason, leaves no count and no event behind.
   */
  const file = await withActor(actor, async (tx) => {
    /*
     * Every version's row of this role that the actor may see. RLS decides
     * that (migration 0059): the owner and the credited engineers see every
     * version, a buyer sees the versions they hold INSIDE their six-month
     * window, and a visitor sees the preview of the version on sale.
     */
    const rows = await tx
      .select({
        id: productFiles.id,
        productId: productFiles.productId,
        versionId: productFiles.versionId,
        versionNo: productVersions.versionNo,
        role: productFiles.role,
        storageKey: productFiles.storageKey,
        bucket: productFiles.bucket,
        originalFilename: productFiles.originalFilename,
        contentType: productFiles.contentType,
        byteSize: productFiles.byteSize,
        scanStatus: productFiles.scanStatus,
        currentVersionId: products.currentVersionId,
        filesPurgedAt: productVersions.filesPurgedAt,
      })
      .from(productFiles)
      .innerJoin(products, eq(products.id, productFiles.productId))
      .innerJoin(productVersions, eq(productVersions.id, productFiles.versionId))
      .where(and(
        eq(products.slug, request.productSlug),
        eq(productFiles.role, request.role),
        request.versionId ? eq(productFiles.versionId, request.versionId) : undefined,
      ))
      .orderBy(desc(productVersions.versionNo));

    // A purged version has no bytes left to give.
    const live = rows.filter((r) => r.filesPurgedAt === null);

    let buyerGrant: { id: string; grantedAt: unknown; orderNumber: string | null; versionId: string | null } | undefined;
    if (request.role === 'ORIGINAL' && actor.kind === 'USER' && !isOwner(actor) && live.length > 0) {
      /*
       * The buyer's own live grants on this product. Named explicitly — RLS
       * admits the owner to every grant (the reason `purchaseState` filters
       * too) — and inside the window: an expired grant is history, not access.
       */
      const grants = await tx
        .select({
          id: entitlements.id,
          grantedAt: entitlements.grantedAt,
          versionId: entitlements.versionId,
          // Left-joined: `order_item_id` is ON DELETE SET NULL, and a grant
          // can exist without an order behind it at all.
          orderNumber: orders.orderNumber,
        })
        .from(entitlements)
        .leftJoin(orderItems, eq(orderItems.id, entitlements.orderItemId))
        .leftJoin(orders, eq(orders.id, orderItems.orderId))
        .where(and(
          eq(entitlements.productId, live[0]!.productId),
          eq(entitlements.customerId, actor.userId),
          isNull(entitlements.revokedAt),
          gt(entitlements.expiresAt, sql`now()`),
        ));
      // Several grants after an upgrade: the one on the version on sale first,
      // then the newest version (`live` is newest first), then a legacy grant.
      const rank = (g: (typeof grants)[number]) => {
        if (g.versionId === null) return live.length + 1;
        if (g.versionId === live[0]!.currentVersionId) return -1;
        const at = live.findIndex((r) => r.versionId === g.versionId);
        return at === -1 ? Number.POSITIVE_INFINITY : at;
      };
      buyerGrant = grants
        .filter((g) => Number.isFinite(rank(g)))
        .sort((a, b) => rank(a) - rank(b))[0];
    }

    /*
     * Which version: the one asked for; otherwise the version on sale for
     * those who manage the product and for a buyer who holds it; otherwise a
     * buyer's newest version still in their window.
     */
    const current = live.find((r) => r.versionId === r.currentVersionId);
    const row = request.versionId
      ? live[0]
      : request.role !== 'ORIGINAL'
        ? current
        : buyerGrant
          ? (live.find((r) => r.versionId === buyerGrant!.versionId) ?? current ?? live[0])
          : (current ?? live[0]);

    // RLS already removed anything this actor may not see.
    if (!row) throw new NotFoundError('الملف غير متاح');

    if (!isServable(row.scanStatus, env.NODE_ENV === 'production')) {
      // Deliberately the same error as "not found": whether a file exists but
      // failed scanning is not information a visitor needs.
      throw new NotFoundError('الملف غير متاح');
    }

    if (row.role === 'ORIGINAL' && !isOwner(actor)) {
      const grant = buyerGrant && (buyerGrant.versionId === null || buyerGrant.versionId === row.versionId)
        ? buyerGrant
        : undefined;
      if (grant) {
        grantReason = 'ENTITLEMENT';
        entitlementId = grant.id;
        /**
         * What goes on the buyer's copy (OPEN-5). The name comes from the
         * session actor, so it is the account's own name and not anything a
         * request carried.
         */
        stamp = {
          buyerName: actor.kind === 'USER' ? actor.displayName : '',
          orderNumber: grant.orderNumber ?? null,
          purchasedAt: toDate(grant.grantedAt as never) ?? new Date(),
        };
      } else {
        // RLS admitted a non-owner without a live grant: a credited engineer.
        grantReason = 'CONTRIBUTOR';
      }
    }

    return row;
  });

  const isOriginal = file.role === 'ORIGINAL';

  /*
   * PHASE 3 — RECORD, after the object has been read (S4-07). The count and
   * the event are written once the bytes are in hand and before they leave;
   * a missing object, a failed read or a failed stamp records nothing.
   */
  const record = async (): Promise<void> => {
    if (!isOriginal) return;
    await withActor(actor, async (tx) => {
      if (entitlementId) {
        // Counts the download. Raises if the grant was revoked, or its window
        // closed, between authorisation and here — and then nothing is sent.
        await tx.execute(sql`SELECT app_record_entitlement_download(${entitlementId}::uuid)`);
      }
      const recorded = await tx.insert(downloadEvents).values({
        productFileId: file.id,
        // Denormalised so the record still identifies what was taken after the
        // product or its file row has been removed.
        productId: file.productId,
        productSlug: request.productSlug,
        filename: file.originalFilename,
        storageKey: file.storageKey,
        userId: actor.kind === 'USER' ? actor.userId : null,
        grantReason,
        ipHash: hashIp(request.ip),
        userAgent: request.userAgent ?? null,
        byteSize: file.byteSize,
      }).returning({ id: downloadEvents.id });

      /**
       * A refused write returns no rows; it does not raise. Without this, a
       * delivery whose record was silently dropped would still hand over the
       * bytes, and the trail this route exists to keep would have a hole.
       */
      if (recorded.length === 0) {
        throw new Error('download event was not recorded — refusing to release the file');
      }
    });
  };

  /**
   * ===========================================================================
   * THE BUYER'S COPY IS PERSONALISED (OPEN-5)
   * ===========================================================================
   * Only for a buyer (`stamp` is set on the ENTITLEMENT branch alone), only for
   * the original, and only for a PDF — nothing can write a visible mark into a
   * Revit model or a zip archive, and pretending otherwise would give the owner
   * a traceability they do not have.
   *
   * THIS PATH STREAMS, IT DOES NOT REDIRECT. A signed URL points at the master
   * in storage; handing one to a buyer would deliver the unstamped file and
   * quietly undo the whole feature. The bytes below exist for this one response
   * and are never written back — the stored original is untouched, which is the
   * owner's condition on this decision.
   */
  if (isOriginal && stamp && file.contentType === 'application/pdf') {
    const master = await readObject(file.bucket as BucketName, file.storageKey);
    const personalised = await stampPdfForBuyer(master, stamp);
    await record();

    return {
      grant: { kind: 'stream', body: personalised, contentType: file.contentType },
      filename: file.originalFilename,
      contentType: file.contentType,
    };
  }

  /**
   * ===========================================================================
   * THE PREVIEW IS SERVED FROM THIS ORIGIN, NEVER BY REDIRECT (Preview Display)
   * ===========================================================================
   * The product page shows the preview in an iframe, and its CSP allows frames
   * from this origin only (`frame-src 'self'`). A signed-URL redirect moves the
   * frame to the storage host — R2 in production — and the browser refuses to
   * display it: the preview was blank on every product page wherever storage
   * was S3-compatible. Streaming it here keeps the frame on this origin, so the
   * policy stays as narrow as it is instead of naming a storage host.
   *
   * A preview is a few generated pages, public by design, and already
   * authorised above; the original never takes this path.
   */
  if (file.role === 'PREVIEW') {
    return {
      grant: {
        kind: 'stream',
        body: await readObject(file.bucket as BucketName, file.storageKey),
        contentType: file.contentType,
      },
      filename: file.originalFilename,
      contentType: file.contentType,
    };
  }

  /*
   * A signed URL is not a read. The object is confirmed present first, so a
   * row whose bytes are gone answers 404 and counts nothing (S4-07); the
   * recorded download is then the one the grant hands over.
   */
  if (!(await getStorage().exists(file.bucket as BucketName, file.storageKey))) {
    logger.warn({ key: file.storageKey }, 'File row has no stored object; answered as not found');
    throw new NotFoundError('الملف غير متاح');
  }
  const grant = await getStorage().grantDelivery(file.bucket as BucketName, file.storageKey, {
    ttlSeconds: isOriginal ? ORIGINAL_URL_TTL_SECONDS : PREVIEW_URL_TTL_SECONDS,
    /**
     * An original is saved; a preview is looked at.
     *
     * The product page renders the preview in an iframe, so `attachment` there
     * makes the page offer a download instead of showing anything. That is what
     * production would have done on every product page, because the S3 adapter
     * said `attachment` for every role while development never reached the
     * signed-URL path at all.
     */
    disposition: isOriginal ? 'attachment' : 'inline',
    ...(isOriginal ? { downloadFilename: file.originalFilename } : {}),
    contentType: file.contentType,
  });

  await record();
  return { grant, filename: file.originalFilename, contentType: file.contentType };
}
