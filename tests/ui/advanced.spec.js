// The Advanced tab: every chdman command through a form or as text.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { chdman, extract, nativeChdman, reference, sameVersion, sha1File, sharedCopy, info } from '../support/native.js';

async function openCli(app, page) {
  await app.open();
  await page.click('.tab[data-tab="cli"]');
}
async function addCliFiles(app, names) {
  await app.add(names, { via: '#cliAdd' });
}
async function runCli(page) {
  await page.click('#cliRun');
  await expect(page.locator('#cliConsole')).toContainText(/\[exit code \d+/, { timeout: 120_000 });
  return page.locator('#cliConsole').textContent();
}

test('lists every chdman command', async ({ app, page }) => {
  await openCli(app, page);
  const values = await page.locator('#cliCmd option').evaluateAll(o => o.map(x => x.value));
  expect(values.sort()).toEqual(['createcd', 'createdvd', 'createhd', 'createraw', 'createld', 'extractcd', 'extractdvd', 'extracthd',
    'extractraw', 'extractld', 'info', 'verify', 'copy', 'addmeta', 'delmeta', 'dumpmeta', 'listtemplates'].sort());
});

test('the form builds the command and createcd output matches desktop chdman', async ({ app, page }) => {
  await openCli(app, page);
  await addCliFiles(app, ['twine.cue', 'twine.bin']);
  await expect(page.locator('#cliPreview')).toHaveText('chdman createcd -i twine.cue -o twine.chd');
  await page.locator('#cliOpts label.field', { hasText: 'Compression codecs' }).locator('input').fill('cdzl,cdfl');
  await expect(page.locator('#cliPreview')).toHaveText('chdman createcd -i twine.cue -o twine.chd -c cdzl,cdfl');
  expect(await runCli(page)).toContain('[exit code 0]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#cliOuts button').first().click()]);
  expect(dl.suggestedFilename()).toBe('twine.chd');
  const p = test.info().outputPath('twine.chd');
  await dl.saveAs(p);
  if (nativeChdman()) {
    const ref = reference('createcd', 'twine.cue', ['-c', 'cdzl,cdfl']);
    if (sameVersion()) expect(sha1File(p)).toBe(sha1File(ref));
    else expect(info(p).dataSha1).toBe(info(ref).dataSha1);
  }
});

// A command whose results could be too large to keep in memory asks first, as on the Convert tab
// (memMax lowers the limit); declined, nothing runs (audit 2026-10-05, M12)
test('a command whose result may be too large for memory asks before it runs', async ({ app, page }) => {
  await app.open({ noOpfs: true, debug: { memMax: 100000 } });
  await page.click('.tab[data-tab="cli"]');
  await addCliFiles(app, ['twine.cue', 'twine.bin']);
  const asked = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { asked.push(d.message()); asked.length === 1 ? d.dismiss() : d.accept(); });
  await page.click('#cliRun');
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain('This browser keeps results in memory here');
  await expect(page.locator('#cliConsole')).not.toContainText('[exit code');
  expect(await runCli(page)).toContain('[exit code 0]');
  expect(asked).toHaveLength(2);
});

// A file added under the name of one listed replaced it without a word; a cue sheet chdman can't read as
// it is gets a pointer to the Convert tab, which corrects it (audit 2026-10-05)
test('a file of a listed name says it replaced it, and a raw cue sheet chdman can\'t read points to Convert', async ({ app, page }) => {
  const dir = path.join(FIXTURES, 'gen', 'cli lower');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'twine.bin'), path.join(dir, 'twine.bin'));
  fs.writeFileSync(path.join(dir, 'lower.cue'), 'file "twine.bin" binary\n  track 01 mode2/2352\n    index 01 00:00:00\n');
  await openCli(app, page);
  await addCliFiles(app, ['twine.bin']);
  await addCliFiles(app, ['gen/cli lower/lower.cue', 'gen/cli lower/twine.bin']);
  await expect(page.locator('#toasts')).toContainText('Replaced “twine.bin” in the list with the file of the same name just added.');
  await expect(page.locator('#cliFiles li')).toHaveCount(2);
  const out = await runCli(page);
  expect(out).toContain('[exit code 1');
  expect(out).toContain('Here chdman reads the CUE file as it is. The Convert tab corrects what chdman can’t read');
});

