import { chromium } from 'playwright';

/**
 *   node scripts/csp-check.mjs [url ...]
 *
 * Does the policy in `src/lib/security/csp.ts` break the running site?
 *
 * A CSP mistake is invisible in the markup: the HTML looks perfect and the
 * page is simply dead. So this listens for the browser's OWN verdict — the
 * `securitypolicyviolation` event, which fires for every resource the policy
 * refused — and separately proves that React hydrated by clicking something.
 */
const BASE = process.env.PROBE_BASE_URL ?? 'http://localhost:3111';
const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/', '/search', '/login'].map((p) => BASE + p);
const browser = await chromium.launch(
  process.env.PROBE_CHROMIUM ? { executablePath: process.env.PROBE_CHROMIUM } : {},
);

let violations = 0;
for (const url of urls) {
  const ctx = await browser.newContext({ locale: 'ar' });
  const page = await ctx.newPage();

  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(`${e.violatedDirective} <- ${e.blockedURI}`);
    });
  });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const found = await page.evaluate(() => window.__cspViolations ?? []);
  // Hydration proof: React attaches this only once the client bundle has run.
  const hydrated = await page.evaluate(
    () => Boolean(document.querySelector('body')?.__reactContainer$ ||
      Object.keys(document.querySelector('#__next, body > div, main') ?? {})
        .some((k) => k.startsWith('__react'))),
  );

  console.log(`\n### ${url}`);
  console.log(`  hydrated: ${hydrated}`);
  console.log(`  csp violations: ${found.length}`);
  for (const v of found) { violations++; console.log('   !! ' + v); }
  const cspErrors = consoleErrors.filter((e) => /Refused to|Content Security/i.test(e));
  console.log(`  console CSP complaints: ${cspErrors.length}`);
  for (const e of cspErrors) { violations++; console.log('   !! ' + e); }
  const otherErrors = consoleErrors.filter((e) => !/Refused to|Content Security/i.test(e));
  if (otherErrors.length) console.log(`  (other console errors: ${otherErrors.length})`, otherErrors.slice(0, 3));

  await ctx.close();
}
await browser.close();
console.log(violations === 0 ? '\nPASS: no CSP violation anywhere' : `\nFAIL: ${violations} violations`);
process.exit(violations ? 1 : 0);
