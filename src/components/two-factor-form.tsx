'use client';

import { useActionState } from 'react';
import { verifyTwoFactorAction, type TwoFactorState } from '@/auth/actions';

const INITIAL: TwoFactorState = { error: null };

/**
 * The second step of signing in.
 *
 * The form carries the code and nothing else — no user id, no session id. Which
 * account is being completed is decided on the server from the cookie, so this
 * component cannot be pointed at somebody else's account by editing the page.
 */
export function TwoFactorForm({ next }: { next: string | null }) {
  const [state, formAction, pending] = useActionState(verifyTwoFactorAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="code" className="text-sm font-medium">
          رمز التحقق
        </label>
        <input
          id="code"
          name="code"
          type="text"
          required
          autoFocus
          // `one-time-code` lets a phone offer the code from its keyboard, and
          // `numeric` gives a digit pad instead of a full keyboard.
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={7}
          dir="ltr"
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 text-center text-lg tracking-[0.3em] outline-none focus:border-[var(--color-accent)]"
        />
        <p className="text-xs text-[var(--color-ink-faint)]">
          ستة أرقام من تطبيق المصادقة على هاتفك.
        </p>
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
        className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2.5 font-semibold text-[var(--color-accent-contrast)] disabled:opacity-60"
      >
        {pending ? 'جارٍ التحقق…' : 'تأكيد'}
      </button>
    </form>
  );
}