test('missing required options are reported instead of run', async ({ app, page }) => {
  await openCli(app, page);
  await page.locator('#cliCmd').selectOption('info');
  await expect(page.locator('#cliPreview')).toContainText('# still needed: Input file');
  await page.click('#cliRun');
  await expect(page.locator('#toasts')).toContainText('Please fill in: Input file');
});

// chdman 0.289 never finishes on these (0% forever, or -nan%); the engine reports an error
for (const [label, file, text, message] of [
  ['a .bin read as a cdrdao TOC, with no tracks', 'lone.bin', null, 'no tracks found'],
  // (not a length of 0, which cdrdao, and the engine, read as the rest of the file)
  ['a TOC whose track holds no data', 'nolength.toc', 'CD_ROM\nTRACK MODE1_RAW\nNO COPY\n', 'track 1 holds no data'],
]) {
  test(`a command chdman would never finish is an error: ${label}`, async ({ app, page }) => {
    if (text) fs.writeFileSync(path.join(FIXTURES, file), text);
    await app.open({ settings: { threads: 4 } });
    await page.click('.tab[data-tab="cli"]');
    await addCliFiles(app, text ? [file, 'lone.bin'] : [file]);
    await page.click('#cliEditToggle');
    await page.locator('#cliText').fill(`chdman createcd -i ${file} -o stuck.chd`);
    await page.click('#cliRun');
    await expect(page.locator('#cliConsole')).toContainText(message, { timeout: 20_000 });
    await expect(page.locator('#cliRun')).toBeEnabled();
  });
}

// chdman 0.289 aborts (throw nullptr) or divides by zero on these; the engine reports an error instead
for (const [label, input, command, message] of [
  ['extracting a DVD CHD as a CD', 'dvd', 'chdman extractcd -i agent-dvd.chd -o out.cue', 'is not a CD-ROM or GD-ROM'],
  ['a unit size of 0', 'agent.iso', 'chdman createraw -i agent.iso -o raw.chd -us 0', 'Invalid unit size'],
]) {
  test(`${label} is an error, not a crash`, async ({ app, page }) => {
    let file = input;
    if (input === 'dvd') {
      test.skip(!nativeChdman(), 'needs native chdman to make the CHD');
      fs.mkdirSync(path.join(FIXTURES, 'chd'), { recursive: true });
      sharedCopy(reference('createdvd', 'agent.iso'), path.join(FIXTURES, 'chd', 'agent-dvd.chd'));
      file = 'chd/agent-dvd.chd';
    }
    await openCli(app, page);
    await addCliFiles(app, [file]);
    await page.click('#cliEditToggle');
    await page.locator('#cliText').fill(command);
    const out = await runCli(page);
    expect(out).toContain('[exit code 1]');
    expect(out).toContain(message);
  });
}

test('commands can be typed as text', async ({ app, page }) => {
  await openCli(app, page);
  await addCliFiles(app, ['agent.iso']);
  await page.click('#cliEditToggle');
  await page.locator('#cliText').fill('chdman createdvd -i agent.iso -o typed.chd -hs 2048');
  expect(await runCli(page)).toContain('[exit code 0]');
  await expect(page.locator('#cliOuts')).toContainText('typed.chd');
});

test('text commands must name files that were added', async ({ app, page }) => {
  await openCli(app, page);
  await page.click('#cliEditToggle');
  await page.locator('#cliText').fill('chdman info -i nothere.chd');
  await page.click('#cliRun');
  await expect(page.locator('#toasts')).toContainText('"nothere.chd" is not in the file list');
});

