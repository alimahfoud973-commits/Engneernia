'use client';

import { useActionState } from 'react';
import { loginAction, ownerLoginAction, type LoginState } from '@/auth/actions';

const INITIAL: LoginState = { error: null };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]'
  + ' px-3 py-2.5 text-start outline-none focus:border-[var(--color-accent)]';

const SUBMIT =
  'rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold'
  + ' text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60';

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2.5 text-sm text-[var(--color-danger)]"
    >
      {message}
    </p>
  ) : null;
}

/**
 * Subscribers and engineers: phone + email (Stage 6). Both post straight to a
 * server action; nothing typed here is held in client state.
 */
export function LoginForm({ next }: { next: string | null }) {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

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
      </div>

      <ErrorLine message={state.error} />

      <button type="submit" disabled={pending} className={SUBMIT}>
        {pending ? 'جارٍ الدخول…' : 'دخول'}
      </button>
    </form>
  );
}

/** The owner: username + password. */
export function OwnerLoginForm({ next }: { next: string | null }) {
  const [state, formAction, pending] = useActionState(ownerLoginAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="username" className="text-sm font-medium">
          اسم المستخدم
        </label>
        <input
          id="username"
          name="username"
          type="text"
          required
          autoComplete="username"
          autoCapitalize="none"
          dir="ltr"
          defaultValue={state.values?.username ?? ''}
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
          autoComplete="current-password"
          dir="ltr"
          className={FIELD}
        />
      </div>

      <ErrorLine message={state.error} />

      <button type="submit" disabled={pending} className={SUBMIT}>
        {pending ? 'جارٍ الدخول…' : 'دخول'}
      </button>
    </form>
  );
}
