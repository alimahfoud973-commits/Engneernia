import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { resolveActor, sessionCookie } from '@/auth/session';
import { isOwner } from '@/authz/actor';
import { withActor } from '@/db/actor-context';
import { products } from '@/db/schema';
import { ingestProductFile } from '@/media/ingest';
import { MAX_UPLOAD_BYTES, type ProductFileType } from '@/media/file-types';
import { toUserMessage } from '@/lib/action-errors';
import { AppError, NotFoundError } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import {
  UploadTooLargeError, isSameOrigin, readBoundedBody, uploadFilename,
} from '@/lib/http/upload-request';

export const dynamic = 'force-dynamic';

function statusOf(error: unknown): number {
  return error instanceof AppError && error.httpStatus < 500 ? error.httpStatus : 500;
}

/**
 * The owner uploads a product file (S4-01) — a new version of the product.
 *
 * The body is the file itself, read as a bounded stream up to the ceiling for
 * THIS product's declared type (never a caller-chosen one); its name is the
 * `x-file-name` header. Everything that decides whether the file is accepted
 * — who may upload, the product's type, the file's structure, the scan, the
 * version rules — is `ingestProductFile`, unchanged from the Server Action
 * this replaces. A non-owner is a 404 (CLAUDE.md rule 5).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ productId: string }> },
) {
  const { productId } = await context.params;
  if (!isUuid(productId) || !isSameOrigin(request)) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const cookieStore = await cookies();
  const actor = await resolveActor(cookieStore.get(sessionCookie().name)?.value);
  if (!isOwner(actor)) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const filename = uploadFilename(request);
  if (!filename) {
    return NextResponse.json({ error: 'اختر ملفاً أولاً' }, { status: 400 });
  }

  // The ceiling comes from the product row: a caller cannot pick a larger one
  // by declaring another type.
  const [product] = await withActor(actor, (tx) =>
    tx.select({ fileType: products.fileType }).from(products).where(eq(products.id, productId)).limit(1));
  if (!product) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
  const declaredType = product.fileType as ProductFileType;

  try {
    const body = await readBoundedBody(request, MAX_UPLOAD_BYTES[declaredType]);
    if (body.byteLength === 0) {
      return NextResponse.json({ error: 'اختر ملفاً أولاً' }, { status: 400 });
    }
    const result = await ingestProductFile(actor, {
      productId,
      filename,
      declaredType,
      body,
      contentType: request.headers.get('content-type') || 'application/octet-stream',
    });
    // A version that waits for release is not an error, but the owner must be
    // told the product is still selling the previous file.
    return NextResponse.json({
      error: null,
      ...(result.activated ? {} : { waiting: result.versionNo }),
    });
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return NextResponse.json(
        { error: `حجم الملف يتجاوز الحد المسموح لهذا النوع (${error.limitBytes / 1024 / 1024} ميغابايت)` },
        { status: 413 },
      );
    }
    if (error instanceof NotFoundError) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    // Below 500 the error speaks for itself; above, it is logged and the
    // owner gets the generic sentence (the rule `toUserMessage` owns).
    return NextResponse.json({ error: toUserMessage(error, 'Product file upload failed') }, { status: statusOf(error) });
  }
}
