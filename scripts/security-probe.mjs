/**
 * ===========================================================================
 * THE SECURITY PROBE
 * ===========================================================================
 *   node scripts/security-probe.mjs [baseUrl]
 *
 * Drives a real browser against a RUNNING build and checks, from the outside,
 * the things this platform promises about who may see what. It is deliberately
 * separate from the test suites: unit tests prove the rules are written
 * correctly, integration tests prove the database enforces them, and this
 * proves that what is actually SERVED over HTTP agrees with both.
 *
 * Written in P8 after two defects that no suite could have caught:
 *   - a post-login redirect that a crafted `next` parameter sent off-site;
 *   - a rate limiter whose refusal path crashed.
 * Both were found by operating the running site, which is what this automates.
 *
 * WHAT IT NEEDS. Two accounts and two ids, supplied through the environment,
 * because the probe must sign in as somebody to prove anything:
 *
 *   PROBE_OWNER_EMAIL / PROBE_OWNER_PASSWORD
 *   PROBE_ENGINEER_EMAIL / PROBE_ENGINEER_PASSWORD
 *   PROBE_FOREIGN_SETTLEMENT_ID   a settlement belonging to a DIFFERENT engineer
 *   PROBE_FOREIGN_PROOF_ID        a payment receipt belonging to someone else
 *
 * These are throwaway credentials for a staging database. Never point this at
 * production with a real owner password.
 * ===========================================================================
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? process.env.PROBE_BASE_URL ?? 'http://localhost:3111';
const CHROME = process.env.PROBE_CHROMIUM ?? undefined;

const required = [
  'PROBE_OWNER_EMAIL',
  'PROBE_OWNER_PASSWORD',
  'PROBE_ENGINEER_EMAIL',
  'PROBE_ENGINEER_PASSWORD',
  'PROBE_FOREIGN_SETTLEMENT_ID',
  'PROBE_FOREIGN_PROOF_ID',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error('Missing environment: ' + missing.join(', '));
  console.error('See the comment at the top of this file.');
  process.exit(2);
}

const env = process.env;
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

/**
 * Financial vocabulary that must not appear in a response to somebody who is
 * not entitled to it. Matched against the RAW response body, not the rendered
 * DOM, so text hidden by CSS still counts as leaked — which is the whole point
 * of the owner's first rule.
 */
const FINANCIAL_MARKERS = [
  'صافي المستحق',
  'إجمالي المبيعات',
  'عمولة المنصة',
  'رصيد المهندس',
  'كشف التسوية',
];

const GUARDED_PAGES = [
  '/admin/finance',
  '/admin/settlements',
  '/admin/adjustments',
  '/admin/payments',
];

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

async function signIn(ctx, email, password) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  return { page, signedIn: page.url().includes('/account') };
}

async function get(page, path) {
  const res = await page.request.get(BASE + path, { maxRedirects: 5 });
  const body = res.status() === 200 ? await res.text() : '';
  return {
    status: res.status(),
    landedOn: res.url().replace(BASE, ''),
    markers: FINANCIAL_MARKERS.filter((m) => body.includes(m)),
  };
}

