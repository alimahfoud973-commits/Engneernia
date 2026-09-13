import 'server-only';
import { serverEnv } from '@/lib/config/env';
import { LogEmail } from './log';
import { SmtpEmail } from './smtp';
import type { EmailPort } from './port';

export * from './port';

let cached: EmailPort | undefined;

/**
 * Chooses an adapter from configuration, never from a build flag.
 *
 * A `log:` transport URL selects the logging adapter for local work; an
 * `smtp:`/`smtps:` URL selects real delivery. Production is refused the
 * logging adapter here as well as in `env.ts`, because this is the call site
 * that would otherwise turn a misconfiguration into customers who never
 * receive the mail that lets them buy.
 */
export function getEmail(): EmailPort {
  if (cached) return cached;
  const env = serverEnv();

  if (env.MAIL_TRANSPORT_URL.startsWith('log:')) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'The log mail transport is not permitted in production — verification emails '
        + 'would never leave the server. Configure an smtp:// or smtps:// MAIL_TRANSPORT_URL.',
      );
    }
    cached = new LogEmail();
    return cached;
  }

  cached = new SmtpEmail({ url: env.MAIL_TRANSPORT_URL, from: env.MAIL_FROM });
  return cached;
}

/** Test seam: forget the memoised adapter. */
export function resetEmailForTests(): void {
  cached = undefined;
}

/**
 * Test seam: install a capturing adapter.
 *
 * Integration tests need to read the verification LINK, not just observe that
 * something was sent — the link is the thing under test, and asserting on a
 * token pulled out of the database instead would test a different path from
 * the one a customer walks.
 */
export function setEmailForTests(port: EmailPort): void {
  cached = port;
}
