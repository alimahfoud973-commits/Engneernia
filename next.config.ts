import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Security headers applied to every response.
 * CSP is intentionally strict: no `unsafe-eval`, no wildcard sources.
 * `unsafe-inline` for styles is required by Next's streaming style injection;
 * scripts use nonces in production (see middleware, phase P1).
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
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
