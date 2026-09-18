import { describe, expect, it } from 'vitest';
import { buildCsp, newNonce } from './csp';

/**
 * These tests guard the policy's SHAPE, not its taste.
 *
 * Each one corresponds to a way the header has historically been weakened by
 * accident: a stray `'unsafe-inline'` added to script-src to make something
 * work, a `*` pasted in to unblock an asset, a development relaxation left in
 * the production branch, a nonce reused across responses.
 */
describe('content security policy', () => {
  const production = buildCsp('NONCE_UNDER_TEST', false);
  const development = buildCsp('NONCE_UNDER_TEST', true);

  const directive = (policy: string, name: string): string => {
    const found = policy
      .split('; ')
      .find((part) => part === name || part.startsWith(`${name} `));
    if (!found) throw new Error(`directive ${name} is missing from: ${policy}`);
    return found;
  };

  it('carries the nonce it was given', () => {
    expect(directive(production, 'script-src')).toContain("'nonce-NONCE_UNDER_TEST'");
  });

  it('never allows inline scripts wholesale', () => {
    expect(directive(production, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(development, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('never allows eval in production', () => {
    expect(directive(production, 'script-src')).not.toContain("'unsafe-eval'");
  });

  it('allows eval only in development, where Next hot reload needs it', () => {
    expect(directive(development, 'script-src')).toContain("'unsafe-eval'");
  });

  it('opens no websocket in production', () => {
    expect(directive(production, 'connect-src')).toBe("connect-src 'self'");
  });

  it('has no wildcard source anywhere', () => {
    expect(production).not.toContain('*');
    expect(development).not.toContain('*');
  });

  it('names no external host', () => {
    expect(production).not.toMatch(/https?:\/\//);
  });

  it('refuses framing, plugins and injected base tags', () => {
    expect(directive(production, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(production, 'object-src')).toBe("object-src 'none'");
    expect(directive(production, 'base-uri')).toBe("base-uri 'none'");
  });

  it('confines form submissions to this origin', () => {
    expect(directive(production, 'form-action')).toBe("form-action 'self'");
  });

  it('falls back to default-src for anything not named', () => {
    expect(directive(production, 'default-src')).toBe("default-src 'self'");
  });

  it('allows the same-origin iframe the PDF preview needs', () => {
    expect(directive(production, 'frame-src')).toBe("frame-src 'self'");
  });

  it('upgrades insecure requests in production', () => {
    expect(directive(production, 'upgrade-insecure-requests'))
      .toBe('upgrade-insecure-requests');
  });

  /*
   * AND NOT IN DEVELOPMENT — the one relaxation here that is about reachability
   * rather than tooling.
   *
   * The directive is invisible on localhost, which the browser treats as
   * trustworthy and exempts. It applies on every other host, so on
   * `http://192.168.1.x:3000` — how a phone on the same Wi-Fi reaches a
   * development server — the browser re-requests every script, stylesheet and
   * font over https, the dev server speaks no TLS, and the page never
   * hydrates. No error reaches the server log and no form ever submits.
   *
   * Every automated check in this repository talks to localhost, so nothing
   * else in the suite can see this. This assertion is the whole guard.
   */
  it('does NOT upgrade in development, or the site is unreachable off localhost', () => {
    expect(development).not.toContain('upgrade-insecure-requests');
  });
});

describe('nonce', () => {
  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 500 }, () => newNonce()));
    expect(seen.size).toBe(500);
  });

  it('carries at least 128 bits and no characters that would break the header', () => {
    const nonce = newNonce();
    // base64 of 16 bytes
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
