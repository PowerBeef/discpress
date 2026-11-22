// The per-console and per-disc rules (app/quirks.js) and the compression warnings (PROFILES): settings
// that would make a CHD some emulators can't load are left out or warned about, never applied silently.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

async function card(app, key, title) {
  await app.add(fixture(key).add);
  const c = app.job(title);
  await app.settled(c);
  return c;
}

// Kronos, Yabause (Saturn) and jgenesis (Sega CD, PC Engine CD) fail on any metadata tag that isn't a track's,
// so a kept cue sheet makes the CHD unbootable there: those jobs give chdman's own CHD instead
test('with "keep the cue sheet" on, Saturn, Sega CD and PC Engine CD games leave it out and say why', async ({ app }) => {
  await app.open({ settings: { keepCue: true } });
  const sat = await card(app, 'saturn', 'albert odyssey');
  const scd = await card(app, 'segacd', 'ax101');
  const pce = await card(app, 'pcecd-iso', 'pce iso');
  for (const c of [sat, scd, pce]) {
    await expect(c.locator('code.cmd')).not.toContainText('--keepcue');
    await expect(c.locator('.compat-note[data-quirk="keepcue-strict"]')).toBeVisible();
  }
  await expect(sat.locator('[data-quirk="keepcue-strict"]')).toHaveText('Kronos and Yabause reject CHDs that keep their cue sheet, so this one leaves it out (the setting “Keep the cue sheet in CD CHDs” is on).');
  await expect(scd.locator('[data-quirk="keepcue-strict"]')).toContainText('jgenesis rejects CHDs that keep their cue sheet');
  await expect(pce.locator('[data-quirk="keepcue-strict"]')).toContainText('jgenesis rejects CHDs that keep their cue sheet');
  await app.run(sat);
  const [out] = await app.downloads(sat);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', 'albert odyssey.cue')));
});

test('other games keep the cue sheet with the setting, and Saturn games get no note without it', async ({ app }) => {
  await app.open({ settings: { keepCue: true } });
  const mgs = await card(app, 'ps1-multitrack', 'mgs disc1');
  await expect(mgs.locator('code.cmd')).toContainText('--keepcue');
  await expect(mgs.locator('[data-quirk]')).toHaveCount(0);
  await app.settings({ setKeepCue: false });
  const sat = await card(app, 'saturn', 'albert odyssey');
  await expect(sat.locator('[data-quirk="keepcue-strict"]')).toHaveCount(0);
});

// MAME and Flycast look a NAOMI GD-ROM up by its lowercase disc serial in the romset folder
test('a NAOMI GD-ROM is named after its disc serial, and the card says why', async ({ app }) => {
  const fx = fixture('naomi2-gdi');
  await app.open();
  const c = await card(app, 'naomi2-gdi', 'spikers');
  await expect(c.locator('.ident-name')).toHaveText(fx.name);
  await expect(c.locator('[data-quirk="naomi-name"]')).toContainText('MAME and Flycast find this arcade GD-ROM by its disc serial');
  await expect(c.locator('code.cmd')).toContainText('-o gds-0014.chd');
  await app.run(c);
  const [out] = await app.downloads(c);
  expect(out.name).toBe('gds-0014.chd');
});

test('the Zstd preset warns for PS2, Dreamcast, NAOMI and PC-FX games too', async ({ app }) => {
  await app.open();
  const ps2 = await card(app, 'ps2-dvd', 'agent');
  await ps2.locator('details.opts summary').click();
  const field = ps2.locator('label.field', { hasText: 'Compression' });
  await field.locator('select').selectOption('zstd');
  await expect(field).toContainText('AetherSX2 and NetherSX2 can’t read Zstd CHDs of Sony PlayStation 2 games.');
  const dc = await card(app, 'dreamcast-gdi', 'aerowings');
  await dc.locator('details.opts summary').click();
  const dfield = dc.locator('label.field', { hasText: 'Compression' });
  await dfield.locator('select').selectOption('zstd');
  await expect(dfield).toContainText('Redream and Flycast before 2.3 can’t read Zstd CHDs of Sega Dreamcast games.');
});

