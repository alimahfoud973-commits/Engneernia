import 'server-only';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { ValidationError } from '@/lib/errors';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy';

/**
 * Password hashing with argon2id.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet baseline for
 * argon2id (19 MiB memory, 2 iterations, 1 degree of parallelism). They are
 * stored inside the hash string, so raising them later re-hashes users
 * transparently on their next successful login rather than locking anyone out.
 */
const ARGON_OPTIONS = {
  // 2 === Algorithm.Argon2id. The package exports it as an ambient const enum,
  // which `verbatimModuleSyntax` cannot import; the numeric value is stable
  // and is asserted by the test suite.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The numbers themselves live in `password-policy.ts`, which carries no
 * `server-only` marker, so the sign-up form can state the same minimum it will
 * be judged against. Re-exported here so existing importers are unaffected.
 */
export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy';

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} محرفاً على الأقل`,
      { minLength: MIN_PASSWORD_LENGTH },
    );
  }
  // Guards against a denial-of-service through very long inputs hitting the KDF.
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError('كلمة المرور طويلة أكثر من اللازم', {
      maxLength: MAX_PASSWORD_LENGTH,
    });
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return argonHash(password, ARGON_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored
 * hash, so that a corrupt row cannot be distinguished from a wrong password.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await argonVerify(storedHash, password);
  } catch {
    return false;
  }
}

/**
 * A dummy verification used when the email does not exist, so that a login
 * attempt against an unknown address costs the same time as one against a
 * known address. Without it, response timing enumerates the user table.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zdGF0aWMtc2FsdA$Yx8mTFhBzPXwxNlKMOKu3VJeuK1oTTLDXsGGXZPzXqo';

export async function wasteTimeLikeAVerification(password: string): Promise<void> {
  try {
    await argonVerify(DUMMY_HASH, password);
  } catch {
    // Expected: the dummy hash never matches. The point is the elapsed time.
  }
}
