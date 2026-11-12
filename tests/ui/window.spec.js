// In the browser, chdman keeps up to 1024 small hunks in flight instead of 256 (chd_file_compressor::m_window),
// so that helper workers get batches large enough for their messages. A partial last hunk is compressed whole, and
// past the end of the data it holds what chdman's 256-hunk buffer would: the bytes of the hunk 256 before it, or
// zeros. Each case must give chdman 0.289's CHD byte for byte: fewer than 256 hunks, 256 to 1024 (a slot of the
// wider buffer not used yet), more than 1024 (one used before).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { nativeChdman, reference, sameVersion, sha1File } from '../support/native.js';

const dir = path.join(FIXTURES, 'gen', 'window');

// an image of 2048-byte sectors, an odd number of them, each different (text, noise and zeros by turns)
function image(name, sectors) {
  const file = path.join(dir, name);
  if (fs.existsSync(file) && fs.statSync(file).size === sectors * 2048) return 'gen/window/' + name;
  fs.mkdirSync(dir, { recursive: true });
  const b = Buffer.alloc(sectors * 2048);
  let x = sectors * 2654435761 >>> 0;
  for (let s = 0; s < sectors; s++) {
    const kind = s % 3, at = s * 2048;
    for (let i = 0; i < 2048; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      b[at + i] = kind === 0 ? 97 + ((x >>> 16) % 7) : kind === 1 ? x >>> 24 : (i < 64 ? s & 255 : 0);
    }
  }
  fs.writeFileSync(file, b);
  return 'gen/window/' + name;
}

const CASES = [
  ['under 256 hunks', 'w100.iso', 2 * 100 + 1],
  ['256 to 1024 hunks', 'w600.iso', 2 * 600 + 1],
  ['over 1024 hunks', 'w1500.iso', 2 * 1500 + 1],
];

for (const threads of [1, 4]) {
  test(`a partial last hunk gives chdman's CHD, with any window (${threads} thread${threads > 1 ? 's' : ''})`, async ({ app, page }) => {
    test.skip(!nativeChdman() || !sameVersion(), 'needs native chdman 0.289');
    test.setTimeout(300_000);
    const files = CASES.map(([, name, sectors]) => image(name, sectors));
    await app.open({ settings: { threads } });
    await page.click('.tab[data-tab="cli"]');
    await app.add(files, { via: '#cliAdd' });
    await page.click('#cliEditToggle');
    for (const [what, name] of CASES) {
      for (const codecs of [[], ['-c', 'zlib,huff']]) {
        const out = `${name.replace('.iso', '')}${codecs.length ? '-fast' : ''}.chd`;
        await page.locator('#cliText').fill(`chdman createdvd -i ${name} -o ${out} ${codecs.join(' ')}`.trim());
        await page.click('#cliRun');
        await expect(page.locator('#cliConsole')).toContainText(/\[exit code \d+/, { timeout: 120_000 });
        await expect(page.locator('#cliConsole')).toContainText('[exit code 0]');
        await expect(page.locator('#cliOuts')).toContainText(out);
        const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#cliOuts button').first().click()]);
        const p = test.info().outputPath(out);
        await dl.saveAs(p);
        expect(sha1File(p), `${what}${codecs.length ? ', ' + codecs[1] : ''}`).toBe(sha1File(reference('createdvd', `gen/window/${name}`, codecs)));
      }
    }
  });
}
