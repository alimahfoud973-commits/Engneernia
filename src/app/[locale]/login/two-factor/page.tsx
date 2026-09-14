import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { TwoFactorForm } from '@/components/two-factor-form';
import { currentActor } from '@/auth/current';
import { safeReturnPath } from '@/auth/return-path';
import { PRIVATE_ROBOTS } from '@/seo/config';

export const metadata: Metadata = { robots: PRIVATE_ROBOTS };
export const dynamic = 'force-dynamic';

/**
 * The second factor, which the platform had a domain layer for and no screen.
 *
 * `verifyLoginTotp` and `markTwoFactorVerified` existed, were tested, and were
 * called by nothing — so an owner who enrolled TOTP was never challenged, and
 * `twoFactorSatisfied` stayed false for the life of the session while nothing
 * read it. This page is the missing half; the other half is that a session
 * which has not been through it now authorises nothing.
 */
export default async function TwoFactorPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next } = await searchParams;

  const actor = await currentActor();

  // Nothing to complete: no session at all, or one already finished.
  if (actor.kind !== 'USER') redirect('/login');
  if (actor.twoFactorSatisfied) redirect(safeReturnPath(next));

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-16">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">التحقق بخطوتين</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            كلمة المرور وحدها لا تكفي لهذا الحساب. أدخل الرمز من تطبيق المصادقة.
          </p>
        </header>
        <TwoFactorForm next={next ?? null} />
      </main>
      <SiteFooter />
    </>
  );
}