test('listtemplates prints the hard disk templates', async ({ app, page }) => {
  await openCli(app, page);
  await page.locator('#cliCmd').selectOption('listtemplates');
  await expect(page.locator('#cliOpts')).toContainText('This command has no options.');
  const out = await runCli(page);
  expect(out).toContain('[exit code 0]');
  expect(out).toMatch(/Conner|Seagate|Quantum/);
});

test('addmeta edits a copy of the CHD in place, exactly like desktop chdman', async ({ app, page }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  // metadata can only be added to uncompressed CHDs; chdman rewrites parts of the file in place
  const src = reference('createdvd', 'homebrew.iso', ['-c', 'none']);
  const dir = path.join(FIXTURES, 'chd');
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, 'meta.chd');
  fs.copyFileSync(src, input);
  const expected = test.info().outputPath('expected.chd');
  fs.copyFileSync(src, expected);
  chdman(['addmeta', '-i', expected, '-t', 'TEST', '-vt', 'hello from the tests']);

  await openCli(app, page);
  await addCliFiles(app, ['chd/meta.chd']);
  await page.locator('#cliCmd').selectOption('addmeta');
  await page.locator('#cliOpts label.field', { hasText: 'Metadata tag' }).locator('input').fill('TEST');
  await page.locator('#cliOpts label.field', { hasText: 'Text value' }).locator('input').fill('hello from the tests');
  expect(await runCli(page)).toContain('[exit code 0]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#cliOuts button').first().click()]);
  const got = test.info().outputPath('meta.chd');
  await dl.saveAs(got);
  expect(sha1File(got)).toBe(sha1File(expected));
});

// audit, batch 3: typed commands read quotes the way the form writes them, and as phones type them
test('typed commands accept single quotes and smart quotes around file names', async ({ app, page }) => {
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'agent.iso'), path.join(dir, 'my game.iso'));
  await openCli(app, page);
  await addCliFiles(app, ['gen/my game.iso']);
  await page.click('#cliEditToggle');
  await page.locator('#cliText').fill("chdman createdvd -i 'my game.iso' -o “my game.chd” -c none");
  expect(await runCli(page)).toContain('[exit code 0]');
  await expect(page.locator('#cliOuts')).toContainText('my game.chd');
});