// older emulators can't open a Zstd CHD of any console: the compatibility mode says so, even for a
// console whose own emulators all read it (PSP)
test('with the compatibility mode on, the Zstd presets warn for every console', async ({ app, page }) => {
  await app.open();
  const psp = await card(app, 'psp-umd', 'frwl');
  await psp.locator('details.opts summary').click();
  const field = psp.locator('label.field', { hasText: 'Compression' });
  await field.locator('select').selectOption('zstd');
  await expect(field).not.toContainText('Older emulators');
  await page.click('#settingsBtn');
  await page.locator('#setCompat').setChecked(true);
  await page.click('#settingsClose');
  await expect(field).toContainText('Older emulators can\u2019t open Zstd CHDs at all (RetroArch 1.21 and earlier, and most emulators from before 2024).');
  await expect(field.locator('.hint')).toHaveAttribute('style', /var\(--warn\)/);
  // the compression itself never changes by itself
  await expect(field.locator('select')).toHaveValue('zstd');
  await field.locator('select').selectOption('default');
  await expect(field).not.toContainText('Older emulators');
});

// the MiSTer preset uses Zstandard too, and MiSTer has no Dreamcast, PS2 or PC-FX core
test('the MiSTer preset warns as the Zstd one does, and where MiSTer has no core', async ({ app }) => {
  await app.open();
  const sat = await card(app, 'saturn', 'albert odyssey');
  await sat.locator('details.opts summary').click();
  const field = sat.locator('label.field', { hasText: 'Compression' });
  await field.locator('select').selectOption('mister');
  await expect(field).toContainText('Kronos, Yabause and Yaba Sanshiro 2 can’t read Zstd CHDs of Sega Saturn games.');
  await expect(field).not.toContainText('no core');
  const dc = await card(app, 'dreamcast-cdr', 'dc cdr');
  await dc.locator('details.opts summary').click();
  const dfield = dc.locator('label.field', { hasText: 'Compression' });
  await dfield.locator('select').selectOption('mister');
  await expect(dfield).toContainText('MiSTer has no core that plays Sega Dreamcast games from CHDs.');
  await expect(dfield.locator('.hint')).toHaveAttribute('style', /var\(--warn\)/); // in the warning colour
});

test('the rules’ notes carry their ids', async ({ app }) => {
  await app.open();
  const ps2 = await card(app, 'ps2-cd-audio', 'ps2 cdda');
  await expect(ps2.locator('.compat-note')).toHaveAttribute('data-quirk', 'ps2-cd-audio');
  const dc = await card(app, 'dreamcast-cdr', 'dc cdr');
  await expect(dc.locator('.compat-note')).toHaveAttribute('data-quirk', 'dc-cd-gaps');
});

// more than 2 notes go into one group ("Emulator notes (n)"); warnings stay in view. An 85-minute Sega
// CD disc (its audio track a sparse file) with a stored and a virtual pregap: three notes, one warning
// a copy of the ninjas Sega CD disc whose audio track lasts this long (a sparse file); its card
async function longScd(app, name, minutes) {
  const dir = path.join(FIXTURES, 'gen', name + ' scd');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'ninjas (Track 1).bin'), path.join(dir, name + ' (Track 1).bin'));
  fs.copyFileSync(path.join(FIXTURES, 'ninjas (Track 3).bin'), path.join(dir, name + ' (Track 3).bin'));
  const audio = path.join(dir, name + ' (Track 2).bin');
  if (!fs.existsSync(audio)) { // (made aside and renamed: another browser's run may read it at once)
    const part = `${audio}.${process.pid}.tmp`, fd = fs.openSync(part, 'w');
    fs.ftruncateSync(fd, minutes * 60 * 75 * 2352);
    fs.closeSync(fd);
    fs.renameSync(part, audio);
  }
  fs.writeFileSync(path.join(dir, name + '.cue'), fs.readFileSync(path.join(FIXTURES, 'ninjas.cue'), 'latin1').replace(/ninjas/g, name), 'latin1');
  await app.open();
  await app.add([name + '.cue', ...[1, 2, 3].map(n => `${name} (Track ${n}).bin`)].map(n => `gen/${name} scd/${n}`));
  const c = app.job(name);
  await app.settled(c);
  return c;
}
test('more than two notes are grouped, warnings stay in view', async ({ app }) => {
  const c = await longScd(app, 'long', 85);
  const group = c.locator('details.compat-notes');
  await expect(group.locator('summary')).toHaveText('Emulator notes (3)');
  expect(await group.locator('[data-quirk]').evaluateAll(ns => ns.map(n => n.dataset.quirk))).toEqual(['segacd-long', 'segacd-index0', 'ares-pregap']);
  await expect(group.locator('[data-quirk="segacd-long"]')).toContainText('this one is 85 minutes long. Genesis Plus GX takes up to 100.');
  await expect(c.locator('.note.ident > [data-quirk="segacd-data-tracks"]')).toBeVisible();
});
// over 100 minutes: Genesis Plus GX doesn't take it either
test('a Sega CD disc of over 100 minutes is too long for Genesis Plus GX too', async ({ app }) => {
  const c = await longScd(app, 'longer', 105);
  await expect(c.locator('[data-quirk="segacd-long"]')).toContainText('this one is 105 minutes long; Genesis Plus GX takes up to 100.');
});

