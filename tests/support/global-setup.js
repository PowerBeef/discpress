// Makes sure the page and the fixtures exist before any test runs.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, FIXTURES, ROOT, TESTS, pageUnderTest } from './paths.js';
import { nativeChdman, engineChdman, APP_CHDMAN_VERSION } from './native.js';

export default async function globalSetup(config) {
  const page = pageUnderTest();
  if (!fs.existsSync(page)) throw new Error(`page under test not found: ${page}`);
  // a server left running (reuseExistingServer) may serve another page than DISCPRESS_HTML picks
  const health = (config.webServer && config.webServer.url) || config.projects[0].use.baseURL + '/healthz';
  const served = await fetch(health).then(r => r.json()).then(j => j.page, () => undefined);
  if (served !== page) {
    throw new Error(`the test server at ${new URL(health).origin} serves ${served || 'an unknown page (an older server?)'}, ` +
      `not ${page}: stop it, or run the tests with PORT set to a free port`);
  }
  // the fixtures, made again when the generator changed (it says so in generator.sha256) or when asked
  // (REGEN_FIXTURES=1); then what was made from the old ones goes too: native chdman's references (cached
  // by file name), and the CHDs and files tests derived from them
  const gen = crypto.createHash('sha256');
  for (const n of ['make_fixtures.py', 'discgen.py']) gen.update(fs.readFileSync(path.join(TESTS, 'fixtures', n)));
  const stamp = path.join(FIXTURES, 'generator.sha256');
  const stale = !fs.existsSync(path.join(FIXTURES, 'manifest.json')) || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8').trim() !== gen.digest('hex');
  if (stale || process.env.REGEN_FIXTURES) {
    execFileSync('python3', [path.join(TESTS, 'fixtures', 'make_fixtures.py'), '--out', FIXTURES, ...(process.env.REGEN_FIXTURES ? ['--force'] : [])], { stdio: 'inherit' });
    for (const d of [path.join(CACHE, 'native'), path.join(FIXTURES, 'chd'), path.join(FIXTURES, 'gen')]) fs.rmSync(d, { recursive: true, force: true });
  }
  // the folders extract() made in earlier runs (native chdman's extracted files)
  for (const d of fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : []) if (d.startsWith('native-x-')) fs.rmSync(path.join(CACHE, d), { recursive: true, force: true });
  const n = nativeChdman();
  const note = !n ? 'not found: conversions are checked by round trip only'
    : n.version === APP_CHDMAN_VERSION ? `${n.bin} ${n.version}: outputs must match byte for byte`
      : `${n.bin} ${n.version}: data checksums must match (different version than the app's ${APP_CHDMAN_VERSION})`;
  console.log(`page: ${page}\nnative chdman: ${note}`);
  // REQUIRE_NATIVE=1 (CI): without both references, the byte-for-byte checks would skip, and a run
  // that proves nothing would pass
  if (process.env.REQUIRE_NATIVE) {
    const want = path.join(ROOT, 'build', 'chdman-0.289');
    if (!n || n.bin !== want || n.version !== APP_CHDMAN_VERSION) throw new Error(`REQUIRE_NATIVE: ${want} (scripts/build-upstream.sh) is missing or not chdman ${APP_CHDMAN_VERSION}`);
    if (!engineChdman()) throw new Error('REQUIRE_NATIVE: build/chdman-native (scripts/build-native.sh) is missing or older than engine/');
  }
}
