// Identification that confirms the exact release by checksum, and conversions that
// don't wait for it. Uses the page with extra database rows (server.js ?testdb=1),
// since synthetic discs can't match real Redump checksums.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES, ROOT } from '../support/paths.js';
import { chdman, nativeChdman, reference, sha1File } from '../support/native.js';

const fx = fixture('ps1-verified');

test('a dump whose checksum matches the database is named after that exact release', async ({ app }) => {
  await app.open({ testdb: true });
  await app.add(fx.add);
  const card = app.job('verified');
  await app.settled(card);
  await expect(card.locator('.ident-name')).toHaveText(fx.name);
  await expect(card.locator('.ident-how')).toHaveText('✓ Exact match in the Redump database (checksum verified)');
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${fx.name}.chd`);
});

test('a compressed ISO is matched by the checksum of the ISO inside it', async ({ app }) => {
  await app.open({ testdb: true });
  await app.add(['umd v2.cso']); // deflate, LZ4 and stored blocks (make_fixtures.py: psp-cso2)
  const card = app.job('umd v2');
  await app.settled(card);
  await expect(card.locator('.ident-name')).toHaveText('Checksum Verified PSP Game (USA)');
  await expect(card.locator('.ident-how')).toHaveText('✓ Exact match in the Redump database (checksum verified)');
});

test('an ECM image is matched by the checksum of the image inside it', async ({ app }) => {
  await app.open({ testdb: true });
  await app.add(['xa.cue', 'xa.bin.ecm']); // XA sectors, Form 1 and Form 2 (make_fixtures.py: ps1-ecm)
  const card = app.job('xa');
  await app.settled(card);
  await expect(card.locator('.ident-name')).toHaveText('Checksum Verified ECM Game (USA)');
  await expect(card.locator('.ident-how')).toHaveText('✓ Exact match in the Redump database (checksum verified)');
});

test('the page-side checksum fallback finds the same match', async ({ app }) => {
  await app.open({ testdb: true, debug: { stage: 1 } }); // stage also routes the checksum through the page
  await app.add(fx.add);
  const card = app.job('verified');
  await app.settled(card);
  await expect(card.locator('.ident-name')).toHaveText(fx.name);
});

test('converting starts before the checksum finishes, and results are renamed after it', async ({ app }) => {
  await app.open({ testdb: true, debug: { crcDelay: 6000 } });
  await app.add(fx.add);
  const card = app.job('verified');
  // provisional: serial match only, checksum still running
  await expect(card.locator('.ident-check')).toBeVisible();
  await expect(card.locator('.ident-name')).toHaveText(fx.provisional);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'done', 30_000);
  await expect(card.locator('.ident-check')).toBeVisible(); // finished while the checksum was still running
  await expect(card.locator('.result .out .nm')).toContainText(`${fx.provisional}.chd`);
  // the checksum confirms a different release: the result follows it
  await expect(card.locator('.ident-check')).toHaveCount(0, { timeout: 30_000 });
  await expect(card.locator('.ident-name')).toHaveText(fx.name);
  await expect(card.locator('.result .out .nm')).toContainText(`${fx.name}.chd`);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${fx.name}.chd`);
  if (nativeChdman()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', 'verified.cue')));
});

// A finished card removed while its checksum still ran: the checksum's rename then recorded results
// already deleted, which the next visit listed under "From your last visit" (audit 2026-10-05, L4)
test('a card removed while its checksum runs leaves no record of its results', async ({ app, page }) => {
  await app.open({ testdb: true, debug: { crcDelay: 6000 } });
  await app.add(fx.add);
  const card = app.job('verified');
  await expect(card.locator('.ident-check')).toBeVisible();
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'done', 30_000);
  await card.locator('.job-head button[aria-label^="Remove "]').click(); // (its unsaved results: asked, and accepted)
  await expect(app.jobs()).toHaveCount(0);
  await page.waitForTimeout(7000); // the checksum is done
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('chdman-web-sessions') || '{}'));
  for (const s of Object.values(rec)) expect(Object.keys(s.results || {})).toEqual([]);
});

