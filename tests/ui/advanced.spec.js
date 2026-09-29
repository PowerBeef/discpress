// The Advanced tab: every chdman command through a form or as text.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { chdman, nativeChdman, reference, sameVersion, sha1File, info } from '../support/native.js';

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
  ['a TOC without track lengths', 'nolength.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "lone.bin"\n', 'the tracks hold no data'],
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
      fs.copyFileSync(reference('createdvd', 'agent.iso'), path.join(FIXTURES, 'chd', 'agent-dvd.chd'));
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
test('a new command, or Clear temporary storage, removes the last command’s results', async ({ app, page }) => {
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
