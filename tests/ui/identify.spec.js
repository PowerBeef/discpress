// Identification that confirms the exact release by checksum, and conversions that
// don't wait for it. Uses the page with extra database rows (server.js ?testdb=1),
// since synthetic discs can't match real Redump checksums.
import { test, expect, fixture } from '../support/app.js';
import { nativeChdman, reference, sha1File } from '../support/native.js';

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
