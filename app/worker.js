/* chdman web worker: runs one chdman command (role "job"), or compresses and decompresses
   hunks for another worker (role "helper"). Appended after the Emscripten glue (createChdman). */
'use strict';

var ERR = { ENOENT: 44, EPERM: 63, EIO: 29, EINVAL: 28, EEXIST: 20, ENOTEMPTY: 55, ENOSPC: 51, EISDIR: 31 };
var S_IFDIR = 0o040000, S_IFREG = 0o100000;
var DIR_MODE = S_IFDIR | 0o777, FILE_MODE = S_IFREG | 0o777;
var BLOCK = 1 << 20;
// an error for people: the stores throw {errno} objects, which print as "[object Object]"
function errText(err) {
  if (err && typeof err.errno === 'number') {
    return err.errno === ERR.ENOSPC ? 'the browser\u2019s storage is full. Free some space, or delete earlier results (Settings \u2192 Clear temporary storage), and try again'
      : err.errno === ERR.EIO ? 'a file could not be read or written' : 'file system error ' + err.errno;
  }
  return String(err && err.message || err);
}
var wasmModule = null;
var syncReader = null;

function getReader() {
  if (!syncReader) syncReader = new FileReaderSync();
  return syncReader;
}

function u8(view, offset, length) {
  return new Uint8Array(view.buffer, view.byteOffset + offset, length);
}

async function loadModule(msg) {
  if (wasmModule) return wasmModule;
  if (msg.wasmModule instanceof WebAssembly.Module) wasmModule = msg.wasmModule;
  else wasmModule = await WebAssembly.compile(msg.wasmBytes);
  return wasmModule;
}

function instantiate(extra) {
  var opts = {
    noInitialRun: true,
    instantiateWasm: function (imports, receive) {
      WebAssembly.instantiate(wasmModule, imports).then(function (inst) { receive(inst, wasmModule); },
        function (err) { postMessage({ type: 'fatal', message: 'Could not start WebAssembly: ' + err }); });
      return {};
    },
    locateFile: function (p) { return p; },
    print: function () {},
    printErr: function () {}
  };
  for (var k in extra) opts[k] = extra[k];
  return createChdman(opts);
}

/* ---------------- storage backends ---------------- */

function BlobStore(blob) {
  this.blob = blob;
  this.sizeV = blob.size;
  this.cache = new Map();
  this.readonly = true;
}
BlobStore.prototype.block = function (bi) {
  var b = this.cache.get(bi);
  if (b) {
    this.cache.delete(bi);
    this.cache.set(bi, b);
    return b;
  }
  var start = bi * BLOCK;
  b = new Uint8Array(getReader().readAsArrayBuffer(this.blob.slice(start, Math.min(this.sizeV, start + BLOCK))));
  this.cache.set(bi, b);
  if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value);
  return b;
};
BlobStore.prototype.read = function (dst, pos, len) {
  try { return this.read2(dst, pos, len); }
  catch (e) {
    if (e && typeof e.errno === 'number') throw e;
    postMessage({ type: 'notice', level: 'error', message: 'Reading the input failed: ' + (e && e.message || e) });
    throw { errno: ERR.EIO };
  }
};
BlobStore.prototype.read2 = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  if (len >= BLOCK) {
    var ab = getReader().readAsArrayBuffer(this.blob.slice(pos, pos + len));
    dst.set(new Uint8Array(ab), 0);
    return ab.byteLength;
  }
  var done = 0;
  while (done < len) {
    var p = pos + done, bi = Math.floor(p / BLOCK), off = p - bi * BLOCK;
    var blk = this.block(bi);
    var n = Math.min(len - done, blk.length - off);
    if (n <= 0) break;
    dst.set(blk.subarray(off, off + n), done);
    done += n;
  }
  return done;
};

function MemStore() {
  this.chunks = [];
  this.sizeV = 0;
}
MemStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  var done = 0;
  while (done < len) {
    var p = pos + done, ci = Math.floor(p / BLOCK), off = p - ci * BLOCK;
    var n = Math.min(len - done, BLOCK - off);
    var c = this.chunks[ci];
    if (c) dst.set(c.subarray(off, off + n), done);
    else dst.fill(0, done, done + n);
    done += n;
  }
  return done;
};
MemStore.prototype.write = function (src, pos) {
  var len = src.length, done = 0;
  while (done < len) {
    var p = pos + done, ci = Math.floor(p / BLOCK), off = p - ci * BLOCK;
    var n = Math.min(len - done, BLOCK - off);
    var c = this.chunks[ci];
    if (!c) {
      try { c = this.chunks[ci] = new Uint8Array(BLOCK); }
      catch (e) { throw { errno: ERR.ENOSPC }; }
    }
    c.set(src.subarray(done, done + n), off);
    done += n;
  }
  if (pos + len > this.sizeV) this.sizeV = pos + len;
  return len;
};
MemStore.prototype.truncate = function (n) {
  if (n < this.sizeV) {
    var keep = Math.ceil(n / BLOCK);
    this.chunks.length = Math.min(this.chunks.length, keep);
    var tail = n - (keep - 1) * BLOCK;
    if (keep > 0 && this.chunks[keep - 1] && tail < BLOCK) this.chunks[keep - 1].fill(0, tail);
  }
  this.sizeV = n;
};
MemStore.prototype.toBlob = function () {
  var parts = [], remaining = this.sizeV;
  for (var i = 0; remaining > 0; i++) {
    var n = Math.min(BLOCK, remaining);
    var c = this.chunks[i] || new Uint8Array(BLOCK);
    parts.push(n === BLOCK ? c : c.subarray(0, n));
    remaining -= n;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
};

// A CSO (CISO, versions 1 and 2) or ZSO (ZISO) compressed ISO, read as the ISO itself: blocks are
// decompressed as they are read, a chunk of them at a time (chunkBytes, 4 MiB by default; formats:
// maxcso's README_CSO/ZSO). Deflate blocks go through the module's zlib (setModule); LZ4 blocks are
// decoded here. `label` names the file in the message about a damaged block.
function CisoStore(base, chunkBytes, label) {
  var h = new Uint8Array(24), dv;
  if (base.read(h, 0, 24) !== 24) throw new Error('not a CSO/ZSO image');
  dv = new DataView(h.buffer);
  var magic = String.fromCharCode(h[0], h[1], h[2], h[3]);
  if (magic !== 'CISO' && magic !== 'ZISO') throw new Error('not a CSO/ZSO image');
  this.base = base;
  this.zso = magic === 'ZISO';
  this.v2 = !this.zso && h[20] === 2;
  this.sizeV = dv.getUint32(8, true) + dv.getUint32(12, true) * 4294967296;
  this.bs = dv.getUint32(16, true);
  this.shift = Math.pow(2, h[21]);
  if (!this.bs || this.bs > (1 << 24) || this.bs % 2048) throw new Error('unusual CSO block size ' + this.bs);
  this.nblocks = Math.ceil(this.sizeV / this.bs);
  var raw = new Uint8Array((this.nblocks + 1) * 4);
  if (base.read(raw, 24, raw.length) !== raw.length) throw new Error('truncated CSO index');
  this.index = new Uint32Array(raw.buffer);
  this.readonly = true;
  this.chunkBlocks = Math.max(1, Math.floor((chunkBytes || 4 << 20) / this.bs));
  this.chunks = [];   // the two most recent chunks: {first, data}
  this.M = null;
  this.label = label || 'the image';
  this.reported = false;
}
CisoStore.prototype.damaged = function (b) {
  if (!this.reported) {
    this.reported = true;
    postMessage({ type: 'notice', level: 'error', message: '"' + this.label + '" is damaged or incomplete: block ' + b + ' of ' + this.nblocks + ' could not be read.' });
  }
  return { errno: ERR.EIO };
};
CisoStore.prototype.setModule = function (M) {
  this.M = M;
  this.srcCap = this.bs + 64;
  this.src = M._malloc(this.srcCap);
  this.dst = M._malloc(this.bs);
};
// the block's stored bytes start and length, and how they are stored: 0 raw, 1 deflate, 2 LZ4
CisoStore.prototype.block = function (b) {
  var e = this.index[b], next = this.index[b + 1];
  var start = (e & 0x7fffffff) * this.shift, len = (next & 0x7fffffff) * this.shift - start;
  var high = e >>> 31, how;
  if (this.zso) how = high ? 0 : 2;
  else if (this.v2) how = len >= this.bs ? 0 : high ? 2 : 1;
  else how = high ? 0 : 1;
  return { start: start, len: len, how: how };
};
CisoStore.prototype.chunk = function (c) {
  for (var i = 0; i < this.chunks.length; i++) if (this.chunks[i].first === c) return this.chunks[i].data;
  var first = c * this.chunkBlocks, last = Math.min(this.nblocks, first + this.chunkBlocks);
  var b0 = this.block(first), end = (this.index[last] & 0x7fffffff) * this.shift;
  // blocks are at most a little larger than block_size (padding; deflate's worst case), unless damaged
  if (!(end >= b0.start && end - b0.start <= (last - first) * (2 * this.bs + this.shift) + 4096)) throw this.damaged(first);
  var stored = new Uint8Array(end - b0.start), got = this.base.read(stored, b0.start, stored.length);
  var bs = this.bs, out = new Uint8Array((last - first) * bs), M = this.M;
  for (var b = first; b < last; b++) {
    var blk = this.block(b), at = blk.start - b0.start, want = Math.min(bs, this.sizeV - b * bs), o = (b - first) * bs;
    if (!(blk.len >= 0 && at + blk.len <= got)) throw this.damaged(b);
    if (blk.how === 0) {
      if (blk.len < want) throw this.damaged(b);
      out.set(stored.subarray(at, at + want), o);
    } else if (blk.how === 2) {
      if (lz4Block(stored, at, at + blk.len, out, o, want) !== want) throw this.damaged(b);
    } else {
      if (!M) throw this.damaged(b);
      if (blk.len > this.srcCap) { M._free(this.src); this.srcCap = blk.len; this.src = M._malloc(blk.len); }
      M.HEAPU8.set(stored.subarray(at, at + blk.len), this.src);
      if (M._wasm_inflate_raw(this.src, blk.len, this.dst, want) !== want) throw this.damaged(b);
      out.set(M.HEAPU8.subarray(this.dst, this.dst + want), o);
    }
  }
  this.chunks = [{ first: c, data: out }].concat(this.chunks.slice(0, 1));
  return out;
};
CisoStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  var M = this.M, heap = M && dst.buffer === M.HEAPU8.buffer, addr = dst.byteOffset, done = 0, span = this.chunkBlocks * this.bs;
  var parts = [];
  while (done < len) {
    var p = pos + done, c = Math.floor(p / span), data = this.chunk(c), off = p - c * span;
    var n = Math.min(len - done, data.length - off);
    if (n <= 0) break;
    parts.push({ data: data, off: off, n: n, at: done });
    done += n;
  }
  // chdman's buffer is in the module's memory, which may have grown (and moved) meanwhile
  if (heap && dst.byteLength === 0) dst = M.HEAPU8.subarray(addr, addr + len);
  parts.forEach(function (q) { dst.set(q.data.subarray(q.off, q.off + q.n), q.at); });
  return done;
};

