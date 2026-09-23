import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ===========================================================================
 * EVERY ADMIN PAGE CALLS `requireOwner`
 * ===========================================================================
 * The admin layout deliberately does NOT gate (see its comment): each page
 * calls `requireOwner` itself. That makes the gate one line per page — and a
 * line is easy to forget on the next page someone adds. A forgotten gate is
 * not a type error, not a build failure, and not visible to the owner, who
 * passes it anyway. RLS would still refuse most of the DATA, but the page
 * itself would render for anyone.
 *
 * Source-level on purpose: it runs in milliseconds with no server, so it
 * catches the omission on the commit that makes it. What is actually SERVED
 * is checked from outside by `scripts/security-probe.mjs`.
 * ===========================================================================
 */

const ROOT = process.cwd();

function adminPages(): string[] {
  return [...globSync('src/app/**/admin/**/page.tsx', { cwd: ROOT })].sort();
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('admin pages', () => {
  it('finds the admin pages at all (control)', () => {
    // Without this, a glob that silently matched nothing would pass every
    // assertion below.
    expect(adminPages().length).toBeGreaterThanOrEqual(8);
  });

  it.each(adminPages())('%s calls requireOwner', (file) => {
    expect(read(file)).toMatch(/await requireOwner\(/);
  });
});

describe('/admin — the front door', () => {
  const file = adminPages().find((f) => /admin[\\/]page\.tsx$/.test(f));

  it('exists', () => {
    expect(file).toBeDefined();
  });

  it('gates before it redirects', () => {
    const source = read(file!);
    const gate = source.indexOf("await requireOwner('/admin')");
    const onward = source.indexOf("redirect('/admin/products')");
    expect(gate).toBeGreaterThan(-1);
    expect(onward).toBeGreaterThan(-1);
    // Redirecting first would confirm to a visitor that a console lives here.
    expect(gate).toBeLessThan(onward);
  });
});
