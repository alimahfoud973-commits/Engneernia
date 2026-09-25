'use client';

import { useActionState } from 'react';
import { updateWhatsappAction, type SettingsState } from '@/platform/settings-actions';

const INITIAL: SettingsState = { error: null };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const BUTTON =
  'rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold '
  + 'text-[var(--color-accent-contrast)] transition-opacity disabled:opacity-60';

/** Set or clear the WhatsApp number buyers are sent to (§23, W2). */
export function WhatsappNumberForm({ defaultValue }: { defaultValue: string }) {
  const [state, formAction, pending] = useActionState(updateWhatsappAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">رقم واتساب</span>
        <input
          name="whatsapp"
          type="tel"
          inputMode="tel"
          dir="ltr"
          maxLength={40}
          defaultValue={defaultValue}
          className={`${FIELD} technical-term max-w-xs`}
        />
        <span className="text-xs text-[var(--color-ink-faint)]">
          بالصيغة الدولية مع رمز الدولة، مثل{' '}
          <bdi dir="ltr" className="technical-term">+963 933 123 456</bdi>. اتركه فارغاً لإخفاء المساعدة
          عبر واتساب.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className={BUTTON} disabled={pending}>
          {pending ? 'جارٍ الحفظ…' : 'حفظ الرقم'}
        </button>
        {state.error ? <p className="text-sm text-[var(--color-danger)]">{state.error}</p> : null}
        {state.ok ? <p className="text-sm text-[var(--color-ink-soft)]">حُفظ.</p> : null}
      </div>
    </form>
  );
}
