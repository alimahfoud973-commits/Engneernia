'use client';

import { useActionState, useState } from 'react';
import {
  changePriceAction, changeStatusAction, createProductAction, setCreditsAction,
  updateProductAction, uploadProductFileAction, type ProductActionState,
} from '@/catalog/product-actions';

const INITIAL: ProductActionState = { error: null };
const FIELD =
  'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const BTN =
  'rounded-[var(--radius-card)] bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-60';

function Note({ state }: { state: ProductActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
        {state.error}
      </p>
    );
  }
  if (state.ok) return <p className="text-sm text-[var(--color-ok)]">تم الحفظ.</p>;
  return null;
}

const FILE_TYPES = [
  ['PDF', 'PDF'], ['EXCEL', 'Excel'], ['CAD', 'CAD'], ['REVIT_BIM', 'Revit / BIM'],
  ['ARCHIVE', 'أرشيف مضغوط'], ['TEMPLATE', 'قالب'], ['PROJECT', 'مشروع'], ['OTHER', 'أخرى'],
] as const;
const LEVELS = [['', '—'], ['BEGINNER', 'مبتدئ'], ['INTERMEDIATE', 'متوسط'], ['ADVANCED', 'متقدم']] as const;

export function CreateProductForm({
  disciplines, categories, currency,
}: {
  disciplines: ReadonlyArray<{ id: string; nameAr: string }>;
  categories: ReadonlyArray<{ id: string; nameAr: string; disciplineId: string }>;
  currency: string;
}) {
  const [state, action, pending] = useActionState(createProductAction, INITIAL);
  const [discipline, setDiscipline] = useState('');
  const scoped = categories.filter((c) => c.disciplineId === discipline);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">عنوان المنتج</span>
          <input name="titleAr" required maxLength={300} className={FIELD} placeholder="دليل تصميم الأساسات" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">
            العنوان في الرابط (لاتيني، دائم)
          </span>
          <input name="slug" required className={FIELD} placeholder="foundation-design-guide" dir="ltr" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">التخصص</span>
          <select name="disciplineId" required className={FIELD} value={discipline}
                  onChange={(e) => setDiscipline(e.target.value)}>
            <option value="" disabled>اختر التخصص</option>
            {disciplines.map((d) => <option key={d.id} value={d.id}>{d.nameAr}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">القسم (اختياري)</span>
          <select name="categoryId" className={FIELD} defaultValue="" disabled={discipline === ''}>
            <option value="">—</option>
            {scoped.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">نوع الملف</span>
          <select name="fileType" className={FIELD} defaultValue="PDF">
            {FILE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">المستوى</span>
          <select name="level" className={FIELD} defaultValue="">
            {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">وصف مختصر (اختياري)</span>
        <input name="subtitleAr" maxLength={300} className={FIELD} />
      </label>
      <input type="hidden" name="currency" value={currency} />
      <p className="text-xs text-[var(--color-ink-faint)]">
        يُنشأ المنتج <strong>مسودّة</strong>. لا يُنشر قبل أن يكون له ملف ومهندس وسعر.
      </p>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={BTN}>
          {pending ? 'جارٍ الإنشاء…' : 'إنشاء المنتج'}
        </button>
      </div>
      <Note state={state} />
    </form>
  );
}

export function ProductDetailsForm({
  productId, titleAr, subtitleAr, descriptionAr, level, softwareTags,
}: {
  productId: string; titleAr: string; subtitleAr: string | null;
  descriptionAr: string | null; level: string | null; softwareTags: readonly string[];
}) {
  const [state, action, pending] = useActionState(updateProductAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">العنوان</span>
        <input name="titleAr" required defaultValue={titleAr} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">وصف مختصر</span>
        <input name="subtitleAr" defaultValue={subtitleAr ?? ''} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">الوصف</span>
        <textarea name="descriptionAr" rows={4} defaultValue={descriptionAr ?? ''} className={FIELD} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">المستوى</span>
          <select name="level" defaultValue={level ?? ''} className={FIELD}>
            {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">البرامج (بفواصل)</span>
          <input name="softwareTags" defaultValue={softwareTags.join('، ')} className={FIELD} />
        </label>
      </div>
      <div><button type="submit" disabled={pending} className={BTN}>{pending ? '…' : 'حفظ التعديلات'}</button></div>
      <Note state={state} />
    </form>
  );
}

export function UploadFileForm({ productId, declaredType }: { productId: string; declaredType: string }) {
  const [state, action, pending] = useActionState(uploadProductFileAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="declaredType" value={declaredType} />
      <input type="file" name="file" required className={FIELD} />
      <p className="text-xs text-[var(--color-ink-faint)]">
        يُفحص الملف ويُخزَّن في تخزين خاص بلا رابط عام، وتُولَّد معاينة للـPDF تلقائياً.
      </p>
      <div><button type="submit" disabled={pending} className={BTN}>{pending ? 'جارٍ الرفع…' : 'رفع الملف'}</button></div>
      <Note state={state} />
    </form>
  );
}

export function CreditsForm({
  productId, contributors, current,
}: {
  productId: string;
  contributors: ReadonlyArray<{ id: string; displayName: string }>;
  current: ReadonlyArray<{ contributorId: string; shareBp: number }>;
}) {
  const [state, action, pending] = useActionState(setCreditsAction, INITIAL);
  const [rows, setRows] = useState(
    current.length > 0
      ? current.map((c) => ({ id: c.contributorId, percent: String(c.shareBp / 100) }))
      : [{ id: '', percent: '100' }],
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[1fr_110px_auto] gap-2">
          <select name="contributorId" required className={FIELD} value={row.id}
            onChange={(e) => setRows(rows.map((r, i) => i === index ? { ...r, id: e.target.value } : r))}>
            <option value="" disabled>اختر المهندس</option>
            {contributors.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
          </select>
          <input name="percent" required inputMode="decimal" className={FIELD} value={row.percent}
            onChange={(e) => setRows(rows.map((r, i) => i === index ? { ...r, percent: e.target.value } : r))} />
          <button type="button" className="text-xs text-[var(--color-ink-faint)]"
            onClick={() => setRows(rows.length > 1 ? rows.filter((_, i) => i !== index) : rows)}>حذف</button>
        </div>
      ))}
      <button type="button" className="self-start text-sm text-[var(--color-accent-ink)]"
        onClick={() => setRows([...rows, { id: '', percent: '' }])}>+ إضافة مهندس</button>
      <p className="text-xs text-[var(--color-ink-faint)]">
        مجموع النسب يجب أن يساوي <strong>١٠٠٪</strong> بالضبط. ولكل مهندس نسبة عمولته الخاصة،
        تُحدَّد في شاشة اتفاقات العمولة لا هنا.
      </p>
      <div><button type="submit" disabled={pending} className={BTN}>{pending ? '…' : 'حفظ المساهمين'}</button></div>
      <Note state={state} />
    </form>
  );
}

export function PriceForm({
  productId, currency, currentMinor,
}: { productId: string; currency: string; currentMinor: bigint | null }) {
  const [state, action, pending] = useActionState(changePriceAction, INITIAL);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">السعر ({currency})</span>
          <input name="amount" required inputMode="decimal" className={FIELD} placeholder="35.00" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">سبب التغيير (اختياري)</span>
          <input name="reason" maxLength={300} className={FIELD} />
        </label>
      </div>
      <p className="text-xs text-[var(--color-ink-faint)]">
        {currentMinor === null ? 'لا سعر حالي.' : 'يُغلق السعر الحالي ويُفتح سعر جديد.'}{' '}
        <strong>المبيعات السابقة لا تتأثر</strong> — كل بيعة تحمل سعرها المجمَّد.
      </p>
      <div><button type="submit" disabled={pending} className={BTN}>{pending ? '…' : 'حفظ السعر'}</button></div>
      <Note state={state} />
    </form>
  );
}

export function StatusForm({
  productId, nextStates, blockers,
}: {
  productId: string;
  nextStates: ReadonlyArray<{ to: string; label: string }>;
  blockers: readonly string[];
}) {
  const [state, action, pending] = useActionState(changeStatusAction, INITIAL);
  if (nextStates.length === 0) {
    return <p className="text-sm text-[var(--color-ink-faint)]">لا انتقالات متاحة من هذه الحالة.</p>;
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">الانتقال</span>
          <select name="to" className={FIELD} defaultValue={nextStates[0]!.to}>
            {nextStates.map((s) => <option key={s.to} value={s.to}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">ملاحظة (اختيارية)</span>
          <input name="note" maxLength={400} className={FIELD} />
        </label>
        <button type="submit" disabled={pending} className={BTN}>{pending ? '…' : 'تنفيذ'}</button>
      </div>
      {blockers.length > 0 ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn)]">
          لا يمكن النشر بعد: {blockers.join('، ')}
        </p>
      ) : null}
      <Note state={state} />
    </form>
  );
}
