'use client';

import { useActionState } from 'react';
import { markReadAction, type ActionState } from '@/notifications/actions';

const INITIAL: ActionState = { error: null };

export function MarkAllReadButton({ count }: { count: number }) {
  const [state, formAction, pending] = useActionState(markReadAction, INITIAL);

  if (count === 0) return null;

  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-3 py-1.5 text-xs font-semibold transition-colors hover:border-[var(--color-accent)] disabled:opacity-60"
      >
        {pending ? '…' : `تعليم الكل مقروءاً (${count})`}
      </button>
      {state.error ? (
        <p role="alert" className="mt-1 text-xs text-[var(--color-danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function MarkOneReadButton({ notificationId }: { notificationId: string }) {
  const [, formAction, pending] = useActionState(markReadAction, INITIAL);
  return (
    <form action={formAction}>
      <input type="hidden" name="notificationId" value={notificationId} />
      <button
        type="submit"
        disabled={pending}
        aria-label="تعليم كمقروء"
        className="text-xs text-[var(--color-ink-faint)] underline underline-offset-4 hover:text-[var(--color-ink)] disabled:opacity-60"
      >
        {pending ? '…' : 'تعليم كمقروء'}
      </button>
    </form>
  );
}
