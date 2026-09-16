import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { resolveActor, sessionCookie } from '@/auth/session';
import { deliverProductFile } from '@/media/deliver';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const ROLES = new Set(['ORIGINAL', 'PREVIEW', 'THUMBNAIL']);

/**
 * The single entry point to stored files.
 *
 * There is no other route, rewrite or static path that reaches a bucket.
 * A preview is public; an original resolves only for someone Row-Level
 * Security says may have it, and everything else gets 404.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string; role: string }> },
) {
  const { slug, role } = await context.params;
  const upper = role.toUpperCase();

  if (!ROLES.has(upper)) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  try {
    const cookieStore = await cookies();
    const headerStore = await headers();
    const actor = await resolveActor(cookieStore.get(sessionCookie().name)?.value);

    const result = await deliverProductFile(actor, {
      productSlug: slug,
      role: upper as 'ORIGINAL' | 'PREVIEW' | 'THUMBNAIL',
      ip: headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: headerStore.get('user-agent'),
    });

    if (result.grant.kind === 'redirect') {
      return NextResponse.redirect(result.grant.url, { status: 302 });
    }

    const disposition =
      upper === 'ORIGINAL'
        ? `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`
        : 'inline';

    return new NextResponse(Buffer.from(result.grant.body), {
      status: 200,
      headers: {
        'Content-Type': result.grant.contentType,
        'Content-Disposition': disposition,
        // Never cached by a shared cache: the URL is the same for everyone,
        // the authorisation is not.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.code }, { status: error.httpStatus });
    }
    logger.error({ err: error, slug, role }, 'File delivery failed');
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
