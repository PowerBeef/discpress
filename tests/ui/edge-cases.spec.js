// How the app copes with incomplete, odd or repeated input, and with cancelling.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { engineReference, extract, info, nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

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

// chdman 0.289 never finished on a TOC without lengths; the engine reads cdrdao's grammar, where a
// missing length is the rest of the file
test('a TOC without lengths converts the whole file', async ({ app }) => {
  fs.writeFileSync(path.join(FIXTURES, 'no length.toc'), 'CD_ROM_XA\n\nTRACK MODE2_RAW\nDATAFILE "lone.bin"\n');
  await app.open();
  await app.add(['no length.toc', 'lone.bin']);
  const card = app.job('no length');
  await app.settled(card);
  await expect(card.locator('.note.ident')).toContainText('SLUS-00975');
  await app.run(card);
  const [out] = await app.downloads(card);
  const ref = engineReference('createcd', 'no length.toc');
  if (ref) expect(sha1File(out.path)).toBe(sha1File(ref));
});

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
  await expect(card.locator('.note.ident')).toContainText('SLUS-00594'); // the console is read from the TOC's tracks
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

test('an identified PSP game is a DVD CHD, and the other type is only in Options', async ({ app }) => {
  await app.open();
  await app.add(fixture('psp-umd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await expect(card.locator('.note.ident')).toContainText('ULUS-10080');
  await expect(card.locator('.seg button', { hasText: 'CD CHD' })).toHaveCount(0);
  await expect(card.locator('code.cmd')).toContainText('chdman createdvd');
  await expect(card.locator('code.cmd')).toContainText('-hs 2048');
  await card.locator('details.opts summary').click();
  const field = card.locator('label.field', { hasText: 'Create as' });
  await expect(field.locator('select')).toHaveValue('dvd');
  await expect(field).toContainText('Sony PlayStation Portable games become DVD CHDs with 2,048-byte hunks, as PPSSPP recommends.');
});

// compressed ISOs (convert.spec: psp-cso, psp-cso2, psp-zso and ps2-cso)
test('a compressed ISO can be converted as a CD', async ({ app }) => {
  await app.open();
  await app.add(['umd.zso']);
  const card = app.jobs().first();
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('ZSO compressed ISO');
  await expect(card.locator('code.cmd')).toContainText('chdman createdvd -i umd.iso');
  // identified as a PSP game, so the choice is in Options
  await card.locator('details.opts summary').click();
  await card.locator('label.field', { hasText: 'Create as' }).locator('select').selectOption({ label: 'CD CHD' });
  await expect(card.locator('code.cmd')).toContainText('chdman createcd -i umd.iso');
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman()) {
    const ref = reference('createcd', 'umd.iso');
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  }
});

test('a file named .cso that is not a compressed ISO is refused', async ({ app }) => {
  fs.writeFileSync(path.join(FIXTURES, 'not really.cso'), 'CISO but not really');
  await app.open();
  await app.add(['not really.cso']);
  const card = app.job('not really');
  await app.waitState(card, 'error');
  await expect(card.locator('.note.err')).toContainText('not a CSO or ZSO compressed ISO');
  await expect(card.locator('.job-foot')).toContainText('Can\u2019t convert');
});

test('a damaged compressed ISO stops with an error that names the block', async ({ app }) => {
  const src = Buffer.from(fs.readFileSync(path.join(FIXTURES, 'umd.cso')));
  const shift = src[21], entry = i => src.readUInt32LE(24 + 4 * i);
  // the first deflate block past the file system: garble its start
  let b = 600;
  while (entry(b) >>> 31) b++;
  src.fill(0xff, (entry(b) & 0x7fffffff) << shift, ((entry(b) & 0x7fffffff) << shift) + 16);
  fs.writeFileSync(path.join(FIXTURES, 'damaged umd.cso'), src);
  await app.open();
  await app.add(['damaged umd.cso']);
  const card = app.job('damaged umd');
  await app.settled(card);
  await expect(card.locator('.ident-how')).toHaveText('Matched by serial number'); // the file system is intact
  await app.run(card, { expectState: 'error' });
  await expect(card.locator('.note.err')).toContainText(`"damaged umd.cso" is damaged or incomplete: block ${b} of 666 could not be read.`);
});

// data as an ECM file that stores all of it as it is (valid, if not what bin2ecm makes of CD sectors;
// the format: wasm/ecm.cpp): a header, the bytes, the end and the EDC of the image
function ecmOf(data) {
  let edc = 0;
  for (const b of data) {
    edc ^= b;
    for (let k = 0; k < 8; k++) edc = (edc >>> 1) ^ (edc & 1 ? 0xd8018001 : 0);
  }
  const head = [];
  let v = data.length - 1;
  head.push((v >= 32 ? 128 : 0) | (v & 31) << 2);
  for (v = Math.floor(v / 32); v; v = Math.floor(v / 128)) head.push((v >= 128 ? 128 : 0) | (v & 127));
  const tail = Buffer.alloc(9);
  Buffer.from([0xfc, 0xff, 0xff, 0xff, 0x3f]).copy(tail); // count - 1 = 0xffffffff: the end
  tail.writeUInt32LE(edc >>> 0, 5);
  return Buffer.concat([Buffer.from('ECM\0'), Buffer.from(head), data, tail]);
}

test('ECM track files find their cue sheet, whichever comes first', async ({ app }) => {
  const t2 = fs.readFileSync(path.join(FIXTURES, 'mgs disc1 (Track 2).bin'));
  fs.writeFileSync(path.join(FIXTURES, 'mgs disc1 (Track 2).bin.ecm'), ecmOf(t2));
  await app.open();
  // the data track alone gets a generated cue; a later track waits for its cue sheet
  await app.add(['mgs disc1 (Track 1).bin.ecm', 'mgs disc1 (Track 2).bin.ecm']);
  await expect(app.jobs()).toHaveCount(2);
  await expect(app.job('mgs disc1 (Track 1)').locator('.sub')).toContainText('.bin.ecm image (no cue)');
  await app.waitState(app.jobs().nth(1), 'blocked');
  // the cue sheet takes both over, as the files it lists without .ecm
  await app.add(['mgs disc1.cue']);
  await expect(app.jobs()).toHaveCount(1);
  const card = app.job('mgs disc1');
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('CUE + 2 track files (ECM)');
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman()) {
    const ref = reference('createcd', 'mgs disc1.cue');
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  }
});

