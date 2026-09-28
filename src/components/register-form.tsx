'use client';

import { useActionState } from 'react';
import { registerAction, type RegisterState } from '@/auth/actions';

const INITIAL: RegisterState = { error: null };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]'
  + ' px-3 py-2.5 text-start outline-none focus:border-[var(--color-accent)]';

/**
 * The sign-up form (Stage 6): a name, a phone and an email. On success the
 * server action signs the subscriber in and moves on, so there is no
 * "done" state to render here.
 */
export function RegisterForm({ next }: { next: string | null }) {
  const [state, formAction, pending] = useActionState(registerAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

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
          defaultValue={state.values?.displayName ?? ''}
          className={FIELD}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="phone" className="text-sm font-medium">
          رقم الهاتف
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          inputMode="tel"
          dir="ltr"
          placeholder="+963…"
          defaultValue={state.values?.phone ?? ''}
          className={FIELD}
        />
        <p className="text-xs text-[var(--color-ink-soft)]">
          بالصيغة الدولية مع رمز الدولة، مثل +963 أو 00963.
        </p>
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
          defaultValue={state.values?.email ?? ''}
          className={FIELD}
        />
        <p className="text-xs text-[var(--color-ink-soft)]">
          تدخل لاحقاً برقم الهاتف والبريد معاً.
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
