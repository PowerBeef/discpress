// How the app copes with incomplete, odd or repeated input, and with cancelling.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';

test('a cue with a missing track waits for it, then continues', async ({ app }) => {
  await app.open();
  await app.add(['mgs disc1.cue', 'mgs disc1 (Track 1).bin']);
  const card = app.job('mgs disc1');
  await app.waitState(card, 'blocked');
  await expect(card.locator('.note.warn')).toContainText('Missing 1 file listed in mgs disc1.cue:');
  await expect(card.locator('.note.warn li')).toHaveText(['mgs disc1 (Track 2).bin']);
  await app.add(['mgs disc1 (Track 2).bin']);
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('CUE + 2 track files');
  await app.run(card);
});

test('a lone later track asks for its cue', async ({ app }) => {
  await app.open();
  await app.add(['mgs disc1 (Track 2).bin']);
  const card = app.jobs().first();
  await app.waitState(card, 'blocked');
  await expect(card).toContainText('This is one track of a multi-track disc.');
  // adding the cue later takes the track over instead of making a second job
  await app.add(['mgs disc1.cue', 'mgs disc1 (Track 1).bin']);
  await expect(app.jobs()).toHaveCount(1);
  await app.settled(app.job('mgs disc1'));
});

test('adding the same files twice is ignored', async ({ app, page }) => {
  await app.open();
  await app.add(fixture('ps1-single').add);
  await app.settled(app.job('twine'));
  await app.add(fixture('ps1-single').add);
  await expect(page.locator('#toasts')).toContainText('Those files are already in the list.');
  await expect(app.jobs()).toHaveCount(1);
});

test('files that cannot be converted are skipped with a message', async ({ app, page }) => {
  const txt = path.join(FIXTURES, 'readme.txt');
  fs.writeFileSync(txt, 'not a disc');
  await app.open();
  await app.add(['readme.txt']);
  await expect(page.locator('#toasts')).toContainText('Nothing to convert in 1 file.');
  await expect(app.jobs()).toHaveCount(0);
});

test('a truncated image gets a warning', async ({ app }) => {
  const src = fs.readFileSync(path.join(FIXTURES, 'lone.bin'));
  fs.writeFileSync(path.join(FIXTURES, 'truncated.bin'), src.subarray(0, src.length - 1000));
  await app.open();
  await app.add(['truncated.bin']);
  const card = app.jobs().first();
  await app.settled(card);
  await expect(card).toContainText('The file size is not a multiple of 2,352 bytes');
});

test('an ISO can be switched between DVD and CD', async ({ app }) => {
  await app.open();
  await app.add(fixture('homebrew-iso').add);
  const card = app.jobs().first();
  await app.settled(card);
  await expect(card.locator('code.cmd')).toContainText('chdman createdvd');
  await card.locator('.seg button', { hasText: 'CD CHD' }).click();
  await expect(card.locator('code.cmd')).toContainText('chdman createcd');
  await app.run(card);
});

test('a running job can be cancelled and run again', async ({ app, page }) => {
  await app.open({ settings: { threads: 1 } });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'running');
  await card.locator('.job-foot button.danger', { hasText: 'Cancel' }).click();
  await app.waitState(card, 'canceled');
  await expect(card).toContainText('Canceled.');
  await card.locator('.job-foot button', { hasText: 'Try again' }).click();
  await app.waitState(card, 'ready');
  await app.run(card);
  await expect(page.locator('#dock')).toBeVisible();
});

test('removing a job forgets its files', async ({ app }) => {
  await app.open();
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await card.locator('.job-head button[aria-label="Remove"]').click();
  await expect(app.jobs()).toHaveCount(0);
  await app.add(fixture('ps1-single').add); // accepted again, not "already in the list"
  await expect(app.jobs()).toHaveCount(1);
});
