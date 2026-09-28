// How the app copes with incomplete, odd or repeated input, and with cancelling.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { extract, info, nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

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

// chdman 0.289 never finishes on a descriptor it reads as having no tracks (and writes outside its
// track table for a track number outside 1-99); the app refuses those and says why instead
for (const [name, text, why] of [
  ['no tracks', 'FILE "lone.bin" BINARY\r\n', 'This CUE file lists no tracks.'],
  ['track zero', 'FILE "lone.bin" BINARY\r\n  TRACK 00 MODE2/2352\r\n    INDEX 01 00:00:00\r\n', 'Track numbers go from 01 to 99'],
  ['no length', 'CD_ROM_XA\n\nTRACK MODE2_RAW\nDATAFILE "lone.bin"\n', 'chdman can\u2019t tell the length of track 1'],
]) {
  test(`a descriptor chdman can't convert is refused: ${name}`, async ({ app }) => {
    const file = name + (text.startsWith('CD_ROM') ? '.toc' : '.cue');
    fs.writeFileSync(path.join(FIXTURES, file), text);
    await app.open();
    await app.add([file, 'lone.bin']);
    await expect(app.jobs()).toHaveCount(1);
    const card = app.job(name);
    await app.waitState(card, 'error');
    await expect(card.locator('.note.err')).toContainText(why);
    await expect(card.locator('.job-foot')).toContainText('Can\u2019t convert');
    await expect(card.locator('.job-foot button')).toHaveCount(0);
    await expect(card.locator('code.cmd')).toBeEmpty();
  });
}

// a CloneCD .ccd becomes a cue sheet for its .img (convert.spec: ps1-clonecd); it waits for the .img,
// and what a cue sheet can't describe is refused
test('a CloneCD image waits for its .img', async ({ app }) => {
  await app.open();
  await app.add(['mgs ccd.ccd', 'mgs ccd.sub']);
  const card = app.job('mgs ccd');
  await app.waitState(card, 'blocked');
  await expect(card.locator('.note.warn')).toContainText('Missing 1 file listed in mgs ccd.ccd:');
  await expect(card.locator('.note.warn li')).toHaveText(['mgs ccd.img']);
  await app.add(['mgs ccd.img']);
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('CloneCD image');
  await expect(card.locator('code.cmd')).toContainText('chdman createcd -i "mgs ccd.cue"');
});

for (const [name, text, why] of [
  ['two sessions', '[CloneCD]\r\nVersion=3\r\n[Disc]\r\nSessions=2\r\n[TRACK 1]\r\nMODE=1\r\nINDEX 1=0\r\n', 'only single-session images can be converted'],
  ['no track list', '[CloneCD]\r\nVersion=2\r\n[Disc]\r\nSessions=1\r\n', 'lists no tracks'],
  ['not clonecd', '[Settings]\r\nfoo=1\r\n', 'not a CloneCD control file'],
]) {
  test(`a CloneCD image that can't be converted is refused: ${name}`, async ({ app }) => {
    fs.writeFileSync(path.join(FIXTURES, name + '.ccd'), text);
    await app.open();
    await app.add([name + '.ccd']);
    const card = app.job(name);
    await app.waitState(card, 'error');
    await expect(card.locator('.note.err')).toContainText(why);
    await expect(card.locator('.job-foot')).toContainText('Can\u2019t convert');
  });
}

// chdman reads a cue's bytes as they are; the app hands it a UTF-8 copy with LF line ends when needed
for (const [how, key, bin, bytes] of [
  ['in UTF-16', 'utf16', 'twine.bin', s => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])],
  ['in Windows-1252', 'cp1252', 'twin\u00e9.bin', s => Buffer.from(s, 'latin1')],
  ['with classic Mac OS line ends (CR)', 'cr', 'twine.bin', s => Buffer.from(s.replace(/\r\n/g, '\r'))],
]) {
  test(`a cue sheet ${how} converts like a plain one`, async ({ app, page }) => {
    const cue = `twine ${key}.cue`;
    fs.writeFileSync(path.join(FIXTURES, cue), bytes(`FILE "${bin}" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n`));
    await app.open();
    // files go in as buffers: a file chooser may drop paths with non-ASCII names when the locale isn't UTF-8
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#addFiles')]);
    await chooser.setFiles([[cue, cue], [bin, 'twine.bin']].map(([name, src]) =>
      ({ name, mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(FIXTURES, src)) })));
    const card = app.job(`twine ${key}`);
    await app.settled(card);
    await expect(card.locator('.sub')).toContainText('CUE + 1 track file');
    await app.run(card);
    const [out] = await app.downloads(card);
    if (!nativeChdman()) return;
    const ref = reference('createcd', 'twine.cue');
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  });
}

test('a binary .toc beside a cue sheet is skipped', async ({ app, page }) => {
  // some disc dumping tools save the drive's raw table of contents as a binary <name>.toc beside the .cue
  fs.writeFileSync(path.join(FIXTURES, 'twine.toc'), Buffer.from('0012010100140100000000000014aa0000002e10', 'hex'));
  await app.open();
  await app.add(['twine.cue', 'twine.toc', 'twine.bin']);
  await expect(page.locator('#toasts')).toContainText('ignored 1 file (twine.toc)');
  await expect(app.jobs()).toHaveCount(1);
  await app.settled(app.job('twine'));
});

test('a TOC with one file per track, as chdman writes it, keeps every track', async ({ app }) => {
  test.skip(!nativeChdman(), 'needs native chdman to write the TOC');
  // chdman extractcd -sb writes `DATAFILE "file" length` for each track, and chdman createcd reads a
  // lone length after track 1 as an offset: the later tracks came out empty
  const original = reference('createcd', 'mgs disc1.cue');
  const x = extract('extractcd', original, 'mgs split.toc', ['-sb']);
  for (const f of x.files) fs.copyFileSync(path.join(x.dir, f), path.join(FIXTURES, f));
  const toc = fs.readFileSync(path.join(FIXTURES, 'mgs split.toc'), 'utf8');
  fs.writeFileSync(path.join(FIXTURES, 'mgs split-ref.toc'), toc.replace(/^(DATAFILE "[^"]*" )(\d)/gm, '$1#0 $2'));
  await app.open();
  await app.add(x.files);
  const card = app.job('mgs split');
  await app.settled(card);
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(info(out.path).dataSha1).toBe(info(original).dataSha1);
  if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', 'mgs split-ref.toc')));
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