// audit, batch 3: each run's results used to stay in private storage until the next visit
test('a new command, or Clear temporary storage, removes the last command’s results', async ({ app, page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright\'s WebKit has no navigator.storage');

  const workDirs = () => page.evaluate(async () => {
    const out = [];
    try {
      const work = await (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-work');
      for await (const [, s] of work.entries()) for await (const [n] of s.entries()) out.push(n);
    } catch (e) { /* none */ }
    return out.filter(n => n.startsWith('cli'));
  });
  await openCli(app, page);
  await addCliFiles(app, ['twine.cue', 'twine.bin']);
  expect(await runCli(page)).toContain('[exit code 0]');
  await expect.poll(workDirs).toHaveLength(1);
  const first = (await workDirs())[0];
  expect(await runCli(page)).toContain('[exit code 0]'); // unsaved: the harness agrees to delete them
  await expect.poll(workDirs).toHaveLength(1);
  expect((await workDirs())[0]).not.toBe(first);
  await page.click('#settingsBtn');
  await page.click('#clearStorage');
  await page.click('#settingsClose');
  await expect.poll(workDirs).toEqual([]);
  await expect(page.locator('#cliOuts')).toBeEmpty();
});

test('typed commands accept backslash escapes, as a shell does', async ({ app, page }) => {
  const dir = path.join(FIXTURES, 'gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'agent.iso'), path.join(dir, 'my game.iso'));
  await openCli(app, page);
  await addCliFiles(app, ['gen/my game.iso']);
  await page.click('#cliEditToggle');
  await page.locator('#cliText').fill('chdman createdvd -i my\\ game.iso -o "the \\"best\\" game.chd" -c none');
  expect(await runCli(page)).toContain('[exit code 0]');
  await expect(page.locator('#cliOuts')).toContainText('the "best" game.chd');
});

test('typed commands keep an apostrophe inside a name, typed either way', async ({ app, page }) => {
  await openCli(app, page);
  // (as a buffer: Playwright's file chooser drops a path with \u2019 in it)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#cliAdd')]);
  await chooser.setFiles([{ name: 'Tony Hawk\u2019s.iso', mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(FIXTURES, 'agent.iso')) }]);
  await page.click('#cliEditToggle');
  await page.locator('#cliText').fill('chdman createdvd -i “Tony Hawk’s.iso” -o “Tony Hawk’s.chd” -c none');
  expect(await runCli(page)).toContain('[exit code 0]');
  await expect(page.locator('#cliOuts')).toContainText('Tony Hawk’s.chd');
});

// ---- each command through the form, against desktop chdman (audit 2026-10-05, M10) ----

// every result of the last command, downloaded: [{name, path}]
async function cliResults(page) {
  const buttons = page.locator('#cliOuts .out button'), out = [];
  for (let i = 0; i < await buttons.count(); i++) {
    const [dl] = await Promise.all([page.waitForEvent('download'), buttons.nth(i).click()]);
    const p = test.info().outputPath('results', dl.suggestedFilename());
    await dl.saveAs(p);
    out.push({ name: dl.suggestedFilename(), path: p });
  }
  return out;
}
async function pickCommand(page, cmd, fields = {}) {
  await page.locator('#cliCmd').selectOption(cmd);
  for (const [label, value] of Object.entries(fields)) {
    const f = page.locator('#cliOpts label.field', { hasText: label });
    if (await f.locator('select').count()) await f.locator('select').selectOption(value);
    else await f.locator('input').fill(value);
  }
}
// a CHD of desktop chdman's, in the fixtures' chd/ folder (for this file's tests)
function nativeChd(name, command, input, extra = []) {
  const p = path.join(FIXTURES, 'chd', name);
  sharedCopy(reference(command, input, extra), p);
  return { rel: 'chd/' + name, path: p };
}

test('copy writes <name>-copy.chd, the CHD desktop chdman copies', async ({ app, page }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  const src = nativeChd('copy src.chd', 'createcd', 'twine.cue');
  await openCli(app, page);
  await addCliFiles(app, [src.rel]);
  await pickCommand(page, 'copy', { 'Compression codecs': 'cdzl,cdfl' });
  await expect(page.locator('#cliPreview')).toHaveText('chdman copy -i "copy src.chd" -o "copy src-copy.chd" -c cdzl,cdfl');
  expect(await runCli(page)).toContain('[exit code 0]');
  const [got] = await cliResults(page);
  expect(got.name).toBe('copy src-copy.chd');
  const ref = test.info().outputPath('ref.chd');
  chdman(['copy', '-i', src.path, '-o', ref, '-c', 'cdzl,cdfl']);
  if (sameVersion()) expect(sha1File(got.path)).toBe(sha1File(ref));
});

test('dumpmeta writes a tag’s metadata to <name>.bin, as desktop chdman does', async ({ app, page }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  const src = nativeChd('dump src.chd', 'createcd', 'mgs disc1.cue');
  await openCli(app, page);
  await addCliFiles(app, [src.rel]);
  await pickCommand(page, 'dumpmeta', { 'Metadata tag': 'CHT2', 'Metadata index': '1' });
  expect(await runCli(page)).toContain('[exit code 0]');
  const [got] = await cliResults(page);
  expect(got.name).toBe('dump src.bin');
  const ref = test.info().outputPath('ref.bin');
  chdman(['dumpmeta', '-i', src.path, '-o', ref, '-t', 'CHT2', '-ix', '1']);
  expect(fs.readFileSync(got.path)).toEqual(fs.readFileSync(ref));
});

test('delmeta edits a copy of the CHD in place, exactly like desktop chdman', async ({ app, page }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  const dir = path.join(FIXTURES, 'chd');
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, 'delmeta.chd');
  sharedCopy(reference('createdvd', 'homebrew.iso', ['-c', 'none']), input);
  chdman(['addmeta', '-i', input, '-t', 'TEST', '-vt', 'to be removed']);
  const expected = test.info().outputPath('expected.chd');
  fs.copyFileSync(input, expected);
  chdman(['delmeta', '-i', expected, '-t', 'TEST']);
  await openCli(app, page);
  await addCliFiles(app, ['chd/delmeta.chd']);
  await pickCommand(page, 'delmeta', { 'Metadata tag': 'TEST' });
  expect(await runCli(page)).toContain('[exit code 0]');
  const [got] = await cliResults(page);
  expect(got.name).toBe('delmeta.chd');
  expect(sha1File(got.path)).toBe(sha1File(expected));
});

