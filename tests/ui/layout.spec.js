// Layout sweep: every screen of the app at several sizes, in light and dark.
// Fails on horizontal overflow; saves screenshots of each screen to
// .cache/screens/<size>/<theme>-<screen>.png (viewport) and ...-full.png (whole page)
// for a human (or Claude) to review.
import fs from 'node:fs';
import path from 'node:path';
import { devices } from '@playwright/test';
import { test, expect, fixture } from '../support/app.js';
import { overflowReport, smallTargets } from '../support/layout.js';
import { CACHE } from '../support/paths.js';

// only Chromium is available; drop the browser choice so test.use() can switch devices per group
const chromium = ({ defaultBrowserType, browserName, ...rest }) => rest; // eslint-disable-line no-unused-vars
const SIZES = {
  'phone-320': chromium({ ...devices['iPhone SE'], viewport: { width: 320, height: 568 } }),
  'iphone-se': chromium(devices['iPhone SE']),
  'iphone-15-pro-max': chromium(devices['iPhone 15 Pro Max']),
  'pixel-7': chromium(devices['Pixel 7']),
  'phone-landscape': chromium(devices['iPhone 15 Pro landscape']),
  'ipad': chromium(devices['iPad (gen 7)']),
  'ipad-landscape': chromium(devices['iPad (gen 7) landscape']),
  'laptop': chromium({ ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }),
  'desktop-wide': chromium({ ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } }),
};

async function shot(page, size, theme, screen, touch) {
  const dir = path.join(CACHE, 'screens', size);
  fs.mkdirSync(dir, { recursive: true });
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove()));
  // what the user sees (fixed header and dock included) ...
  await page.screenshot({ path: path.join(dir, `${theme}-${screen}.png`), animations: 'disabled' });
  // ... and the whole page, without fixed overlays that would land mid-image
  const style = await page.addStyleTag({ content: '#dock{display:none!important}' });
  await page.screenshot({ path: path.join(dir, `${theme}-${screen}-full.png`), fullPage: true, animations: 'disabled' });
  await style.evaluate(n => n.remove());
  // a full-page screenshot turns Chromium's touch emulation off ((pointer: coarse) stops matching): turn it back on
  if (touch) await (await page.context().newCDPSession(page)).send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

async function check(page, size, theme, screen, touch) {
  await page.waitForTimeout(150); // let transitions settle
  await shot(page, size, theme, screen, touch);
  const r = await overflowReport(page);
  expect(r.offenders, `${size} ${theme} ${screen}: elements outside the viewport`).toEqual([]);
  expect(r.scrollWidth, `${size} ${theme} ${screen}: page scrolls sideways`).toBeLessThanOrEqual(r.viewport);
  if (touch) test.info().annotations.push(...(await smallTargets(page, 32)).map(t => ({ type: `small tap target (${screen}, ${theme})`, description: t })));
}

for (const [size, device] of Object.entries(SIZES)) {
  test.describe(size, () => {
    test.use(device);
    for (const theme of ['light', 'dark']) {
      test(`${theme}`, async ({ app, page }) => {
        const touch = !!device.hasTouch;
        await app.open({ theme });
        await check(page, size, theme, '1-start', touch);

        // jobs in several states: finished, waiting for a file, and an ambiguous match
        await app.add([...fixture('ps1-single').add, 'ax101.cue', 'ax101.bin', ...fixture('ps1-multitrack').add]);
        await app.settled(app.job('twine'));
        await app.settled(app.job('mgs disc1'));
        await app.job('mgs disc1').locator('details.opts summary').click();
        await app.run(app.job('twine'));
        await page.evaluate(() => document.scrollingElement.scrollTo(0, 0));
        await check(page, size, theme, '2-jobs', touch);

        await page.click('.tab[data-tab="cli"]');
        await app.add(['twine.cue', 'twine.bin'], { via: '#cliAdd' });
        await check(page, size, theme, '3-advanced', touch);

        await page.click('.tab[data-tab="help"]');
        await check(page, size, theme, '4-help', touch);

        await page.click('#settingsBtn');
        await expect(page.locator('dialog#settings')).toBeVisible();
        await check(page, size, theme, '5-settings', touch);
      });
    }
  });
}
