import 'server-only';
import { and, eq } from 'drizzle-orm';
import { downloadEvents, productFiles, products } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError } from '@/lib/errors';
import { serverEnv } from '@/lib/config/env';
import { hashIp } from '@/auth/crypto';
import { getStorage, type BucketName, type DeliveryGrant } from './storage';
import { isServable } from './scanner';

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
 *   - every delivery of an original is recorded before the bytes go out.
 * ===========================================================================
 */

/** Short by design: long enough to start a download, too short to share. */
export const ORIGINAL_URL_TTL_SECONDS = 60;
export const PREVIEW_URL_TTL_SECONDS = 600;

export interface DeliveryRequest {
  readonly productSlug: string;
  readonly role: 'ORIGINAL' | 'PREVIEW' | 'THUMBNAIL';
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface DeliveryResponse {
  readonly grant: DeliveryGrant;
  readonly filename: string;
  readonly contentType: string;
}

export async function deliverProductFile(
  actor: Actor,
  request: DeliveryRequest,
): Promise<DeliveryResponse> {
  const env = serverEnv();

  const file = await withActor(actor, async (tx) => {
    const [row] = await tx
      .select({
        id: productFiles.id,
        productId: productFiles.productId,
        role: productFiles.role,
        storageKey: productFiles.storageKey,
        bucket: productFiles.bucket,
        originalFilename: productFiles.originalFilename,
        contentType: productFiles.contentType,
        byteSize: productFiles.byteSize,
        scanStatus: productFiles.scanStatus,
      })
      .from(productFiles)
      .innerJoin(products, eq(products.id, productFiles.productId))
      .where(and(eq(products.slug, request.productSlug), eq(productFiles.role, request.role)))
      .limit(1);

    // RLS already removed anything this actor may not see.
    if (!row) throw new NotFoundError('الملف غير متاح');

    if (!isServable(row.scanStatus, env.NODE_ENV === 'production')) {
      // Deliberately the same error as "not found": whether a file exists but
      // failed scanning is not information a visitor needs.
      throw new NotFoundError('الملف غير متاح');
    }

    // Record the delivery of an original BEFORE the bytes are granted, so a
    // download cannot happen without a trail even if the transfer then fails.
    if (row.role === 'ORIGINAL') {
      await tx.insert(downloadEvents).values({
        productFileId: row.id,
        // Denormalised so the record still identifies what was taken after the
        // product or its file row has been removed.
        productId: row.productId,
        productSlug: request.productSlug,
        filename: row.originalFilename,
        storageKey: row.storageKey,
        userId: actor.kind === 'USER' ? actor.userId : null,
        grantReason: isOwner(actor) ? 'OWNER' : 'CONTRIBUTOR',
        ipHash: hashIp(request.ip),
        userAgent: request.userAgent ?? null,
        byteSize: row.byteSize,
      });
    }

    return row;
  });

  const grant = await getStorage().grantDelivery(file.bucket as BucketName, file.storageKey, {
    ttlSeconds: file.role === 'ORIGINAL' ? ORIGINAL_URL_TTL_SECONDS : PREVIEW_URL_TTL_SECONDS,
    downloadFilename: file.originalFilename,
    contentType: file.contentType,
  });

  return { grant, filename: file.originalFilename, contentType: file.contentType };
}
