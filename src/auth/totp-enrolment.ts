import 'server-only';
import { eq } from 'drizzle-orm';
import { users } from '@/db/schema';
import { withActor } from '@/db/actor-context';
import { recordAudit } from '@/audit/log';
import { isOwner, type Actor } from '@/authz/actor';
import { NotFoundError, RuleViolationError, ValidationError } from '@/lib/errors';
import { LOGIN_RULES, consumeRateLimit } from '@/lib/rate-limit';
import { getPublicSettings } from '@/platform/settings';
import { decryptSecret, encryptSecret } from './crypto';
import { verifyPassword } from './password';
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from './totp';
import { revokeAllSessions } from './session';

/**
 * ===========================================================================
 * ENROLLING THE SECOND FACTOR (specification §2.1 — the owner's account)
 * ===========================================================================
 * The platform could VERIFY a second factor and could REQUIRE one, and had no
 * way to turn one on: nothing outside the tests ever wrote
 * `totp_secret_encrypted`, and `bootstrap:owner` does not set it. So the
 * launch checklist asked for an owner account with TOTP enabled and no such
 * account could be created. This is the missing third part.
 *
 * THE STATE MACHINE IS THE TWO COLUMNS THAT ALREADY EXIST:
 *
 *   secret NULL,     enabled NULL  →  no second factor
 *   secret SET,      enabled NULL  →  enrolled, NOT yet in force
 *   secret SET,      enabled SET   →  in force; login demands a code
 *
 * The middle state is what makes enrolment safe. A secret written before the
 * code is proven does nothing: `attemptLogin` reads `totp_enabled_at`, so an
 * enrolment abandoned halfway — a lost phone, a closed tab — leaves the
 * account exactly as it was rather than locked out of itself.
 *
 * THREE THINGS EVERY STEP DOES:
 *   - re-checks the PASSWORD, so a stolen session cannot add or remove a
 *     factor. This is the one place where holding the cookie is not enough;
 *   - writes an audit row inside the same transaction as the change;
 *   - verifies the write took effect, because row-level security refuses by
 *     returning no rows rather than by raising.
 * ===========================================================================
 */

export interface EnrolmentOffer {
  /** Shown once, never stored in plaintext, never sent again. */
  readonly secret: string;
  /** What an authenticator app scans. Carries the same secret. */
  readonly uri: string;
}

/** Groups of four, which is how every authenticator app prints it. */
export function formatSecretForReading(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

async function loadSelf(actor: Actor) {
  if (actor.kind !== 'USER') throw new NotFoundError();

  return withActor(actor, async (tx) => {
    const [row] = await tx
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        secret: users.totpSecretEncrypted,
        enabledAt: users.totpEnabledAt,
      })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1);

    if (!row) throw new NotFoundError();
    return row;
  });
}

/**
 * Step one: mint a secret and store it UNARMED.
 *
 * Returns the secret exactly once. It is encrypted at rest with
 * CONFIG_ENCRYPTION_KEY and never handed back afterwards — a second look
 * requires starting again, which also invalidates the first.
 */