// An ECM image (the ecm tools' Error Code Modeler format, described in wasm/ecm.cpp), read as the
// CD image it packs. A scan of its chunk headers maps the image's bytes to the file's, with a
// checkpoint about every ECM_WINDOW bytes of the image (on a sector boundary, or inside a chunk
// of bytes stored as they are); the windows between checkpoints are rebuilt by the module
// (wasm_ecm_decode: sync, headers, EDC, ECC) as they are read. An image read in order to its end
// must have the EDC the file ends with, as ecm2bin checks: otherwise it is damaged.
var ECM_STORED = [1, 2051, 2052, 2328], ECM_SIZE = [1, 2352, 2336, 2336], ECM_WINDOW = 1 << 20;
function EcmStore(base, label) {
  var head = new Uint8Array(4);
  if (base.read(head, 0, 4) !== 4 || head[0] !== 69 || head[1] !== 67 || head[2] !== 77 || head[3] !== 0) throw new Error('not an ECM image');
  this.base = base;
  this.label = label || 'the image';
  this.readonly = true;
  this.M = null;
  this.reported = false;
  // checkpoints: the image's offset, the file's, and the chunk's type and units left there (0: a header)
  var cpOut = [], cpIn = [], cpType = [], cpLeft = [], next = 0;
  var size = base.sizeV, pos = 4, out = 0, buf = new Uint8Array(1 << 20), bufAt = 0, bufLen = 0;
  var fail = function (why) { return new Error(why + ' (at byte ' + pos + ' of ' + size + ')'); };
  var byteAt = function (p) {
    if (p >= bufAt + bufLen || p < bufAt) {
      if (p >= size) throw fail('it ends before the image it holds does');
      bufAt = p;
      try { bufLen = base.read(buf, p, Math.min(buf.length, size - p)); } catch (e) { bufLen = 0; }
      if (bufLen <= 0) throw fail('it could not be read');
    }
    return buf[p - bufAt];
  };
  var mark = function (o, i, type, left) { cpOut.push(o); cpIn.push(i); cpType.push(type); cpLeft.push(left); next = o + ECM_WINDOW; };
  for (;;) {
    if (out >= next) mark(out, pos, 0, 0);
    var at = pos, c = byteAt(pos++), type = c & 3, n = (c >> 2) & 31, bits = 5;
    while (c & 128) {
      if (bits > 26) throw fail('a chunk header is invalid');
      c = byteAt(pos++);
      n += (c & 127) * Math.pow(2, bits);
      bits += 7;
    }
    if (n > 0xFFFFFFFF) throw fail('a chunk header is invalid');
    if (n === 0xFFFFFFFF) break; // the end; the EDC follows
    var count = n + 1, isz = ECM_STORED[type], osz = ECM_SIZE[type];
    if (pos + count * isz > size) throw fail('it ends before the image it holds does');
    // checkpoints inside a long chunk
    for (var u = Math.ceil((next - out) / osz); u < count; u = Math.ceil((next - out) / osz)) mark(out + u * osz, pos + u * isz, type, count - u);
    pos += count * isz;
    out += count * osz;
  }
  if (cpOut[cpOut.length - 1] !== out) mark(out, at, 0, 0);
  if (pos + 4 > size) throw fail('it ends before its checksum');
  this.edcWant = (byteAt(pos) | (byteAt(pos + 1) << 8) | (byteAt(pos + 2) << 16) | (byteAt(pos + 3) << 24)) >>> 0;
  this.cp = { out: cpOut, inp: cpIn, type: cpType, left: cpLeft };
  this.sizeV = out;
  this.maxIn = 0;
  this.maxOut = 0;
  for (var w = 0; w + 1 < cpOut.length; w++) {
    this.maxIn = Math.max(this.maxIn, cpIn[w + 1] - cpIn[w]);
    this.maxOut = Math.max(this.maxOut, cpOut[w + 1] - cpOut[w]);
  }
  this.windows = []; // the two most recent: {w, data}
  this.last = 0;
  this.edc = 0;      // of the image read in order so far, up to edcAt
  this.edcAt = 0;
}
EcmStore.prototype.damaged = function (o, why) {
  if (!this.reported) {
    this.reported = true;
    postMessage({ type: 'notice', level: 'error', message: '"' + this.label + '" is damaged: ' + (why || 'the image it holds could not be rebuilt at byte ' + o + '.') });
  }
  return { errno: ERR.EIO };
};
EcmStore.prototype.setModule = function (M) {
  this.M = M;
  this.src = M._malloc(Math.max(1, this.maxIn));
  this.dst = M._malloc(Math.max(1, this.maxOut));
};
// the window holding image offset p
EcmStore.prototype.find = function (p) {
  var o = this.cp.out, w = this.last;
  if (o[w] <= p && p < o[w + 1]) return w;
  if (o[w + 1] <= p && p < o[w + 2]) return (this.last = w + 1);
  var lo = 0, hi = o.length - 2;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (o[mid] <= p) lo = mid; else hi = mid - 1;
  }
  return (this.last = lo);
};
EcmStore.prototype.window = function (w) {
  for (var i = 0; i < this.windows.length; i++) if (this.windows[i].w === w) return this.windows[i].data;
  var M = this.M, cp = this.cp, inLen = cp.inp[w + 1] - cp.inp[w], outLen = cp.out[w + 1] - cp.out[w];
  if (!M) throw this.damaged(cp.out[w]);
  if (this.base.read(M.HEAPU8.subarray(this.src, this.src + inLen), cp.inp[w], inLen) !== inLen) throw this.damaged(cp.out[w]);
  if (M._wasm_ecm_decode(this.src, inLen, this.dst, outLen, cp.type[w], cp.left[w]) !== inLen) throw this.damaged(cp.out[w]);
  if (cp.out[w] === this.edcAt) {
    this.edc = M._wasm_ecm_edc(this.edc, this.dst, outLen) >>> 0;
    this.edcAt += outLen;
    if (this.edcAt === this.sizeV && this.edc !== this.edcWant) throw this.damaged(0, 'the image rebuilt from it doesn’t match the checksum it ends with.');
  }
  var data = M.HEAPU8.slice(this.dst, this.dst + outLen);
  this.windows = [{ w: w, data: data }].concat(this.windows.slice(0, 1));
  return data;
};
EcmStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  var M = this.M, heap = M && dst.buffer === M.HEAPU8.buffer, addr = dst.byteOffset, done = 0, parts = [];
  while (done < len) {
    var p = pos + done, w = this.find(p), data = this.window(w), off = p - this.cp.out[w];
    var n = Math.min(len - done, data.length - off);
    if (n <= 0) break;
    parts.push({ data: data, off: off, n: n, at: done });
    done += n;
  }
  if (heap && dst.byteLength === 0) dst = M.HEAPU8.subarray(addr, addr + len);
  parts.forEach(function (q) { dst.set(q.data.subarray(q.off, q.off + q.n), q.at); });
  return done;
};

