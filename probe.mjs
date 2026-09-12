import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const scheme of ['light','dark']) {
  const ctx = await browser.newContext({ colorScheme: scheme, locale: 'ar' });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3111/', { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const header = document.querySelector('header');
    return {
      matchesDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      ground: cs.getPropertyValue('--color-ground').trim(),
      surface: cs.getPropertyValue('--color-surface').trim(),
      ink: cs.getPropertyValue('--color-ink').trim(),
      accent: cs.getPropertyValue('--color-accent').trim(),
      bodyBg: body.backgroundColor,
      headerBg: header ? getComputedStyle(header).backgroundColor : null,
    };
  });
  console.log(scheme, JSON.stringify(out));
  await ctx.close();
}
await browser.close();
