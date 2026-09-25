'use client';

import { useActionState, useState } from 'react';
import {
  createPaymentMethodAction, setPaymentMethodActiveAction, updatePaymentMethodAction,
  type PaymentMethodState,
} from '@/payments/admin-actions';

const INITIAL: PaymentMethodState = { error: null };

const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const BUTTON =
  'rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold '
  + 'text-[var(--color-accent-contrast)] transition-opacity disabled:opacity-60';

export interface PaymentMethodFormValues {
  readonly id: string;
  readonly type: 'MANUAL' | 'ASSISTED' | 'GATEWAY';
  readonly displayNameAr: string;
  readonly displayNameEn: string | null;
  readonly descriptionAr: string | null;
  readonly instructionsAr: string | null;
  readonly accountDetailsAr: string | null;
  readonly supportMessageAr: string | null;
  readonly requiresProof: boolean;
  readonly countries: readonly string[];
  readonly currencies: readonly string[];
  readonly sortOrder: number;
}

function Message({ state, done }: { state: PaymentMethodState; done: string }) {
  if (state.error) return <p className="text-sm text-[var(--color-danger)]">{state.error}</p>;
  if (state.ok) return <p className="text-sm text-[var(--color-ink-soft)]">{done}</p>;
  return null;
}

function Text({
  name, label, defaultValue, hint, rows, required,
}: {
  name: string;
  label: string;
  defaultValue?: string | null | undefined;
  hint?: string | undefined;
  rows?: number | undefined;
  required?: boolean | undefined;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--color-ink-faint)]">{label}</span>
      {rows ? (
        <textarea name={name} rows={rows} defaultValue={defaultValue ?? ''} className={FIELD} />
      ) : (
        <input name={name} defaultValue={defaultValue ?? ''} required={required} className={FIELD} />
      )}
      {hint ? <span className="text-xs text-[var(--color-ink-faint)]">{hint}</span> : null}
    </label>
  );
}

/** The fields every method has; which of the type-specific ones show depends on its type. */
function Fields({ type, values }: { type: string; values?: PaymentMethodFormValues }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Text name="displayNameAr" label="الاسم الظاهر للمشتري" defaultValue={values?.displayNameAr} required />
        <Text name="displayNameEn" label="الاسم بالإنجليزية (اختياري)" defaultValue={values?.displayNameEn} />
      </div>
      <Text name="descriptionAr" label="الوصف" defaultValue={values?.descriptionAr} rows={2} />
      <Text
        name="instructionsAr"
        label="تعليمات الدفع"
        defaultValue={values?.instructionsAr}
        rows={3}
        hint={type === 'MANUAL' ? 'مطلوبة: بدونها لا تظهر الطريقة للمشترين.' : undefined}
      />
      {type === 'MANUAL' ? (
        <Text
          name="accountDetailsAr"
          label="بيانات الحساب (رقم الحساب، IBAN، رقم المحفظة…)"
          defaultValue={values?.accountDetailsAr}
          rows={2}
          hint="مطلوبة: بدونها لا تظهر الطريقة للمشترين. تُحفظ مع كل طلب لحظة إنشائه، فتعديلها لاحقاً لا يغيّر الطلبات السابقة."
        />
      ) : (
        // Not this type's field — carried unchanged, so a save does not clear it.
        <input type="hidden" name="accountDetailsAr" value={values?.accountDetailsAr ?? ''} />
      )}
      {type === 'ASSISTED' ? (
        <Text
          name="supportMessageAr"
          label="نص رسالة الدعم"
          defaultValue={values?.supportMessageAr}
          rows={3}
          hint="يمكن استخدام {{items}} و{{order}} و{{amount}} و{{currency}}."
        />
      ) : (
        <input type="hidden" name="supportMessageAr" value={values?.supportMessageAr ?? ''} />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Text
          name="countries"
          label="الدول"
          defaultValue={values?.countries.join(', ')}
          hint="رموز من حرفين مثل SY, SA — فارغ = كل الدول."
        />
        <Text
          name="currencies"
          label="العملات"
          defaultValue={values?.currencies.join(', ')}
          hint="رموز من ثلاثة أحرف مثل USD — فارغ = كل العملات."
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">الترتيب</span>
          <input
            name="sortOrder"
            type="number"
            min={0}
            max={9999}
            required
            defaultValue={values?.sortOrder ?? 10}
            className={FIELD}
          />
          <span className="text-xs text-[var(--color-ink-faint)]">الأصغر يظهر أولاً.</span>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="requiresProof" defaultChecked={values?.requiresProof ?? true} />
        يطلب من المشتري رفع إيصال الدفع
      </label>
    </>
  );
}

/** Add a method (§21). Its code and type cannot be changed afterwards. */
export function CreatePaymentMethodForm() {
  const [state, formAction, pending] = useActionState(createPaymentMethodAction, INITIAL);
  const [type, setType] = useState<string>('MANUAL');

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">الرمز (ثابت بعد الإنشاء)</span>
          <input name="code" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={50} className={FIELD} dir="ltr" />
          <span className="text-xs text-[var(--color-ink-faint)]">حروف لاتينية صغيرة وأرقام وشرطات، مثل local-wallet.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">النوع (ثابت بعد الإنشاء)</span>
          <select name="type" className={FIELD} value={type} onChange={(event) => setType(event.target.value)}>
            <option value="MANUAL">تحويل يدوي (بنك، محفظة) مع إيصال</option>
            <option value="ASSISTED">مساعدة عبر واتساب</option>
          </select>
        </label>
      </div>
      <Fields type={type} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" />
        مفعّلة فور الإنشاء
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className={BUTTON} disabled={pending}>
          {pending ? 'جارٍ الحفظ…' : 'إضافة طريقة الدفع'}
        </button>
        <Message state={state} done="أُضيفت طريقة الدفع." />
      </div>
    </form>
  );
}

export function EditPaymentMethodForm({ values }: { values: PaymentMethodFormValues }) {
  const [state, formAction, pending] = useActionState(updatePaymentMethodAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="methodId" value={values.id} />
      <Fields type={values.type} values={values} />
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
 * Enable or disable. The desired state is a hidden field, so a second click on
 * a stale page does not switch the method back. Disabling is also how a method
 * is retired: orders already placed keep what they were told.
 */
export function PaymentMethodActiveForm({ methodId, isActive }: { methodId: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(setPaymentMethodActiveAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="methodId" value={methodId} />
      <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-card)] border border-[var(--color-line-strong)] px-3 py-1.5 text-sm font-semibold transition-colors hover:border-[var(--color-accent)] disabled:opacity-60"
      >
        {isActive ? 'تعطيل الطريقة' : 'تفعيل الطريقة'}
      </button>
      <Message state={state} done="حُدِّثت الحالة." />
    </form>
  );
}