// LZ4 block format: decodes src[from, to) into out at o, up to `want` bytes; returns the count,
// or -1 if the data is damaged. Like maxcso, it stops there: a block can be followed by padding,
// and an image's last block can decode to more, the zeros that fill it to the block size.
function lz4Block(src, from, to, out, o, want) {
  var i = from, start = o, end = o + want;
  while (i < to && o < end) {
    var token = src[i++], n = token >>> 4;
    if (n === 15) { var b; do { b = src[i++]; n += b; } while (b === 255 && i < to); }
    if (i + n > to) return -1;
    var lit = Math.min(n, end - o);
    out.set(src.subarray(i, i + lit), o);
    i += n; o += lit;
    if (i >= to || o >= end) break; // the last sequence has only literals
    if (i + 2 > to) return -1;
    var off = src[i] | (src[i + 1] << 8);
    i += 2;
    var m = (token & 15) + 4;
    if ((token & 15) === 15) { var c; do { c = src[i++]; m += c; } while (c === 255 && i < to); }
    if (i > to || !off || off > o - start) return -1; // a length running past the block: damaged
    m = Math.min(m, end - o);
    if (off >= m) out.copyWithin(o, o - off, o - off + m);
    else for (var k = 0; k < m; k++) out[o + k] = out[o + k - off]; // overlapping: repeats the last bytes
    o += m;
  }
  return o - start;
}

// Every access-handle write has a fixed cost (up to ~0.7 ms measured in Chromium), and chdman
// writes each compressed hunk separately (4 KiB for DVDs), so small writes are gathered in
// write-back buffers: hundreds of times fewer writes, and the job worker no longer starves the
// helpers. A few independent ranges per file cover chdman's patterns (uncompressed CHDs
// alternate between hunk data at the end and map entries near the start). Buffered ranges never
// overlap, reads flush what they touch, and switching to another file writes this one's out,
// so only one file holds buffers at a time.
var WBUF = 2 << 20, NBUF = 4, lastWriter = null;
function OpfsStore(slot) {
  this.slot = slot;
  this.h = slot.handle;
  this.sizeV = 0;
  this.bufs = [];
  this.tick = 0;
}
OpfsStore.prototype.put = function (src, pos) {
  var n;
  try { n = this.h.write(src, { at: pos }); }
  catch (e) {
    postMessage({ type: 'notice', level: 'error', message: 'Storage full: the browser refused to write more data (' + (e && e.name || e) + ').' });
    throw { errno: ERR.ENOSPC };
  }
  if (n !== src.length) throw { errno: ERR.ENOSPC };
};
OpfsStore.prototype.flushBuf = function (b) {
  if (!b.len) return;
  var len = b.len;
  b.len = 0;
  this.put(b.data.subarray(0, len), b.pos);
};
// write out buffered ranges overlapping [pos, pos + len), except `keep`
OpfsStore.prototype.flushRange = function (pos, len, keep) {
  for (var i = 0; i < this.bufs.length; i++) {
    var b = this.bufs[i];
    if (b !== keep && b.len && pos < b.pos + b.len && pos + len > b.pos) this.flushBuf(b);
  }
};
OpfsStore.prototype.flush = function () {
  for (var i = 0; i < this.bufs.length; i++) this.flushBuf(this.bufs[i]);
};
OpfsStore.prototype.release = function () {
  this.flush();
  this.bufs = [];
  if (lastWriter === this) lastWriter = null;
};
OpfsStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  this.flushRange(pos, len, null);
  return this.h.read(dst.subarray(0, len), { at: pos });
};
OpfsStore.prototype.write = function (src, pos) {
  var len = src.length;
  if (lastWriter !== this) {
    if (lastWriter) lastWriter.release();
    lastWriter = this;
  }
  if (len >= WBUF) {
    this.flushRange(pos, len, null);
    this.put(src, pos);
  } else {
    // a range this write extends or overwrites, else a free one, else the least recently used
    var b = null, i;
    for (i = 0; i < this.bufs.length && !b; i++) {
      var c = this.bufs[i];
      if (c.len && pos >= c.pos && pos <= c.pos + c.len && pos + len <= c.pos + WBUF) b = c;
    }
    this.flushRange(pos, len, b);
    if (!b) {
      for (i = 0; i < this.bufs.length && !b; i++) if (!this.bufs[i].len) b = this.bufs[i];
      if (!b && this.bufs.length < NBUF) this.bufs.push(b = { pos: 0, len: 0, tick: 0, data: new Uint8Array(WBUF) });
      if (!b) {
        b = this.bufs[0];
        for (i = 1; i < this.bufs.length; i++) if (this.bufs[i].tick < b.tick) b = this.bufs[i];
        this.flushBuf(b);
      }
      b.pos = pos;
    }
    b.data.set(src, pos - b.pos);
    b.len = Math.max(b.len, pos - b.pos + len);
    b.tick = ++this.tick;
  }
  if (pos + len > this.sizeV) this.sizeV = pos + len;
  return len;
};
OpfsStore.prototype.truncate = function (n) {
  this.flush();
  this.h.truncate(n);
  this.sizeV = n;
};

/* Stream store: results go straight to a folder the user picked. The page writes
   the chunks to disk; only the first few MB (headers, metadata) stay readable here. */
var PIN = 8;
var streamSeq = 0;
function StreamStore(name) {
  this.id = ++streamSeq;
  this.chunks = [];
  this.flushed = [];
  this.sizeV = 0;
  postMessage({ type: 's-open', id: this.id, name: name });
}
StreamStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  var done = 0;
  while (done < len) {
    var p = pos + done, ci = Math.floor(p / BLOCK), off = p - ci * BLOCK;
    var n = Math.min(len - done, BLOCK - off);
    var c = this.chunks[ci];
    if (c) dst.set(c.subarray(off, off + n), done);
    else if (this.flushed[ci]) throw { errno: ERR.EIO };
    else dst.fill(0, done, done + n);
    done += n;
  }
  return done;
};
StreamStore.prototype.write = function (src, pos) {
  var len = src.length, done = 0;
  while (done < len) {
    var p = pos + done, ci = Math.floor(p / BLOCK), off = p - ci * BLOCK;
    var n = Math.min(len - done, BLOCK - off);
    if (this.flushed[ci]) {
      // region already on disk: forward a positional write
      sinkPending += n;
      postMessage({ type: 's-write', id: this.id, pos: p, data: src.slice(done, done + n) });
    } else {
      var c = this.chunks[ci];
      if (!c) c = this.chunks[ci] = new Uint8Array(BLOCK);
      c.set(src.subarray(done, done + n), off);
    }
    done += n;
  }
  if (pos + len > this.sizeV) this.sizeV = pos + len;
  // hand finished chunks (well behind the write position) to the page
  // (from where the last scan stopped: a chunk written again behind it goes at finish())
  var upto = Math.floor(pos / BLOCK) - 1;
  for (var k = Math.max(PIN, this.scanned || 0); k < upto; k++) {
    var ch = this.chunks[k];
    if (ch) {
      this.chunks[k] = null;
      this.flushed[k] = true;
      sinkPending += ch.length;
      postMessage({ type: 's-write', id: this.id, pos: k * BLOCK, data: ch }, [ch.buffer]);
    }
  }
  if (upto > (this.scanned || 0)) this.scanned = upto;
  return len;
};
StreamStore.prototype.truncate = function (n) {
  if (n < this.sizeV) {
    var keep = Math.ceil(n / BLOCK);
    for (var k = keep; k < this.chunks.length; k++) { this.chunks[k] = null; }
    var tail = n - (keep - 1) * BLOCK;
    if (keep > 0 && this.chunks[keep - 1] && tail < BLOCK) this.chunks[keep - 1].fill(0, tail);
  }
  this.sizeV = n;
  postMessage({ type: 's-trunc', id: this.id, size: n });
};
StreamStore.prototype.finish = function (keep) {
  if (!keep || this.deleted) { postMessage({ type: 's-remove', id: this.id }); return; }
  var total = this.sizeV;
  for (var k = 0; k < this.chunks.length; k++) {
    var ch = this.chunks[k];
    if (!ch || k * BLOCK >= total) continue;
    var n = Math.min(BLOCK, total - k * BLOCK);
    var data = n === BLOCK ? ch : ch.slice(0, n);
    postMessage({ type: 's-write', id: this.id, pos: k * BLOCK, data: data }, [data.buffer]);
    this.chunks[k] = null;
  }
  postMessage({ type: 's-close', id: this.id, size: total });
};

