// Creating CHDs from every kind of input, checked against desktop chdman.
import { test, expect, manifest, fixture } from '../support/app.js';
import { engineReference, info, nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

const SYSTEM_BADGE = { ps1: 'PS1', ps2: 'PS2', psp: 'PSP', saturn: 'SAT', segacd: 'SCD', dc: 'DC' };

/** The CHD from the app must equal what desktop chdman makes from the same files. */
function expectSameAsNative(outPath, command, input, extra = []) {
  if (!nativeChdman()) return;
  const ref = reference(command, input, extra);
  if (sameVersion()) expect(sha1File(outPath), `${command} ${input} ${extra.join(' ')} byte for byte`).toBe(sha1File(ref));
  else expect(info(outPath).dataSha1).toBe(info(ref).dataSha1);
}

const inputOf = fx => fx.add.find(n => /\.(cue|gdi)$/i.test(n)) || fx.add[0];
const titleOf = fx => fx.title || inputOf(fx).replace(/\.[^.]+$/, '');

for (const fx of manifest().filter(f => f.job === 'create' && !f.bench && !f.testdb)) {
  test(`create: ${fx.key}`, async ({ app }) => {
    await app.open();
    await app.add(fx.add);
    await expect(app.jobs()).toHaveCount(1);
    const card = app.job(titleOf(fx));
    await app.settled(card);

    // identification
    if (fx.sys && SYSTEM_BADGE[fx.sys]) await expect(card.locator('.badge')).toContainText(SYSTEM_BADGE[fx.sys]);
    if (fx.serial) await expect(card.locator('.note.ident')).toContainText(fx.serial);
    if (fx.ident === 'serial') await expect(card.locator('.ident-how')).toHaveText('Matched by serial number');
    if (fx.ident === 'ambiguous') await expect(card.locator('.ident-how')).toContainText('several versions share it');
    if (fx.ident === 'none') await expect(card.locator('.ident-name')).toHaveCount(0);
    if (fx.warning) await expect(card).toContainText(fx.warning);

    // command and output name
    const expectedName = fx.name || fx.names[0];
    await expect(card.locator('code.cmd')).toContainText(`chdman ${fx.command} -i`);
    await app.run(card);
    await expect(card.locator('.result')).toContainText('Done.');
    const outs = await app.downloads(card);
    expect(outs.map(o => o.name)).toEqual([`${expectedName}.chd`]);

    const extra = fx.sys === 'psp' ? ['-hs', '2048'] : [];
    if (fx.key === 'ps1-lone-bin') return; // the app generates its own .cue for a lone .bin
    // `ref`: the input native chdman gets instead, when the app gives chdman a corrected or generated descriptor
    expectSameAsNative(outs[0].path, fx.command, fx.ref || inputOf(fx), extra);
  });
}

test('choosing between versions that share a serial number renames the output', async ({ app }) => {
  const fx = fixture('ps1-multitrack');
  await app.open();
  await app.add(fx.add);
  const card = app.job('mgs disc1');
  await app.settled(card);
  const pick = card.locator('.note.ident select');
  await expect(pick.locator('option')).toHaveText(fx.names);
  await pick.selectOption(fx.names[1]);
  await expect(card.locator('.ident-name')).toHaveText(fx.names[1]);
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(out.name).toBe(`${fx.names[1]}.chd`);
});

test('a custom output name wins over the game title', async ({ app }) => {
  await app.open();
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await card.locator('details.opts summary').click();
  await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('My Disc');
  await expect(card.locator('code.cmd')).toContainText('-o "My Disc.chd"');
  await app.run(card);
  const [out] = await app.downloads(card);
  expect(out.name).toBe('My Disc.chd');
});

test('renaming can be turned off in settings', async ({ app }) => {
  await app.open({ settings: { rename: false } });
  await app.add(fixture('ps1-single').add);
  const card = app.job('twine');
  await app.settled(card);
  await expect(card.locator('code.cmd')).toContainText('-o twine.chd');
});

const PRESETS = [
  ['Faster to create', { cd: ['-c', 'cdzl,cdfl'], dvd: ['-c', 'zlib,huff'] }],
  ['Faster to load (Zstd)', { cd: ['-c', 'cdzs,cdfl'], dvd: ['-c', 'zstd'] }],
  ['No compression', { cd: ['-c', 'none'], dvd: ['-c', 'none'] }],
];
for (const [label, codecs] of PRESETS) {
  for (const [key, disc] of [['ps1-multitrack', 'cd'], ['ps2-dvd', 'dvd']]) {
    test(`compression "${label}" on ${disc.toUpperCase()}`, async ({ app }) => {
      const fx = fixture(key);
      await app.open();
      await app.add(fx.add);
      const card = app.jobs().first();
      await app.settled(card);
      await card.locator('details.opts summary').click();
      await card.locator('label.field', { hasText: 'Compression' }).locator('select').selectOption({ label });
      await expect(card.locator('code.cmd')).toContainText(codecs[disc].join(' '));
      await app.run(card);
      const [out] = await app.downloads(card);
      expectSameAsNative(out.path, fx.command, inputOf(fx), codecs[disc]);
    });
  }
}

// "Nearly as small, faster" is the engine's codec plan (--codecplan): not chdman 0.289's bytes, but
// its checksums, and the native engine's bytes whether helper workers compress or not
for (const [key, disc] of [['ps1-multitrack', 'cd'], ['ps2-dvd', 'dvd']]) {
  for (const threads of [1, 4]) {
    test(`compression "Nearly as small, faster" on ${disc.toUpperCase()}, ${threads} thread(s)`, async ({ app }) => {
      const fx = fixture(key);
      await app.open({ settings: { threads } });
      await app.add(fx.add);
      const card = app.jobs().first();
      await app.settled(card);
      await card.locator('details.opts summary').click();
      await card.locator('label.field', { hasText: 'Compression' }).locator('select').selectOption({ label: 'Nearly as small, faster' });
      await expect(card.locator('code.cmd')).toContainText('--codecplan');
      await expect(card.locator('code.cmd')).not.toContainText(/\s-c\s/);
      await app.run(card);
      const [out] = await app.downloads(card);
      if (!nativeChdman()) return;
      const ref = info(reference(fx.command, inputOf(fx))), mine = info(out.path);
      expect([mine.sha1, mine.dataSha1]).toEqual([ref.sha1, ref.dataSha1]);
      const engine = engineReference(fx.command, inputOf(fx), ['--codecplan']);
      if (engine) expect(sha1File(out.path), 'the native engine\'s CHD, byte for byte').toBe(sha1File(engine));
    });
  }
}

for (const threads of [1, 2, 4]) {
  test(`${threads} compression thread(s) give identical output`, async ({ app }) => {
    const fx = fixture('ps2-dvd');
    await app.open({ settings: { threads } });
    await expect(app.page.locator('#chipThreads')).toHaveText(threads > 1 ? `${threads} threads` : '1 thread');
    await app.add(fx.add);
    const card = app.jobs().first();
    await app.settled(card);
    await app.run(card);
    const [out] = await app.downloads(card);
    expectSameAsNative(out.path, 'createdvd', 'agent.iso');
  });
}

test('start all runs every job in turn', async ({ app, page }) => {
  await app.open();
  await app.add([...fixture('ps1-single').add, ...fixture('saturn').add, ...fixture('segacd').add]);
  await expect(app.jobs()).toHaveCount(3);
  for (const t of ['twine', 'albert odyssey', 'ax101']) await app.settled(app.job(t));
  await expect(page.locator('#dock')).toBeVisible();
  await page.click('#startAll');
  for (const t of ['twine', 'albert odyssey', 'ax101']) await app.waitState(app.job(t), 'done');
  await expect(page.locator('#dockText')).toContainText(/3/);
  await expect(page.locator('#dlAll')).toBeVisible();
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  await page.click('#dlAll');
  await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(3);
  expect(downloads.sort()).toEqual(['007 - The World Is Not Enough (USA).chd', 'A-X-101 (USA).chd', 'Albert Odyssey - Legend of Eldean (USA).chd']);
  await page.click('#clearDone');
  await expect(app.jobs()).toHaveCount(0);
});
