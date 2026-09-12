import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { paymentProofs } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { currentActor } from '@/auth/current';
import { getStorage } from '@/media/storage';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Serves a payment receipt to the owner reviewing it.
 *
 * RLS decides: the proofs policy admits the owner and the customer who
 * submitted it, and nobody else — a proof that is not yours does not resolve,
 * so this route cannot leak one even by id.
 *
 * The response is pinned to the content type that was PROVEN by inspecting
 * the bytes at upload, with nosniff, so a file that somehow got through as
 * something else still cannot be executed in the owner's browser.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ proofId: string }> },
) {
  const { proofId } = await context.params;

  try {
    const actor = await currentActor();

    const proof = await withActor(actor, async (tx) => {
      const [row] = await tx
        .select({
          storageKey: paymentProofs.storageKey,
          contentType: paymentProofs.contentType,
        })
        .from(paymentProofs)
        .where(eq(paymentProofs.id, proofId))
        .limit(1);
      return row ?? null;
    });

    if (!proof) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const bytes = await getStorage().get('originals', proof.storageKey);

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': proof.contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // A receipt is data, never a document that may run anything.
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.code }, { status: error.httpStatus });
    }
    logger.error({ err: error, proofId }, 'Proof delivery failed');
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
