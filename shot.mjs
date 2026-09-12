import { chromium } from 'playwright';
const S='/tmp/claude-0/-home-user/d729d803-3281-5077-848f-706b813db3f2/scratchpad';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const scheme of ['light','dark']) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 1000 }, locale: 'ar' });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3111/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${S}/home-${scheme}.png`, fullPage: false });
  await ctx.close();
}
await browser.close();
console.log('shots taken');
