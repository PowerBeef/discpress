// Results that outlive a reload (Recovery in app/ui.js): iOS reloads a page it stopped to free memory,
// and a finished CHD that wasn't saved yet used to go with the old visit's storage. Where results can
// only live in memory (a page opened as a file in Chrome: file-url project), a reload loses them, and the
// next visit says which, and how to keep them.
import { test, expect, fixture } from '../support/app.js';
import { reference, sameVersion, sha1File, nativeChdman } from '../support/native.js';

// the tests of results kept in the browser's storage, which a page opened as a file doesn't get in Chrome
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name === 'file-url' && !/memory/.test(testInfo.title), 'no private storage for file:// pages');
});

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

test('where results live in memory, a reload says which were lost and how to keep them', async ({ app, page }, testInfo) => {
  // a page opened as a file in Chrome gets no private storage; over http, take it away
  await app.open(testInfo.project.name === 'file-url' ? {} : { noOpfs: true });
  await expect(page.locator('#chipStore')).toHaveText(/Results in memory/);
  const tip = page.locator('#memTip');
  await expect(tip).toContainText('closing or reloading the page loses those not saved yet');
  await expect(tip).toContainText('have results written straight into a folder, or use Discpress online at powerbeef.github.io/discpress');
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  const name = (await card.locator('.result .out .nm').innerText()).split('\n')[0].trim();
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  const note = page.locator('#earlier .note.warn');
  await expect(note).toContainText('A result was lost when the page was closed or reloaded: \u201c' + name + '\u201d');
  await expect(note).toContainText('use Discpress online at powerbeef.github.io/discpress');
  await expect(page.locator('#earlier')).not.toContainText('From your last visit'); // nothing left to save
  await note.locator('button', { hasText: 'OK' }).click();
  await expect(page.locator('#earlier')).toBeHidden();
  // reported once
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await expect(page.locator('#earlier')).toBeHidden();
  // a result that was saved isn't reported
  await app.add(fixture('ps1-single').add);
  const again = app.job('twine');
  await app.settled(again);
  await app.run(again);
  await app.downloads(again);
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await expect(page.locator('#earlier')).toBeHidden();
});

test('where results live in memory, a conversion stopped by a reload is reported', async ({ app, page }, testInfo) => {
  await app.open({ settings: { threads: 1 }, ...(testInfo.project.name === 'file-url' ? {} : { noOpfs: true }) });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'running');
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await expect(page.locator('#earlier .note.warn').first()).toContainText('A conversion didn’t finish');
});