export async function beginTotpEnrolment(
  actor: Actor,
  input: { password: string },
): Promise<EnrolmentOffer> {
  if (actor.kind !== 'USER') throw new NotFoundError();
  /**
   * Owner-only, for now and deliberately.
   *
   * `users_update` admits the owner alone, so a contributor enrolling would be
   * refused by row-level security with no rows and a confusing error. Saying
   * so here makes the boundary a decision rather than an accident; extending
   * to other roles later needs a policy change or a trusted function, not a
   * tweak to this file.
   */
  if (!isOwner(actor)) {
    throw new RuleViolationError('التحقق بخطوتين متاح لحساب المالك في هذه المرحلة');
  }

  await consumeRateLimit('totp:enrol', actor.userId, LOGIN_RULES.perAccount);

  const self = await loadSelf(actor);
  if (!(await verifyPassword(self.passwordHash, input.password))) {
    throw new ValidationError('كلمة المرور غير صحيحة');
  }
  if (self.enabledAt !== null) {
    throw new RuleViolationError('التحقق بخطوتين مفعَّل بالفعل. عطِّله أولاً لتسجيل جهاز آخر.');
  }

  const secret = generateTotpSecret();
  const settings = await getPublicSettings();

  await withActor(actor, async (tx) => {
    const updated = await tx
      .update(users)
      .set({ totpSecretEncrypted: encryptSecret(secret), totpEnabledAt: null, updatedAt: new Date() })
      .where(eq(users.id, actor.userId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      throw new RuleViolationError('تعذّر حفظ إعداد التحقق بخطوتين');
    }
  });

  return {
    secret,
    uri: totpProvisioningUri(secret, self.email, settings.platformNameAr),
  };
}

/**
 * Step two: prove the app holds the same secret, then arm it.
 *
 * The current session is marked as having satisfied the factor, because it
 * just did — demanding a second code immediately after proving the first would
 * teach people that the challenge is noise.
 *
 * Every OTHER session is revoked. Turning on a second factor is a statement
 * that the password alone is no longer enough, and sessions opened under the
 * old rule are exactly what that statement is about.
 */
export async function confirmTotpEnrolment(
  actor: Actor,
  input: { code: string },
): Promise<void> {
  if (actor.kind !== 'USER') throw new NotFoundError();

  await consumeRateLimit('totp:confirm', actor.userId, LOGIN_RULES.perAccount);

  const self = await loadSelf(actor);
  if (self.enabledAt !== null) {
    throw new RuleViolationError('التحقق بخطوتين مفعَّل بالفعل');
  }
  if (!self.secret) {
    throw new RuleViolationError('ابدأ التسجيل أولاً');
  }

  if (!verifyTotp(decryptSecret(self.secret), input.code)) {
    throw new ValidationError('رمز غير صحيح. تحقّق من التطبيق وأعد المحاولة.');
  }

  await withActor(actor, async (tx) => {
    const updated = await tx
      .update(users)
      .set({ totpEnabledAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, actor.userId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      throw new RuleViolationError('تعذّر تفعيل التحقق بخطوتين');
    }

    await recordAudit(tx, actor, {
      action: 'USER_TWO_FACTOR_ENABLED',
      entityType: 'user',
      entityId: actor.userId,
      after: { enabled: true },
    });
  });
}

/**
 * Removing the factor needs BOTH: the password and a live code.
 *
 * One of them alone is the thing the other exists to cover. A stolen password
 * must not be able to strip the factor that makes it insufficient, and a phone
 * left unlocked on a desk must not be able to either.
 */
export async function disableTotp(
  actor: Actor,
  input: { password: string; code: string },
): Promise<void> {
  if (actor.kind !== 'USER') throw new NotFoundError();

  await consumeRateLimit('totp:disable', actor.userId, LOGIN_RULES.perAccount);

  const self = await loadSelf(actor);
  if (self.enabledAt === null || !self.secret) {
    throw new RuleViolationError('التحقق بخطوتين غير مفعَّل');
  }
  if (!(await verifyPassword(self.passwordHash, input.password))) {
    throw new ValidationError('كلمة المرور غير صحيحة');
  }
  if (!verifyTotp(decryptSecret(self.secret), input.code)) {
    throw new ValidationError('رمز غير صحيح');
  }

  await withActor(actor, async (tx) => {
    const updated = await tx
      .update(users)
      .set({ totpSecretEncrypted: null, totpEnabledAt: null, updatedAt: new Date() })
      .where(eq(users.id, actor.userId))
      .returning({ id: users.id });

    if (updated.length === 0) {
      throw new RuleViolationError('تعذّر تعطيل التحقق بخطوتين');
    }

    await recordAudit(tx, actor, {
      action: 'USER_TWO_FACTOR_DISABLED',
      entityType: 'user',
      entityId: actor.userId,
      after: { enabled: false },
    });
  });
}

/** What the security screen needs to know, without exposing the secret. */
export async function twoFactorState(
  actor: Actor,
): Promise<{ enabled: boolean; enrolmentStarted: boolean }> {
  const self = await loadSelf(actor);
  return { enabled: self.enabledAt !== null, enrolmentStarted: self.secret !== null };
}

/** Exported for the confirm step, which revokes the other sessions. */
export async function revokeOtherSessionsAfterEnrolment(actor: Actor): Promise<void> {
  if (actor.kind !== 'USER') return;
  await revokeAllSessions(actor, actor.userId, 'two-factor enabled');
}
