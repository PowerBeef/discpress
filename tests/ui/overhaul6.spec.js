// Phase 6 overhaul tests:
// 1. Lossless (FLAC, extended WAV 0xFFFE 24-bit, AIFF) & lossy/GOG (.ins + MP3) audio CUE tracks
// 2. Streaming .7z archive unpacking (LZMA SDK 23.01)
// 3. Alcohol 120% .mds/.mdf v1.x (CD + interleaved +96B PS1 LibCrypt Q -> .sbi, DVD, v2 refusal)
// 4. DiscJuggler .cdi v3.5 (1-session CHD, 2-session Dreamcast MIL-CD extract & Flycast 2.8+ Tier X)
// 5. CD+G (TRACK nn CDG + guarded CloneCD .ccd/.sub RW_RAW planar->interleaved transpose)
// 6. CSO v1 / CSO v2 / ZSO (--block=2048) writer round-trip from ISO & DVD CHD
// 7. Scrubbed Original Xbox XISO (.xiso.iso) repacker for xemu
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { info, nativeChdman, sha1File } from '../support/native.js';

function genDir(sub) {
  const dir = path.join(FIXTURES, 'gen', 'p6', sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha1Buf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---- Audio builders (FLAC verbatim, WAVE_FORMAT_EXTENSIBLE 24-bit, AIFF, minimal MP3) ---- */
function makePcm(sectors) {
  const buf = Buffer.alloc(sectors * 2352);
  for (let i = 0; i < sectors * 588; i++) {
    const l = Math.round(Math.sin(i * 0.06) * 16000);
    const r = Math.round(Math.cos(i * 0.04) * 12000);
    buf.writeInt16LE(l, i * 4);
    buf.writeInt16LE(r, i * 4 + 2);
  }
  return buf;
}

function flacCrc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xFF) : ((c << 1) & 0xFF);
  }
  return c;
}
function flacCrc16(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= (b << 8);
    for (let i = 0; i < 8; i++) c = (c & 0x8000) ? (((c << 1) ^ 0x8005) & 0xFFFF) : ((c << 1) & 0xFFFF);
  }
  return c;
}
function makeFlacFromPcm(pcm) {
  const totalSamples = pcm.length / 4;
  const blk = 588; // 1 CD sector per FLAC frame (exact multiple!)
  const md5 = crypto.createHash('md5').update(pcm).digest();
  // STREAMINFO block (34 bytes)
  const si = Buffer.alloc(34);
  si.writeUInt16BE(blk, 0); si.writeUInt16BE(blk, 2);
  // min/max frame size = 0 (unknown)
  // 20-bit rate (44100), 3-bit ch-1 (1), 5-bit bps-1 (15), 36-bit totalSamples
  const r = 44100;
  si[10] = (r >> 12) & 0xFF;
  si[11] = (r >> 4) & 0xFF;
  si[12] = ((r & 0x0F) << 4) | ((1 & 0x07) << 1) | ((15 >> 4) & 1);
  si[13] = ((15 & 0x0F) << 4) | Math.floor(totalSamples / 4294967296);
  si.writeUInt32BE(totalSamples >>> 0, 14);
  md5.copy(si, 18);
  const parts = [Buffer.from('fLaC'), Buffer.from([0x80, 0x00, 0x00, 34]), si];
  const nFrames = Math.ceil(totalSamples / blk);
  for (let f = 0; f < nFrames; f++) {
    const cnt = Math.min(blk, totalSamples - f * blk);
    const hdr = [
      0xFF, 0xF8, // sync + fixed blocksize
      0x79,       // blocksize = 16-bit at end (0x7), rate = 44.1kHz (0x9)
      0x18,       // independent stereo (0x1), 16-bit (0x4 -> 0x8)
    ];
    // UTF-8 coded frame number
    if (f < 0x80) hdr.push(f);
    else if (f < 0x800) { hdr.push(0xC0 | (f >> 6), 0x80 | (f & 0x3F)); }
    else { hdr.push(0xE0 | (f >> 12), 0x80 | ((f >> 6) & 0x3F), 0x80 | (f & 0x3F)); }
    hdr.push(((cnt - 1) >> 8) & 0xFF, (cnt - 1) & 0xFF);
    hdr.push(flacCrc8(hdr));
    const frameBuf = Buffer.alloc(hdr.length + 2 + cnt * 4 + 2);
    Buffer.from(hdr).copy(frameBuf, 0);
    let o = hdr.length;
    // Subframe 0 (L): verbatim header byte = 0x02 (0 | 000001 << 1 | 0)
    frameBuf[o++] = 0x02;
    for (let i = 0; i < cnt; i++) {
      const s = pcm.readInt16LE((f * blk + i) * 4);
      frameBuf.writeInt16BE(s, o); o += 2;
    }
    // Subframe 1 (R): verbatim header byte = 0x02
    frameBuf[o++] = 0x02;
    for (let i = 0; i < cnt; i++) {
      const s = pcm.readInt16LE((f * blk + i) * 4 + 2);
      frameBuf.writeInt16BE(s, o); o += 2;
    }
    frameBuf.writeUInt16BE(flacCrc16(frameBuf.subarray(0, o)), o);
    parts.push(frameBuf);
  }
  return Buffer.concat(parts);
}

