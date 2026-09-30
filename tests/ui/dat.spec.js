// DAT files (Redump, No-Intro): every track of a disc checked against them, and verified discs named
// after them. They are kept in the browser.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { nativeChdman, reference } from '../support/native.js';
import { makeZip } from '../support/zip.js';

const dir = path.join(FIXTURES, 'gen', 'dat');
const rom = (name, file) => {
  const b = fs.readFileSync(path.join(FIXTURES, file));
  return { name, size: b.length, crc: zlib.crc32(b).toString(16).padStart(8, '0') };
};
function xmlDat(name, games) {
  return '<?xml version="1.0"?>\n<!DOCTYPE datafile PUBLIC "-//Logiqx//DTD ROM Management Datafile//EN" "http://www.logiqx.com/dtds/datafile.dtd">\n' +
    `<datafile>\n\t<header>\n\t\t<name>${name}</name>\n\t\t<description>${name} - Datfile</description>\n\t\t<version>2026-09-30</version>\n\t</header>\n` +
    games.map(g => `\t<game name="${g.name}">\n\t\t<category>Games</category>\n\t\t<description>${g.name}</description>\n` +
      g.roms.map(r => `\t\t<rom name="${r.name}" size="${r.size}" crc="${r.crc}" md5="00" sha1="00"/>\n`).join('') + '\t</game>\n').join('') + '</datafile>\n';
}
function writeDat(file, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  return 'gen/dat/' + file;
}
const MGS = 'Metal Gear Solid (DAT Test) (Disc 1)';
const mgsRoms = (track2 = 'mgs disc1 (Track 2).bin') => [
  rom(MGS + '.cue', 'mgs disc1.cue'), rom(MGS + ' (Track 1).bin', 'mgs disc1 (Track 1).bin'), rom(MGS + ' (Track 2).bin', track2)];

test('every track matching a DAT game verifies the disc and names it after the game', async ({ app, page }) => {
  const dat = writeDat('test.dat', xmlDat('Sony - PlayStation (Test)', [{ name: MGS, roms: mgsRoms() }, { name: 'Other Game', roms: [rom('Other.bin', 'twine.bin')] }]));
  await app.open();
  await app.add([dat]);
  await expect(page.locator('#toasts')).toContainText('Added “Sony - PlayStation (Test)” (2 games)');
  await expect(app.jobs()).toHaveCount(0);
  await app.add(fixture('ps1-multitrack').add);
  const card = app.job('mgs disc1');
  await app.settled(card);
  await expect(card.locator('.dat-note')).toHaveText(`✓ Verified with your DAT file. All 2 tracks match “${MGS}” in Sony - PlayStation (Test).`);
  await expect(card.locator('h3')).toHaveText(MGS);
  await expect(card.locator('.ident-how')).toHaveText('✓ Every track matches your DAT file');
  await app.run(card);
  const outs = await app.downloads(card);
  expect(outs.map(o => o.name)).toEqual([MGS + '.chd']);
  // kept: after a reload, Settings lists it, and removing it forgets it
  await page.reload();
  await expect(page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
  await page.click('#settingsBtn');
  await expect(page.locator('#datList li')).toHaveCount(1);
  await expect(page.locator('#datList li')).toContainText('Sony - PlayStation (Test)');
  await expect(page.locator('#datList li')).toContainText('2 games');
  await page.locator('#datList button[aria-label="Remove Sony - PlayStation (Test)"]').click();
  await expect(page.locator('#datList li')).toHaveCount(0);
  await expect(page.locator('#datEmpty')).toBeVisible();
});

test('a disc with a track that differs partly matches; one loaded later is checked then', async ({ app }) => {
  await app.open();
  await app.add(fixture('ps1-multitrack').add);
  const card = app.job('mgs disc1');
  await app.settled(card);
  await expect(card.locator('.dat-note')).toHaveCount(0); // no DAT files yet
  // a clrmamepro DAT, in a zip, whose track 2 is another file
  const r = mgsRoms('twine.bin');
  const cmp = 'clrmamepro (\n\tname "Sony - PlayStation (CMP)"\n\tversion 1\n)\n\ngame (\n\tname "' + MGS + '"\n' +
    r.map(x => `\trom ( name "${x.name}" size ${x.size} crc ${x.crc} md5 00 sha1 00 )\n`).join('') + ')\n';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cmp.zip'), makeZip([{ name: 'Sony - PlayStation (CMP).dat', data: Buffer.from(cmp) }]));
  await app.add(['gen/dat/cmp.zip']);
  await expect(card.locator('.dat-note')).toHaveText(`Partly matches your DAT file. 1 of 2 tracks match “${MGS}” in Sony - PlayStation (CMP). Not matched: ${MGS} (Track 2).bin.`);
  await expect(card.locator('h3')).not.toHaveText(MGS); // not verified: not named after it
});

test('a disc in no DAT file says so; files that aren’t DATs are ignored', async ({ app, page }) => {
  const dat = writeDat('other.dat', xmlDat('Other (Test)', [{ name: 'Other Game', roms: [rom('Other.bin', 'twine.bin')] }]));
  const notDat = writeDat('notes.xml', '<?xml version="1.0"?><notes><note>hi</note></notes>');
  await app.open();
  await app.add([dat, notDat]);
  await expect(page.locator('#toasts')).toContainText('Added “Other (Test)”');
  await app.add(['agent.iso']);
  const card = app.job('agent');
  await app.settled(card);
  await expect(card.locator('.dat-note')).toHaveText('Not in your DAT files.');
});

test('a CHD is checked against the DAT files after Verify, every track', async ({ app }) => {
  test.skip(!nativeChdman(), 'needs native chdman to make the CHD');
  const chd = reference('createcd', 'twine.cue');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(chd, path.join(dir, 'twine.chd'));
  const dat = writeDat('twine.dat', xmlDat('Twine (Test)', [{ name: 'Twine (DAT Test)', roms: [rom('Twine (DAT Test).cue', 'twine.cue'), rom('Twine (DAT Test).bin', 'twine.bin')] }]));
  await app.open();
  await app.add([dat, 'gen/dat/twine.chd']);
  const card = app.job('twine');
  await app.settled(card);
  await card.locator('.seg button', { hasText: 'Verify' }).click();
  await app.run(card);
  await expect(card.locator('.dat-note')).toContainText('✓ Verified with your DAT file. It matches “Twine (DAT Test)” in Twine (Test).');
});