// An output that is only checksummed (outMode 'crc', to compare with Redump): the CRC-32 of the file
// as written. extractcd and extractdvd write each file front to back; a write elsewhere makes the
// checksum unknown.
function CrcStore(backing) {
  this.backing = backing;
  this.sizeV = 0;
  this.crc = 0;
  this.inOrder = true;
}
CrcStore.prototype.write = function (src, pos) {
  var M = this.backing.M, n = src.length;
  if (pos !== this.sizeV) this.inOrder = false;
  else if (M && src.buffer === M.HEAPU8.buffer) this.crc = M._crc32(this.crc, src.byteOffset, n) >>> 0; // zlib's, on chdman's buffer
  else this.crc = (crcUpdate(this.crc ^ -1, src) ^ -1) >>> 0;
  this.sizeV = Math.max(this.sizeV, pos + n);
  return n;
};
CrcStore.prototype.read = function () { throw { errno: ERR.EIO }; };
CrcStore.prototype.truncate = function (n) {
  if (n !== this.sizeV) this.inOrder = false;
  this.sizeV = n;
};

/* ---------------- Emscripten filesystem driver ---------------- */

function makeFS(FS) {
  function fail(code) { throw new FS.ErrnoError(code); }
  function wrap(fn) {
    try { return fn(); }
    catch (e) {
      if (e && typeof e.errno === 'number' && !(e instanceof FS.ErrnoError)) fail(e.errno);
      throw e;
    }
  }
  var CHDFS = {
    mount: function (mount) {
      var root = CHDFS.createNode(null, '/', DIR_MODE, null);
      (mount.opts.files || []).forEach(function (f) { CHDFS.createNode(root, f.name, FILE_MODE, f.store); });
      return root;
    },
    createNode: function (parent, name, mode, store) {
      var node = FS.createNode(parent, name, mode, 0);
      node.node_ops = CHDFS.node_ops;
      node.stream_ops = CHDFS.stream_ops;
      node.atime = node.mtime = node.ctime = Date.now();
      if (FS.isDir(mode)) node.contents = {};
      else { node.store = store; store.name = name; }
      if (parent) parent.contents[name] = node;
      return node;
    },
    node_ops: {
      getattr: function (node) {
        var size = FS.isDir(node.mode) ? 4096 : node.store.sizeV;
        return {
          dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size: size,
          atime: new Date(node.atime), mtime: new Date(node.mtime), ctime: new Date(node.ctime),
          blksize: 4096, blocks: Math.ceil(size / 4096)
        };
      },
      setattr: function (node, attr) {
        ['mode', 'atime', 'mtime', 'ctime'].forEach(function (k) { if (attr[k] != null) node[k] = attr[k]; });
        if (attr.size != null && !FS.isDir(node.mode)) {
          if (node.store.readonly) fail(ERR.EPERM);
          wrap(function () { node.store.truncate(attr.size); });
        }
      },
      lookup: function (parent, name) {
        var lower = name.toLowerCase();
        for (var k in parent.contents) if (k.toLowerCase() === lower) return parent.contents[k];
        fail(ERR.ENOENT);
      },
      mknod: function (parent, name, mode, dev) {
        if (FS.isDir(mode)) return CHDFS.createNode(parent, name, DIR_MODE, null);
        var backing = parent.mount && parent.mount.opts.backing;
        if (!backing) fail(ERR.EPERM);
        return CHDFS.createNode(parent, name, FILE_MODE, backing.create(name));
      },
      rename: function (oldNode, newDir, newName) {
        var existing = newDir.contents[newName];
        if (existing) {
          if (FS.isDir(existing.mode) && Object.keys(existing.contents).length) fail(ERR.ENOTEMPTY);
          if (existing.store) existing.store.deleted = true;
          FS.hashRemoveNode(existing);
        }
        delete oldNode.parent.contents[oldNode.name];
        newDir.contents[newName] = oldNode;
        oldNode.name = newName;
        if (oldNode.store) oldNode.store.name = newName;
      },
      unlink: function (parent, name) {
        var node = parent.contents[name];
        if (node && node.store) {
          if (node.store.readonly) fail(ERR.EPERM);
          node.store.deleted = true;
          try { node.store.truncate(0); } catch (e) { /* ignore */ }
        }
        delete parent.contents[name];
      },
      rmdir: function (parent, name) {
        var node = parent.contents[name];
        if (node && Object.keys(node.contents).length) fail(ERR.ENOTEMPTY);
        delete parent.contents[name];
      },
      readdir: function (node) { return ['.', '..'].concat(Object.keys(node.contents)); },
      symlink: function () { fail(ERR.EPERM); }
    },
    stream_ops: {
      read: function (stream, buffer, offset, length, position) {
        if (length <= 0) return 0;
        return wrap(function () { return stream.node.store.read(u8(buffer, offset, length), position, length); });
      },
      write: function (stream, buffer, offset, length, position) {
        var store = stream.node.store;
        if (store.readonly) fail(ERR.EPERM);
        if (length <= 0) return 0;
        stream.node.mtime = Date.now();
        return wrap(function () { return store.write(u8(buffer, offset, length), position); });
      },
      llseek: function (stream, offset, whence) {
        var position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2 && FS.isFile(stream.node.mode)) position += stream.node.store.sizeV;
        if (position < 0) fail(ERR.EINVAL);
        return position;
      }
    }
  };
  return CHDFS;
}

/* ---------------- output storage ---------------- */

