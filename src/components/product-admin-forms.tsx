'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  changePriceAction, changeStatusAction, createProductAction, productVersionAction,
  setCreditsAction, updateProductAction, type ProductActionState,
} from '@/catalog/product-actions';
import { formKey } from './form-key';
import { uploadFile } from './upload-file';

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

  const typed = state.values;

  return (
    <form key={formKey(state)} action={action} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">عنوان المنتج</span>
          <input name="titleAr" required maxLength={300} className={FIELD} placeholder="دليل تصميم الأساسات" defaultValue={typed?.titleAr} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">
            العنوان في الرابط (لاتيني، دائم)
          </span>
          <input name="slug" required className={FIELD} placeholder="foundation-design-guide" dir="ltr" defaultValue={typed?.slug} />
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
          <select name="categoryId" className={FIELD} defaultValue={typed?.categoryId ?? ''} disabled={discipline === ''}>
            <option value="">—</option>
            {scoped.map((c) => <option key={c.id} value={c.id}>{c.nameAr}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">نوع الملف</span>
          <select name="fileType" className={FIELD} defaultValue={typed?.fileType ?? 'PDF'}>
            {FILE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">المستوى</span>
          <select name="level" className={FIELD} defaultValue={typed?.level ?? ''}>
            {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">وصف مختصر (اختياري)</span>
        <input name="subtitleAr" maxLength={300} className={FIELD} defaultValue={typed?.subtitleAr} />
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
  // A refusal shows what was typed; otherwise the stored values.
  const typed = state.values;
  return (
    <form key={formKey(state)} action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">العنوان</span>
        <input name="titleAr" required defaultValue={typed?.titleAr ?? titleAr} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">وصف مختصر</span>
        <input name="subtitleAr" defaultValue={typed?.subtitleAr ?? subtitleAr ?? ''} className={FIELD} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-faint)]">الوصف</span>
        <textarea name="descriptionAr" rows={4} defaultValue={typed?.descriptionAr ?? descriptionAr ?? ''} className={FIELD} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">المستوى</span>
          <select name="level" defaultValue={typed?.level ?? level ?? ''} className={FIELD}>
            {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">البرامج (بفواصل)</span>
          <input name="softwareTags" defaultValue={typed?.softwareTags ?? softwareTags.join('، ')} className={FIELD} />
        </label>
      </div>
      <div><button type="submit" disabled={pending} className={BTN}>{pending ? '…' : 'حفظ التعديلات'}</button></div>
      <Note state={state} />
    </form>
  );
}

/**
 * Upload a product file (S4-01). Not a Server Action: an action's body is
 * capped at 1 MB before any of our code runs, so the file goes to a Route
 * Handler that streams it against the product type's own ceiling.
 */
export function UploadFileForm({ productId }: { productId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<ProductActionState & { waiting?: number }>(INITIAL);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (form.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0];
    if (!file || file.size === 0) {
      setState({ error: 'اختر ملفاً أولاً' });
      return;
    }
    setPending(true);
    const answer = await uploadFile(`/api/admin/products/${productId}/file`, file);
    setPending(false);
    if (answer.error) {
      setState({ error: answer.error });
      return;
    }
    form.reset();
    setState({ error: null, ok: true, ...(answer.waiting ? { waiting: answer.waiting } : {}) });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <input type="file" name="file" required className={FIELD} />
      <p className="text-xs text-[var(--color-ink-faint)]">
        يُفحص الملف ويُخزَّن في تخزين خاص بلا رابط عام، وتُولَّد معاينة للـPDF تلقائياً.
        رفع ملف لمنتج معروض للبيع أو مُباع يُنشئ إصداراً جديداً ينتظر اعتمادك، ويبقى الإصدار الحالي معروضاً.
      </p>
      <div><button type="submit" disabled={pending} className={BTN}>{pending ? 'جارٍ الرفع…' : 'رفع الملف'}</button></div>
      {state.waiting ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-sm text-[var(--color-warn)]">
          رُفع الإصدار {state.waiting} وينتظر اعتمادك في قائمة الإصدارات. المنتج ما زال يبيع الإصدار الحالي.
        </p>
      ) : (
        <Note state={state} />
      )}
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
    <form key={formKey(state)} action={action} className="flex flex-col gap-3">
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
    <form key={formKey(state)} action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">السعر ({currency})</span>
          <input name="amount" required inputMode="decimal" className={FIELD} placeholder="35.00" defaultValue={state.values?.amount} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">سبب التغيير (اختياري)</span>
          <input name="reason" maxLength={300} className={FIELD} defaultValue={state.values?.reason} />
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
    <form key={formKey(state)} action={action} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">الانتقال</span>
          <select name="to" className={FIELD} defaultValue={state.values?.to ?? nextStates[0]!.to}>
            {nextStates.map((s) => <option key={s.to} value={s.to}>{s.label}</option>)}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-xs text-[var(--color-ink-faint)]">ملاحظة (اختيارية)</span>
          <input name="note" maxLength={400} className={FIELD} defaultValue={state.values?.note} />
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

export interface VersionRow {
  readonly id: string;
  readonly versionNo: number;
  readonly createdAt: string;
  readonly isCurrent: boolean;
  readonly pending: boolean;
  readonly superseded: boolean;
  readonly deleted: boolean;
  readonly filesPurged: boolean;
  readonly filename: string | null;
  readonly scanStatus: string | null;
  readonly buyers: number;
  readonly buyersInWindow: number;
  readonly blockers: readonly string[];
}

/**
 * The versions of a product (S4-04, S4-09, S4-10): release a waiting one,
 * delete any. Nothing here decides — `activateVersion` re-runs the file checks
 * and `deleteVersion` keeps every order, grant and invoice.
 */
export function VersionControls({ productId, version }: { productId: string; version: VersionRow }) {
  const [activateState, activate, activating] = useActionState(productVersionAction, INITIAL);
  const [deleteState, remove, removing] = useActionState(productVersionAction, INITIAL);
  const status = version.deleted
    ? 'محذوف'
    : version.isCurrent
      ? 'المعروض للبيع'
      : version.pending
        ? 'ينتظر الاعتماد'
        : version.superseded
          ? 'سابق'
          : '—';
  return (
    <li className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-line)] p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">الإصدار {version.versionNo}</span>
        <span className="rounded-sm bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs">{status}</span>
      </div>
      <p className="text-xs text-[var(--color-ink-faint)]">
        {version.filename ?? 'بلا ملف أصلي'}
        {version.scanStatus ? ` · ${version.scanStatus}` : ''}
        {` · ${version.createdAt.slice(0, 10)}`}
        {` · المشترون ${version.buyers} (ضمن مدة التنزيل ${version.buyersInWindow})`}
        {version.filesPurged ? ' · أُزيلت ملفاته من التخزين' : ''}
      </p>
      {version.pending && version.blockers.length > 0 ? (
        <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-3 py-2 text-xs text-[var(--color-warn)]">
          لا يمكن اعتماده بعد: {version.blockers.join('، ')}
        </p>
      ) : null}
      {!version.deleted ? (
        <div className="flex flex-wrap items-center gap-3">
          {version.pending ? (
            <form action={activate}>
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="versionId" value={version.id} />
              <input type="hidden" name="op" value="activate" />
              <button type="submit" disabled={activating} className={BTN}>
                {activating ? '…' : 'اعتماده للبيع'}
              </button>
            </form>
          ) : null}
          <form action={remove} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="versionId" value={version.id} />
            <input type="hidden" name="op" value="delete" />
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" name="confirm" value="yes" required />
              {version.isCurrent ? 'أؤكد الحذف وإيقاف عرض المنتج' : 'أؤكد الحذف'}
            </label>
            <button
              type="submit"
              disabled={removing}
              className="rounded-[var(--radius-card)] border border-[var(--color-danger)] px-3 py-2 text-xs text-[var(--color-danger)] disabled:opacity-60"
            >
              {removing ? '…' : 'حذف الإصدار'}
            </button>
          </form>
        </div>
      ) : null}
      <Note state={activateState.error ? activateState : deleteState} />
    </li>
  );
}