function makeExtensibleWav24(pcm) {
  const frames = pcm.length / 4;
  const data = Buffer.alloc(frames * 6); // 24-bit stereo LE (low byte 0 -> lossless shift back to 16-bit!)
  for (let i = 0; i < frames * 2; i++) {
    const s = pcm.readInt16LE(i * 2);
    data[i * 3] = 0;
    data[i * 3 + 1] = s & 0xFF;
    data[i * 3 + 2] = (s >> 8) & 0xFF;
  }
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xFFFE, 0); // WAVE_FORMAT_EXTENSIBLE
  fmt.writeUInt16LE(2, 2);      // channels
  fmt.writeUInt32LE(44100, 4);  // rate
  fmt.writeUInt32LE(44100 * 6, 8);
  fmt.writeUInt16LE(6, 12);     // blockAlign
  fmt.writeUInt16LE(24, 14);    // bits
  fmt.writeUInt16LE(22, 16);    // cbSize
  fmt.writeUInt16LE(24, 18);    // validBits
  fmt.writeUInt32LE(3, 20);     // channelMask (FL|FR)
  Buffer.from([0x01,0x00,0x00,0x00,0x00,0x00,0x10,0x00,0x80,0x00,0x00,0xAA,0x00,0x38,0x9B,0x71]).copy(fmt, 24);
  const hdr = Buffer.alloc(12);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4); hdr.write('WAVE', 8);
  const ch1 = Buffer.alloc(8); ch1.write('fmt ', 0); ch1.writeUInt32LE(fmt.length, 4);
  const ch2 = Buffer.alloc(8); ch2.write('data', 0); ch2.writeUInt32LE(data.length, 4);
  return Buffer.concat([hdr, ch1, fmt, ch2, data]);
}

function makeAiffFromPcm(pcm) {
  const frames = pcm.length / 4;
  const ssnd = Buffer.alloc(8 + pcm.length);
  for (let i = 0; i < pcm.length; i += 2) ssnd.writeInt16BE(pcm.readInt16LE(i), 8 + i);
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(2, 0);
  comm.writeUInt32BE(frames, 2);
  comm.writeUInt16BE(16, 6);
  // 80-bit IEEE 754 extended for 44100.0: 0x400E AC44 0000 0000 0000
  Buffer.from([0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]).copy(comm, 8);
  const form = Buffer.alloc(12);
  form.write('FORM', 0); form.writeUInt32BE(4 + 8 + comm.length + 8 + ssnd.length, 4); form.write('AIFF', 8);
  const c1 = Buffer.alloc(8); c1.write('COMM', 0); c1.writeUInt32BE(comm.length, 4);
  const c2 = Buffer.alloc(8); c2.write('SSND', 0); c2.writeUInt32BE(ssnd.length, 4);
  return Buffer.concat([form, c1, comm, c2, ssnd]);
}