test('an ECM image completes a cue sheet that waits for its track', async ({ app }) => {
  await app.open();
  await app.add(['ax101.cue', 'ax101.bin.ecm']);
  const card = app.job('ax101');
  await app.waitState(card, 'blocked');
  await expect(card.locator('.note.warn li')).toHaveText(['ax101 audio.bin']);
  await app.add(['ax101 audio.bin.ecm']);
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('CUE + 2 track files (ECM)');
});

test('a file named .ecm that is not an ECM image is refused', async ({ app }) => {
  fs.writeFileSync(path.join(FIXTURES, 'not really.bin.ecm'), 'ECM but not really');
  await app.open();
  await app.add(['not really.bin.ecm']);
  const card = app.job('not really');
  await app.waitState(card, 'error');
  await expect(card.locator('.note.err')).toContainText('This is not an ECM image that Discpress can read.');
  await expect(card.locator('.job-foot')).toContainText('Can’t convert');
});

test('a lone ECM image that holds no data track asks for its cue sheet', async ({ app }) => {
  fs.writeFileSync(path.join(FIXTURES, 'song.bin.ecm'), ecmOf(fs.readFileSync(path.join(FIXTURES, 'piano.bin'))));
  await app.open();
  await app.add(['song.bin.ecm']);
  const card = app.job('song');
  await app.waitState(card, 'error');
  await expect(card.locator('.note.err')).toContainText('doesn’t start with a CD data track, so its tracks are unknown. Add the .cue file that lists it.');
});

