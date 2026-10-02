// db/facts: scripts/assemble.py checks every fact against the database before it embeds them
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../support/paths.js';

for (const [what, line, why] of [
  ['a serial the database doesn’t have', 'ps1\tSLES-99999\tlibcrypt\t1\ta test', 'no SLES-99999 in the database for ps1'],
  ['an unknown fact', 'ps1\tSLES-02563\tcartridge\t1\ta test', 'unknown fact cartridge'],
  ['a line without a source', 'ps1\tSLES-02563\tlibcrypt\t1\t', 'no source'],
  ['a system the database doesn’t have', 'gba\tAGB-0001\tlibcrypt\t1\ta test', 'no system gba'],
]) {
  test(`assemble.py refuses a fact with ${what}`, () => {
    const dir = test.info().outputPath('facts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.tsv'), '# a test\n' + line + '\n');
    const r = spawnSync('python3', [path.join(ROOT, 'scripts', 'assemble.py'), test.info().outputPath('page.html')],
      { env: { ...process.env, DISCPRESS_FACTS_DIR: dir }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('db/facts/bad.tsv:2: ' + why);
  });
}
