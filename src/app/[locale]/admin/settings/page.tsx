import { setRequestLocale } from 'next-intl/server';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { AdminNav } from '../admin-nav';
import { WhatsappNumberForm } from '@/components/settings-forms';
import { requireOwner } from '@/auth/current';
import { whatsappSettingForOwner } from '@/platform/settings-admin';

export const dynamic = 'force-dynamic';

/**
 * Platform settings — for now the WhatsApp number alone (specification §23;
 * Stage 2 audit, W2).
 *
 * OWNER-ONLY at every layer: `requireOwner` redirects, `settings-admin.ts`
 * refuses anyone else, and `settings_write` admits only `app_is_owner()`.
 */
export default async function AdminSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await requireOwner('/admin/settings');
  const whatsapp = await whatsappSettingForOwner(actor);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10">
        <AdminNav current="/admin/settings" />

        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">الإعدادات</h1>
        </header>

        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">المساعدة عبر واتساب</h2>
            <p className="max-w-prose text-sm leading-relaxed text-[var(--color-ink-soft)]">
              الرقم الذي يُحوَّل إليه المشتري حين يختار «المساعدة عبر واتساب» أو يضغط «تواصل معنا
              عبر واتساب» في صفحة إتمام الطلب. تُستخدم القيمة الحالية دائماً، حتى للطلبات السابقة.
              نص الرسالة يُعدَّل من «طرق الدفع».
            </p>
          </div>
          <p
            className={
              'w-fit rounded-[var(--radius-card)] px-3 py-1 text-sm font-semibold '
              + (whatsapp.usable
                ? 'bg-[var(--color-ok-soft)] text-[var(--color-ok)]'
                : 'bg-[var(--color-warn-soft)] text-[var(--color-warn)]')
            }
          >
            {whatsapp.usable
              ? 'مضبوط — تظهر المساعدة عبر واتساب للمشترين'
              : whatsapp.number
                ? 'الرقم المحفوظ غير صالح لواتساب — لا تظهر المساعدة للمشترين حتى يُصحَّح'
                : 'غير مضبوط — لا تظهر المساعدة عبر واتساب للمشترين'}
          </p>
          {/* A usable number is shown with its "+"; an unusable one as stored, to correct. */}
          <WhatsappNumberForm defaultValue={whatsapp.usable ? `+${whatsapp.number}` : whatsapp.number} />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
