'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeReturnPath } from './return-path';
import { z } from 'zod';
import { attemptLogin } from './login';
import {
  SESSION_COOKIE_NAME, resolveActor, revokeAllSessions, sessionCookieOptions,
} from './session';
import { RateLimitedError } from '@/lib/rate-limit';
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
