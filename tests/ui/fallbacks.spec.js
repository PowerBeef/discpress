// Paths the app takes on older or restricted browsers, forced on in Chromium.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { engineReference, info, nativeChdman, reference, sameVersion, sha1File, sharedCopy } from '../support/native.js';

async function convertAgent(app) {
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman()) {
    const ref = reference('createdvd', 'agent.iso');
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  }
  return card;
}

test('without WebAssembly SIMD the baseline build is used and gives the same result', async ({ app, page }) => {
  await app.open({ noSimd: true });
  await convertAgent(app);
  // the build that was loaded has its embedded copy cleared
  expect(await page.locator('#wasm-base').evaluate(n => n.textContent.length)).toBe(0);
  expect(await page.locator('#wasm-simd').evaluate(n => n.textContent.length)).toBeGreaterThan(0);
});

// the faster presets use the engine's codec plan and libdeflate, whose output must not depend on SIMD
test('without SIMD the faster presets give the native engine\'s CHDs', async ({ app }) => {
  await app.open({ noSimd: true, settings: { threads: 2 } });
  for (const [key, input, command, label, own] of [
    ['ps1-multitrack', 'mgs disc1.cue', 'createcd', 'Nearly as small, faster', ['--codecplan', '--libdeflate']],
    ['ps2-dvd', 'agent.iso', 'createdvd', 'Faster to create', ['-c', 'zlib,huff', '--libdeflate']],
  ]) {
    await app.add(fixture(key).add);
    const card = app.jobs().last();
    await app.settled(card);
    await card.locator('details.opts summary').click();
    await card.locator('label.field', { hasText: 'Compression' }).locator('select').selectOption({ label });
    await app.run(card);
    const [out] = await app.downloads(card);
    const engine = engineReference(command, input, own);
    if (engine) expect(sha1File(out.path), `${input}, ${label}`).toBe(sha1File(engine));
  }
});

test('with SIMD the SIMD build is used', async ({ app, page }) => {
  await app.open();
  expect(await page.locator('#wasm-simd').evaluate(n => n.textContent.length)).toBe(0);
});

test('without private storage (OPFS) results are kept in memory', async ({ app, page }) => {
  await app.open({ noOpfs: true });
  await expect(page.locator('#chipStore')).toHaveText('Results in memory');
  await expect(page.locator('#memTip')).toBeVisible();
  await convertAgent(app);
});

test('"memory only" setting keeps results in memory', async ({ app, page }) => {
  await app.open({ settings: { storage: 'memory' } });
  await expect(page.locator('#chipStore')).toHaveText('Results in memory');
  await convertAgent(app);
});

test('private storage is used when available', async ({ app, page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright\'s WebKit has no navigator.storage');

  await app.open();
  await expect(page.locator('#chipStore')).toHaveText('Large files OK');
});

test('inputs the worker cannot read directly are copied to storage first', async ({ app }) => {
  await app.open({ debug: { stage: 1 } });
  const card = await convertAgent(app);
  await expect(card.locator('pre.logtext')).toContainText('is copied to private storage first');
});

test('if the worker cannot read them at all, the page streams inputs to it (iOS web view path)', async ({ app }) => {
  await app.open({ debug: { stage: 2 } });
  const card = await convertAgent(app);
  await expect(card.locator('pre.logtext')).toContainText('is copied to private storage first');
});

// Cancel while the page streams an input to the worker: the job stops, and runs again from the start
// (audit 2026-10-05, M12)
test('a job canceled while its input is streamed to the worker stops, and runs again', async ({ app }) => {
  await app.open({ debug: { stage: 2 }, settings: { threads: 1 } });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await expect(card.locator('pre.logtext')).toContainText('is copied to private storage first', { timeout: 60_000 });
  await card.locator('.job-foot button.danger', { hasText: 'Cancel' }).click();
  await app.waitState(card, 'canceled');
  await card.locator('.job-foot button', { hasText: 'Try again' }).click();
  await app.run(card);
  const [out] = await app.downloads(card);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createdvd', 'agent.iso')));
});

test('a compressed ISO the worker cannot read directly is copied, then decompressed as usual', async ({ app }) => {
  await app.open({ debug: { stage: 2 } });
  await app.add(['umd v2.cso']);
  const card = app.jobs().first();
  await app.settled(card);
  await app.run(card);
  await expect(card.locator('pre.logtext')).toContainText('is copied to private storage first');
  const [out] = await app.downloads(card);
  if (nativeChdman()) {
    const ref = reference('createdvd', 'umd.iso', ['-hs', '2048']);
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  }
});