async function makeBacking(msg) {
  var registry = [], slots = [], dir = null;
  if (msg.outMode === 'opfs' && msg.slots > 0) {
    try {
      dir = await navigator.storage.getDirectory();
      var path = msg.dirPath || ['chdman-work', msg.jobId];
      for (var pi = 0; pi < path.length; pi++) dir = await dir.getDirectoryHandle(path[pi], { create: true });
      for (var i = 0; i < msg.slots; i++) {
        var name = 'slot' + i;
        var fh = await dir.getFileHandle(name, { create: true });
        var handle = await fh.createSyncAccessHandle();
        var t = handle.truncate(0);
        if (t && typeof t.then === 'function') {
          // early Safari versions only had asynchronous access handles
          try { await t; await handle.close(); } catch (e) { /* ignore */ }
          throw new Error('synchronous file access is not supported');
        }
        slots.push({ name: name, handle: handle, used: false, store: null });
      }
    } catch (err) {
      slots.forEach(function (s) { try { s.handle.close(); } catch (e) { /* ignore */ } });
      slots = [];
      dir = null;
      postMessage({ type: 'notice', level: 'info', storage: 'mem', message: 'Disk storage unavailable (' + (err && err.name || err) + '); keeping results in memory.' });
    }
  }
  var streaming = msg.outMode === 'stream', crcOnly = msg.outMode === 'crc';
  var backing = {
    mode: crcOnly ? 'crc' : streaming ? 'stream' : dir ? 'opfs' : 'mem',
    M: null, // the module, once instantiated (CrcStore uses its crc32)
    create: function (name, writableCopy) {
      var slot = slots.find(function (s) { return !s.used; });
      var store;
      if (crcOnly && !writableCopy) store = new CrcStore(backing);
      else if (streaming && !writableCopy) store = new StreamStore(name);
      else if (slot) { slot.used = true; store = new OpfsStore(slot); slot.store = store; }
      else store = new MemStore();
      store.name = name;
      registry.push(store);
      return store;
    },
    // write out buffered data; returns an error message if the storage refused it
    flush: function () {
      for (var i = 0; i < registry.length; i++) {
        var st = registry[i];
        if (!(st instanceof OpfsStore) || st.deleted) continue;
        try { st.flush(); }
        catch (e) { return 'Storage full: could not finish writing ' + st.name + '.'; }
      }
      return null;
    },
    finalize: async function (keep) {
      var outputs = [];
      registry.forEach(function (st) {
        if (st instanceof CrcStore) {
          if (keep && !st.deleted) outputs.push({ name: st.name, size: st.sizeV, kind: 'crc', crc: st.inOrder ? ('00000000' + st.crc.toString(16).toUpperCase()).slice(-8) : null });
          return;
        }
        if (st instanceof StreamStore) {
          st.finish(keep);
          if (keep && !st.deleted) outputs.push({ name: st.name, size: st.sizeV, kind: 'disk', id: st.id });
          return;
        }
        if (st.deleted || !keep) return;
        if (st instanceof OpfsStore) {
          try { st.flush(); st.h.flush(); } catch (e) { /* ignore */ }
          outputs.push({ name: st.name, size: st.sizeV, kind: 'opfs', slot: st.slot.name });
        } else {
          outputs.push({ name: st.name, size: st.sizeV, kind: 'blob', blob: st.toBlob() });
          st.chunks = [];
        }
      });
      slots.forEach(function (s) { try { s.handle.close(); } catch (e) { /* ignore */ } });
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (!keep || !s.used || (s.store && s.store.deleted)) {
          try { await dir.removeEntry(s.name); } catch (e) { /* ignore */ }
        }
      }
      return outputs;
    }
  };
  return backing;
}

/* ---------------- input staging ----------------
   Some browsers (notably iOS web views) hand workers File objects that cannot be
   read synchronously. Such inputs are first copied into private storage (or
   memory): read here asynchronously, or, failing that, sent over by the page. */

var stageWaiter = null;

function storeReadable(st) {
  try {
    var n = Math.min(BLOCK, st.sizeV);
    var rd = st.read2 || st.read;
    if (n) rd.call(st, new Uint8Array(n), 0, n);
    if (st.sizeV > BLOCK) rd.call(st, new Uint8Array(4096), st.sizeV - 4096, 4096);
    return true;
  } catch (e) {
    return false;
  }
}

async function stageTarget(msg, name, stages) {
  try {
    var dir = await navigator.storage.getDirectory();
    var path = msg.dirPath || ['chdman-work', msg.jobId];
    for (var i = 0; i < path.length; i++) dir = await dir.getDirectoryHandle(path[i], { create: true });
    var fname = 'stage-' + stages.length;
    var fh = await dir.getFileHandle(fname, { create: true });
    var h = await fh.createSyncAccessHandle();
    var t = h.truncate(0);
    if (t && typeof t.then === 'function') throw new Error('async handles');
    var slot = { name: fname, handle: h, used: true };
    stages.push({ dir: dir, slot: slot });
    return new OpfsStore(slot);
  } catch (e) {
    return new MemStore();
  }
}

async function stageInput(msg, index, stages) {
  var inp = msg.inputs[index], blob = inp.blob, size = blob.size;
  var dst = await stageTarget(msg, inp.name, stages);
  var step = 4 << 20, pos = 0, last = 0;
  postMessage({ type: 'notice', level: 'info', message: 'This browser cannot read "' + inp.name + '" directly in the background, so it is copied to private storage first.' });
  function prog() {
    var now = Date.now();
    if (now - last > 300) { last = now; postMessage({ type: 'progress', text: 'Copying input, ' + (size ? 100 * pos / size : 100).toFixed(1) + '% complete' }); }
  }
  try {
    if (msg.debugStage === 2) throw new Error('debug');
    for (; pos < size; pos += step) {
      var ab = await blob.slice(pos, Math.min(size, pos + step)).arrayBuffer();
      dst.write(new Uint8Array(ab), pos);
      prog();
    }
  } catch (e) {
    if (e && typeof e.errno === 'number') throw e; // the copy couldn't be written (storage full): not a read problem
    // async reads fail too: let the page read the file and send it over
    await new Promise(function (resolve, reject) {
      stageWaiter = { dst: dst, resolve: resolve, reject: reject, size: size, onChunk: function (p) { pos = p; prog(); } };
      postMessage({ type: 'stage-request', index: index, from: pos });
    });
    stageWaiter = null;
  }
  dst.sizeV = size;
  dst.readonly = true;
  return dst;
}

/* ---------------- multi-core compression and decompression (job side) ---------------- */