test('a damaged ECM image stops with an error, and so does a truncated one', async ({ app }) => {
  // lone.bin.ecm: each sector is 16 bytes stored as they are, then a Mode 2 Form 1 sector (make_fixtures.py)
  const src = Buffer.from(fs.readFileSync(path.join(FIXTURES, 'lone.bin.ecm')));
  const unit = 1 + 16 + 1 + 4 + 2048, sector = 400;
  src[4 + sector * unit + 1 + 16 + 1 + 4 + 100] ^= 0x40; // a data byte of sector 400: its EDC and ECC are rebuilt to fit
  fs.writeFileSync(path.join(FIXTURES, 'damaged lone.bin.ecm'), src);
  fs.writeFileSync(path.join(FIXTURES, 'cut lone.bin.ecm'), src.subarray(0, Math.floor(src.length * 0.6)));
  await app.open();
  await app.add(['damaged lone.bin.ecm']);
  const card = app.job('damaged lone');
  await app.settled(card);
  await expect(card.locator('.ident-how')).toHaveText('Matched by serial number'); // the file system is intact
  await app.run(card, { expectState: 'error' });
  // only the checksum of the whole image, at its end, tells
  await expect(card.locator('.note.err')).toContainText('"damaged lone.bin.ecm" is damaged: the image rebuilt from it doesn’t match the checksum it ends with.');
  await app.add(['cut lone.bin.ecm']);
  const cut = app.job('cut lone');
  await app.settled(cut);
  await app.run(cut, { expectState: 'error' });
  await expect(cut.locator('.note.err')).toContainText('"cut lone.bin.ecm" could not be read as an ECM image: it ends before the image it holds does');
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

// A started job first loads the engine, waits for identification and may measure the device; until
// chdman runs there was nothing for Cancel to stop, and removing only hid the card (audit, batch 1).
test('Cancel stops a job that is still identifying the game', async ({ app }) => {
  await app.open({ debug: { identDelay: 5000 } });
  await app.add(['tnd.iso']);
  const card = app.job('tnd');
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'running');
  await card.locator('.job-foot button.danger', { hasText: 'Cancel' }).click();
  await app.waitState(card, 'canceled', 3000);
  await app.page.waitForTimeout(6000); // past the identification: it must not start after all
  expect(await card.getAttribute('data-state')).toBe('canceled');
  await card.locator('.job-foot button', { hasText: 'Try again' }).click();
  await app.waitState(card, 'ready');
  await app.run(card);
});

test('a job removed while it waits for identification neither runs nor blocks the queue', async ({ app, page }) => {
  await app.open({ debug: { identDelay: 3000 } });
  await app.add(['tnd.iso', 'frwl.iso']);
  // frwl's identification waits behind tnd's; start frwl, then remove it before its turn
  const frwl = app.job('frwl');
  await frwl.locator('.job-foot button.primary').click();
  await app.waitState(frwl, 'running');
  await frwl.locator('.job-head button[aria-label^="Remove "]').click();
  await expect(app.jobs()).toHaveCount(1);
  const tnd = app.job('tnd');
  await app.settled(tnd);
  await app.run(tnd, { timeout: 30_000 }); // the queue moves on
  await page.waitForTimeout(4000); // frwl's turn has come and gone: it didn't convert in the background
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('chdman-web-sessions') || '{}'));
  const titles = Object.values(rec).flatMap(r => Object.values(r.results || {}).map(x => x.title));
  expect(titles).not.toContain('frwl');
});

test('removing a job forgets its files', async ({ app }) => {
  await app.open();
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await card.locator('.job-head button[aria-label^="Remove "]').click();
  await expect(app.jobs()).toHaveCount(0);
  await app.add(fixture('ps1-single').add); // accepted again, not "already in the list"
  await expect(app.jobs()).toHaveCount(1);
});

// A folder of games whose tracks share generic names (every GDI has track01.bin): each descriptor takes
// the files in its own folder, never a same-named one from another game's (audit, batch 1).
function gameFolders(testInfo, { missingB = false } = {}) {
  const root = testInfo.outputPath('games');
  const bin = fs.readFileSync(path.join(FIXTURES, 'twine.bin'));
  for (const g of ['Game A', 'Game B']) {
    fs.mkdirSync(path.join(root, g), { recursive: true });
    fs.writeFileSync(path.join(root, g, 'game.cue'), 'FILE "track01.bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n');
    if (g === 'Game B' && missingB) continue;
    const b = Buffer.from(bin);
    if (g === 'Game B') b[b.length - 1] ^= 1; // a different disc of the same size
    fs.writeFileSync(path.join(root, g, 'track01.bin'), b);
    fs.utimesSync(path.join(root, g, 'track01.bin'), 1700000000, 1700000000); // same date too
  }
  return root;
}
async function addFolder(app, dir) {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.page.click('#addFolder')]);
  await chooser.setFiles(dir);
}

test('a game missing a track does not borrow the same-named track of another game in the folder', async ({ app }, testInfo) => {
  await app.open();
  await addFolder(app, gameFolders(testInfo, { missingB: true }));
  await expect(app.jobs()).toHaveCount(2);
  const cards = app.jobs();
  const states = await cards.evaluateAll(els => els.map(e => e.getAttribute('data-state')).sort());
  expect(states).toEqual(['blocked', 'ready']);
  await expect(app.page.locator('#jobs article.job[data-state="blocked"]')).toContainText('track01.bin');
});

