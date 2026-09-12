'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from '@/auth/actions';

const INITIAL: LoginState = { error: null };

/**
 * The one client component in the sign-in path.
 *
 * The credentials never touch client state: the form posts straight to a
 * server action, so the password exists only in the request body.
 */
export function LoginForm({ next }: { next: string | null }) {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

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
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 text-start outline-none focus:border-[var(--color-accent)]"
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
          autoComplete="current-password"
          dir="ltr"
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 text-start outline-none focus:border-[var(--color-accent)]"
        />
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
        {pending ? 'جارٍ الدخول…' : 'دخول'}
      </button>
    </form>
  );
}