function setupParallel(M, ports) {
  var helpers = ports.map(function (port, i) { return { port: port, inflight: 0, id: i }; });
  var hunkbytes = 0, batchSize = 1, scratch = 0, open = null, pending = [], fifo = [], done = new Set();
  var sleeper = null, seq = 0, failed = null;
  var mc = new MessageChannel(), wakeFn = null;
  mc.port1.onmessage = function () { var w = wakeFn; wakeFn = null; if (w) w(); };
  function wake(w) { wakeFn = w; mc.port2.postMessage(0); }

  function flushOpen() {
    if (open && open.n) { pending.push(open); }
    open = null;
  }
  function dispatch() {
    flushOpen();
    for (var round = 0; round < 2; round++) {
      for (var i = 0; i < helpers.length && pending.length; i++) {
        var h = helpers[i];
        if (h.inflight > round) continue;
        var b = pending.shift();
        h.inflight++;
        var items = b.items.slice(0, b.n), codecs = b.codecs.slice(0, b.n);
        var data = b.n === batchSize ? b.buf : b.buf.slice(0, b.n * hunkbytes);
        h.port.postMessage({ type: 'batch', id: ++seq, items: items, codecs: codecs, data: data.buffer }, [items.buffer, codecs.buffer, data.buffer]);
      }
    }
  }
  function headDone() {
    while (fifo.length && done.has(fifo[0])) { done.delete(fifo[0]); fifo.shift(); }
  }
  function maybeWake() {
    if (!sleeper) return;
    if (failed || fifo.length === 0 || done.has(fifo[0])) {
      headDone();
      var s = sleeper; sleeper = null; wake(s);
    }
  }
  helpers.forEach(function (h) {
    h.port.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'error') {
        failed = m.message;
        postMessage({ type: 'notice', level: 'error', message: 'A helper thread failed: ' + m.message });
        maybeWake();
        rdWake(); // an extract or verify waiting on it: rdWait reports the failure
        return;
      }
      if (m.type === 'dresult') {
        h.inflight--;
        rdResult(m);
        rdDispatch();
        rdWake();
        return;
      }
      if (m.type !== 'result') return;
      h.inflight--;
      var items = m.items, meta = m.meta, sha1 = m.sha1, out = m.out, o = 0;
      for (var i = 0; i < items.length; i++) {
        var c = meta[i * 3], len = meta[i * 3 + 1] >>> 0, crc = meta[i * 3 + 2] >>> 0;
        var heap = M.HEAPU8;
        heap.set(sha1.subarray(i * 20, i * 20 + 20), scratch);
        heap.set(out.subarray(o, o + len), scratch + 32);
        o += len;
        M._wasm_par_complete(items[i], crc, scratch, c, len, scratch + 32);
        done.add(items[i]);
      }
      dispatch();
      maybeWake();
    };
  });

  // flags: 1 = libdeflate for the deflate codec (--libdeflate)
  M.parSetup = function (hb, ub, comps, flags) {
    if (!helpers.length) return false;
    // the LaserDisc codec (avhu) reads settings from the CHD's own metadata: keep it single-threaded
    if (comps.indexOf(0x61766875) >= 0) return false;
    hunkbytes = hb;
    // chdman keeps at most 256 hunks in flight and reads them 128 at a time, so a batch must be
    // small enough for those 128 to give every helper two batches; otherwise helpers sit idle
    // (with 4 KiB DVD hunks, 512 KiB batches meant only two helpers ever had work)
    batchSize = Math.max(1, Math.min(64, Math.floor((512 * 1024) / hb), Math.floor(128 / (2 * helpers.length))));
    scratch = M._malloc(hb + 64);
    helpers.forEach(function (h) { h.port.postMessage({ type: 'init', hunkbytes: hb, unitbytes: ub, comps: comps, flags: flags || 0 }); });
    M.parActive = true;
    postMessage({ type: 'notice', level: 'debug', message: 'multi-core compression: ' + helpers.length + ' helper threads, batch ' + batchSize });
    return true;
  };
  // codecs: the codec slots the codec plan tries for this hunk, a bit each (15 = all)
  M.parSubmit = function (item, ptr, len, codecs) {
    if (!open) open = { n: 0, items: new Uint32Array(batchSize), codecs: new Uint8Array(batchSize), buf: new Uint8Array(batchSize * hunkbytes) };
    open.buf.set(M.HEAPU8.subarray(ptr, ptr + len), open.n * hunkbytes);
    open.codecs[open.n] = codecs;
    open.items[open.n++] = item;
    fifo.push(item);
    if (open.n === batchSize) flushOpen();
  };
  // chdman paused after a compression step: resolves when it can go on (its next hunk is in)
  M.parWait = function () {
    return new Promise(function (resolve) {
      if (failed) {
        // abort the whole run: helper failed, results would be incomplete
        postMessage({ type: 'fatal', message: 'Multi-core compression failed (' + failed + '). Try again with 1 thread in Settings.' });
        return; // never resolves: the job worker is terminated by the page
      }
      dispatch();
      headDone();
      sleeper = resolve;
      maybeWake();
    });
  };

  // Extract and verify: helpers decompress the hunks chdman is about to read (chd_file::wasm_read_ahead
  // hands them over with wasm_rd_submit); the results go straight into the engine's cache slots.
  // One file at a time; a closed file's late results are dropped by generation.
  var rd = { chd: 0, gen: 0, hb: 0, batch: 1, open: null, queue: [], busy: 0, waiting: null };
  function rdFlush() {
    if (rd.open && rd.open.n) rd.queue.push(rd.open);
    rd.open = null;
  }
  // Every batch goes out at once, to the least busy helper: the job worker can't hand out work while
  // chdman uses a window of hunks, so helpers need their queue (at most two windows, see wasm_read_ahead)
  function rdDispatch() {
    rdFlush();
    while (rd.queue.length) {
      var h = helpers[0];
      for (var i = 1; i < helpers.length; i++) if (helpers[i].inflight < h.inflight) h = helpers[i];
      var b = rd.queue.shift();
      h.inflight++;
      var meta = b.meta.slice(0, b.n * 3), data = b.data.slice(0, b.used);
      h.port.postMessage({ type: 'dbatch', gen: b.gen, meta: meta, data: data.buffer }, [meta.buffer, data.buffer]);
    }
  }
  function rdResult(m) {
    var live = rd.chd && m.gen === rd.gen, meta = m.meta, ok = m.ok, out = m.out;
    for (var i = 0; i < ok.length; i++) {
      rd.busy--;
      if (!live) continue;
      var hunk = meta[i * 3];
      var slot = ok[i] ? M._wasm_rd_slot(rd.chd, hunk) : 0;
      if (slot) M.HEAPU8.set(out.subarray(i * rd.hb, (i + 1) * rd.hb), slot);
      M._wasm_rd_done(rd.chd, hunk, slot ? 1 : 0);
    }
  }
  function rdWake() {
    if (rd.waiting) { var w = rd.waiting; rd.waiting = null; wake(w); }
  }
  M.rdSetup = function (chd, hb, ub, comps) {
    if (!helpers.length || rd.chd) return false;
    // the LaserDisc codec (avhu) reads settings from the CHD's own metadata
    if (comps.indexOf(0x61766875) >= 0) return false;
    rd.chd = chd; rd.gen++; rd.hb = hb;
    rd.batch = Math.max(1, Math.min(64, Math.floor((512 * 1024) / hb)));
    helpers.forEach(function (h) { h.port.postMessage({ type: 'dinit', hunkbytes: hb, unitbytes: ub, comps: comps }); });
    postMessage({ type: 'notice', level: 'debug', message: 'multi-core decompression: ' + helpers.length + ' helper threads, batch ' + rd.batch });
    return true;
  };
  M.rdSubmit = function (chd, hunk, codec, ptr, len) {
    if (chd !== rd.chd) return;
    if (!rd.open) rd.open = { gen: rd.gen, n: 0, used: 0, meta: new Uint32Array(3 * rd.batch), data: new Uint8Array(rd.batch * rd.hb) };
    var o = rd.open;
    o.data.set(M.HEAPU8.subarray(ptr, ptr + len), o.used);
    o.meta[o.n * 3] = hunk; o.meta[o.n * 3 + 1] = codec; o.meta[o.n * 3 + 2] = len;
    o.used += len;
    o.n++;
    rd.busy++;
    if (o.n === rd.batch) rdDispatch();
  };
  M.rdClose = function (chd) {
    if (chd !== rd.chd) return;
    rdFlush();
    rd.queue.forEach(function (b) { rd.busy -= b.n; });
    rd.queue = [];
    rd.chd = 0;
    rd.gen++;
  };
  M.rdBusy = function () { return rd.busy > 0; };
  // chdman paused until hunks it is about to read are in: resolves when more results arrive
  M.rdWait = function () {
    return new Promise(function (resolve) {
      if (failed) {
        postMessage({ type: 'fatal', message: 'Multi-core decompression failed (' + failed + '). Try again with 1 thread in Settings.' });
        return; // never resolves: the job worker is terminated by the page
      }
      rdDispatch();
      rd.waiting = resolve;
      if (!rd.busy) rdWake();
    });
  };
}

/* ---------------- helper role ---------------- */

async function runHelper(msg) {
  await loadModule(msg);
  var M = await instantiate({});
  var port = msg.port;
  var inbuf = 0, outbuf = 0, res = M._malloc(16), sha = M._malloc(32), hb = 0;
  var dinbuf = 0, doutbuf = 0, dhb = 0;
  port.onmessage = function (e) {
    var m = e.data;
    try {
      if (m.type === 'dinit') {
        var dr = M._wasm_helper_dinit(m.hunkbytes, m.unitbytes, m.comps[0], m.comps[1], m.comps[2], m.comps[3]);
        if (dr !== 0) throw new Error('codec init failed (' + dr + ')');
        dinbuf = M._wasm_helper_dinbuf();
        doutbuf = M._wasm_helper_doutbuf();
        dhb = m.hunkbytes;
        return;
      }
      if (m.type === 'dbatch') {
        // a hunk that fails here is decompressed again by the job worker, which reports the error
        var dmeta = m.meta, ddata = new Uint8Array(m.data), dn = dmeta.length / 3;
        var ok = new Uint8Array(dn), dout = new Uint8Array(dn * dhb), doff = 0;
        for (var di = 0; di < dn; di++) {
          var dlen = dmeta[di * 3 + 2];
          M.HEAPU8.set(ddata.subarray(doff, doff + dlen), dinbuf);
          doff += dlen;
          if (M._wasm_helper_decompress(dmeta[di * 3 + 1], dlen) === 0) {
            ok[di] = 1;
            dout.set(M.HEAPU8.subarray(doutbuf, doutbuf + dhb), di * dhb);
          }
        }
        port.postMessage({ type: 'dresult', gen: m.gen, meta: dmeta, ok: ok, out: dout }, [dmeta.buffer, ok.buffer, dout.buffer]);
        return;
      }
      if (m.type === 'init') {
        var r = M._wasm_helper_init(m.hunkbytes, m.unitbytes, m.comps[0], m.comps[1], m.comps[2], m.comps[3], m.flags || 0);
        if (r !== 0) throw new Error('codec init failed (' + r + ')');
        inbuf = M._wasm_helper_inbuf();
        outbuf = M._wasm_helper_outbuf();
        hb = m.hunkbytes;
        return;
      }
      if (m.type === 'batch') {
        var n = m.items.length, data = new Uint8Array(m.data), codecs = m.codecs;
        var meta = new Int32Array(n * 3), sha1 = new Uint8Array(n * 20), parts = [], total = 0;
        for (var i = 0; i < n; i++) {
          M.HEAPU8.set(data.subarray(i * hb, (i + 1) * hb), inbuf);
          var c = M._wasm_helper_compress(res, sha, codecs ? codecs[i] : 15);
          var heap32 = M.HEAPU32, heap8 = M.HEAPU8;
          var len = heap32[res >>> 2], crc = heap32[(res >>> 2) + 1];
          meta[i * 3] = c; meta[i * 3 + 1] = len; meta[i * 3 + 2] = crc;
          sha1.set(heap8.subarray(sha, sha + 20), i * 20);
          parts.push(heap8.slice(outbuf, outbuf + len));
          total += len;
        }
        var out = new Uint8Array(total), o = 0;
        parts.forEach(function (p) { out.set(p, o); o += p.length; });
        port.postMessage({ type: 'result', id: m.id, items: m.items, meta: meta, sha1: sha1, out: out },
          [m.items.buffer, meta.buffer, sha1.buffer, out.buffer]);
      }
    } catch (err) {
      port.postMessage({ type: 'error', message: errText(err) });
    }
  };
  postMessage({ type: 'helper-ready' });
}