function makeMinimalMp3(frameCount = 4) {
  // MPEG-1 Layer III, 128 kbps, 44100 Hz, stereo, no padding: 417 bytes/frame, 1152 samples/frame
  const frame = Buffer.alloc(417, 0);
  frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = 0x90; frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

/* ---- Minimal valid .7z builder (Copy method, Public Domain 7z format spec) ---- */
function enc7zU64(v) {
  let n = BigInt(v);
  if (n < 0x80n) return Buffer.from([Number(n)]);
  let mask = 0x80, extra = [];
  for (let i = 1; i <= 8; i++) {
    const limit = 1n << BigInt(7 * i + (8 - i));
    if (n < limit || i === 8) {
      const top = i === 8 ? 0 : Number(n >> BigInt(8 * i));
      const first = (0xFF << (8 - i)) & 0xFF | top;
      for (let b = 0; b < i; b++) extra.push(Number((n >> BigInt(8 * b)) & 0xFFn));
      return Buffer.from([first, ...extra]);
    }
    mask >>= 1;
  }
}
function make7z(entries) {
  // Single solid folder using Copy (method 0x00)
  const payload = Buffer.concat(entries.map(e => e.data));
  const h = [];
  const push = (...b) => h.push(Buffer.from(b));
  push(0x01); // kHeader
  push(0x04); // kMainStreamsInfo
  push(0x06); // kPackInfo
  h.push(enc7zU64(0)); // packPos = 0
  h.push(enc7zU64(1)); // numPackStreams = 1
  push(0x09); h.push(enc7zU64(payload.length)); // kSize
  push(0x00); // kEnd PackInfo
  push(0x07); // kUnpackInfo
  push(0x0B); // kFolder
  h.push(enc7zU64(1)); // numFolders = 1
  push(0x00); // external = 0
  push(0x01); // numCoders = 1
  push(0x01, 0x00); // idSize=1, Copy=0x00
  push(0x0C); h.push(enc7zU64(payload.length)); // kCodersUnpackSize
  push(0x00); // kEnd UnpackInfo
  push(0x08); // kSubStreamsInfo
  push(0x0D); h.push(enc7zU64(entries.length)); // kNumUnpackStream
  if (entries.length > 1) {
    push(0x09); // kSize (n - 1 sizes)
    for (let i = 0; i < entries.length - 1; i++) h.push(enc7zU64(entries[i].data.length));
  }
  push(0x0A, 0x01); // kCRC, AllAreDefined=1
  for (const e of entries) {
    const cb = Buffer.alloc(4);
    cb.writeUInt32LE(crc32(e.data), 0);
    h.push(cb);
  }
  push(0x00); // kEnd SubStreamsInfo
  push(0x00); // kEnd MainStreamsInfo
  push(0x05); // kFilesInfo
  h.push(enc7zU64(entries.length));
  // kName (0x11)
  const nameChunks = [Buffer.from([0x00])]; // external=0
  for (const e of entries) {
    nameChunks.push(Buffer.from(e.name + '\0', 'utf16le'));
  }
  const namesBuf = Buffer.concat(nameChunks);
  push(0x11); h.push(enc7zU64(namesBuf.length)); h.push(namesBuf);
  push(0x00); // kEnd FilesInfo
  push(0x00); // kEnd Header
  const headerBuf = Buffer.concat(h);
  const startHdr = Buffer.alloc(32);
  Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0x00, 0x04]).copy(startHdr, 0);
  const nextHdr = Buffer.alloc(20);
  nextHdr.writeBigUInt64LE(BigInt(payload.length), 0);
  nextHdr.writeBigUInt64LE(BigInt(headerBuf.length), 8);
  nextHdr.writeUInt32LE(crc32(headerBuf), 16);
  startHdr.writeUInt32LE(crc32(nextHdr), 8);
  nextHdr.copy(startHdr, 12);
  return Buffer.concat([startHdr, payload, headerBuf]);
}

/* ---- Minimal DiscJuggler .cdi v3.5 builder ---- */
function makeCdiV35(sessions) {
  const MARK = Buffer.from([0, 0, 1, 0, 0, 0, 255, 255, 255, 255]);
  const payloads = [];
  const hdr = [];
  const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
  hdr.push(u16(sessions.length));
  for (const sess of sessions) {
    hdr.push(u16(sess.length));
    for (const tr of sess) {
      payloads.push(tr.data);
      hdr.push(MARK, MARK, Buffer.alloc(4));
      const fn = Buffer.from(tr.name || 't.bin', 'ascii');
      hdr.push(Buffer.from([fn.length]), fn);
      hdr.push(Buffer.alloc(19));
      hdr.push(Buffer.alloc(2));
      hdr.push(u32(tr.pregap || 0));
      hdr.push(u32(tr.length));
      hdr.push(Buffer.alloc(6));
      hdr.push(u32(tr.modeCode)); // 0=AUDIO, 1=MODE1, 2=MODE2
      hdr.push(Buffer.alloc(12));
      hdr.push(u32(tr.startLba || 0));
      hdr.push(u32((tr.pregap || 0) + tr.length));
      hdr.push(Buffer.alloc(16));
      hdr.push(u32(tr.secCode)); // 0=2048, 1=2336, 2=2352
      hdr.push(Buffer.alloc(29));
      hdr.push(Buffer.alloc(5)); // v3.5 non-0xFFFFFFFF extra block
    }
    hdr.push(Buffer.alloc(13)); // v3.5 session trailer
  }
  const dataBuf = Buffer.concat(payloads);
  const hdrBuf = Buffer.concat(hdr);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(0x80000006, 0); // v3.5
  tail.writeUInt32LE(hdrBuf.length + 8, 4); // offset backwards from EOF
  return Buffer.concat([dataBuf, hdrBuf, tail]);
}

