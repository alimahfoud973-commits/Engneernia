'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeReturnPath } from './return-path';
import { z } from 'zod';
import { attemptMemberLogin, attemptOwnerLogin, type LoginOutcome } from './login';
import { registerCustomer } from './register';
import { resolveActor, revokeAllSessions, sessionCookie } from './session';
import { RateLimitedError } from '@/lib/rate-limit';
import { ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { waitLabelAr } from '@/lib/duration-ar';
import { submittedValues, type SubmittedValues } from '@/lib/form-values';

/**
 * Authentication server actions (Stage 6).
 *
 * The cookie is set HERE and nowhere else, so there is one place where a
 * session becomes a browser credential. Nothing typed into these forms — no
 * phone, email, username or password — is ever written to a log line: the
 * logger receives the error object only.
 */

function clientIp(headerStore: Headers): string | null {
  return headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

function tooMany(error: RateLimitedError): string {
  /**
   * Say how long, not just "later". The person most likely to see this is
   * someone who mistyped a few times, and a refusal with no remedy reads as a
   * broken site. An attacker learns the window by measuring it anyway.
   */
  return `محاولات كثيرة. أعد المحاولة بعد ${waitLabelAr(error.retryAfterSeconds)}.`;
}

async function setSessionCookie(rawToken: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(sessionCookie().name, rawToken, sessionCookie().options);
}

/**
 * `values` hands back what was typed with a refusal, so React's form reset
 * restores it (see src/lib/form-values.ts) — never the password.
 */
export type LoginState = { error: string | null; values?: SubmittedValues };

function typedWithout(formData: FormData, ...secret: string[]): SubmittedValues {
  const values = { ...submittedValues(formData) };
  for (const name of secret) delete values[name];
  return values;
}

/* ---------------------------------------------------------------------------
 * Subscribers and engineers: phone + email.
 * ------------------------------------------------------------------------- */

const memberLoginSchema = z.object({
  phone: z.string().trim().min(3).max(40),
  email: z.string().trim().min(3).max(254),
  next: z.string().optional(),
});

export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const typed = typedWithout(formData);
  const parsed = memberLoginSchema.safeParse({
    phone: formData.get('phone'),
    email: formData.get('email'),
    next: formData.get('next') ?? undefined,
  });
  if (!parsed.success) {
    return { error: 'يرجى إدخال رقم الهاتف والبريد الإلكتروني', values: typed };
  }

  const headerStore = await headers();
  let outcome: LoginOutcome;
  try {
    outcome = await attemptMemberLogin({
      phone: parsed.data.phone,
      email: parsed.data.email,
      ip: clientIp(headerStore),
      userAgent: headerStore.get('user-agent'),
    });
  } catch (error) {
    if (error instanceof RateLimitedError) return { error: tooMany(error), values: typed };
    logger.error({ err: error }, 'Member login failed unexpectedly');
    return { error: 'تعذّر إتمام تسجيل الدخول', values: typed };
  }

  switch (outcome.status) {
    case 'INVALID_CREDENTIALS':
    case 'ACCOUNT_LOCKED':
      // One sentence for an unknown phone and for a phone with another email.
      return { error: 'رقم الهاتف أو البريد الإلكتروني غير صحيح', values: typed };
    case 'ACCOUNT_DISABLED':
      return { error: 'هذا الحساب معطّل. تواصل مع إدارة المنصة.', values: typed };
    case 'SUCCESS':
      await setSessionCookie(outcome.session.rawToken);
      break;
  }

  // Validated, never merely prefix-checked: `//evil.com` starts with a slash.
  redirect(safeReturnPath(parsed.data.next));
}

/* ---------------------------------------------------------------------------
 * The owner: username + password. No second factor (owner decision).
 * ------------------------------------------------------------------------- */

const ownerLoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  next: z.string().optional(),
});

