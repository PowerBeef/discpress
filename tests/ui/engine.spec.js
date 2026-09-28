// The engine's own command line (build/chdman-native, scripts/build-native.sh) against unmodified
// chdman 0.289 (build/chdman-0.289, scripts/build-upstream.sh). It keeps 0.289's behaviour, except
// where 0.289 crashes, loses data or reports success on a failure.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, ROOT } from '../support/paths.js';

const ENGINE = path.join(ROOT, 'build', 'chdman-native');
const UPSTREAM = path.join(ROOT, 'build', 'chdman-0.289');

function newest(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}
const missing = !fs.existsSync(ENGINE) || !fs.existsSync(UPSTREAM);
test.skip(missing, 'needs build/chdman-native and build/chdman-0.289');
test.skip(!missing && fs.statSync(ENGINE).mtimeMs < newest(path.join(ROOT, 'engine', 'mame')), 'build/chdman-native is older than engine/: run scripts/build-native.sh');

function run(bin, args) {
  const r = spawnSync(bin, args, { cwd: FIXTURES, timeout: 120_000 });
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr.toString() };
}
function tmp(name) {
  const dir = test.info().outputPath();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
function makeChd(command, input) {
  const out = tmp(`${command}.chd`);
  expect(run(UPSTREAM, [command, '-i', input, '-o', out, '-f']).code).toBe(0);
  return out;
}

test('verify fails when the data does not match the header, and --fix repairs it', () => {
  const good = makeChd('createcd', 'twine.cue');
  for (const [what, offset] of [['raw SHA-1', 64], ['overall SHA-1', 84]]) {
    const bad = tmp(`bad-${offset}.chd`);
    const b = fs.readFileSync(good);
    b[offset] ^= 0xff;
    fs.writeFileSync(bad, b);
    expect(run(UPSTREAM, ['verify', '-i', bad]).code, `upstream, ${what}`).toBe(0); // the bug
    const r = run(ENGINE, ['verify', '-i', bad]);
    expect(r.code, what).toBe(1);
    expect(r.err).toContain('Verification failed');
    expect(run(ENGINE, ['verify', '-i', bad, '--fix']).code, `${what}, --fix`).toBe(0);
    expect(run(ENGINE, ['verify', '-i', bad]).code, `${what}, after --fix`).toBe(0);
  }
  expect(run(ENGINE, ['verify', '-i', good]).code).toBe(0);
});

test('an output is never written over an input', () => {
  const chd = makeChd('createdvd', 'agent.iso');
  const before = fs.readFileSync(chd);
  const r = run(ENGINE, ['copy', '-i', chd, '-o', chd, '-f']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('is also an input file');
  expect(fs.readFileSync(chd).equals(before)).toBe(true); // upstream truncates it, then deletes it
});

test('bad input is an error, not a crash', () => {
  const dvd = makeChd('createdvd', 'agent.iso');
  for (const [args, message] of [
    [['extractcd', '-i', dvd, '-o', tmp('x.cue'), '-f'], 'is not a CD-ROM or GD-ROM'],
    [['createraw', '-i', 'agent.iso', '-o', tmp('r.chd'), '-f', '-us', '0'], 'Invalid unit size'],
    [['createhd', '-i', 'arcade.img', '-o', tmp('h.chd'), '-f', '-ss', '0', '-chs', '10,2,2'], 'Invalid sector size'],
  ]) {
    expect(run(UPSTREAM, args).signal, `upstream ${args[0]}`).toBeTruthy(); // SIGABRT or SIGFPE
    const r = run(ENGINE, args);
    expect({ code: r.code, signal: r.signal }, args.join(' ')).toEqual({ code: 1, signal: null });
    expect(r.err).toContain(message);
  }
});

test('dumpmeta to stdout writes only the metadata', () => {
  const chd = makeChd('createcd', 'twine.cue');
  const up = run(UPSTREAM, ['dumpmeta', '-i', chd, '-t', 'CHT2']);
  const r = run(ENGINE, ['dumpmeta', '-i', chd, '-t', 'CHT2']);
  expect(r.code).toBe(0);
  expect(r.out.toString()).toMatch(/^TRACK:1 /);
  expect(up.out.toString()).toContain(r.out.toString()); // upstream puts the banner first
  expect(r.err).toContain('chdman - MAME Compressed Hunks of Data');
});
