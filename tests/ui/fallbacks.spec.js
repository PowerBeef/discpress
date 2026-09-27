// Paths the app takes on older or restricted browsers, forced on in Chromium.
import { test, expect, fixture } from '../support/app.js';
import { info, nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

async function convertAgent(app) {
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman()) {
    const ref = reference('createdvd', 'agent.iso');
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  }
  return card;
}

test('without WebAssembly SIMD the baseline build is used and gives the same result', async ({ app, page }) => {
  await app.open({ noSimd: true });
  await convertAgent(app);
  // the build that was loaded has its embedded copy cleared
  expect(await page.locator('#wasm-base').evaluate(n => n.textContent.length)).toBe(0);
  expect(await page.locator('#wasm-simd').evaluate(n => n.textContent.length)).toBeGreaterThan(0);
});

test('with SIMD the SIMD build is used', async ({ app, page }) => {
  await app.open();
  expect(await page.locator('#wasm-simd').evaluate(n => n.textContent.length)).toBe(0);
});

test('without private storage (OPFS) results are kept in memory', async ({ app, page }) => {
  await app.open({ noOpfs: true });
  await expect(page.locator('#chipStore')).toHaveText('Results in memory');
  await expect(page.locator('#memTip')).toBeVisible();
  await convertAgent(app);
});

test('"memory only" setting keeps results in memory', async ({ app, page }) => {
  await app.open({ settings: { storage: 'memory' } });
  await expect(page.locator('#chipStore')).toHaveText('Results in memory');
  await convertAgent(app);
});

test('private storage is used when available', async ({ app, page }) => {
  await app.open();
  await expect(page.locator('#chipStore')).toHaveText('Large files OK');
});

test('inputs the worker cannot read directly are copied to storage first', async ({ app }) => {
  await app.open({ debug: { stage: 1 } });
  const card = await convertAgent(app);
  await expect(card.locator('pre.logtext')).toContainText('is copied to private storage first');
});

test('if the worker cannot read them at all, the page streams inputs to it (iOS web view path)', async ({ app }) => {
  await app.open({ debug: { stage: 2 } });
  const card = await convertAgent(app);
  await expect(card.locator('pre.logtext')).toContainText('is copied to private storage first');
});

test('a single CPU core still converts (no helper workers)', async ({ app, page }) => {
  await app.open({ cores: 1 });
  await expect(page.locator('#chipThreads')).toContainText('1 thread');
  await convertAgent(app);
});
