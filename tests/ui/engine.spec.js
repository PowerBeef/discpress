// The engine's own command line (build/chdman-native, scripts/build-native.sh) against unmodified
// chdman 0.289 (build/chdman-0.289, scripts/build-upstream.sh). It keeps 0.289's behaviour, except
// where 0.289 crashes, loses data or reports success on a failure.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, ROOT } from '../support/paths.js';
import { engineSourcesNewest } from '../support/native.js';

// CHDMAN_ENGINE: another build of the engine, such as the sanitized one (scripts/build-sanitized.sh)
const ENGINE = process.env.CHDMAN_ENGINE ? path.resolve(process.env.CHDMAN_ENGINE) : path.join(ROOT, 'build', 'chdman-native');
const UPSTREAM = path.join(ROOT, 'build', 'chdman-0.289');

const missing = !fs.existsSync(ENGINE) || !fs.existsSync(UPSTREAM);
const stale = !missing && fs.statSync(ENGINE).mtimeMs < engineSourcesNewest();
// a run that asked for a build (CHDMAN_ENGINE: the sanitizer job) or for the references (REQUIRE_NATIVE:
// CI) fails without it, rather than pass with every test skipped
if ((process.env.CHDMAN_ENGINE || process.env.REQUIRE_NATIVE) && (missing || stale)) {
  throw new Error(`${missing ? 'missing' : 'out of date'}: ${missing && !fs.existsSync(UPSTREAM) ? UPSTREAM : ENGINE} (older than engine/ or wasm/: build it again)`);
}
test.skip(missing, 'needs build/chdman-native and build/chdman-0.289');
test.skip(stale, 'build/chdman-native is older than engine/ or wasm/: run scripts/build-native.sh');

