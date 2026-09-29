// The automatic thread count: a one-off speed test per device decides how many
// compression threads to use, instead of guessing from the device.
import { test, expect, fixture } from '../support/app.js';
import { nativeChdman, reference, sha1File } from '../support/native.js';

const tuning = page => page.evaluate(() => JSON.parse(localStorage.getItem('chdman-web-tuning') || 'null'));

test('the first conversion measures the device once, then uses the result', async ({ app, page }) => {
  await app.open({ tuned: false });
  await expect(page.locator('#chipThreads')).toHaveText(/^Auto · /);
  expect(await tuning(page)).toBeNull();

  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await expect(card.locator('.prog .ptext')).toContainText('Measuring this device', { timeout: 30_000 });
  await app.waitState(card, 'done', 120_000);

  const t = await tuning(page);
  expect(t.threads).toBeGreaterThanOrEqual(1);
  expect(t.steps.length).toBeGreaterThanOrEqual(2);
  test.info().annotations.push({ type: 'speed test', description: t.steps.map(([n, r]) => `${n}: ${r} MB/s`).join(', ') + ` -> ${t.threads}` });
  await expect(page.locator('#chipThreads')).toHaveText(`Auto · ${t.threads} thread${t.threads > 1 ? 's' : ''}`);
  const [out] = await app.downloads(card);
  if (nativeChdman()) expect(sha1File(out.path)).toBe(sha1File(reference('createdvd', 'agent.iso')));

  // a second conversion reuses the stored result
  await app.add(fixture('homebrew-iso').add);
  const second = app.job('homebrew');
  await app.settled(second);
  await second.locator('.job-foot button.primary').click();
  await app.waitState(second, 'done');
  expect((await tuning(page)).date).toBe(t.date);
});

test('the speed test is not limited by the number of cores the browser reports', async ({ app, page }) => {
  // report a single core on a machine that has several (as privacy-minded browsers may do)
  await app.open({ tuned: false, cores: 1 });
  await page.click('#settingsBtn');
  await expect(page.locator('#retuneRow')).toBeVisible();
  await page.click('#retune');
  await expect.poll(() => tuning(page), { timeout: 60_000 }).not.toBeNull();
  const t = await tuning(page);
  test.info().annotations.push({ type: 'speed test', description: JSON.stringify(t.steps) });
  // it tried more threads than the one reported (whether a second one pays off depends on the load of
  // the machine running the tests, not on the app)
  expect(Math.max(...t.steps.map(([n]) => n))).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#threadsInfo')).toContainText(`Measured on this device: ${t.threads} thread${t.threads > 1 ? 's' : ''}`);
  await page.locator('#diagBox summary').click();
  await expect(page.locator('#diagText')).toContainText('speed test: 1 → ');
});

test('measuring again replaces the stored result', async ({ app, page }) => {
  await app.open(); // starts from a stored result
  const before = await tuning(page);
  await page.click('#settingsBtn');
  await page.click('#retune');
  await expect.poll(async () => (await tuning(page)).date, { timeout: 60_000 }).not.toBe(before.date);
  expect((await tuning(page)).steps.length).toBeGreaterThanOrEqual(2);
});

test('a manual thread count skips the speed test', async ({ app, page }) => {
  await app.open({ tuned: false, settings: { threads: 2 } });
  await expect(page.locator('#chipThreads')).toHaveText('2 threads');
  await page.click('#settingsBtn');
  await expect(page.locator('#setThreads')).toHaveValue('2');
  await expect(page.locator('#retuneRow')).toBeHidden();
  await page.click('#settingsClose');
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await app.run(card);
  expect(await tuning(page)).toBeNull();
});

test('switching back to Automatic uses the measured count', async ({ app, page }) => {
  await app.open({ settings: { threads: 1 } });
  await expect(page.locator('#chipThreads')).toHaveText('1 thread');
  await app.settings({ setThreads: 'auto' });
  await expect(page.locator('#chipThreads')).toHaveText(/^Auto · /);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chdman-web-settings')).threads)).toBe('auto');
});

// A game's checksum running during the speed test took a core from it, which could make the test
// settle on fewer threads; the checksum now stops, and starts over once the test is done (audit)
test('a checksum running when the device is measured starts over after the test', async ({ app, page }) => {
  await page.addInitScript(() => {
    window.__crc = { started: 0, stopped: 0 };
    const W = window.Worker;
    window.Worker = class extends W {
      postMessage(m, t) { if (m && m.type === 'crc') { this.crc = true; window.__crc.started++; } return super.postMessage(m, t); }
      terminate() { if (this.crc && !this.done) window.__crc.stopped++; return super.terminate(); }
      constructor(...a) { super(...a); this.addEventListener('message', e => { if (e.data && e.data.type === 'crc') this.done = true; }); }
    };
  });
  await app.open({ testdb: true, debug: { crcSlow: 3000 } });
  await app.add(fixture('ps1-verified').add);
  const card = app.job('verified');
  await expect(card.locator('.ident-check')).toBeVisible(); // the checksum is running
  await page.click('#settingsBtn');
  await page.click('#retune');
  await page.click('#settingsClose');
  await expect.poll(() => page.evaluate(() => window.__crc.stopped)).toBe(1);
  await app.settled(card);
  await expect(card.locator('.ident-name')).toHaveText(fixture('ps1-verified').name);
  expect(await page.evaluate(() => window.__crc.started)).toBe(2);
});
