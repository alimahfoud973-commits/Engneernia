import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { GUEST, isOwner, type Actor } from '@/authz/actor';
import { SESSION_COOKIE_NAME, resolveActor } from './session';

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
  return resolveActor(store.get(SESSION_COOKIE_NAME)?.value);
});

/**
 * For pages that require a signed-in user. Sends guests to sign in — and sends
 * a session that still owes its second factor to the challenge.
 *
 * Without that second branch the page would render for a half-authenticated
 * session and then show nothing, because the policy layer and RLS both refuse
 * it: the person would see an empty console with no way to understand why.
 * The redirect turns a dead end into the step they actually have to take.
 */
export async function requireActor(returnTo: string): Promise<Actor> {
  const actor = await currentActor();
  if (actor.kind !== 'USER') {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }
  if (!actor.twoFactorSatisfied) {
    redirect(`/login/two-factor?next=${encodeURIComponent(returnTo)}`);
  }
  return actor;
}

/**
 * For the admin console. A non-owner is sent away, not told it exists.
 *
 * An owner with NO second factor enrolled is sent to enrol instead. The
 * platform is operated by one account that approves payments, pays engineers
 * and writes ledger corrections; a password is not enough for it, and the
 * deployment checklist has always said so. What was missing was any way to
 * comply — so this is a guided step, not a lockout: /account/security is
 * reachable, and everything else about the account keeps working.
 */
export async function requireOwner(returnTo: string): Promise<Actor> {
  const actor = await requireActor(returnTo);
  if (!isOwner(actor)) {
    // Not a 403: confirming that an admin console exists is itself a hint.
    redirect('/');
  }
  if (actor.kind === 'USER' && !actor.totpEnabled) {
    redirect(`/account/security?next=${encodeURIComponent(returnTo)}`);
  }
  return actor;
}

export { GUEST };