// a sanitized build's report fails the test, whatever chdman's exit code (it often exits 1 here on purpose)
const SANITIZER = /ERROR: AddressSanitizer|ERROR: LeakSanitizer|runtime error:/;
function run(bin, args) {
  const r = spawnSync(bin, args, { cwd: FIXTURES, timeout: 120_000 });
  const err = r.stderr.toString();
  if (SANITIZER.test(err)) throw new Error(`${path.basename(bin)} ${args.join(' ')}: sanitizer report\n${err.slice(0, 4000)}`);
  return { code: r.status, signal: r.signal, out: r.stdout, err };
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

// extractdvd is extractraw under another name: of a CD CHD, 0.289 writes its frames, subcode and all, as an .iso
test('extractdvd of a CD is an error, and of a DVD upstream\'s', () => {
  const cd = makeChd('createcd', 'twine.cue'), dvd = makeChd('createdvd', 'agent.iso');
  expect(run(UPSTREAM, ['extractdvd', '-i', cd, '-o', tmp('up.iso'), '-f']).code).toBe(0); // the bug
  const r = run(ENGINE, ['extractdvd', '-i', cd, '-o', tmp('cd.iso'), '-f']);
  expect({ code: r.code, signal: r.signal }).toEqual({ code: 1, signal: null });
  expect(r.err).toContain('Input CHD is a CD-ROM or GD-ROM');
  expect(fs.existsSync(tmp('cd.iso'))).toBe(false);
  // its frames are still there with extractraw, and a DVD extracts as before
  for (const [command, chd] of [['extractraw', cd], ['extractdvd', dvd]]) {
    expect(run(UPSTREAM, [command, '-i', chd, '-o', tmp('up.out'), '-f']).code, command).toBe(0);
    expect(run(ENGINE, [command, '-i', chd, '-o', tmp('en.out'), '-f']).code, command).toBe(0);
    expect(fs.readFileSync(tmp('en.out')).equals(fs.readFileSync(tmp('up.out'))), command).toBe(true);
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
    ['nolength.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "t.bin" #940800\n', null, 'track 1 holds no data'], // upstream: -nan% forever
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

// A kept sheet whose TRACK types aren't the CHD's tracks' (edited here, in an uncompressed CHD): extractcd
// --redump writes the sheet it makes itself, not one that describes another disc (audit 2026-10-05)
test('extractcd --redump leaves out a kept cue sheet whose track types are not the CHD\'s', () => {
  const keep = tmp('typed.chd'), plain = tmp('typed plain.chd'), edited = tmp('typed.cue'), mine = tmp('typed out'), made = tmp('typed made');
  for (const d of [mine, made]) fs.mkdirSync(d, { recursive: true });
  expect(run(ENGINE, ['createcd', '-i', 'fidelity.cue', '-o', keep, '-f', '--keepcue', '-c', 'none']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', 'fidelity.cue', '-o', plain, '-f', '-c', 'none']).code).toBe(0);
  fs.writeFileSync(edited, fs.readFileSync(path.join(FIXTURES, 'fidelity.cue'), 'latin1').replace('TRACK 01 MODE1/2352', 'TRACK 01 MODE2/2352'), 'latin1');
  expect(run(ENGINE, ['delmeta', '-i', keep, '-t', 'CUES']).code).toBe(0);
  expect(run(ENGINE, ['addmeta', '-i', keep, '-t', 'CUES', '-vf', edited, '-nocs']).code).toBe(0);
  const r = run(ENGINE, ['extractcd', '-i', keep, '-o', path.join(mine, 'x.cue'), '--redump']);
  expect(r.code).toBe(0);
  expect(r.out.toString()).not.toContain('the one kept when the CHD was made');
  expect(run(ENGINE, ['extractcd', '-i', plain, '-o', path.join(made, 'x.cue'), '--redump']).code).toBe(0);
  for (const n of fs.readdirSync(made)) expect(fs.readFileSync(path.join(mine, n)).equals(fs.readFileSync(path.join(made, n))), n).toBe(true);
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

// The codec plan (--codecplan, the page's "Nearly as small, faster"): each hunk tries only the codecs
// meant for what it holds (engine/README.md). Its bytes differ where a codec left out would have
// won, but not its data: 0.289 gives the CHD the same checksums and verifies it. It is also the
// same CHD at any thread count.
test('the codec plan keeps the checksums, and 0.289 verifies what it makes', () => {
  const sha1 = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  const upstreamInfo = (file, verbose) => run(UPSTREAM, ['info', ...(verbose ? ['-v'] : []), '-i', file]).out.toString();
  const checksums = file => { const o = upstreamInfo(file); return [/^SHA1:\s+(\w+)/m.exec(o)[1], /^Data SHA1:\s+(\w+)/m.exec(o)[1]]; };
  const codecsUsed = file => { // codecs that won hunks, from the table of 0.289's info -v
    const used = [];
    for (const m of upstreamInfo(file, true).matchAll(/^\s*[\d,]+\s+[\d.]+%\s+(.+?)\s*$/gm))
      if (!/^(Uncompressed|Copy from self|Copy from parent)$/.test(m[1])) used.push(m[1]);
    return used.sort();
  };
  const DATA = ['Deflate', 'Huffman', 'LZMA'];
  const cases = [
    // [command, input, options, the codecs the plan may use (null: any, a hunk can hold audio and data)]
    ['createcd', 'twine.cue', [], ['CD LZMA']],
    ['createcd', 'xa.cue', [], ['CD LZMA']],
    ['createcd', 'piano.cue', [], ['CD FLAC']],
    ['createcd', 'mgs disc1.cue', [], null],
    ['createcd', 'aerowings.gdi', [], null],
    ['createcd', 'codec mix cd.cue', [], null],
    ['createcd', 'codec mix cd.cue', ['-c', 'cdzl,cdfl'], null],
    ['createdvd', 'agent.iso', [], DATA],
    ['createhd', 'codec mix.img', [], DATA],
    ['createraw', 'codec mix.img', ['-hs', '16384', '-us', '4', '-c', 'zstd,flac,lzma'], ['LZMA', 'Zstandard']],
  ];
  for (const [command, input, extra, allowed] of cases) {
    const what = [command, input, ...extra].join(' ');
    const up = tmp('up.chd'), plan = tmp('plan.chd'), plan1 = tmp('plan1.chd');
    expect(run(UPSTREAM, [command, '-i', input, '-o', up, '-f', ...extra]).code, `upstream ${what}`).toBe(0);
    expect(run(ENGINE, [command, '-i', input, '-o', plan, '-f', '--codecplan', ...extra]).code, what).toBe(0);
    expect(run(ENGINE, [command, '-i', input, '-o', plan1, '-f', '-cp', '-np', '1', ...extra]).code, `${what}, 1 thread`).toBe(0);
    expect(checksums(plan), what).toEqual(checksums(up));
    expect(run(UPSTREAM, ['verify', '-i', plan]).code, `upstream verifies ${what}`).toBe(0);
    expect(sha1(plan1), `${what}: 1 thread and several`).toBe(sha1(plan));
    if (allowed) expect(allowed, `${what}: ${codecsUsed(plan)}`).toEqual(expect.arrayContaining(codecsUsed(plan)));
  }
  // the plan leaves out codecs that win hunks of these, so the bytes differ from chdman's
  for (const [command, input] of [['createcd', 'mgs disc1.cue'], ['createdvd', 'agent.iso']]) {
    const up = tmp('up.chd'), plan = tmp('plan.chd');
    run(UPSTREAM, [command, '-i', input, '-o', up, '-f']);
    run(ENGINE, [command, '-i', input, '-o', plan, '-f', '-cp']);
    expect(sha1(plan), `${command} ${input}`).not.toBe(sha1(up));
  }
});

// --libdeflate (the page's faster presets): the deflate codec encodes with libdeflate instead of
// zlib. Standard deflate, so 0.289 decodes it: the same checksums, verified by 0.289, and the same
// CHD at any thread count, whether deflate wins a hunk, loses it or gives up at the limit.
test('libdeflate keeps the checksums, and 0.289 verifies what it makes', () => {
  const sha1 = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  const checksums = file => { const o = run(UPSTREAM, ['info', '-i', file]).out.toString(); return [/^SHA1:\s+(\w+)/m.exec(o)[1], /^Data SHA1:\s+(\w+)/m.exec(o)[1]]; };
  const cases = [
    ['createcd', 'twine.cue', []],
    ['createcd', 'mgs disc1.cue', ['-c', 'cdzl,cdfl']],
    ['createcd', 'mgs disc1.cue', ['--codecplan']],
    ['createcd', 'codec mix cd.cue', ['-c', 'cdzl,cdlz,cdfl']],
    ['createdvd', 'agent.iso', ['-c', 'zlib,huff']],
    ['createhd', 'codec mix.img', ['-c', 'zlib,flac']],
    ['createraw', 'codec mix.img', ['-hs', '16384', '-us', '4', '-c', 'flac,zlib,lzma']],
  ];
  for (const [command, input, extra] of cases) {
    const what = [command, input, ...extra].join(' ');
    const up = tmp('up.chd'), ld = tmp('ld.chd'), ld1 = tmp('ld1.chd');
    const upExtra = extra.filter(a => a !== '--codecplan');
    expect(run(UPSTREAM, [command, '-i', input, '-o', up, '-f', ...upExtra]).code, `upstream ${what}`).toBe(0);
    expect(run(ENGINE, [command, '-i', input, '-o', ld, '-f', '--libdeflate', ...extra]).code, what).toBe(0);
    expect(run(ENGINE, [command, '-i', input, '-o', ld1, '-f', '-ld', '-np', '1', ...extra]).code, `${what}, 1 thread`).toBe(0);
    expect(checksums(ld), what).toEqual(checksums(up));
    expect(run(UPSTREAM, ['verify', '-i', ld]).code, `upstream verifies ${what}`).toBe(0);
    expect(sha1(ld1), `${what}: 1 thread and several`).toBe(sha1(ld));
    if (upExtra.includes('-c')) expect(sha1(ld), `${what}: not zlib's bytes`).not.toBe(sha1(up));
  }
});

// Robustness fixes for malformed or unusual input. For valid input the engine's CHDs stay 0.289's.

// deterministic noise (xorshift32), so the tests make the same files every time
function noise(seed, n) {
  let x = seed >>> 0;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    b[i] = x & 0xff;
  }
  return b;
}
const sha1of = file => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const write = (name, data) => { const p = tmp(name); fs.writeFileSync(p, data); return p; };

// A CD codec compresses the sectors, then the subcode after them into a buffer as large as a hunk.
// 0.289 lets the subcode run past its end when the sectors hardly compress (an AddressSanitizer build
// shows the heap overflow with these hunks); such a result can't win, so the CHD is the same.
test('a CD hunk whose subcode doesn\'t fit after its sectors makes upstream\'s CHD', () => {
  const raw = noise(1, 4 * 8 * 2448);
  for (let f = 0; f < 32; f++) raw.fill(0, f * 2448, f * 2448 + 10); // sectors that deflate to 18,813-18,815 bytes of 18,816
  const input = write('ovf.raw', raw);
  for (const codecs of ['cdzl', 'cdlz,cdzl,cdfl', 'cdzs']) {
    const up = tmp(`up-${codecs}.chd`), en = tmp(`en-${codecs}.chd`);
    const args = ['-i', input, '-hs', '19584', '-us', '2448', '-c', codecs, '-f'];
    expect(run(UPSTREAM, ['createraw', ...args, '-o', up]).code, `upstream ${codecs}`).toBe(0);
    expect(run(ENGINE, ['createraw', ...args, '-o', en]).code, codecs).toBe(0);
    expect(sha1of(en), codecs).toBe(sha1of(up));
    expect(run(ENGINE, ['verify', '-i', en]).code, `verify ${codecs}`).toBe(0);
  }
});

// cue and cdrdao TOC lines that belong to a track, before the first TRACK: 0.289 writes them before its
// track table (track -1), which can crash it or not, depending on what lies there
test('track lines before the first TRACK are an error, disc lines are fine', () => {
  write('t.bin', noise(2, 300 * 2352));
  const track = 'FILE "t.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';
  const toc = 'TRACK MODE1_RAW\nDATAFILE "t.bin" 00:04:00\n';
  for (const [name, text, message] of [
    ['index.cue', 'FILE "t.bin" BINARY\n  INDEX 01 00:00:00\n' + track, 'INDEX before the first TRACK'],
    ['pregap.cue', 'PREGAP 00:02:00\n' + track, 'PREGAP before the first TRACK'],
    ['postgap.cue', 'POSTGAP 00:02:00\n' + track, 'POSTGAP before the first TRACK'],
    ['flags.cue', 'FLAGS DCP\n' + track, 'FLAGS before the first TRACK'],
    ['leadout.cue', 'REM LEAD-OUT 00:10:00\n' + track, 'REM LEAD-OUT before the first TRACK'],
    ['datafile.toc', 'CD_ROM\nDATAFILE "t.bin"\n' + toc, 'DATAFILE before the first TRACK'],
    ['copy.toc', 'CD_ROM\nCOPY\n' + toc, 'COPY before the first TRACK'],
    ['start.toc', 'CD_ROM\nSTART 00:02:00\n' + toc, 'START before the first TRACK'],
  ]) {
    const input = write(name, text);
    const r = run(ENGINE, ['createcd', '-i', input, '-o', tmp('e.chd'), '-f']);
    expect({ code: r.code, signal: r.signal }, name).toEqual({ code: 1, signal: null });
    expect(r.err, name).toContain(message);
  }
  // what belongs to the disc may come first, as in 0.289
  for (const [name, text] of [
    ['header.cue', 'CATALOG 0000000000000\nREM GENRE Test\nREM COMMENT "x"\n' + track],
    ['header.toc', 'CD_ROM_XA\n// a comment\nCATALOG "0000000000000"\n' + toc],
  ]) {
    const input = write(name, text), up = tmp(`u-${name}.chd`), en = tmp(`e-${name}.chd`);
    expect(run(UPSTREAM, ['createcd', '-i', input, '-o', up, '-f']).code, `upstream ${name}`).toBe(0);
    expect(run(ENGINE, ['createcd', '-i', input, '-o', en, '-f']).code, name).toBe(0);
    expect(sha1of(en), name).toBe(sha1of(up));
  }
});

// A Nero image: 40 sectors of 2048 bytes, a DAOX chunk for one track, END! and the NER5 footer
function nrg({ start = 1, size = 2048, end = true, daoxSize = 64 } = {}) {
  const data = noise(3, 40 * 2048);
  const daox = Buffer.alloc(72);
  daox.write('DAOX', 0);
  daox.writeUInt32BE(daoxSize, 4);
  daox[28] = start; // first and last track
  daox[29] = start;
  daox.writeUInt16BE(size, 42); // sector size; mode 0 (2048-byte data) at 44
  daox.writeBigUInt64BE(BigInt(data.length), 64); // index 0 and 1 at 48 and 56 are 0, then the end
  const footer = Buffer.alloc(12);
  footer.write('NER5', 0);
  footer.writeBigUInt64BE(BigInt(data.length), 4);
  return Buffer.concat([data, daox, end ? Buffer.from('END!\0\0\0\0', 'latin1') : Buffer.alloc(0), footer]);
}

test('a broken NRG image is an error, not a crash or a hang', () => {
  // a well-formed one is still 0.289's
  const ok = write('ok.nrg', nrg()), up = tmp('ok-up.chd'), en = tmp('ok-en.chd');
  expect(run(UPSTREAM, ['createcd', '-i', ok, '-o', up, '-f']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', ok, '-o', en, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(up));
  const size0 = write('size0.nrg', nrg({ size: 0 }));
  expect(run(UPSTREAM, ['createcd', '-i', size0, '-o', tmp('u.chd'), '-f']).signal).toBeTruthy(); // SIGFPE
  // a sector size other than the mode's: 0.289 reads that many bytes into each frame of 2448 (a heap overflow for
  // 65535, which an AddressSanitizer build shows), and exits 0 with a CHD of other data
  const size4000 = write('size4000.nrg', nrg({ size: 4000 }));
  expect(run(UPSTREAM, ['createcd', '-i', size4000, '-o', tmp('u.chd'), '-f']).code).toBe(0);
  // (0.289 crashes on these, never finishes, or makes a CHD of other data)
  for (const [name, image, message] of [
    ['size0.nrg', null, 'has sectors of 0 bytes, which its mode (0) doesn\'t have'],
    ['size4000.nrg', null, 'has sectors of 4000 bytes'],
    ['size65535.nrg', nrg({ size: 65535 }), 'has sectors of 65535 bytes'],
    ['size2352.nrg', nrg({ size: 2352 }), 'has sectors of 2352 bytes'],
    ['track0.nrg', nrg({ start: 0 }), 'has tracks 0 to 0'],
    ['noend.nrg', nrg({ end: false }), 'end without an END! chunk'],
    ['past.nrg', nrg({ daoxSize: 1 << 20 }), 'end without an END! chunk'],
    ['short.nrg', Buffer.from('NER5'), 'Not a Nero 5.5 or later image'],
  ]) {
    const input = image ? write(name, image) : tmp(name);
    const r = run(ENGINE, ['createcd', '-i', input, '-o', tmp('e.chd'), '-f']);
    expect({ code: r.code, signal: r.signal }, name).toEqual({ code: 1, signal: null });
    expect(r.err, name).toContain(message);
  }
});

// A Nero image of `data` and its tracks, [mode, INDEX 00, INDEX 01, end] (byte positions), 2352-byte sectors
function nrgOf(data, tracks) {
  const daox = Buffer.alloc(30 + 42 * tracks.length);
  daox.write('DAOX', 0);
  daox.writeUInt32BE(daox.length - 8, 4);
  daox[28] = 1;
  daox[29] = tracks.length;
  tracks.forEach(([mode, i0, i1, end], n) => {
    const at = 30 + 42 * n;
    daox.writeUInt16BE(2352, at + 12);
    daox.writeUInt16BE(mode, at + 14);
    daox.writeBigUInt64BE(BigInt(i0), at + 18);
    daox.writeBigUInt64BE(BigInt(i1), at + 26);
    daox.writeBigUInt64BE(BigInt(end), at + 34);
  });
  const footer = Buffer.alloc(12);
  footer.write('NER5', 0);
  footer.writeBigUInt64BE(BigInt(data.length), 4);
  return Buffer.concat([data, daox, Buffer.from('END!\0\0\0\0', 'latin1'), footer]);
}

// 0.289 reads a Nero image's track at the sum of the earlier tracks' lengths without their pregaps, so after a
// track whose pregap the image holds it reads the wrong bytes; and it drops the pregap's data (a virtual pregap).
// The engine takes each track from its INDEX 00 and stores the pregap, as for a cue sheet's INDEX 00 in the file.
test('an NRG image with pregaps makes the CHD of the same disc as a cue sheet', () => {
  const F = 2352, disc = noise(12, 900 * F);
  write('pg.bin', disc);
  // track 1: 150 frames of pregap, then 300; track 2 (audio) the same
  const nrgImage = write('pg.nrg', nrgOf(disc, [[0x600, 0, 150 * F, 450 * F], [0x700, 450 * F, 600 * F, 900 * F]]));
  const cue = write('pg.cue', 'FILE "pg.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n' +
    '  TRACK 02 AUDIO\n    INDEX 00 00:06:00\n    INDEX 01 00:08:00\n');
  // the fixture ps1-nrg: a pregap in track 2 only
  for (const [image, twin] of [[nrgImage, cue], ['mgs.nrg', 'mgs ccd-ref.cue']]) {
    const en = tmp('en.chd'), up = tmp('up.chd'), plain = tmp('plain.chd');
    expect(run(UPSTREAM, ['createcd', '-i', twin, '-o', plain, '-f']).code).toBe(0);
    expect(run(UPSTREAM, ['createcd', '-i', image, '-o', up, '-f']).code).toBe(0);
    expect(run(ENGINE, ['createcd', '-i', image, '-o', en, '-f']).code).toBe(0);
    expect(sha1of(en), image).toBe(sha1of(plain));
    expect(sha1of(up), `upstream ${image}`).not.toBe(sha1of(plain)); // the bug
  }
  // without pregaps, 0.289's CHD
  const plain = write('nopg.nrg', nrgOf(disc, [[0x600, 0, 0, 450 * F], [0x700, 450 * F, 450 * F, 900 * F]]));
  const en = tmp('nopg-en.chd'), up = tmp('nopg-up.chd');
  expect(run(UPSTREAM, ['createcd', '-i', plain, '-o', up, '-f']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', plain, '-o', en, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(up));
  // a track that isn't in the file is an error
  const r = run(ENGINE, ['createcd', '-i', write('out.nrg', nrgOf(disc, [[0x600, 0, 0, 901 * F]])), '-o', tmp('e.chd'), '-f']);
  expect({ code: r.code, signal: r.signal }).toEqual({ code: 1, signal: null });
  expect(r.err).toContain('isn\'t in the file');
});

// cdrdao TOCs as cdrdao reads them (engine/README.md). 0.289 made START a pregap that isn't in the file although
// the file holds it, ignored PREGAP, SILENCE and ZERO, kept only a track's last file statement, read a lone
// DATAFILE length after track 1 as an offset and a plain number as frames, and gave a statement without a
// length no data. Each TOC here makes the CHD of a cue sheet of the same disc, which 0.289 reads right.
test('cdrdao TOCs make the CHD of the same disc as a cue sheet', () => {
  const F = 2352, d1 = noise(20, 300 * F), pg = noise(21, 150 * F), a2 = noise(22, 200 * F);
  write('d1.bin', d1);
  write('d2.bin', noise(23, 150 * F));
  write('pg.raw', pg);
  write('a2.raw', a2);
  write('a2pg.raw', Buffer.concat([pg, a2]));
  const t1 = 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "d1.bin" 00:04:00\n';
  const c1 = 'FILE "d1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';
  // the audio's pregap in its file, or not in any file (SWAP: the cue sheets' BINARY audio is little-endian)
  const stored = c1 + 'FILE "a2pg.raw" BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n';
  const virtual = c1 + 'FILE "a2.raw" BINARY\n  TRACK 02 AUDIO\n    PREGAP 00:02:00\n    INDEX 01 00:00:00\n';
  const cases = [
    // [TOC, the cue sheet of the same disc, whether 0.289 finishes]
    [t1 + 'TRACK AUDIO\nFILE "a2pg.raw" SWAP 0 00:04:50\nSTART 00:02:00\n', stored, true], // the pregap in the file
    [t1 + 'TRACK AUDIO\nFILE "a2pg.raw" SWAP 0\nSTART 00:02:00\n', stored, true], // no length: the rest of the file
    [t1 + 'TRACK AUDIO\nFILE "pg.raw" SWAP 0 00:02:00\nSTART\nFILE "a2.raw" SWAP 0 00:02:50\n', stored, true], // two files
    [t1 + 'TRACK AUDIO\nFILE "a2pg.raw" SWAP 0 00:02:00\nSTART\nFILE "a2pg.raw" SWAP 00:02:00 00:02:50\n', stored, true], // cdrdao's own
    [t1 + 'TRACK AUDIO\nPREGAP 00:02:00\nFILE "a2.raw" SWAP 0 00:02:50\n', virtual, true],
    [t1 + 'TRACK AUDIO\nSILENCE 00:02:00\nSTART\nFILE "a2.raw" SWAP 0 00:02:50\n', virtual, true],
    [t1 + 'TRACK AUDIO\nZERO AUDIO 00:02:00\nFILE "a2.raw" SWAP 0\nSTART 00:02:00\n', virtual, false], // as extractcd writes it
    // a plain number: bytes for DATAFILE, samples for AUDIOFILE
    ['CD_ROM\nTRACK MODE1_RAW\nDATAFILE "d1.bin" #0 705600\nTRACK AUDIO\nAUDIOFILE "a2.raw" SWAP 0 117600\n',
      c1 + 'FILE "a2.raw" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n', true],
    // a lone DATAFILE length after track 1, as extractcd -sb writes it; DATAFILE without a length
    [t1 + 'TRACK MODE1_RAW\nDATAFILE "d2.bin" 00:02:00\n', c1 + 'FILE "d2.bin" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n', true],
    ['CD_ROM\nTRACK MODE1_RAW\nDATAFILE "d1.bin"\nTRACK MODE1_RAW\nDATAFILE "d2.bin"\n',
      c1 + 'FILE "d2.bin" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n', false],
  ];
  cases.forEach(([toc, cue, finishes], n) => {
    const input = write(`t${n}.toc`, toc), twin = write(`t${n}.cue`, cue);
    const en = tmp(`t${n}.chd`), up = tmp(`t${n}-up.chd`), plain = tmp(`t${n}-cue.chd`);
    expect(run(UPSTREAM, ['createcd', '-i', twin, '-o', plain, '-f']).code, `cue ${n}`).toBe(0);
    expect(run(ENGINE, ['createcd', '-i', input, '-o', en, '-f']).code, toc).toBe(0);
    expect(sha1of(en), toc).toBe(sha1of(plain));
    // the bug: 0.289 makes another CHD, or fails reading past the end of a file
    if (finishes) expect(run(UPSTREAM, ['createcd', '-i', input, '-o', up, '-f']).code === 0 ? sha1of(up) : 'failed', `upstream ${toc}`).not.toBe(sha1of(plain));
  });
  // the fixture ps1-toc: START on an audio track whose file holds the pregap, as mgs disc1.cue's INDEX 00 (the
  // TOC's audio is big-endian: the same sheet with MOTOROLA files, which the engine reads right)
  const en = tmp('mgs.chd'), up = tmp('mgs-up.chd'), plain = tmp('mgs-cue.chd');
  for (const n of [1, 2]) fs.copyFileSync(path.join(FIXTURES, `mgs disc1 (Track ${n}).bin`), tmp(`mgs disc1 (Track ${n}).bin`));
  const moto = write('mgs moto.cue', fs.readFileSync(path.join(FIXTURES, 'mgs disc1.cue'), 'latin1').replaceAll('BINARY', 'MOTOROLA'));
  expect(run(ENGINE, ['createcd', '-i', moto, '-o', plain, '-f']).code).toBe(0);
  expect(run(UPSTREAM, ['createcd', '-i', 'mgs disc1.toc', '-o', up, '-f']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', 'mgs disc1.toc', '-o', en, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(plain));
  expect(sha1of(up)).not.toBe(sha1of(plain));
  // the TOCs extractcd writes, which 0.289 reads (with #0 for a track in its own file): 0.289's CHD
  const chd = makeChd('createcd', 'mgs disc1.cue');
  for (const split of [false, true]) {
    const dir = tmp(`x-${split}`);
    fs.mkdirSync(dir, { recursive: true });
    expect(run(UPSTREAM, ['extractcd', '-i', chd, '-o', path.join(dir, 'x.toc'), ...(split ? ['-sb'] : [])]).code).toBe(0);
    const toc = path.join(dir, 'x.toc');
    fs.writeFileSync(toc, fs.readFileSync(toc, 'utf8').replace(/^(DATAFILE "[^"]*" )(\d)/gm, '$1#0 $2'));
    const a = tmp(`x-${split}-en.chd`), b = tmp(`x-${split}-up.chd`);
    expect(run(UPSTREAM, ['createcd', '-i', toc, '-o', b, '-f']).code).toBe(0);
    expect(run(ENGINE, ['createcd', '-i', toc, '-o', a, '-f']).code).toBe(0);
    expect(sha1of(a), `extractcd ${split ? '-sb' : ''}`).toBe(sha1of(b));
  }
  // what the engine refuses
  for (const [toc, message] of [
    [t1 + 'TRACK AUDIO\nFILE "pg.raw" 0\nFILE "a2.raw" SWAP 0\n', 'has samples in both byte orders'],
    [t1 + 'TRACK AUDIO\nFILE "pg.raw" 0\nSTART 00:02:00\n', 'START is at or past its end'],
    [t1 + 'TRACK AUDIO\nFILE "gone.raw" 0\n', 'couldn\'t find bin file'],
    [t1 + 'TRACK AUDIO\nSILENCE\n', 'without a length'],
    // past the end of the file (0.289 failed reading)
    [t1 + 'TRACK AUDIO\nFILE "pg.raw" SWAP 0 00:02:01\n', 'track 2 asks for 355152 bytes of [' + tmp('pg.raw') + '] from byte 0, but only 352800 are there'],
    [t1 + 'TRACK AUDIO\nFILE "pg.raw" SWAP 00:02:01\n', 'from byte 355152, but only 0 are there'],
    // numbers too large to be lengths: the engine before wrapped them (a length of 2^64 - 1 bytes gave a track of 0
    // frames, 2^62 samples none at all, the rest of the file), and 0.289 overflowed the minutes
    ['CD_ROM\nTRACK MODE1\nDATAFILE "d1.bin" 00:00:10\nDATAFILE "d1.bin" #20480 18446744073709551615\n', 'too large (18446744073709551615)'],
    ['CD_ROM\nTRACK MODE1\nDATAFILE "d1.bin" #18446744073709551616\n', 'too large'],
    [t1 + 'TRACK AUDIO\nFILE "a2.raw" SWAP 0 4611686018427387904\n', 'too large'],
    [t1 + 'TRACK AUDIO\nFILE "a2.raw" SWAP 0 999999999:00:00\n', 'too large'],
    [t1 + 'TRACK AUDIO\nZERO 999999999:00:00\n', 'is too long'],
    [t1 + 'TRACK AUDIO\nFILE "a2.raw" SWAP 0\nSTART 999999999:00:00\n', 'START is at or past its end'],
    // samples in a track with sub-channel data, and ZERO in another mode than its track's (cdrdao refuses the
    // first, and makes sectors of that mode for the second, which a CHD track can't hold)
    ['CD_DA\nTRACK AUDIO RW_RAW\nFILE "a2.raw" 0\n', 'has sub-channel data, which a FILE of samples'],
    ['CD_DA\nTRACK AUDIO RW\nSILENCE 00:02:00\n', 'has sub-channel data, which a SILENCE of samples'],
    ['CD_ROM\nTRACK MODE1_RAW\nZERO MODE1 20480\nDATAFILE "d1.bin"\n', 'ZERO has MODE1, which isn\'t the track\'s mode'],
    ['CD_ROM\nTRACK MODE1_RAW\nZERO MODE1_RAW RW 00:00:10\nDATAFILE "d1.bin"\n', 'ZERO has RW, which isn\'t the track\'s mode'],
    [t1 + 'TRACK AUDIO\nSILENCE AUDIO 00:02:00\n', 'SILENCE has AUDIO'],
  ]) {
    const r = run(ENGINE, ['createcd', '-i', write('bad.toc', toc), '-o', tmp('e.chd'), '-f']);
    expect({ code: r.code, signal: r.signal }, toc).toEqual({ code: 1, signal: null });
    expect(r.err, toc).toContain(message);
  }
});

// extractcd's TOC. 0.289 writes `ZERO` before every pregap, but a pregap the CHD holds (a cue sheet's INDEX 00,
// PGTYPE:V…) is in the file it writes: `ZERO` reads back (in cdrdao and the engine alike) as zeros followed by the
// pregap's data, a longer disc. The engine writes `ZERO` only for a pregap that isn't in the CHD (a cue sheet's
// PREGAP), so a CD reads back as the CHD it came from; otherwise the TOC is 0.289's.
test('extractcd writes a TOC that reads back as the same CHD', () => {
  const F = 2352;
  write('rt1.bin', noise(60, 301 * F));
  write('rt2.bin', noise(61, 350 * F));
  write('rt3.bin', noise(62, 100 * F));
  const one = 'FILE "rt1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';
  // pregaps in the files (INDEX 00), and not in any file (PREGAP), on audio and data tracks
  const stored = write('rt stored.cue', one + 'FILE "rt2.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n' +
    'FILE "rt3.bin" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 00 00:00:00\n    INDEX 01 00:00:50\n');
  const virtual = write('rt virtual.cue', one + 'FILE "rt2.bin" BINARY\n  TRACK 02 AUDIO\n    PREGAP 00:02:00\n    INDEX 01 00:00:00\n' +
    'FILE "rt3.bin" BINARY\n  TRACK 03 MODE1/2352\n    PREGAP 00:01:00\n    INDEX 01 00:00:00\n');
  const fixtures = ['mgs disc1.cue', 'mgs disc1.toc', 'mgs.nrg', 'twine.cue', 'xa.cue', 'ax101.cue', 'codec mix cd.cue', 'fidelity.cue',
    'moto.cue', 'shared.cue', 'wavs.cue', 'piano.cue', 'cdi disc.cue'];
  for (const input of [stored, virtual, ...fixtures]) {
    const chd = tmp('rt.chd'), name = path.basename(input);
    expect(run(ENGINE, ['createcd', '-i', input, '-o', chd, '-f']).code, name).toBe(0);
    for (const split of [[], ['-sb']]) {
      const x = {};
      for (const [who, bin] of [['en', ENGINE], ['up', UPSTREAM]]) {
        const dir = tmp(`rt-${who}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        expect(run(bin, ['extractcd', '-i', chd, '-o', path.join(dir, 'x.toc'), ...split]).code, `${who} ${name} ${split}`).toBe(0);
        x[who] = { dir, toc: fs.readFileSync(path.join(dir, 'x.toc'), 'latin1') };
      }
      // the same track files; the TOC is 0.289's but for ZERO before a pregap in the file
      const files = fs.readdirSync(x.en.dir).sort();
      expect(fs.readdirSync(x.up.dir).sort(), name).toEqual(files);
      for (const f of files.filter(f => !f.endsWith('.toc'))) expect(sha1of(path.join(x.en.dir, f)), `${name} ${f}`).toBe(sha1of(path.join(x.up.dir, f)));
      expect(x.en.toc, `${name} ${split}`).toBe(input === virtual ? x.up.toc : x.up.toc.replace(/^ZERO .*\n/gm, ''));
      // and it reads back as the same CHD, byte for byte
      const back = tmp('rt-back.chd');
      expect(run(ENGINE, ['createcd', '-i', path.join(x.en.dir, 'x.toc'), '-o', back, '-f']).code, name).toBe(0);
      expect(sha1of(back), `${name} ${split}`).toBe(sha1of(chd));
      // the bug: 0.289's TOC makes a longer disc
      if (input === stored || name === 'mgs disc1.cue') {
        expect(run(ENGINE, ['createcd', '-i', path.join(x.up.dir, 'x.toc'), '-o', back, '-f']).code, name).toBe(0);
        expect(sha1of(back), `upstream TOC ${name}`).not.toBe(sha1of(chd));
      }
    }
  }
});

// A WAVE file: RIFF, fmt (16-bit stereo 44.1 kHz PCM), optionally a LIST chunk, then the samples
function wavOf(pcm, list = false) {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(44100, 12); fmt.writeUInt32LE(44100 * 4, 16); fmt.writeUInt16LE(4, 20); fmt.writeUInt16LE(16, 22);
  const extra = list ? Buffer.concat([Buffer.from('LIST\x0a\0\0\0INFOabcdef', 'latin1')]) : Buffer.alloc(0);
  const data = Buffer.alloc(8);
  data.write('data', 0); data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, extra, data, pcm]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

// cdrdao reads an audio file whose name ends in .wav as a WAVE file: its samples, which are little-endian, from
// the data chunk on (SWAP: the other byte order). 0.289, and the engine before, read the header as audio and the
// samples as big-endian, as in a raw file.
test('a WAVE file in a TOC is read as in a cue sheet', () => {
  const F = 2352, pcm = noise(80, 350 * F);
  write('w1.bin', noise(81, 300 * F));
  write('w.wav', wavOf(pcm, true));
  write('w.raw', pcm);
  const be = Buffer.from(pcm);
  be.swap16();
  write('w.be', be);
  const cue = write('w.cue', 'FILE "w1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n' +
    'FILE "w.wav" WAVE\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n');
  const plain = tmp('w-cue.chd');
  expect(run(UPSTREAM, ['createcd', '-i', cue, '-o', plain, '-f']).code).toBe(0);
  const t = 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "w1.bin"\nTRACK AUDIO\n';
  const tocs = [
    t + 'AUDIOFILE "w.wav" 0\nSTART 00:02:00\n',
    t + 'FILE "w.wav" 0 00:04:50\nSTART 00:02:00\n',
    t + 'AUDIOFILE "w.wav" 0 0\nSTART 00:02:00\n', // a length of 0: the rest of the file, as none
    t + 'AUDIOFILE "w.wav" 0 88200\nSTART\nAUDIOFILE "w.wav" 88200\n', // in samples
    t + 'AUDIOFILE "w.be" 0\nSTART 00:02:00\n', // the same samples, in a raw file
    t + 'AUDIOFILE "w.raw" SWAP 0\nSTART 00:02:00\n',
  ];
  tocs.forEach((toc, n) => {
    const en = tmp(`w${n}.chd`);
    expect(run(ENGINE, ['createcd', '-i', write(`w${n}.toc`, toc), '-o', en, '-f']).code, toc).toBe(0);
    expect(sha1of(en), toc).toBe(sha1of(plain));
  });
  // the bug: 0.289 reads the header as audio, and the samples in the other byte order (with lengths, which it needs)
  const withLengths = write('w-up.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "w1.bin" #0 00:04:00\nTRACK AUDIO\nAUDIOFILE "w.wav" 0 00:04:50\nSTART 00:02:00\n');
  const en = tmp('w-en.chd'), up = tmp('w-up.chd');
  expect(run(ENGINE, ['createcd', '-i', withLengths, '-o', en, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(plain));
  expect(run(UPSTREAM, ['createcd', '-i', withLengths, '-o', up, '-f']).code).toBe(0);
  expect(sha1of(up)).not.toBe(sha1of(plain));
  // SWAP on a WAVE file: its bytes as they are, as a raw file without SWAP
  const a = tmp('ws.chd'), b = tmp('wr.chd');
  expect(run(ENGINE, ['createcd', '-i', write('ws.toc', t + 'AUDIOFILE "w.wav" SWAP 0\n'), '-o', a, '-f']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', write('wr.toc', t + 'AUDIOFILE "w.raw" 0\n'), '-o', b, '-f']).code).toBe(0);
  expect(sha1of(a)).toBe(sha1of(b));
  // #offset: where the WAVE file starts in the file, as cdrdao reads it (TrackData.cc: waveLength parses the header
  // there), and start and length count from its samples; the engine before counted the offset from the samples
  write('in.wav', Buffer.concat([noise(83, 1000), wavOf(pcm, true), noise(84, 5000)]));
  for (const toc of [t + 'AUDIOFILE "in.wav" #1000 0\nSTART 00:02:00\n', t + 'AUDIOFILE "in.wav" #1000 0 88200\nSTART\nAUDIOFILE "in.wav" #1000 88200\n']) {
    const en = tmp('in.chd');
    expect(run(ENGINE, ['createcd', '-i', write('in.toc', toc), '-o', en, '-f']).code, toc).toBe(0);
    expect(sha1of(en), toc).toBe(sha1of(plain)); // (the data chunk ends before the 5000 bytes after it)
  }
  // not a WAVE file, or no WAVE file at the offset
  write('bad.wav', noise(82, 10 * F));
  for (const toc of [t + 'AUDIOFILE "bad.wav" 0\n', t + 'AUDIOFILE "w.wav" #44 0\n', t + 'AUDIOFILE "in.wav" 0\n']) {
    const r = run(ENGINE, ['createcd', '-i', write('bad.toc', toc), '-o', tmp('e.chd'), '-f']);
    expect({ code: r.code, signal: r.signal }, toc).toEqual({ code: 1, signal: null });
    expect(r.err, toc).toContain('not a valid .WAV');
  }
});

// cdrdao pads a track whose data ends inside a sector with zeros; 0.289, and the engine before, dropped that last
// sector. Cue sheets keep 0.289's reading, which drops it too (Redump's files are always whole sectors).
test('a TOC track whose data ends inside a sector gets the rest of the sector as zeros', () => {
  const F = 2352, d = noise(70, 300 * F + 1000), a = noise(71, 200 * F + 400); // 400 bytes: 100 samples
  write('part.bin', d);
  write('part.raw', a);
  write('padded.bin', Buffer.concat([d, Buffer.alloc(F - 1000)]));
  write('padded.raw', Buffer.concat([a, Buffer.alloc(F - 400)]));
  const disc = (d1, a2) => `FILE "${d1}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "${a2}" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n`;
  const plain = tmp('padded.chd');
  expect(run(UPSTREAM, ['createcd', '-i', write('padded.cue', disc('padded.bin', 'padded.raw')), '-o', plain, '-f']).code).toBe(0);
  for (const toc of [
    'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "part.bin"\nTRACK AUDIO\nAUDIOFILE "part.raw" SWAP 0\n', // lengths from the files' sizes
    'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "part.bin" 706600\nTRACK AUDIO\nAUDIOFILE "part.raw" SWAP 0 117700\n', // in bytes, and samples
  ]) {
    const en = tmp('part.chd');
    expect(run(ENGINE, ['createcd', '-i', write('part.toc', toc), '-o', en, '-f']).code, toc).toBe(0);
    expect(sha1of(en), toc).toBe(sha1of(plain));
  }
  // ZERO and SILENCE that end inside a sector: a sector of zeros, whatever the file holds past the length before
  const z = tmp('z.chd'), zp = tmp('zp.chd');
  expect(run(ENGINE, ['createcd', '-i', write('z.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "part.bin" 00:04:00\nZERO 1000\nTRACK AUDIO\nAUDIOFILE "part.raw" SWAP 0 00:02:50\nSILENCE 100\n'), '-o', z, '-f']).code).toBe(0);
  write('p301.bin', Buffer.concat([d.subarray(0, 300 * F), Buffer.alloc(F)]));
  write('p201.raw', Buffer.concat([a.subarray(0, 200 * F), Buffer.alloc(F)]));
  expect(run(UPSTREAM, ['createcd', '-i', write('zp.cue', disc('p301.bin', 'p201.raw')), '-o', zp, '-f']).code).toBe(0);
  expect(sha1of(z)).toBe(sha1of(zp));
  // the bug: 0.289 makes another CHD, or fails
  const up = tmp('part-up.chd');
  expect(run(UPSTREAM, ['createcd', '-i', write('part-up.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "part.bin" #0 00:04:01\nTRACK AUDIO\nAUDIOFILE "part.raw" SWAP 0\n'), '-o', up, '-f']).code === 0 ? sha1of(up) : 'failed').not.toBe(sha1of(plain));
  // a cue sheet of the same files: 0.289's CHD, without the last sectors
  const cue = write('part.cue', disc('part.bin', 'part.raw')), en = tmp('part-cue.chd'), upc = tmp('part-cue-up.chd');
  expect(run(UPSTREAM, ['createcd', '-i', cue, '-o', upc, '-f']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', cue, '-o', en, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(upc));
  expect(sha1of(en)).not.toBe(sha1of(plain));
  // data after a statement that ends inside a sector would not start on a sector: an error
  const r = run(ENGINE, ['createcd', '-i', write('mid.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "part.bin" 706600\nDATAFILE "part.bin" 00:01:00\n'), '-o', tmp('e.chd'), '-f']);
  expect({ code: r.code, signal: r.signal }).toEqual({ code: 1, signal: null });
  expect(r.err).toContain('ends inside a sector');
});

// The page identifies a CHD's data tracks with cdrom_file's logical reads (wasm_probe_read), which no chdman
// command uses. 0.289 served a track's pregap from the end of the track before, shifted by that track's padding,
// and a pregap or postgap that isn't in the CHD from the next track's data. tests/support/cdprobe.cpp reads every
// LBA as the page does: now each is the disc's, and a gap the CHD doesn't hold is zeros.
test('logical reads give each pregap its own data, and zeros where the CHD holds none', () => {
  test.setTimeout(600_000);
  const probe = path.join(ROOT, 'build', 'cdprobe-native');
  const make = spawnSync('make', ['-s', '-C', path.join(ROOT, 'wasm'), 'T=native', `O=${path.join(ROOT, 'build', 'obj-native')}`, 'cdprobe'], { timeout: 590_000 });
  expect(make.status, String(make.stderr)).toBe(0);
  const F = 2352, t1 = noise(90, 301 * F), pg2 = noise(91, 150 * F), t2 = noise(92, 200 * F), t3 = noise(93, 100 * F), t4 = noise(94, 50 * F);
  write('l1.bin', t1);
  write('l2.bin', Buffer.concat([pg2, t2]));
  write('l3.bin', t3);
  write('l4.bin', t4);
  // track 1 is padded with 3 frames in the CHD; track 2's pregap is in its file; track 3's pregap and postgap aren't
  const cue = write('l.cue', 'FILE "l1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n' +
    'FILE "l2.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n' +
    'FILE "l3.bin" BINARY\n  TRACK 03 MODE1/2352\n    PREGAP 00:01:00\n    INDEX 01 00:00:00\n    POSTGAP 00:00:30\n' +
    'FILE "l4.bin" BINARY\n  TRACK 04 AUDIO\n    INDEX 01 00:00:00\n');
  const chd = tmp('l.chd'), out = tmp('l.raw');
  expect(run(UPSTREAM, ['createcd', '-i', cue, '-o', chd, '-f']).code).toBe(0);
  const r = spawnSync(probe, [chd, out]);
  expect(r.status, String(r.stderr)).toBe(0);
  const text = r.stdout.toString();
  expect(text).not.toContain('fail');
  expect(text).toContain('leadout 906');
  // each LBA is its track's from INDEX 00 on
  expect(text.match(/^lba \d+ track \d+$/gm)).toEqual(['lba 0 track 1', 'lba 301 track 2', 'lba 651 track 3', 'lba 856 track 4']);
  // and INDEX 00 in a pregap (the engine before counted back from INDEX 01 there, which wrapped)
  expect(text.match(/^lba \d+ index \d+$/gm)).toEqual(['lba 0 index 1', 'lba 301 index 0', 'lba 451 index 1', 'lba 651 index 0', 'lba 726 index 1']);
  const be = b => Buffer.from(b).swap16(); // the CHD's audio is big-endian
  const want = Buffer.concat([t1, be(pg2), be(t2), Buffer.alloc(75 * F), t3, Buffer.alloc(30 * F), be(t4)]);
  const got = fs.readFileSync(out);
  expect(got.length).toBe(want.length);
  const wrong = [];
  for (let s = 0; s < want.length / F; s++) if (!got.subarray(s * F, (s + 1) * F).equals(want.subarray(s * F, (s + 1) * F))) wrong.push(s);
  expect(wrong).toEqual([]);
});

// Damaged FLAC data (cdfl) can make libFLAC's LPC and fixed-predictor restores overflow 32 bits, which C leaves
// undefined (the build wrapped, as two's complement). They compute modulo 2^32 now: the same results, so such a hunk
// fails as before.
// 0.289's decoder hangs on each of these.
test('damaged FLAC audio is an error', () => {
  const good = makeChd('createcd', 'codec mix cd.cue');
  // (the last two overflowed libFLAC's fixed-predictor restore, fixed.c, in the same way)
  for (const [at, xor] of [[1176968, 17], [1391207, 11], [1410799, 169], [1419408, 218], [1470418, 37], [1603281, 66], [1215763, 157], [1219803, 59]]) {
    const bad = tmp('bad.chd'), b = fs.readFileSync(good);
    b[at] ^= xor;
    fs.writeFileSync(bad, b);
    for (const args of [['verify', '-i', bad], ['extractcd', '-i', bad, '-o', tmp('x.cue'), '-f']]) {
      const r = run(ENGINE, args);
      expect({ code: r.code, signal: r.signal }, `${args[0]} ${at}`).toEqual({ code: 1, signal: null });
      expect(r.err, `${args[0]} ${at}`).toContain('Decompression error');
    }
  }
});

// EAC's "gaps appended to the previous track": a track's INDEX 00 at the end of one FILE, its INDEX 01 at the
// start of the next. 0.289 read the track from the first file at the second file's INDEX points (a pregap of
// -300 frames). The engine reads the pregap from the end of the first file: the CHD of the disc as one file.
test('a cue sheet with pregaps at the end of the previous FILE makes the CHD of the disc as one file', () => {
  const F = 2352, t1 = noise(30, 300 * F), pg2 = noise(31, 150 * F), t2 = noise(32, 200 * F), pg3 = noise(33, 75 * F), t3 = noise(34, 100 * F);
  const wav = pcm => {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(44100, 24); h.writeUInt32LE(44100 * 4, 28);
    h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
  };
  const files = [Buffer.concat([t1, pg2]), Buffer.concat([t2, pg3]), t3];
  files.forEach((f, n) => { write(`eac${n}.bin`, f); write(`eac${n}.wav`, wav(f)); });
  write('eac all.bin', Buffer.concat(files));
  const eac = (ext, type) => `FILE "eac0.${ext}" ${type}\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:04:00\n` +
    `FILE "eac1.${ext}" ${type}\n    INDEX 01 00:00:00\n  TRACK 03 AUDIO\n    INDEX 00 00:02:50\nFILE "eac2.${ext}" ${type}\n    INDEX 01 00:00:00\n`;
  const one = write('eac all.cue', 'FILE "eac all.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:04:00\n' +
    '    INDEX 01 00:06:00\n  TRACK 03 AUDIO\n    INDEX 00 00:08:50\n    INDEX 01 00:09:50\n');
  const plain = tmp('all.chd');
  expect(run(UPSTREAM, ['createcd', '-i', one, '-o', plain, '-f']).code).toBe(0);
  for (const [ext, type] of [['bin', 'BINARY'], ['wav', 'WAVE']]) {
    const cue = write(`eac ${ext}.cue`, eac(ext, type)), en = tmp(`eac-${ext}.chd`), up = tmp(`eac-${ext}-up.chd`);
    expect(run(ENGINE, ['createcd', '-i', cue, '-o', en, '-f']).code, type).toBe(0);
    expect(sha1of(en), type).toBe(sha1of(plain));
    // the bug: 0.289 makes another CHD, or fails
    expect(run(UPSTREAM, ['createcd', '-i', cue, '-o', up, '-f']).code === 0 ? sha1of(up) : 'failed', `upstream ${type}`).not.toBe(sha1of(plain));
  }
  // EAC's other layouts are 0.289's: gaps left out (PREGAP), and gaps appended to the next track (INDEX 00 in the track's file)
  for (const [name, text] of [
    ['eac left out.cue', 'FILE "eac0.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\nFILE "eac1.bin" BINARY\n  TRACK 02 AUDIO\n' +
      '    PREGAP 00:02:00\n    INDEX 01 00:00:00\nFILE "eac2.bin" BINARY\n  TRACK 03 AUDIO\n    PREGAP 00:01:00\n    INDEX 01 00:00:00\n'],
    ['eac next.cue', 'FILE "eac0.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\nFILE "eac1.wav" WAVE\n  TRACK 02 AUDIO\n' +
      '    INDEX 00 00:00:00\n    INDEX 01 00:02:00\nFILE "eac2.bin" BINARY\n  TRACK 03 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:00:30\n'],
  ]) {
    const cue = write(name, text), en = tmp('en.chd'), up = tmp('up.chd');
    expect(run(UPSTREAM, ['createcd', '-i', cue, '-o', up, '-f']).code, name).toBe(0);
    expect(run(ENGINE, ['createcd', '-i', cue, '-o', en, '-f']).code, name).toBe(0);
    expect(sha1of(en), name).toBe(sha1of(up));
  }
});

// 0.289 types an .iso by its size: an image of 2352-byte sectors whose size is also a multiple of 2048 (128 sectors
// times any number) or of 2336 (146 sectors times any number) came out as 2048- or 2336-byte sectors. The engine
// also looks for the first two sectors' sync pattern and mode byte.
test('an .iso of 2352-byte sectors is one, whatever its size', () => {
  const raw = (sectors, seed) => {
    const b = noise(seed, sectors * 2352);
    for (let s = 0; s < sectors; s++) {
      const at = s * 2352;
      b.fill(0xff, at, at + 12);
      b[at] = b[at + 11] = 0;
      b[at + 15] = 1; // mode 1
    }
    return b;
  };
  for (const [sectors, fixed] of [[128, true], [256, true], [146, true], [100, false], [129, false]]) {
    const iso = write(`raw${sectors}.iso`, raw(sectors, 40 + sectors));
    const twin = write(`raw${sectors}.cue`, `FILE "raw${sectors}.iso" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n`);
    const en = tmp(`${sectors}.chd`), up = tmp(`${sectors}-up.chd`), plain = tmp(`${sectors}-cue.chd`);
    expect(run(UPSTREAM, ['createcd', '-i', twin, '-o', plain, '-f']).code).toBe(0);
    expect(run(UPSTREAM, ['createcd', '-i', iso, '-o', up, '-f']).code).toBe(0);
    expect(run(ENGINE, ['createcd', '-i', iso, '-o', en, '-f']).code).toBe(0);
    expect(sha1of(en), `${sectors} sectors`).toBe(sha1of(plain));
    expect(sha1of(up) === sha1of(plain), `upstream, ${sectors} sectors`).toBe(!fixed); // the bug
  }
  // images of 2048-byte sectors, and of 2336, are 0.289's
  for (const [name, data] of [['cooked.iso', noise(50, 147 * 2048)], ['mode2.iso', noise(51, 147 * 2336)], ['zeros.iso', Buffer.alloc(128 * 2352)]]) {
    const iso = write(name, data), en = tmp('en.chd'), up = tmp('up.chd');
    expect(run(UPSTREAM, ['createcd', '-i', iso, '-o', up, '-f']).code, name).toBe(0);
    expect(run(ENGINE, ['createcd', '-i', iso, '-o', en, '-f']).code, name).toBe(0);
    expect(sha1of(en), name).toBe(sha1of(up));
  }
});

// 0.289 sizes the map's buffer without the Huffman tree that starts it, so the map of a CHD of a hunk
// or so overflows: creation exits 0, but the map's last bytes are whatever lay past the buffer, and
// the CHD usually can't be opened
test('a CHD of a few hunks can be read', () => {
  write('one frame.bin', Buffer.alloc(2352));
  write('one hunk.bin', noise(11, 8 * 2352));
  const cue = bin => write(`${bin}.cue`, `FILE "${bin}.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`);
  const tiny = [
    ['createcd', ['-i', cue('one frame')], true],
    ['createcd', ['-i', cue('one hunk')], true],
    ['createraw', ['-i', write('one.raw', noise(4, 19584)), '-hs', '19584', '-us', '2448'], false],
  ];
  for (const [command, args, broken] of tiny) {
    const what = `${command} ${path.basename(args[1])}`, up = tmp('up.chd'), en = tmp('en.chd');
    expect(run(UPSTREAM, [command, ...args, '-o', up, '-f']).code, `upstream ${what}`).toBe(0);
    if (broken) expect(run(UPSTREAM, ['verify', '-i', up]).err, `upstream ${what}`).toContain('Decompression error'); // the bug
    expect(run(ENGINE, [command, ...args, '-o', en, '-f']).code, what).toBe(0);
    expect(run(ENGINE, ['verify', '-i', en]).code, what).toBe(0);
    expect(run(UPSTREAM, ['verify', '-i', en]).code, `0.289 reads the engine's ${what}`).toBe(0);
  }
});

test('the last track of a file that another file follows ends with its file', () => {
  const data = noise(5, 300 * 2352), audio = noise(6, 300 * 2352), more = noise(7, 300 * 2352);
  write('a.bin', Buffer.concat([data, audio]));
  write('b.bin', more);
  write('t1.bin', data);
  write('t2.bin', audio);
  const mix = write('mix.cue', 'FILE "a.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:04:00\n' +
    'FILE "b.bin" BINARY\n  TRACK 03 AUDIO\n    INDEX 01 00:00:00\n');
  const twin = write('twin.cue', 'FILE "t1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "t2.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n' +
    'FILE "b.bin" BINARY\n  TRACK 03 AUDIO\n    INDEX 01 00:00:00\n');
  const en = tmp('mix.chd'), up = tmp('mix-up.chd'), plain = tmp('twin.chd');
  expect(run(UPSTREAM, ['createcd', '-i', twin, '-o', plain, '-f']).code).toBe(0);
  expect(run(UPSTREAM, ['createcd', '-i', mix, '-o', up, '-f']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', mix, '-o', en, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(plain));
  expect(sha1of(up)).not.toBe(sha1of(plain)); // the bug: track 2 got all of a.bin, 600 frames
});

test('data in a MOTOROLA file is not byte-swapped', () => {
  write('d.bin', noise(8, 100 * 2352));
  const moto = write('moto data.cue', 'FILE "d.bin" MOTOROLA\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
  const bin = write('bin data.cue', 'FILE "d.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
  const en = tmp('moto.chd'), up = tmp('moto-up.chd'), plain = tmp('bin.chd');
  expect(run(UPSTREAM, ['createcd', '-i', bin, '-o', plain, '-f']).code).toBe(0);
  expect(run(UPSTREAM, ['createcd', '-i', moto, '-o', up, '-f']).code).toBe(0);
  expect(run(ENGINE, ['createcd', '-i', moto, '-o', en, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(plain));
  expect(sha1of(up)).not.toBe(sha1of(plain)); // the bug
});

test('an output is never written over a track file', () => {
  const cases = [
    ['t.cue', 'FILE "a2.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'],
    ['t.gdi', '1\n1 0 4 2352 a2.bin 0\n'],
    ['t.toc', 'CD_ROM\nTRACK MODE1_RAW\nDATAFILE "a2.bin" 00:04:00\n'],
  ];
  for (const [name, text] of cases) {
    const input = write(name, text), track = write('a2.bin', noise(9, 300 * 2352)), before = fs.readFileSync(track);
    const r = run(ENGINE, ['createcd', '-i', input, '-o', track, '-f']);
    expect({ code: r.code, signal: r.signal }, name).toEqual({ code: 1, signal: null });
    expect(r.err, name).toContain('is also an input file');
    expect(fs.readFileSync(track).equals(before), name).toBe(true);
    // upstream truncates it, then deletes it
    run(UPSTREAM, ['createcd', '-i', input, '-o', track, '-f']);
    expect(fs.existsSync(track) && fs.readFileSync(track).equals(before), `upstream ${name}`).toBe(false);
  }
});

test('a GDI track file that is missing, or a track size of 0, is an error', () => {
  write('t1.bin', noise(10, 300 * 2352));
  const missing = write('missing.gdi', '2\n1 0 4 2352 t1.bin 0\n2 600 4 2352 gone.bin 0\n');
  expect(run(UPSTREAM, ['createcd', '-i', missing, '-o', tmp('u.chd'), '-f']).code).toBe(0); // the bug: an empty track 2
  let r = run(ENGINE, ['createcd', '-i', missing, '-o', tmp('e.chd'), '-f']);
  expect({ code: r.code, signal: r.signal }).toEqual({ code: 1, signal: null });
  expect(r.err).toContain('couldn\'t find bin file');
  const size0 = write('size0.gdi', '1\n1 0 0 0 t1.bin 0\n');
  expect(run(UPSTREAM, ['createcd', '-i', size0, '-o', tmp('u.chd'), '-f']).signal).toBeTruthy(); // SIGFPE
  r = run(ENGINE, ['createcd', '-i', size0, '-o', tmp('e.chd'), '-f']);
  expect({ code: r.code, signal: r.signal }).toEqual({ code: 1, signal: null });
  expect(r.err).toContain('Unknown track type 0 and track size 0');
});

test('extractcd of a damaged CHD is an error, and leaves no files', () => {
  const good = makeChd('createcd', 'twine.cue');
  const bad = tmp('bad.chd'), b = fs.readFileSync(good);
  b[b.length >> 1] ^= 0xff; // in the middle of the hunks
  fs.writeFileSync(bad, b);
  const up = tmp('up'), en = tmp('en');
  for (const d of [up, en]) fs.mkdirSync(d, { recursive: true });
  expect(run(UPSTREAM, ['extractcd', '-i', bad, '-o', path.join(up, 'x.cue')]).code).toBe(0); // the bug
  const r = run(ENGINE, ['extractcd', '-i', bad, '-o', path.join(en, 'x.cue')]);
  expect({ code: r.code, signal: r.signal }).toEqual({ code: 1, signal: null });
  expect(r.err).toContain('Error reading CHD file');
  expect(r.err).toContain('Decompression error');
  expect(fs.readdirSync(en)).toEqual([]);
  // as extractraw fails on the same CHD
  expect(run(ENGINE, ['extractraw', '-i', bad, '-o', path.join(en, 'x.raw')]).code).toBe(1);
});

// A Dreamcast disc of each GD-ROM layout (the high-density area: one data track; data, then audio; two data
// tracks; data, audio, data), as Redump lays it out (a cue sheet, each track's pregap at the start of its own
// file) and as TOSEC does (a GDI: track 2's pregap in no file, the others at the end of the previous file, but
// for a last data track after audio, whose 3 s are 75 frames there and 150 in no file). The pregaps are zeros,
// so both hold the same disc.
function gdDisc(name, hd) {
  const F = 2352, zeros = n => Buffer.alloc(n * F);
  const tracks = [{ data: true, frames: 300, pregap: 0 }, { data: false, frames: 200, pregap: 150 },
    ...hd.map((data, i) => ({ data, frames: 100 + 37 * i, pregap: i === 0 ? 0 : (data && i === hd.length - 1) ? 225 : 150 }))];
  tracks.forEach((t, i) => { t.body = noise(90 + i, t.frames * F); });
  let cue = '';
  tracks.forEach((t, i) => {
    const file = `${name} (Track ${i + 1}).bin`;
    write(file, Buffer.concat([zeros(t.pregap), t.body]));
    if (i === 0) cue += 'REM SINGLE-DENSITY AREA\r\n';
    if (i === 2) cue += 'REM HIGH-DENSITY AREA\r\n';
    cue += `FILE "${file}" BINARY\r\n  TRACK ${String(i + 1).padStart(2, '0')} ${t.data ? 'MODE1/2352' : 'AUDIO'}\r\n` +
      (t.pregap ? `    INDEX 00 00:00:00\r\n    INDEX 01 00:0${t.pregap / 75}:00\r\n` : '    INDEX 01 00:00:00\r\n');
  });
  let gdi = `${tracks.length}\n`, lba = 0;
  tracks.forEach((t, i) => {
    const next = tracks[i + 1], file = `${name}${String(i + 1).padStart(2, '0')}.${t.data ? 'bin' : 'raw'}`;
    // what of the next track's pregap is at the end of this file (the rest is in no file)
    const split = i >= 2 && next ? (next.data && !t.data && i + 2 === tracks.length ? 75 : next.pregap) : 0;
    if (i === 1) lba = 450;
    if (i === 2) lba = 45000;
    gdi += `${i + 1} ${lba} ${t.data ? 4 : 0} 2352 ${file} 0\n`;
    write(file, Buffer.concat([t.body, zeros(split)]));
    lba += t.frames + (next ? next.pregap : 0);
  });
  return { dir: path.dirname(write(`${name}.gdi`, gdi)), cue: write(`${name}.cue`, cue), gdi: tmp(`${name}.gdi`) };
}

// 0.289 and the engine before read a GD-ROM cue sheet's PREGAP (which extractcd writes for the gap a GDI leaves
// out) from the start of the track's file, and wrote .toc files for GD-ROMs whose lengths the files don't hold:
// only the .gdi, and the .cue of a CHD made from a Redump cue sheet, read back. Now every GD-ROM output reads back
// as the same CHD; --redump writes Redump's layout, whatever the CHD was made from; and a TOC, which can't describe
// a GD-ROM, is refused.
test('every GD-ROM extract reads back as the same disc, and a TOC is refused', () => {
  const info = chd => run(ENGINE, ['info', '-v', '-i', chd]).out.toString();
  const data = chd => /^Data SHA1:\s+(\w+)/m.exec(info(chd))[1];
  const extract = (bin, chd, dir, out, args = []) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return run(bin, ['extractcd', '-i', chd, '-o', path.join(dir, out), ...args]);
  };
  for (const [name, hd] of [['gd1', [true]], ['gd2', [true, false, false]], ['gd3', [true, true]], ['gd3s', [true, false, true]]]) {
    const disc = gdDisc(name, hd);
    const made = {};
    for (const src of ['gdi', 'cue']) {
      const en = tmp(`${name}-${src}.chd`), up = tmp(`${name}-${src}-up.chd`);
      expect(run(ENGINE, ['createcd', '-i', disc[src], '-o', en, '-f']).code, `${name} ${src}`).toBe(0);
      expect(run(UPSTREAM, ['createcd', '-i', disc[src], '-o', up, '-f']).code, `upstream ${name} ${src}`).toBe(0);
      expect(sha1of(en), `${name} ${src}: 0.289's CHD`).toBe(sha1of(up));
      // 0.289's layout: no gaps, the high-density area at LBA 45000
      const frames = [...info(en).matchAll(/TRACK:\d+ TYPE:\S+ SUBTYPE:NONE FRAMES:(\d+) PAD:\d+ PREGAP:0 PGTYPE:\S+ PGSUB:NONE POSTGAP:0/g)].map(m => +m[1]);
      expect(frames.length, `${name} ${src}`).toBe(hd.length + 2);
      expect(frames[0] + frames[1], `${name} ${src}`).toBe(45000);
      made[src] = en;
    }
    // the same data (the GDI's gaps are padding in its CHD, and data of the track before in the cue sheet's)
    expect(data(made.gdi), name).toBe(data(made.cue));
    const redumpFiles = fs.readdirSync(disc.dir).filter(n => n.startsWith(`${name} (Track `) || n === `${name}.cue`).sort();
    for (const src of ['gdi', 'cue']) {
      const chd = made[src];
      for (const [fmt, out, args] of [['gdi', 'x.gdi', []], ['cue', 'x.cue', []], ['redump', `${name}.cue`, ['--redump']]]) {
        const dir = tmp(`${name}-${src}-${fmt}`), back = tmp(`${name}-${src}-${fmt}.chd`), what = `${name} ${src} -> ${fmt}`;
        expect(extract(ENGINE, chd, dir, out, args).code, what).toBe(0);
        expect(run(ENGINE, ['createcd', '-i', path.join(dir, out), '-o', back, '-f']).code, what).toBe(0);
        // the same CHD; Redump's layout makes the one its cue sheet makes
        expect(sha1of(back), what).toBe(sha1of(fmt === 'redump' ? made.cue : chd));
        if (fmt === 'redump') {
          // Redump's files, byte for byte
          const names = fs.readdirSync(dir).sort();
          expect(names, what).toEqual(redumpFiles);
          for (const n of names) expect(sha1of(path.join(dir, n)), `${what}: ${n}`).toBe(sha1of(path.join(disc.dir, n)));
        }
        if (fmt === 'gdi' || (fmt === 'cue' && src === 'cue')) {
          // 0.289 writes the same files
          const up = tmp(`${name}-${src}-${fmt}-up`);
          expect(extract(UPSTREAM, chd, up, out).code, what).toBe(0);
          expect(fs.readdirSync(up).sort(), what).toEqual(fs.readdirSync(dir).sort());
          for (const n of fs.readdirSync(dir)) expect(sha1of(path.join(up, n)), `${what}: ${n}`).toBe(sha1of(path.join(dir, n)));
        }
      }
      if (src === 'gdi') {
        // the bug: 0.289's .cue of a CHD made from a GDI reads back as an error, or as another disc
        const dir = tmp(`${name}-up-cue`), back = tmp(`${name}-up-cue.chd`);
        expect(extract(UPSTREAM, chd, dir, 'x.cue').code).toBe(0);
        const r = run(UPSTREAM, ['createcd', '-i', path.join(dir, 'x.cue'), '-o', back, '-f']);
        expect(r.code === 0 ? sha1of(back) : 'failed', `upstream ${name}`).not.toBe(sha1of(chd));
        // the engine reads it as the same disc: its PREGAP is the GDI's gap (0.289's .cue of gd3s leaves out 75
        // frames at the end of track 4, zeros here, which then read back as padding)
        expect(run(ENGINE, ['createcd', '-i', path.join(dir, 'x.cue'), '-o', back, '-f']).code, name).toBe(0);
        if (name === 'gd3s') expect(data(back), name).toBe(data(chd));
        else expect(sha1of(back), name).toBe(sha1of(chd));
      }
      // a TOC: refused, with or without -sb
      for (const sb of [[], ['-sb']]) {
        const dir = tmp(`${name}-toc`);
        const r = extract(ENGINE, chd, dir, 'x.toc', sb);
        expect({ code: r.code, signal: r.signal }, `${name} ${src} toc ${sb}`).toEqual({ code: 1, signal: null });
        expect(r.err).toContain('A GD-ROM can\'t be written as a TOC');
        expect(fs.readdirSync(dir)).toEqual([]);
      }
    }
  }
  // 0.289's TOC of a GD-ROM, whose lengths its files don't hold: a clear error, where 0.289 fails reading
  const dir = tmp('gd-up-toc');
  expect(extract(UPSTREAM, tmp('gd1-gdi.chd'), dir, 'x.toc').code).toBe(0);
  expect(run(UPSTREAM, ['createcd', '-i', path.join(dir, 'x.toc'), '-o', tmp('e.chd'), '-f']).code).toBe(1);
  const r = run(ENGINE, ['createcd', '-i', path.join(dir, 'x.toc'), '-o', tmp('e.chd'), '-f']);
  expect({ code: r.code, signal: r.signal }).toEqual({ code: 1, signal: null });
  expect(r.err).toMatch(/track 2 asks for \d+ bytes of \[.*x\.bin\] from byte \d+, but only \d+ are there/);
});

// Cue sheets with INDEX points out of order, or a track with no frames from its INDEX 01 on: 0.289 made tracks of a
// negative length (exit 0, or a read error) or of none (exit 0), whose TOC does not read back (START at the end)
// CD+G tracks (TRACK nn CDG): 0.289 refuses the cue sheet, and so does the engine (the page refuses
// it before running, edge-cases.spec.js; CD+G CHDs are post-0.289)
test('a CD+G track is an error, and no CHD is written', () => {
  const dir = tmp('cdg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'karaoke.bin'), Buffer.alloc(2448 * 300));
  fs.writeFileSync(path.join(dir, 'karaoke.cue'), 'FILE "karaoke.bin" BINARY\n  TRACK 01 CDG\n    INDEX 01 00:00:00\n');
  for (const bin of [UPSTREAM, ENGINE]) {
    const out = path.join(dir, path.basename(bin) + '.chd');
    const r = run(bin, ['createcd', '-i', path.join(dir, 'karaoke.cue'), '-o', out, '-f']);
    expect(r.code, path.basename(bin)).toBe(1);
    expect(r.err).toContain('Unsupported format');
    expect(fs.existsSync(out)).toBe(false);
  }
});

test('INDEX points out of order, or a track without data, are an error', () => {
  const F = 2352;
  write('ix.bin', noise(100, 400 * F));
  write('ix.wav', wavOf(noise(101, 400 * F)));
  write('ix0.bin', noise(102, 137 * F + 1520));
  write('ix1.bin', noise(103, 2400));
  const one = 'FILE "ix.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';
  for (const [name, cue, upstream, message] of [
    // the next track starts before this one (in a .bin and in a .wav)
    ['back.cue', 'FILE "ix.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:03\n  TRACK 02 AUDIO\n    INDEX 01 00:00:01\n', 1, 'track 2 starts where track 1 does, or before'],
    ['backwav.cue', 'FILE "ix.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:03\n  TRACK 02 AUDIO\n    INDEX 01 00:00:01\n', 0, 'track 2 starts where track 1 does, or before'],
    // INDEX 00 after INDEX 01, or past it
    ['late0.cue', one + '  TRACK 02 AUDIO\n    INDEX 01 00:02:00\n    INDEX 00 00:01:00\n', 0, 'track 2\'s INDEX 00 is out of order'],
    ['past0.cue', one.replace('00:00:00\n', '00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:03:00\n    INDEX 01 00:02:00\n'), 0, 'track 2\'s INDEX 01 is out of order'],
    // a track that is only its pregap: INDEX 01 where the next track starts, or at the end of its file
    ['pgonly.cue', one.replace('00:00:00\n', '00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:01:00\n    INDEX 01 00:02:00\n  TRACK 03 AUDIO\n    INDEX 00 00:02:00\n    INDEX 01 00:03:00\n'), 0, 'track 2 has no data from its INDEX 01 on'],
    ['eacpg.cue', 'FILE "ix0.bin" MOTOROLA\n  TRACK 01 MODE2/2352\n    INDEX 00 00:01:00\nFILE "ix1.bin" MOTOROLA\n    INDEX 01 00:00:01\n', null, 'track 1 has no data from its INDEX 01 on'],
  ]) {
    const input = write(name, cue);
    if (upstream !== null) expect(run(UPSTREAM, ['createcd', '-i', input, '-o', tmp('u.chd'), '-f']).code, `upstream ${name}`).toBe(upstream);
    const r = run(ENGINE, ['createcd', '-i', input, '-o', tmp('e.chd'), '-f']);
    expect({ code: r.code, signal: r.signal }, name).toEqual({ code: 1, signal: null });
    expect(r.err, name).toContain(message);
  }
  // INDEX points in order, a pregap in its file and one that isn't: as 0.289
  const ok = write('ok.cue', one + '  TRACK 02 AUDIO\n    INDEX 00 00:01:00\n    INDEX 01 00:02:00\n    INDEX 02 00:03:00\n  TRACK 03 AUDIO\n    PREGAP 00:01:00\n    INDEX 01 00:04:00\n');
  const en = tmp('ok-en.chd'), up = tmp('ok-up.chd');
  expect(run(ENGINE, ['createcd', '-i', ok, '-o', en, '-f']).code).toBe(0);
  expect(run(UPSTREAM, ['createcd', '-i', ok, '-o', up, '-f']).code).toBe(0);
  expect(sha1of(en)).toBe(sha1of(up));
});
