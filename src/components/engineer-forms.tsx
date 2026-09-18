'use client';

import { useActionState } from 'react';
import {
  addEngineerAction, setEngineerActiveAction, updateEngineerAction,
  type EngineerState,
} from '@/contributors/engineer-actions';

const INITIAL: EngineerState = { error: null };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const BUTTON =
  'rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold '
  + 'text-[var(--color-accent-contrast)] transition-opacity disabled:opacity-60';

export interface DisciplineOption {
  readonly id: string;
  readonly nameAr: string;
}

function Message({ state, done }: { state: EngineerState; done: string }) {
  if (state.error) {
    return <p className="text-sm text-[var(--color-danger)]">{state.error}</p>;
  }
  if (state.ok) {
    return <p className="text-sm text-[var(--color-ink-soft)]">{done}</p>;
  }
  return null;
}

function DisciplineSelect({
  disciplines,
  defaultValue,
}: {
  disciplines: readonly DisciplineOption[];
  defaultValue?: string | null;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--color-ink-faint)]">التخصص</span>
      <select name="disciplineId" className={FIELD} defaultValue={defaultValue ?? ''}>
        <option value="">غير محدّد</option>
        {disciplines.map((discipline) => (
          <option key={discipline.id} value={discipline.id}>
            {discipline.nameAr}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Add an engineer (§32, §46).
 *
 * It asks for an EMAIL, not a password: the engineer registers themselves and
 * the owner authorises the profile afterwards. If no account carries that
 * address the server refuses and says so, rather than inventing one.
 */
export function AddEngineerForm({ disciplines }: { disciplines: readonly DisciplineOption[] }) {
  const [state, formAction, pending] = useActionState(addEngineerAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">
            بريد حساب مسجَّل على المنصة
          </span>
          <input name="email" type="email" required className={FIELD} dir="ltr" />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">الاسم المعروض</span>
          <input name="displayName" required minLength={2} maxLength={120} className={FIELD} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">
            العنوان اللطيف (‎/contributors/…)
          </span>
          <input
            name="publicSlug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            className={FIELD}
            dir="ltr"
            placeholder="ahmad-civil"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">رمز التسوية</span>
          <input
            name="settlementCode"
            required
            pattern="[A-Z0-9][A-Z0-9\-]{1,23}"
            className={FIELD}
            dir="ltr"
            placeholder="CIVIL-01"
          />
        </label>

        <DisciplineSelect disciplines={disciplines} />

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">
            التخصص الدقيق (اختياري)
          </span>
          <input name="specialization" maxLength={120} className={FIELD} />
        </label>
      </div>

      <p className="text-xs text-[var(--color-ink-faint)]">
        يُنشأ الملف <strong>غير مفعَّل</strong>. التفعيل قرار منفصل يُسجَّل في سجل
        التدقيق.
      </p>

      <div className="flex items-center gap-3">
        <button type="submit" className={BUTTON} disabled={pending}>
          {pending ? 'جارٍ الإضافة…' : 'إضافة المهندس'}
        </button>
        <Message state={state} done="أُضيف المهندس. فعِّل ملفه حين يكون جاهزاً." />
      </div>
    </form>
  );
}

/** Edit the profile. The slug and the settlement code are not editable — see
 *  `updateEngineer` for why a code printed on issued statements is fixed. */
export function EditEngineerForm({
  contributorId,
  displayName,
  disciplineId,
  specialization,
  bio,
  disciplines,
}: {
  contributorId: string;
  displayName: string;
  disciplineId: string | null;
  specialization: string | null;
  bio: string | null;
  disciplines: readonly DisciplineOption[];
}) {
  const [state, formAction, pending] = useActionState(updateEngineerAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="contributorId" value={contributorId} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">الاسم المعروض</span>
          <input
            name="displayName"
            required
            minLength={2}
            maxLength={120}
            defaultValue={displayName}
            className={FIELD}
          />
        </label>

        <DisciplineSelect disciplines={disciplines} defaultValue={disciplineId} />

        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">التخصص الدقيق</span>
          <input
            name="specialization"
            maxLength={120}
            defaultValue={specialization ?? ''}
            className={FIELD}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">نبذة</span>
        <textarea name="bio" maxLength={1000} rows={3} defaultValue={bio ?? ''} className={FIELD} />
      </label>

      <div className="flex items-center gap-3">
        <button type="submit" className={BUTTON} disabled={pending}>
          {pending ? 'جارٍ الحفظ…' : 'حفظ التعديلات'}
        </button>
        <Message state={state} done="حُفظت التعديلات." />
      </div>
    </form>
  );
}

/**
 * Activate or deactivate.
 *
 * The desired state is a hidden field, not a toggle read from the screen: two
 * clicks on a page the owner left open must not turn an engineer back on.
 * Deactivating touches no sale, no entitlement and no unpaid balance — the
 * engineer is still owed what they earned.
 */
export function EngineerActiveForm({
  contributorId,
  isActive,
}: {
  contributorId: string;
  isActive: boolean;
}) {
  const [state, formAction, pending] = useActionState(setEngineerActiveAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="contributorId" value={contributorId} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-3 py-1.5 text-sm font-semibold transition-colors hover:border-[var(--color-accent)] disabled:opacity-60"
      >
        {isActive ? 'إيقاف التفعيل' : 'تفعيل المهندس'}
      </button>
      <Message state={state} done="حُدِّثت الحالة." />
    </form>
  );
}
