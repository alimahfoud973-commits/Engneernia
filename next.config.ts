import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Security headers applied to every response.
 *
 * The Content-Security-Policy is NOT here: it carries a per-response nonce, so
 * it can only be built where the response is — `src/proxy.ts`, from
 * `src/lib/security/csp.ts`. These are the headers whose value is the same for
 * every response and therefore safe to declare statically.
 *
 * X-Frame-Options duplicates the CSP's `frame-ancestors 'none'` on purpose:
 * the two are read by different browser generations, and API responses (which
 * the proxy's matcher skips) are covered by this list alone.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Never let a build ship with type errors. Linting is a separate CI gate
  // (Next 16 removed build-time linting), wired in .github/workflows/ci.yml.
  typescript: { ignoreBuildErrors: false },
  // Original product files are NEVER served through the Next image/static layer.
  images: { remotePatterns: [] },
  /*
   * Native addons, left as runtime requires rather than bundled.
   *
   * @napi-rs/canvas and mupdf ship platform-specific .node binaries. Turbopack
   * cannot place a non-ECMAScript asset in an ESM chunk, and the failure only
   * appears once one of them is reached from a ROUTE HANDLER — which is what
   * the settlement statement PDF does. Declaring them external tells Next to
   * require them at runtime instead of trying to bundle the binary.
   */
  serverExternalPackages: ['@napi-rs/canvas', 'mupdf'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
