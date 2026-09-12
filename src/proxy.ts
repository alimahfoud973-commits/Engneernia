import createIntlMiddleware from 'next-intl/middleware';
import { routing } from '@/i18n/routing';

/**
 * Next 16 names this layer `proxy` (formerly `middleware`).
 *
 * Locale resolution runs here today. From phase P1 it also carries the
 * deny-by-default route gate (report §F, layer 1): any path under /admin or
 * /contributor without a valid session of the right role is rejected before a
 * page ever renders.
 */
export default createIntlMiddleware(routing);

export const config = {
  // Skip Next internals, API routes and anything with a file extension.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
