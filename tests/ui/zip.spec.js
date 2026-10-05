// Zip archives: their files join the list as if picked one by one. Stored files are read in place,
// deflated ones unpacked first (checked against the zip's CRC-32); what can't be read gets a card.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';
import { makeZip } from '../support/zip.js';

const dir = path.join(FIXTURES, 'gen', 'zip');
function writeZip(name, files, opts) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), makeZip(files, opts));
  return 'gen/zip/' + name;
}
const read = n => fs.readFileSync(path.join(FIXTURES, n));

test('a zipped cue sheet and its tracks (deflated) convert to the CHD of the files themselves', async ({ app, page }) => {
  const fx = fixture('ps1-multitrack');
  const zip = writeZip('mgs disc1.zip', [...fx.add.map(n => ({ name: n, data: read(n) })), { name: 'readme.txt', data: Buffer.from('hello') }]);
  await app.open();
  await app.add([zip]);
  await expect(app.jobs()).toHaveCount(1);
  const card = app.job('mgs disc1');
  await app.settled(card);
  await expect(card.locator('.sub')).toContainText('CUE + 2 track files');
  await expect(page.locator('#chipUnzip')).toHaveCount(0); // the unpacking progress is gone
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', 'mgs disc1.cue')));
});

test('a stored file in a zip64 archive is read in place, and a removed zip can be added again', async ({ app, page }) => {
  const zip = writeZip('agent.zip', [{ name: 'Games/agent.iso', data: read('agent.iso'), method: 0 }], { zip64: true });
  await app.open();
  await app.add([zip]);
  const card = app.job('agent');
  await app.settled(card);
  await expect(card.locator('.sysbadge')).toHaveText('PS2');
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createdvd', 'agent.iso')));
  // added again while listed: said so, not "Nothing to convert" (audit 2026-10-05, L12)
  await app.add([zip]);
  await expect(page.locator('#toasts')).toContainText('That zip is already in the list.');
  await expect(app.jobs()).toHaveCount(1);
  await card.locator('.job-head button[aria-label^="Remove "]').click();
  await expect(app.jobs()).toHaveCount(0);
  await app.add([zip]);
  await expect(app.jobs()).toHaveCount(1);
});

test('files a zip can’t give back get a card that says why; the others are added', async ({ app }) => {
  const zip = writeZip('mixed.zip', [
    { name: 'twine.cue', data: read('twine.cue') }, { name: 'twine.bin', data: read('twine.bin') },
    { name: 'broken.iso', data: read('homebrew.iso'), crc: 0x12345678 },
    { name: 'packed.iso', data: read('homebrew.iso'), fakeMethod: 14 },
    // said to be 1 KB: unpacking stops there, not at the end (audit 2026-10-05, zip inflation bound)
    { name: 'bomb.iso', data: read('homebrew.iso'), usize: 1024 },
  ]);
  await app.open();
  await app.add([zip]);
  await expect(app.jobs()).toHaveCount(2);
  const bad = app.job('mixed');
  await expect(bad.locator('.note.err')).toContainText('3 files in this zip can’t be converted.');
  await expect(bad.locator('.note.err')).toContainText('bomb.iso is damaged in the zip: it holds more than the zip says');
  await expect(bad.locator('.note.err')).toContainText('broken.iso is damaged in the zip: its checksum doesn’t match');
  await expect(bad.locator('.note.err')).toContainText('packed.iso uses LZMA compression');
  await expect(bad.locator('.job-foot')).toContainText('Can’t convert');
  await app.settled(app.job('twine'));
});

// The browser's storage full while a deflated file is unpacked (DEBUG.unzipFull): the card says so, and
// nothing of the file stays in storage (audit 2026-10-05, M12)
test('a zip whose files fill the browser’s storage gets a card that says so, and leaves nothing behind', async ({ app, page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright\'s WebKit has no navigator.storage');
  const fx = fixture('ps1-single');
  const zip = writeZip('twine full.zip', fx.add.map(n => ({ name: n, data: read(n) })));
  await app.open({ debug: { unzipFull: true } });
  await app.add([zip]);
  await expect(app.job('twine full').locator('.note.err')).toContainText('twine.bin could not be unpacked (the browser’s storage is full)');
  const left = await page.evaluate(async () => {
    const files = async d => { let n = 0; for await (const h of d.values()) n += h.kind === 'file' ? 1 : await files(h); return n; };
    try { return await files(await (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-unzip')); } catch (e) { return 0; }
  });
  expect(left).toBe(1); // twine.cue, unpacked; not twine.bin
});

test('a file that is not a zip gets a card', async ({ app }) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fake.zip'), Buffer.alloc(4096, 7));
  await app.open();
  await app.add(['gen/zip/fake.zip']);
  await expect(app.job('fake').locator('.note.err')).toContainText('This zip can’t be read: it is not a zip archive, or it is damaged.');
});

test('without private storage, deflated files are unpacked into memory', async ({ app, page }) => {
  const fx = fixture('ps1-single');
  const zip = writeZip('twine mem.zip', fx.add.map(n => ({ name: n, data: read(n) })));
  await app.open({ noOpfs: true });
  await expect(page.locator('#chipStore')).toHaveText('Results in memory');
  await app.add([zip]);
  const card = app.job('twine');
  await app.settled(card);
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', fx.add[0])));
});
