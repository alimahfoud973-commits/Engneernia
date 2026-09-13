import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { RegisterForm } from '@/components/register-form';
import { currentActor } from '@/auth/current';
import { PRIVATE_ROBOTS } from '@/seo/config';

/**
 * Kept out of search results for the same reason as the sign-in page: a
 * sign-up form ranking for the platform's own name is what makes a phishing
 * copy indistinguishable from the real one in a results list.
 */
export const metadata: Metadata = { robots: PRIVATE_ROBOTS };

export const dynamic = 'force-dynamic';

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const actor = await currentActor();
  if (actor.kind === 'USER') redirect('/');

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-16">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">إنشاء حساب</h1>
          <p className="text-sm text-[var(--color-ink-soft)]">
            الحساب يلزم لإتمام الشراء وتنزيل ما اشتريته لاحقاً.
          </p>
        </header>

        <RegisterForm />

        <p className="text-sm text-[var(--color-ink-soft)]">
          لديك حساب؟{' '}
          <Link href="/login" className="font-semibold text-[var(--color-accent)] hover:underline">
            تسجيل الدخول
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
