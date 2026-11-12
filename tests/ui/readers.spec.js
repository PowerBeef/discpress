// Damaged files of each kind the page reads itself rather than chdman (app/worker.js's CisoStore, PbpStore and
// EcmStore, app/ui.js's zipEntries, Unzip, ccdToCue and scanSub): made from the fixtures by a seeded random
// generator, cut short, with header fields set to extremes, and with bytes changed. Whatever they hold, each must
// end as a card that says what is wrong, or as a conversion that finishes or fails with a message: never an
// uncaught exception, a console error (the fixture checks both) or a card left waiting.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test, expect } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { makeZip } from '../support/zip.js';

const read = n => fs.readFileSync(path.join(FIXTURES, n));

// mulberry32: the same variants on every run
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cut = (b, at) => Buffer.from(b.subarray(0, Math.max(0, Math.floor(at))));
function flip(b, seed, from = 0, to = b.length, count = 8) {
  const r = random(seed), out = Buffer.from(b);
  for (let i = 0; i < count; i++) out[from + Math.floor(r() * (Math.min(to, out.length) - from))] ^= 1 + Math.floor(r() * 255);
  return out;
}
const edit = (b, f) => { const out = Buffer.from(b); f(out); return out; };

// A CSO v1 image (maxcso's format, as discgen.py's ciso writes it): deflate blocks, an index of their offsets
function cso(iso, block = 2048) {
  const count = Math.ceil(iso.length / block), index = Buffer.alloc(4 * (count + 1)), blocks = [];
  let pos = 24 + index.length;
  for (let i = 0; i < count; i++) {
    const raw = Buffer.alloc(block);
    iso.copy(raw, 0, i * block, (i + 1) * block);
    let data = zlib.deflateRawSync(raw, { level: 9 }), plain = 0;
    if (data.length >= block) { data = raw; plain = 0x80000000; }
    index.writeUInt32LE((pos | plain) >>> 0, 4 * i);
    blocks.push(data);
    pos += data.length;
  }
  index.writeUInt32LE(pos, 4 * count);
  const head = Buffer.alloc(24);
  head.write('CISO', 0, 'latin1'); head.writeUInt32LE(24, 4); head.writeBigUInt64LE(BigInt(iso.length), 8);
  head.writeUInt32LE(block, 16); head[20] = 1;
  return Buffer.concat([head, index, ...blocks]);
}

// writes the variants into their own folder and returns the paths to add
function variants(kind, list) {
  const dir = path.join(FIXTURES, 'gen', 'readers', kind);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (const [name, data] of list) {
    fs.writeFileSync(path.join(dir, name), data);
    names.push(`gen/readers/${kind}/${name}`);
  }
  return names;
}

// adds the files, waits for every card to be identified, then converts each one that can be converted.
// expected: the number of cards (without it, as many as the page makes once it has unpacked every zip)
async function exercise(app, files, expected) {
  await app.open();
  await app.add(files);
  const cards = app.jobs();
  if (expected === undefined) {
    await expect.poll(async () => cards.count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => app.page.locator('#chipUnzip').count(), { timeout: 90_000 }).toBe(0);
    expected = await cards.count();
  }
  await expect(cards).toHaveCount(expected, { timeout: 60_000 });
  for (let i = 0; i < expected; i++) {
    const card = cards.nth(i);
    await app.waitState(card, ['ready', 'blocked', 'error'], 90_000);
    await expect(card.locator('.note', { hasText: /Identifying|Checking against|Reading the ECM/ })).toHaveCount(0, { timeout: 90_000 });
  }
  const ended = {};
  for (let i = 0; i < expected; i++) {
    const card = cards.nth(i), button = card.locator('.job-foot button.primary');
    const title = await card.getAttribute('data-title');
    if (!(await button.count()) || !(await button.isEnabled())) { ended[title] = await card.getAttribute('data-state'); continue; }
    await button.click();
    try { ended[title] = await app.waitState(card, ['done', 'error', 'canceled'], 120_000); }
    catch (e) { throw new Error(`${title}: still "${await card.getAttribute('data-state')}" after 120 s:\n${await card.innerText()}`); }
    // a failure says why
    if (ended[title] === 'error') await expect(card, title).toContainText(/\S/);
  }
  return ended;
}

test('damaged CSO and ZSO images', async ({ app }) => {
  test.setTimeout(400_000);
  const good = cso(read('psxexe.iso')), zso = read('umd.zso');
  const blocks = (good.readUInt32LE(16) && Math.ceil(Number(good.readBigUInt64LE(8)) / good.readUInt32LE(16))) || 1;
  const files = variants('ciso', [
    ['header-only.cso', cut(good, 24 + 4 * 10)],
    ['half.cso', cut(good, good.length / 2)],
    ['block-0.cso', edit(good, b => b.writeUInt32LE(0, 16))],
    ['block-2g.cso', edit(good, b => b.writeUInt32LE(0x80000000, 16))],
    ['size-huge.cso', edit(good, b => b.writeBigUInt64LE(0xffffffffffffn, 8))],
    ['version-9.cso', edit(good, b => { b[20] = 9; b[21] = 31; })],
    ['index-past-end.cso', edit(good, b => b.writeUInt32LE(0x7fffffff, 24 + 4 * 5))],
    ['index-backwards.cso', edit(good, b => b.writeUInt32LE(b.readUInt32LE(24 + 4 * 3), 24 + 4 * 7))],
    ['index-flips.cso', flip(good, 1, 24, 24 + 4 * (blocks + 1), 12)],
    ['data-flips.cso', flip(good, 2, 24 + 4 * (blocks + 1), good.length, 40)],
    ['zso-half.zso', cut(zso, zso.length / 2)],
    ['zso-index-flips.zso', flip(zso, 3, 24, 24 + 4 * 64, 12)],
    ['zso-data-flips.zso', flip(zso, 4, 4096, zso.length, 40)],
  ]);
  const ended = await exercise(app, files, files.length);
  expect(Object.keys(ended)).toHaveLength(files.length);
});

