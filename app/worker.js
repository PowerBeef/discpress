/* chdman web worker: runs one chdman command (role "job"), or compresses and decompresses
   hunks for another worker (role "helper"). Appended after the Emscripten glue (createChdman). */
'use strict';

var ERR = { ENOENT: 44, EPERM: 63, EIO: 29, EINVAL: 28, EEXIST: 20, ENOTEMPTY: 55, ENOSPC: 51, EISDIR: 31 };
var S_IFDIR = 0o040000, S_IFREG = 0o100000;
var DIR_MODE = S_IFDIR | 0o777, FILE_MODE = S_IFREG | 0o777, RO_FILE_MODE = S_IFREG | 0o555;
var BLOCK = 1 << 20;
// an error for people: the stores throw {errno} objects, which print as "[object Object]"
function errText(err) {
  if (err && typeof err.errno === 'number') {
    return err.errno === ERR.ENOSPC ? 'the browser\u2019s storage is full. Free some space, or delete earlier results (Settings \u2192 Free temporary storage), and try again'
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
  return new Promise(function (resolve, reject) {
    var opts = {
      noInitialRun: true,
      instantiateWasm: function (imports, receive) {
        WebAssembly.instantiate(wasmModule, imports).then(function (inst) { receive(inst, wasmModule); },
          function (err) { reject(new Error('Could not start WebAssembly: ' + err)); });
        return {};
      },
      locateFile: function (p) { return p; },
      print: function () {},
      printErr: function () {}
    };
    for (var k in extra) opts[k] = extra[k];
    createChdman(opts).then(resolve, reject);
  });
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
var zeroBlock = null;
MemStore.prototype.toBlob = function () {
  var parts = [], remaining = this.sizeV;
  for (var i = 0; remaining > 0; i++) {
    var n = Math.min(BLOCK, remaining);
    var c = this.chunks[i];
    if (!c) {
      if (!zeroBlock) zeroBlock = new Uint8Array(BLOCK);
      c = zeroBlock;
    }
    parts.push(n === BLOCK ? c : c.subarray(0, n));
    remaining -= n;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
};

// Virtual zero-filled file of arbitrary length (zero RAM): used for materialized PREGAP/POSTGAP
// and PC multi-session lead-out repairs without copying or allocating buffers.
function ZeroStore(size) {
  this.sizeV = Math.max(0, size || 0);
  this.readonly = true;
}
ZeroStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  dst.fill(0, 0, len);
  return len;
};

// Virtual concatenation of { store, start, len } slices (including ZeroStore, BlobStore,
// OpfsStore, EcmStore, PbpStore) with zero copying or temporary files.
function ConcatStore(parts) {
  this.rawParts = parts || [];
  this.parts = [];
  this.readonly = true;
  this.sizeV = 0;
  this.last = 0;
  this.rebuild();
}
ConcatStore.prototype.rebuild = function () {
  this.parts = [];
  var off = 0;
  for (var i = 0; i < this.rawParts.length; i++) {
    var p = this.rawParts[i];
    if (!p || !p.store) continue;
    var st = p.start || 0;
    var ln = p.autoLen ? Math.max(0, p.store.sizeV - st) : (p.len || 0);
    if (!(ln > 0)) continue;
    this.parts.push({ store: p.store, start: st, len: ln, off: off });
    off += ln;
  }
  this.sizeV = off;
  this.last = 0;
};
ConcatStore.prototype.setModule = function () {
  this.rebuild();
};
ConcatStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  var done = 0, parts = this.parts, idx = this.last;
  if (idx >= parts.length || pos < parts[idx].off || pos >= parts[idx].off + parts[idx].len) {
    var lo = 0, hi = parts.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (parts[mid].off <= pos) lo = mid; else hi = mid - 1;
    }
    idx = lo;
  }
  while (done < len && idx < parts.length) {
    var p = parts[idx], rel = (pos + done) - p.off;
    if (rel >= p.len) { idx++; continue; }
    var want = Math.min(len - done, p.len - rel);
    var got = p.store.read(dst.subarray(done, done + want), p.start + rel, want);
    if (got <= 0) break;
    done += got;
    if (rel + got >= p.len) idx++;
  }
  this.last = Math.min(idx, Math.max(0, parts.length - 1));
  return done;
};

// Virtual sector-strided slice of a disc image (Alcohol 120% .mdf, DiscJuggler .cdi, or
// CloneCD .img + planar .sub transposed to bit-interleaved 96-byte RW_RAW subchannels).
function StrideSliceStore(base, offset, count, dataSize, stride, subStore, subOffset) {
  this.base = base;
  this.offset = offset || 0;
  this.count = count || 0;
  this.dataSize = dataSize || 2352;
  this.stride = stride || this.dataSize;
  this.subStore = subStore || null;
  this.subOffset = subOffset || 0;
  this.outSec = this.subStore ? (this.dataSize + 96) : this.dataSize;
  this.sizeV = this.count * this.outSec;
  this.readonly = true;
  this.chunkSecs = 256;
  this.cache = null;
}
StrideSliceStore.prototype.transposePlanarSub = function (src, sOff, dst, dOff) {
  for (var s = 0; s < 96; s++) {
    var bi = s >> 3, sh = 7 - (s & 7), v = 0;
    if ((src[sOff + bi] >>> sh) & 1) v |= 0x80;
    if ((src[sOff + 12 + bi] >>> sh) & 1) v |= 0x40;
    if ((src[sOff + 24 + bi] >>> sh) & 1) v |= 0x20;
    if ((src[sOff + 36 + bi] >>> sh) & 1) v |= 0x10;
    if ((src[sOff + 48 + bi] >>> sh) & 1) v |= 0x08;
    if ((src[sOff + 60 + bi] >>> sh) & 1) v |= 0x04;
    if ((src[sOff + 72 + bi] >>> sh) & 1) v |= 0x02;
    if ((src[sOff + 84 + bi] >>> sh) & 1) v |= 0x01;
    dst[dOff + s] = v;
  }
};
StrideSliceStore.prototype.chunk = function (ci) {
  if (this.cache && this.cache.ci === ci) return this.cache.data;
  var first = ci * this.chunkSecs;
  var n = Math.min(this.chunkSecs, this.count - first);
  var out = new Uint8Array(n * this.outSec);
  var raw = new Uint8Array(n * this.stride);
  var got = this.base.read(raw, this.offset + first * this.stride, raw.length);
  var subRaw = null;
  if (this.subStore) {
    subRaw = new Uint8Array(n * 96);
    this.subStore.read(subRaw, this.subOffset + first * 96, subRaw.length);
  }
  for (var i = 0; i < n; i++) {
    var rOff = i * this.stride, oOff = i * this.outSec;
    if (rOff + this.dataSize <= got) out.set(raw.subarray(rOff, rOff + this.dataSize), oOff);
    else if (rOff < got) out.set(raw.subarray(rOff, got), oOff);
    if (subRaw) this.transposePlanarSub(subRaw, i * 96, out, oOff + this.dataSize);
  }
  this.cache = { ci: ci, data: out };
  return out;
};
StrideSliceStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  if (!this.subStore && this.stride === this.dataSize) {
    return this.base.read(dst, this.offset + pos, len);
  }
  var done = 0, span = this.chunkSecs * this.outSec;
  while (done < len) {
    var p = pos + done, ci = Math.floor(p / span), data = this.chunk(ci), off = p - ci * span;
    var n = Math.min(len - done, data.length - off);
    if (n <= 0) break;
    dst.set(data.subarray(off, off + n), done);
    done += n;
  }
  return done;
};
StrideSliceStore.prototype.free = function () { this.cache = null; };