test('ECM images the worker cannot read directly are copied, then unpacked as usual', async ({ app }) => {
  await app.open({ debug: { stage: 2 } });
  await app.add(fixture('segacd-ecm').add);
  const card = app.job('ax101');
  await app.settled(card);
  await app.run(card);
  await expect(card.locator('pre.logtext')).toContainText('is copied to private storage first');
  const [out] = await app.downloads(card);
  if (nativeChdman()) {
    const ref = reference('createcd', 'ax101.cue');
    if (sameVersion()) expect(sha1File(out.path)).toBe(sha1File(ref));
    else expect(info(out.path).dataSha1).toBe(info(ref).dataSha1);
  }
});

test('a single CPU core still converts (no helper workers)', async ({ app, page }) => {
  await app.open({ cores: 1 });
  await expect(page.locator('#chipThreads')).toContainText('1 thread');
  await convertAgent(app);
});

test('a helper thread that fails to start stops the job with a message instead of hanging', async ({ app, page }) => {
  // the second helper gets WebAssembly that won't compile (as when an iPhone runs out of memory for it)
  await page.addInitScript(() => {
    let n = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, transfer) {
      if (msg && msg.type === 'helper' && ++n === 2) { msg = { ...msg, wasmModule: undefined, wasmBytes: new Uint8Array([0, 97, 115, 109, 9]) }; }
      return post.call(this, msg, transfer);
    };
  });
  await app.open({ settings: { threads: 4 } });
  app.allowErrors(/WebAssembly|CompileError|helper/i);
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await app.run(card, { expectState: 'error', timeout: 30_000 });
  await expect(card).toContainText('A helper thread stopped');
  await expect(card).toContainText('Try again with fewer threads');
});

// Some Safari versions' WebAssembly compilers miscompile now and then, and a helper or the job worker traps
// ("Out of bounds memory access", docs/ios/README.md). DEBUG.failHelpers makes helpers fail that way:
// the others take over a helper's work, and when none is left the job runs once more; the CHD is the same.
for (const [mode, logged] of [['one', 'A helper thread stopped (Out of bounds memory access'], ['all', 'Converting again']]) {
  test(`a helper whose WebAssembly traps doesn't fail the conversion (${mode === 'one' ? 'one helper' : 'every helper, on the first run'})`, async ({ app }) => {
    await app.open({ settings: { threads: 4 }, debug: { failHelpers: mode } });
    const card = await convertAgent(app);
    await expect(card.locator('pre.logtext')).toContainText(logged);
    await expect(card.locator('.result')).toContainText('Done.');
  });
}

test('when the engine fails again, the error says what to do about the browser, not about threads', async ({ app }) => {
  await app.open({ settings: { threads: 4 }, debug: { failHelpers: 'always' } });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await app.run(card, { expectState: 'error' });
  await expect(card).toContainText('Multi-core compression failed (Out of bounds memory access');
  await expect(card).toContainText('This is a fault in the browser, not in your files. Update the browser, or convert in another one.');
  await expect(card).not.toContainText('1 thread');
  await expect(card.locator('pre.logtext')).toContainText('Converting again');
});

test('extract and verify go on when helpers fail: the others, or the job worker, decompress their hunks', async ({ app }) => {
  test.skip(!nativeChdman(), 'needs native chdman to make the CHD');
  const dir = path.join(FIXTURES, 'chd');
  fs.mkdirSync(dir, { recursive: true });
  sharedCopy(reference('createdvd', 'agent.iso'), path.join(dir, 'agent-fault.chd'));
  for (const mode of ['one', 'always']) {
    await app.open({ settings: { threads: 4 }, debug: { failHelpers: mode } });
    await app.add(['chd/agent-fault.chd']);
    const card = app.job('agent-fault');
    await app.settled(card);
    await card.locator('.seg button', { hasText: 'Verify' }).click();
    await app.run(card);
    await expect(card).toContainText('Verified.');
    await card.locator('.job-foot button', { hasText: 'Run again' }).click();
    await card.locator('.seg button', { hasText: 'Extract' }).click();
    await app.run(card);
    const [out] = await app.downloads(card);
    expect(sha1File(out.path), mode).toBe(sha1File(path.join(FIXTURES, 'agent.iso')));
    await expect(card.locator('pre.logtext')).toContainText('A helper thread stopped');
  }
});