/* ---------------- job role ---------------- */

function makeLineSink(stream) {
  var bytes = [];
  var dec = new TextDecoder('utf-8');
  function text() { var t = dec.decode(new Uint8Array(bytes)); bytes = []; return t; }
  return {
    put: function (ch) {
      if (ch === null || ch === undefined) return;
      if (ch < 0) ch += 256;
      if (ch === 10) postMessage({ type: 'line', stream: stream, text: text() });
      else if (ch === 13) { var t = text(); if (t.trim()) postMessage({ type: 'progress', stream: stream, text: t }); }
      else bytes.push(ch);
    },
    flush: function () { if (bytes.length) postMessage({ type: 'line', stream: stream, text: text() }); }
  };
}

// Results streamed into a folder (StreamStore) that the page hasn't written yet: over SINK_MAX, chdman
// pauses (wasm_out_full) until the page's s-ack messages bring it under half of that
var sinkPending = 0, sinkWaiter = null, SINK_MAX = 64 << 20;
function sinkFull() { return sinkPending > SINK_MAX; }
function sinkDrained() {
  return new Promise(function (resolve) { if (sinkPending <= SINK_MAX / 2) resolve(); else sinkWaiter = resolve; });
}
function sinkAck(bytes) {
  sinkPending = Math.max(0, sinkPending - bytes);
  if (sinkWaiter && sinkPending <= SINK_MAX / 2) { var w = sinkWaiter; sinkWaiter = null; w(); }
}

// Runs a chdman command line and resolves with its exit code. A command that compresses with
// helper workers pauses after each step (chdman_begin/chdman_resume return -1) until M.parWait()
// says the next hunk is in, so the worker keeps receiving their results. Extract and verify pause
// the same way while helpers decompress the hunks they are about to read (M.rdWait()).
async function runChdman(M, args) {
  var argv = M._malloc(4 * (args.length + 2));
  ['chdman'].concat(args).forEach(function (a, i) { var p = M.stringToNewUTF8(a); M.HEAPU32[(argv >>> 2) + i] = p; });
  M.HEAPU32[(argv >>> 2) + args.length + 1] = 0;
  var code = M._chdman_begin(args.length + 1, argv);
  while (code === -1) {
    if (sinkFull()) await sinkDrained();
    if (M.rdBusy && M.rdBusy()) await M.rdWait();
    else if (M.parWait) await M.parWait();
    code = M._chdman_resume();
  }
  return code;
}

async function runJob(msg) {
  if (msg.debugSinkMax) SINK_MAX = msg.debugSinkMax; // testing: a small limit
  await loadModule(msg);
  var backing = await makeBacking(msg);
  postMessage({ type: 'storage', mode: backing.mode });

  // copies of inputs chdman must modify in place (verify --fix, addmeta, delmeta)
  var outFiles = [];
  var wl = msg.writable || [];
  for (var wi = 0; wi < wl.length; wi++) {
    var w = wl[wi];
    var store = backing.create(w.name, true), step = 8 << 20;
    for (var pos = 0; pos < w.blob.size; pos += step) {
      var part = w.blob.slice(pos, Math.min(w.blob.size, pos + step)), chunk;
      try { chunk = new Uint8Array(getReader().readAsArrayBuffer(part)); }
      catch (e) { chunk = new Uint8Array(await part.arrayBuffer()); }
      store.write(chunk, pos);
    }
    outFiles.push({ name: w.name, store: store });
  }

  // inputs: read directly when possible, otherwise staged first
  var stages = [], inStores = [];
  var inputs = msg.inputs || [];
  for (var ii = 0; ii < inputs.length; ii++) {
    var bs = new BlobStore(inputs[ii].blob);
    if (msg.debugStage || !storeReadable(bs)) {
      try { bs = await stageInput(msg, ii, stages); }
      catch (e) {
        stages.forEach(function (st) { try { st.slot.handle.close(); } catch (x) { /* ignore */ } });
        await backing.finalize(false);
        var full = e && typeof e.errno === 'number';
        postMessage({ type: 'done', code: -1, readFail: !full, error: full ? 'Could not copy "' + inputs[ii].name + '" to private storage: ' + errText(e) + '.' : 'The browser could not read "' + inputs[ii].name + '": ' + errText(e), outputs: [] });
        return;
      }
    }
    // a CSO/ZSO compressed ISO, or an ECM image: chdman reads what they hold
    if (inputs[ii].ciso || inputs[ii].ecm) {
      var label = inputs[ii].blob.name || inputs[ii].name;
      try { bs = inputs[ii].ciso ? new CisoStore(bs, 0, label) : new EcmStore(bs, label); }
      catch (e) {
        await dropStages();
        await backing.finalize(false);
        postMessage({ type: 'done', code: -1, error: '"' + label + '" could not be read as ' + (inputs[ii].ciso ? 'a compressed ISO' : 'an ECM image') + ': ' + (e && e.message || e), outputs: [] });
        return;
      }
    }
    inStores.push({ name: inputs[ii].name, store: bs });
  }
  async function dropStages() {
    for (var si = 0; si < stages.length; si++) {
      try { stages[si].slot.handle.close(); } catch (e) { /* ignore */ }
      try { await stages[si].dir.removeEntry(stages[si].slot.name); } catch (e) { /* ignore */ }
    }
  }

  var out = makeLineSink(1), err = makeLineSink(2), aborted = null;
  var M = await instantiate({
    stdin: function () { return null; },
    stdout: function (c) { out.put(c); },
    stderr: function (c) { err.put(c); },
    onAbort: function (what) { aborted = 'chdman stopped unexpectedly: ' + what; }
  });

  inStores.forEach(function (st) { if (st.store.setModule) st.store.setModule(M); });
  backing.M = M;
  M.outFull = sinkFull; // wasm_out_full: chdman pauses while a folder is behind
  var FS = M.FS, CHDFS = makeFS(FS);
  FS.mkdir('/in');
  FS.mount(CHDFS, { files: inStores }, '/in');
  FS.mkdir('/out');
  FS.mount(CHDFS, { files: outFiles, backing: backing }, '/out');
  FS.chdir('/out');

  if (msg.ports && msg.ports.length) setupParallel(M, msg.ports);

  var started = performance.now(), code;
  try {
    code = await runChdman(M, msg.args);
    M._fflush(0);
  } catch (e) {
    out.flush(); err.flush();
    await backing.finalize(false);
    await dropStages();
    postMessage({ type: 'done', code: -1, error: aborted || String(e && e.message || e), outputs: [], ms: performance.now() - started });
    return;
  }
  out.flush(); err.flush();
  var flushError = code === 0 ? backing.flush() : null;
  if (flushError) {
    await backing.finalize(false);
    await dropStages();
    postMessage({ type: 'done', code: -1, error: flushError, outputs: [], ms: performance.now() - started });
    return;
  }
  var outputs = await backing.finalize(true);
  await dropStages();
  postMessage({ type: 'done', code: code, outputs: outputs, ms: performance.now() - started },
    []);
}

/* ---------------- game identification helpers ---------------- */

