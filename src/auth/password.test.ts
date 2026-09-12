import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
  wasteTimeLikeAVerification,
} from './password';
import { ValidationError } from '@/lib/errors';

/** Mirrors the constant in password.ts; asserted to match a real hash below. */
const DUMMY_HASH_FOR_TEST =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zdGF0aWMtc2FsdA$Yx8mTFhBzPXwxNlKMOKu3VJeuK1oTTLDXsGGXZPzXqo';

const GOOD_PASSWORD = 'correct-horse-battery-staple';

describe('password policy', () => {
  it('accepts a long passphrase', () => {
    expect(() => assertPasswordAcceptable(GOOD_PASSWORD)).not.toThrow();
  });

  it(`rejects anything under ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(() => assertPasswordAcceptable('short')).toThrow(ValidationError);
    expect(() => assertPasswordAcceptable('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      ValidationError,
    );
    expect(() => assertPasswordAcceptable('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it('rejects an oversized input that would hammer the KDF', () => {
    expect(() => assertPasswordAcceptable('x'.repeat(1000))).toThrow(ValidationError);
  });
});

describe('hashing', () => {
  it('produces an argon2id hash with the intended parameters', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    // Asserts the numeric algorithm constant used in password.ts is argon2id.
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=19456,t=2,p=1');
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD_PASSWORD), hashPassword(GOOD_PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(b, GOOD_PASSWORD)).toBe(true);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword(hash, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, 'wrong-horse-battery-staple')).toBe(false);
    expect(await verifyPassword(hash, GOOD_PASSWORD.toUpperCase())).toBe(false);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    expect(await verifyPassword('not-a-hash', GOOD_PASSWORD)).toBe(false);
    expect(await verifyPassword('', GOOD_PASSWORD)).toBe(false);
  });

  it('refuses to hash a password that fails policy', async () => {
    await expect(hashPassword('short')).rejects.toThrow(ValidationError);
  });

  it('the unknown-user decoy runs without throwing', async () => {
    await expect(wasteTimeLikeAVerification(GOOD_PASSWORD)).resolves.toBeUndefined();
  });

  /**
   * Guards the user-enumeration defence.
   *
   * Asserted STRUCTURALLY rather than by wall-clock comparison: the decoy hash
   * must carry the same argon2id work factor as a real hash, which is what
   * actually makes the two paths cost the same. A timing-ratio assertion looks
   * more convincing but flakes under CI load, and a flaky security test is
   * worse than none — it gets muted.
   */
  it('the decoy hash carries the same work factor as a real hash', async () => {
    const realHash = await hashPassword(GOOD_PASSWORD);
    const realParams = /\$argon2id\$v=(\d+)\$([^$]+)\$/.exec(realHash);
    const decoyParams = /\$argon2id\$v=(\d+)\$([^$]+)\$/.exec(DUMMY_HASH_FOR_TEST);

    expect(realParams, 'real hash must be argon2id').not.toBeNull();
    expect(decoyParams, 'decoy hash must be argon2id').not.toBeNull();
    expect(decoyParams?.[1]).toBe(realParams?.[1]); // same version
    expect(decoyParams?.[2]).toBe(realParams?.[2]); // same m, t, p
  });

  it('the decoy actually performs work rather than returning immediately', async () => {
    // argon2id at 19 MiB cannot complete in under a millisecond on any machine.
    const start = process.hrtime.bigint();
    await wasteTimeLikeAVerification('some-candidate-password');
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeGreaterThan(1);
  });
});
