/**
 * ===========================================================================
 * WHERE IT IS SAFE TO SEND SOMEONE AFTER SIGNING IN
 * ===========================================================================
 * The login form carries a `next` parameter so a visitor who was sent to sign
 * in lands back where they were. An attacker controls that parameter, so it is
 * an open-redirect primitive unless it is validated properly.
 *
 * THE CHECK THAT WAS HERE WAS `next.startsWith('/')`, AND IT IS NOT ENOUGH.
 * A browser reads `//evil.com` as a PROTOCOL-RELATIVE URL and navigates off
 * the site; the string starts with a slash all the same. `/\evil.com` is
 * treated the same way by several browsers, which normalise the backslash
 * before parsing. Both passed the old check.
 *
 * Why it matters here specifically: the destination is reached AFTER a
 * successful sign-in, so a phishing page can promise "sign in and you will be
 * returned to your account", send the victim through the platform's REAL
 * login, and land them on a copy of it — carrying the trust of having just
 * authenticated on the genuine site.
 *
 * This function is the only thing allowed to decide that destination.
 * ===========================================================================
 */

/** Where to land when there is no usable destination. */
export const DEFAULT_RETURN_PATH = '/account';

/**
 * Control characters, space and DEL — header-splitting and parser-confusion
 * fodder. Written as escapes so this source file holds no control byte itself.
 */
const UNSAFE_CHARACTERS = /[\u0000-\u0020\u007f]/;

/**
 * A safe same-origin path, or the fallback.
 *
 * Accepts only an absolute path on this site. Everything else — an absolute
 * URL, a protocol-relative URL, a backslash variant, a scheme, a control
 * character — is discarded rather than repaired: a destination that needs
 * repairing is a destination nobody meant to send anyone to.
 */
export function safeReturnPath(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_RETURN_PATH,
): string {
  if (typeof candidate !== 'string') return fallback;

  const value = candidate.trim();
  if (value.length === 0 || value.length > 512) return fallback;

  // Must be an absolute path on this site...
  if (!value.startsWith('/')) return fallback;

  // ...and NOT a protocol-relative URL. Browsers read "//host" as a host, and
  // normalise a backslash to a slash before doing so, so both forms must go.
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;

  // A backslash anywhere is never needed in a path this application generates,
  // and is a known normalisation trick.
  if (value.includes('\\')) return fallback;

  if (UNSAFE_CHARACTERS.test(value)) return fallback;

  return value;
}
