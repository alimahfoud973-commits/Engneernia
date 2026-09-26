import type { Metadata } from 'next';
import { connection } from 'next/server';
import { NotFoundContent } from '@/components/not-found-content';
import { fontVariables } from './fonts';
import './globals.css';

/**
 * The 404 for everything the `[locale]` layout never renders (D1):
 * addresses no route matches (`/a/b/c`), and a `notFound()` raised by that
 * layout itself (`/en/x` — a locale the platform does not serve).
 *
 * It renders its own document because the root layout is empty. Arabic and
 * right-to-left are written here rather than read from routing: this page
 * runs when the URL did NOT resolve to a locale, and the platform's only
 * locale is Arabic (decision D-03).
 *
 * `connection()` makes it render per request. Prerendered, it was a static
 * file with no CSP nonce, so the policy `src/proxy.ts` sends blocked every
 * one of its scripts — three violations on every mistyped address. Rendered
 * per request, Next stamps the nonce from the request header like on any
 * other page.
 */
export const metadata: Metadata = {
  title: 'الصفحة غير موجودة',
};

export default async function RootNotFound() {
  await connection();

  return (
    <html lang="ar" dir="rtl">
      <body className={fontVariables}>
        <NotFoundContent />
      </body>
    </html>
  );
}
