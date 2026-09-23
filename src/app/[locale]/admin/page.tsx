import { redirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { requireOwner } from '@/auth/current';

export const dynamic = 'force-dynamic';

/**
 * The console's front door.
 *
 * Every owner screen lives one level down, so `/admin` itself used to be a
 * 404 — for the owner too. Typing the obvious address looked like the console
 * did not exist.
 *
 * The gate runs BEFORE the redirect, and it is the same `requireOwner` every
 * screen behind it calls. Redirecting first would bounce a visitor to
 * `/admin/products`, where they would be refused anyway — but it would also
 * confirm, by that very bounce, that a console lives here. This way a
 * non-owner gets exactly what they get on any other admin URL.
 */
export default async function AdminIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner('/admin');
  redirect('/admin/products');
}