test('same-named tracks of the same size and date in two game folders are both used, each by its own game', async ({ app }, testInfo) => {
  await app.open({ settings: { rename: false } });
  await addFolder(app, gameFolders(testInfo));
  await expect(app.jobs()).toHaveCount(2);
  const sums = [];
  for (let i = 0; i < 2; i++) {
    const card = app.jobs().nth(i);
    await app.settled(card);
    await expect(card).toContainText('CUE + 1 track file');
    await app.run(card);
    const [out] = await app.downloads(card);
    sums.push(fs.readFileSync(out.path).subarray(0x54, 0x68).toString('hex')); // the CHD's SHA-1
  }
  expect(sums[0]).not.toBe(sums[1]);
});

// the files in the page's private storage (OPFS), as session/job/slot paths
const workFiles = page => page.evaluate(async () => {
  const out = [];
  async function walk(d, p) { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') await walk(h, p + n + '/'); else out.push(p + n); } }
  try { await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-work'), ''); } catch (e) { /* none */ }
  return out;
});

// audit, batch 3
test('a hunk size picked for a DVD is dropped when identification makes the ISO a CD', async ({ app }) => {
  await app.open({ debug: { identDelay: 3000 } });
  await app.add(['tnd.iso']);
  const card = app.job('tnd');
  await expect(card).toContainText('Identifying game');
  await card.locator('details.opts summary').click();
  await card.locator('label.field', { hasText: 'Hunk size' }).locator('select').selectOption('2048');
  await expect(card.locator('code.cmd')).toContainText('chdman createdvd -i tnd.iso -o tnd.chd -hs 2048');
  await app.settled(card);
  await expect(card.locator('code.cmd')).toContainText('chdman createcd');
  await expect(card.locator('code.cmd')).not.toContainText('-hs');
  await app.run(card);
});

test('Clear finished asks before deleting unsaved results, and forgets the files', async ({ app, page }) => {
  await app.open();
  const asked = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { asked.push(d.message()); asked.length === 1 ? d.dismiss() : d.accept(); });
  await app.add(['tnd.iso']);
  const card = app.job('tnd');
  await app.settled(card);
  await app.run(card);
  await page.click('#clearDone');
  expect(asked[0]).toContain('1 finished job has results that haven’t been saved');
  await expect(app.jobs()).toHaveCount(1); // not removed: the user said no
  await page.click('#clearDone');
  await expect(app.jobs()).toHaveCount(0);
  await app.add(['tnd.iso']); // accepted again, not "already in the list"
  await expect(app.jobs()).toHaveCount(1);
});

test('removing a job with unsaved results asks first', async ({ app, page }) => {
  await app.open();
  const asked = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { asked.push(d.message()); d.dismiss(); });
  await app.add(['tnd.iso']);
  const card = app.job('tnd');
  await app.settled(card);
  await app.run(card);
  await card.locator('.job-head button[aria-label^="Remove "]').click();
  expect(asked).toEqual(['Remove "tnd"? Its results haven’t been saved and will be deleted.']);
  await expect(app.jobs()).toHaveCount(1);
  await app.downloads(card);
  await card.locator('.job-head button[aria-label^="Remove "]').click(); // saved: removed without asking
  await expect(app.jobs()).toHaveCount(0);
  expect(asked).toHaveLength(1);
});

test('macOS "._" companion files are not games', async ({ app, page }) => {
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '._tnd.iso'), Buffer.alloc(4096));
  await app.open();
  await app.add(['gen/._tnd.iso']);
  await expect(page.locator('#toasts')).toContainText('Nothing to convert in 1 file');
  await expect(app.jobs()).toHaveCount(0);
  await app.add(['tnd.iso', 'gen/._tnd.iso']);
  await expect(page.locator('#toasts')).toContainText('ignored 1 file (._tnd.iso)');
  await expect(app.jobs()).toHaveCount(1);
});

test('a cue added after the .iso it lists takes it over', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tnd game.cue'), 'FILE "tnd.iso" BINARY\r\n  TRACK 01 MODE1/2048\r\n    INDEX 01 00:00:00\r\n');
  await app.open();
  await app.add(['tnd.iso']);
  await app.settled(app.job('tnd'));
  await app.add(['gen/tnd game.cue']);
  const card = app.job('tnd game');
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('CUE + 1 track file');
  await expect(app.jobs()).toHaveCount(1);
});

