// Settings picked from the identified console (PROFILES in app/ui.js): the CHD type and hunk size,
// the emulators that can't read a compression, and the consoles whose emulators don't load CHDs.
// And the files emulators want next to the CHDs: a PS1 disc's .sbi, a multi-disc game's .m3u.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

test('an Xbox 360 dump is recognized behind its video partition, with a note that emulators need the ISO', async ({ app }) => {
  await app.open();
  await app.add(['xgd3.iso']);
  const card = app.job('xgd3');
  await app.settled(card);
  await expect(card.locator('.sysbadge')).toHaveText('XBOX');
  await expect(card.locator('.ident-note')).toHaveText('Xbox emulators (xemu, Xenia) do not load CHDs. They use the ISO itself.');
  // not settled by the system: the type stays a choice up front
  await expect(card.locator('.row', { hasText: 'Create as' })).toBeVisible();
  await expect(card.locator('code.cmd')).toContainText('chdman createdvd');
});

test('a PS3 disc is recognized, with its serial, and a note that RPCS3 needs the ISO', async ({ app }) => {
  await app.open();
  await app.add(['ps3game.iso']);
  const card = app.job('ps3game');
  await app.settled(card);
  await expect(card.locator('.sysbadge')).toHaveText('PS3');
  await expect(card.locator('.ident-head')).toContainText('BLUS-30001');
  await expect(card.locator('.ident-note')).toContainText('RPCS3 does not load CHDs');
});

test('PSP games become DVD CHDs with 2,048-byte hunks, and the card says why', async ({ app }) => {
  await app.open();
  await app.add(['frwl.iso']);
  const card = app.job('frwl');
  await app.settled(card);
  await expect(card.locator('code.cmd')).toContainText('-hs 2048');
  await card.locator('details.opts summary').click();
  await expect(card.locator('label.field', { hasText: 'Create as' })).toContainText('Sony PlayStation Portable games become DVD CHDs with 2,048-byte hunks, as PPSSPP recommends.');
});

test('the Zstd preset warns where the system’s emulators can’t read it', async ({ app }) => {
  await app.open();
  await app.add(['albert odyssey.cue', 'albert odyssey.bin']);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('details.opts summary').click();
  const field = card.locator('label.field', { hasText: 'Compression' });
  await expect(field).not.toContainText('Kronos');
  await field.locator('select').selectOption('zstd');
  await expect(field).toContainText('Kronos and Yabause can’t read Zstd CHDs of Sega Saturn games.');
});

test('PS2 DVD games become CD CHDs when Settings asks for AetherSX2 and NetherSX2, and follow a change', async ({ app, page }) => {
  await app.open({ settings: { ps2dvd: 'cd' } });
  await app.add(['agent.iso']);
  const card = app.job('agent');
  await app.settled(card);
  await expect(card.locator('code.cmd')).toContainText('chdman createcd');
  await card.locator('details.opts summary').click();
  await expect(card.locator('label.field', { hasText: 'Create as' })).toContainText('It becomes a CD CHD, for AetherSX2 and NetherSX2 (Settings).');
  await page.click('#settingsBtn');
  await page.locator('#setPs2Dvd').selectOption('dvd');
  await page.click('#settingsClose');
  await expect(card.locator('code.cmd')).toContainText('chdman createdvd');
  await page.click('#settingsBtn');
  await page.locator('#setPs2Dvd').selectOption('cd');
  await page.click('#settingsClose');
  await expect(card.locator('code.cmd')).toContainText('chdman createcd');
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', 'agent.iso')));
});

test('a PS1 disc\u2019s .sbi file is saved with its CHD, under the CHD\u2019s name', async ({ app }) => {
  const fx = fixture('ps1-single');
  const sbi = Buffer.concat([Buffer.from('SBI\0'), Buffer.from([0x03, 0x08, 0x05, 0x01]), Buffer.alloc(10, 0x41)]);
  const dir = path.join(FIXTURES, 'gen', 'sbi');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fx.add) fs.copyFileSync(path.join(FIXTURES, n), path.join(dir, n));
  fs.writeFileSync(path.join(dir, 'twine.sbi'), sbi);
  await app.open();
  await app.add(['gen/sbi/twine.sbi', ...fx.add.map(n => 'gen/sbi/' + n)]);
  await expect(app.jobs()).toHaveCount(1);
  const card = app.job('twine');
  await app.settled(card);
  await expect(card.locator('.sbi-note')).toContainText('twine.sbi');
  await app.run(card);
  const outs = await app.downloads(card);
  expect(outs.map(o => o.name)).toEqual([`${fx.name}.chd`, `${fx.name}.sbi`]);
  expect(fs.readFileSync(outs[1].path).equals(sbi)).toBe(true);
});

