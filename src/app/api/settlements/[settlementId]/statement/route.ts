import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveActor, sessionCookie } from '@/auth/session';
import { statementDocument } from '@/settlements/queries';
import { renderStatementPdf } from '@/settlements/statement-pdf';
import { getPublicSettings } from '@/platform/settings';
import { logger } from '@/lib/logger';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

/**
 * The monthly settlement statement, as a PDF (owner decision).
 *
 * AUTHORISATION IS THE DATABASE'S. This route does not compare a contributor
 * id to anything: it asks for the settlement under the caller's own actor, and
 * the row-level policy on `settlements` decides whether it resolves. An
 * engineer requesting another engineer's statement gets the same 404 as one
 * requesting a settlement that does not exist — because to them, it does not.
 *
 * Generated fresh on every request from the frozen record. Nothing is stored,
 * so there is no second copy of financial data to protect and none to fall out
 * of step with the statement it was made from.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ settlementId: string }> },
) {
  const { settlementId } = await context.params;

  if (!isUuid(settlementId)) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  try {
    const cookieStore = await cookies();
    const actor = await resolveActor(cookieStore.get(sessionCookie().name)?.value);

    if (actor.kind !== 'USER') {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const document = await statementDocument(actor, settlementId);
    if (!document) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const settings = await getPublicSettings();

    const pdf = await renderStatementPdf({
      settlement: document.settlement,
      lines: document.lines,
      contributorName: document.contributorName,
      platformName: settings.platformName,
    });

    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.byteLength),
        'Content-Disposition':
          `attachment; filename*=UTF-8''${encodeURIComponent(`${document.settlement.reference}.pdf`)}`,
        // A financial document about one person. Never cached by a proxy, and
        // never kept by the browser once the session ends.
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    logger.error({ err: error, settlementId }, 'Statement rendering failed');
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
