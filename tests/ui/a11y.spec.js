// Accessibility audit (axe-core) of every screen, in light and dark.
// Serious and critical violations fail the test; everything found is attached to
// the report (and written to .cache/a11y/) so smaller issues can be reviewed too.
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, fixture } from '../support/app.js';
import { CACHE } from '../support/paths.js';

// Known issues still to fix in the app: [rule id, CSS selector substring, why].
// Anything else that is serious or critical fails. Remove entries as they are fixed.
const ACCEPTED = [];

async function audit(page, name) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const rows = r.violations.flatMap(v => v.nodes.map(n => ({ rule: v.id, impact: v.impact, help: v.help, target: n.target.join(' '), summary: n.failureSummary })));
  fs.mkdirSync(path.join(CACHE, 'a11y'), { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'a11y', `${name}.json`), JSON.stringify(rows, null, 1));
  await test.info().attach(`axe-${name}`, { body: JSON.stringify(rows, null, 1), contentType: 'application/json' });
  return rows.filter(x => (x.impact === 'serious' || x.impact === 'critical') && !ACCEPTED.some(([rule, sel]) => x.rule === rule && x.target.includes(sel)));
}

for (const theme of ['light', 'dark']) {
  test(`${theme}: no serious accessibility problems`, async ({ app, page }) => {
    await app.open({ theme });
    const found = {};
    found.start = await audit(page, `${theme}-start`);
    await app.add([...fixture('ps1-single').add, ...fixture('ps1-multitrack').add, 'ax101.cue', 'ax101.bin']);
    await app.settled(app.job('twine'));
    await app.settled(app.job('mgs disc1'));
    await app.run(app.job('twine'));
    found.jobs = await audit(page, `${theme}-jobs`);
    await page.click('.tab[data-tab="cli"]');
    found.advanced = await audit(page, `${theme}-advanced`);
    await page.click('.tab[data-tab="help"]');
    found.help = await audit(page, `${theme}-help`);
    await page.click('#settingsBtn');
    found.settings = await audit(page, `${theme}-settings`);
    expect(found).toEqual({ start: [], jobs: [], advanced: [], help: [], settings: [] });
  });
}
