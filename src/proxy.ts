import { NextRequest, NextResponse } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from '@/i18n/routing';
import { buildCsp, newNonce } from '@/lib/security/csp';

/**
 * Next 16 names this layer `proxy` (formerly `middleware`).
 *
 * Two jobs, in order: mint the per-response CSP nonce, then hand the request
 * to next-intl for locale resolution.
 *
 * A NOTE ON WHAT THIS LAYER IS NOT. An earlier version of this comment
 * promised that "from phase P1 it also carries the deny-by-default route
 * gate". It never did, and it should not: authorisation on this platform is
 * decided by Row-Level Security inside the request's own transaction, and by
 * an explicit check at the top of every guarded page. A cookie inspected out
 * here proves nothing — the session behind it may be revoked, expired, or for
 * a role that changed a second ago — so a gate here would be a THIRD, weaker
 * opinion about a question two stronger layers already answer. The promise is
 * removed rather than implemented.
 */
const handleI18nRouting = createIntlMiddleware(routing);

const isDevelopment = process.env.NODE_ENV !== 'production';

export default function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp(nonce, isDevelopment);

  /**
   * The nonce travels on the REQUEST, not just the response.
   *
   * Next mints its inline bootstrap scripts during rendering, downstream of
   * here, and it discovers the nonce by parsing the `Content-Security-Policy`
   * request header. Setting the header only on the response would produce a
   * policy whose nonce matches nothing on the page — every Next script
   * blocked, a blank site, and a CSP report for each one.
   *
   * `request.headers` is frozen in this layer, so the headers are copied onto
   * a new request rather than mutated.
   */
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  const response = handleI18nRouting(new NextRequest(request, { headers }));

  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Skip Next internals, API routes and anything with a file extension.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
