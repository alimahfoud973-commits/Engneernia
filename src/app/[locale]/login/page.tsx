import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { LoginForm } from '@/components/login-form';
import { currentActor } from '@/auth/current';
import { safeReturnPath } from '@/auth/return-path';
import type { Metadata } from 'next';
import { PRIVATE_ROBOTS } from '@/seo/config';

/**
 * The sign-in page is kept out of search results.
 *
 * Not for secrecy — the form is public — but because a sign-in page ranking
 * for the platform's own name is how phishing pages get clicked: a visitor who
 * searches for the site and lands on a login screen has no way to tell a real
 * result from a paid one.
 */
export const metadata: Metadata = { robots: PRIVATE_ROBOTS };

export const dynamic = 'force-dynamic';

export default async function LoginPage({
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
  if (actor.kind === 'USER') redirect(safeReturnPath(next));

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-16">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">تسجيل الدخول</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            ادخل إلى حسابك لمتابعة طلباتك وتنزيل مشترياتك.
          </p>
        </header>
        <LoginForm next={next ?? null} />

        <p className="text-sm text-[var(--color-ink-soft)]">
          لا حساب لك بعد؟{' '}
          <Link href="/register" className="font-semibold text-[var(--color-accent)] hover:underline">
            أنشئ حساباً
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
