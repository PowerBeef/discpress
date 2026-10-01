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