test('a cue sheet may name its file in single quotes, as chdman reads it', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'twine.bin'), path.join(dir, 'twine q.bin'));
  fs.writeFileSync(path.join(dir, 'quoted.cue'), "FILE 'twine q.bin' BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n");
  await app.open({ settings: { rename: false } });
  await app.add(['gen/quoted.cue', 'gen/twine q.bin']);
  const card = app.job('quoted');
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('CUE + 1 track file');
  await expect(card.locator('.note.ident')).toContainText('SLUS-01272');
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman()) {
    const ref = reference('createcd', 'gen/quoted.cue');
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  }
});

test('a cancelled conversion leaves nothing in private storage', async ({ app, page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright\'s WebKit has no navigator.storage');

  await app.open({ settings: { threads: 1 } });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await expect.poll(async () => (await workFiles(page)).length, { timeout: 60_000, intervals: [20] }).toBeGreaterThan(0); // the CHD is being written
  await card.locator('.job-foot button.danger', { hasText: 'Cancel' }).click();
  await app.waitState(card, 'canceled');
  await expect.poll(() => workFiles(page), { timeout: 15_000 }).toEqual([]);
});

// "Notify me when all jobs are done" (Settings): the notification code was there, but nothing ever
// asked for the permission it needs (audit, remaining items)
test('a notification says when all jobs are done, if turned on', async ({ app, page }) => {
  await page.addInitScript(() => {
    window.__notes = [];
    window.Notification = class {
      constructor(title, o) { window.__notes.push(title + ': ' + o.body); }
      static get permission() { return window.__perm || 'default'; }
      static async requestPermission() { window.__perm = 'granted'; return 'granted'; }
    };
    Object.defineProperty(document, 'hidden', { get: () => !!window.__hidden, configurable: true });
  });
  await app.open();
  await app.settings({ setNotify: true });
  await app.add(['tnd.iso']);
  const card = app.job('tnd');
  await app.settled(card);
  await page.evaluate(() => { window.__hidden = true; }); // the page is in the background
  await app.run(card);
  await expect.poll(() => page.evaluate(() => window.__notes)).toEqual(['Discpress: All jobs are done.']);
});

// a lone file from folder A counted as "picked on its own": a cue sheet in folder B, added later, took it
// (second review)
test('a cue sheet added later does not take a lone file of the same name from another folder', async ({ app }, testInfo) => {
  const root = testInfo.outputPath('two');
  fs.mkdirSync(path.join(root, 'A'), { recursive: true });
  fs.mkdirSync(path.join(root, 'B'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'tnd.iso'), path.join(root, 'A', 'disc.iso'));
  fs.writeFileSync(path.join(root, 'B', 'disc.cue'), 'FILE "disc.iso" BINARY\r\n  TRACK 01 MODE1/2048\r\n    INDEX 01 00:00:00\r\n');
  await app.open();
  await addFolder(app, path.join(root, 'A'));
  await app.settled(app.job('disc'));
  await addFolder(app, path.join(root, 'B'));
  await expect(app.jobs()).toHaveCount(2);
  await expect(app.page.locator('#jobs article.job[data-state="blocked"]')).toContainText('disc.iso');
});

// formats Discpress can't read get a card that says why and what to do, rather than being ignored
test('unsupported disc images and archives get a card that explains them', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen', 'unsupported');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['homebrew.cdi', 'shmup.mds', 'shmup.mdf', 'game.isz', 'set.7z', 'set.rar']) fs.writeFileSync(path.join(dir, n), Buffer.alloc(4096, 1));
  await app.open();
  await app.add(['homebrew.cdi', 'shmup.mds', 'shmup.mdf', 'game.isz', 'set.7z', 'set.rar'].map(n => 'gen/unsupported/' + n));
  await expect(app.jobs()).toHaveCount(5); // the .mdf goes with its .mds
  for (const [title, why] of [['homebrew', 'Flycast and Redream load .cdi files as they are'], ['shmup', 'Alcohol 120% images'], ['game', '.isz'], ['set', '7-Zip archives']]) {
    const card = app.job(title).first();
    await expect(card.locator('.note.err')).toContainText(why);
    await expect(card.locator('.job-foot')).toContainText('Can’t convert');
    await expect(card.locator('.job-foot button')).toHaveCount(0);
  }
  await expect(app.jobs().filter({ hasText: 'RAR archives' })).toHaveCount(1);
  await expect(app.job('shmup').locator('.sub')).toHaveText('.mds file · 4.00 KB');
});