// Facts about particular games (db/facts): LibCrypt games without their .sbi warn; the .sbi (or DuckStation's
// .lsd) is saved with the CHD under its name; one paired with a disc of another console waits for its own
test('a LibCrypt game warns until its .sbi or .lsd is added, which is then saved under the CHD’s name', async ({ app }) => {
  const fx = fixture('ps1-libcrypt-missing');
  await app.open();
  const c = await card(app, 'ps1-libcrypt-missing', 'anstoss');
  await expect(c.locator('[data-quirk="libcrypt-missing"]')).toContainText('This game is protected by LibCrypt');
  for (const sidecar of ['sbi', 'lsd']) {
    const dir = path.join(FIXTURES, 'gen', 'lc-' + sidecar);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'anstoss lc.sbi'), path.join(dir, `anstoss.${sidecar}`));
    if (sidecar === 'lsd') {
      await app.open();
      await app.add(fx.add);
    }
    await app.add([`gen/lc-${sidecar}/anstoss.${sidecar}`]);
    const job = app.job('anstoss');
    await app.settled(job);
    await expect(job.locator('[data-quirk="libcrypt-missing"]')).toHaveCount(0);
    await expect(job.locator('.sbi-note')).toContainText(`anstoss.${sidecar}`);
    await app.run(job);
    const outs = await app.downloads(job);
    expect(outs.map(o => o.name)).toEqual([`${fx.name}.chd`, `${fx.name}.${sidecar}`]);
  }
});

test('an .sbi paired with a disc of another console isn’t saved with its CHD', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen', 'sbi-saturn');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['albert odyssey.cue', 'albert odyssey.bin']) fs.copyFileSync(path.join(FIXTURES, f), path.join(dir, f));
  fs.copyFileSync(path.join(FIXTURES, 'anstoss lc.sbi'), path.join(dir, 'albert odyssey.sbi'));
  await app.open();
  await app.add(['albert odyssey.cue', 'albert odyssey.bin', 'albert odyssey.sbi'].map(n => 'gen/sbi-saturn/' + n));
  const c = app.job('albert odyssey');
  await app.settled(c);
  await expect(c.locator('.sbi-note')).toHaveText('albert odyssey.sbi isn’t saved with this CHD: it holds LibCrypt data for PlayStation discs, and this is a Sega Saturn disc.');
  await app.run(c);
  expect((await app.downloads(c)).map(o => o.name)).toEqual(['Albert Odyssey - Legend of Eldean (USA).chd']);
});

test('a disc of a set says how many discs the set has until all are converted', async ({ app }) => {
  await app.open();
  const one = await card(app, 'saturn-disc1', '3x3 eyes 1');
  await app.run(one);
  await expect(one.locator('[data-quirk="set-incomplete"]')).toHaveText('Disc 1 of 3 of this game: convert the other discs too, and a playlist (.m3u) for them is offered here.');
  const two = await card(app, 'saturn-disc2', '3x3 eyes 2');
  await app.run(two);
  await expect(one.locator('[data-quirk="set-incomplete"]')).toHaveText('The playlist has 2 of this game’s 3 discs: convert the others to add them.');
  await expect(two.locator('[data-quirk="set-incomplete"]')).toHaveCount(0);
});

