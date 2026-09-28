// Results that outlive a reload (Recovery in app/ui.js): iOS reloads a page it stopped to free memory,
// and a finished CHD that wasn't saved yet used to go with the old visit's storage.
import { test, expect, fixture } from '../support/app.js';
import { reference, sameVersion, sha1File, nativeChdman } from '../support/native.js';

test('a finished but unsaved result is listed after a reload, and can be saved or deleted', async ({ app, page }) => {
  await app.open();
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  const earlier = page.locator('#earlier');
  await expect(earlier).toBeVisible();
  await expect(earlier).toContainText('From your last visit');
  const row = earlier.locator('.out');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('.chd');
  const [dl] = await Promise.all([page.waitForEvent('download'), row.locator('button', { hasText: 'Download' }).click()]);
  const file = test.info().outputPath(dl.suggestedFilename());
  await dl.saveAs(file);
  if (nativeChdman() && sameVersion()) expect(sha1File(file)).toBe(sha1File(reference('createcd', 'twine.cue')));
  // saved, so the next visit doesn't list it again
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await expect(page.locator('#earlier')).toBeHidden();
});

test('an unsaved result can be deleted from the list', async ({ app, page }) => {
  await app.open();
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await page.locator('#earlier .out button', { hasText: 'Delete' }).click();
  await expect(page.locator('#earlier')).toBeHidden();
  const left = await page.evaluate(async () => {
    const work = await (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-work');
    const names = [];
    for await (const k of work.keys()) names.push(k);
    return names.length;
  });
  expect(left).toBe(0); // the earlier visit's folder is gone (this visit makes one only when a job runs)
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await expect(page.locator('#earlier')).toBeHidden();
});

test('a conversion stopped by a reload is reported', async ({ app, page }) => {
  await app.open({ settings: { threads: 1 } });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'running');
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  const note = page.locator('#earlier .note.warn');
  await expect(note).toContainText('A conversion didn’t finish');
  await expect(note).toContainText('Add its files again to start over.');
  await note.locator('button', { hasText: 'OK' }).click();
  await expect(page.locator('#earlier')).toBeHidden();
});
