// The hosted copy (web/README.md): served over https it becomes an installable web app that works offline,
// and in every copy its Content-Security-Policy forbids it any network connection.
// The test server is http://127.0.0.1, so the debug flag "hosted" stands in for https here.
import { test as base, expect } from '@playwright/test';
import { App, fixture } from '../support/app.js';

const test = base;

test('served as the hosted copy, it installs a service worker and opens offline', async ({ page, context }, testInfo) => {
  const app = new App(page, testInfo, false);
  await app.open({ debug: { hosted: true } });
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', 'apple-touch-icon.png');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // every request stayed on this site, and only for its own files
  const origin = new URL(page.url()).origin;
  const others = [...new Set(app.requests)].filter(u => !u.startsWith(origin + '/') && !u.startsWith('blob:') && !u.startsWith('data:'));
  expect(others).toEqual([]);
  // offline: the page still opens, from the service worker's cache, and converts
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  expect(app.unexpectedErrors()).toEqual([]);
});

test('on a slow network, the online version opens from its saved copy within seconds', async ({ page }, testInfo) => {
  const app = new App(page, testInfo, false);
  const id = 'slow-' + testInfo.project.name;
  await app.open({ debug: { hosted: true } });
  await page.goto(`/alt/${id}/discpress.html`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now under the service worker, which saves the page
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // from now on the server takes 60 s to answer the page
  await page.request.get(`/__slow/${id}`);
  const t0 = Date.now();
  await page.reload({ timeout: 30_000 });
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 30_000 });
  const secs = (Date.now() - t0) / 1000;
  test.info().annotations.push({ type: 'opened in', description: secs.toFixed(1) + ' s' });
  expect(secs).toBeGreaterThan(3.5); // the service worker waited for the network first
  expect(secs).toBeLessThan(20);
  expect(app.unexpectedErrors()).toEqual([]);
});

test('when the site answers with an error, the online version opens from its saved copy', async ({ page }, testInfo) => {
  const app = new App(page, testInfo, false);
  const id = 'fail-' + testInfo.project.name;
  await app.open({ debug: { hosted: true } });
  await page.goto(`/alt/${id}/discpress.html`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now under the service worker, which saves the page
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // from now on the server answers the page with 503 Service Unavailable
  await page.request.get(`/__fail/${id}`);
  const t0 = Date.now();
  const res = await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 30_000 });
  expect(res.status()).toBe(200);
  expect(Date.now() - t0).toBeLessThan(3500); // at once, not after the slow network's wait
  expect(app.unexpectedErrors()).toEqual([]);
});

test('a copy on another site without the service worker keeps its built-in icon and links no manifest', async ({ page }, testInfo) => {
  const app = new App(page, testInfo, false);
  await app.open({ debug: { hosted: true } });
  // the harness opened the page at / first, whose service worker would control /alt/ too
  await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
  await page.goto(`/alt/nosw-${testInfo.project.name}/discpress.html`);
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length))).toBe(0);
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', /^data:/);
  app.allowErrors(/sw\.js|ServiceWorker|service worker|404/i);
  expect(app.unexpectedErrors()).toEqual([]);
});

test('the page may not connect anywhere, even to its own site', async ({ page }, testInfo) => {
  const app = new App(page, testInfo, false);
  await app.open();
  app.allowErrors(/Content Security Policy|connect-src/);
  const blocked = await page.evaluate(async () => {
    try { await fetch('/healthz'); return false; } catch (e) { return true; }
  });
  expect(blocked).toBe(true);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src 'none'/);
  // not the hosted copy: no manifest, no service worker
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(r => r.length))).toBe(0);
});