// Removing a card while its checksum ran left the checksum running, and every other card waited for it
// (audit 2026-10-05): it stops, and the next card is identified at once
test('removing a card stops its checksum, and the next card is identified at once', async ({ app }) => {
  await app.open({ testdb: true, debug: { crcSlow: 60000 } });
  await app.add(fx.add);
  const first = app.job('verified');
  await expect(first.locator('.ident-check')).toBeVisible();
  await app.add(['tnd.iso']);
  const next = app.job('tnd');
  await expect(next).toBeVisible();
  await expect(first.locator('.ident-check')).toBeVisible();
  await expect(next.locator('.note.ident')).toHaveCount(0); // (waiting for the first card's checksum)
  await first.locator('.job-head button[aria-label^="Remove "]').click();
  await expect(app.jobs()).toHaveCount(1);
  await expect(next.locator('.note.ident')).toHaveAttribute('data-method', 'serial', { timeout: 10_000 });
});

test('a result already saved under the provisional name is not renamed', async ({ app }) => {
  await app.open({ testdb: true, debug: { crcDelay: 6000 } });
  await app.add(fx.add);
  const card = app.job('verified');
  await expect(card.locator('.ident-check')).toBeVisible();
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'done', 30_000);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${fx.provisional}.chd`);
  await expect(card.locator('.ident-check')).toHaveCount(0, { timeout: 30_000 });
  await expect(card.locator('.ident-name')).toHaveText(fx.name);
  await expect(card.locator('.result .out .nm')).toContainText(`${fx.provisional}.chd`);
});

test('a version picked while the checksum runs is kept when it finds no exact match', async ({ app }) => {
  // the database has a game of the size of the data track (testdb.json), so a checksum runs; it matches nothing
  const mgs = fixture('ps1-multitrack');
  await app.open({ testdb: true, debug: { crcDelay: 3000 } });
  await app.add(mgs.add);
  const card = app.job('mgs disc1');
  await expect(card.locator('.ident-check')).toBeVisible();
  await card.locator('.note.ident select').selectOption(mgs.names[1]);
  await expect(card.locator('.ident-check')).toHaveCount(0, { timeout: 30_000 });
  await expect(card.locator('.ident-name')).toHaveText(mgs.names[1]);
  await expect(card.locator('.note.ident select')).toHaveValue(mgs.names[1]);
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${mgs.names[1]}.chd`);
});

test('a version picked while converting names the results', async ({ app }) => {
  const mgs = fixture('ps1-multitrack');
  await app.open({ testdb: true, debug: { crcDelay: 3000 } });
  await app.add(mgs.add);
  const card = app.job('mgs disc1');
  await expect(card.locator('.ident-check')).toBeVisible();
  await card.locator('.job-foot button.primary').click();
  await card.locator('.note.ident select').selectOption(mgs.names[1]);
  await app.waitState(card, 'done', 30_000);
  await expect(card.locator('.ident-check')).toHaveCount(0, { timeout: 30_000 });
  await expect(card.locator('.result .out .nm')).toContainText(`${mgs.names[1]}.chd`);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${mgs.names[1]}.chd`);
});

test('starting while identification is still running uses the game name and disc type', async ({ app }) => {
  const iso = fixture('ps1-as-iso');
  await app.open({ debug: { identDelay: 1500 } });
  await app.add(iso.add);
  const card = app.job('tnd');
  await expect(card).toContainText('Identifying game');
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'done', 60_000);
  await expect(card.locator('code.cmd')).toContainText('chdman createcd');
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${iso.name}.chd`);
  if (nativeChdman()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', 'tnd.iso')));
});