// CHD sector reader: answers {type:'read', id, track, lba} with 2048 bytes of user data
// (msg.ciso: a CSO/ZSO compressed ISO instead, read like a DVD CHD; msg.ecm: ECM images)
async function runReader(msg) {
  await loadModule(msg);
  var M = await instantiate({});
  if (msg.ciso) return runCisoReader(M, msg);
  if (msg.ecm) return runEcmReader(M, msg);
  var FS = M.FS, CHDFS = makeFS(FS);
  FS.mkdir('/in');
  FS.mount(CHDFS, { files: [{ name: msg.name, store: new BlobStore(msg.blob) }].concat((msg.parent ? [{ name: 'parent.chd', store: new BlobStore(msg.parent) }] : [])) }, '/in');
  var path = '/in/' + msg.name, enc = new TextEncoder().encode(path + '\0');
  var pp = M._malloc(enc.length);
  M.HEAPU8.set(enc, pp);
  var kind = M._wasm_probe_open(pp);
  var tracks = [], info = M._malloc(32), buf = M._malloc(2048);
  var n = kind === 1 ? M._wasm_probe_tracks() : 0;
  for (var t = 0; t < n; t++) {
    M._wasm_probe_track_info(t, info);
    var q = info >>> 2, h = M.HEAPU32;
    tracks.push({ type: h[q], frames: h[q + 1], pregap: h[q + 2], datasize: h[q + 3], gdrom: !!h[q + 4] });
  }
  postMessage({ type: 'reader-ready', kind: kind, tracks: tracks, logical: M._wasm_probe_logical() });
  self.onmessage = function (e) {
    var m = e.data;
    if (m.type !== 'read') return;
    var r = -1;
    try { r = M._wasm_probe_read(m.track | 0, m.lba >>> 0, buf); } catch (err) { /* unreadable: null */ }
    postMessage({ type: 'sector', id: m.id, data: r === 0 ? M.HEAPU8.slice(buf, buf + 2048) : null });
  };
}

function runCisoReader(M, msg) {
  var iso = new CisoStore(new BlobStore(msg.blob), 2048);
  iso.setModule(M);
  postMessage({ type: 'reader-ready', kind: 2, tracks: [], logical: iso.sizeV });
  self.onmessage = function (e) {
    var m = e.data, data = null;
    if (m.type !== 'read') return;
    try {
      var b = new Uint8Array(2048);
      if (iso.read(b, m.lba * 2048, 2048) === 2048) data = b;
    } catch (err) { /* unreadable: null */ }
    postMessage({ type: 'sector', id: m.id, data: data });
  };
}

// the CD images in a job's ECM files (msg.ecm): reports their sizes (null: not an ECM image, or
// damaged), then answers {type:'read', id, file, pos, len} with the image's bytes
function runEcmReader(M, msg) {
  var images = msg.ecm.map(function (blob) {
    try {
      var s = new EcmStore(new BlobStore(blob), blob.name);
      s.setModule(M);
      return s;
    } catch (e) { return null; }
  });
  postMessage({ type: 'reader-ready', kind: 3, tracks: [], logical: 0, sizes: images.map(function (s) { return s ? s.sizeV : null; }) });
  self.onmessage = function (e) {
    var m = e.data, data = null;
    if (m.type !== 'read') return;
    try {
      var s = images[m.file], n = Math.max(0, Math.min(m.len, s.sizeV - m.pos)), b = new Uint8Array(n);
      if (s.read(b, m.pos, n) === n) data = b;
    } catch (err) { /* unreadable: null */ }
    postMessage({ type: 'sector', id: m.id, data: data });
  };
}

// CRC-32 of a byte range of a file (slicing-by-8)
var CRC_T = null;
function crcTables() {
  if (CRC_T) return CRC_T;
  CRC_T = new Int32Array(256 * 8);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_T[n] = c;
  }
  for (n = 0; n < 256; n++) {
    c = CRC_T[n];
    for (k = 1; k < 8; k++) { c = CRC_T[c & 255] ^ (c >>> 8); CRC_T[k * 256 + n] = c; }
  }
  return CRC_T;
}
function crcUpdate(crc, b) {
  var T = crcTables(), i = 0, n = b.length;
  var t0 = 0, t1 = 256, t2 = 512, t3 = 768, t4 = 1024, t5 = 1280, t6 = 1536, t7 = 1792;
  for (; i + 8 <= n; i += 8) {
    var a = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) ^ crc;
    crc = T[t7 + (a & 255)] ^ T[t6 + ((a >>> 8) & 255)] ^ T[t5 + ((a >>> 16) & 255)] ^ T[t4 + (a >>> 24)] ^
      T[t3 + b[i + 4]] ^ T[t2 + b[i + 5]] ^ T[t1 + b[i + 6]] ^ T[t0 + b[i + 7]];
  }
  for (; i < n; i++) crc = T[(crc ^ b[i]) & 255] ^ (crc >>> 8);
  return crc;
}
async function runCrc(msg) {
  var blob = msg.blob, start = msg.start || 0, end = msg.end != null ? msg.end : blob.size;
  var step = 8 << 20, r = getReader(), last = 0;
  // zlib's crc32 in WebAssembly is several times faster than the JavaScript loop below it
  var M = null, buf = 0, iso = null;
  if (msg.wasmModule || msg.wasmBytes) {
    try {
      await loadModule(msg);
      M = await instantiate({});
      if (typeof M._crc32 === 'function') buf = M._malloc(step); else M = null;
    } catch (e) { M = null; }
  }
  // msg.ciso: the checksum of the ISO inside a CSO/ZSO image, which needs the module's inflate;
  // msg.ecm: of the CD image inside an ECM file (and that image's EDC is checked)
  if (msg.ciso || msg.ecm) {
    if (!M) throw new Error('cannot decompress');
    iso = msg.ciso ? new CisoStore(new BlobStore(blob)) : new EcmStore(new BlobStore(blob), blob.name);
    iso.setModule(M);
    if (msg.end == null) end = iso.sizeV;
  }
  var crc = M ? 0 : -1;
  for (var pos = start; pos < end; pos += step) {
    var n = Math.min(end, pos + step) - pos;
    if (iso) {
      if (iso.read(M.HEAPU8.subarray(buf, buf + n), pos, n) !== n) throw new Error('truncated image');
      crc = M._crc32(crc, buf, n) >>> 0;
    } else {
      var chunk = new Uint8Array(r.readAsArrayBuffer(blob.slice(pos, pos + n)));
      if (M) { M.HEAPU8.set(chunk, buf); crc = M._crc32(crc, buf, chunk.length) >>> 0; }
      else crc = crcUpdate(crc, chunk);
    }
    var now = Date.now();
    if (now - last > 250) { last = now; postMessage({ type: 'crc-progress', done: pos - start, total: end - start }); }
  }
  crc = M ? crc >>> 0 : (crc ^ -1) >>> 0;
  postMessage({ type: 'crc', crc: ('00000000' + crc.toString(16).toUpperCase()).slice(-8) });
}

self.addEventListener('error', function (e) {
  if (e && e.error && e.error.name === 'ExitStatus') { e.preventDefault(); }
});
self.addEventListener('unhandledrejection', function (e) {
  if (e && e.reason && e.reason.name === 'ExitStatus') { e.preventDefault(); }
});

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'stage-chunk' && stageWaiter) {
    try {
      stageWaiter.dst.write(new Uint8Array(msg.data), msg.pos);
      stageWaiter.onChunk(msg.pos + msg.data.byteLength);
      postMessage({ type: 'stage-ack' });
    } catch (err) { stageWaiter.reject(err && typeof err.errno === 'number' ? err : new Error('could not store the copy (' + (err && err.name || err) + ')')); }
    return;
  }
  if (msg.type === 's-ack') { sinkAck(msg.bytes); return; }
  if (msg.type === 'stage-end' && stageWaiter) { stageWaiter.resolve(); return; }
  if (msg.type === 'stage-fail' && stageWaiter) { stageWaiter.reject(new Error(msg.message)); return; }
  if (msg.type === 'crc') { runCrc(msg).catch(function (err) { postMessage({ type: 'fatal', message: errText(err) }); }); return; }
  var p = msg.type === 'helper' ? runHelper(msg) : msg.type === 'run' ? runJob(msg) : msg.type === 'reader' ? runReader(msg) : null;
  if (p) p.catch(function (err) { postMessage({ type: 'fatal', message: err && typeof err.errno === 'number' ? errText(err) : String(err && err.stack || err && err.message || err) }); });
};
