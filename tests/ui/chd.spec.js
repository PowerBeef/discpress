// Working with existing CHDs: identify, extract, verify, info, rename, parents.
// Input CHDs are made with native chdman, so these tests need it.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { chdman, extract, info, nativeChdman, reference, sha1File } from '../support/native.js';

test.skip(() => !nativeChdman(), 'needs native chdman to make input CHDs');

/** Put a native-made CHD into the fixtures dir as chd/<name>.chd; returns the relative name. */
function chdInput(name, command, input, extra = []) {
  const dir = path.join(FIXTURES, 'chd');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.chd`);
  if (!fs.existsSync(dst)) {
    fs.copyFileSync(reference(command, input, extra), dst + '.tmp' + process.pid);
    fs.renameSync(dst + '.tmp' + process.pid, dst);
  }
  return `chd/${name}.chd`;
}

function sameFiles(outs, native) {
  expect(outs.map(o => o.name).sort()).toEqual(native.files);
  for (const o of outs) expect(sha1File(o.path), o.name).toBe(sha1File(path.join(native.dir, o.name)));
}

/** The fixture's own files: its cue sheets are written as Redump's (CRLF, Redump's file names). */
function sameAsFixture(outs, names) {
  expect(outs.map(o => o.name).sort()).toEqual([...names].sort());
  for (const o of outs) expect(sha1File(o.path), o.name).toBe(sha1File(path.join(FIXTURES, o.name)));
}

async function openChd(app, rel, title) {
  await app.open();
  await app.add([rel]);
  const card = app.job(title);
  await app.settled(card);
  return card;
}

test('a CD CHD is identified from its contents and described', async ({ app }) => {
  const card = await openChd(app, chdInput('mgs', 'createcd', 'mgs disc1.cue'), 'mgs');
  await expect(card.locator('.sub')).toContainText('CD-ROM · 2 tracks');
  await expect(card.locator('.badge')).toContainText('PS1');
  await expect(card.locator('.note.ident')).toContainText('SLUS-00594');
  await expect(card.locator('.seg button')).toHaveText(['Extract', 'Verify', 'Info', 'Rename']);
});

for (const [label, fmt, args, ext] of [
  ['CUE + BIN (one .bin)', 'cue', [], '.cue'],
  ['CUE + BIN (one .bin per track)', 'cue-split', ['-sb'], '.cue'],
  ['TOC + BIN (cdrdao)', 'toc', [], '.toc'],
]) {
  test(`extract a CD CHD as ${fmt}`, async ({ app }) => {
    const card = await openChd(app, chdInput('mgs', 'createcd', 'mgs disc1.cue'), 'mgs');
    await card.locator('label.field', { hasText: 'Save as' }).locator('select').selectOption({ label });
    await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('mgs out');
    await app.run(card);
    const outs = await app.downloads(card);
    sameFiles(outs, extract('extractcd', path.join(FIXTURES, 'chd/mgs.chd'), 'mgs out' + ext, args));
  });
}

// Redump's layout (the engine's extractcd --redump, the default for CDs): the files of the original
// dump come back byte for byte, cue sheet included, with one .bin per track unless there is only one
for (const [key, title] of [['ps1-multitrack', 'mgs disc1'], ['ps1-single', 'twine'], ['music-cd', 'piano']]) {
  test(`extracting a CD CHD gives back the Redump dump it was made from: ${key}`, async ({ app }) => {
    const fx = fixture(key);
    const card = await openChd(app, chdInput(key, 'createcd', fx.add.find(n => n.endsWith('.cue'))), key);
    await expect(card.locator('label.field', { hasText: 'Save as' }).locator('select')).toHaveValue('redump');
    await expect(card.locator('label.field', { hasText: 'Save as' })).toContainText('match Redump');
    await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill(title);
    await expect(card.locator('code.cmd')).toContainText(title.includes(' ') ? `-o "${title}.cue" --redump` : `-o ${title}.cue --redump`);
    await app.run(card);
    sameAsFixture(await app.downloads(card), fx.add);
  });
}

test('a GD-ROM CHD extracts as its Redump dump too', async ({ app }) => {
  const fx = fixture('dreamcast-cue');
  const card = await openChd(app, chdInput('aerowings-cue', 'createcd', 'aerowings.cue'), 'aerowings-cue');
  await card.locator('label.field', { hasText: 'Save as' }).locator('select').selectOption({ label: 'CUE + BIN, as Redump' });
  await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('aerowings');
  await app.run(card);
  sameAsFixture(await app.downloads(card), fx.add);
});

test('extract a GD-ROM CHD as GDI', async ({ app }) => {
  const card = await openChd(app, chdInput('aerowings', 'createcd', 'aerowings.gdi'), 'aerowings');
  await expect(card.locator('.sub')).toContainText('GD-ROM');
  await expect(card.locator('.badge')).toContainText('DC');
  await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('aw');
  await app.run(card);
  const outs = await app.downloads(card);
  sameFiles(outs, extract('extractcd', path.join(FIXTURES, 'chd/aerowings.chd'), 'aw.gdi'));
});

for (const [name, command, input, xcmd, ext] of [
  ['agent', 'createdvd', 'agent.iso', 'extractdvd', '.iso'],
  ['arcade', 'createhd', 'arcade.img', 'extracthd', '.img'],
]) {
  test(`extract a ${command.slice(6).toUpperCase()} CHD back to the original ${ext}`, async ({ app }) => {
    const card = await openChd(app, chdInput(name, command, input), name);
    await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('x');
    await app.run(card);
    const [out] = await app.downloads(card);
    expect(out.name).toBe('x' + ext);
    expect(sha1File(out.path)).toBe(sha1File(path.join(FIXTURES, input)));
    void xcmd;
  });
}

/** agent.chd with 64 bytes of its compressed data changed, as chd/damaged.chd */
function damagedChd() {
  const good = chdInput('agent', 'createdvd', 'agent.iso');
  const badPath = path.join(FIXTURES, 'chd', 'damaged.chd');
  if (!fs.existsSync(badPath)) {
    const b = fs.readFileSync(path.join(FIXTURES, good));
    for (let i = 0; i < 64; i++) b[Math.floor(b.length * 0.6) + i] ^= 0x5a; // inside the compressed data
    fs.writeFileSync(badPath + '.tmp' + process.pid, b);
    fs.renameSync(badPath + '.tmp' + process.pid, badPath);
  }
  return 'chd/damaged.chd';
}

test('verify passes on a good CHD and fails on a damaged one', async ({ app }) => {
  const good = chdInput('agent', 'createdvd', 'agent.iso');
  damagedChd();
  await app.open();
  await app.add([good, 'chd/damaged.chd']);
  for (const [title, state, text] of [['agent', 'done', 'Verified.'], ['damaged', 'error', 'Verification failed.']]) {
    const card = app.job(title);
    await app.settled(card);
    await card.locator('.seg button', { hasText: 'Verify' }).click();
    await app.run(card, { expectState: state });
    await expect(card).toContainText(text);
  }
});

// Extract and verify read ahead: helper workers decompress the hunks about to be read, or with one
// thread the stored data of a window is read in one go and kept (chd_file::wasm_read_ahead). Either
// way the files are native chdman's, and so is the error for damaged data.
for (const threads of [1, 4]) {
  test(`extract and verify with ${threads} thread${threads > 1 ? 's' : ''}: same files and errors as desktop chdman`, async ({ app }) => {
    const cd = chdInput('codec-mix-cd', 'createcd', 'codec mix cd.cue');
    const dvd = chdInput('agent', 'createdvd', 'agent.iso');
    await app.open({ settings: { threads } });
    await app.add([cd, dvd, damagedChd()]);

    let card = app.job('codec-mix-cd');
    await app.settled(card);
    await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('codec mix cd');
    await app.run(card);
    sameAsFixture(await app.downloads(card), fixture('codec-mix-cd').add); // Redump's layout, the default

    card = app.job('agent');
    await app.settled(card);
    await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('x');
    await app.run(card);
    const [iso] = await app.downloads(card);
    expect(sha1File(iso.path)).toBe(sha1File(path.join(FIXTURES, 'agent.iso')));

    card = app.job('damaged');
    await app.settled(card);
    await card.locator('.seg button', { hasText: 'Verify' }).click();
    await app.run(card, { expectState: 'error' });
    await expect(card).toContainText('Verification failed.');
    await expect(card).toContainText('Decompression error'); // chdman's own message
  });
}

test('verify fails when the data does not match the checksum in the header', async ({ app }) => {
  // chdman 0.289 only prints the mismatch and exits 0, so the page reported "Verified."
  const good = chdInput('agent', 'createdvd', 'agent.iso');
  const b = fs.readFileSync(path.join(FIXTURES, good));
  b[64] ^= 0xff; // first byte of the raw SHA-1 in the CHD v5 header
  fs.writeFileSync(path.join(FIXTURES, 'chd', 'badsum.chd'), b);
  const card = await openChd(app, 'chd/badsum.chd', 'badsum');
  await card.locator('.seg button', { hasText: 'Verify' }).click();
  await app.run(card, { expectState: 'error' });
  await expect(card).toContainText('Verification failed.');
});

test('info shows the same checksums as desktop chdman', async ({ app }) => {
  const rel = chdInput('agent', 'createdvd', 'agent.iso');
  const card = await openChd(app, rel, 'agent');
  await card.locator('.seg button', { hasText: 'Info' }).click();
  await app.run(card);
  const native = info(path.join(FIXTURES, rel));
  const kv = card.locator('.result dl.kv');
  await expect(kv.locator('dt', { hasText: /^SHA1$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText(native.sha1);
  await expect(kv.locator('dt', { hasText: /^Data SHA1$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText(native.dataSha1);
});

test('rename saves an identical copy under the game title', async ({ app }) => {
  const rel = chdInput('twine', 'createcd', 'twine.cue');
  const card = await openChd(app, rel, 'twine');
  await card.locator('.seg button', { hasText: 'Rename' }).click();
  await expect(card.locator('.job-foot button.primary')).toHaveText(/Save renamed copy/);
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${fixture('ps1-single').name}.chd`);
  expect(sha1File(out.path)).toBe(sha1File(path.join(FIXTURES, rel)));
});