// A music CD's tracks are just sizes: among 40,000 discs one often has the size of some game's. The
// size-only match is for a recognized console's disc whose serial can't be read (audit, batch 1).
test('an audio CD whose track has the size of a game is not named after that game', async ({ app }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  // a PlayStation row whose size is whole CD frames and belongs to one game only
  const db = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'db', 'db.json.gz'))));
  const bySize = new Map();
  for (const row of db.systems.ps1.split('\n')) {
    const [name, , size] = row.split('\t');
    if (+size % 2352 === 0 && +size < 4 << 20) bySize.set(+size, (bySize.get(+size) || new Set()).add(name));
  }
  const [size, names] = [...bySize].find(([, n]) => n.size === 1);
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'album.bin'), Buffer.alloc(size, 7));
  fs.writeFileSync(path.join(dir, 'album.cue'), 'FILE "album.bin" BINARY\r\n  TRACK 01 AUDIO\r\n    INDEX 01 00:00:00\r\n');
  chdman(['createcd', '-i', 'gen/album.cue', '-o', 'gen/album.chd', '-f']);

  await app.open();
  await app.add(['gen/album.chd']);
  const card = app.job('album');
  await app.settled(card);
  await expect(card).not.toContainText([...names][0]);
  await expect(card).not.toContainText('Matched by size');
});

// A serial the database doesn't know (a release missing from it, or a serial read wrong) used to end the
// search, though the data track's size alone can still name the disc (audit, batch 2).
test('a CHD whose serial is not in the database is still matched by its data track size', async ({ app }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  const db = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'db', 'db.json.gz'))));
  const bin = Buffer.from(fs.readFileSync(path.join(FIXTURES, 'twine.bin')));
  // the disc's serial becomes one Redump doesn't list (SYSTEM.CNF and the boot file's name)
  const from = Buffer.from('SLUS_012.72'), to = Buffer.from('SLUS_999.99');
  for (let i = bin.indexOf(from); i >= 0; i = bin.indexOf(from, i + 1)) to.copy(bin, i);
  expect(db.systems.ps1.includes('SLUS-99999')).toBe(false);
  // padded to the size of a PlayStation disc that only one game has
  const count = new Map();
  for (const row of db.systems.ps1.split('\n')) {
    const [name, , size] = row.split('\t');
    if (+size % 2352 === 0 && +size >= bin.length && +size < 8 << 20) count.set(+size, (count.get(+size) || new Set()).add(name));
  }
  const [size, names] = [...count].filter(([, n]) => n.size === 1).sort((a, b) => a[0] - b[0])[0];
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'unlisted.bin'), Buffer.concat([bin, Buffer.alloc(size - bin.length)]));
  fs.writeFileSync(path.join(dir, 'unlisted.cue'), 'FILE "unlisted.bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n');
  chdman(['createcd', '-i', 'gen/unlisted.cue', '-o', 'gen/unlisted.chd', '-f']);

  await app.open();
  await app.add(['gen/unlisted.chd']);
  const card = app.job('unlisted');
  await app.settled(card);
  await expect(card.locator('.note.ident')).toContainText('SLUS-99999');
  await expect(card).toContainText([...names][0]);
  await expect(card.locator('.ident-how')).toHaveText('Matched by size');
});

// A CHD's data track as MODE2/2336 or MODE2/2048: the reader asked for Mode 1 data, which chdman converts
// only from Mode 1 tracks, so these gave shifted bytes or nothing and were never identified (audit, batch 2).
for (const [mode, from, size] of [['MODE2/2336', 16, 2336], ['MODE2/2048', 24, 2048]]) {
  test(`a CHD whose data track is ${mode} is identified`, async ({ app }) => {
    test.skip(!nativeChdman(), 'needs native chdman');
    const raw = fs.readFileSync(path.join(FIXTURES, 'twine.bin'));
    const out = Buffer.alloc(raw.length / 2352 * size);
    for (let i = 0; i < raw.length / 2352; i++) raw.copy(out, i * size, i * 2352 + from, i * 2352 + from + size);
    const name = 'twine-' + size;
    const dir = path.join(FIXTURES, 'gen');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.bin'), out);
    fs.writeFileSync(path.join(dir, name + '.cue'), `FILE "${name}.bin" BINARY\r\n  TRACK 01 ${mode}\r\n    INDEX 01 00:00:00\r\n`);
    chdman(['createcd', '-i', `gen/${name}.cue`, '-o', `gen/${name}.chd`, '-f']);

    await app.open();
    await app.add([`gen/${name}.chd`]);
    const card = app.job(name);
    await app.settled(card);
    await expect(card.locator('.note.ident')).toContainText('SLUS-01272');
    await expect(card).toContainText('007 - The World Is Not Enough (USA)');
  });
}

