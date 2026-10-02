// The per-console and per-disc rules (app/quirks.js) and the compression warnings (PROFILES): settings
// that would make a CHD some emulators can't load are left out or warned about, never applied silently.
import { test, expect, fixture } from '../support/app.js';
import { nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

async function card(app, key, title) {
  await app.add(fixture(key).add);
  const c = app.job(title);
  await app.settled(c);
  return c;
}

// Kronos, Yabause (Saturn) and jgenesis (Sega CD) fail on any metadata tag that isn't a track's, so a
// kept cue sheet makes the CHD unbootable there: those jobs give chdman's own CHD instead
test('with "keep the cue sheet" on, Saturn and Sega CD games leave it out and say why', async ({ app }) => {
  await app.open({ settings: { keepCue: true } });
  const sat = await card(app, 'saturn', 'albert odyssey');
  const scd = await card(app, 'segacd', 'ax101');
  for (const c of [sat, scd]) {
    await expect(c.locator('code.cmd')).not.toContainText('--keepcue');
    await expect(c.locator('.compat-note[data-quirk="keepcue-strict"]')).toBeVisible();
  }
  await expect(sat.locator('[data-quirk="keepcue-strict"]')).toHaveText('Kronos and Yabause reject CHDs that keep their cue sheet, so this one leaves it out (the setting “Keep the cue sheet in CD CHDs” is on).');
  await expect(scd.locator('[data-quirk="keepcue-strict"]')).toContainText('jgenesis rejects CHDs that keep their cue sheet');
  await app.run(sat);
  const [out] = await app.downloads(sat);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createcd', 'albert odyssey.cue')));
});

test('other games keep the cue sheet with the setting, and Saturn games get no note without it', async ({ app }) => {
  await app.open({ settings: { keepCue: true } });
  const mgs = await card(app, 'ps1-multitrack', 'mgs disc1');
  await expect(mgs.locator('code.cmd')).toContainText('--keepcue');
  await expect(mgs.locator('[data-quirk]')).toHaveCount(0);
  await app.settings({ setKeepCue: false });
  const sat = await card(app, 'saturn', 'albert odyssey');
  await expect(sat.locator('[data-quirk="keepcue-strict"]')).toHaveCount(0);
});

// MAME and Flycast look a NAOMI GD-ROM up by its file name in the romset: renaming it after the game breaks that
test('a NAOMI GD-ROM keeps its file’s name, and the card says why', async ({ app }) => {
  const fx = fixture('naomi2-gdi');
  await app.open();
  const c = await card(app, 'naomi2-gdi', 'spikers');
  await expect(c.locator('.ident-name')).toHaveText(fx.name);
  await expect(c.locator('[data-quirk="naomi-name"]')).toContainText('MAME and Flycast find a NAOMI GD-ROM by its file name');
  await expect(c.locator('code.cmd')).toContainText('-o spikers.chd');
  await app.run(c);
  const [out] = await app.downloads(c);
  expect(out.name).toBe('spikers.chd');
});

test('the Zstd preset warns for PS2, Dreamcast, NAOMI and PC-FX games too', async ({ app }) => {
  await app.open();
  const ps2 = await card(app, 'ps2-dvd', 'agent');
  await ps2.locator('details.opts summary').click();
  const field = ps2.locator('label.field', { hasText: 'Compression' });
  await field.locator('select').selectOption('zstd');
  await expect(field).toContainText('AetherSX2 and NetherSX2 can’t read Zstd CHDs of Sony PlayStation 2 games.');
  const dc = await card(app, 'dreamcast-gdi', 'aerowings');
  await dc.locator('details.opts summary').click();
  const dfield = dc.locator('label.field', { hasText: 'Compression' });
  await dfield.locator('select').selectOption('zstd');
  await expect(dfield).toContainText('Flycast before 2.3 (and probably Redream) can’t read Zstd CHDs of Sega Dreamcast games.');
});

// the MiSTer preset uses Zstandard too, and MiSTer has no Dreamcast, PS2 or PC-FX core
test('the MiSTer preset warns as the Zstd one does, and where MiSTer has no core', async ({ app }) => {
  await app.open();
  const sat = await card(app, 'saturn', 'albert odyssey');
  await sat.locator('details.opts summary').click();
  const field = sat.locator('label.field', { hasText: 'Compression' });
  await field.locator('select').selectOption('mister');
  await expect(field).toContainText('Kronos and Yabause can’t read Zstd CHDs of Sega Saturn games.');
  await expect(field).not.toContainText('no core');
  const dc = await card(app, 'dreamcast-cdr', 'dc cdr');
  await dc.locator('details.opts summary').click();
  const dfield = dc.locator('label.field', { hasText: 'Compression' });
  await dfield.locator('select').selectOption('mister');
  await expect(dfield).toContainText('MiSTer has no core that plays Sega Dreamcast games from CHDs.');
  await expect(dfield.locator('.hint')).toHaveAttribute('style', /var\(--warn\)/); // in the warning colour
});

test('the rules’ notes carry their ids', async ({ app }) => {
  await app.open();
  const ps2 = await card(app, 'ps2-cd-audio', 'ps2 cdda');
  await expect(ps2.locator('.compat-note')).toHaveAttribute('data-quirk', 'ps2-cd-audio');
  const dc = await card(app, 'dreamcast-cdr', 'dc cdr');
  await expect(dc.locator('.compat-note')).toHaveAttribute('data-quirk', 'dc-cd-gaps');
});
