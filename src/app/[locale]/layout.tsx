import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { IBM_Plex_Sans_Arabic, IBM_Plex_Mono } from 'next/font/google';
import { routing, directionOf } from '@/i18n/routing';
import '../globals.css';

/**
 * IBM Plex Sans Arabic carries both Arabic and Latin glyphs from one
 * superfamily, which keeps English engineering terms inside Arabic copy
 * visually consistent rather than falling back to an unrelated face.
 */
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'منصة الموارد الهندسية',
  description: 'المعرفة الهندسية والموارد الرقمية — كهربائية، ميكانيكية، معمارية، مدنية',
  robots: { index: false, follow: false }, // Lifted at launch (phase P8).
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!(routing.locales as readonly string[]).includes(locale)) notFound();

  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={locale} dir={directionOf(locale)} suppressHydrationWarning>
      <body className={`${plexArabic.variable} ${plexMono.variable}`}>
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