// A reader worker that died (out of memory, say) left its requests unanswered: the job stayed at
// "Identifying game…" and every job after it waited forever (audit, batch 2).
test('a reader worker that dies fails its identification, and the next job is identified', async ({ app, page }) => {
  await page.addInitScript(() => {
    const W = window.Worker;
    window.Worker = class extends W {
      postMessage(m, t) {
        if (m && m.type === 'reader') this.reader = true;
        if (this.reader && m && m.type === 'read') {
          this.terminate();
          setTimeout(() => this.onerror && this.onerror(new ErrorEvent('error', { message: 'the reader crashed' })));
          return;
        }
        return super.postMessage(m, t);
      }
    };
  });
  await app.open();
  await app.add(['umd.cso']);
  const umd = app.job('umd');
  await expect(umd.locator('.note').first()).toContainText('Could not identify this game (the reader crashed)', { timeout: 30_000 });
  await app.add(['twine.cue', 'twine.bin']);
  const twine = app.job('twine');
  await app.settled(twine);
  await expect(twine.locator('.note.ident')).toContainText('SLUS-01272');
});

// A CHD made against a parent (-op) holds only what differs from it; it was never identified.
test('a child CHD is identified through its parent', async ({ app }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  chdman(['createcd', '-i', 'twine.cue', '-o', 'gen/twine-parent.chd', '-f']);
  chdman(['createcd', '-i', 'twine.cue', '-o', 'gen/twine-child.chd', '-op', 'gen/twine-parent.chd', '-f']);
  await app.open();
  await app.add(['gen/twine-child.chd']);
  const child = app.job('twine-child');
  await app.waitState(child, 'ready');
  await expect(child.locator('.note.ident')).toHaveCount(0); // no parent yet
  await app.add(['gen/twine-parent.chd']);
  await app.settled(child);
  await expect(child.locator('.note.ident')).toContainText('SLUS-01272');
  await expect(child).toContainText('007 - The World Is Not Enough (USA)');
});

// The checksum step reads an ECM image to its end, where a damaged one shows: that was dropped, and
// the card said nothing until converting failed (audit, remaining items)
test('an ECM image found damaged while checking against the database says so', async ({ app }) => {
  const dir = path.join(FIXTURES, 'gen', 'damaged-ecm');
  fs.mkdirSync(dir, { recursive: true });
  const src = Buffer.from(fs.readFileSync(path.join(FIXTURES, 'xa.bin.ecm')));
  src[src.length - 1] ^= 0x01; // the EDC the file ends with
  fs.writeFileSync(path.join(dir, 'xa.bin.ecm'), src);
  fs.copyFileSync(path.join(FIXTURES, 'xa.cue'), path.join(dir, 'xa.cue'));
  await app.open({ testdb: true }); // xa.bin's size is in the database, so its checksum is computed
  await app.add(['gen/damaged-ecm/xa.cue', 'gen/damaged-ecm/xa.bin.ecm']);
  const card = app.job('xa');
  await app.settled(card);
  await expect(card.locator('.ident-damaged')).toContainText('"xa.bin.ecm" is damaged: the image rebuilt from it doesn’t match the checksum it ends with.');
});

// How a serial names a release (milestone 6): a release of the disc's size wins over the one its serial
// names exactly (Redump's Asterix: SLES-01748, and SLES-017482 for the Rev 1 disc that says SLES-01748)
test('a release of the disc’s size wins over the exact serial', async ({ app }) => {
  const sr = fixture('ps1-size-rank');
  await app.open({ testdb: true });
  await app.add(sr.add);
  const card = app.job('size rank');
  await app.settled(card);
  await expect(card.locator('.ident-name')).toHaveText(sr.name);
  await expect(card.locator('.ident-how')).toHaveText('Matched by serial number and size');
  await expect(card.locator('.note.ident')).toHaveAttribute('data-method', 'serial+size');
});