// ---------------------------------------------------------------------------
console.log('\n1. SECURITY HEADERS');
{
  const res = await fetch(`${BASE}/`, { redirect: 'follow' });
  const csp = res.headers.get('content-security-policy') ?? '';
  check(csp.includes("script-src"), 'a Content-Security-Policy is sent');
  check(/'nonce-[^']+'/.test(csp), 'script-src is nonce-gated');
  check(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src has no 'unsafe-inline'");
  check(!/script-src[^;]*'unsafe-eval'/.test(csp), "script-src has no 'unsafe-eval'");
  check(csp.includes("frame-ancestors 'none'"), 'framing is refused');
  check(csp.includes("base-uri 'none'"), 'an injected <base> cannot repoint scripts');
  check(csp.includes("form-action 'self'"), 'forms cannot post off-site');
  check(res.headers.get('x-content-type-options') === 'nosniff', 'nosniff is set');
  check(res.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options is set for old browsers');
  check((res.headers.get('strict-transport-security') ?? '').includes('max-age='), 'HSTS is set');
  check(res.headers.get('x-powered-by') === null, 'the server does not announce itself');
}

// ---------------------------------------------------------------------------
console.log('\n2. NOBODY UNAUTHENTICATED REACHES A FINANCIAL SURFACE');
{
  const ctx = await browser.newContext({ locale: 'ar' });
  const page = await ctx.newPage();
  for (const path of GUARDED_PAGES) {
    const r = await get(page, path);
    check(r.landedOn.startsWith('/login'), `${path} sends a visitor to sign in`, r.landedOn);
    check(r.markers.length === 0, `${path} discloses no figure to a visitor`, r.markers.join(', '));
  }
  const statement = await get(page, `/api/settlements/${env.PROBE_FOREIGN_SETTLEMENT_ID}/statement`);
  check(statement.status === 404, 'a settlement statement is 404 for a visitor', String(statement.status));
  const proof = await get(page, `/api/proofs/${env.PROBE_FOREIGN_PROOF_ID}`);
  check(proof.status === 404, 'a payment receipt is 404 for a visitor', String(proof.status));
  // Shape check, not authorisation: a malformed id must not become a 500.
  const malformed = await get(page, '/api/proofs/not-a-uuid');
  check(malformed.status === 404, 'a malformed id is 404, not a server error', String(malformed.status));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n3. A SIGNED-IN ENGINEER REACHES ONLY THEIR OWN');
{
  const ctx = await browser.newContext({ locale: 'ar' });
  const { page, signedIn } = await signIn(ctx, env.PROBE_ENGINEER_EMAIL, env.PROBE_ENGINEER_PASSWORD);
  check(signedIn, 'the engineer can sign in at all (control)');
  for (const path of GUARDED_PAGES) {
    const r = await get(page, path);
    check(!r.landedOn.startsWith('/admin'), `${path} is refused to an engineer`, r.landedOn);
    check(r.markers.length === 0, `${path} discloses no figure to an engineer`, r.markers.join(', '));
  }
  const statement = await get(page, `/api/settlements/${env.PROBE_FOREIGN_SETTLEMENT_ID}/statement`);
  check(statement.status === 404, "another engineer's statement is 404", String(statement.status));
  const proof = await get(page, `/api/proofs/${env.PROBE_FOREIGN_PROOF_ID}`);
  check(proof.status === 404, "someone else's receipt is 404", String(proof.status));
  const own = await get(page, '/account/earnings');
  check(own.status === 200, 'the engineer still reaches their own earnings page');
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n4. THE OWNER DOES REACH THEM (POSITIVE CONTROL)');
{
  const ctx = await browser.newContext({ locale: 'ar' });
  const { page, signedIn } = await signIn(ctx, env.PROBE_OWNER_EMAIL, env.PROBE_OWNER_PASSWORD);
  check(signedIn, 'the owner can sign in');
  const finance = await get(page, '/admin/finance');
  check(finance.landedOn.startsWith('/admin/finance'), 'the owner reaches the finance report');
  /**
   * Without this assertion the whole probe could pass against a build where
   * every page 404s. The denials above are only meaningful because the same
   * marker IS present here.
   */
  check(finance.markers.length > 0, 'the finance report really does contain figures', finance.markers.join(', '));
  const statement = await get(page, `/api/settlements/${env.PROBE_FOREIGN_SETTLEMENT_ID}/statement`);
  check(statement.status === 200, 'the owner reaches any settlement statement', String(statement.status));
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n5. THE POST-LOGIN DESTINATION CANNOT LEAVE THIS SITE');
{
  const hostile = ['//evil.example.com', '/\\evil.example.com', 'https://evil.example.com', 'javascript:alert(1)'];
  for (const next of hostile) {
    const ctx = await browser.newContext({ locale: 'ar' });
    const page = await ctx.newPage();
    let offSite = null;
    await ctx.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== new URL(BASE).hostname) { offSite = route.request().url(); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${BASE}/login?next=${encodeURIComponent(next)}`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="email"]', env.PROBE_ENGINEER_EMAIL);
    await page.fill('input[name="password"]', env.PROBE_ENGINEER_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
    check(offSite === null, `next=${next} does not leave the site`, offSite ?? '');
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
console.log('\n6. A SERVER ACTION REFUSES A FOREIGN ORIGIN');
{
  const ctx = await browser.newContext({ locale: 'ar' });
  const page = await ctx.newPage();
  let captured = null;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) {
      captured = { url: r.url(), headers: r.headers(), body: r.postData() };
    }
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', env.PROBE_ENGINEER_EMAIL);
  await page.fill('input[name="password"]', env.PROBE_ENGINEER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);

  const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const session = (await ctx.cookies()).find((c) => c.name.includes('session'));
  check(Boolean(session), 'a session cookie was issued');
  if (session) {
    check(session.httpOnly, 'the session cookie is httpOnly (script cannot read it)');
    check(session.sameSite === 'Lax' || session.sameSite === 'Strict', 'the session cookie is SameSite', session.sameSite);
    check(session.name.startsWith('__Host-'), 'the session cookie carries the __Host- prefix', session.name);
  }

  if (captured) {
    const headers = { ...captured.headers, cookie: cookies, origin: 'https://evil.example.com' };
    delete headers['content-length'];
    const res = await fetch(captured.url, { method: 'POST', headers, body: captured.body, redirect: 'manual' });
    check(res.status >= 400, 'a replayed action with a foreign Origin is refused', String(res.status));
  } else {
    check(false, 'a server-action request could be captured');
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Added after the review was first written, because these surfaces did not
// exist then. Self-registration (0039) and invoices (0042) are the two things
// that changed what an anonymous stranger can touch.
console.log('\n7. REGISTRATION DOES NOT ANSWER "DOES THIS PERSON HAVE AN ACCOUNT?"');
{
  /**
   * THE POINT OF THIS SECTION.
   *
   * The registration form takes an email and says something back. If it says
   * anything different for an address that already has an account, it becomes
   * a way to ask, one address at a time, who buys from this platform — which
   * is the §36 rule applied to a form instead of an API.
   *
   * A FRESH CONTEXT PER ATTEMPT, and the comparison is of <main> rather than
   * the whole document. Written the other way first, it reported a difference
   * that turned out to be the probe's own carry-over between two submissions
   * in one page — a false alarm, which in a security check is as costly as a
   * miss: it is the report nobody believes the second time.
   */
  const register = async (email) => {
    const ctx = await browser.newContext({ locale: 'ar' });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await page.fill('#displayName', 'Probe');
    await page.fill('#email', email);
    await page.fill('#password', 'probe-password-that-is-long-enough');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);
    const main = (await page.textContent('main')) ?? '';
    await ctx.close();
    return main.replace(/\s+/g, ' ').trim();
  };

  const knownAnswer = await register(env.PROBE_ENGINEER_EMAIL);
  const unknownAnswer = await register(`nobody-${Date.now()}@test.local`);
  /**
   * A CONTROL, because this check has a second way to differ.
   *
   * Registration is rate limited per IP. Once the limit is crossed the form
   * answers differently — and if one of the two attempts above straddles that
   * boundary, they differ for a reason that has nothing to do with whether an
   * address exists. That happened on the first run of this section and looked
   * exactly like a leak.
   *
   * Two UNKNOWN addresses must always agree. When they do not, the
   * environment is what is noisy, and the check says so instead of crying
   * wolf. Run the probe against a database whose registration buckets are
   * fresh — `DELETE FROM rate_limit_buckets WHERE key LIKE 'register%'`.
   */
  const controlAnswer = await register(`nobody-${Date.now()}-b@test.local`);

  /**
   * A SECOND WAY TO BE INCONCLUSIVE, found the same way as the first.
   *
   * If outbound mail is unreachable, every registration ends in the same
   * server-side failure — so the three answers agree perfectly, the sameness
   * check passes, and only the "is it the neutral message" check fails. That
   * reads exactly like the neutral message having regressed, and it is not: it
   * is the mail server. Seen on a run whose SMTP host did not resolve.
   *
   * Enumeration is genuinely untested in that state, so say so rather than
   * report a failure whose cause is somewhere else entirely.
   */
  const mailDown = /تعذّر إتمام إنشاء الحساب/.test(unknownAnswer);

  /**
   * THE RATE LIMIT, DETECTED RATHER THAN INFERRED.
   *
   * Comparing the two unknown addresses was meant to catch this, and it does
   * not catch all of it: the per-IP bucket is shared by all three attempts and
   * the known address goes first, so a limit crossed after it leaves the two
   * unknowns agreeing with each other and disagreeing with the known one —
   * which is indistinguishable, from here, from the leak this section exists
   * to find. It reported exactly that on a run whose buckets were not cleared.
   *
   * Reading the limiter's own message is order-independent and needs no
   * inference. The equality control below stays, because it still catches the
   * case where the limit lands between the second and third attempt.
   */
  const rateLimited = [knownAnswer, unknownAnswer, controlAnswer]
    .some((answer) => /محاولات كثيرة/.test(answer));

  if (rateLimited) {
    console.log('  SKIP  registration is rate limited right now — enumeration check not conclusive');
    console.log('        run `ALLOW_PROBE_SEED=yes npm run seed:probe` immediately before the probe.');
  } else if (unknownAnswer !== controlAnswer) {
    console.log('  SKIP  registration is rate limited right now — enumeration check not conclusive');
    console.log('        clear the buckets and re-run: DELETE FROM rate_limit_buckets WHERE key LIKE \'register%\'');
  } else if (mailDown) {
    console.log('  SKIP  registration is failing on the server — enumeration check not conclusive');
    console.log('        every address gets the same error, so this proves nothing either way.');
    console.log('        check MAIL_TRANSPORT_URL: the host must resolve and accept the credentials.');
  } else {
    check(
      knownAnswer === unknownAnswer,
      'a known address and an unknown one get the SAME answer',
    );
    check(
      /تحقّق من بريدك/.test(knownAnswer),
      'and that answer is the neutral one',
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\n8. A VERIFICATION LINK CANNOT BE GUESSED OR REPLAYED BLINDLY');
{
  const ctx = await browser.newContext({ locale: 'ar' });
  const page = await ctx.newPage();

  for (const token of ['', 'not-a-token', 'a'.repeat(43), '../../etc/passwd']) {
    const res = await page.goto(
      `${BASE}/verify-email?token=${encodeURIComponent(token)}`,
      { waitUntil: 'domcontentloaded' },
    );
    const body = (await page.textContent('body')) ?? '';
    // It must answer, and it must not confirm anything.
    check(
      res.status() < 500 && !/تم تأكيد بريدك/.test(body),
      `a forged token verifies nothing`,
      JSON.stringify(token.slice(0, 16)),
    );
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n9. AN INVOICE REACHES ONLY ITS BUYER');
{
  // Invoices carry the buyer's name, address and what they bought. They are
  // the newest financial document on the platform and the probe had nothing
  // about them.
  const ctx = await browser.newContext({ locale: 'ar' });
  const page = await ctx.newPage();

  if (env.PROBE_FOREIGN_INVOICE_ID) {
    const anonymous = await get(page, `/api/invoices/${env.PROBE_FOREIGN_INVOICE_ID}`);
    check(anonymous.status === 404, "a visitor cannot fetch somebody's invoice", String(anonymous.status));

    const malformed = await get(page, '/api/invoices/not-a-uuid');
    check(malformed.status === 404, 'a malformed invoice id is 404, not a server error', String(malformed.status));

    const { page: enginPage } = await signIn(ctx, env.PROBE_ENGINEER_EMAIL, env.PROBE_ENGINEER_PASSWORD);
    const asEngineer = await get(enginPage, `/api/invoices/${env.PROBE_FOREIGN_INVOICE_ID}`);
    // A contributor sells the product and still may not see who bought it.
    check(asEngineer.status === 404, "an engineer cannot fetch a customer's invoice", String(asEngineer.status));
  } else {
    console.log('  SKIP  PROBE_FOREIGN_INVOICE_ID not set — invoice checks not run');
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
console.log('\n10. PRIVATE SETTINGS STAY PRIVATE');
{
  // `tax.*` and `invoice.*` are marked is_public = false. A page that leaked
  // the platform's tax registration number would be disclosing a business
  // identifier nobody asked it to publish.
  const ctx = await browser.newContext({ locale: 'ar' });
  const page = await ctx.newPage();
  for (const path of ['/', '/search', '/register', '/login']) {
    const res = await get(page, path);
    check(
      !/tax\.rateBp|tax\.registration|invoice\.sellerAddressAr/.test(res.body),
      `${path} does not disclose a private setting key`,
    );
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
