import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { routing, directionOf } from '@/i18n/routing';
import { getPublicSettings } from '@/platform/settings';
import { languageAlternates, publicRobots, siteUrl } from '@/seo/config';
import { fontVariables } from '../fonts';
import '../globals.css';

/**
 * The metadata every page inherits.
 *
 * Built at request time rather than declared as a constant, for two reasons
 * that both come from the owner's decisions: the platform NAME lives in the
 * settings table so it can be changed without a deployment, and whether this
 * deployment may be indexed at all is a per-environment flag that defaults to
 * no. A static export could express neither.
 *
 * `metadataBase` is what turns every relative URL below — canonical links,
 * Open Graph images — into an absolute one. Without it Next emits relative
 * canonicals, which some crawlers resolve against the wrong host.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const settings = await getPublicSettings();
  const name = locale === 'ar' ? settings.platformNameAr : settings.platformName;

  return {
    metadataBase: siteUrl(),
    title: {
      // A product page sets only its own title; this appends the platform's.
      template: `%s — ${name}`,
      default: `${name} — ${settings.tagline}`,
    },
    description: settings.tagline,
    applicationName: name,
    robots: publicRobots(),
    alternates: {
      canonical: '/',
      languages: languageAlternates('/'),
    },
    openGraph: {
      type: 'website',
      siteName: name,
      locale: locale === 'ar' ? 'ar_SY' : 'en_US',
      title: `${name} — ${settings.tagline}`,
      description: settings.tagline,
      url: '/',
    },
    // No Twitter image is declared: an og:image that 404s is worse than none,
    // and the platform has no artwork yet (OPEN-8).
    twitter: { card: 'summary', title: name, description: settings.tagline },
    formatDetection: { telephone: false },
  };
}

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
      <body className={fontVariables}>
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
