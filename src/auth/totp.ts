import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '@/lib/errors';
import { base32Decode, base32Encode } from './base32';

/**
 * TOTP (RFC 6238) — second factor for the owner account.
 *
 * Implemented directly against the RFC and verified with its published test
 * vectors (see totp.test.ts). Authentication is the last place to take a
 * dependency you have not read.
 */

export interface TotpOptions {
  /** Seconds per code. 30 is what every authenticator app assumes. */
  readonly stepSeconds?: number;
  readonly digits?: number;
  readonly algorithm?: 'sha1' | 'sha256' | 'sha512';
  /**
   * How many steps either side of now are accepted, to tolerate clock drift.
   * 1 means the previous, current and next code work — roughly a 90 s window.
   */
  readonly window?: number;
}

const DEFAULTS = {
  stepSeconds: 30,
  digits: 6,
  algorithm: 'sha1' as const,
  window: 1,
};

/** A fresh 160-bit secret, the size RFC 4226 recommends for SHA-1. */
export function generateTotpSecret(): string {
  return base32Encode(new Uint8Array(randomBytes(20)));
}

function hotp(secret: Uint8Array, counter: bigint, digits: number, algorithm: string): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);

  const digest = createHmac(algorithm, Buffer.from(secret)).update(counterBytes).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function generateTotp(
  base32Secret: string,
  atMs: number = Date.now(),
  options: TotpOptions = {},
): string {
  const { stepSeconds, digits, algorithm } = { ...DEFAULTS, ...options };
  const counter = BigInt(Math.floor(atMs / 1000 / stepSeconds));
  return hotp(base32Decode(base32Secret), counter, digits, algorithm);
}

/**
 * Constant-time verification across the drift window.
 *
 * The comparison is timing-safe and the loop always runs every candidate, so
 * neither the code's value nor its position in the window leaks through
 * response time.
 */
export function verifyTotp(
  base32Secret: string,
  candidate: string,
  atMs: number = Date.now(),
  options: TotpOptions = {},
): boolean {
  const { stepSeconds, digits, algorithm, window } = { ...DEFAULTS, ...options };

  const normalised = candidate.replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalised)) {
    return false;
  }

  const secret = base32Decode(base32Secret);
  const currentStep = BigInt(Math.floor(atMs / 1000 / stepSeconds));
  const candidateBuffer = Buffer.from(normalised, 'utf8');

  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, currentStep + BigInt(offset), digits, algorithm);
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (
      expectedBuffer.length === candidateBuffer.length &&
      timingSafeEqual(expectedBuffer, candidateBuffer)
    ) {
      matched = true;
    }
  }
  return matched;
}

/** The otpauth:// URI an authenticator app scans. */
export function totpProvisioningUri(
  base32Secret: string,
  accountLabel: string,
  issuer: string,
): string {
  if (accountLabel.trim().length === 0) {
    throw new ValidationError('Account label is required for a provisioning URI');
  }
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: base32Secret.replace(/=+$/, ''),
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULTS.digits),
    period: String(DEFAULTS.stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
