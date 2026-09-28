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
