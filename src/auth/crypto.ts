import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { serverEnv } from '@/lib/config/env';
import { ValidationError } from '@/lib/errors';

/**
 * Cryptographic helpers for the authentication path.
 *
 * Two different hashing jobs appear here and they must not be confused:
 *   - PASSWORDS are low-entropy and human-chosen: they need a slow, salted
 *     KDF (argon2id, see password.ts).
 *   - SESSION TOKENS are 256-bit random values: a fast SHA-256 is correct and
 *     a slow KDF would only add latency to every single request.
 */

const TOKEN_BYTES = 32;

/** A new session token. Returned raw once, stored only as a hash. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Hash an IP address before it touches the database or a log.
 * Keyed with the session secret so the hashes are not reversible by rainbow
 * table over the small IPv4 space.
 */
/**
 * A single-use token for a link sent by email (address verification today).
 *
 * Same primitives as a session token, deliberately a separate pair of
 * functions: the two have different lifetimes and different threat models, and
 * a future change to how sessions are minted must not silently change what
 * lands in people's inboxes.
 */
export function generateLinkToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashLinkToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256')
    .update(`${serverEnv().SESSION_SECRET}:${ip}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * AES-256-GCM encryption for secrets held at rest: TOTP seeds today, payment
 * provider credentials from phase P5. Authenticated, so a tampered ciphertext
 * fails to decrypt rather than yielding garbage.
 *
 * Format: v1.<iv>.<authTag>.<ciphertext>, all base64url. The version prefix
 * makes future key rotation or algorithm change a migration, not a guess.
 */
const ENCRYPTION_VERSION = 'v1';

function encryptionKey(): Buffer {
  const key = createHash('sha256').update(serverEnv().CONFIG_ENCRYPTION_KEY, 'utf8').digest();
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    throw new ValidationError('Malformed or unsupported encrypted payload');
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
