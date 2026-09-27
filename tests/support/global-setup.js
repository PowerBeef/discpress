// Makes sure the page and the fixtures exist before any test runs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, TESTS, pageUnderTest } from './paths.js';
import { nativeChdman, APP_CHDMAN_VERSION } from './native.js';

export default async function globalSetup() {
  const page = pageUnderTest();
  if (!fs.existsSync(page)) throw new Error(`page under test not found: ${page}`);
  if (!fs.existsSync(path.join(FIXTURES, 'manifest.json')) || process.env.REGEN_FIXTURES) {
    execFileSync('python3', [path.join(TESTS, 'fixtures', 'make_fixtures.py'), '--out', FIXTURES], { stdio: 'inherit' });
  }
  const n = nativeChdman();
  const note = !n ? 'not found: conversions are checked by round trip only'
    : n.version === APP_CHDMAN_VERSION ? `${n.bin} ${n.version}: outputs must match byte for byte`
      : `${n.bin} ${n.version}: data checksums must match (different version than the app's ${APP_CHDMAN_VERSION})`;
  console.log(`page: ${page}\nnative chdman: ${note}`);
}