test('a child CHD finds its parent and extracts', async ({ app }) => {
  const parent = chdInput('parent', 'createdvd', 'agent.iso');
  const dir = path.join(FIXTURES, 'chd');
  const child = path.join(dir, 'child.chd');
  // the child is a slightly different disc (a patched copy), stored as a delta against the parent
  const patched = path.join(dir, 'patched.iso');
  if (!fs.existsSync(child)) {
    const b = fs.readFileSync(path.join(FIXTURES, 'agent.iso'));
    b.write('PATCHED BY TEST', 40 * 2048);
    fs.writeFileSync(patched, b);
    chdman(['createdvd', '-i', patched, '-o', child, '-op', path.join(dir, 'parent.chd'), '-f']);
  }
  await app.open();
  await app.add(['chd/child.chd']);
  const card = app.job('child');
  await app.settled(card);
  await expect(card).toContainText('This CHD depends on a parent CHD');
  await app.add([parent]);
  await expect(card).toContainText('Uses parent CHD parent.chd');
  await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('child');
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(sha1File(out.path)).toBe(sha1File(patched));
});

test('a CHD is never used as its own parent', async ({ app }) => {
  // a child made against a parent with identical data carries its own SHA-1 as the parent's
  const dir = path.join(FIXTURES, 'chd');
  const parent = path.join(dir, 'same-parent.chd'), child = path.join(dir, 'same-child.chd');
  if (!fs.existsSync(child)) {
    fs.copyFileSync(reference('createdvd', 'homebrew.iso'), parent);
    chdman(['createdvd', '-i', 'homebrew.iso', '-o', child, '-op', parent, '-f']);
  }
  await app.open();
  await app.add(['chd/same-child.chd']);
  const card = app.job('same-child');
  await app.settled(card);
  await expect(card).toContainText('This CHD depends on a parent CHD');
  await expect(card.locator('code.cmd')).not.toContainText('-ip');
  await app.add(['chd/same-parent.chd']);
  await expect(card).toContainText('Uses parent CHD same-parent.chd');
  await expect(card.locator('code.cmd')).toContainText('-ip same-parent.chd');
});
