import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveActor, sessionCookie } from '@/auth/session';
import { submitPaymentProof, PROOF_MAX_BYTES } from '@/commerce/proofs';
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
 * The buyer uploads the receipt for their own payment (S4-01).
 *
 * Bounded at the receipt ceiling (10 MB) while streaming. Whose payment it
 * is, the payment's state, the file's type and signature and the scan are all
 * `submitPaymentProof`, unchanged from the Server Action this replaces — and
 * ownership is still settled there before any byte is stored (W14). A guest,
 * or a payment that is not the caller's, is a 404 (CLAUDE.md rule 5).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ paymentId: string }> },
) {
  const { paymentId } = await context.params;
  if (!isUuid(paymentId) || !isSameOrigin(request)) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const cookieStore = await cookies();
  const actor = await resolveActor(cookieStore.get(sessionCookie().name)?.value);
  if (actor.kind !== 'USER') {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  const filename = uploadFilename(request);
  if (!filename) {
    return NextResponse.json({ error: 'يرجى اختيار صورة الإيصال' }, { status: 400 });
  }
  let referenceNote: string | null = null;
  try {
    referenceNote = decodeURIComponent(request.headers.get('x-reference-note') ?? '').trim() || null;
  } catch {
    return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
  }
  if (referenceNote !== null && referenceNote.length > 200) {
    return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
  }

  try {
    const body = await readBoundedBody(request, PROOF_MAX_BYTES);
    if (body.byteLength === 0) {
      return NextResponse.json({ error: 'يرجى اختيار صورة الإيصال' }, { status: 400 });
    }
    await submitPaymentProof(actor, { paymentId, filename, body, referenceNote });
    return NextResponse.json({ error: null });
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return NextResponse.json({ error: 'حجم إثبات الدفع يتجاوز الحد المسموح (10 ميغابايت)' }, { status: 413 });
    }
    if (error instanceof NotFoundError) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    return NextResponse.json({ error: toUserMessage(error, 'Payment proof upload failed') }, { status: statusOf(error) });
  }
}
