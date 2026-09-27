// Native chdman as a reference ("oracle") for the browser build.
// Prefers the same version the app ships (build/chdman-native, see scripts/build-native.sh);
// falls back to CHDMAN=... or a chdman on PATH (e.g. the mame-tools package).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, ROOT, FIXTURES } from './paths.js';

function probe(bin) {
  try {
    const out = execFileSync(bin, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out;
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    return /CHD\) manager/.test(out) ? out : null;
  }
}

let cached;
export function nativeChdman() {
  if (cached !== undefined) return cached;
  for (const bin of [process.env.CHDMAN, path.join(ROOT, 'build', 'chdman-native'), 'chdman'].filter(Boolean)) {
    const out = probe(bin);
    const m = out && /manager ([\d.]+)/.exec(out);
    if (m) return (cached = { bin, version: m[1] });
  }
  return (cached = null);
}

/** The version the page ships, read from the MAME revision pinned for the build. */
export const APP_CHDMAN_VERSION = '0.289';

/** true when native output can be expected to match the app byte for byte */
export function sameVersion() {
  const n = nativeChdman();
  return !!n && n.version === APP_CHDMAN_VERSION;
}

export function chdman(args, opts = {}) {
  const n = nativeChdman();
  if (!n) throw new Error('native chdman not found (run scripts/build-native.sh or install mame-tools)');
  return execFileSync(n.bin, args, { encoding: 'utf8', maxBuffer: 64 << 20, cwd: opts.cwd || FIXTURES, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function info(chd) {
  const out = chdman(['info', '-i', chd]);
  const kv = {};
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9 ]*?):\s+(.*)$/.exec(line);
    if (m && !(m[1] in kv)) kv[m[1]] = m[2].trim();
  }
  return { raw: out, sha1: kv['SHA1'], dataSha1: kv['Data SHA1'], kv };
}

/**
 * Create (and cache) a reference CHD from fixture files with native chdman.
 * `command` is createcd/createdvd/createhd, `input` a file name in the fixtures dir.
 */
export function reference(command, input, extra = []) {
  const n = nativeChdman();
  const key = crypto.createHash('sha1').update([n.bin, n.version, command, input, ...extra].join('\0')).digest('hex').slice(0, 16);
  const dir = path.join(CACHE, 'native');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${key}.chd`);
  if (!fs.existsSync(out)) {
    chdman([command, '-i', input, '-o', out + '.tmp', '-f', ...extra]);
    fs.renameSync(out + '.tmp', out);
  }
  return out;
}

/** Extract a CHD with native chdman into a fresh directory; returns {dir, files}. */
export function extract(command, chd, outName, extra = []) {
  const dir = fs.mkdtempSync(path.join(CACHE, 'native-x-'));
  chdman([command, '-i', chd, '-o', path.join(dir, outName), ...extra]);
  return { dir, files: fs.readdirSync(dir).sort() };
}

export function sha1File(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}