// a disc for Japan whose serial the database has only as a European release's base serial: not named
test('a release for another region than the disc’s doesn’t name it', async ({ app }) => {
  const or = fixture('saturn-other-region');
  await app.open({ testdb: true });
  await app.add(or.add);
  const card = app.job('other region');
  await app.settled(card);
  await expect(card.locator('.note.ident')).toHaveAttribute('data-region', 'J');
  await expect(card.locator('.ident-name')).toHaveCount(0);
  await expect(card.locator('.note.ident')).toContainText('Not in the Redump database');
});

// a disc whose serial without its suffix is another game's (T-25406H: Hexen; the disc's title is DOOM): not
// named after it, only offered; a disc for Europe is named after the Doom release its base serial lists
test('a release whose serial is the disc’s without its suffix, of another title, is only offered', async ({ app }) => {
  const us = fixture('saturn-related'), eu = fixture('saturn-suffix');
  await app.open();
  await app.add(us.add.concat(eu.add));
  const card = app.job('doom us'), other = app.job('doom eu');
  await app.settled(card);
  await app.settled(other);
  await expect(card.locator('.note.ident')).toHaveAttribute('data-method', 'serial-related');
  await expect(card.locator('.ident-name')).toHaveCount(0);
  await expect(card.locator('.ident-related')).toContainText('Disc title: DOOM.');
  await expect(card.locator('.ident-related')).toContainText('A release with a related serial number: Hexen (USA).');
  await expect(card.locator('code.cmd')).toContainText('doom us.chd');
  await card.locator('.note.ident button', { hasText: 'Use this name' }).click();
  await expect(card.locator('code.cmd')).toContainText('Hexen (USA).chd');
  await expect(card.locator('.note.ident button', { hasText: 'Use this name' })).toHaveCount(0);
  await expect(other.locator('.ident-name')).toHaveText(eu.name);
  await expect(other.locator('.note.ident')).toHaveAttribute('data-method', 'serial');
  // which serial found them: the disc's without its suffix; a base serial (T-25406H of T-25406H-50)
  await expect(card.locator('.note.ident')).toHaveAttribute('data-how', 'trim');
  await expect(other.locator('.note.ident')).toHaveAttribute('data-how', 'base');
});

// PC-98 discs have nothing of their own to detect (a PC disc's file system): their size and checksum find them
test('a PC-98 disc is found by its size and checksum', async ({ app }) => {
  const fx = fixture('pc98-iso');
  await app.open({ testdb: true });
  await app.add(fx.add);
  const card = app.job('pc98 game');
  await app.settled(card);
  await expect(card.locator('.sysbadge')).toHaveText('PC-98');
  await expect(card.locator('.ident-name')).toHaveText(fx.name);
  await expect(card.locator('.note.ident')).toHaveAttribute('data-method', 'hash');
});

// Sega's headers say which disc of a set this is: a Saturn game's two discs are named apart, and get a playlist
test('the discs of a Saturn set are told apart by their headers and get a playlist', async ({ app, page }) => {
  const d1 = fixture('saturn-disc1'), d2 = fixture('saturn-disc2');
  await app.open();
  await app.add(d1.add.concat(d2.add));
  const one = app.job('3x3 eyes 1'), two = app.job('3x3 eyes 2');
  await app.settled(one);
  await app.settled(two);
  await expect(one.locator('.note.ident')).toHaveAttribute('data-disc', '1/3');
  await expect(two.locator('.note.ident')).toHaveAttribute('data-disc', '2/3');
  await expect(two.locator('.ident-name')).toHaveText(d2.name);
  await app.run(one);
  await app.run(two);
  await expect(one.locator('.playlist')).toContainText('A game on 2 discs.');
  const [dl] = await Promise.all([page.waitForEvent('download'), one.locator('.playlist button').click()]);
  expect(dl.suggestedFilename()).toBe('3x3 Eyes - Kyuusei Koushu S (Japan).m3u');
  const p = test.info().outputPath('set.m3u');
  await dl.saveAs(p);
  expect(fs.readFileSync(p, 'utf8')).toBe(`${d1.name}.chd\n${d2.name}.chd\n`);
});
