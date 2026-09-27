/* chdman web worker: runs one chdman command (role "job") or compresses hunks for
   another worker (role "helper"). Appended after the Emscripten glue (createChdman). */
'use strict';

var ERR = { ENOENT: 44, EPERM: 63, EIO: 29, EINVAL: 28, EEXIST: 20, ENOTEMPTY: 55, ENOSPC: 51, EISDIR: 31 };
var S_IFDIR = 0o040000, S_IFREG = 0o100000;
var DIR_MODE = S_IFDIR | 0o777, FILE_MODE = S_IFREG | 0o777;
var BLOCK = 1 << 20;
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

function OpfsStore(slot) {
  this.slot = slot;
  this.h = slot.handle;
  this.sizeV = 0;
}
OpfsStore.prototype.read = function (dst, pos, len) {
  if (pos >= this.sizeV) return 0;
  len = Math.min(len, this.sizeV - pos);
  return this.h.read(dst.subarray(0, len), { at: pos });
};
OpfsStore.prototype.write = function (src, pos) {
  var n;
  try { n = this.h.write(src, { at: pos }); }
  catch (e) {
    postMessage({ type: 'notice', level: 'error', message: 'Storage full: the browser refused to write more data (' + (e && e.name || e) + ').' });
    throw { errno: ERR.ENOSPC };
  }
  if (n !== src.length) throw { errno: ERR.ENOSPC };
  if (pos + n > this.sizeV) this.sizeV = pos + n;
  return n;
};
OpfsStore.prototype.truncate = function (n) {
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
  var upto = Math.floor(pos / BLOCK) - 1;
  for (var k = PIN; k < upto; k++) {
    var ch = this.chunks[k];
    if (ch) {
      this.chunks[k] = null;
      this.flushed[k] = true;
      postMessage({ type: 's-write', id: this.id, pos: k * BLOCK, data: ch }, [ch.buffer]);
    }
  }
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
  var streaming = msg.outMode === 'stream';
  return {
    mode: streaming ? 'stream' : dir ? 'opfs' : 'mem',
    create: function (name, writableCopy) {
      var slot = slots.find(function (s) { return !s.used; });
      var store;
      if (streaming && !writableCopy) store = new StreamStore(name);
      else if (slot) { slot.used = true; store = new OpfsStore(slot); slot.store = store; }
      else store = new MemStore();
      store.name = name;
      registry.push(store);
      return store;
    },
    finalize: async function (keep) {
      var outputs = [];
      registry.forEach(function (st) {
        if (st instanceof StreamStore) {
          st.finish(keep);
          if (keep && !st.deleted) outputs.push({ name: st.name, size: st.sizeV, kind: 'disk', id: st.id });
          return;
        }
        if (st.deleted || !keep) return;
        if (st instanceof OpfsStore) {
          try { st.h.flush(); } catch (e) { /* ignore */ }
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
    if (now - last > 300) { last = now; postMessage({ type: 'progress', text: 'Copying input, ' + (100 * pos / size).toFixed(1) + '% complete' }); }
  }
  try {
    if (msg.debugStage === 2) throw new Error('debug');
    for (; pos < size; pos += step) {
      var ab = await blob.slice(pos, Math.min(size, pos + step)).arrayBuffer();
      dst.write(new Uint8Array(ab), pos);
      prog();
    }
  } catch (e) {
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

/* ---------------- multi-core compression (job side) ---------------- */

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
        var items = b.items.slice(0, b.n);
        var data = b.n === batchSize ? b.buf : b.buf.slice(0, b.n * hunkbytes);
        h.port.postMessage({ type: 'batch', id: ++seq, items: items, data: data.buffer }, [items.buffer, data.buffer]);
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

  M.parSetup = function (hb, ub, comps) {
    if (!helpers.length) return false;
    // the LaserDisc codec (avhu) reads settings from the CHD's own metadata: keep it single-threaded
    if (comps.indexOf(0x61766875) >= 0) return false;
    hunkbytes = hb;
    batchSize = Math.max(1, Math.min(64, Math.floor((512 * 1024) / hb)));
    scratch = M._malloc(hb + 64);
    helpers.forEach(function (h) { h.port.postMessage({ type: 'init', hunkbytes: hb, unitbytes: ub, comps: comps }); });
    M.parActive = true;
    postMessage({ type: 'notice', level: 'debug', message: 'multi-core compression: ' + helpers.length + ' helper threads, batch ' + batchSize });
    return true;
  };
  M.parSubmit = function (item, ptr, len) {
    if (!open) open = { n: 0, items: new Uint32Array(batchSize), buf: new Uint8Array(batchSize * hunkbytes) };
    open.buf.set(M.HEAPU8.subarray(ptr, ptr + len), open.n * hunkbytes);
    open.items[open.n++] = item;
    fifo.push(item);
    if (open.n === batchSize) flushOpen();
  };
  M.parYield = function (wakeUp) {
    if (failed) {
      // abort the whole run: helper failed, results would be incomplete
      postMessage({ type: 'fatal', message: 'Multi-core compression failed (' + failed + '). Try again with 1 thread in Settings.' });
      return; // never wake: the job worker is terminated by the page
    }
    dispatch();
    headDone();
    sleeper = wakeUp;
    maybeWake();
  };
}

/* ---------------- helper role ---------------- */

async function runHelper(msg) {
  await loadModule(msg);
  var M = await instantiate({});
  var port = msg.port;
  var inbuf = 0, outbuf = 0, res = M._malloc(16), sha = M._malloc(32), hb = 0;
  port.onmessage = function (e) {
    var m = e.data;
    try {
      if (m.type === 'init') {
        var r = M._wasm_helper_init(m.hunkbytes, m.unitbytes, m.comps[0], m.comps[1], m.comps[2], m.comps[3]);
        if (r !== 0) throw new Error('codec init failed (' + r + ')');
        inbuf = M._wasm_helper_inbuf();
        outbuf = M._wasm_helper_outbuf();
        hb = m.hunkbytes;
        return;
      }
      if (m.type === 'batch') {
        var n = m.items.length, data = new Uint8Array(m.data);
        var meta = new Int32Array(n * 3), sha1 = new Uint8Array(n * 20), parts = [], total = 0;
        for (var i = 0; i < n; i++) {
          M.HEAPU8.set(data.subarray(i * hb, (i + 1) * hb), inbuf);
          var c = M._wasm_helper_compress(res, sha);
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
      port.postMessage({ type: 'error', message: String(err && err.message || err) });
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

async function runJob(msg) {
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
        postMessage({ type: 'done', code: -1, readFail: true, error: 'The browser could not read "' + inputs[ii].name + '": ' + (e && e.message || e), outputs: [] });
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

  var out = makeLineSink(1), err = makeLineSink(2);
  var resolveExit, rejectExit, finished = false;
  var exited = new Promise(function (res, rej) { resolveExit = res; rejectExit = rej; });
  var M = await instantiate({
    stdin: function () { return null; },
    stdout: function (c) { out.put(c); },
    stderr: function (c) { err.put(c); },
    onExit: function (code) { if (!finished) { finished = true; resolveExit(code); } },
    onAbort: function (what) { if (!finished) { finished = true; rejectExit(new Error('chdman stopped unexpectedly: ' + what)); } }
  });

  var FS = M.FS, CHDFS = makeFS(FS);
  FS.mkdir('/in');
  FS.mount(CHDFS, { files: inStores }, '/in');
  FS.mkdir('/out');
  FS.mount(CHDFS, { files: outFiles, backing: backing }, '/out');
  FS.chdir('/out');

  if (msg.ports && msg.ports.length) setupParallel(M, msg.ports);

  var started = performance.now();
  try {
    var ret = M.callMain(msg.args);
    var A = M.__asyncify;
    if (A && A.currData) {
      // main() is suspended waiting for helper threads; it finishes asynchronously
      A.whenDone().then(function (code) {
        try { M._fflush(0); } catch (e) { /* ignore */ }
        if (!finished) { finished = true; resolveExit(code); }
      }, function (e) { if (!finished) { finished = true; rejectExit(e); } });
    } else if (typeof ret === 'number' && !finished) { finished = true; resolveExit(ret); }
  } catch (e) {
    if (!(e && e.name === 'ExitStatus')) {
      if (!finished) { finished = true; rejectExit(e); }
    }
  }
  var code;
  try { code = await exited; }
  catch (e) {
    out.flush(); err.flush();
    await backing.finalize(false);
    await dropStages();
    postMessage({ type: 'done', code: -1, error: String(e && e.message || e), outputs: [], ms: performance.now() - started });
    return;
  }
  out.flush(); err.flush();
  var outputs = await backing.finalize(true);
  await dropStages();
  postMessage({ type: 'done', code: code, outputs: outputs, ms: performance.now() - started },
    []);
}

/* ---------------- game identification helpers ---------------- */

// CHD sector reader: answers {type:'read', id, track, lba} with 2048 bytes of user data
async function runReader(msg) {
  await loadModule(msg);
  var M = await instantiate({});
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
    var r = M._wasm_probe_read(m.track | 0, m.lba >>> 0, buf);
    postMessage({ type: 'sector', id: m.id, data: r === 0 ? M.HEAPU8.slice(buf, buf + 2048) : null });
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
function runCrc(msg) {
  var blob = msg.blob, start = msg.start || 0, end = msg.end != null ? msg.end : blob.size;
  var crc = -1, step = 8 << 20, r = getReader(), last = 0;
  for (var pos = start; pos < end; pos += step) {
    var chunk = new Uint8Array(r.readAsArrayBuffer(blob.slice(pos, Math.min(end, pos + step))));
    crc = crcUpdate(crc, chunk);
    var now = Date.now();
    if (now - last > 250) { last = now; postMessage({ type: 'crc-progress', done: pos - start, total: end - start }); }
  }
  crc = (crc ^ -1) >>> 0;
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
    } catch (err) { stageWaiter.reject(new Error('could not store the copy (' + (err && err.name || err) + ')')); }
    return;
  }
  if (msg.type === 'stage-end' && stageWaiter) { stageWaiter.resolve(); return; }
  if (msg.type === 'stage-fail' && stageWaiter) { stageWaiter.reject(new Error(msg.message)); return; }
  if (msg.type === 'crc') { try { runCrc(msg); } catch (err) { postMessage({ type: 'fatal', message: String(err && err.message || err) }); } return; }
  var p = msg.type === 'helper' ? runHelper(msg) : msg.type === 'run' ? runJob(msg) : msg.type === 'reader' ? runReader(msg) : null;
  if (p) p.catch(function (err) { postMessage({ type: 'fatal', message: String(err && err.stack || err && err.message || err) }); });
};
