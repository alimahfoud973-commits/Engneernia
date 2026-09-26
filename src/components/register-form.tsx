'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { registerAction, type RegisterState } from '@/auth/actions';
import { MIN_PASSWORD_LENGTH } from '@/auth/password-policy';

const INITIAL: RegisterState = { error: null, done: false };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]'
  + ' px-3 py-2.5 text-start outline-none focus:border-[var(--color-accent)]';

/**
 * The sign-up form.
 *
 * Like the sign-in form, the password never enters client state: the form
 * posts straight to a server action. The confirmation it shows is the same
 * sentence whatever happened on the server — see the note on `registerAction`.
 */
export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerAction, INITIAL);

  if (state.done) {
    return <SignInNow />;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="displayName" className="text-sm font-medium">
          الاسم
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          required
          minLength={2}
          maxLength={80}
          autoComplete="name"
          className={FIELD}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          البريد الإلكتروني
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          dir="ltr"
          className={FIELD}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          كلمة المرور
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          dir="ltr"
          className={FIELD}
        />
        <p className="text-xs text-[var(--color-ink-soft)]">
          {MIN_PASSWORD_LENGTH} محرفاً على الأقل. العبارة الطويلة أقوى من الرموز المعقّدة.
        </p>
      </div>

      {/*
        Hidden from people, visible to form-filling bots. `aria-hidden` and
        `tabIndex={-1}` keep it away from screen readers and the tab order, so
        it is invisible to assistive technology rather than merely invisible.

        `sr-only`, NOT `left-[-9999px]`.

        The off-screen idiom is written for a left-to-right page, where content
        pushed past the left edge is unreachable and the browser discards it.
        This document is right-to-left, so leftward IS the scrolling direction:
        the same rule made the register page 10,389 pixels wide on a phone,
        scrollable sideways into ten thousand pixels of nothing. Every other
        page measured exactly one viewport.

        `sr-only` clips the field where it already sits, so it takes part in no
        overflow at all. Guarded by scripts/layout-check.mjs, because no unit
        test can see this — it is a property of a laid-out page in a browser.
      */}
      <div aria-hidden className="sr-only">
        <label htmlFor="company">لا تملأ هذا الحقل</label>
        <input id="company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {state.error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2.5 text-sm text-[var(--color-danger)]"
        >
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? 'جارٍ الإنشاء…' : 'إنشاء الحساب'}
      </button>
    </form>
  );
}

/**
 * Shown after every accepted submission, identical whether the account was
 * just created or the address already had one. There is no email step: the
 * account is ACTIVE, so the next thing to do is sign in.
 */
function SignInNow() {
  return (
    <div className="flex flex-col gap-5">
      <div
        role="status"
        className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-4"
      >
        <p className="text-sm font-semibold">تمّ</p>
        <p className="mt-1.5 text-sm text-[var(--color-ink-soft)]">
          إن لم يكن هذا البريد مسجّلاً من قبل فقد أُنشئ حسابك. سجّل الدخول الآن ببريدك وكلمة المرور.
        </p>
      </div>
      <Link
        href="/login"
        className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-center text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90"
      >
        تسجيل الدخول
      </Link>
    </div>
  );
}
