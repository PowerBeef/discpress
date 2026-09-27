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
