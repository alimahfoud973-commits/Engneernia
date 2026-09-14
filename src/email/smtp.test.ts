import { describe, expect, it } from 'vitest';
import { parseSmtpUrl } from './smtp';

/**
 * The mail URL is the one credential the platform reads from a single string,
 * and a mistake in parsing it fails at the worst moment: nobody can register.
 * These cases are the ones an owner actually hits.
 */

describe('parseSmtpUrl', () => {
  it('defaults smtp:// to 587 and STARTTLS, not implicit TLS', () => {
    const c = parseSmtpUrl('smtp://mail.example.com');
    expect(c).toMatchObject({ host: 'mail.example.com', port: 587, secure: false });
    expect(c.auth).toBeUndefined();
  });

  it('defaults smtps:// to 465 and implicit TLS', () => {
    expect(parseSmtpUrl('smtps://mail.example.com'))
      .toMatchObject({ host: 'mail.example.com', port: 465, secure: true });
  });

  it('honours an explicit port', () => {
    expect(parseSmtpUrl('smtp://mail.example.com:2525').port).toBe(2525);
  });

  it('carries the credentials', () => {
    expect(parseSmtpUrl('smtps://alice:hunter2@mail.example.com').auth)
      .toEqual({ user: 'alice', pass: 'hunter2' });
  });

  it('percent-decodes a password containing URL punctuation', () => {
    /**
     * A password with an `@` or `:` MUST be encoded in a URL. Passing it on
     * still encoded authenticates with the wrong string, which the server
     * reports as a bad password — and the owner then changes a password that
     * was never wrong.
     */
    const c = parseSmtpUrl('smtps://user%40corp:p%40ss%3Aw%2Frd@mail.example.com');
    expect(c.auth).toEqual({ user: 'user@corp', pass: 'p@ss:w/rd' });
  });

  it('refuses a scheme that is not SMTP', () => {
    // `log://` is valid configuration elsewhere, and reaching this adapter
    // with it means the selection in `getEmail()` went wrong.
    expect(() => parseSmtpUrl('log://local')).toThrow(/smtp/i);
    expect(() => parseSmtpUrl('https://mail.example.com')).toThrow(/smtp/i);
  });

  it('refuses a URL with no host', () => {
    expect(() => parseSmtpUrl('smtp://')).toThrow();
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => parseSmtpUrl('mail.example.com:587')).toThrow();
  });
});
