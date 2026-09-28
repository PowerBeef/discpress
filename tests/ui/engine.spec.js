// The engine's own command line (build/chdman-native, scripts/build-native.sh) against unmodified
// chdman 0.289 (build/chdman-0.289, scripts/build-upstream.sh). It keeps 0.289's behaviour, except
// where 0.289 crashes, loses data or reports success on a failure.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

test('an input that cannot be read is an error, not a broken CHD', () => {
  const dir = tmp('a directory'); // opens, but reading it fails
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [['createraw', '-hs', '4096', '-us', '512'], ['createhd'], ['createdvd']]) {
    const out = tmp(`${args[0]}.chd`);
    // 0.289: exit 0, and a CHD that it can't open
    expect(run(UPSTREAM, [args[0], '-i', dir, '-o', out, '-f', ...args.slice(1)]).code, `upstream ${args[0]}`).toBe(0);
    expect(run(UPSTREAM, ['info', '-i', out]).code, `upstream ${args[0]} output`).toBe(1);
    fs.rmSync(out);
    const r = run(ENGINE, [args[0], '-i', dir, '-o', out, '-f', ...args.slice(1)]);
    expect({ code: r.code, signal: r.signal }, args[0]).toEqual({ code: 1, signal: null });
    expect(r.err).toContain('Error during compression: Is a directory');
    expect(fs.existsSync(out), `${args[0]} output`).toBe(false);
  }
});

// descriptors with no tracks or no data, or track numbers outside 1-99: 0.289 spins forever, aborts or segfaults
test('no tracks, no data or too many tracks is an error', () => {
  const bin = tmp('t.bin');
  fs.writeFileSync(bin, Buffer.alloc(100 * 4 * 2352));
  const cue = n => Array.from({ length: n }, (_, i) =>
    `${i ? '' : 'FILE "t.bin" BINARY\n'}  TRACK ${String(i + 1).padStart(2, '0')} ${i ? 'AUDIO' : 'MODE1/2352'}\n    INDEX 01 ${String(Math.floor(i * 4 / 75 / 60)).padStart(2, '0')}:${String(Math.floor(i * 4 / 75) % 60).padStart(2, '0')}:${String(i * 4 % 75).padStart(2, '0')}\n`).join('');
  const gdi = n => `${n}\n` + Array.from({ length: n }, (_, i) => `${i + 1} ${i * 4} ${i ? 0 : 4} 2352 t.bin 0\n`).join('');
  for (const [name, text, upstream, message] of [
    ['none.cue', 'REM nothing here\n', null, 'no tracks found'], // upstream: never finishes
    ['t00.cue', 'FILE "t.bin" BINARY\n  TRACK 00 MODE1/2352\n    INDEX 01 00:00:00\n', null, 'track number 00 is not between 1 and 99'],
    ['nolength.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "t.bin"\n', null, 'the tracks hold no data'], // upstream: -nan% forever
    ['t100.cue', cue(100), 'crash', 'track number 100 is not between 1 and 99'],
    ['t100.gdi', gdi(100), 'crash', 'GDI expects too many tracks'],
  ]) {
    const input = tmp(name);
    fs.writeFileSync(input, text);
    if (upstream) expect(run(UPSTREAM, ['createcd', '-i', input, '-o', tmp('u.chd'), '-f']).signal, `upstream ${name}`).toBeTruthy(); // SIGSEGV or SIGABRT
    const r = run(ENGINE, ['createcd', '-i', input, '-o', tmp('e.chd'), '-f']);
    expect({ code: r.code, signal: r.signal }, name).toEqual({ code: 1, signal: null });
    expect(r.err, name).toContain(message);
  }
  // 99 tracks are fine, and upstream's
  const ok = tmp('t99.cue');
  fs.writeFileSync(ok, cue(99));
  expect(run(ENGINE, ['createcd', '-i', ok, '-o', tmp('e99.chd'), '-f']).code).toBe(0);
  expect(run(UPSTREAM, ['createcd', '-i', ok, '-o', tmp('u99.chd'), '-f']).code).toBe(0);
  expect(fs.readFileSync(tmp('e99.chd')).equals(fs.readFileSync(tmp('u99.chd')))).toBe(true);
});

