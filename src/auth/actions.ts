'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeReturnPath } from './return-path';
import { z } from 'zod';
import { attemptLogin } from './login';
import { registerCustomer, resendVerification } from './register';
import {
  SESSION_COOKIE_NAME, resolveActor, revokeAllSessions, sessionCookieOptions,
} from './session';
import { RateLimitedError } from '@/lib/rate-limit';
import { ValidationError } from '@/lib/errors';
import { MIN_PASSWORD_LENGTH } from './password';
import { serverEnv } from '@/lib/config/env';
import { logger } from '@/lib/logger';
import { waitLabelAr } from '@/lib/duration-ar';

/**
 * Authentication server actions.
 *
 * The cookie is set HERE and nowhere else, so there is one place where a
 * session becomes a browser credential. Failure messages are deliberately
 * uniform: the form must not reveal whether an email exists (§36).
 */

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  next: z.string().optional(),
});

export type LoginState = { error: string | null };

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });

  if (!parsed.success) {
    return { error: 'يرجى إدخال بريد إلكتروني وكلمة مرور صحيحين' };
  }

  const headerStore = await headers();
  const ip = headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  let outcome;
  try {
    outcome = await attemptLogin({
      email: parsed.data.email,
      password: parsed.data.password,
      ip,
      userAgent: headerStore.get('user-agent'),
    });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      /**
       * Say how long, not just "later".
       *
       * A refusal with no remedy in it reads as a broken site, and the person
       * most likely to see this message is the legitimate owner of the account
       * who mistyped a password a few times — not the attacker the limit is
       * for. The number costs nothing: an attacker already learns the window
       * by measuring it.
       */
      return { error: `محاولات كثيرة. أعد المحاولة بعد ${waitLabelAr(error.retryAfterSeconds)}.` };
    }
    logger.error({ err: error }, 'Login failed unexpectedly');
    return { error: 'تعذّر إتمام تسجيل الدخول' };
  }

  switch (outcome.status) {
    case 'INVALID_CREDENTIALS':
      // Same message whether the address is unknown or the password is wrong.
      return { error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' };
    case 'ACCOUNT_LOCKED':
      return { error: 'الحساب مقفل مؤقتاً بسبب محاولات متكررة. حاول لاحقاً.' };
    case 'ACCOUNT_DISABLED':
      return { error: 'هذا الحساب معطّل. تواصل مع إدارة المنصة.' };
    case 'EMAIL_NOT_VERIFIED':
      return {
        error:
          'لم يُؤكَّد بريدك بعد. افتح الرابط المُرسَل إليك، أو اطلب إرساله من جديد من صفحة إنشاء الحساب.',
      };
    case 'TWO_FACTOR_REQUIRED':
    case 'SUCCESS': {
      const cookieStore = await cookies();
      cookieStore.set(
        SESSION_COOKIE_NAME,
        outcome.session.rawToken,
        sessionCookieOptions(serverEnv().NODE_ENV === 'production'),
      );
      break;
    }
  }

  // Validated, never merely prefix-checked: `//evil.com` starts with a slash
  // and is a protocol-relative URL. See src/auth/return-path.ts.
  const destination = safeReturnPath(parsed.data.next);
  redirect(destination);
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (token) {
    const actor = await resolveActor(token);
    if (actor.kind === 'USER') {
      await revokeAllSessions(actor, actor.userId, 'تسجيل خروج');
    }
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect('/');
}

/**
 * ===========================================================================
 * REGISTRATION (owner decision on OPEN-23)
 * ===========================================================================
 * THE SUCCESS MESSAGE IS THE ONLY MESSAGE.
 *
 * Whether the address was new, already pending, or already a verified
 * customer, this returns the same "check your inbox". The outcome is known —
 * `registerCustomer` returns it — and is deliberately discarded here. A
 * different word in any of those cases would let anyone type an address into
 * a public form and learn whether that person has an account on this
 * platform, which is precisely what §36 forbids and what the login form is
 * already careful not to do.
 *
 * The only things that CAN change the answer are conditions the sender
 * controls and can fix: a malformed address, a short password, too many
 * attempts.
 * ===========================================================================
 */

const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .min(3)
    .max(254)
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'بريد إلكتروني غير صالح'),
  password: z.string().min(1).max(256),
  displayName: z.string().trim().min(2, 'الاسم قصير').max(80),
  /**
   * A field no human fills in, hidden from sight in the form.
   *
   * Not a CAPTCHA: it is the cheap half of bot prevention that costs a real
   * person nothing and stops the indiscriminate form-fillers, which are most
   * of what a small site sees. The rate limits behind it are what stop anyone
   * who bothers to look at the HTML.
   */
  company: z.string().max(0).optional(),
});

export type RegisterState = { error: string | null; done: boolean };

export async function registerAction(
  _previous: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const parsed = registerSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    displayName: formData.get('displayName'),
    company: formData.get('company') ?? undefined,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: first?.message ?? 'تعذّر قبول البيانات المُدخَلة', done: false };
  }

  // Filled in means a bot. Answered exactly like a success, so the bot learns
  // nothing and stops; a real person can never reach this branch.
  if (parsed.data.company) {
    return { error: null, done: true };
  }

  const headerStore = await headers();
  const ip = headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  try {
    await registerCustomer({
      email: parsed.data.email,
      password: parsed.data.password,
      displayName: parsed.data.displayName,
      ip,
      userAgent: headerStore.get('user-agent'),
    });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return {
        error: `محاولات كثيرة. أعد المحاولة بعد ${waitLabelAr(error.retryAfterSeconds)}.`,
        done: false,
      };
    }
    if (error instanceof ValidationError) {
      // The password policy speaks for itself; nothing here names the address.
      return { error: error.message, done: false };
    }
    logger.error({ err: error }, 'Registration failed unexpectedly');
    return {
      error: `تعذّر إتمام إنشاء الحساب. حاول مرة أخرى. (كلمة المرور ${MIN_PASSWORD_LENGTH} محرفاً على الأقل)`,
      done: false,
    };
  }

  return { error: null, done: true };
}

export type ResendState = { error: string | null; done: boolean };

/** Same silence as registration: a resend never confirms an address exists. */
export async function resendVerificationAction(
  _previous: ResendState,
  formData: FormData,
): Promise<ResendState> {
  const email = z.string().trim().min(3).max(254).safeParse(formData.get('email'));
  if (!email.success) return { error: 'بريد إلكتروني غير صالح', done: false };

  const headerStore = await headers();
  const ip = headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  try {
    await resendVerification({ email: email.data, ip });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return {
        error: `محاولات كثيرة. أعد المحاولة بعد ${waitLabelAr(error.retryAfterSeconds)}.`,
        done: false,
      };
    }
    logger.error({ err: error }, 'Resending a verification email failed');
    return { error: 'تعذّر الإرسال. حاول مرة أخرى.', done: false };
  }

  return { error: null, done: true };
}