/* ---- Minimal Alcohol 120% .mds v1.5 builder ---- */
function makeMdsV1({ isDvd, tracks }) {
  const sessOff = 0x58;
  const tracksOff = sessOff + 24;
  const extraBase = tracksOff + tracks.length * 80;
  const totalLen = extraBase + tracks.length * 8;
  const b = Buffer.alloc(totalLen);
  b.write('MEDIA DESCRIPTOR', 0, 'ascii');
  b[0x10] = 1; b[0x11] = 5;
  b.writeUInt16LE(isDvd ? 0x10 : 0x00, 0x12);
  b.writeUInt16LE(1, 0x14);
  b.writeUInt32LE(sessOff, 0x50);
  // Session 1
  b.writeUInt16LE(1, sessOff + 8);
  b[sessOff + 10] = tracks.length;
  b.writeUInt16LE(1, sessOff + 12);
  b.writeUInt16LE(tracks.length, sessOff + 14);
  b.writeUInt32LE(tracksOff, sessOff + 20);
  tracks.forEach((tr, i) => {
    const to = tracksOff + i * 80;
    const eo = extraBase + i * 8;
    b[to] = tr.modeByte;
    b[to + 1] = tr.hasSub ? 8 : 0;
    b[to + 2] = tr.adrCtl;
    b[to + 4] = i + 1;
    b.writeUInt32LE(isDvd ? tr.length : eo, to + 12);
    b.writeUInt16LE(tr.stride, to + 16);
    b.writeUInt32LE(tr.startLba || 0, to + 36);
    b.writeBigUInt64LE(BigInt(tr.offset), to + 40);
    if (!isDvd) {
      b.writeUInt32LE(tr.pregap || 0, eo);
      b.writeUInt32LE(tr.length, eo + 4);
    }
  });
  return b;
}

/* ---- Minimal Original Xbox XDVDFS ISO builder (padded with junk for scrubbing test) ---- */
function makeXboxIso() {
  const partBase = 0; // un-scrubbed XISO with massive trailing/internal padding
  const files = [
    { name: 'DATA.BIN', data: crypto.createHash('sha256').update('xbox-data').digest().subarray(0, 32).toString('hex').repeat(200) },
    { name: 'DEFAULT.XBE', data: null }
  ];
  // Build minimal XBEH header with UTF-16LE title "SYNTHETIC XBOX"
  const xbe = Buffer.alloc(4096, 0);
  xbe.write('XBEH', 0, 'ascii');
  xbe.writeUInt32LE(0x10000, 0x104); // base address
  xbe.writeUInt32LE(0x10200, 0x118); // cert address (offset 0x200)
  xbe.writeUInt32LE(0x4D530001, 0x200 + 0x08); // MS-001
  Buffer.from('SYNTHETIC XBOX\0', 'utf16le').copy(xbe, 0x200 + 0x0C);
  const f0 = Buffer.from(files[0].data, 'ascii');
  const f1 = xbe;

  // Place root dir at sector 40, file 0 at sector 100, file 1 at sector 200, total ISO = 300 sectors (600 KB)
  const totalSectors = 300;
  const iso = Buffer.alloc(totalSectors * 2048, 0xAA); // random-like junk padding
  iso.fill(0, 0, 32 * 2048);
  const vd = Buffer.alloc(2048, 0);
  vd.write('MICROSOFT*XBOX*MEDIA', 0, 'ascii');
  vd.writeUInt32LE(40, 0x14);    // rootSector = 40
  vd.writeUInt32LE(2048, 0x18);  // rootSize = 2048
  vd.writeBigUInt64LE(133000000000000000n, 0x1C); // FILETIME
  vd.write('MICROSOFT*XBOX*MEDIA', 0x7EC, 'ascii');
  vd.copy(iso, partBase + 32 * 2048);

  // Root AVL tree: node 0 = "DATA.BIN" (at off 0), right child = "DEFAULT.XBE" (at off 24 -> DWORD 6)
  const dir = Buffer.alloc(2048, 0xFF);
  // Node 0: DATA.BIN (len 8 -> 14+8=22 -> padded to 24)
  dir.writeUInt16LE(0, 0);       // left = 0
  dir.writeUInt16LE(6, 2);       // right = 24 / 4 = 6
  dir.writeUInt32LE(100, 4);     // sector = 100
  dir.writeUInt32LE(f0.length, 8);
  dir[12] = 0x20;                // archive file
  dir[13] = 8;
  dir.write('DATA.BIN', 14, 'ascii');
  // Node 1 at offset 24: DEFAULT.XBE
  dir.writeUInt16LE(0, 24);
  dir.writeUInt16LE(0, 26);
  dir.writeUInt32LE(200, 28);    // sector = 200
  dir.writeUInt32LE(f1.length, 32);
  dir[36] = 0x20;
  dir[37] = 11;
  dir.write('DEFAULT.XBE', 38, 'ascii');
  dir.copy(iso, partBase + 40 * 2048);
  f0.copy(iso, partBase + 100 * 2048);
  f1.copy(iso, partBase + 200 * 2048);
  return { iso, f0, f1, filetime: 133000000000000000n };
}