test('a game on several discs gets an .m3u playlist of its CHDs', async ({ app, page }) => {
  const dir = path.join(FIXTURES, 'gen', 'multi');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [1, 2]) fs.copyFileSync(path.join(FIXTURES, 'homebrew.iso'), path.join(dir, `Game (USA) (Disc ${n}).iso`));
  await app.open();
  await app.add(['gen/multi/Game (USA) (Disc 2).iso', 'gen/multi/Game (USA) (Disc 1).iso']);
  const one = app.job('Game (USA) (Disc 1)'), two = app.job('Game (USA) (Disc 2)');
  await app.settled(one);
  await app.settled(two);
  await app.run(one);
  await expect(one.locator('.playlist')).toHaveCount(0); // one disc isn't a set yet
  await app.run(two);
  await expect(one.locator('.playlist')).toContainText('A game on 2 discs.');
  await expect(two.locator('.playlist')).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent('download'), one.locator('.playlist button').click()]);
  expect(dl.suggestedFilename()).toBe('Game (USA).m3u');
  const p = test.info().outputPath('Game (USA).m3u');
  await dl.saveAs(p);
  expect(fs.readFileSync(p, 'utf8')).toBe('Game (USA) (Disc 1).chd\nGame (USA) (Disc 2).chd\n');
});

test('discs of the same name from different consoles don\u2019t share a playlist', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen', 'multi2');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'homebrew.iso'), path.join(dir, 'Game (USA) (Disc 1).iso')); // a data disc
  fs.copyFileSync(path.join(FIXTURES, 'tnd.iso'), path.join(dir, 'Game (USA) (Disc 2).iso')); // a PS1 disc
  await app.open({ settings: { rename: false } });
  await app.add(['gen/multi2/Game (USA) (Disc 1).iso', 'gen/multi2/Game (USA) (Disc 2).iso']);
  const one = app.job('Game (USA) (Disc 1)'), two = app.job('Game (USA) (Disc 2)');
  await app.settled(one);
  await app.settled(two);
  await expect(two.locator('.sysbadge')).toHaveText('PS1');
  await app.run(one);
  await app.run(two);
  await expect(two.locator('.result .out')).toContainText('Game (USA) (Disc 2).chd');
  await expect(one.locator('.playlist')).toHaveCount(0);
  await expect(two.locator('.playlist')).toHaveCount(0);
});

test('a PS2 game on CD with music tracks: the card says PCSX2 plays only the first track', async ({ app }) => {
  await app.open();
  await app.add(fixture('ps2-cd-audio').add);
  const card = app.job('ps2 cdda');
  await app.settled(card);
  await expect(card.locator('.sysbadge')).toHaveText('PS2');
  await expect(card.locator('.compat-note')).toHaveText('PCSX2 plays only the first track of a CD CHD, so this game’s music tracks won’t play in it. They are kept in the CHD.');
  await expect(card.locator('code.cmd')).toContainText('chdman createcd');
});

test('a CD-based Dreamcast disc with pregaps: the card says older Flycast rejects its CHD; a GD-ROM gets no such note', async ({ app }) => {
  await app.open();
  await app.add([...fixture('dreamcast-cdr').add, ...fixture('dreamcast-gdi').add]);
  const cdr = app.job('dc cdr'), gd = app.job('aerowings');
  await app.settled(cdr);
  await app.settled(gd);
  await expect(cdr.locator('.sysbadge')).toHaveText('DC');
  await expect(cdr.locator('.compat-note')).toContainText('Flycast 2.7 and earlier can’t load CD-based Dreamcast CHDs whose tracks have pregaps');
  await expect(gd.locator('.compat-note')).toHaveCount(0);
  // a PS1 disc with a music track needs no note either
  await app.add(fixture('ps1-multitrack').add);
  const mgs = app.job('mgs disc1');
  await app.settled(mgs);
  await expect(mgs.locator('.compat-note')).toHaveCount(0);
});

test('the MiSTer preset makes Zstd + FLAC CD CHDs with 4-sector hunks, as chdman does with those options', async ({ app }) => {
  const fx = fixture('ps1-single');
  await app.open();
  await app.add(fx.add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('details.opts summary').click();
  const field = card.locator('label.field', { hasText: 'Compression' });
  await field.locator('select').selectOption('mister');
  await expect(field).toContainText('MiSTer');
  await expect(card.locator('code.cmd')).toContainText('-c cdzs,cdfl -hs 9792');
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', fx.add[0], ['-c', 'cdzs,cdfl', '-hs', '9792'])));
});

test('PS1 games warn that older SwanStation can’t read the Zstd preset', async ({ app }) => {
  await app.open();
  await app.add(fixture('ps1-single').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('details.opts summary').click();
  const field = card.locator('label.field', { hasText: 'Compression' });
  await field.locator('select').selectOption('zstd');
  await expect(field).toContainText('SwanStation (before March 2026) can’t read Zstd CHDs of Sony PlayStation games.');
});
