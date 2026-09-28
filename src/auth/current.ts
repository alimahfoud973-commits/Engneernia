import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { GUEST, isOwner, type Actor } from '@/authz/actor';
import { resolveActor, sessionCookie } from './session';

/**
 * The current actor, resolved from the session cookie.
 *
 * `cache()` deduplicates within one render pass: a layout, a page and three
 * components asking who is signed in cost a single lookup, not five.
 *
 * The role comes from the DATABASE on every request (see session.ts), never
 * from the cookie, so disabling an account takes effect immediately.
 */
export const currentActor = cache(async (): Promise<Actor> => {
  const store = await cookies();
  return resolveActor(store.get(sessionCookie().name)?.value);
});

/**
 * For pages that require a signed-in user. Sends guests to sign in.
 */
export async function requireActor(returnTo: string): Promise<Actor> {
  const actor = await currentActor();
  if (actor.kind !== 'USER') {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }
  return actor;
}

/**
 * For the admin console. A guest is sent to the OWNER's sign-in (username and
 * password) — the subscriber form could never open this console, because the
 * phone-and-email path cannot return the owner row. A signed-in non-owner is
 * sent away, not told the console exists.
 *
 * No second factor (Stage 6, owner decision): the owner's password and the
 * session rules are the whole of it.
 */
export async function requireOwner(returnTo: string): Promise<Actor> {
  const actor = await currentActor();
  if (actor.kind !== 'USER') {
    redirect(`/login/owner?next=${encodeURIComponent(returnTo)}`);
  }
  if (!isOwner(actor)) {
    // Not a 403: confirming that an admin console exists is itself a hint.
    redirect('/');
  }
  return actor;
}

export { GUEST };