test('lossless FLAC, extended 24-bit WAV, and AIFF cues match raw Red Book PCM byte for byte', async ({ app }) => {
  const dir = genDir('audio-lossless');
  const dataTrack = fs.readFileSync(path.join(FIXTURES, 'lone.bin'));
  const pcm = makePcm(12);
  fs.writeFileSync(path.join(dir, 't1.bin'), dataTrack);
  fs.writeFileSync(path.join(dir, 't2.bin'), pcm);
  fs.writeFileSync(path.join(dir, 't2.flac'), makeFlacFromPcm(pcm));
  fs.writeFileSync(path.join(dir, 't2ext.wav'), makeExtensibleWav24(pcm));
  fs.writeFileSync(path.join(dir, 't2.aiff'), makeAiffFromPcm(pcm));
  fs.writeFileSync(path.join(dir, 'ref.cue'), 'FILE "t1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "t2.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');
  fs.writeFileSync(path.join(dir, 'flac.cue'), 'FILE "t1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "t2.flac" WAVE\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');
  fs.writeFileSync(path.join(dir, 'extwav.cue'), 'FILE "t1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "t2ext.wav" WAVE\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');
  fs.writeFileSync(path.join(dir, 'aiff.cue'), 'FILE "t1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "t2.aiff" AIFF\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');

  await app.open();
  await app.add(['gen/p6/audio-lossless/ref.cue', 'gen/p6/audio-lossless/t1.bin', 'gen/p6/audio-lossless/t2.bin']);
  const cRef = app.job('ref'); await app.settled(cRef); await app.run(cRef);
  const refOut = (await app.downloads(cRef))[0];

  for (const [label, cue, aud] of [['flac', 'flac.cue', 't2.flac'], ['extwav', 'extwav.cue', 't2ext.wav'], ['aiff', 'aiff.cue', 't2.aiff']]) {
    await app.open();
    await app.add([`gen/p6/audio-lossless/${cue}`, 'gen/p6/audio-lossless/t1.bin', `gen/p6/audio-lossless/${aud}`]);
    const card = app.job(label);
    await app.settled(card);
    if (label === 'extwav') await expect(card.locator('[data-quirk="resampled-audio"]')).toBeVisible();
    await app.run(card);
    const out = (await app.downloads(card))[0];
    expect(sha1File(out.path), `${label} CHD matches raw BIN+PCM byte for byte`).toBe(sha1File(refOut.path));
  }
});

test('GOG .ins descriptor with lossy MP3 track shows lossy-audio warning and converts to CHD', async ({ app }) => {
  const dir = genDir('gog-ins');
  fs.copyFileSync(path.join(FIXTURES, 'lone.bin'), path.join(dir, 'game.gog'));
  fs.writeFileSync(path.join(dir, 'track02.mp3'), makeMinimalMp3(6));
  fs.writeFileSync(path.join(dir, 'game.ins'), 'FILE "game.gog" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "track02.mp3" MP3\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');
  await app.open();
  await app.add(['gen/p6/gog-ins/game.ins', 'gen/p6/gog-ins/game.gog', 'gen/p6/gog-ins/track02.mp3']);
  const card = app.job('game');
  await app.settled(card);
  await expect(card.locator('[data-quirk="lossy-audio"]')).toBeVisible();
  await app.run(card);
  await expect(card.locator('.result')).toContainText('Done.');
});

test('streaming .7z archive unpacks seamlessly and produces a byte-identical CHD', async ({ app }) => {
  const dir = genDir('sevenzip');
  const bin = fs.readFileSync(path.join(FIXTURES, 'lone.bin'));
  const cue = Buffer.from('FILE "lone.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n', 'ascii');
  fs.writeFileSync(path.join(dir, 'disc.7z'), make7z([{ name: 'disc.cue', data: cue }, { name: 'lone.bin', data: bin }]));
  fs.writeFileSync(path.join(dir, 'disc.cue'), cue);
  fs.writeFileSync(path.join(dir, 'lone.bin'), bin);

  await app.open();
  await app.add(['gen/p6/sevenzip/disc.7z']);
  await expect(app.jobs()).toHaveCount(1);
  const card = app.job('disc');
  await app.settled(card);
  await app.run(card);
  const out7z = (await app.downloads(card))[0];

  await app.open();
  await app.add(['gen/p6/sevenzip/disc.cue', 'gen/p6/sevenzip/lone.bin']);
  const c2 = app.job('disc'); await app.settled(c2); await app.run(c2);
  const outRaw = (await app.downloads(c2))[0];
  expect(sha1File(out7z.path)).toBe(sha1File(outRaw.path));
});

