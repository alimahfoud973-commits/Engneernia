import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { OwnerLoginForm } from '@/components/login-form';
import { currentActor } from '@/auth/current';
import { safeReturnPath } from '@/auth/return-path';
import type { Metadata } from 'next';
import { PRIVATE_ROBOTS } from '@/seo/config';

/**
 * The owner's sign-in (Stage 6): username and password. Kept out of search
 * results like the subscriber form, and linked from nowhere — `/admin` sends
 * a visitor here, which is the only way anyone needs to reach it.
 */
export const metadata: Metadata = { robots: PRIVATE_ROBOTS };

export const dynamic = 'force-dynamic';

export default async function OwnerLoginPage({
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
  if (actor.kind === 'USER') redirect(safeReturnPath(next, '/admin'));

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-16">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">دخول الإدارة</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            باسم المستخدم وكلمة المرور.
          </p>
        </header>
        <OwnerLoginForm next={next ?? null} />
      </main>
      <SiteFooter />
    </>
  );
}