test('verify --fix on a sound CHD leaves it as it was', async ({ app, page }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  const src = nativeChd('fix src.chd', 'createdvd', 'homebrew.iso', ['-c', 'none']);
  await openCli(app, page);
  await addCliFiles(app, [src.rel]);
  await pickCommand(page, 'verify');
  await page.locator('#cliOpts label.check', { hasText: 'Fix the SHA-1' }).locator('input').check();
  await expect(page.locator('#cliPreview')).toHaveText('chdman verify -i "fix src.chd" -f');
  expect(await runCli(page)).toContain('[exit code 0]');
  const [got] = await cliResults(page);
  expect(sha1File(got.path)).toBe(sha1File(src.path));
});

// creating a hard disk CHD, and extracting each kind through the form: the files desktop chdman makes
for (const [label, make, cmd, fields, outName, nativeArgs] of [
  ['createhd', null, 'createhd', {}, 'arcade.chd', null],
  ['extractcd (cue/bin)', ['x cd.chd', 'createcd', 'mgs disc1.cue'], 'extractcd', {}, 'x cd.cue', []],
  ['extractcd (one .bin per track)', ['x cd.chd', 'createcd', 'mgs disc1.cue'], 'extractcd', { sb: true }, 'x cd.cue', ['-sb']],
  ['extractdvd', ['x dvd.chd', 'createdvd', 'homebrew.iso'], 'extractdvd', {}, 'x dvd.iso', []],
  ['extracthd', ['x hd.chd', 'createhd', 'arcade.img'], 'extracthd', {}, 'x hd.img', []],
  ['extractraw', ['x raw.chd', 'createraw', 'arcade.img', ['-hs', '4096', '-us', '512']], 'extractraw', {}, 'x raw.raw', []],
]) {
  test(`${label} through the form gives desktop chdman's files`, async ({ app, page }) => {
    test.skip(!nativeChdman(), 'needs native chdman');
    await openCli(app, page);
    let src = null;
    if (make) {
      src = nativeChd(make[0], make[1], make[2], make[3] || []);
      await addCliFiles(app, [src.rel]);
    } else await addCliFiles(app, ['arcade.img']);
    await pickCommand(page, cmd);
    if (fields.sb) await page.locator('#cliOpts label.check', { hasText: 'One .bin file per track' }).locator('input').check();
    await expect(page.locator('#cliOpts label.field', { hasText: 'Output file name' }).locator('input')).toHaveValue(outName);
    expect(await runCli(page)).toContain('[exit code 0]');
    const outs = await cliResults(page);
    if (!make) {
      expect(outs.map(o => o.name)).toEqual(['arcade.chd']);
      if (sameVersion()) expect(sha1File(outs[0].path)).toBe(sha1File(reference('createhd', 'arcade.img')));
      return;
    }
    const x = extract(cmd, src.path, outName, nativeArgs);
    expect(outs.map(o => o.name).sort()).toEqual(x.files);
    for (const o of outs) expect(sha1File(o.path), o.name).toBe(sha1File(path.join(x.dir, o.name)));
  });
}
