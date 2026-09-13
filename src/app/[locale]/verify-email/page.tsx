import { setRequestLocale } from 'next-intl/server';
import Link from 'next/link';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/site-chrome';
import { consumeVerificationToken, type VerificationOutcome } from '@/auth/verify-email';
import { PRIVATE_ROBOTS } from '@/seo/config';

export const metadata: Metadata = { robots: PRIVATE_ROBOTS };

/**
 * Redeeming the link from the verification email.
 *
 * `force-dynamic` is not a performance oversight: this page CONSUMES a
 * single-use token, so it must never be prerendered, cached, or revalidated.
 */
export const dynamic = 'force-dynamic';

const MESSAGES: Record<VerificationOutcome, { title: string; body: string; tone: 'ok' | 'bad' }> = {
  VERIFIED: {
    title: 'تم تأكيد بريدك',
    body: 'حسابك مُفعَّل الآن. ادخل إليه لتتابع طلباتك وتنزيل مشترياتك.',
    tone: 'ok',
  },
  ALREADY_VERIFIED: {
    title: 'الحساب مؤكَّد من قبل',
    body: 'لا شيء عليك فعله — هذا البريد مؤكَّد بالفعل. ادخل إلى حسابك مباشرة.',
    tone: 'ok',
  },
  EXPIRED_OR_SPENT: {
    title: 'انتهت صلاحية الرابط',
    body:
      'هذا الرابط استُعمل من قبل أو مضت مدته. اطلب رابطاً جديداً من صفحة إنشاء الحساب '
      + 'بإدخال البريد نفسه.',
    tone: 'bad',
  },
  INVALID: {
    title: 'رابط غير صالح',
    body:
      'تعذّرت قراءة هذا الرابط. تأكّد من نسخه كاملاً من الرسالة، أو اطلب رابطاً جديداً '
      + 'من صفحة إنشاء الحساب.',
    tone: 'bad',
  },
};

export default async function VerifyEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { token } = await searchParams;

  const headerStore = await headers();
  const outcome = token
    ? await consumeVerificationToken({
        rawToken: token,
        ip: headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: headerStore.get('user-agent'),
      })
    : ('INVALID' as const);

  const message = MESSAGES[outcome];
  const verified = outcome === 'VERIFIED' || outcome === 'ALREADY_VERIFIED';

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-16">
        <div
          className={
            message.tone === 'ok'
              ? 'rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-5'
              : 'rounded-[var(--radius-card)] border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-5'
          }
        >
          <h1 className="text-xl font-bold">{message.title}</h1>
          <p className="mt-2 text-sm text-[var(--color-ink-soft)]">{message.body}</p>
        </div>

        <Link
          href={verified ? '/login' : '/register'}
          className="rounded-[var(--radius-card)] bg-[var(--color-accent)] px-5 py-2.5 text-center text-sm font-semibold text-[var(--color-accent-contrast)] transition-opacity hover:opacity-90"
        >
          {verified ? 'تسجيل الدخول' : 'اطلب رابطاً جديداً'}
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
