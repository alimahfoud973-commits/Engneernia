import { setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { DisableTwoFactor, EnrolTwoFactor } from '@/components/security-forms';
import { requireActor } from '@/auth/current';
import { twoFactorState } from '@/auth/totp-enrolment';
import { isOwner } from '@/authz/actor';
import { PRIVATE_ROBOTS } from '@/seo/config';

export const metadata: Metadata = { robots: PRIVATE_ROBOTS };
export const dynamic = 'force-dynamic';

/**
 * The account's security screen — today, the second factor and nothing else.
 *
 * `requireActor` rather than `requireOwner`: the owner arriving here has been
 * REDIRECTED from the admin console precisely because they have no factor yet,
 * and a gate that bounced them back would be a loop. The enrolment itself is
 * owner-only and says so, in the domain layer where it is enforced.
 */
export default async function SecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next } = await searchParams;

  const actor = await requireActor('/account/security');
  const state = await twoFactorState(actor);
  const owner = isOwner(actor);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-lg flex-col gap-6 px-5 py-12">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">أمان الحساب</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            التحقق بخطوتين: رمز من تطبيق على هاتفك، إضافةً إلى كلمة المرور.
          </p>
        </header>

        {owner && !state.enabled ? (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-4 py-3 text-sm">
            حساب المالك يعتمد المدفوعات، ويصرف للمهندسين، ويكتب قيود التصحيح في
            الدفتر. لوحة الإدارة تبقى مغلقة حتى تُفعِّل التحقق بخطوتين.
            {next ? ' وستعود إلى ما كنت تفعله بعد التفعيل.' : ''}
          </p>
        ) : null}

        <section className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-line)] p-5">
          <h2 className="text-lg font-semibold">
            {state.enabled ? 'التحقق بخطوتين مفعَّل' : 'تفعيل التحقق بخطوتين'}
          </h2>

          {state.enabled ? (
            <>
              <p className="text-sm text-[var(--color-ink-soft)]">
                عند كل تسجيل دخول يُطلب منك رمز من تطبيق المصادقة.
              </p>
              <DisableTwoFactor />
            </>
          ) : owner ? (
            <EnrolTwoFactor />
          ) : (
            <p className="text-sm text-[var(--color-ink-soft)]">
              التحقق بخطوتين متاح لحساب المالك في هذه المرحلة.
            </p>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
