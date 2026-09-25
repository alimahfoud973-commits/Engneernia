import { describe, it, expect } from 'vitest';
import { GUEST, type Actor } from '@/authz/actor';
import { accountEntry } from './site-chrome';

/**
 * ===========================================================================
 * THE HEADER'S WAY IN (Stage 2 audit, D2)
 * ===========================================================================
 * A crawl of every public page reached neither /login nor /register: a
 * visitor could only find sign-in by pressing "buy", and a signed-in user had
 * no route to their account except from checkout. The header now carries one
 * link whose target depends on who is looking.
 * ===========================================================================
 */

const base = {
  kind: 'USER',
  displayName: 'Test',
  locale: 'ar',
  sessionId: 'session-1',
  twoFactorSatisfied: true,
  totpEnabled: false,
  contributorId: null,
  contributorActive: false,
} as const;

const customer: Actor = { ...base, userId: 'u-customer', role: 'CUSTOMER' };
const engineer: Actor = { ...base, userId: 'u-engineer', role: 'CONTRIBUTOR', contributorId: 'c-1', contributorActive: true };
const owner: Actor = { ...base, userId: 'u-owner', role: 'OWNER', totpEnabled: true };
const ownerOwingSecondFactor: Actor = { ...owner, twoFactorSatisfied: false };

describe('accountEntry', () => {
  it('offers a visitor the sign-in page', () => {
    expect(accountEntry(GUEST)).toEqual({ href: '/login', label: 'تسجيل الدخول' });
  });

  it.each([
    ['customer', customer],
    ['engineer', engineer],
    ['owner', owner],
  ])('offers a signed-in %s their account', (_name, actor) => {
    expect(accountEntry(actor)).toEqual({ href: '/account', label: 'الحساب' });
  });

  it('treats a session still owing its second factor as signed in', () => {
    // /account then sends it to /login/two-factor — the step it has to take.
    expect(accountEntry(ownerOwingSecondFactor).href).toBe('/account');
  });
});