test('post-identification .sbi pairs by Redump name or PS1 serial, and redumper .subcode pairs with .cue', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen', 'sbi-postid');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['anstoss.cue', 'anstoss.bin']) fs.copyFileSync(path.join(FIXTURES, n), path.join(dir, n));
  // serial-named .sbi (like MiSTer sbi.zip) paired after PS1 serial identification
  fs.copyFileSync(path.join(FIXTURES, 'anstoss lc.sbi'), path.join(dir, 'SLES-02563.sbi'));
  await app.open();
  await app.add(['gen/sbi-postid/SLES-02563.sbi', 'gen/sbi-postid/anstoss.cue', 'gen/sbi-postid/anstoss.bin']);
  const c = app.job('anstoss');
  await app.settled(c);
  await expect(c.locator('[data-quirk="libcrypt-missing"]')).toHaveCount(0);
  await expect(c.locator('.sbi-note')).toContainText('SLES-02563.sbi');

  // redumper interleaved bit-6 Q .subcode paired with a .cue/.bin job generates byte-exact .sbi
  const sdir = path.join(FIXTURES, 'gen', 'subcode-cue');
  fs.mkdirSync(sdir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'lc.img'), path.join(sdir, 'lc.bin'));
  fs.writeFileSync(path.join(sdir, 'lc.cue'), 'FILE "lc.bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n');
  const planar = fs.readFileSync(path.join(FIXTURES, 'lc.sub'));
  const inter = Buffer.alloc(planar.length);
  for (let off = 0; off + 96 <= planar.length; off += 96) {
    for (let bi = 0; bi < 12; bi++) {
      const qByte = planar[off + 12 + bi];
      for (let bit = 0; bit < 8; bit++) {
        if ((qByte >> (7 - bit)) & 1) inter[off + bi * 8 + bit] |= 0x40;
      }
    }
  }
  fs.writeFileSync(path.join(sdir, 'lc.subcode'), inter);
  await app.open();
  await app.add(['gen/subcode-cue/lc.cue', 'gen/subcode-cue/lc.bin', 'gen/subcode-cue/lc.subcode']);
  const sc = app.job('lc');
  await app.settled(sc);
  await expect(sc.locator('.sbi-note')).toContainText('4 protected sectors');
  await app.run(sc);
  const outs = await app.downloads(sc);
  expect(outs.map(o => o.name)).toEqual(['lc.chd', 'lc.sbi']);
  expect(fs.readFileSync(outs[1].path).equals(fs.readFileSync(path.join(FIXTURES, 'lc-expected.sbi')))).toBe(true);
});

test('CloneCD v2 [Entry N] files parse into cues, ImgBurn .mds sidecars are skipped, and .hdi headers are refused', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen', 'p1-compat');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'lc.img'), path.join(dir, 'v2.img'));
  fs.writeFileSync(path.join(dir, 'v2.ccd'),
    '[CloneCD]\r\nVersion=2\r\n[Disc]\r\nTocEntries=4\r\nSessions=1\r\nDataTracksScrambled=0\r\n' +
    '[Session 1]\r\nPreGapMode=2\r\n' +
    '[Entry 0]\r\nSession=1\r\nPoint=0xa0\r\nADR=0x01\r\nControl=0x04\r\nPLBA=0\r\n' +
    '[Entry 1]\r\nSession=1\r\nPoint=0x01\r\nADR=0x01\r\nControl=0x04\r\nPLBA=0\r\n');
  // ImgBurn 4 KB .mds sidecar next to PS2 .iso
  fs.copyFileSync(path.join(FIXTURES, 'agent.iso'), path.join(dir, 'agent.iso'));
  fs.writeFileSync(path.join(dir, 'agent.mds'), Buffer.alloc(4096, 0x4D));
  // Anex86 .hdi with 4,096-byte header
  fs.writeFileSync(path.join(dir, 'pc98.hdi'), Buffer.alloc(8192, 0));

  await app.open();
  await app.add(['gen/p1-compat/v2.ccd', 'gen/p1-compat/v2.img', 'gen/p1-compat/agent.iso', 'gen/p1-compat/agent.mds', 'gen/p1-compat/pc98.hdi']);
  await expect(app.jobs()).toHaveCount(3); // agent.mds ignored cleanly!
  const v2 = app.job('v2');
  await app.settled(v2);
  await expect(v2.locator('.sysbadge')).toHaveText('PS1');
  await expect(v2.locator('code.cmd')).toContainText('chdman createcd');
  const hdi = app.job('pc98');
  await expect(hdi.locator('.note.err')).toContainText('4,096-byte header');
});

test('multi-disc PS2 and PSP games show emulator disc-swap guidance instead of .m3u playlists', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen', 'no-m3u');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [1, 2]) fs.copyFileSync(path.join(FIXTURES, 'umd.iso'), path.join(dir, `Hero (USA) (Disc ${n}).iso`));
  await app.open({ settings: { rename: false } });
  await app.add(['gen/no-m3u/Hero (USA) (Disc 1).iso', 'gen/no-m3u/Hero (USA) (Disc 2).iso']);
  const d1 = app.job('Hero (USA) (Disc 1)'), d2 = app.job('Hero (USA) (Disc 2)');
  await app.settled(d1);
  await app.settled(d2);
  await app.run(d1);
  await app.run(d2);
  await expect(d1.locator('.playlist')).toHaveCount(0);
  await expect(d1.locator('.set-note')).toContainText('PPSSPP does not use .m3u playlists');
});
