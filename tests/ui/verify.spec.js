// Reading a new CHD back (chdman verify on the result): from the card, after every conversion with the
// setting, and by itself when a helper failed while converting. And results that could be too large
// to keep in memory: the page asks first.
import { test, expect, fixture } from '../support/app.js';
import { nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

async function convert(app, key) {
  await app.add(fixture(key).add);
  const card = app.jobs().first();
  await app.settled(card);
  await app.run(card);
  return card;
}

test('a finished CHD can be verified from its card', async ({ app }) => {
  await app.open();
  const card = await convert(app, 'ps1-single');
  const row = card.locator('.verify-row');
  await expect(row).toContainText('Read the CHD back');
  await row.locator('button', { hasText: 'Verify' }).click();
  await expect(card.locator('.verify-note')).toHaveText('✓ Verified. The CHD holds exactly the data it was made from.');
  await expect(card.locator('pre.logtext')).toContainText('Verified: the CHD holds exactly the data it was made from.');
});

// Run again, Remove or Clear storage left a Verify running on results already deleted, and its verdict
// landed on the reset card (audit 2026-10-05, L3). Here the verify's worker starts 3 s late.
test('a Verify still running stops when its results are thrown away, and its verdict never lands', async ({ app, page }) => {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, t) {
      if (m && m.type === 'run' && m.args && m.args[0] === 'verify') { setTimeout(() => post.call(this, m, t), 3000); return; }
      return post.call(this, m, t);
    };
  });
  await app.open();
  const card = await convert(app, 'ps1-single');
  await card.locator('.verify-row button', { hasText: 'Verify' }).click();
  await expect(card.locator('.verify-row')).toContainText('Verifying');
  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());
  await card.locator('.job-foot button', { hasText: 'Run again' }).click();
  await expect(card).toHaveAttribute('data-state', 'ready');
  await page.waitForTimeout(4000);
  await expect(card.locator('.verify-note')).toHaveCount(0);
  await expect(card.locator('pre.logtext')).not.toContainText('Verif');
});

test('with the setting, every new CHD is verified', async ({ app, page }) => {
  await app.open({ settings: { verifyAfter: true } });
  await page.click('#settingsBtn');
  await expect(page.locator('#setVerify')).toBeChecked();
  await page.keyboard.press('Escape');
  const card = await convert(app, 'ps1-single');
  await expect(card.locator('.verify-note')).toHaveText('✓ Verified. The CHD holds exactly the data it was made from.');
});

test('a helper that answers for other hunks is dropped, and the CHD, the same, is checked', async ({ app }) => {
  await app.open({ settings: { threads: 4 }, debug: { failHelpers: 'lie' } });
  const card = await convert(app, 'ps2-dvd');
  await expect(card.locator('pre.logtext')).toContainText('A helper thread stopped (it answered for other hunks');
  await expect(card.locator('.verify-note')).toContainText('✓ Verified. The CHD holds exactly the data it was made from. A helper thread failed during the conversion, so the CHD was checked.');
  const [out] = await app.downloads(card);
  if (nativeChdman() && sameVersion()) expect(sha1File(out.path)).toBe(sha1File(reference('createdvd', 'agent.iso')));
});

test('a job whose results could be too large to keep in memory asks first', async ({ app, page }) => {
  await app.open({ noOpfs: true, debug: { memMax: 100000 } });
  const asked = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { asked.push(d.message()); asked.length === 1 ? d.dismiss() : d.accept(); });
  await app.add(fixture('ps1-single').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await expect(card).toHaveAttribute('data-state', 'canceled');
  expect(asked[0]).toContain('This browser keeps results in memory here, and this one could take about');
  expect(asked[0]).toContain('Convert anyway?');
  // asked again, and this time the user goes on
  await card.locator('.job-foot button', { hasText: 'Try again' }).click();
  await app.run(card);
  expect(asked).toHaveLength(2);
});

// Storage that fails when the run starts (a file still held by a run that ended, or none at all): the job
// went on in memory without the question above, and the whole visit switched to memory (audit 2026-10-05, M2)
for (const [kind, flips] of [['other', true], ['lock', false]]) {
  test(`storage that fails when a run starts (${kind}): asks before keeping a large result in memory`, async ({ app, page }) => {
    await app.open({ debug: { memMax: 100000, failStorage: kind } });
    const asked = [];
    page.removeAllListeners('dialog');
    page.on('dialog', d => { asked.push(d.message()); asked.length === 1 ? d.dismiss() : d.accept(); });
    await app.add(fixture('ps1-single').add);
    const card = app.jobs().first();
    await app.settled(card);
    await card.locator('.job-foot button.primary').click();
    await app.waitState(card, 'error');
    expect(asked[0]).toContain('This browser keeps results in memory here');
    await expect(card.locator('.note.err')).toContainText('storage wasn’t available for this job');
    await card.locator('.job-foot button', { hasText: 'Try again' }).click();
    await app.run(card);
    expect(asked).toHaveLength(2);
    await expect(page.locator('#chipStore')).toContainText(flips ? 'Results in memory' : 'Large files OK');
  });
}