export async function ownerLoginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const typed = typedWithout(formData, 'password');
  const parsed = ownerLoginSchema.safeParse({
    username: formData.get('username'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });
  if (!parsed.success) {
    return { error: 'يرجى إدخال اسم المستخدم وكلمة المرور', values: typed };
  }

  const headerStore = await headers();
  let outcome: LoginOutcome;
  try {
    outcome = await attemptOwnerLogin({
      username: parsed.data.username,
      password: parsed.data.password,
      ip: clientIp(headerStore),
      userAgent: headerStore.get('user-agent'),
    });
  } catch (error) {
    if (error instanceof RateLimitedError) return { error: tooMany(error), values: typed };
    logger.error({ err: error }, 'Owner login failed unexpectedly');
    return { error: 'تعذّر إتمام تسجيل الدخول', values: typed };
  }

  switch (outcome.status) {
    case 'INVALID_CREDENTIALS':
      return { error: 'اسم المستخدم أو كلمة المرور غير صحيحة', values: typed };
    case 'ACCOUNT_LOCKED':
      return { error: 'الحساب مقفل مؤقتاً بسبب محاولات متكررة. حاول لاحقاً.', values: typed };
    case 'ACCOUNT_DISABLED':
      return { error: 'هذا الحساب معطّل.', values: typed };
    case 'SUCCESS':
      await setSessionCookie(outcome.session.rawToken);
      break;
  }

  redirect(safeReturnPath(parsed.data.next, '/admin'));
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookie().name)?.value;

  if (token) {
    const actor = await resolveActor(token);
    if (actor.kind === 'USER') {
      await revokeAllSessions(actor, actor.userId, 'تسجيل خروج');
    }
  }

  cookieStore.delete(sessionCookie().name);
  redirect('/');
}

/* ---------------------------------------------------------------------------
 * Registration: name + phone + email → ACTIVE CUSTOMER, signed in.
 * ------------------------------------------------------------------------- */

const registerSchema = z.object({
  displayName: z.string().trim().min(2, 'الاسم قصير').max(80, 'الاسم طويل'),
  phone: z.string().trim().min(3, 'أدخل رقم الهاتف').max(40, 'رقم الهاتف طويل'),
  email: z
    .string()
    .trim()
    .min(3, 'أدخل البريد الإلكتروني')
    .max(254)
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'بريد إلكتروني غير صالح'),
  /**
   * A field no human fills in, hidden from sight in the form. Not a CAPTCHA:
   * the cheap half of bot prevention that costs a real person nothing. The
   * rate limits behind it stop anyone who bothers to read the HTML.
   */
  company: z.string().max(0).optional(),
  next: z.string().optional(),
});

export type RegisterState = { error: string | null; values?: SubmittedValues };

export async function registerAction(
  _previous: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const typed = typedWithout(formData);
  const parsed = registerSchema.safeParse({
    displayName: formData.get('displayName'),
    phone: formData.get('phone'),
    email: formData.get('email'),
    company: formData.get('company') ?? undefined,
    next: formData.get('next') ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'تعذّر قبول البيانات المُدخَلة', values: typed };
  }

  // Filled in means a bot: no account, no session, and nothing to learn.
  if (parsed.data.company) {
    redirect('/');
  }

  const headerStore = await headers();
  let rawToken: string;
  try {
    const result = await registerCustomer({
      displayName: parsed.data.displayName,
      phone: parsed.data.phone,
      email: parsed.data.email,
      ip: clientIp(headerStore),
      userAgent: headerStore.get('user-agent'),
    });
    if (result.outcome === 'ALREADY_EXISTS') {
      // Neither which field was taken, nor anything about the account.
      return { error: 'رقم الهاتف أو البريد الإلكتروني مسجّل لحساب قائم. سجّل الدخول بهما.', values: typed };
    }
    rawToken = result.session.rawToken;
  } catch (error) {
    if (error instanceof RateLimitedError) return { error: tooMany(error), values: typed };
    if (error instanceof ValidationError) return { error: error.message, values: typed };
    logger.error({ err: error }, 'Registration failed unexpectedly');
    return {
      error: 'تعذّر إتمام إنشاء الحساب لخلل مؤقت من جانبنا، لا في بياناتك. أعد المحاولة بعد قليل.',
      values: typed,
    };
  }

  await setSessionCookie(rawToken);
  redirect(safeReturnPath(parsed.data.next));
}
