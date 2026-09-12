import { setRequestLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { LoginForm } from '@/components/login-form';
import { currentActor } from '@/auth/current';

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
  if (actor.kind === 'USER') redirect(next?.startsWith('/') ? next : '/account');

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
      </main>
      <SiteFooter />
    </>
  );
}
