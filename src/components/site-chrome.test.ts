import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * ===========================================================================
 * THE HEADER LISTS NO DISCIPLINE OF ITS OWN (D3)
 * ===========================================================================
 * Disciplines are data (owner decisions §12, D-12). The header once wrote the
 * four into this file, so disabling one left a header link to a 404 and adding
 * one never reached the header. It now renders `navDisciplines()`; this keeps
 * a literal list from coming back. Source-level, so it runs without a server;
 * `src/catalog/nav-disciplines.itest.ts` checks what the function returns.
 * ===========================================================================
 */
describe('the header reads its disciplines from the database (D3)', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/site-chrome.tsx'), 'utf8');
  const SEEDED_SLUGS = ['electrical', 'civil', 'architecture', 'mechanical'];

  it('names no discipline slug', () => {
    for (const slug of SEEDED_SLUGS) {
      expect(source, slug).not.toMatch(new RegExp(`['"\`/]${slug}['"\`]`));
    }
  });

  it('keeps no hard-coded discipline list', () => {
    expect(source).not.toMatch(/DISCIPLINE_NAV/);
    expect(source).not.toMatch(/\{\s*slug:\s*['"]/);
  });

  it('renders navDisciplines() and shows name_ar as stored', () => {
    expect(source).toMatch(/await navDisciplines\(\)/);
    expect(source).toMatch(/\{item\.nameAr\}/);
  });
});
