// Known app issues found by this suite, pinned with test.fail(): they pass while the
// bug exists. When a fix lands, Playwright reports "expected to fail, but passed";
// then delete the test.fail() line so the test guards against regressions.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { chdman, nativeChdman, reference } from '../support/native.js';

test('a disc whose header serial matches one release exactly is named after that release', async ({ app }) => {
  test.fail(true, 'serial lookup also matches regional variants (T-8113H vs T-8113H-50) and shows the first, not the exact match');
  // USA Saturn disc: IP.BIN carries "T-8113H"; Europe/Germany releases are T-8113H-50 / T-8113H-18
  const py = `
import sys; sys.path.insert(0, ${JSON.stringify(path.resolve(FIXTURES, '../../fixtures'))})
import discgen as g
b = bytearray(16 * 2048); b[0:16] = b'SEGA SEGASATURN '; b[0x20:0x2A] = b'T-8113H   '; b[0x60:0x6D] = b'ALIEN TRILOGY'
open(${JSON.stringify(path.join(FIXTURES, 'alien.bin'))}, 'wb').write(g.raw_sectors(g.pad_sectors(g.iso9660({'0.BIN': b'x' * 4096}, 'ALIEN', 'SEGA SEGASATURN', bytes(b))), 1))
open(${JSON.stringify(path.join(FIXTURES, 'alien.cue'))}, 'w').write('FILE "alien.bin" BINARY\\n  TRACK 01 MODE1/2352\\n    INDEX 01 00:00:00\\n')
`;
  const { execFileSync } = await import('node:child_process');
  execFileSync('python3', ['-c', py]);
  await app.open();
  await app.add(['alien.cue', 'alien.bin']);
  const card = app.job('alien');
  await app.settled(card);
  await expect(card.locator('.ident-name')).toHaveText('Alien Trilogy (USA)');
});

test('a CHD is never used as its own parent', async ({ app }) => {
  test.skip(!nativeChdman(), 'needs native chdman');
  test.fail(true, 'linkParents() does not exclude the job itself, so a child whose data equals its parent links to itself');
  const dir = path.join(FIXTURES, 'chd');
  fs.mkdirSync(dir, { recursive: true });
  const parent = path.join(dir, 'same-parent.chd'), child = path.join(dir, 'same-child.chd');
  if (!fs.existsSync(child)) {
    fs.copyFileSync(reference('createdvd', 'homebrew.iso'), parent);
    chdman(['createdvd', '-i', 'homebrew.iso', '-o', child, '-op', parent, '-f']);
  }
  await app.open();
  await app.add(['chd/same-child.chd']);
  const card = app.job('same-child');
  await app.settled(card);
  await expect(card).toContainText('This CHD depends on a parent CHD');
});
