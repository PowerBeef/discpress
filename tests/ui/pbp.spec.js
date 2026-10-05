// PS1 EBOOT.PBP files (popstation's format): each disc converts from the image it packs, with a cue
// sheet made from its TOC. (`create: ps1-pbp` and `create: ps1-pbp-eboot` in convert.spec.js check the
// conversion of one-disc files against native chdman.)
import { test, expect, fixture } from '../support/app.js';
import { nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

test('a PBP with two discs makes a card for each, and each converts', async ({ app }) => {
  const fx = fixture('ps1-pbp-discs');
  await app.open();
  await app.add(fx.add);
  await expect(app.jobs()).toHaveCount(2);
  const cards = [app.job('two discs (Disc 1)'), app.job('two discs (Disc 2)')];
  for (let i = 0; i < 2; i++) {
    await app.settled(cards[i]);
    await expect(cards[i].locator('.sub')).toContainText('PS1 PBP file · ' + (i ? '1 track' : '2 tracks'));
    await app.run(cards[i]);
    const [out] = await app.downloads(cards[i]);
    if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', fx.refs[i])));
  }
  await expect(cards[1].locator('.sysbadge')).toHaveText('PS1');
});

test('PBP files that can’t be converted get a card that says why', async ({ app }) => {
  const fx = fixture('ps1-pbp-bad');
  await app.open();
  await app.add(fx.add);
  await expect(app.jobs()).toHaveCount(2);
  await expect(app.job('store').locator('.note.err')).toContainText('This PBP file is encrypted (a PlayStation Store download)');
  await expect(app.job('homebrew').locator('.note.err')).toContainText('This PBP file holds a PSP program, not a PlayStation disc.');
  for (const t of ['store', 'homebrew']) await expect(app.job(t).locator('.job-foot')).toContainText('Can’t convert');
});

// Removing one disc's card forgot the PBP both discs come from, so adding it again duplicated the other
// disc (audit 2026-10-05, L5): it brings back only the disc removed
test('a PBP added again after one of its discs was removed brings back only that disc', async ({ app, page }) => {
  const fx = fixture('ps1-pbp-discs');
  await app.open();
  await app.add(fx.add);
  await expect(app.jobs()).toHaveCount(2);
  const one = app.job('two discs (Disc 1)');
  await app.settled(one);
  await one.locator('.job-head button[aria-label^="Remove "]').click();
  await expect(app.jobs()).toHaveCount(1);
  await app.add(fx.add);
  await expect(app.jobs()).toHaveCount(2);
  await expect(app.job('two discs (Disc 1)')).toHaveCount(1);
  await expect(app.job('two discs (Disc 2)')).toHaveCount(1);
  // and again, with both listed: nothing new
  await app.add(fx.add);
  await expect(page.locator('#toasts')).toContainText('Those files are already in the list.');
  await expect(app.jobs()).toHaveCount(2);
});
