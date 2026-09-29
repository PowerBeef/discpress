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
