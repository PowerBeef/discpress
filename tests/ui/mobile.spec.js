// Phone-specific behaviour (runs in the emulated iphone and android projects).
import { test, expect, fixture, App } from '../support/app.js';
import { overflowReport } from '../support/layout.js';

test('the phone layout fits the screen before and after converting', async ({ app, page }) => {
  await app.open();
  await expect(page.locator('#addFolder')).toBeHidden(); // no folder picking on phones
  expect((await overflowReport(page)).offenders).toEqual([]);
  await app.add(fixture('ps1-multitrack').add);
  const card = app.job('mgs disc1');
  await app.settled(card);
  await card.locator('details.opts summary').click();
  expect((await overflowReport(page)).offenders).toEqual([]);
  await app.run(card);
  expect((await overflowReport(page)).offenders).toEqual([]);
  const label = await card.locator('.result .out button').innerText();
  expect(['Download', 'Save to Files']).toContain(label.trim());
});

test('before measuring, phones start from fewer threads', async ({ app, page }) => {
  await app.open({ cores: 8, tuned: false });
  await expect(page.locator('#chipThreads')).toHaveText(/Auto · 4 threads/i);
});

test('inside an iOS app web view the header stays fixed and the content scrolls', async ({ browser, browserName }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  const base = testInfo.project.use;
  // web views are Safari without the "Safari/" token in the user agent
  const ctx = await browser.newContext({ ...base, userAgent: base.userAgent.replace(/ Safari\/[\d.]+/, '') });
  const page = await ctx.newPage();
  const app = new App(page, testInfo, false);
  await app.open();
  await expect(page.locator('html')).toHaveClass(/mode-shell/);
  await app.add([...fixture('ps1-single').add, ...fixture('saturn').add, ...fixture('segacd').add, ...fixture('ps2-dvd').add]);
  await expect(app.jobs()).toHaveCount(4);
  const scroller = page.locator('#scroller');
  await scroller.evaluate(s => s.scrollTo(0, s.scrollHeight));
  expect(await scroller.evaluate(s => s.scrollTop)).toBeGreaterThan(0);
  const top = await page.locator('header.top').boundingBox();
  expect(Math.round(top.y)).toBe(0);
  expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
  expect(app.unexpectedErrors()).toEqual([]);
  await ctx.close();
  void browserName;
});
