import { describe, expect, it } from 'vitest';
import { accountAlreadyExistsEmail, verificationEmail } from './templates';

/**
 * The mail bodies are HTML built by string concatenation, and one of the
 * values in them — the display name — is whatever a stranger typed into a
 * public form. These tests exist for that one fact.
 */

const BASE = {
  to: 'someone@example.test',
  url: 'https://engineernia.test/verify-email?token=abc123',
  platformName: 'إنجينيرنيا',
  expiresInHours: 24,
};

describe('verificationEmail', () => {
  it('escapes a display name that carries markup', () => {
    const message = verificationEmail({
      ...BASE,
      displayName: '<a href="https://evil.test">اضغط هنا</a>',
    });

    // The point is not that the text is absent — it is that it cannot act.
    expect(message.html).not.toContain('<a href="https://evil.test"');
    expect(message.html).toContain('&lt;a href=&quot;https://evil.test&quot;&gt;');
  });

  it('escapes an address that carries markup', () => {
    const message = verificationEmail({
      ...BASE,
      to: '"><img src=x onerror=alert(1)>@example.test',
      displayName: 'زين',
    });

    expect(message.html).not.toContain('<img src=x');
    expect(message.html).toContain('&lt;img src=x');
  });

  it('carries the link in both the HTML and the plain-text body', () => {
    const message = verificationEmail({ ...BASE, displayName: 'زين' });

    // A recipient whose client refuses HTML must still be able to verify.
    expect(message.text).toContain(BASE.url);
    expect(message.html).toContain(BASE.url);
  });

  it('states the expiry, because a link that silently dies reads as a broken site', () => {
    const message = verificationEmail({ ...BASE, displayName: 'زين' });
    expect(message.text).toContain('24');
    expect(message.html).toContain('24');
  });
});

describe('accountAlreadyExistsEmail', () => {
  const ARGS = {
    to: 'someone@example.test',
    displayName: 'زين',
    signInUrl: 'https://engineernia.test/login',
    platformName: 'إنجينيرنيا',
  };

  it('contains no verification link — nothing was issued', () => {
    const message = accountAlreadyExistsEmail(ARGS);
    expect(message.text).not.toContain('verify-email');
    expect(message.html).not.toContain('verify-email');
  });

  it('says plainly that nothing about the account changed', () => {
    const message = accountAlreadyExistsEmail(ARGS);
    expect(message.text).toContain('لم تُغيَّر كلمة مرورك');
  });

  it('escapes the display name here too', () => {
    const message = accountAlreadyExistsEmail({ ...ARGS, displayName: '<script>x</script>' });
    expect(message.html).not.toContain('<script>');
  });
});
