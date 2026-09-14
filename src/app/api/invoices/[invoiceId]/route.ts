import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveActor, SESSION_COOKIE_NAME } from '@/auth/session';
import { invoiceDocument } from '@/finance/invoice-queries';
import { renderInvoicePdf } from '@/finance/invoice-pdf';
import { logger } from '@/lib/logger';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

/**
 * A customer's invoice, as a PDF (owner decision on OPEN-9).
 *
 * AUTHORISATION IS THE DATABASE'S. This route compares no ids: it asks for the
 * invoice under the caller's own actor, and the row-level policy decides
 * whether it resolves. Somebody requesting another customer's invoice gets the
 * same 404 as one requesting an invoice that does not exist — because to them,
 * it does not (§36).
 *
 * The id is checked with `isUuid` at the edge so a malformed one is a 404 and
 * not a 500 from the driver — the project's rule for every id in a path.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await context.params;

  if (!isUuid(invoiceId)) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  try {
    const cookieStore = await cookies();
    const actor = await resolveActor(cookieStore.get(SESSION_COOKIE_NAME)?.value);

    if (actor.kind !== 'USER') {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const document = await invoiceDocument(actor, invoiceId);
    if (!document) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const pdf = await renderInvoicePdf(document);

    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          `attachment; filename="${document.invoiceNumber}.pdf"`,
        // A financial document must never sit in a shared cache.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    logger.error({ err: error, invoiceId }, 'Rendering an invoice failed');
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