test('Alcohol 120% .mds/.mdf v1.5 converts CD (+PS1 interleaved Q .sbi) and DVD, and refuses v2', async ({ app }) => {
  const dir = genDir('mds');
  const ps1Bin = fs.readFileSync(path.join(FIXTURES, 'twine.bin'));
  const nSec = ps1Bin.length / 2352;
  // Build +96B interleaved subchannel .mdf with 2 bad-CRC Q sectors (LibCrypt)
  const mdf = Buffer.alloc(nSec * 2448, 0);
  function qCrc(q) {
    let c = 0;
    for (let i = 0; i < 10; i++) {
      c ^= q[i] << 8;
      for (let k = 0; k < 8; k++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
    return (~c) & 0xFFFF;
  }
  for (let s = 0; s < nSec; s++) {
    ps1Bin.copy(mdf, s * 2448, s * 2352, (s + 1) * 2352);
    const q = Buffer.from([0x41, 0x01, 0x01, 0x00, 0x00, s & 0x7F, 0x00, 0x00, 0x02, s & 0x7F, 0, 0]);
    const crc = qCrc(q);
    const bad = (s === 5 || s === 10) ? (crc ^ 0xFFFF) : crc;
    q[10] = (bad >> 8) & 0xFF; q[11] = bad & 0xFF;
    // Bit-interleave Q into bit 6 of the 96 subchannel bytes
    const subOff = s * 2448 + 2352;
    for (let bi = 0; bi < 12; bi++) {
      for (let bit = 0; bit < 8; bit++) {
        if ((q[bi] >> (7 - bit)) & 1) mdf[subOff + bi * 8 + bit] |= 0x40;
      }
    }
  }
  const mdsCd = makeMdsV1({ isDvd: false, tracks: [{ modeByte: 0xAB, hasSub: true, adrCtl: 0x41, stride: 2448, length: nSec, offset: 0 }] });
  fs.writeFileSync(path.join(dir, 'ps1mds.mds'), mdsCd);
  fs.writeFileSync(path.join(dir, 'ps1mds.mdf'), mdf);

  // DVD .mds/.mdf v1.5 direct pass-through
  const dvdIso = fs.readFileSync(path.join(FIXTURES, 'frwl.iso'));
  const mdsDvd = makeMdsV1({ isDvd: true, tracks: [{ modeByte: 0xAA, hasSub: false, adrCtl: 0x14, stride: 2048, length: dvdIso.length / 2048, offset: 0 }] });
  fs.writeFileSync(path.join(dir, 'dvdmds.mds'), mdsDvd);
  fs.writeFileSync(path.join(dir, 'dvdmds.mdf'), dvdIso);

  // Also v2 refusal
  const mdsV2 = Buffer.from(mdsCd); mdsV2[0x10] = 2;
  fs.writeFileSync(path.join(dir, 'v2bad.mds'), mdsV2);

  await app.open();
  await app.add(['gen/p6/mds/ps1mds.mds', 'gen/p6/mds/ps1mds.mdf', 'gen/p6/mds/dvdmds.mds', 'gen/p6/mds/dvdmds.mdf', 'gen/p6/mds/v2bad.mds']);
  const card = app.job('ps1mds');
  await app.settled(card);
  await expect(card.locator('.sysbadge')).toHaveText('PS1');
  await expect(card.locator('.sbi-note')).toContainText('2 protected sectors');
  await app.run(card);
  const outs = await app.downloads(card);
  expect(outs.some(o => o.name.endsWith('.chd'))).toBe(true);
  expect(outs.some(o => o.name.endsWith('.sbi'))).toBe(true);

  const dvdCard = app.job('dvdmds');
  await app.settled(dvdCard);
  await expect(dvdCard.locator('.sysbadge')).toHaveText('PSP');
  await app.run(dvdCard);
  const dvdOuts = await app.downloads(dvdCard);
  expect(dvdOuts.some(o => o.name.endsWith('.chd'))).toBe(true);

  const badCard = app.job('v2bad');
  await app.waitState(badCard, 'error');
  await expect(badCard.locator('.note.err')).toContainText('Alcohol 120% v2');
});

test('DiscJuggler .cdi v3.5 converts 1-session to CHD, extracts multi-session DC MIL-CD, and offers Flycast 2.8+ CHD', async ({ app }) => {
  const dir = genDir('cdi');
  // 1-session CDI
  const data1 = fs.readFileSync(path.join(FIXTURES, 'lone.bin'));
  fs.writeFileSync(path.join(dir, 'single.cdi'), makeCdiV35([[
    { name: 't1.bin', data: data1, pregap: 0, length: data1.length / 2352, modeCode: 1, secCode: 2, startLba: 0 }
  ]]));

  // 2-session Audio+Data Dreamcast MIL-CD (MODE2/2048 with SEGA SEGAKATANA IP.BIN at LBA 11702)
  const aud = Buffer.alloc(302 * 2352, 0);
  const dcData = Buffer.alloc(20 * 2048, 0);
  dcData.write('SEGA SEGAKATANA SEGA ENTERPRISES', 0, 'ascii');
  dcData.write('GD-ROM1/1       ', 0x20, 'ascii');
  dcData.write('U       ', 0x30, 'ascii');
  dcData.write('T-99999N  ', 0x40, 'ascii');
  dcData.write('SYNTHETIC MIL-CD', 0x80, 'ascii');
  fs.writeFileSync(path.join(dir, 'milcd.cdi'), makeCdiV35([
    [{ name: 't1.raw', data: aud, pregap: 0, length: 302, modeCode: 0, secCode: 2, startLba: 0 }],
    [{ name: 't2.iso', data: dcData, pregap: 0, length: 20, modeCode: 2, secCode: 0, startLba: 11702 }]
  ]));

  await app.open();
  await app.add(['gen/p6/cdi/single.cdi', 'gen/p6/cdi/milcd.cdi']);
  const c1 = app.job('single');
  await app.settled(c1);
  await app.run(c1);
  await expect(c1.locator('.result')).toContainText('Done.');

  const c2 = app.job('milcd');
  await app.settled(c2);
  await expect(c2.locator('.sysbadge')).toHaveText('DC');
  // Default action on multi-session .cdi is Extract .cue + .bin
  await expect(c2.locator('.job-foot button.primary')).toContainText('Extract .cue + .bin');
  await app.run(c2);
  const extOuts = await app.downloads(c2);
  expect(extOuts.map(o => o.name)).toContain('milcd.cue');
  expect(extOuts.length).toBe(3);

  // Switch to Flycast 2.8+ Tier X CHD mode and convert!
  await app.open();
  await app.add(['gen/p6/cdi/milcd.cdi']);
  const c2b = app.job('milcd');
  await app.settled(c2b);
  await c2b.getByRole('button', { name: 'Create CHD (Flycast 2.8+)' }).click();
  await app.run(c2b);
  await expect(c2b.locator('.result')).toContainText('Done.');
});

test('CD+G TRACK nn CDG and CloneCD .ccd/.sub guarded Tier-X toggle emit RW_RAW with emulator warning', async ({ app }) => {
  const dir = genDir('cdg');
  // 1) TRACK 01 CDG (2448 bytes/sector)
  const rawCdg = Buffer.alloc(10 * 2448, 0x11);
  fs.writeFileSync(path.join(dir, 'kara.bin'), rawCdg);
  fs.writeFileSync(path.join(dir, 'kara.cue'), 'FILE "kara.bin" BINARY\n  TRACK 01 CDG\n    INDEX 01 00:00:00\n');
  // 2) CloneCD .ccd + .img + .sub
  const img = fs.readFileSync(path.join(FIXTURES, 'lone.bin'));
  const sub = Buffer.alloc((img.length / 2352) * 96, 0x55);
  fs.writeFileSync(path.join(dir, 'ccdsub.img'), img);
  fs.writeFileSync(path.join(dir, 'ccdsub.sub'), sub);
  fs.writeFileSync(path.join(dir, 'ccdsub.ccd'), '[CloneCD]\nVersion=3\n[Disc]\nSessions=1\n[TRACK 1]\nMODE=1\nINDEX 1=0\n');

  await app.open();
  await app.add(['gen/p6/cdg/kara.cue', 'gen/p6/cdg/kara.bin', 'gen/p6/cdg/ccdsub.ccd', 'gen/p6/cdg/ccdsub.img', 'gen/p6/cdg/ccdsub.sub']);
  const ck = app.job('kara');
  await app.settled(ck);
  await expect(ck.locator('[data-quirk="cdg-subcode"]')).toBeVisible();
  await expect(ck.locator('[data-quirk="cdg-subcode"]')).toContainText('Beetle PCE');
  await app.run(ck);
  const kOut = (await app.downloads(ck))[0];
  if (nativeChdman()) expect(info(kOut.path).raw).toContain('RW_RAW');

  // CloneCD .sub toggle is OFF by default, and turns ON RW_RAW when checked
  const cc = app.job('ccdsub');
  await app.settled(cc);
  await expect(cc.locator('[data-quirk="cdg-subcode"]')).toHaveCount(0);
  await cc.locator('details.opts summary').click();
  await cc.locator('input[type="checkbox"]').check();
  await expect(cc.locator('[data-quirk="cdg-subcode"]')).toBeVisible();
  await app.run(cc);
  const cOut = (await app.downloads(cc))[0];
  if (nativeChdman()) expect(info(cOut.path).raw).toContain('RW_RAW');
});

test('CSO v1, CSO v2, and ZSO (--block=2048) round-trip from ISO and DVD CHD match original ISO byte for byte', async ({ app }) => {
  const isoPath = path.join(FIXTURES, 'frwl.iso');
  const origBuf = fs.readFileSync(isoPath);
  const dir = genDir('ciso-out');

  // Reference DVD CHD directly from frwl.iso
  await app.open();
  await app.add(['frwl.iso']);
  const cRef = app.job('frwl'); await app.settled(cRef); await app.run(cRef);
  const refChd = (await app.downloads(cRef))[0];
  const refChdCopy = path.join(dir, 'frwl-ref.chd');
  fs.copyFileSync(refChd.path, refChdCopy);

  for (const [fmt, magic, ver, extName] of [
    ['zso', 'ZISO', 1, '.zso'],
    ['cso1', 'CISO', 1, '.cso'],
    ['cso2', 'CISO', 2, '.cso']
  ]) {
    await app.open();
    await app.add(['frwl.iso']);
    const card = app.job('frwl');
    await app.settled(card);
    await card.locator('details.opts summary').click();
    await card.locator('label.field', { hasText: 'Output format' }).locator('select').selectOption(fmt);
    await app.run(card);
    const out = (await app.downloads(card))[0];
    expect(out.name.endsWith(extName)).toBe(true);
    const b = fs.readFileSync(out.path);
    expect(b.subarray(0, 4).toString('ascii')).toBe(magic);
    expect(b.readUInt32LE(16)).toBe(2048); // ALWAYS --block=2048 for OPL/PSP/Vita
    expect(b[20]).toBe(ver);
    expect(Number(b.readBigUInt64LE(8))).toBe(origBuf.length);

    // Re-import generated CSO/ZSO back into Discpress -> DVD CHD -> must match original CHD byte for byte!
    const rtPath = path.join(dir, `rt-${fmt}${extName}`);
    fs.copyFileSync(out.path, rtPath);
    await app.open();
    await app.add([`gen/p6/ciso-out/rt-${fmt}${extName}`]);
    const rtCard = app.job(`rt-${fmt}`);
    await app.settled(rtCard);
    await app.run(rtCard);
    const rtChd = (await app.downloads(rtCard))[0];
    expect(sha1File(rtChd.path), `${fmt} round-trip DVD CHD`).toBe(sha1File(refChdCopy));
  }

  // Extract DVD CHD directly to ZSO
  await app.open();
  await app.add(['gen/p6/ciso-out/frwl-ref.chd']);
  const chdCard = app.job('frwl-ref');
  await app.settled(chdCard);
  await chdCard.locator('label.field', { hasText: 'Save as' }).locator('select').selectOption('zso');
  await app.run(chdCard);
  const zOut = (await app.downloads(chdCard))[0];
  const zb = fs.readFileSync(zOut.path);
  expect(zb.subarray(0, 4).toString('ascii')).toBe('ZISO');
  expect(zb.readUInt32LE(16)).toBe(2048);
  expect(Number(zb.readBigUInt64LE(8))).toBe(origBuf.length);
});

test('Original Xbox ISO defaults to scrubbed XISO (.xiso.iso) for xemu, preserving XDVDFS AVL tree and files', async ({ app }) => {
  const dir = genDir('xbox');
  const { iso, f0, f1, filetime } = makeXboxIso();
  fs.writeFileSync(path.join(dir, 'ogxbox.iso'), iso);

  await app.open();
  await app.add(['gen/p6/xbox/ogxbox.iso']);
  const card = app.job('ogxbox');
  await app.settled(card);
  await expect(card.locator('.sysbadge')).toHaveText('XBOX');
  await expect(card.locator('.job-foot button.primary')).toContainText('Create scrubbed XISO');
  await app.run(card);
  await expect(card.locator('.result')).toContainText('scrubbed XISO');
  const out = (await app.downloads(card))[0];
  expect(out.name).toBe('ogxbox.xiso.iso');

  const scrubbed = fs.readFileSync(out.path);
  expect(scrubbed.length).toBeLessThan(iso.length / 4); // stripped huge padding!
  // Verify Volume Descriptor at sector 32
  const vd = scrubbed.subarray(32 * 2048, 33 * 2048);
  expect(vd.subarray(0, 20).toString('ascii')).toBe('MICROSOFT*XBOX*MEDIA');
  expect(vd.subarray(0x7EC, 0x800).toString('ascii')).toBe('MICROSOFT*XBOX*MEDIA');
  expect(vd.readBigUInt64LE(0x1C)).toBe(filetime);
  const rootSec = vd.readUInt32LE(0x14);
  expect(rootSec).toBe(33);
  const rootBuf = scrubbed.subarray(rootSec * 2048, (rootSec + 1) * 2048);
  const s0 = rootBuf.readUInt32LE(4), sz0 = rootBuf.readUInt32LE(8);
  const s1 = rootBuf.readUInt32LE(28), sz1 = rootBuf.readUInt32LE(32);
  expect(sha1Buf(scrubbed.subarray(s0 * 2048, s0 * 2048 + sz0))).toBe(sha1Buf(f0));
  expect(sha1Buf(scrubbed.subarray(s1 * 2048, s1 * 2048 + sz1))).toBe(sha1Buf(f1));
});
