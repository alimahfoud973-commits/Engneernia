import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import {
  CreatePaymentMethodForm, EditPaymentMethodForm, PaymentMethodActiveForm,
} from '@/components/payment-method-forms';
import { requireOwner } from '@/auth/current';
import { paymentMethodsForOwner } from '@/payments/admin';

export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  MANUAL: 'تحويل يدوي',
  ASSISTED: 'مساعدة عبر واتساب',
  GATEWAY: 'بوابة دفع إلكترونية',
};

/**
 * Payment methods (specification §21 — Stage 2 audit, F3).
 *
 * OWNER-ONLY at every layer: `requireOwner` redirects, every function in
 * `src/payments/admin.ts` refuses a non-owner, and `payment_methods_write`
 * admits only `app_is_owner()`. Provider credentials are never read here —
 * they live in `payment_method_secrets`, which this screen does not touch.
 *
 * Each method says whether customers actually see it, and if not, why: an
 * active manual method without account details is kept from checkout, and the
 * owner should never have to guess why a method they switched on is missing.
 */
export default async function AdminPaymentMethodsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/payment-methods');
  const methods = await paymentMethodsForOwner(actor);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/payment-methods" />

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">طرق الدفع</h1>
          <p className="max-w-prose text-sm leading-relaxed text-[var(--color-ink-soft)]">
            ما يراه المشتري عند إتمام الطلب. لا تظهر طريقة التحويل اليدوي إلا وهي مفعّلة
            ومكتملة التعليمات وبيانات الحساب. كل طلب يحتفظ ببيانات الدفع التي عُرضت عليه لحظة
            إنشائه، فتعديل الطريقة أو تعطيلها لا يغيّر الطلبات السابقة.
          </p>
        </header>

        <ul className="flex flex-col gap-5">
          {methods.map((method) => (
            <li
              key={method.id}
              className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="text-base font-semibold">{method.displayNameAr}</h2>
                  <p className="technical-term text-xs text-[var(--color-ink-faint)]" dir="ltr">
                    {method.code} · {TYPE_LABELS[method.type] ?? method.type}
                  </p>
                </div>
                <PaymentMethodActiveForm methodId={method.id} isActive={method.isActive} />
              </div>

              <p
                className={
                  'w-fit rounded-[var(--radius-card)] px-3 py-1 text-sm font-semibold '
                  + (method.offeredToBuyers
                    ? 'bg-[var(--color-ok-soft)] text-[var(--color-ok)]'
                    : 'bg-[var(--color-warn-soft)] text-[var(--color-warn)]')
                }
              >
                {method.offeredToBuyers
                  ? 'مفعّلة وتظهر للمشترين'
                  : !method.isActive
                    ? 'معطّلة — لا تظهر للمشترين'
                    : `مفعّلة لكنها لا تظهر للمشترين: ${method.gaps.join('، ')}`}
              </p>

              {method.type === 'GATEWAY' ? (
                <p className="text-sm text-[var(--color-ink-soft)]">
                  لا توجد بوابة دفع إلكترونية مُعدّة، فلا تظهر هذه الطريقة للمشترين مهما كانت حالتها.
                </p>
              ) : (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-[var(--color-accent-ink)]">
                    تعديل الطريقة
                  </summary>
                  <div className="mt-4">
                    <EditPaymentMethodForm
                      values={{
                        id: method.id,
                        type: method.type,
                        displayNameAr: method.displayNameAr,
                        displayNameEn: method.displayNameEn,
                        descriptionAr: method.descriptionAr,
                        instructionsAr: method.instructionsAr,
                        accountDetailsAr: method.accountDetailsAr,
                        supportMessageAr: method.supportMessageAr,
                        requiresProof: method.requiresProof,
                        countries: method.countries,
                        currencies: method.currencies,
                        sortOrder: method.sortOrder,
                      }}
                    />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>

        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink-soft)]">إضافة طريقة دفع</h2>
          <CreatePaymentMethodForm />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
