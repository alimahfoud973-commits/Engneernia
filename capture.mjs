import { chromium } from 'playwright';
const SP = process.env.SHOT_DIR;
const BASE = 'http://localhost:3111';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function ctxFor(scheme, creds) {
  const ctx = await browser.newContext({
    colorScheme: scheme, locale: 'ar', viewport: { width: 1360, height: 1000 },
    deviceScaleFactor: 2,
  });
  if (creds) {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.fill('input[name="email"]', creds.email);
    await p.fill('input[name="password"]', creds.password);
    await p.click('button[type="submit"]');
    await p.waitForTimeout(2200);
    await p.close();
  }
  return ctx;
}

const OWNER = { email: 'owner@platform.local', password: 'p8-audit-owner-not-for-production' };
const ENG = { email: 'demo-engineer@example.com', password: 'demo-account-not-for-production' };

const SHOTS = [
  ['home',          '/',                        null,  true],
  ['search',        '/search?discipline=civil', null,  false],
  ['product',       '/products/scale-4625',     null,  false],
  ['login',         '/login',                   null,  false],
  ['admin-finance', '/admin/finance',           OWNER, true],
  ['admin-adjust',  '/admin/adjustments',       OWNER, false],
  ['admin-settle',  '/admin/settlements',       OWNER, false],
  ['eng-earnings',  '/account/earnings',        ENG,   false],
  ['eng-notify',    '/account/notifications',   ENG,   false],
];

for (const scheme of ['light', 'dark']) {
  const contexts = new Map();
  for (const [name, path, creds, full] of SHOTS) {
    const key = creds ? creds.email : 'guest';
    if (!contexts.has(key)) contexts.set(key, await ctxFor(scheme, creds));
    const page = await contexts.get(key).newPage();
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${SP}/${name}-${scheme}.png`, fullPage: full });
    console.log(name, scheme, '->', page.url());
    await page.close();
  }
  for (const c of contexts.values()) await c.close();
}

// One phone-width capture, because the platform is browsed on phones.
const mob = await browser.newContext({ locale: 'ar', viewport: { width: 400, height: 850 }, deviceScaleFactor: 2 });
const mp = await mob.newPage();
await mp.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await mp.waitForTimeout(1500);
await mp.screenshot({ path: `${SP}/home-mobile.png` });
console.log('mobile ->', mp.url());
await browser.close();