test('damaged PBP files', async ({ app }) => {
  test.setTimeout(400_000);
  const good = read('mgs.pbp'), psar = good.readUInt32LE(0x24);
  const files = variants('pbp', [
    ['header-only.pbp', cut(good, 0x28)],
    ['third.pbp', cut(good, good.length / 3)],
    ['psar-past-end.pbp', edit(good, b => b.writeUInt32LE(b.length + 1, 0x24))],
    ['psar-max.pbp', edit(good, b => b.writeUInt32LE(0xffffffff, 0x24))],
    ['header-flips.pbp', flip(good, 5, 0, 0x28, 6)],
    ['psar-flips-1.pbp', flip(good, 6, psar, psar + 0x400, 12)],
    ['psar-flips-2.pbp', flip(good, 7, psar + 0x400, psar + 0x4000, 12)],
    ['table-flips.pbp', flip(good, 8, psar + 0x4000, psar + 0x10000, 24)],
    ['data-flips.pbp', flip(good, 9, psar + 0x10000, good.length, 40)],
  ]);
  const ended = await exercise(app, files, files.length);
  expect(Object.keys(ended)).toHaveLength(files.length);
});

test('damaged ECM images', async ({ app }) => {
  test.setTimeout(400_000);
  const good = read('lone.bin.ecm');
  const files = variants('ecm', [
    ['magic.bin.ecm', edit(good, b => b.write('ECX', 0, 'latin1'))],
    ['half.bin.ecm', cut(good, good.length / 2)],
    ['no-edc.bin.ecm', cut(good, good.length - 2)],
    ['edc.bin.ecm', edit(good, b => { b[b.length - 1] ^= 0x55; })],
    ['count-huge.bin.ecm', edit(good, b => Buffer.from([0xfd, 0xff, 0xff, 0xff, 0x0f]).copy(b, 4))],
    ['start-flips.bin.ecm', flip(good, 10, 4, 64, 4)],
    ['flips-1.bin.ecm', flip(good, 11, 4, good.length, 6)],
    ['flips-2.bin.ecm', flip(good, 12, 4, good.length, 60)],
  ]);
  const ended = await exercise(app, files, files.length);
  expect(Object.keys(ended)).toHaveLength(files.length);
  // a changed byte of the image's data fails its EDC: the conversion stops instead of making a CHD of other data
  expect(ended.edc).toBe('error');
});

test('damaged zip archives', async ({ app }) => {
  test.setTimeout(400_000);
  const cue = Buffer.from('FILE "lone.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
  const good = makeZip([{ name: 'lone.cue', data: cue }, { name: 'lone.bin', data: read('lone.bin') }]);
  const stored = makeZip([{ name: 'lone.cue', data: cue, method: 0 }, { name: 'lone.bin', data: read('lone.bin'), method: 0 }]);
  const eocd = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), cd = good.readUInt32LE(eocd + 16);
  const files = variants('zip', [
    ['half.zip', cut(good, good.length / 2)],
    ['no-directory.zip', cut(good, cd)],
    ['directory-flips.zip', flip(good, 13, cd, good.length, 10)],
    ['directory-offset.zip', edit(good, b => b.writeUInt32LE(0xfffffff0, eocd + 16))],
    ['sizes-huge.zip', edit(good, b => { b.writeUInt32LE(0xffffffff, cd + 20); b.writeUInt32LE(0xffffffff, cd + 24); })],
    ['local-flips.zip', flip(good, 14, 0, 30, 6)],
    ['data-flips.zip', flip(good, 15, 200, cd, 30)],
    ['stored-flips.zip', flip(stored, 16, 0, stored.length, 30)],
  ]);
  // (a zip's entries make the cards, so as many as the page makes)
  const ended = await exercise(app, files);
  expect(Object.keys(ended).length).toBeGreaterThan(0);
});

test('damaged CloneCD images', async ({ app }) => {
  test.setTimeout(400_000);
  const ccd = read('lc.ccd').toString('latin1'), img = read('lc.img'), sub = read('lc.sub');
  const sets = {
    'toc-0': [ccd.replace(/TocEntries=\d+/, 'TocEntries=0'), img, sub],
    'toc-999': [ccd.replace(/TocEntries=\d+/, 'TocEntries=999'), img, sub],
    'plba': [ccd.replace(/PLBA=\d+/g, 'PLBA=-150'), img, sub],
    'plba-huge': [ccd.replace(/PLBA=\d+/g, 'PLBA=4294967295'), img, sub],
    'no-entries': [ccd.replace(/\[Entry[\s\S]*/, ''), img, sub],
    'garbage': [flip(Buffer.from(ccd, 'latin1'), 17, 0, ccd.length, 20).toString('latin1'), img, sub],
    'img-short': [ccd, cut(img, 1000), sub],
    'sub-short': [ccd, img, cut(sub, 100)],
    'sub-flips': [ccd, img, flip(sub, 18, 0, sub.length, 400)],
  };
  const list = [];
  for (const [name, [c, i, s]] of Object.entries(sets)) list.push([`${name}.ccd`, Buffer.from(c, 'latin1')], [`${name}.img`, i], [`${name}.sub`, s]);
  const files = variants('ccd', list);
  // (a .ccd that can't be read leaves its image and subchannel to make a card of their own: as many cards as the page makes)
  const ended = await exercise(app, files);
  expect(Object.keys(ended).length).toBeGreaterThanOrEqual(Object.keys(sets).length);
});
