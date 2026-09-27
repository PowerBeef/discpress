// Basic health of the page. Also runs from file:// and on emulated phones.
import fs from 'node:fs';
import { test, expect, fixture } from '../support/app.js';
import { info, nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

test('loads, starts the engine and switches tabs', async ({ app, page }) => {
  await app.open();
  await expect(page).toHaveTitle('Discpress');
  await expect(page.locator('#chipThreads')).toContainText(/thread/);
  for (const [tab, panel] of [['cli', '#tab-cli'], ['help', '#tab-help'], ['convert', '#tab-convert']]) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await expect(page.locator(panel)).toBeVisible();
    await expect(page.locator(`.tab[data-tab="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
  }
});

test('help lists the database version and every source change', async ({ app, page }) => {
  await app.open();
  await page.click('.tab[data-tab="help"]');
  const help = page.locator('#tab-help');
  await expect(help).toContainText(/version \d{4}\.\d{2}\.\d{2}/);
  await expect(help).toContainText('wasm_helper.cpp (new file)');
  await expect(help).toContainText('src/lib/util/chd.cpp');
});

test('settings are remembered after a reload', async ({ app, page }) => {
  await app.open();
  await app.settings({ setTheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('converts a CD and the result matches desktop chdman', async ({ app }) => {
  const fx = fixture('ps1-single');
  await app.open();
  await app.add(fx.add);
  const card = app.job('twine');
  await app.settled(card);
  await expect(card).toContainText(fx.name);
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${fx.name}.chd`);
  if (!nativeChdman()) return;
  const ref = reference('createcd', 'twine.cue');
  if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
  else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  expect(fs.statSync(out.path).size).toBeGreaterThan(0);
});
