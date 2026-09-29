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

test('on iPhone, the speed test tries up to 4 threads, and one that stopped at 1.3.1\u2019s limit of 2 runs again', async ({ app, page }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  const tuning = () => page.evaluate(() => JSON.parse(localStorage.getItem('chdman-web-tuning') || 'null'));
  // a result measured under a lower limit is dropped, so automatic mode starts from 4 again
  await app.open({ cores: 4, tuning: { threads: 2, cap: 2 } });
  await expect(page.locator('#chipThreads')).toHaveText(/Auto · 4 threads/i);
  await page.click('#settingsBtn');
  await page.click('#retune');
  await expect.poll(async () => (await tuning())?.cap, { timeout: 60_000 }).toBe(4);
  const t = await tuning();
  test.info().annotations.push({ type: 'speed test', description: JSON.stringify(t.steps) });
  expect(t.steps.every(([n]) => n <= 4)).toBe(true);
  // one that chose fewer threads than its limit allowed, or that is older than the limit, is kept
  for (const [fields, chip] of [[{ threads: 3, cap: undefined }, /Auto · 3 threads/i], [{ threads: 1, cap: 2 }, /Auto · 1 thread$/i]]) {
    await page.evaluate(f => localStorage.setItem('chdman-web-tuning',
      JSON.stringify({ ...JSON.parse(localStorage.getItem('chdman-web-tuning')), ...f })), fields);
    await page.reload();
    await expect(page.locator('#chipThreads')).toHaveText(chip);
  }
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
  // no frosted glass on the fixed header: iOS draws it out of focus there
  expect(await page.locator('header.top').evaluate(h => getComputedStyle(h).backdropFilter)).toBe('none');
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

test('on iPhone, a file the share sheet cannot take is downloaded instead', async ({ page }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  // the share sheet is there, but fails as it can for a very large file
  await page.addInitScript(() => {
    navigator.canShare = () => true;
    navigator.share = () => Promise.reject(new DOMException('The share could not be completed.', 'DataError'));
  });
  const app = new App(page, testInfo, false);
  await app.open();
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  const button = card.locator('.result .out button');
  await expect(button).toHaveText(/Save to Files/);
  const download = page.waitForEvent('download');
  await button.click();
  expect((await download).suggestedFilename()).toMatch(/\.chd$/);
  await expect(page.locator('.toast.err', { hasText: 'Downloading it instead' })).toBeVisible();
});

test('on iPhone, a result too large for the share sheet is downloaded without it', async ({ page }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  // WebKit's share sheet reads the whole file into memory, which closes the app for a large one
  await page.addInitScript(() => {
    window.__shared = 0;
    navigator.canShare = () => true;
    navigator.share = () => { window.__shared++; return Promise.resolve(); };
  });
  const app = new App(page, testInfo, false);
  await app.open({ debug: { shareMax: 64 << 10 } }); // "large" = over 64 KiB here
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  const out = card.locator('.result .out');
  await expect(out.locator('button')).toHaveText(/^\s*Download\s*$/);
  await expect(out).toContainText('too large for the share sheet');
  const download = page.waitForEvent('download');
  await out.locator('button').click();
  expect((await download).suggestedFilename()).toMatch(/\.chd$/);
  expect(await page.evaluate(() => window.__shared)).toBe(0);
});

test('opened from the Home Screen, the fixed header is sharp: no frosted glass', async ({ page }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const app = new App(page, testInfo, false);
  await app.open();
  await expect(page.locator('html')).toHaveClass(/mode-shell/);
  const style = await page.locator('header.top').evaluate(h => { const c = getComputedStyle(h); return [c.backdropFilter, c.backgroundColor]; });
  expect(style[0]).toBe('none');
  expect(style[1]).not.toMatch(/rgba\(.*, 0(\.\d+)?\)$/); // opaque
});

test('opened from the Home Screen, a large result downloads and says to use Safari if nothing happens', async ({ page }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  // iOS may not start downloads in a home-screen web app (docs/ios/hosting.md)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    navigator.canShare = () => true;
    navigator.share = () => Promise.resolve();
  });
  const app = new App(page, testInfo, false);
  await app.open({ debug: { shareMax: 64 << 10 } });
  await expect(page.locator('#iosTip')).toBeHidden();
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  const out = card.locator('.result .out');
  await expect(out.locator('button')).toHaveText(/^\s*Download\s*$/);
  await expect(out).toContainText('if nothing happens, open powerbeef.github.io/discpress in Safari itself');
});

test('inside an iOS app web view, a notice points big games to Discpress online in Safari', async ({ browser }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  const base = testInfo.project.use;
  const ctx = await browser.newContext({ ...base, userAgent: base.userAgent.replace(/ Safari\/[\d.]+/, '') });
  const page = await ctx.newPage();
  const app = new App(page, testInfo, false);
  await app.open();
  const tip = page.locator('#iosTip');
  await expect(tip).toBeVisible();
  await expect(tip.locator('#hostedLink')).toHaveAttribute('href', 'https://powerbeef.github.io/discpress/');
  await tip.locator('#iosTipOk').click();
  await expect(tip).toBeHidden();
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await expect(page.locator('#iosTip')).toBeHidden(); // dismissed once, for good
  expect(app.unexpectedErrors()).toEqual([]);
  await ctx.close();
});

test('in Safari itself, there is no such notice', async ({ app, page }, testInfo) => {
  test.skip(!/iphone/.test(testInfo.project.name), 'iOS only');
  await app.open();
  await expect(page.locator('#iosTip')).toBeHidden();
});