// Windowed on-demand Red Book 44.1 kHz 16-bit LE stereo PCM decoder backed by wasm/audio.cpp
// (FLAC, extended WAV/RF64, AIFF/AIFC, Ogg Vorbis, MP3). Exact 2,352-byte sector boundary padding.
var AUD_WIN = 112 * 2352; // 263,424 bytes = 65,856 stereo frames (~1.5 s)
var audSeq = 0;
function ensureAudMount(M) {
  if (M._audRoot) return M._audRoot;
  var chdfs = makeFS(M.FS);
  try { M.FS.mkdir('/aud'); } catch (e) { /* already exists */ }
  M.FS.mount(chdfs, { files: [] }, '/aud');
  M._audRoot = M.FS.lookupPath('/aud').node;
  M._audCHDFS = chdfs;
  return M._audRoot;
}
function AudioStore(base, label) {
  this.base = base;
  this.label = label || 'audio track';
  this.sizeV = 0;
  this.readonly = true;
  this.M = null;
  this.handle = 0;
  this.buf = 0;
  this.audKey = '';
  this.audInfo = null;
  this.windows = [];
}
AudioStore.prototype.setModule = function (M) {
  this.M = M;
  var root = ensureAudMount(M);
  this.audKey = 'a' + (++audSeq) + '.aud';
  M._audCHDFS.createNode(root, this.audKey, RO_FILE_MODE, this.base);
  var path = '/aud/' + this.audKey;
  var pPath = M.stringToNewUTF8(path);
  var pInfo = wasmAlloc(M, 32);
  var h = M._wasm_aud_open(pPath, pInfo);
  M._free(pPath);
  if (h <= 0) {
    M._free(pInfo);
    delete root.contents[this.audKey];
    this.audKey = '';
    throw new Error('"' + this.label + '" could not be decoded as a supported audio track.');
  }
  var q = pInfo >>> 2, hu = M.HEAPU32;
  var framesPad = hu[q + 1] + hu[q + 2] * 4294967296;
  this.audInfo = {
    fmt: hu[q],
    framesPad: framesPad,
    origRate: hu[q + 3],
    origCh: hu[q + 4],
    origBits: hu[q + 5],
    isLossy: !!hu[q + 6]
  };
  M._free(pInfo);
  this.handle = h;
  this.sizeV = framesPad * 4;
  this.buf = wasmAlloc(M, AUD_WIN);
  this.windows = [];
};
AudioStore.prototype.free = function () {
  if (this.M) {
    if (this.handle) { this.M._wasm_aud_close(this.handle); this.handle = 0; }
    if (this.buf) { this.M._free(this.buf); this.buf = 0; }
    if (this.audKey && this.M._audRoot) { delete this.M._audRoot.contents[this.audKey]; this.audKey = ''; }
  }
  this.windows = [];
};
AudioStore.prototype.window = function (w) {
  for (var i = 0; i < this.windows.length; i++) if (this.windows[i].w === w) return this.windows[i].data;
  var M = this.M, bytePos = w * AUD_WIN;
  var want = Math.min(AUD_WIN, this.sizeV - bytePos);
  if (want <= 0 || !M || !this.handle) return new Uint8Array(0);
  var framePos = Math.floor(bytePos / 4);
  var got = M._wasm_aud_read(this.handle, framePos >>> 0, Math.floor(framePos / 4294967296) >>> 0, this.buf, want);
  if (got < 0) throw { errno: ERR.EIO };
  var data = M.HEAPU8.slice(this.buf, this.buf + got);
  this.windows = [{ w: w, data: data }].concat(this.windows.slice(0, 1));
  return data;
};
AudioStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  var M = this.M, heap = M && dst.buffer === M.HEAPU8.buffer, addr = dst.byteOffset, done = 0, parts = [];
  while (done < len) {
    var p = pos + done, w = Math.floor(p / AUD_WIN), data = this.window(w), off = p - w * AUD_WIN;
    var n = Math.min(len - done, data.length - off);
    if (n <= 0) break;
    parts.push({ data: data, off: off, n: n, at: done });
    done += n;
  }
  if (heap && dst.byteLength === 0) dst = M.HEAPU8.subarray(addr, addr + len);
  parts.forEach(function (q) { dst.set(q.data.subarray(q.off, q.off + q.n), q.at); });
  return done;
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
  if (h[21] > 20) throw new Error('unusual CSO alignment ' + h[21]);
  if (!Number.isSafeInteger(this.sizeV)) throw new Error('unusual CSO image size');
  this.shift = Math.pow(2, h[21]);
  if (!this.bs || this.bs > (1 << 24) || this.bs % 2048) throw new Error('unusual CSO block size ' + this.bs);
  this.nblocks = Math.ceil(this.sizeV / this.bs);
  // (an index longer than the file, from a damaged header, isn't allocated: it can't be read anyway)
  if (base.sizeV != null && 24 + (this.nblocks + 1) * 4 > base.sizeV) throw new Error('truncated CSO index');
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
// the module's memory for n bytes; a failure (the page's memory exhausted) stops the job with a message
// rather than let it write through a null pointer. (Pointers from the module are used as they come,
// signed: right while its memory can't grow past 2 GB, MAXIMUM_MEMORY in wasm/link.sh)
function wasmAlloc(M, n) {
  var p = M._malloc(n);
  if (!p) throw new Error('Out of memory: the browser gave this job no more memory. Close other tabs and try again.');
  return p;
}
CisoStore.prototype.setModule = function (M) {
  this.M = M;
  this.srcCap = this.bs + 64;
  this.src = wasmAlloc(M, this.srcCap);
  this.dst = wasmAlloc(M, this.bs);
};
CisoStore.prototype.free = function () {
  if (this.M) {
    if (this.src) { this.M._free(this.src); this.src = 0; }
    if (this.dst) { this.M._free(this.dst); this.dst = 0; }
  }
  this.srcCap = 0;
  this.chunks = [];
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
  // aligned CSOs may omit trailing EOF alignment padding on the last block
  if (last === this.nblocks && this.base.sizeV != null && end > this.base.sizeV && end - this.base.sizeV < this.shift) end = this.base.sizeV;
  // blocks are at most a little larger than block_size (padding; deflate's worst case), unless damaged
  if (!(end >= b0.start && end - b0.start <= (last - first) * (2 * this.bs + this.shift) + 4096)) throw this.damaged(first);
  var stored = new Uint8Array(end - b0.start), got = this.base.read(stored, b0.start, stored.length);
  var bs = this.bs, out = new Uint8Array((last - first) * bs), M = this.M;
  for (var b = first; b < last; b++) {
    var blk = this.block(b), at = blk.start - b0.start, want = Math.min(bs, this.sizeV - b * bs), o = (b - first) * bs;
    var blen = blk.len;
    if (b === this.nblocks - 1 && blen > got - at && blen - (got - at) < this.shift) blen = got - at;
    if (!(blen >= 0 && at >= 0 && at + blen <= got)) throw this.damaged(b);
    if (blk.how === 0) {
      if (blen < want) throw this.damaged(b);
      out.set(stored.subarray(at, at + want), o);
    } else if (blk.how === 2) {
      if (M && M._wasm_lz4_block) {
        if (blen > this.srcCap || !this.src) {
          if (this.src) M._free(this.src);
          this.src = 0; this.srcCap = 0;
          this.src = wasmAlloc(M, blen);
          this.srcCap = blen;
        }
        M.HEAPU8.set(stored.subarray(at, at + blen), this.src);
        if (M._wasm_lz4_block(this.src, blen, this.dst, want) !== want) throw this.damaged(b);
        out.set(M.HEAPU8.subarray(this.dst, this.dst + want), o);
      } else {
        if (lz4Block(stored, at, at + blen, out, o, want) !== want) throw this.damaged(b);
      }
    } else {
      if (!M) throw this.damaged(b);
      if (blen > this.srcCap || !this.src) {
        if (this.src) M._free(this.src);
        this.src = 0;
        this.srcCap = 0;
        this.src = wasmAlloc(M, blen);
        this.srcCap = blen;
      }
      M.HEAPU8.set(stored.subarray(at, at + blen), this.src);
      if (M._wasm_inflate_raw(this.src, blen, this.dst, want) !== want) throw this.damaged(b);
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

// A disc in a PS1 EBOOT.PBP (popstation's format; the page reads its TOC, sniffPbp), read as the raw CD
// image it packs: from track 1's INDEX 01, 2,352-byte sectors in blocks of 16, each deflated, or
// stored as it is when that isn't smaller. The disc's header (PSISOIMG0000, at `pbp.at`) holds the
// offset of its blocks at 0xBFC and their table at 0x4000: per block its offset from there and its
// stored size, 32 bytes apart. `pbp.sectors`: the image's length, from the TOC.
var PBP_BLOCK = 16 * 2352, PBP_TABLE = 0x4000, PBP_BLOCKS = 32256;
function PbpStore(base, pbp, label) {
  var head = new Uint8Array(0xC00), dv = new DataView(head.buffer);
  if (base.read(head, pbp.at, head.length) !== head.length || String.fromCharCode.apply(null, head.subarray(0, 12)) !== 'PSISOIMG0000') throw new Error('not a PS1 disc image');
  if (dv.getUint32(0x400, true) === 0x44475000) throw new Error('encrypted');
  this.base = base;
  this.sizeV = pbp.sectors * 2352;
  this.nblocks = Math.ceil(this.sizeV / PBP_BLOCK);
  if (!this.nblocks || this.nblocks > PBP_BLOCKS) throw new Error('unusual image size');
  var raw = new Uint8Array(this.nblocks * 32), tv = new DataView(raw.buffer);
  if (base.read(raw, pbp.at + PBP_TABLE, raw.length) !== raw.length) throw new Error('truncated block table');
  var from = pbp.at + dv.getUint32(0xBFC, true);
  this.blocks = [];
  for (var b = 0; b < this.nblocks; b++) this.blocks.push({ start: from + tv.getUint32(b * 32, true), len: tv.getUint16(b * 32 + 4, true) });
  this.readonly = true;
  this.cache = [];
  this.M = null;
  this.label = label || 'the PBP file';
  this.reported = false;
}
PbpStore.prototype.damaged = CisoStore.prototype.damaged;
PbpStore.prototype.setModule = function (M) {
  this.M = M;
  this.src = wasmAlloc(M, PBP_BLOCK + 64);
  this.dst = wasmAlloc(M, PBP_BLOCK);
};
PbpStore.prototype.free = function () {
  if (this.M) {
    if (this.src) { this.M._free(this.src); this.src = 0; }
    if (this.dst) { this.M._free(this.dst); this.dst = 0; }
  }
  this.cache = [];
  this.rbuf = null;
};
PbpStore.prototype.readBase = function (dst, pos, len) {
  if (this.base instanceof BlobStore) return this.base.read(dst, pos, len);
  // buffer 1 MiB at a time when staged in OPFS/MemStore so 37 KiB blocks don't each incur a sync-handle read
  if (!this.rbuf) { this.rbuf = new Uint8Array(BLOCK); this.rpos = -1; this.rlen = 0; }
  if (len > BLOCK) return this.base.read(dst, pos, len);
  if (pos < this.rpos || pos + len > this.rpos + this.rlen) {
    this.rpos = pos;
    this.rlen = this.base.read(this.rbuf, pos, BLOCK);
  }
  var n = Math.min(len, Math.max(0, this.rpos + this.rlen - pos));
  if (n > 0) dst.set(this.rbuf.subarray(pos - this.rpos, pos - this.rpos + n), 0);
  return n;
};
PbpStore.prototype.block = function (b) {
  for (var i = 0; i < this.cache.length; i++) if (this.cache[i].b === b) return this.cache[i].data;
  var blk = this.blocks[b], want = Math.min(PBP_BLOCK, this.sizeV - b * PBP_BLOCK), M = this.M;
  if (!blk || !blk.len || blk.len > PBP_BLOCK) throw this.damaged(b);
  var stored = new Uint8Array(blk.len);
  if (this.readBase(stored, blk.start, blk.len) !== blk.len) throw this.damaged(b);
  var out;
  if (blk.len === PBP_BLOCK) out = stored.subarray(0, want);
  else {
    if (!M) throw this.damaged(b);
    M.HEAPU8.set(stored, this.src);
    if (M._wasm_inflate_raw(this.src, blk.len, this.dst, want) !== want) throw this.damaged(b);
    out = M.HEAPU8.slice(this.dst, this.dst + want);
  }
  this.cache = [{ b: b, data: out }].concat(this.cache.slice(0, 1));
  return out;
};
PbpStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  var M = this.M, heap = M && dst.buffer === M.HEAPU8.buffer, addr = dst.byteOffset, done = 0, parts = [];
  while (done < len) {
    var p = pos + done, b = Math.floor(p / PBP_BLOCK), data = this.block(b), off = p - b * PBP_BLOCK;
    var n = Math.min(len - done, data.length - off);
    if (n <= 0) break;
    parts.push({ data: data, off: off, n: n, at: done });
    done += n;
  }
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
  // the scan reads the whole file when its chunks are short: the page shows how far it got (every 1%, from 8 MB)
  var step = Math.max(size / 100, 8 << 20), report = step;
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
    if (pos >= report) { report = pos + step; postMessage({ type: 'scan', done: pos, total: size }); }
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
  this.edcHist = [{ at: 0, edc: 0 }];
}
EcmStore.prototype.edcAtOrBefore = function (limit) {
  var best = { at: 0, edc: 0 };
  for (var i = 0; i < this.edcHist.length; i++) {
    if (this.edcHist[i].at <= limit && this.edcHist[i].at >= best.at) best = this.edcHist[i];
  }
  return best;
};
EcmStore.prototype.restoreEdc = function (st) {
  if (st && typeof st.at === 'number' && st.at >= 0) {
    this.edcAt = st.at;
    this.edc = st.edc >>> 0;
    this.edcHist = [{ at: this.edcAt, edc: this.edc }];
  }
};
EcmStore.prototype.damaged = function (o, why) {
  if (!this.reported) {
    this.reported = true;
    postMessage({ type: 'notice', level: 'error', message: '"' + this.label + '" is damaged: ' + (why || 'the image it holds could not be rebuilt at byte ' + o + '.') });
  }
  return { errno: ERR.EIO };
};
EcmStore.prototype.setModule = function (M) {
  this.M = M;
  // share one growable scratch buffer pair across all ECM tracks in this WASM instance
  var sc = M._ecmScratch || (M._ecmScratch = { src: 0, srcCap: 0, dst: 0, dstCap: 0 });
  var needIn = Math.max(1, this.maxIn), needOut = Math.max(1, this.maxOut);
  if (needIn > sc.srcCap) {
    if (sc.src) M._free(sc.src);
    sc.src = 0; sc.srcCap = 0;
    sc.src = wasmAlloc(M, needIn);
    sc.srcCap = needIn;
  }
  if (needOut > sc.dstCap) {
    if (sc.dst) M._free(sc.dst);
    sc.dst = 0; sc.dstCap = 0;
    sc.dst = wasmAlloc(M, needOut);
    sc.dstCap = needOut;
  }
  this.scratch = sc;
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
  // an image whose checksum didn't match stays damaged: read again, it doesn't give its data
  if (this.bad) throw this.damaged(0);
  for (var i = 0; i < this.windows.length; i++) if (this.windows[i].w === w) return this.windows[i].data;
  var M = this.M, cp = this.cp, inLen = cp.inp[w + 1] - cp.inp[w], outLen = cp.out[w + 1] - cp.out[w];
  if (!M || !this.scratch) throw this.damaged(cp.out[w]);
  var src = this.scratch.src, dst = this.scratch.dst;
  if (this.base.read(M.HEAPU8.subarray(src, src + inLen), cp.inp[w], inLen) !== inLen) throw this.damaged(cp.out[w]);
  if (M._wasm_ecm_decode(src, inLen, dst, outLen, cp.type[w], cp.left[w]) !== inLen) throw this.damaged(cp.out[w]);
  if (cp.out[w] === this.edcAt) {
    this.edc = M._wasm_ecm_edc(this.edc, dst, outLen) >>> 0;
    this.edcAt += outLen;
    this.edcHist.push({ at: this.edcAt, edc: this.edc });
    if (this.edcHist.length > 16) this.edcHist.shift();
    if (this.edcAt === this.sizeV && this.edc !== this.edcWant) { this.bad = true; throw this.damaged(0, 'the image rebuilt from it doesn’t match the checksum it ends with.'); }
  }
  var data = M.HEAPU8.slice(dst, dst + outLen);
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
    if (n === 15) {
      var b;
      do {
        if (i >= to) return -1;
        b = src[i++];
        n += b;
      } while (b === 255);
    }
    if (i + n > to) return -1;
    var lit = Math.min(n, end - o);
    out.set(src.subarray(i, i + lit), o);
    i += n; o += lit;
    if (i >= to || o >= end) break; // the last sequence has only literals
    if (i + 2 > to) return -1;
    var off = src[i] | (src[i + 1] << 8);
    i += 2;
    var m = (token & 15) + 4;
    if ((token & 15) === 15) {
      var c;
      do {
        if (i >= to) return -1;
        c = src[i++];
        m += c;
      } while (c === 255);
    }
    if (!off || off > o - start) return -1; // invalid back-reference
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
function OpfsStore(slot, preserveOnInit) {
  this.slot = slot;
  this.h = slot.handle;
  this.sizeV = 0;
  this.bufs = [];
  this.tick = 0;
  this.preserveOnInit = !!preserveOnInit;
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
  this.put(b.data.subarray(0, b.len), b.pos);
  b.len = 0;
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
  var n;
  // (the browser's own error, a DOMException, as the file system's: chdman reports a read error)
  try { n = this.h.read(dst.subarray(0, len), { at: pos }); }
  catch (e) {
    postMessage({ type: 'notice', level: 'error', message: 'The browser could not read back "' + this.name + '" from its storage (' + (e && e.name || e) + ').' });
    throw { errno: ERR.EIO };
  }
  // below the file's size, a part never written (past the end of what's on disk) reads as zeros, as in POSIX
  if (n < len) dst.fill(0, n, len);
  return len;
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
      if (!b && this.bufs.length < NBUF) {
        var mem;
        try { mem = new Uint8Array(WBUF); }
        catch (e) { throw { errno: ERR.ENOSPC }; }
        this.bufs.push(b = { pos: 0, len: 0, tick: 0, data: mem });
      }
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
  if (this.preserveOnInit && n === 0) {
    this.bufs = [];
    this.sizeV = 0;
    return;
  }
  for (var i = 0; i < this.bufs.length; i++) {
    var b = this.bufs[i];
    if (!b.len) continue;
    if (b.pos >= n) b.len = 0;
    else if (b.pos + b.len > n) b.len = n - b.pos;
  }
  if (n > 0) this.flush();
  try { this.h.truncate(n); }
  catch (e) { throw { errno: e && e.name === 'QuotaExceededError' ? ERR.ENOSPC : ERR.EIO }; }
  this.sizeV = n;
};
OpfsStore.prototype.discard = function () {
  this.bufs = [];
  if (lastWriter === this) lastWriter = null;
  try { this.h.truncate(0); } catch (e) { /* ignore */ }
  this.sizeV = 0;
};

/* Stream store: results go straight to a folder the user picked. The page writes
   the chunks to disk; only the first few MB (headers, metadata) stay readable here. */
var PIN = 8, PIN_MAX = 64;
var streamSeq = 0;
function StreamStore(name) {
  this.id = ++streamSeq;
  this.chunks = [];
  this.flushed = [];
  this.sizeV = 0;
  this.scanned = 0;
  this.pin = PIN;
  postMessage({ type: 's-open', id: this.id, name: name });
}
StreamStore.prototype.checkPin = function () {
  var c0 = this.chunks[0];
  if (!c0 || this.sizeV < 64) return;
  // Uncompressed CHD v5 keeps a 4-byte map entry per hunk at mapoffset, plus metadata right after it:
  // pin the map region (up to 64 MiB) so large uncompressed DVDs don't thrash 4-byte disk writes or fail metadata reads.
  if (c0[0] !== 0x4d || c0[1] !== 0x43 || c0[2] !== 0x6f || c0[3] !== 0x6d ||
      c0[4] !== 0x70 || c0[5] !== 0x72 || c0[6] !== 0x48 || c0[7] !== 0x44) return;
  var dv = new DataView(c0.buffer, c0.byteOffset, 64);
  if (dv.getUint32(8, false) !== 124 || dv.getUint32(12, false) !== 5) return;
  if (dv.getUint32(16, false) || dv.getUint32(20, false) || dv.getUint32(24, false) || dv.getUint32(28, false)) return;
  var logical = dv.getUint32(32, false) * 4294967296 + dv.getUint32(36, false);
  var mapOff = dv.getUint32(40, false) * 4294967296 + dv.getUint32(44, false);
  var hb = dv.getUint32(56, false);
  if (!hb || !logical) return;
  var mapEnd = mapOff + Math.ceil(logical / hb) * 4 + 65536;
  var want = Math.min(PIN_MAX, Math.max(PIN, Math.ceil(mapEnd / BLOCK)));
  if (want > this.pin) this.pin = want;
};
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
  var len = src.length, done = 0, touched0 = false;
  while (done < len) {
    var p = pos + done, ci = Math.floor(p / BLOCK), off = p - ci * BLOCK;
    var n = Math.min(len - done, BLOCK - off);
    if (this.flushed[ci]) {
      // region already on disk: forward a positional write
      var slice = src.slice(done, done + n);
      sinkPending += n;
      postMessage({ type: 's-write', id: this.id, pos: p, data: slice }, [slice.buffer]);
    } else {
      var c = this.chunks[ci];
      if (!c) {
        try { c = this.chunks[ci] = new Uint8Array(BLOCK); }
        catch (e) { throw { errno: ERR.ENOSPC }; }
      }
      c.set(src.subarray(done, done + n), off);
      if (ci === 0) touched0 = true;
      if (ci >= this.pin && ci < this.scanned) this.scanned = ci;
    }
    done += n;
  }
  if (pos + len > this.sizeV) this.sizeV = pos + len;
  if (touched0 && this.pin === PIN) this.checkPin();
  // hand finished chunks (well behind the write position) to the page
  var upto = Math.floor(pos / BLOCK) - 1;
  for (var k = Math.max(this.pin, this.scanned); k < upto; k++) {
    var ch = this.chunks[k];
    if (ch) {
      this.chunks[k] = null;
      this.flushed[k] = true;
      sinkPending += ch.length;
      postMessage({ type: 's-write', id: this.id, pos: k * BLOCK, data: ch }, [ch.buffer]);
    }
  }
  if (upto > this.scanned) this.scanned = upto;
  return len;
};
StreamStore.prototype.truncate = function (n) {
  if (n < this.sizeV) {
    var keep = Math.ceil(n / BLOCK);
    for (var k = keep; k < this.chunks.length; k++) this.chunks[k] = null;
    for (var f = keep; f < this.flushed.length; f++) this.flushed[f] = false;
    this.flushed.length = Math.min(this.flushed.length, keep);
    if (this.scanned > keep) this.scanned = keep;
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
  function findKey(parent, name) {
    if (parent.contents[name]) return name;
    var lower = name.toLowerCase();
    for (var k in parent.contents) if (k.toLowerCase() === lower) return k;
    return null;
  }
  var CHDFS = {
    mount: function (mount) {
      var root = CHDFS.createNode(null, '/', DIR_MODE, null);
      (mount.opts.files || []).forEach(function (f) {
        CHDFS.createNode(root, f.name, f.store && f.store.readonly ? RO_FILE_MODE : FILE_MODE, f.store);
      });
      return root;
    },
    createNode: function (parent, name, mode, store) {
      var node = FS.createNode(parent, name, mode, 0);
      node.node_ops = CHDFS.node_ops;
      node.stream_ops = CHDFS.stream_ops;
      node.atime = node.mtime = node.ctime = Date.now();
      if (FS.isDir(mode)) node.contents = Object.create(null);
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
        var k = findKey(parent, name);
        if (k !== null) return parent.contents[k];
        fail(ERR.ENOENT);
      },
      mknod: function (parent, name, mode, dev) {
        var backing = parent.mount && parent.mount.opts.backing;
        if (!backing) fail(ERR.EPERM);
        if (FS.isDir(mode)) return CHDFS.createNode(parent, name, DIR_MODE, null);
        return CHDFS.createNode(parent, name, FILE_MODE, backing.create(name));
      },
      rename: function (oldNode, newDir, newName) {
        var backing = newDir.mount && newDir.mount.opts.backing;
        if (!backing || (oldNode.store && oldNode.store.readonly)) fail(ERR.EPERM);
        var oldKey = findKey(oldNode.parent, oldNode.name);
        var exKey = findKey(newDir, newName);
        var existing = exKey !== null ? newDir.contents[exKey] : null;
        if (existing && existing !== oldNode) {
          if (FS.isDir(existing.mode) && Object.keys(existing.contents).length) fail(ERR.ENOTEMPTY);
          if (existing.store) {
            if (existing.store.readonly) fail(ERR.EPERM);
            existing.store.deleted = true;
            try { if (existing.store.discard) existing.store.discard(); else existing.store.truncate(0); } catch (e) { /* ignore */ }
          }
          FS.hashRemoveNode(existing);
          delete newDir.contents[exKey];
        }
        if (oldKey !== null) delete oldNode.parent.contents[oldKey];
        newDir.contents[newName] = oldNode;
        oldNode.name = newName;
        if (oldNode.store) oldNode.store.name = newName;
      },
      unlink: function (parent, name) {
        var k = findKey(parent, name);
        var node = k !== null ? parent.contents[k] : null;
        if (node && node.store) {
          if (node.store.readonly) fail(ERR.EPERM);
          node.store.deleted = true;
          try { if (node.store.discard) node.store.discard(); else node.store.truncate(0); } catch (e) { /* ignore */ }
        }
        if (k !== null) delete parent.contents[k];
      },
      rmdir: function (parent, name) {
        var backing = parent.mount && parent.mount.opts.backing;
        if (!backing) fail(ERR.EPERM);
        var k = findKey(parent, name);
        var node = k !== null ? parent.contents[k] : null;
        if (node && Object.keys(node.contents).length) fail(ERR.ENOTEMPTY);
        if (k !== null) delete parent.contents[k];
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

// a file's synchronous access handle. A run started again right after a cancel finds the previous run's
// handles still being released (the browser frees them after the worker that held them is gone): wait
// for them for up to about 3 s rather than fall back to memory
async function openSyncHandle(fh) {
  for (var tries = 0; ; tries++) {
    try { return await fh.createSyncAccessHandle(); }
    catch (e) {
      if (tries >= 15 || !e || (e.name !== 'NoModificationAllowedError' && e.name !== 'InvalidStateError')) throw e;
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }
}
var memReason = '';

async function makeBacking(msg) {
  var registry = [], slots = [], dir = null;
  memReason = '';
  if ((msg.outMode === 'opfs' || (msg.writable && msg.writable.length)) && msg.slots > 0) {
    try {
      // testing: storage that fails, held by another run ('lock') or missing ('other')
      if (msg.debugStorage) throw new DOMException('test', msg.debugStorage === 'lock' ? 'NoModificationAllowedError' : 'NotSupportedError');
      dir = await navigator.storage.getDirectory();
      var path = msg.dirPath || ['chdman-work', msg.jobId];
      for (var pi = 0; pi < path.length; pi++) dir = await dir.getDirectoryHandle(path[pi], { create: true });
      for (var i = 0; i < msg.slots; i++) {
        var name = 'slot' + i;
        var fh = await dir.getFileHandle(name, { create: true });
        var handle = await openSyncHandle(fh);
        var preserve = !!(msg.resume && i === 0);
        var probe = preserve ? handle.getSize() : handle.truncate(0);
        if (probe && typeof probe.then === 'function') {
          // early Safari versions only had asynchronous access handles
          try { await probe; await handle.close(); } catch (e) { /* ignore */ }
          throw new Error('synchronous file access is not supported');
        }
        slots.push({ name: name, handle: handle, used: false, store: null, preserveOnInit: preserve });
      }
    } catch (err) {
      slots.forEach(function (s) { try { s.handle.close(); } catch (e) { /* ignore */ } });
      slots = [];
      dir = null;
      memReason = err && err.name || String(err);
      postMessage({ type: 'notice', level: 'info', storage: 'mem', message: 'Disk storage unavailable (' + memReason + '); keeping results in memory.' });
    }
  }
  var streaming = msg.outMode === 'stream', crcOnly = msg.outMode === 'crc';
  var backing = {
    mode: crcOnly ? 'crc' : streaming ? 'stream' : dir ? 'opfs' : 'mem',
    dir: dir,
    slots: slots,
    M: null, // the module, once instantiated (CrcStore uses its crc32)
    create: function (name, writableCopy) {
      var slot = slots.find(function (s) { return !s.used; });
      var store;
      if (crcOnly && !writableCopy) store = new CrcStore(backing);
      else if (streaming && !writableCopy) store = new StreamStore(name);
      else if (slot) { slot.used = true; store = new OpfsStore(slot, slot.preserveOnInit); slot.store = store; }
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
          // (the backing's flush, run before, reported a failed write; this one only makes it durable)
          try { st.flush(); st.h.flush(); } catch (e) { postMessage({ type: 'notice', level: 'info', message: 'Storage: ' + st.name + ' could not be flushed (' + (e && e.name || e) + ').' }); }
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
  var h = null;
  try {
    var dir = await navigator.storage.getDirectory();
    var path = msg.dirPath || ['chdman-work', msg.jobId];
    for (var i = 0; i < path.length; i++) dir = await dir.getDirectoryHandle(path[i], { create: true });
    var fname = 'stage-' + stages.length;
    var fh = await dir.getFileHandle(fname, { create: true });
    h = await openSyncHandle(fh);
    var t = h.truncate(0);
    if (t && typeof t.then === 'function') {
      try { await t; await h.close(); } catch (x) { /* ignore */ }
      h = null;
      throw new Error('async handles');
    }
    var slot = { name: fname, handle: h, used: true };
    stages.push({ dir: dir, slot: slot });
    h = null;
    return new OpfsStore(slot);
  } catch (e) {
    if (h) { try { h.close(); } catch (x) { /* ignore */ } }
    return new MemStore();
  }
}

async function stageInput(msg, index, stages) {
  var inp = msg.inputs[index], blob = inp.blob, size = blob.size;
  var dst = await stageTarget(msg, inp.name, stages);
  dst.name = inp.name;
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
    try {
      await new Promise(function (resolve, reject) {
        stageWaiter = { dst: dst, resolve: resolve, reject: reject, size: size, at: pos, onChunk: function (p) { pos = p; prog(); } };
        postMessage({ type: 'stage-request', index: index, from: pos });
      });
    } finally {
      stageWaiter = null;
    }
  }
  if (dst.release) dst.release();
  dst.sizeV = size;
  dst.readonly = true;
  return dst;
}

/* ---------------- multi-core compression and decompression (job side) ---------------- */

function setupParallel(M, ports) {
  // sent/dsent: the batches a helper has and hasn't answered yet, kept until it does. A helper that fails
  // (a WebAssembly trap: some Safari versions' optimizing compiler miscompiles now and then) is dropped,
  // and the others do its batches: compression is deterministic, so the CHD is the same
  var helpers = ports.map(function (port, i) { return { port: port, inflight: 0, id: i, dead: false, sent: {}, dsent: {} }; });
  function liveHelpers() { return helpers.filter(function (h) { return !h.dead; }); }
  var hunkbytes = 0, batchSize = 1, scratch = 0, parComps = [], bufPool = [], open = null, pending = [], fifo = [], done = new Set();
  var sleeper = null, seq = 0, failed = null, closed = false, maxActive = helpers.length;
  M.setThrottle = function (n) { maxActive = Math.max(1, Math.min(helpers.length, n | 0)); };
  var mc = new MessageChannel(), wakeFn = null;
  mc.port1.onmessage = function () { var w = wakeFn; wakeFn = null; if (w) w(); };
  function wake(w) { wakeFn = w; mc.port2.postMessage(0); }
  function takeBuf() {
    if (bufPool.length) return bufPool.pop();
    return new Uint8Array(batchSize * hunkbytes);
  }

  function flushOpen() {
    if (open && open.n) { pending.push(open); }
    open = null;
  }
  function dispatch() {
    flushOpen();
    for (var round = 0; round < 2; round++) {
      var activeSeen = 0;
      for (var i = 0; i < helpers.length && pending.length; i++) {
        var h = helpers[i];
        if (h.dead) continue;
        if (activeSeen++ >= maxActive) break;
        if (h.inflight > round) continue;
        var b = pending.shift(), id = ++seq;
        h.inflight++;
        h.sent[id] = b;
        // Zero-copy ping-pong transfer: b.buf is transferred directly and recycled on reply;
        // if retried after a helper died (b.buf was neutered), refill from chdman's untouched item.m_data.
        var sendBuf = (b.buf && b.buf.buffer.byteLength >= b.n * hunkbytes) ? b.buf : null;
        if (!sendBuf) {
          sendBuf = takeBuf();
          for (var k = 0; k < b.n; k++) sendBuf.set(M.HEAPU8.subarray(b.ptrs[k], b.ptrs[k] + hunkbytes), k * hunkbytes);
        }
        b.buf = null;
        var items = b.items.slice(0, b.n), codecs = b.codecs.slice(0, b.n);
        var ab = sendBuf.buffer;
        h.port.postMessage({ type: 'batch', id: id, items: items, codecs: codecs, data: ab, len: b.n * hunkbytes }, [items.buffer, codecs.buffer, ab]);
      }
    }
  }
  function headDone() {
    while (fifo.length && done.has(fifo[0])) { done.delete(fifo[0]); fifo.shift(); }
  }
  function maybeWake() {
    if (!sleeper) return;
    if (failed) {
      sleeper = null;
      postMessage({ type: 'fatal', engine: true, message: 'Multi-core compression failed (' + failed + ').' });
      return;
    }
    if (fifo.length === 0 || done.has(fifo[0])) {
      headDone();
      var s = sleeper; sleeper = null; wake(s);
    }
  }
  // a helper failed: its unanswered batches go back in the queue for the others; with none left, a
  // compression fails (the page runs the job again once), and the job worker decompresses by itself
  function helperDown(h, message) {
    if (h.dead) return;
    h.dead = true;
    h.inflight = 0;
    var lost = Object.keys(h.sent).map(function (k) { return h.sent[k]; });
    var dlost = Object.keys(h.dsent).map(function (k) { return h.dsent[k]; });
    h.sent = {}; h.dsent = {};
    var left = liveHelpers().length;
    // (compressing, nothing can take new hunks now: the run stops, and the page runs the job again;
    // an extract or verify decompresses by itself instead)
    if (!left && M.parActive) failed = message;
    postMessage({ type: 'notice', level: 'info', message: 'A helper thread stopped (' + message + ')' + (left ? '; the ' + (left === 1 ? 'other took' : left + ' others took') + ' over its work.' : '.') });
    pending = lost.concat(pending);
    rd.queue = dlost.filter(function (b) { return b.gen === rd.gen; }).concat(rd.queue);
    rd.busy -= dlost.filter(function (b) { return b.gen !== rd.gen; }).reduce(function (n, b) { return n + b.n; }, 0);
    if (left) dispatch();
    rdDispatch();
    maybeWake();
    rdWake();
  }
  helpers.forEach(function (h) {
    h.port.onmessage = function (e) {
      var m = e.data;
      // chdman ended (done, or failed): its work items and CHD handles are gone, so nothing more is written to them
      if (closed) return;
      if (m.type === 'error') { helperDown(h, m.message); return; }
      if (h.dead) return; // a result it sent before failing: its batches were given to the others
      if (m.type === 'dresult') {
        var db = h.dsent[m.id];
        if (!db) return; // not a batch this helper has (anything else would be a fault)
        // the batch's own hunks, each a hunk long: anything else would count hunks it never had
        var dm = m.meta, dok = m.ok, dlive = db.gen === rd.gen;
        var dfit = dm && dok && m.gen === db.gen && dm.length === db.n * 3 && dok.length === db.n && (!dlive || (m.out && m.out.length === db.n * rd.hb));
        for (var dq = 0; dfit && dq < db.n; dq++) if (dm[dq * 3] !== db.meta[dq * 3]) dfit = false;
        if (!dfit) { helperDown(h, 'it answered for other hunks'); return; }
        delete h.dsent[m.id];
        h.inflight--;
        rdResult(m);
        rdDispatch();
        rdWake();
        return;
      }
      if (m.type !== 'result') return;
      if (m.recyc && m.recyc.byteLength === batchSize * hunkbytes && bufPool.length < 16) bufPool.push(new Uint8Array(m.recyc));
      // results go into chdman's work items only for the batch this helper was given, item by item:
      // an answer for another batch, or for other items, would write over hunks it doesn't hold. And
      // each as the compressor gives it: a codec slot that was tried, shorter than a hunk; -1 (stored)
      // a whole hunk; -2 (a repeat, compressed by chdman itself) nothing
      var sentB = h.sent[m.id];
      if (!sentB) return;
      var items = m.items, meta = m.meta, sha1 = m.sha1, out = m.out, o = 0;
      var fits = items && meta && sha1 && out && items.length === sentB.n && meta.length === sentB.n * 3 && sha1.length === sentB.n * 20;
      for (var q = 0, total = 0; fits && q < sentB.n; q++) {
        var qc = meta[q * 3], qlen = meta[q * 3 + 1] >>> 0;
        total += qlen;
        var allowQc = qc >= 0 && qc <= 3 && (
          ((sentB.codecs[q] >> qc) & 1) === 1 ||
          ((sentB.codecs[q] & 0x10) !== 0 && parComps[qc] === 0x63647a6c) ||
          ((sentB.codecs[q] & 0x20) !== 0 && parComps[qc] === 0x666c6163)
        );
        fits = items[q] === sentB.items[q] && total <= out.length &&
          (qc === -2 ? qlen === 0 : qc === -1 ? qlen === hunkbytes : allowQc && qlen < hunkbytes);
      }
      if (!fits) { helperDown(h, 'it answered for other hunks, or not as the compressor does'); return; }
      delete h.sent[m.id];
      h.inflight--;
      for (var i = 0; i < items.length; i++) {
        var c = meta[i * 3], len = meta[i * 3 + 1] >>> 0, crc = meta[i * 3 + 2] >>> 0;
        var heap = M.HEAPU8;
        heap.set(sha1.subarray(i * 20, i * 20 + 20), scratch);
        if (len > 0) {
          var dst = M._wasm_par_item_compbuf(items[i]);
          heap.set(out.subarray(o, o + len), dst);
          o += len;
        }
        M._wasm_par_complete_inplace(items[i], crc, scratch, c, len);
        done.add(items[i]);
      }
      dispatch();
      maybeWake();
    };
  });

  // flags: bit 0 = libdeflate, bit 1 = ultra, bits 8..15 = zstd level
  M.parSetup = function (hb, ub, comps, flags) {
    var live = liveHelpers();
    if (!live.length) return false;
    // the LaserDisc codec (avhu) reads settings from the CHD's own metadata: keep it single-threaded
    if (comps.indexOf(0x61766875) >= 0) return false;
    hunkbytes = hb;
    parComps = comps.slice();
    // match chd.cpp's 256-hunk work-buffer rounding (8 MiB target clamped to 256..4096 hunks)
    // so each half-buffer splits cleanly into >= 2 balanced batches per helper without tail stalls
    var targetHunks = Math.max(256, Math.min(4096, Math.floor((8 << 20) / hb)));
    var halfHunks = Math.max(128, Math.floor(targetHunks / 256) * 128);
    batchSize = Math.max(1, Math.min(64, Math.floor((512 * 1024) / hb), Math.floor(halfHunks / (2 * live.length))));
    if (scratch) { M._free(scratch); scratch = 0; }
    scratch = M._malloc(32);
    if (!scratch) return false;
    bufPool = [];
    live.forEach(function (h) { h.port.postMessage({ type: 'init', hunkbytes: hb, unitbytes: ub, comps: comps, flags: flags || 0 }); });
    M.parActive = true;
    postMessage({ type: 'notice', level: 'debug', message: 'multi-core compression: ' + live.length + ' helper threads, batch ' + batchSize });
    return true;
  };
  // chdman has ended: late answers are dropped (their work items and CHD handles no longer exist)
  M.parClose = function () {
    closed = true;
    M.parActive = false;
    if (scratch) { M._free(scratch); scratch = 0; }
    bufPool = [];
    rd.chd = 0;
    rd.gen++;
    rd.queue = [];
    rd.open = null;
    rd.busy = 0;
    helpers.forEach(function (h) { h.sent = {}; h.dsent = {}; h.port.onmessage = null; try { h.port.close(); } catch (e) { /* ignore */ } });
    try { mc.port1.close(); mc.port2.close(); } catch (e) { /* ignore */ }
    M.parSetup = M.parSubmit = M.parWait = M.parClose = M.rdSetup = M.rdSubmit = M.rdClose = M.rdBusy = M.rdWait = M.setThrottle = null;
  };
  // codecs: the codec slots the codec plan tries for this hunk, a bit each (15 = all; bits 4-5 adaptive)
  M.parSubmit = function (item, ptr, len, codecs) {
    if (!open) open = { n: 0, items: new Uint32Array(batchSize), ptrs: new Uint32Array(batchSize), codecs: new Uint8Array(batchSize), buf: takeBuf() };
    open.buf.set(M.HEAPU8.subarray(ptr, ptr + len), open.n * hunkbytes);
    open.ptrs[open.n] = ptr;
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
        postMessage({ type: 'fatal', engine: true, message: 'Multi-core compression failed (' + failed + ').' });
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
    var live = liveHelpers();
    while (rd.queue.length) {
      var b = rd.queue.shift();
      if (!live.length) {
        // no helper left: the job worker decompresses these hunks itself, as it does a hunk a helper couldn't
        rdResult({ gen: b.gen, meta: b.meta.slice(0, b.n * 3), ok: new Uint8Array(b.n), out: new Uint8Array(0) });
        continue;
      }
      var h = live[0];
      for (var i = 1; i < live.length; i++) if (live[i].inflight < h.inflight) h = live[i];
      var id = ++seq;
      h.inflight++;
      h.dsent[id] = b;
      var meta = b.meta.slice(0, b.n * 3), data = b.data.slice(0, b.used);
      h.port.postMessage({ type: 'dbatch', id: id, gen: b.gen, meta: meta, data: data.buffer }, [meta.buffer, data.buffer]);
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
    var live = liveHelpers();
    if (!live.length || rd.chd) return false;
    // the LaserDisc codec (avhu) reads settings from the CHD's own metadata
    if (comps.indexOf(0x61766875) >= 0) return false;
    rd.chd = chd; rd.gen++; rd.hb = hb;
    rd.batch = Math.max(1, Math.min(64, Math.floor((512 * 1024) / hb)));
    live.forEach(function (h) { h.port.postMessage({ type: 'dinit', hunkbytes: hb, unitbytes: ub, comps: comps }); });
    postMessage({ type: 'notice', level: 'debug', message: 'multi-core decompression: ' + live.length + ' helper threads, batch ' + rd.batch });
    return true;
  };
  M.rdSubmit = function (chd, hunk, codec, ptr, len) {
    if (chd !== rd.chd) return;
    if (!liveHelpers().length) { M._wasm_rd_done(chd, hunk, 0); return; }
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
      rdDispatch();
      rd.waiting = resolve;
      if (!rd.busy) rdWake();
    });
  };
}

/* ---------------- helper role (persistent warm worker) ---------------- */

var helperState = null;
async function initHelper(msg) {
  await loadModule(msg);
  var M = await instantiate({});
  helperState = {
    M: M, port: null, fail: false, lie: false,
    codecsPtr: wasmAlloc(M, 256 * 4), metaPtr: wasmAlloc(M, 256 * 32),
    hb: 0, dinbuf: 0, doutbuf: 0, dhb: 0
  };
  if (msg.port) attachHelper({ port: msg.port, fail: msg.fail, lie: msg.lie });
  postMessage({ type: 'helper-ready' });
}

function attachHelper(msg) {
  var hs = helperState;
  if (!hs) return;
  if (hs.port) { hs.port.onmessage = null; try { hs.port.close(); } catch (e) { /* ignore */ } }
  hs.port = msg.port || null;
  hs.fail = !!msg.fail;
  hs.lie = !!msg.lie;
  if (!hs.port) {
    postMessage({ type: 'detached', memBytes: hs.M.HEAPU8.buffer.byteLength });
    return;
  }
  var M = hs.M, port = hs.port;
  port.onmessage = function (e) {
    var m = e.data;
    try {
      if (m.type === 'dinit') {
        var dr = M._wasm_helper_dinit(m.hunkbytes, m.unitbytes, m.comps[0], m.comps[1], m.comps[2], m.comps[3]);
        if (dr !== 0) throw new Error('codec init failed (' + dr + ')');
        hs.dinbuf = M._wasm_helper_dinbuf();
        hs.doutbuf = M._wasm_helper_doutbuf();
        hs.dhb = m.hunkbytes;
        return;
      }
      if ((m.type === 'dbatch' || m.type === 'batch') && hs.fail) throw new Error('Out of bounds memory access (a test: DEBUG.failHelpers)');
      if (m.type === 'dbatch') {
        var dmeta = m.meta, ddata = new Uint8Array(m.data), dn = dmeta.length / 3;
        var ok = new Uint8Array(dn), dout = new Uint8Array(dn * hs.dhb), doff = 0;
        for (var di = 0; di < dn; di++) {
          var dlen = dmeta[di * 3 + 2];
          if (dlen > hs.dhb) { doff += dlen; continue; }
          M.HEAPU8.set(ddata.subarray(doff, doff + dlen), hs.dinbuf);
          doff += dlen;
          if (M._wasm_helper_decompress(dmeta[di * 3 + 1], dlen) === 0) {
            ok[di] = 1;
            dout.set(M.HEAPU8.subarray(hs.doutbuf, hs.doutbuf + hs.dhb), di * hs.dhb);
          }
        }
        port.postMessage({ type: 'dresult', id: m.id, gen: m.gen, meta: dmeta, ok: ok, out: dout }, [dmeta.buffer, ok.buffer, dout.buffer]);
        return;
      }
      if (m.type === 'init') {
        var r = M._wasm_helper_init(m.hunkbytes, m.unitbytes, m.comps[0], m.comps[1], m.comps[2], m.comps[3], m.flags || 0);
        if (r !== 0) throw new Error('codec init failed (' + r + ')');
        hs.hb = m.hunkbytes;
        return;
      }
      if (m.type === 'batch') {
        var n = m.items.length, hb = hs.hb, codecs = m.codecs;
        var inLen = m.len != null ? m.len : n * hb;
        var data = new Uint8Array(m.data, 0, inLen);
        var inbuf = M._wasm_helper_inbuf_batch(n);
        var outbuf = M._wasm_helper_outbuf_batch(n);
        if (!inbuf || !outbuf) throw new Error('helper batch allocation failed');
        M.HEAPU8.set(data, inbuf);
        var cp32 = hs.codecsPtr >>> 2;
        for (var ci = 0; ci < n; ci++) M.HEAPU32[cp32 + ci] = codecs ? codecs[ci] : 15;
        var total = M._wasm_helper_compress_batch(n, hs.codecsPtr, hs.metaPtr);
        if (total < 0) throw new Error('codec compression failed (' + total + ')');
        var heap32 = M.HEAPU32, heap8 = M.HEAPU8;
        var meta = new Int32Array(n * 3), sha1 = new Uint8Array(n * 20);
        var out = total > 0 ? heap8.slice(outbuf, outbuf + total) : new Uint8Array(0);
        for (var i = 0; i < n; i++) {
          var mp32 = (hs.metaPtr >>> 2) + i * 8;
          var c = heap32[mp32] | 0, len = heap32[mp32 + 1] >>> 0, crc = heap32[mp32 + 2] >>> 0;
          if (len > hb) throw new Error('compressed hunk exceeds hunk size');
          meta[i * 3] = c; meta[i * 3 + 1] = len; meta[i * 3 + 2] = crc;
          var sp = hs.metaPtr + i * 32 + 12;
          sha1.set(heap8.subarray(sp, sp + 20), i * 20);
        }
        if (hs.lie) m.items[0] += 64; // a test (DEBUG.failHelpers 'lie'): an answer for another hunk
        var xfer = [m.items.buffer, meta.buffer, sha1.buffer, out.buffer];
        if (m.data && m.data.byteLength > 0) xfer.push(m.data);
        port.postMessage({ type: 'result', id: m.id, items: m.items, meta: meta, sha1: sha1, out: out, recyc: m.data }, xfer);
        return;
      }
      if (m.type === 'ciso-batch') {
        var ccount = m.count | 0, cfmt = m.fmt, cshift = m.shift || 1, clevel = m.level || 6;
        var cmax = 2048 - cshift;
        if (!hs.cisoIn) {
          hs.cisoIn = wasmAlloc(M, 2048);
          hs.cisoOutA = wasmAlloc(M, 2048);
          hs.cisoOutB = wasmAlloc(M, 2048);
        }
        var csrc = new Uint8Array(m.blocks, 0, ccount * 2048);
        var clens = new Uint16Array(ccount), cflags = new Uint8Array(ccount);
        var cout = new Uint8Array(ccount * 2048), cpos = 0;
        for (var bi = 0; bi < ccount; bi++) {
          var boff = bi * 2048;
          M.HEAPU8.set(csrc.subarray(boff, boff + 2048), hs.cisoIn);
          var bestLen = 2048, bestFlag = (cfmt === 'cso2') ? 0 : 1, bestPtr = 0;
          if (cfmt === 'zso') {
            var zl = M._wasm_lz4_compress_block(hs.cisoIn, 2048, hs.cisoOutA, cmax);
            if (zl > 0 && zl <= cmax) { bestLen = zl; bestFlag = 0; bestPtr = hs.cisoOutA; }
          } else if (cfmt === 'cso1') {
            var dl = M._wasm_deflate_raw(hs.cisoIn, 2048, hs.cisoOutA, cmax, clevel);
            if (dl > 0 && dl <= cmax) { bestLen = dl; bestFlag = 0; bestPtr = hs.cisoOutA; }
          } else {
            var l2 = M._wasm_lz4_compress_block(hs.cisoIn, 2048, hs.cisoOutA, cmax);
            var d2 = M._wasm_deflate_raw(hs.cisoIn, 2048, hs.cisoOutB, cmax, clevel);
            if (d2 > 0 && d2 <= cmax && (l2 <= 0 || d2 <= l2)) { bestLen = d2; bestFlag = 0; bestPtr = hs.cisoOutB; }
            else if (l2 > 0 && l2 <= cmax) { bestLen = l2; bestFlag = 1; bestPtr = hs.cisoOutA; }
          }
          clens[bi] = bestLen;
          cflags[bi] = bestFlag;
          if (bestPtr) cout.set(M.HEAPU8.subarray(bestPtr, bestPtr + bestLen), cpos);
          else cout.set(csrc.subarray(boff, boff + 2048), cpos);
          cpos += bestLen;
        }
        var ctrim = cout.slice(0, cpos);
        port.postMessage({ type: 'ciso-result', id: m.id, seq: m.seq, lens: clens, flags: cflags, out: ctrim }, [clens.buffer, cflags.buffer, ctrim.buffer]);
      }
    } catch (err) {
      port.onmessage = null;
      port.postMessage({ type: 'error', id: m && m.id, message: errText(err) });
    }
  };
}
async function runHelper(msg) {
  if (!helperState) await initHelper(msg);
  else attachHelper(msg);
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

var coordM = null, coordCHDFS = null, curOut = null, curErr = null, curAborted = null;
var ckptUrgent = false, activeBacking = null;

function bytesToHex(b) {
  var s = '';
  for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
  return s;
}
function hexToBytes(hex, dst, off) {
  for (var i = 0; i < hex.length; i += 2) dst[off + (i >> 1)] = parseInt(hex.slice(i, i + 2), 16) & 255;
}
function readCkptJson(handle) {
  try {
    var sz = handle.getSize();
    if (!(sz > 4 && sz < 65536)) return null;
    var buf = new Uint8Array(sz);
    if (handle.read(buf, { at: 0 }) !== sz) return null;
    var dv = new DataView(buf.buffer, buf.byteOffset, 4);
    var want = dv.getUint32(0, true);
    var got = (crcUpdate(-1, buf.subarray(4)) ^ -1) >>> 0;
    if (got !== want) return null;
    return JSON.parse(new TextDecoder('utf-8').decode(buf.subarray(4)));
  } catch (e) { return null; }
}
function writeCkptJson(handle, obj) {
  var json = new TextEncoder().encode(JSON.stringify(obj));
  var pkt = new Uint8Array(4 + json.length);
  new DataView(pkt.buffer).setUint32(0, (crcUpdate(-1, json) ^ -1) >>> 0, true);
  pkt.set(json, 4);
  if (handle.write(pkt, { at: 0 }) !== pkt.length) return false;
  handle.truncate(pkt.length);
  handle.flush();
  return true;
}

async function setupCheckpoint(M, backing, inStores, msg) {
  var dir = backing.dir, slot0 = backing.slots && backing.slots[0];
  if (backing.mode !== 'opfs' || !dir || !slot0 || !msg.ckpt || !msg.ckpt.enabled) return null;
  var logH = null, h0 = null, h1 = null;
  try {
    logH = await openSyncHandle(await dir.getFileHandle('ckpt.log', { create: true }));
    h0 = await openSyncHandle(await dir.getFileHandle('ckpt.0', { create: true }));
    h1 = await openSyncHandle(await dir.getFileHandle('ckpt.1', { create: true }));
    var cand = null;
    if (msg.resume) {
      var a = readCkptJson(h0), b = readCkptJson(h1);
      if (a && b) cand = (a.seq >= b.seq) ? a : b;
      else cand = a || b || null;
    } else {
      logH.truncate(0);
      h0.truncate(0);
      h1.truncate(0);
    }
    var metaH = [h0, h1], seq = 0, metaEndSaved = 0, runParams = null;
    var closeHandles = async function (remove) {
      M.ckptEnabled = M.ckptRequested = M.ckptSave = M.ckptTryResume = null;
      [logH, h0, h1].forEach(function (h) { if (h) { try { h.close(); } catch (e) { /* ignore */ } } });
      logH = h0 = h1 = null;
      if (remove) {
        for (var k = 0; k < 3; k++) {
          try { await dir.removeEntry(['ckpt.log', 'ckpt.0', 'ckpt.1'][k]); } catch (e) { /* ignore */ }
        }
      }
    };
    var cfg = msg.ckpt;
    M.ckptEnabled = function (hb, hc) {
      if (hc <= 512) return 0;
      if (cfg.stride && cfg.stride > 0) return cfg.stride >>> 0;
      var targetBytes = cfg.short ? (16 << 20) : (32 << 20);
      return Math.max(256, Math.round(targetBytes / hb)) >>> 0;
    };
    M.ckptRequested = function () { return ckptUrgent ? 1 : 0; };
    M.ckptTryResume = function (comp, hb, hc, ub, comps, logical, metaEnd, outStatePtr) {
      metaEndSaved = metaEnd;
      runParams = { hb: hb, hc: hc, ub: ub, comps: comps.slice(), logical: logical };
      var st = slot0.store;
      var fail = function () {
        if (st && st.preserveOnInit) {
          st.preserveOnInit = false;
          try { st.flush(); slot0.handle.truncate(st.sizeV); } catch (e) { /* ignore */ }
        }
        try { logH.truncate(0); h0.truncate(0); h1.truncate(0); } catch (e) { /* ignore */ }
        return false;
      };
      if (!msg.resume || !cand || cand.v !== 1 || !st) return fail();
      if (cand.hunkBytes !== hb || cand.hunkCount !== hc || cand.unitBytes !== ub || cand.logicalBytes !== logical || cand.metaEnd !== metaEnd) return fail();
      if (!cand.comps || cand.comps.length !== 4 || cand.comps[0] !== comps[0] || cand.comps[1] !== comps[1] || cand.comps[2] !== comps[2] || cand.comps[3] !== comps[3]) return fail();
      if (!(cand.nextHunk > 0 && (cand.nextHunk % 256) === 0 && cand.nextHunk + 256 < hc)) return fail();
      if (!(cand.writeOffset >= metaEnd && cand.sha1 && cand.sha1.length === 184)) return fail();
      if (slot0.handle.getSize() < cand.writeOffset || logH.getSize() < cand.nextHunk * 32) return fail();
      var tmp = 0, CHUNK = 2048;
      try {
        tmp = wasmAlloc(M, CHUNK * 32);
        var buf = new Uint8Array(CHUNK * 32);
        for (var doneH = 0; doneH < cand.nextHunk; doneH += CHUNK) {
          var cnt = Math.min(CHUNK, cand.nextHunk - doneH), bytes = cnt * 32;
          if (logH.read(buf.subarray(0, bytes), { at: doneH * 32 }) !== bytes) return fail();
          M.HEAPU8.set(buf.subarray(0, bytes), tmp);
          if (!M._wasm_ckpt_restore_chunk(comp, doneH, tmp, cnt)) return fail();
        }
      } catch (e) { return fail(); }
      finally { if (tmp) M._free(tmp); }
      try { logH.truncate(cand.nextHunk * 32); } catch (e) { return fail(); }
      st.preserveOnInit = false;
      seq = cand.seq || 0;
      if (cand.ecm && cand.ecm.length) {
        for (var ei = 0; ei < inStores.length; ei++) {
          var es = inStores[ei].store;
          if (!(es instanceof EcmStore)) continue;
          for (var ej = 0; ej < cand.ecm.length; ej++) {
            if (cand.ecm[ej].name === inStores[ei].name) es.restoreEdc(cand.ecm[ej]);
          }
        }
      }
      var dv = new DataView(M.HEAPU8.buffer, outStatePtr, 112);
      dv.setUint32(0, cand.nextHunk >>> 0, true);
      dv.setUint32(4, cand.writeOffset >>> 0, true);
      dv.setUint32(8, Math.floor(cand.writeOffset / 4294967296) >>> 0, true);
      dv.setUint32(12, cand.totalOut >>> 0, true);
      dv.setUint32(16, Math.floor(cand.totalOut / 4294967296) >>> 0, true);
      hexToBytes(cand.sha1, M.HEAPU8, outStatePtr + 20);
      postMessage({ type: 'resumed', nextHunk: cand.nextHunk, hunkCount: hc, pct: 100 * cand.nextHunk / hc });
      return true;
    };
    M.ckptSave = function (nextHunk, hunkCount, writeOffset, totalOut, sha1Ptr, deltaPtr, deltaCount) {
      var st = slot0.store;
      if (!st || !runParams) return false;
      try {
        st.flush();
        slot0.handle.flush();
        var deltaBytes = deltaCount * 32;
        var deltaOff = (nextHunk - deltaCount) * 32;
        var deltaView = M.HEAPU8.subarray(deltaPtr, deltaPtr + deltaBytes);
        if (logH.write(deltaView, { at: deltaOff }) !== deltaBytes) return false;
        logH.flush();
        var ecmSnap = [];
        var byteLimit = nextHunk * runParams.hb;
        for (var ei = 0; ei < inStores.length; ei++) {
          if (inStores[ei].store instanceof EcmStore) {
            var est = inStores[ei].store.edcAtOrBefore(byteLimit);
            ecmSnap.push({ name: inStores[ei].name, at: est.at, edc: est.edc });
          }
        }
        var nextSeq = seq + 1;
        var obj = {
          v: 1,
          seq: nextSeq,
          jobMeta: cfg.meta || null,
          hunkBytes: runParams.hb,
          hunkCount: hunkCount,
          unitBytes: runParams.ub,
          comps: runParams.comps,
          logicalBytes: runParams.logical,
          metaEnd: metaEndSaved,
          nextHunk: nextHunk,
          writeOffset: writeOffset,
          totalOut: totalOut,
          sha1: bytesToHex(M.HEAPU8.subarray(sha1Ptr, sha1Ptr + 92)),
          ecm: ecmSnap,
          ts: Date.now()
        };
        if (!writeCkptJson(metaH[nextSeq & 1], obj)) return false;
        seq = nextSeq;
        ckptUrgent = false;
        postMessage({ type: 'ckpt', nextHunk: nextHunk, hunkCount: hunkCount, writeOffset: writeOffset, pct: 100 * nextHunk / hunkCount });
        return true;
      } catch (e) { return false; }
    };
    return { close: closeHandles };
  } catch (e) {
    [logH, h0, h1].forEach(function (h) { if (h) { try { h.close(); } catch (x) { /* ignore */ } } });
    return null;
  }
}

function emitBinProgress(M, lastSeq) {
  if (!M._wasm_progress_ptr) return lastSeq;
  var ptr = M._wasm_progress_ptr();
  if (!ptr) return lastSeq;
  var dv = new DataView(M.HEAPU8.buffer, ptr, 48);
  var seq = dv.getUint32(44, true);
  if (seq === lastSeq) return lastSeq;
  postMessage({
    type: 'prog-bin',
    done: dv.getFloat64(0, true),
    ratio: dv.getFloat64(8, true),
    bytesIn: dv.getUint32(16, true) + dv.getUint32(20, true) * 4294967296,
    bytesOut: dv.getUint32(24, true) + dv.getUint32(28, true) * 4294967296,
    hunksDone: dv.getUint32(32, true),
    hunksTotal: dv.getUint32(36, true),
    phase: dv.getUint32(40, true)
  });
  return seq;
}

// Runs a chdman command line and resolves with its exit code. A command that compresses with
// helper workers pauses after each step (chdman_begin/chdman_resume return -1) until M.parWait()
// says the next hunk is in, so the worker keeps receiving their results. Extract and verify pause
// the same way while helpers decompress the hunks they are about to read (M.rdWait()).
async function runChdman(M, args) {
  var argv = wasmAlloc(M, 4 * (args.length + 2));
  var ptrs = [];
  ['chdman'].concat(args).forEach(function (a, i) { var p = M.stringToNewUTF8(a); ptrs.push(p); M.HEAPU32[(argv >>> 2) + i] = p; });
  M.HEAPU32[(argv >>> 2) + args.length + 1] = 0;
  var lastSeq = 0, code = -1;
  try {
    code = M._chdman_begin(args.length + 1, argv);
    lastSeq = emitBinProgress(M, lastSeq);
    while (code === -1) {
      if (sinkFull()) await sinkDrained();
      if (M.rdBusy && M.rdBusy()) await M.rdWait();
      else if (M.parWait) await M.parWait();
      code = M._chdman_resume();
      lastSeq = emitBinProgress(M, lastSeq);
    }
    return code;
  } finally {
    if (code === -1 && M._chdman_abort) { try { M._chdman_abort(); } catch (e) { /* ignore */ } }
    if (M.parClose) M.parClose();
    for (var i = 0; i < ptrs.length; i++) M._free(ptrs[i]);
    M._free(argv);
  }
}

async function runJob(msg) {
  sinkPending = 0; sinkWaiter = null; lastWriter = null; ckptUrgent = false;
  SINK_MAX = msg.debugSinkMax || (64 << 20);
  await loadModule(msg);
  var backing = await makeBacking(msg);
  postMessage({ type: 'storage', mode: backing.mode, reason: memReason });

  var stages = [], inStores = [], allStores = [];
  async function dropStages() {
    for (var si = 0; si < stages.length; si++) {
      try { stages[si].slot.handle.close(); } catch (e) { /* ignore */ }
      try { await stages[si].dir.removeEntry(stages[si].slot.name); } catch (e) { /* ignore */ }
    }
    stages = [];
  }
  function freeStores() {
    for (var i = 0; i < allStores.length; i++) if (allStores[i].store && allStores[i].store.free) allStores[i].store.free();
  }
  function unmountFS(M) {
    if (!M || !M.FS) return;
    try { M.FS.chdir('/'); } catch (e) { /* ignore */ }
    try { M.FS.unmount('/in'); } catch (e) { /* ignore */ }
    try { M.FS.unmount('/out'); } catch (e) { /* ignore */ }
  }

  // copies of inputs chdman must modify in place (verify --fix, addmeta, delmeta)
  var outFiles = [];
  var wl = msg.writable || [];
  for (var wi = 0; wi < wl.length; wi++) {
    var w = wl[wi];
    try {
      var store = backing.create(w.name, true), step = 8 << 20;
      for (var pos = 0; pos < w.blob.size; pos += step) {
        var part = w.blob.slice(pos, Math.min(w.blob.size, pos + step)), chunk;
        try { chunk = new Uint8Array(getReader().readAsArrayBuffer(part)); }
        catch (e) { chunk = new Uint8Array(await part.arrayBuffer()); }
        store.write(chunk, pos);
      }
      outFiles.push({ name: w.name, store: store });
    } catch (e) {
      await backing.finalize(false);
      await dropStages();
      postMessage({ type: 'done', code: -1, error: 'Could not prepare "' + w.name + '": ' + errText(e), outputs: [] });
      return;
    }
  }

  // inputs: read directly when possible, otherwise staged first (also supports virtual zero/concat stores)
  var inputs = msg.inputs || [], storeByName = Object.create(null);
  for (var ii = 0; ii < inputs.length; ii++) {
    var inp = inputs[ii], bs;
    if (inp.zero != null) {
      bs = new ZeroStore(inp.zero);
    } else if (inp.stride) {
      var sref = storeByName[inp.stride.ref];
      var subRef = inp.stride.subRef ? storeByName[inp.stride.subRef] : null;
      if (!sref || (inp.stride.subRef && !subRef)) {
        await dropStages();
        await backing.finalize(false);
        postMessage({ type: 'done', code: -1, error: 'Missing virtual sector source "' + (inp.stride.ref || inp.stride.subRef) + '".', outputs: [] });
        return;
      }
      bs = new StrideSliceStore(sref, inp.stride.offset, inp.stride.count, inp.stride.dataSize, inp.stride.stride, subRef, inp.stride.subOffset);
    } else if (inp.concat) {
      var cparts = [];
      for (var ci = 0; ci < inp.concat.length; ci++) {
        var cp = inp.concat[ci];
        if (cp.zero != null) {
          cparts.push({ store: new ZeroStore(cp.zero), start: 0, len: cp.zero });
        } else {
          var ref = storeByName[cp.ref];
          if (!ref) {
            await dropStages();
            await backing.finalize(false);
            postMessage({ type: 'done', code: -1, error: 'Missing virtual input source "' + cp.ref + '".', outputs: [] });
            return;
          }
          var st0 = cp.start || 0;
          var autoLen = cp.len == null;
          var ln0 = autoLen ? Math.max(0, ref.sizeV - st0) : cp.len;
          cparts.push({ store: ref, start: st0, len: ln0, autoLen: autoLen });
        }
      }
      bs = new ConcatStore(cparts);
    } else {
      bs = new BlobStore(inp.blob);
      if (msg.debugStage || !storeReadable(bs)) {
        try { bs = await stageInput(msg, ii, stages); }
        catch (e) {
          await dropStages();
          await backing.finalize(false);
          var full = e && typeof e.errno === 'number';
          postMessage({ type: 'done', code: -1, readFail: !full, error: full ? 'Could not copy "' + inp.name + '" to private storage: ' + errText(e) + '.' : 'The browser could not read "' + inp.name + '": ' + errText(e), outputs: [] });
          return;
        }
      }
      // a CSO/ZSO compressed ISO, an ECM image, a PS1 PBP's disc, or a decoded audio track
      if (inp.ciso || inp.ecm || inp.pbp || inp.audio) {
        var label = inp.blob.name || inp.name;
        try {
          bs = inp.ciso ? new CisoStore(bs, 0, label)
            : inp.pbp ? new PbpStore(bs, inp.pbp, label)
            : inp.audio ? new AudioStore(bs, label)
            : new EcmStore(bs, label);
        } catch (e) {
          await dropStages();
          await backing.finalize(false);
          postMessage({ type: 'done', code: -1, error: '"' + label + '" could not be read as ' + (inp.ciso ? 'a compressed ISO' : inp.pbp ? 'a PS1 PBP file' : inp.audio ? 'an audio track' : 'an ECM image') + ': ' + (e && e.message || e), outputs: [] });
          return;
        }
      }
    }
    storeByName[inp.name] = bs;
    allStores.push({ name: inp.name, store: bs });
    if (!inp.hidden) inStores.push({ name: inp.name, store: bs });
  }

  var out = makeLineSink(1), err = makeLineSink(2), M;
  curOut = out; curErr = err; curAborted = null;
  try {
    if (!coordM) {
      coordM = await instantiate({
        stdin: function () { return null; },
        stdout: function (c) { if (curOut) curOut.put(c); },
        stderr: function (c) { if (curErr) curErr.put(c); },
        onAbort: function (what) { curAborted = 'chdman stopped unexpectedly: ' + what; coordM = null; }
      });
      coordCHDFS = makeFS(coordM.FS);
      coordM.FS.mkdir('/in');
      coordM.FS.mkdir('/out');
    }
    M = coordM;
    allStores.forEach(function (st) { if (st.store.setModule) st.store.setModule(M); });
    backing.M = M;
    M.outFull = sinkFull; // wasm_out_full: chdman pauses while a folder is behind
    M.FS.mount(coordCHDFS, { files: inStores }, '/in');
    M.FS.mount(coordCHDFS, { files: outFiles, backing: backing }, '/out');
    M.FS.chdir('/out');
  } catch (e) {
    unmountFS(M);
    freeStores();
    await backing.finalize(false);
    await dropStages();
    postMessage({ type: 'done', code: -1, error: curAborted || errText(e), outputs: [], aborted: !!curAborted });
    return;
  }

  if (msg.ports && msg.ports.length) setupParallel(M, msg.ports);
  var ckpt = await setupCheckpoint(M, backing, allStores, msg);
  activeBacking = backing;

  var started = performance.now(), code;
  try {
    code = await runChdman(M, msg.args);
    M._fflush(0);
  } catch (e) {
    out.flush(); err.flush();
    unmountFS(M);
    freeStores();
    activeBacking = null;
    if (ckpt) await ckpt.close(true);
    await backing.finalize(false);
    await dropStages();
    postMessage({ type: 'done', code: -1, error: curAborted || String(e && e.message || e), outputs: [], ms: performance.now() - started, aborted: !!curAborted, memBytes: M ? M.HEAPU8.buffer.byteLength : 0 });
    return;
  }
  out.flush(); err.flush();
  unmountFS(M);
  freeStores();
  activeBacking = null;
  if (ckpt) await ckpt.close(true);
  var flushError = code === 0 ? backing.flush() : null;
  if (flushError) {
    await backing.finalize(false);
    await dropStages();
    postMessage({ type: 'done', code: -1, error: flushError, outputs: [], ms: performance.now() - started, aborted: !!curAborted, memBytes: M ? M.HEAPU8.buffer.byteLength : 0 });
    return;
  }
  var outputs = await backing.finalize(code === 0);
  await dropStages();
  postMessage({ type: 'done', code: code, outputs: outputs, ms: performance.now() - started, aborted: !!curAborted, memBytes: M ? M.HEAPU8.buffer.byteLength : 0 },
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
  var pp = wasmAlloc(M, enc.length);
  M.HEAPU8.set(enc, pp);
  var ppar = 0; // a child CHD's parent (msg.parent), mounted as parent.chd
  if (msg.parent) { var encp = new TextEncoder().encode('/in/parent.chd\0'); ppar = wasmAlloc(M, encp.length); M.HEAPU8.set(encp, ppar); }
  var kind = M._wasm_probe_open(pp, ppar);
  M._free(pp);
  if (ppar) M._free(ppar);
  var tracks = [], info = wasmAlloc(M, 40), buf = wasmAlloc(M, 2048);
  var n = kind === 1 ? M._wasm_probe_tracks() : 0;
  for (var t = 0; t < n; t++) {
    M._wasm_probe_track_info(t, info);
    var q = info >>> 2, h = M.HEAPU32;
    tracks.push({ type: h[q], frames: h[q + 1], pregap: h[q + 2], datasize: h[q + 3], gdrom: !!h[q + 4],
      subtype: h[q + 5], postgap: h[q + 6], padframes: h[q + 7], pgdatasize: h[q + 8], logframeofs: h[q + 9] });
  }
  var inspect = null;
  if (kind > 0 && M._wasm_chd_inspect && M._wasm_chd_inspect(info) === 0) {
    var iq = info >>> 2, ih = M.HEAPU32;
    var tagStr = function (v) { return v ? String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255) : ''; };
    var comps = [ih[iq + 4], ih[iq + 5], ih[iq + 6], ih[iq + 7]].filter(Boolean).map(tagStr);
    var shaPtr = wasmAlloc(M, 60), tagsPtr = wasmAlloc(M, 256 * 4);
    var hex20 = function (off) {
      var s = '';
      for (var k = 0; k < 20; k++) s += ('0' + M.HEAPU8[off + k].toString(16)).slice(-2);
      return /^0+$/.test(s) ? '' : s;
    };
    var sha1 = '', rawSha1 = '', parentSha1 = '', tags = [];
    if (M._wasm_chd_sha1(shaPtr) === 0) {
      sha1 = hex20(shaPtr); rawSha1 = hex20(shaPtr + 20); parentSha1 = hex20(shaPtr + 40);
    }
    var ntags = M._wasm_chd_metadata_list(tagsPtr, 256);
    for (var ti = 0; ti < Math.min(ntags, 256); ti++) tags.push(tagStr(M.HEAPU32[(tagsPtr >>> 2) + ti]));
    M._free(shaPtr); M._free(tagsPtr);
    inspect = { version: ih[iq], hunkbytes: ih[iq + 1], hunkcount: ih[iq + 2], unitbytes: ih[iq + 3],
      comps: comps, parentState: ih[iq + 8], compressed: !!ih[iq + 9], sha1: sha1, rawSha1: rawSha1, parentSha1: parentSha1, tags: tags };
  }
  M._free(info);
  postMessage({ type: 'reader-ready', kind: kind, tracks: tracks, logical: M._wasm_probe_logical(), inspect: inspect });
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

// the CD images in a job's ECM/PBP/Audio/Stride files (msg.ecm): reports their sizes (null: not
// readable, or damaged) and decoded audio metadata, then answers {type:'read', id, file, pos, len}
function runEcmReader(M, msg) {
  var images = msg.ecm.map(function (it) {
    try {
      var blob = it.blob || it;
      var s = it.pbp ? new PbpStore(new BlobStore(blob), it.pbp, blob.name)
        : it.audio ? new AudioStore(new BlobStore(blob), blob.name)
        : it.stride ? new StrideSliceStore(new BlobStore(blob), it.stride.offset, it.stride.count, it.stride.dataSize, it.stride.stride)
        : new EcmStore(new BlobStore(blob), blob.name);
      if (s.setModule) s.setModule(M);
      return s;
    } catch (e) { return null; }
  });
  postMessage({
    type: 'reader-ready', kind: 3, tracks: [], logical: 0,
    sizes: images.map(function (s) { return s ? s.sizeV : null; }),
    audInfos: images.map(function (s) { return s && s.audInfo ? s.audInfo : null; })
  });
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
  if (msg.debugSlow) await new Promise(function (r) { setTimeout(r, msg.debugSlow); }); // testing: a long checksum
  var blob = msg.blob, start = msg.start || 0, end = msg.end != null ? msg.end : blob.size;
  var step = 8 << 20, r = getReader(), last = 0;
  // zlib's crc32 in WebAssembly is several times faster than the JavaScript loop below it
  var M = null, buf = 0, iso = null;
  if (msg.wasmModule || msg.wasmBytes) {
    try {
      await loadModule(msg);
      M = await instantiate({});
      if (typeof M._crc32 === 'function' && (buf = M._malloc(step))) { /* the module's crc32 */ } else M = null;
    } catch (e) { M = null; }
  }
  // msg.ciso/ecm/pbp/audio/stride: checksum of the decoded/sliced image
  if (msg.ciso || msg.ecm || msg.pbp || msg.audio || msg.stride) {
    if (!M && !msg.stride) throw new Error('cannot decompress');
    iso = msg.ciso ? new CisoStore(new BlobStore(blob), 0, blob.name)
      : msg.pbp ? new PbpStore(new BlobStore(blob), msg.pbp, blob.name)
      : msg.audio ? new AudioStore(new BlobStore(blob), blob.name)
      : msg.stride ? new StrideSliceStore(new BlobStore(blob), msg.stride.offset, msg.stride.count, msg.stride.dataSize, msg.stride.stride)
      : new EcmStore(new BlobStore(blob), blob.name);
    if (iso.setModule) iso.setModule(M);
    if (msg.end == null) end = iso.sizeV;
  }
  var crc = M ? 0 : -1;
  try {
    for (var pos = start; pos < end; pos += step) {
      var n = Math.min(end, pos + step) - pos;
      if (iso) {
        if (M) {
          if (iso.read(M.HEAPU8.subarray(buf, buf + n), pos, n) !== n) throw new Error('truncated image');
          crc = M._crc32(crc, buf, n) >>> 0;
        } else {
          var tmp = new Uint8Array(n);
          if (iso.read(tmp, pos, n) !== n) throw new Error('truncated image');
          crc = crcUpdate(crc, tmp);
        }
      } else {
        var chunk = new Uint8Array(r.readAsArrayBuffer(blob.slice(pos, pos + n)));
        if (chunk.length !== n) throw new Error('truncated image');
        if (M) { M.HEAPU8.set(chunk, buf); crc = M._crc32(crc, buf, chunk.length) >>> 0; }
        else crc = crcUpdate(crc, chunk);
      }
      var now = Date.now();
      if (now - last > 250) { last = now; postMessage({ type: 'crc-progress', done: pos - start, total: end - start }); }
    }
    crc = M ? crc >>> 0 : (crc ^ -1) >>> 0;
    postMessage({ type: 'crc', crc: ('00000000' + crc.toString(16).toUpperCase()).slice(-8) });
  } finally {
    if (iso && iso.free) iso.free();
    if (M && buf) M._free(buf);
  }
}

// Worker-side streaming .zip entry unpacker using OPFS createSyncAccessHandle() (unblocks iOS 16.4-25.x,
// eliminates main-thread UI/GC stalls, and returns verified CRC-32 so ident/DAT skips a second hash pass)
async function runUnzip(msg) {
  var stream = msg.zip.slice(msg.at, msg.at + msg.csize).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  var reader = stream.getReader(), crc = -1, done = 0, parts = [], handle = null, sess = null;
  var base_ = msg.baseName, id = msg.id, lastProg = 0;
  var wbuf = null, wlen = 0, wpos = 0;
  function flushWbuf() {
    if (!wlen || !handle) return;
    var n = handle.write(wbuf.subarray(0, wlen), { at: wpos });
    if (n !== wlen) throw new DOMException('storage full', 'QuotaExceededError');
    wpos += wlen;
    wlen = 0;
  }
  if (msg.useOpfs && navigator.storage && navigator.storage.getDirectory) {
    try {
      var root = await (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-unzip', { create: true });
      sess = await root.getDirectoryHandle(msg.session, { create: true });
      var dir = await sess.getDirectoryHandle(id, { create: true });
      var fh = await dir.getFileHandle(base_, { create: true });
      handle = await openSyncHandle(fh);
      var t = handle.truncate(0);
      if (t && typeof t.then === 'function') {
        try { await t; await handle.close(); } catch (x) { /* ignore */ }
        handle = null;
        throw new Error('async handles');
      }
      wbuf = new Uint8Array(WBUF);
    } catch (e) {
      if (handle) { try { handle.close(); } catch (x) { /* ignore */ } handle = null; }
      if (sess) { try { await sess.removeEntry(id, { recursive: true }); } catch (x) { /* ignore */ } }
    }
  }
  if (!handle && msg.usize > msg.memMax) {
    postMessage({ type: 'unzip-done', reqId: msg.reqId, error: base_ + ' is too large (' + msg.sizeLabel + ') to unpack in this browser. Unzip it first, or use a browser with private storage (Discpress online).' });
    return;
  }
  try {
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      var val = r.value;
      done += val.length;
      if (done > msg.usize) { reader.cancel().catch(function () {}); throw new Error('it holds more than the zip says'); }
      crc = crcUpdate(crc, val);
      if (handle && msg.debugUnzipFull && done > val.length) throw new DOMException('test', 'QuotaExceededError');
      if (handle) {
        if (val.length >= WBUF) {
          flushWbuf();
          var wn = handle.write(val, { at: wpos });
          if (wn !== val.length) throw new DOMException('storage full', 'QuotaExceededError');
          wpos += val.length;
        } else {
          if (wlen + val.length > WBUF) flushWbuf();
          wbuf.set(val, wlen);
          wlen += val.length;
        }
      } else {
        parts.push(val);
      }
      var now = Date.now();
      if (now - lastProg > 80) { lastProg = now; postMessage({ type: 'unzip-progress', reqId: msg.reqId, done: done }); }
    }
    if (handle) { flushWbuf(); handle.flush(); handle.close(); handle = null; }
  } catch (e) {
    if (handle) { try { handle.close(); } catch (x) { /* ignore */ } handle = null; }
    if (sess) { try { await sess.removeEntry(id, { recursive: true }); } catch (x) { /* ignore */ } }
    var emsg = done > msg.usize
      ? base_ + ' is damaged in the zip: ' + e.message
      : base_ + ' could not be unpacked (' + (e && e.name === 'QuotaExceededError' ? 'the browser\u2019s storage is full' : e && e.message || e) + ')';
    postMessage({ type: 'unzip-done', reqId: msg.reqId, error: emsg });
    return;
  }
  var gotCrc = (crc ^ -1) >>> 0;
  if (gotCrc !== (msg.crc >>> 0) || done !== msg.usize) {
    if (sess) { try { await sess.removeEntry(id, { recursive: true }); } catch (x) { /* ignore */ } }
    postMessage({ type: 'unzip-done', reqId: msg.reqId, error: base_ + ' is damaged in the zip: its checksum doesn\u2019t match' });
    return;
  }
  var hexCrc = ('00000000' + gotCrc.toString(16).toUpperCase()).slice(-8);
  postMessage({ type: 'unzip-done', reqId: msg.reqId, usedOpfs: !!sess && !parts.length, id: id, crc: hexCrc, blob: parts.length ? new Blob(parts) : null });
}

// Streaming .7z archive unpacker backed by LZMA SDK 23.01 (wasm/7z_stream.c).
// Streams solid folders in <=2 MiB slices straight into OPFS chdman-unzip/<session>/<id>/<base>
// (or MemStore when OPFS is unavailable), verifies CRCs, and returns pre-verified CRC-32 values.
async function runUn7z(msg) {
  await loadModule(msg);
  var M = await instantiate({});
  var FS = M.FS, CHDFS = makeFS(FS);
  var bs = new BlobStore(msg.blob);
  if (!storeReadable(bs)) {
    var ms = new MemStore(), step = 4 << 20;
    for (var sp = 0; sp < msg.blob.size; sp += step) {
      ms.write(new Uint8Array(await msg.blob.slice(sp, Math.min(msg.blob.size, sp + step)).arrayBuffer()), sp);
    }
    ms.readonly = true;
    bs = ms;
  }
  FS.mkdir('/in');
  FS.mount(CHDFS, { files: [{ name: 'archive.7z', store: bs }] }, '/in');
  var pPath = M.stringToNewUTF8('/in/archive.7z');
  var numFiles = M._wasm_7z_open(pPath);
  M._free(pPath);
  if (numFiles < 0) {
    var oerr = numFiles === -2 ? 'is password-protected or uses an unsupported 7z compression method'
      : numFiles === -4 ? 'needs more memory than the browser allows'
      : 'is damaged or not a valid 7z archive';
    postMessage({ type: 'un7z-done', reqId: msg.reqId, error: (msg.name || 'Archive') + ' ' + oerr + '.' });
    return;
  }

  var maxDic = msg.maxDicBytes || (128 << 20);
  var nameBuf = wasmAlloc(M, 2048), metaPtr = wasmAlloc(M, 32), dec = new TextDecoder('utf-8');
  var files = [], folderMap = Object.create(null), totalBytes = 0, idSeq = msg.idBase || 0;
  try {
    for (var i = 0; i < numFiles; i++) {
      var nlen = M._wasm_7z_info(i, nameBuf, 2048, metaPtr);
      if (nlen < 0) continue;
      var q = metaPtr >>> 2, hu = M.HEAPU32;
      var fsz = hu[q] + hu[q + 1] * 4294967296;
      var fcrc = hu[q + 2] >>> 0, fidx = hu[q + 3] >>> 0;
      var isDir = !!hu[q + 4], hasCrc = !!hu[q + 5], dic = hu[q + 6] >>> 0, enc = !!hu[q + 7];
      var nm = dec.decode(M.HEAPU8.subarray(nameBuf, nameBuf + nlen)).replace(/\\/g, '/').replace(/^\/+/, '');
      if (isDir || !nm || nm.slice(-1) === '/' || nm.indexOf('__MACOSX/') === 0) continue;
      var base_ = nm.split('/').pop();
      if (!base_ || base_.indexOf('._') === 0) continue;
      if (enc) {
        M._wasm_7z_close();
        postMessage({ type: 'un7z-done', reqId: msg.reqId, error: (msg.name || 'Archive') + ' is password-protected; unpack it first.' });
        return;
      }
      if (dic > maxDic) {
        M._wasm_7z_close();
        postMessage({ type: 'un7z-done', reqId: msg.reqId, error: (msg.name || 'Archive') + ' uses a ' + Math.round(dic / (1 << 20)) + ' MB LZMA dictionary, which exceeds this browser\u2019s safe limit (' + Math.round(maxDic / (1 << 20)) + ' MB). Extract it externally first.' });
        return;
      }
      var rec = { idx: i, name: nm, baseName: base_, size: fsz, crc: fcrc, hasCrc: hasCrc, folderIdx: fidx, id: 'z7-' + (++idSeq) };
      files.push(rec);
      totalBytes += fsz;
      if (fidx !== 0xFFFFFFFF && fsz > 0) {
        if (!folderMap[fidx]) folderMap[fidx] = [];
        folderMap[fidx].push(rec);
      }
    }
  } finally {
    M._free(nameBuf); M._free(metaPtr);
  }
  postMessage({ type: 'un7z-list', reqId: msg.reqId, count: files.length, totalBytes: totalBytes });

  var sess = null, useOpfs = !!msg.useOpfs;
  if (useOpfs && navigator.storage && navigator.storage.getDirectory) {
    try {
      var root = await (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-unzip', { create: true });
      sess = await root.getDirectoryHandle(msg.session, { create: true });
      // test sync access handle availability once
      var tfh = await sess.getFileHandle('.probe7z', { create: true });
      var th = await openSyncHandle(tfh);
      var tp = th.truncate(0);
      if (tp && typeof tp.then === 'function') { try { await tp; await th.close(); } catch (x) {} throw new Error('async'); }
      th.close();
      try { await sess.removeEntry('.probe7z'); } catch (x) {}
    } catch (e) { sess = null; }
  }
  if (!sess && totalBytes > (msg.memMax || (512 << 20))) {
    M._wasm_7z_close();
    postMessage({ type: 'un7z-done', reqId: msg.reqId, error: (msg.name || 'Archive') + ' is too large to unpack without private storage. Extract it externally first, or use Discpress online.' });
    return;
  }

  var doneTotal = 0, lastProg = 0, outEntries = [], createdIds = [];
  var folderKeys = Object.keys(folderMap).map(Number).sort(function (a, b) { return a - b; });
  try {
    // Emit any zero-byte files directly
    for (var zi = 0; zi < files.length; zi++) {
      if (files[zi].size === 0 || files[zi].folderIdx === 0xFFFFFFFF) {
        outEntries.push({ name: files[zi].name, baseName: files[zi].baseName, size: 0, usedOpfs: false, id: files[zi].id, crc: '00000000', blob: new Blob([]) });
      }
    }
    for (var fk = 0; fk < folderKeys.length; fk++) {
      var fidx2 = folderKeys[fk], list = folderMap[fidx2];
      var sinks = Object.create(null);
      var writeErr = null;
      for (var li = 0; li < list.length; li++) {
        var f = list[li];
        var sink = { rec: f, crc: -1, written: 0, parts: [], handle: null, wbuf: null, wlen: 0, wpos: 0 };
        if (sess) {
          var dir = await sess.getDirectoryHandle(f.id, { create: true });
          createdIds.push(f.id);
          var fh = await dir.getFileHandle(f.baseName, { create: true });
          sink.handle = await openSyncHandle(fh);
          sink.handle.truncate(0);
          sink.wbuf = new Uint8Array(WBUF);
        }
        sinks[f.idx] = sink;
      }
      var flushSink = function (sk) {
        if (!sk.wlen || !sk.handle) return;
        var wn = sk.handle.write(sk.wbuf.subarray(0, sk.wlen), { at: sk.wpos });
        if (wn !== sk.wlen) throw new DOMException('storage full', 'QuotaExceededError');
        sk.wpos += sk.wlen;
        sk.wlen = 0;
      };
      M.on7zWrite = function (fileIdx, ptr, len) {
        var sk = sinks[fileIdx];
        if (!sk) return 0; // unselected file inside solid folder
        try {
          var view = M.HEAPU8.subarray(ptr, ptr + len);
          sk.crc = crcUpdate(sk.crc, view);
          sk.written += len;
          doneTotal += len;
          if (sk.handle) {
            if (len >= WBUF) {
              flushSink(sk);
              var wn = sk.handle.write(view, { at: sk.wpos });
              if (wn !== len) throw new DOMException('storage full', 'QuotaExceededError');
              sk.wpos += len;
            } else {
              if (sk.wlen + len > WBUF) flushSink(sk);
              sk.wbuf.set(view, sk.wlen);
              sk.wlen += len;
            }
          } else {
            sk.parts.push(view.slice());
          }
          var now = Date.now();
          if (now - lastProg > 80) { lastProg = now; postMessage({ type: 'un7z-progress', reqId: msg.reqId, done: doneTotal, total: totalBytes }); }
          return 0;
        } catch (e) {
          writeErr = e;
          return -1;
        }
      };
      var rc = M._wasm_7z_extract_folder(fidx2, maxDic);
      M.on7zWrite = null;
      for (var ci = 0; ci < list.length; ci++) {
        var sk2 = sinks[list[ci].idx];
        try { if (sk2.handle) { if (rc === 0 && !writeErr) { flushSink(sk2); sk2.handle.flush(); } sk2.handle.close(); sk2.handle = null; } } catch (e) { if (!writeErr) writeErr = e; }
      }
      if (writeErr) throw writeErr;
      if (rc !== 0) {
        var rerr = rc === -2 ? 'is password-protected' : rc === -4 ? 'uses an unsupported 7z codec or exceeds memory limits' : 'is damaged or incomplete';
        throw new Error((msg.name || 'Archive') + ' ' + rerr);
      }
      for (var vi = 0; vi < list.length; vi++) {
        var sk3 = sinks[list[vi].idx], rec3 = sk3.rec;
        var gotCrc = (sk3.crc ^ -1) >>> 0;
        if (sk3.written !== rec3.size || (rec3.hasCrc && gotCrc !== rec3.crc)) {
          throw new Error(rec3.baseName + ' is damaged in the 7z archive: checksum mismatch');
        }
        var hex = ('00000000' + gotCrc.toString(16).toUpperCase()).slice(-8);
        outEntries.push({
          name: rec3.name, baseName: rec3.baseName, size: rec3.size,
          usedOpfs: !!sess, id: rec3.id, crc: hex, blob: sess ? null : new Blob(sk3.parts)
        });
      }
    }
    M._wasm_7z_close();
    postMessage({ type: 'un7z-done', reqId: msg.reqId, entries: outEntries });
  } catch (e) {
    M._wasm_7z_close();
    if (sess) {
      for (var di = 0; di < createdIds.length; di++) {
        try { await sess.removeEntry(createdIds[di], { recursive: true }); } catch (x) {}
      }
    }
    var msgTxt = e && e.name === 'QuotaExceededError' ? 'the browser\u2019s storage is full' : (e && e.message || String(e));
    postMessage({ type: 'un7z-done', reqId: msg.reqId, error: msgTxt });
  }
}

// Parallel CSO v1 / CSO v2 / ZSO (--block=2048) writer for PSP, PS Vita Adrenaline, and PS2 OPL.
// Reads from raw ISO, existing CSO/ZSO, or directly from a DVD CHD; compresses 2,048-byte blocks
// across warm helper workers (or locally) and writes CISO/ZISO header + final aligned index table.
async function runCisoWrite(msg) {
  sinkPending = 0; sinkWaiter = null; lastWriter = null;
  SINK_MAX = msg.debugSinkMax || (64 << 20);
  var started = performance.now();
  await loadModule(msg);
  var backing = await makeBacking(msg);
  postMessage({ type: 'storage', mode: backing.mode, reason: memReason });

  var M = await instantiate({});
  var FS = M.FS, CHDFS = makeFS(FS);
  var bs = new BlobStore(msg.blob);
  var srcStore = null, chdOpen = false, totalBytes = 0, secBuf = 0;
  var fmt = msg.fmt || 'cso1'; // 'cso1' | 'cso2' | 'zso'
  var level = msg.level || 6;
  var helpers = (msg.ports || []).map(function (port) { return { port: port, inflight: 0, dead: false }; });

  try {
    if (msg.sourceKind === 'chd') {
      FS.mkdir('/in');
      var inF = [{ name: 'in.chd', store: bs }];
      if (msg.parent) inF.push({ name: 'parent.chd', store: new BlobStore(msg.parent) });
      FS.mount(CHDFS, { files: inF }, '/in');
      var p1 = M.stringToNewUTF8('/in/in.chd'), p2 = msg.parent ? M.stringToNewUTF8('/in/parent.chd') : 0;
      var kind = M._wasm_probe_open(p1, p2);
      M._free(p1); if (p2) M._free(p2);
      if (kind !== 2) throw new Error('Only DVD/raw CHDs can be converted to CSO or ZSO.');
      totalBytes = M._wasm_probe_logical();
      chdOpen = true;
      secBuf = wasmAlloc(M, 2048);
    } else if (msg.sourceKind === 'ciso') {
      srcStore = new CisoStore(bs, 0, msg.blob.name || 'image');
      srcStore.setModule(M);
      totalBytes = srcStore.sizeV;
    } else {
      srcStore = bs;
      totalBytes = bs.sizeV;
    }
    if (!(totalBytes > 0)) throw new Error('Input image is empty.');
    var bsSize = 2048;
    var nblocks = Math.ceil(totalBytes / bsSize);
    var align = totalBytes > 1900 * 1024 * 1024 ? 2 : 0;
    var shift = 1 << align;
    var indexBytes = (nblocks + 1) * 4;
    var dataStart = Math.ceil((24 + indexBytes) / shift) * shift;

    var outStore = backing.create(msg.outName || (fmt === 'zso' ? 'output.zso' : 'output.cso'));
    if (outStore instanceof StreamStore) {
      outStore.pin = Math.min(32, Math.max(outStore.pin, Math.ceil(dataStart / BLOCK) + 1));
    }

    // Write placeholder header + index table so sequential block writes start at dataStart
    var head = new Uint8Array(24), hdv = new DataView(head.buffer);
    var magic = fmt === 'zso' ? 'ZISO' : 'CISO';
    for (var mi = 0; mi < 4; mi++) head[mi] = magic.charCodeAt(mi);
    hdv.setUint32(4, 24, true);
    hdv.setUint32(8, totalBytes >>> 0, true);
    hdv.setUint32(12, Math.floor(totalBytes / 4294967296) >>> 0, true);
    hdv.setUint32(16, bsSize, true);
    head[20] = fmt === 'cso2' ? 2 : 1;
    head[21] = align;
    outStore.write(head, 0);
    var index = new Uint32Array(nblocks + 1);
    var padHdr = dataStart - (24 + indexBytes);
    if (padHdr > 0) outStore.write(new Uint8Array(padHdr), 24 + indexBytes);

    var writePos = dataStart, doneBlocks = 0, lastProg = 0;
    var BATCH = 512; // 1 MiB per parallel batch
    var padZeros = new Uint8Array(shift);
    function commitBatch(startBlock, lens, flags, outBytes) {
      var o = 0;
      for (var k = 0; k < lens.length; k++) {
        var b = startBlock + k, blen = lens[k], flg = flags[k];
        var entry = ((writePos / shift) >>> 0) & 0x7FFFFFFF;
        if (flg) entry = (entry | 0x80000000) >>> 0;
        index[b] = entry;
        outStore.write(outBytes.subarray(o, o + blen), writePos);
        o += blen;
        writePos += blen;
        var rem = writePos % shift;
        if (rem) {
          var p = shift - rem;
          outStore.write(padZeros.subarray(0, p), writePos);
          writePos += p;
        }
      }
      doneBlocks += lens.length;
      var now = Date.now();
      if (now - lastProg > 120 || doneBlocks >= nblocks) {
        lastProg = now;
        postMessage({
          type: 'prog-bin',
          done: 100 * doneBlocks / nblocks,
          ratio: doneBlocks ? 100 * writePos / (doneBlocks * bsSize) : 100,
          bytesIn: Math.min(totalBytes, doneBlocks * bsSize),
          bytesOut: writePos,
          hunksDone: doneBlocks,
          hunksTotal: nblocks,
          phase: 1
        });
      }
    }

    function readBlocks(startBlock, count) {
      var buf = new Uint8Array(count * bsSize);
      if (chdOpen) {
        for (var i = 0; i < count; i++) {
          if (M._wasm_probe_read(0, (startBlock + i) >>> 0, secBuf) !== 0) throw new Error('Failed to read sector ' + (startBlock + i) + ' from CHD.');
          buf.set(M.HEAPU8.subarray(secBuf, secBuf + bsSize), i * bsSize);
        }
      } else {
        var pos = startBlock * bsSize;
        var want = Math.min(count * bsSize, totalBytes - pos);
        if (want > 0 && srcStore.read(buf.subarray(0, want), pos, want) !== want) throw new Error('Failed to read input image.');
      }
      return buf;
    }

    if (helpers.length > 0) {
      var nextSend = 0, nextCommit = 0, totalBatches = Math.ceil(nblocks / BATCH);
      var readyMap = Object.create(null), batchStarts = Object.create(null);
      await new Promise(function (resolve, reject) {
        var failed = false;
        function pump() {
          if (failed) return;
          while (readyMap[nextCommit]) {
            var res = readyMap[nextCommit];
            delete readyMap[nextCommit];
            try { commitBatch(batchStarts[nextCommit], res.lens, res.flags, res.out); }
            catch (e) { failed = true; reject(e); return; }
            delete batchStarts[nextCommit];
            nextCommit++;
          }
          if (nextCommit >= totalBatches) { resolve(); return; }
          if (sinkFull()) { sinkDrained().then(pump); return; }
          for (var hi = 0; hi < helpers.length && nextSend < totalBatches; hi++) {
            var h = helpers[hi];
            if (h.dead || h.inflight >= 2) continue;
            var seq = nextSend++;
            var sb = seq * BATCH, cnt = Math.min(BATCH, nblocks - sb);
            var blkBuf;
            try { blkBuf = readBlocks(sb, cnt); }
            catch (e) { failed = true; reject(e); return; }
            batchStarts[seq] = sb;
            h.inflight++;
            h.port.postMessage({ type: 'ciso-batch', id: seq, seq: seq, fmt: fmt, level: level, shift: shift, count: cnt, blocks: blkBuf.buffer }, [blkBuf.buffer]);
          }
        }
        helpers.forEach(function (h) {
          h.port.onmessage = function (e) {
            var m = e.data;
            if (failed) return;
            if (m.type === 'error') { failed = true; reject(new Error(m.message || 'helper error')); return; }
            if (m.type !== 'ciso-result') return;
            h.inflight--;
            readyMap[m.seq] = m;
            pump();
          };
        });
        pump();
      });
    } else {
      var inP = wasmAlloc(M, bsSize), outA = wasmAlloc(M, bsSize), outB = wasmAlloc(M, bsSize), cmax = bsSize - shift;
      try {
        for (var sb2 = 0; sb2 < nblocks; sb2 += BATCH) {
          if (sinkFull()) await sinkDrained();
          var cnt2 = Math.min(BATCH, nblocks - sb2);
          var raw = readBlocks(sb2, cnt2);
          var lens = new Uint16Array(cnt2), flags = new Uint8Array(cnt2), out = new Uint8Array(cnt2 * bsSize), o = 0;
          for (var i2 = 0; i2 < cnt2; i2++) {
            var off2 = i2 * bsSize;
            M.HEAPU8.set(raw.subarray(off2, off2 + bsSize), inP);
            var bestLen = bsSize, bestFlag = (fmt === 'cso2') ? 0 : 1, bestPtr = 0;
            if (fmt === 'zso') {
              var zl = M._wasm_lz4_compress_block(inP, bsSize, outA, cmax);
              if (zl > 0 && zl <= cmax) { bestLen = zl; bestFlag = 0; bestPtr = outA; }
            } else if (fmt === 'cso1') {
              var dl = M._wasm_deflate_raw(inP, bsSize, outA, cmax, level);
              if (dl > 0 && dl <= cmax) { bestLen = dl; bestFlag = 0; bestPtr = outA; }
            } else {
              var l2 = M._wasm_lz4_compress_block(inP, bsSize, outA, cmax);
              var d2 = M._wasm_deflate_raw(inP, bsSize, outB, cmax, level);
              if (d2 > 0 && d2 <= cmax && (l2 <= 0 || d2 <= l2)) { bestLen = d2; bestFlag = 0; bestPtr = outB; }
              else if (l2 > 0 && l2 <= cmax) { bestLen = l2; bestFlag = 1; bestPtr = outA; }
            }
            lens[i2] = bestLen;
            flags[i2] = bestFlag;
            if (bestPtr) out.set(M.HEAPU8.subarray(bestPtr, bestPtr + bestLen), o);
            else out.set(raw.subarray(off2, off2 + bsSize), o);
            o += bestLen;
          }
          commitBatch(sb2, lens, flags, out.subarray(0, o));
        }
      } finally {
        M._free(inP); M._free(outA); M._free(outB);
      }
    }

    index[nblocks] = (writePos / shift) >>> 0;
    outStore.write(new Uint8Array(index.buffer, index.byteOffset, index.byteLength), 24);
    var ferr = backing.flush();
    if (ferr) throw new Error(ferr);
    var outputs = await backing.finalize(true);
    helpers.forEach(function (h) { h.port.onmessage = null; try { h.port.close(); } catch (e) {} });
    if (srcStore && srcStore.free) srcStore.free();
    if (secBuf) M._free(secBuf);
    postMessage({ type: 'done', code: 0, outputs: outputs, ms: performance.now() - started });
  } catch (e) {
    helpers.forEach(function (h) { h.port.onmessage = null; try { h.port.close(); } catch (x) {} });
    if (srcStore && srcStore.free) srcStore.free();
    if (secBuf) M._free(secBuf);
    await backing.finalize(false);
    postMessage({ type: 'done', code: -1, error: errText(e), outputs: [], ms: performance.now() - started });
  }
}

// Clean-room Original Xbox XDVDFS scrubber/repacker (.iso -> scrubbed .xiso.iso for xemu).
// Handles both full Redump XGD1 ISOs (partition at 0x18300000) and un-scrubbed XISOs (partition at 0),
// preserving exact XDVDFS AVL directory tables, FILETIME, and attributes while stripping random padding.
async function runXisoRepack(msg) {
  sinkPending = 0; sinkWaiter = null; lastWriter = null;
  SINK_MAX = msg.debugSinkMax || (64 << 20);
  var started = performance.now();
  var backing = await makeBacking(msg);
  postMessage({ type: 'storage', mode: backing.mode, reason: memReason });

  var bs = new BlobStore(msg.blob);
  try {
    var SIG = 'MICROSOFT*XBOX*MEDIA';
    function checkSig(buf, off) {
      for (var i = 0; i < 20; i++) if (buf[off + i] !== SIG.charCodeAt(i)) return false;
      return true;
    }
    var partBase = -1, vd = new Uint8Array(2048);
    var bases = [0x18300000, 0];
    for (var bi = 0; bi < bases.length; bi++) {
      var off = bases[bi] + 32 * 2048;
      if (off + 2048 <= bs.sizeV && bs.read(vd, off, 2048) === 2048 && checkSig(vd, 0) && checkSig(vd, 0x7EC)) {
        partBase = bases[bi];
        break;
      }
    }
    if (partBase < 0) throw new Error('Not a recognized Original Xbox XDVDFS disc image.');

    var vdv = new DataView(vd.buffer);
    var rootSec = vdv.getUint32(0x14, true), rootSize = vdv.getUint32(0x18, true);
    if (!rootSec || !rootSize || rootSize > (64 << 20)) throw new Error('Invalid Xbox XDVDFS root directory.');

    var dirs = [], files = [], totalFileBytes = 0;
    function walkDir(sec, size) {
      var aligned = Math.ceil(size / 2048) * 2048;
      var buf = new Uint8Array(aligned);
      buf.fill(0xFF);
      var byteOff = partBase + sec * 2048;
      if (byteOff + size > bs.sizeV || bs.read(buf.subarray(0, size), byteOff, size) !== size) {
        throw new Error('Truncated Xbox XDVDFS directory at sector ' + sec + '.');
      }
      var dirRec = { origSec: sec, size: size, aligned: aligned, buf: buf, newSec: 0, entries: [] };
      dirs.push(dirRec);
      var dv = new DataView(buf.buffer), visited = Object.create(null), stack = [0];
      while (stack.length) {
        var noff = stack.pop();
        if (noff + 14 > size || (noff & 3) || visited[noff]) continue;
        visited[noff] = true;
        var left = dv.getUint16(noff, true), right = dv.getUint16(noff + 2, true);
        if (left === 0xFFFF && right === 0xFFFF) continue;
        var esec = dv.getUint32(noff + 4, true), esize = dv.getUint32(noff + 8, true);
        var attrs = buf[noff + 12];
        var isDir = (attrs & 0x10) !== 0;
        if (left && left !== 0xFFFF) stack.push(left * 4);
        if (right && right !== 0xFFFF) stack.push(right * 4);
        if (isDir) {
          var child = (esize > 0 && esec > 0) ? walkDir(esec, esize) : null;
          dirRec.entries.push({ nodeOff: noff, isDir: true, child: child });
        } else {
          var frec = (esize > 0 && esec > 0) ? { dir: dirRec, nodeOff: noff, origSec: esec, size: esize, newSec: 0 } : null;
          if (frec) { files.push(frec); totalFileBytes += esize; }
          dirRec.entries.push({ nodeOff: noff, isDir: false, file: frec });
        }
      }
      return dirRec;
    }
    var rootDir = walkDir(rootSec, rootSize);
    files.sort(function (a, b) { return a.origSec - b.origSec; });

    // Assign compact sectors: 0..31 zero, 32 VD, 33.. dirs, then non-empty files
    var nextSec = 33;
    for (var di = 0; di < dirs.length; di++) {
      dirs[di].newSec = nextSec;
      nextSec += dirs[di].aligned / 2048;
    }
    for (var fi = 0; fi < files.length; fi++) {
      files[fi].newSec = nextSec;
      nextSec += Math.ceil(files[fi].size / 2048);
    }

    // Patch directory node sector pointers in-place (preserves exact AVL tree + attributes)
    for (var di2 = 0; di2 < dirs.length; di2++) {
      var dr = dirs[di2], ddv = new DataView(dr.buf.buffer);
      for (var ei = 0; ei < dr.entries.length; ei++) {
        var en = dr.entries[ei];
        var ns = en.isDir ? (en.child ? en.child.newSec : 0) : (en.file ? en.file.newSec : 0);
        ddv.setUint32(en.nodeOff + 4, ns >>> 0, true);
      }
    }
    vdv.setUint32(0x14, rootDir.newSec >>> 0, true);

    var outStore = backing.create(msg.outName || 'output.xiso.iso');
    var totalOutBytes = nextSec * 2048;
    // Sectors 0..31 (64 KiB zero) + Sector 32 (VD)
    outStore.write(new Uint8Array(32 * 2048), 0);
    outStore.write(vd, 32 * 2048);
    var writePos = 33 * 2048;
    for (var di3 = 0; di3 < dirs.length; di3++) {
      outStore.write(dirs[di3].buf, writePos);
      writePos += dirs[di3].aligned;
    }

    var CHUNK = 4 << 20, buf4 = new Uint8Array(CHUNK), doneBytes = 0, lastProg = 0;
    var secPad = new Uint8Array(2048);
    for (var fi2 = 0; fi2 < files.length; fi2++) {
      var fl = files[fi2], srcPos = partBase + fl.origSec * 2048, rem = fl.size;
      while (rem > 0) {
        if (sinkFull()) await sinkDrained();
        var n = Math.min(CHUNK, rem);
        if (bs.read(buf4.subarray(0, n), srcPos, n) !== n) throw new Error('Truncated Xbox file data at sector ' + fl.origSec + '.');
        outStore.write(buf4.subarray(0, n), writePos);
        srcPos += n; writePos += n; rem -= n; doneBytes += n;
        var now = Date.now();
        if (now - lastProg > 120) {
          lastProg = now;
          postMessage({
            type: 'prog-bin',
            done: totalFileBytes ? 100 * doneBytes / totalFileBytes : 100,
            ratio: bs.sizeV ? 100 * totalOutBytes / bs.sizeV : 100,
            bytesIn: doneBytes, bytesOut: writePos,
            hunksDone: fi2 + 1, hunksTotal: files.length, phase: 1
          });
        }
      }
      var tail = fl.size % 2048;
      if (tail) {
        var pad = 2048 - tail;
        outStore.write(secPad.subarray(0, pad), writePos);
        writePos += pad;
      }
    }
    var ferr = backing.flush();
    if (ferr) throw new Error(ferr);
    var outputs = await backing.finalize(true);
    postMessage({
      type: 'done', code: 0, outputs: outputs, ms: performance.now() - started,
      xisoMeta: { origBytes: bs.sizeV, outBytes: writePos, fileCount: files.length, dirCount: dirs.length }
    });
  } catch (e) {
    await backing.finalize(false);
    postMessage({ type: 'done', code: -1, error: errText(e), outputs: [], ms: performance.now() - started });
  }
}

// Multi-session DiscJuggler .cdi -> .cue + track .bin unpacker
async function runCdiExtract(msg) {
  sinkPending = 0; sinkWaiter = null; lastWriter = null;
  SINK_MAX = msg.debugSinkMax || (64 << 20);
  var started = performance.now();
  var backing = await makeBacking(msg);
  postMessage({ type: 'storage', mode: backing.mode, reason: memReason });

  var bs = new BlobStore(msg.blob);
  try {
    var cueBytes = new TextEncoder().encode(msg.cueText);
    var cueStore = backing.create(msg.cueName);
    cueStore.write(cueBytes, 0);
    var tracks = msg.tracks || [], totalBytes = 0, doneBytes = 0, lastProg = 0;
    for (var ti = 0; ti < tracks.length; ti++) totalBytes += tracks[ti].count * tracks[ti].dataSize;
    var buf = new Uint8Array(2 << 20);
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      var slice = new StrideSliceStore(bs, tr.offset, tr.count, tr.dataSize, tr.stride);
      var outStore = backing.create(tr.name);
      for (var pos = 0; pos < slice.sizeV; pos += buf.length) {
        if (sinkFull()) await sinkDrained();
        var n = Math.min(buf.length, slice.sizeV - pos);
        if (slice.read(buf.subarray(0, n), pos, n) !== n) throw new Error('Truncated CDI track ' + (i + 1) + '.');
        outStore.write(buf.subarray(0, n), pos);
        doneBytes += n;
        var now = Date.now();
        if (now - lastProg > 120) {
          lastProg = now;
          postMessage({ type: 'prog-bin', done: totalBytes ? 100 * doneBytes / totalBytes : 100, ratio: 100, bytesIn: doneBytes, bytesOut: doneBytes, hunksDone: i + 1, hunksTotal: tracks.length, phase: 2 });
        }
      }
      slice.free();
    }
    var ferr = backing.flush();
    if (ferr) throw new Error(ferr);
    var outputs = await backing.finalize(true);
    postMessage({ type: 'done', code: 0, outputs: outputs, ms: performance.now() - started });
  } catch (e) {
    await backing.finalize(false);
    postMessage({ type: 'done', code: -1, error: errText(e), outputs: [], ms: performance.now() - started });
  }
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
      // each piece where the last one ended (missing bytes would read as zeros)
      if (msg.pos !== stageWaiter.at) throw new Error('a piece of the file is missing');
      stageWaiter.dst.write(new Uint8Array(msg.data), msg.pos);
      stageWaiter.at = msg.pos + msg.data.byteLength;
      stageWaiter.onChunk(stageWaiter.at);
      postMessage({ type: 'stage-ack' });
    } catch (err) { stageWaiter.reject(err && typeof err.errno === 'number' ? err : new Error('could not store the copy (' + (err && err.name || err) + ')')); }
    return;
  }
  if (msg.type === 's-ack') { sinkAck(msg.bytes); return; }
  if (msg.type === 'stage-end' && stageWaiter) {
    if (stageWaiter.at < stageWaiter.size) stageWaiter.reject(new Error('could not store the copy (the page sent only ' + stageWaiter.at + ' of its ' + stageWaiter.size + ' bytes)'));
    else stageWaiter.resolve();
    return;
  }
  if (msg.type === 'stage-fail' && stageWaiter) { stageWaiter.reject(new Error(msg.message)); return; }
  if (msg.type === 'attach') { attachHelper(msg); return; }
  if (msg.type === 'detach') { attachHelper({ port: null }); return; }
  if (msg.type === 'visibility') {
    ckptUrgent = !!msg.hidden;
    if (msg.hidden && activeBacking && activeBacking.flush) { try { activeBacking.flush(); } catch (err) { /* ignore */ } }
    return;
  }
  if (msg.type === 'throttle') {
    if (coordM && coordM.setThrottle) coordM.setThrottle(msg.max);
    return;
  }
  if (msg.type === 'unzip') { runUnzip(msg).catch(function (err) { postMessage({ type: 'unzip-done', reqId: msg.reqId, error: errText(err) }); }); return; }
  if (msg.type === 'un7z') { runUn7z(msg).catch(function (err) { postMessage({ type: 'un7z-done', reqId: msg.reqId, error: errText(err) }); }); return; }
  if (msg.type === 'crc') { runCrc(msg).catch(function (err) { postMessage({ type: 'fatal', message: errText(err) }); }); return; }
  var p = msg.type === 'helper' ? runHelper(msg)
    : msg.type === 'run' ? runJob(msg)
    : msg.type === 'ciso-write' ? runCisoWrite(msg)
    : msg.type === 'xiso-repack' ? runXisoRepack(msg)
    : msg.type === 'cdi-extract' ? runCdiExtract(msg)
    : msg.type === 'reader' ? runReader(msg)
    : null;
  if (p) p.catch(function (err) { postMessage({ type: 'fatal', message: err && typeof err.errno === 'number' ? errText(err) : String(err && err.stack || err && err.message || err) }); });
};
