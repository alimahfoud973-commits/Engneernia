import { describe, it, expect } from 'vitest';
import {
  sessionCookieInvariant, sessionCookieName, sessionCookieOptions,
} from './session';

/**
 * ===========================================================================
 * THE COOKIE PREFIX AND THE `Secure` FLAG MUST AGREE
 * ===========================================================================
 * `__Host-` is a promise the BROWSER enforces, and it enforces it in silence:
 * a `__Host-` cookie sent without `Secure` is not stored, and nothing anywhere
 * says so. No error, no warning, no failing request — the next navigation is
 * simply unauthenticated.
 *
 * That shipped. The name was a constant carrying the prefix while `secure` was
 * `isProduction`, so development logins produced a cookie every browser threw
 * away. The page immediately after login looked right, because Next renders
 * the redirect target inside the same request where the cookie is still in the
 * jar; the next click was a guest. The whole of `/admin` and `/account` were
 * unreachable in `npm run dev` and no test noticed, because every integration
 * test builds its actor directly and never goes near a cookie.
 *
 * This file is the guard: it asserts the pair is coherent in BOTH environments
 * rather than asserting either half on its own.
 * ===========================================================================
 */

describe('the session cookie is coherent in every environment', () => {
  it.each([
    ['production', true],
    ['development', false],
  ])('%s satisfies the prefix rule', (_label, isProduction) => {
    expect(sessionCookieInvariant(isProduction)).toBeNull();
  });

  it('production keeps the __Host- guarantee, and earns it', () => {
    const options = sessionCookieOptions(true);
    expect(sessionCookieName(true)).toBe('__Host-em_session');
    expect(options.secure).toBe(true);
    expect(options.path).toBe('/');
    // A Domain attribute would void the prefix, so there must not be one.
    expect('domain' in options).toBe(false);
  });

  it('development drops the PREFIX rather than the guarantee', () => {
    /*
     * The alternative — keeping the prefix and forcing `Secure` in dev — works
     * on localhost, which browsers treat as a trustworthy origin, and breaks
     * again the moment the app is opened at a LAN address to test on a phone.
     * A plain name over plain HTTP claims nothing it cannot keep.
     */
    expect(sessionCookieName(false)).toBe('em_session');
    expect(sessionCookieName(false).startsWith('__Host-')).toBe(false);
    expect(sessionCookieOptions(false).secure).toBe(false);
  });

  it('is httpOnly and same-site in both, because those never depend on scheme', () => {
    for (const isProduction of [true, false]) {
      const options = sessionCookieOptions(isProduction);
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe('lax');
    }
  });
});