// cue sheets 0.289 reads wrong, silently: MOTOROLA (big-endian) audio swapped anyway, a file with several
// tracks after another file read at the wrong offsets, two tracks in one .wav read as one. Each fixture
// has a plain twin (one file per track, little-endian audio) that 0.289 reads right.
test('cue sheets 0.289 misreads make the same CHD as their plain twin', () => {
  for (const [cue, twin] of [['moto.cue', 'moto-ref.cue'], ['shared.cue', 'shared-ref.cue'], ['wavs.cue', 'wavs-ref.cue']]) {
    const mine = tmp(`${cue}.chd`), theirs = tmp(`${cue}-up.chd`), plain = tmp(`${twin}.chd`);
    expect(run(ENGINE, ['createcd', '-i', cue, '-o', mine, '-f']).code, cue).toBe(0);
    expect(run(UPSTREAM, ['createcd', '-i', twin, '-o', plain, '-f']).code, twin).toBe(0);
    expect(run(UPSTREAM, ['createcd', '-i', cue, '-o', theirs, '-f']).code, `upstream ${cue}`).toBe(0);
    expect(fs.readFileSync(mine).equals(fs.readFileSync(plain)), `${cue} = ${twin}`).toBe(true);
    expect(fs.readFileSync(theirs).equals(fs.readFileSync(plain)), `upstream ${cue}`).toBe(false); // the bug
  }
});

