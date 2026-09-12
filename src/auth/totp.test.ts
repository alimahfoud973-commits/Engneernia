import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode } from './base32';
import { generateTotp, generateTotpSecret, totpProvisioningUri, verifyTotp } from './totp';
import { ValidationError } from '@/lib/errors';

describe('base32 (RFC 4648 test vectors)', () => {
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];

  for (const [plain, encoded] of vectors) {
    it(`encodes ${JSON.stringify(plain)}`, () => {
      expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded);
    });
  }

  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZXW6!!!')).toThrow(ValidationError);
    expect(() => base32Decode('')).toThrow(ValidationError);
  });
});

/**
 * The published RFC 6238 test vectors. If this suite passes, the
 * implementation interoperates with Google Authenticator, Authy, 1Password
 * and every other standards-compliant app.
 */
describe('TOTP (RFC 6238 published test vectors)', () => {
  // The RFC's SHA-1 secret is the ASCII string "12345678901234567890".
  const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

  const vectors: ReadonlyArray<readonly [number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [unixSeconds, expected] of vectors) {
    it(`T=${unixSeconds} produces ${expected}`, () => {
      expect(generateTotp(RFC_SECRET, unixSeconds * 1000, { digits: 8 })).toBe(expected);
    });
  }
});

describe('TOTP verification', () => {
  const secret = generateTotpSecret();
  const now = 1_789_000_000_000;

  it('accepts the current code', () => {
    expect(verifyTotp(secret, generateTotp(secret, now), now)).toBe(true);
  });

  it('accepts the previous and next code, for clock drift', () => {
    expect(verifyTotp(secret, generateTotp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, generateTotp(secret, now + 30_000), now)).toBe(true);
  });

  it('rejects a code from outside the drift window', () => {
    expect(verifyTotp(secret, generateTotp(secret, now - 120_000), now)).toBe(false);
    expect(verifyTotp(secret, generateTotp(secret, now + 120_000), now)).toBe(false);
  });

  it('rejects a code generated from a different secret', () => {
    expect(verifyTotp(secret, generateTotp(generateTotpSecret(), now), now)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78 90']) {
      expect(verifyTotp(secret, bad, now)).toBe(false);
    }
  });

  it('tolerates whitespace in a pasted code', () => {
    const code = generateTotp(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });

  it('generates distinct secrets', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(50);
  });
});

describe('provisioning URI', () => {
  it('produces a scannable otpauth URI', () => {
    const uri = totpProvisioningUri('JBSWY3DPEHPK3PXP', 'owner@example.com', 'Engineering');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Engineering');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('rejects an empty account label', () => {
    expect(() => totpProvisioningUri('JBSWY3DPEHPK3PXP', '  ', 'Engineering')).toThrow(
      ValidationError,
    );
  });
});
