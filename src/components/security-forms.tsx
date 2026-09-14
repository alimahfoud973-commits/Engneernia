'use client';

import { useActionState } from 'react';
import {
  beginTotpAction, confirmTotpAction, disableTotpAction,
  type EnrolState, type TotpActionState,
} from '@/auth/actions';

const ENROL_INITIAL: EnrolState = { error: null, offer: null };
const ACTION_INITIAL: TotpActionState = { error: null };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 text-start outline-none focus:border-[var(--color-accent)]';
const BUTTON =
  'rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2.5 font-semibold text-[var(--color-accent-contrast)] disabled:opacity-60';

function Problem({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2.5 text-sm text-[var(--color-danger)]"
    >
      {message}
    </p>
  );
}

/**
 * Enrolment, in two steps on one screen.
 *
 * The secret is rendered only in the response that created it and is never
 * fetched again — asking for it a second time means starting over, which also
 * retires the first one.
 */
export function EnrolTwoFactor() {
  const [begun, beginAction, beginning] = useActionState(beginTotpAction, ENROL_INITIAL);
  const [confirmed, confirmAction, confirming] = useActionState(confirmTotpAction, ACTION_INITIAL);

  if (!begun.offer) {
    return (
      <form action={beginAction} className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-ink-soft)]">
          أدخل كلمة مرورك لبدء التسجيل. كلمة المرور مطلوبة هنا لأن جلسة مسروقة
          يجب ألّا تستطيع إضافة عامل ثانٍ ولا إزالته.
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium">كلمة المرور</label>
          <input id="password" name="password" type="password" required autoComplete="current-password" className={FIELD} />
        </div>
        <Problem message={begun.error} />
        <button type="submit" disabled={beginning} className={BUTTON}>
          {beginning ? 'جارٍ…' : 'ابدأ التسجيل'}
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-muted)] p-4">
        <p className="text-sm font-medium">١. أضف الحساب إلى تطبيق المصادقة</p>
        <p className="text-xs text-[var(--color-ink-soft)]">
          أدخل هذا المفتاح يدوياً في التطبيق (Google Authenticator، Aegis، 1Password
          أو غيرها). يظهر مرة واحدة فقط — إن أغلقت الصفحة فابدأ من جديد.
        </p>
        {/*
          `break-words`, not `break-all`: this is a key somebody types into a
          phone by hand, and breaking it mid-group — "JD IL" across two lines —
          is an invitation to mistype it. Wrapping at the spaces keeps every
          group whole.
        */}
        <code dir="ltr" className="select-all break-words rounded-[var(--radius-card)] bg-[var(--color-surface)] px-3 py-2 text-center text-sm tracking-widest">
          {begun.offer.readable}
        </code>
        <details className="text-xs text-[var(--color-ink-faint)]">
          <summary className="cursor-pointer">أو انسخ رابط الإعداد الكامل</summary>
          <code dir="ltr" className="mt-2 block select-all break-all text-[11px]">
            {begun.offer.uri}
          </code>
        </details>
      </div>

      <form action={confirmAction} className="flex flex-col gap-4">
        <p className="text-sm font-medium">٢. أدخل الرمز الذي يعرضه التطبيق</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="code" className="text-sm font-medium">رمز التحقق</label>
          <input
            id="code" name="code" type="text" required autoFocus
            autoComplete="one-time-code" inputMode="numeric" maxLength={7} dir="ltr"
            className={`${FIELD} text-center text-lg tracking-[0.3em]`}
          />
          <p className="text-xs text-[var(--color-ink-faint)]">
            لن يُفعَّل شيء حتى يُقبل هذا الرمز. وعند التفعيل تُنهى كل جلساتك الأخرى.
          </p>
        </div>
        <Problem message={confirmed.error} />
        <button type="submit" disabled={confirming} className={BUTTON}>
          {confirming ? 'جارٍ التفعيل…' : 'فعِّل التحقق بخطوتين'}
        </button>
      </form>
    </div>
  );
}

/** Removing the factor needs both the password and a live code. */
export function DisableTwoFactor() {
  const [state, formAction, pending] = useActionState(disableTotpAction, ACTION_INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-ink-soft)]">
        التعطيل يحتاج كلمة المرور <strong>ورمزاً حالياً</strong> معاً: كلٌّ منهما
        موجود ليغطّي ضياع الآخر.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="disable-password" className="text-sm font-medium">كلمة المرور</label>
        <input id="disable-password" name="password" type="password" required autoComplete="current-password" className={FIELD} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="disable-code" className="text-sm font-medium">رمز التحقق</label>
        <input
          id="disable-code" name="code" type="text" required
          autoComplete="one-time-code" inputMode="numeric" maxLength={7} dir="ltr"
          className={`${FIELD} text-center tracking-[0.3em]`}
        />
      </div>
      <Problem message={state.error} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] border border-[var(--color-danger)] px-4 py-2.5 font-semibold text-[var(--color-danger)] disabled:opacity-60"
      >
        {pending ? 'جارٍ…' : 'عطِّل التحقق بخطوتين'}
      </button>
    </form>
  );
}