// Not a fix but an addition: extractcd --redump writes Redump's layout, which upstream can't
test('extractcd --redump writes Redump\'s layout: CRLF, and a .bin per track unless there is only one', () => {
  for (const [input, tracks] of [['mgs disc1.cue', 2], ['twine.cue', 1]]) {
    const chd = makeChd('createcd', input);
    const dir = tmp(`rd-${tracks}`), up = tmp(`up-${tracks}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(up, { recursive: true });
    expect(run(ENGINE, ['extractcd', '-i', chd, '-o', path.join(dir, 'x.cue'), '--redump']).code).toBe(0);
    // upstream: the same files with -sb for several tracks, and LF line ends
    expect(run(UPSTREAM, ['extractcd', '-i', chd, '-o', path.join(up, 'x.cue'), ...(tracks > 1 ? ['-sb'] : [])]).code).toBe(0);
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(fs.readdirSync(up).sort());
    expect(names.length).toBe(tracks + 1);
    for (const n of names) {
      const mine = fs.readFileSync(path.join(dir, n)), theirs = fs.readFileSync(path.join(up, n));
      if (n.endsWith('.cue')) expect(mine.toString()).toBe(theirs.toString().replace(/\n/g, '\r\n'));
      else expect(mine.equals(theirs), n).toBe(true);
    }
  }
  const r = run(ENGINE, ['extractcd', '-i', makeChd('createcd', 'twine.cue'), '-o', tmp('x.gdi'), '--redump']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('--redump needs a .cue output file');
  // without it, the output is upstream's (tests/ui/chd.spec.js compares every format)
});

test('createcd --keepcue keeps the cue sheet, checksums unchanged, and extractcd --redump writes it back', () => {
  const sha = chd => {
    const t = run(UPSTREAM, ['info', '-i', chd]).out.toString();
    return [/^SHA1:\s+(\w+)/m.exec(t)[1], /^Data SHA1:\s+(\w+)/m.exec(t)[1]];
  };
  const same = (a, b) => {
    const names = fs.readdirSync(a).sort();
    expect(names).toEqual(fs.readdirSync(b).sort());
    for (const n of names) expect(fs.readFileSync(path.join(a, n)).equals(fs.readFileSync(path.join(b, n))), n).toBe(true);
  };
  const track = (stem, n) => [...Array(n)].map((_, i) => `${stem} (Track ${i + 1}).bin`);
  // CATALOG, FLAGS, ISRC and INDEX 02; a CD-i track (CDI/2352); a GD-ROM's Redump sheet
  for (const [cue, files] of [['fidelity.cue', track('fidelity', 3)], ['cdi disc.cue', ['cdi disc.bin']], ['aerowings.cue', track('aerowings', 3)]]) {
    const plain = makeChd('createcd', cue), keep = tmp(`keep ${cue}.chd`);
    expect(run(ENGINE, ['createcd', '-i', cue, '-o', keep, '-f', '--keepcue']).code).toBe(0);
    expect(sha(keep), cue).toEqual(sha(plain));
    // chdman 0.289 reads it as it reads the CHD without the sheet
    expect(run(UPSTREAM, ['verify', '-i', keep]).code).toBe(0);
    const a = tmp(`up keep ${cue}`), b = tmp(`up plain ${cue}`), dir = tmp(`redump ${cue}`);
    for (const d of [a, b, dir]) fs.mkdirSync(d, { recursive: true });
    expect(run(UPSTREAM, ['extractcd', '-i', keep, '-o', path.join(a, 'x.cue'), '-sb']).code).toBe(0);
    expect(run(UPSTREAM, ['extractcd', '-i', plain, '-o', path.join(b, 'x.cue'), '-sb']).code).toBe(0);
    same(a, b);
    // the sheet as it was, and the files it names
    expect(run(ENGINE, ['extractcd', '-i', keep, '-o', path.join(dir, cue), '--redump']).code).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual([cue, ...files].sort());
    for (const n of [cue, ...files]) expect(fs.readFileSync(path.join(dir, n)).equals(fs.readFileSync(path.join(FIXTURES, n))), n).toBe(true);
  }
  // under another name, only its FILE names change
  const keep = tmp('keep fidelity.cue.chd'), other = tmp('other');
  fs.mkdirSync(other, { recursive: true });
  expect(run(ENGINE, ['extractcd', '-i', keep, '-o', path.join(other, 'Other Name.cue'), '--redump']).code).toBe(0);
  expect(fs.readFileSync(path.join(other, 'Other Name.cue'), 'latin1'))
    .toBe(fs.readFileSync(path.join(FIXTURES, 'fidelity.cue'), 'latin1').replaceAll('"fidelity (Track', '"Other Name (Track'));
  // a sheet whose files aren't laid out as Redump's (several tracks in one file): the sheet --redump makes itself
  // (the engine's CHDs: 0.289 reads this sheet wrong)
  const shared = tmp('shared keep.chd'), plain = tmp('shared.chd'), mine = tmp('shared keep'), made = tmp('shared plain');
  for (const d of [mine, made]) fs.mkdirSync(d, { recursive: true });
  expect(run(ENGINE, ['createcd', '-i', 'shared.cue', '-o', shared, '-f', '--keepcue']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', 'shared.cue', '-o', plain, '-f']).code).toBe(0);
  expect(run(ENGINE, ['extractcd', '-i', shared, '-o', path.join(mine, 'x.cue'), '--redump']).code).toBe(0);
  expect(run(ENGINE, ['extractcd', '-i', plain, '-o', path.join(made, 'x.cue'), '--redump']).code).toBe(0);
  same(mine, made);
  // only a cue sheet can be kept
  const r = run(ENGINE, ['createcd', '-i', 'aerowings.gdi', '-o', tmp('g.chd'), '-f', '--keepcue']);
  expect(r.code).toBe(1);
  expect(r.err).toContain('--keepcue needs a .cue input file');
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

// The engine tries each hunk's codecs in a different order and stops a codec as soon as it can't
// win (see engine/README.md). The chosen codec and the bytes must still be upstream's, whatever
// the codec list and hunk size: larger hunks make FLAC give up between blocks.
test('codec trials that stop early still make the same CHDs', () => {
  const sha1 = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  const cases = [
    ['createcd', 'codec mix cd.cue', []],
    ['createcd', 'codec mix cd.cue', ['-c', 'cdfl,cdzl,cdlz']],
    ['createcd', 'codec mix cd.cue', ['-c', 'cdzs,cdfl']],
    ['createhd', 'codec mix.img', []],
    ['createhd', 'codec mix.img', ['-c', 'flac,huff,zlib,lzma']],
    ['createraw', 'codec mix.img', ['-hs', '16384', '-us', '4', '-c', 'zstd,flac,lzma']],
    ['createraw', 'codec mix.img', ['-hs', '65536', '-us', '4']],
  ];
  for (const [command, input, extra] of cases) {
    const what = [command, input, ...extra].join(' ');
    const up = tmp('up.chd'), en = tmp('engine.chd');
    expect(run(UPSTREAM, [command, '-i', input, '-o', up, '-f', ...extra]).code, `upstream ${what}`).toBe(0);
    expect(run(ENGINE, [command, '-i', input, '-o', en, '-f', ...extra]).code, what).toBe(0);
    expect(sha1(en), what).toBe(sha1(up));
  }
});
