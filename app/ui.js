'use strict';
(function () {

/* ============================================================
   small helpers
   ============================================================ */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
function el(tag, attrs) {
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.setAttribute('style', v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (c == null || c === false) continue;
    if (Array.isArray(c)) c.forEach(function (x) { if (x != null && x !== false) e.append(x); });
    else e.append(c);
  }
  return e;
}
function icon(id) {
  var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  var u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.appendChild(u);
  return s;
}
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + ' ' + u[i];
}
function fmtDur(s) {
  if (!isFinite(s) || s < 0) return '';
  s = Math.round(s);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function ext(name) { var m = /\.([^.\/\\]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }
function base(name) { return name.replace(/^.*[\/\\]/, ''); }
function stem(name) { return base(name).replace(/\.[^.]*$/, ''); }
function dirOf(path) { var i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
function uid() { return Math.random().toString(36).slice(2, 10); }
function quoteArg(a) { return /^[A-Za-z0-9_.,:\/=+-]+$/.test(a) ? a : '"' + a.replace(/"/g, '\\"') + '"'; }
function plural(n, w, p) { return n + ' ' + (n === 1 ? w : (p || w + 's')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var toastBox = null;
function toast(msg, kind, ms) {
  toastBox = toastBox || $('#toasts');
  var t = el('div', { class: 'toast' + (kind === 'err' ? ' err' : ''), role: kind === 'err' ? 'alert' : 'status' }, msg);
  toastBox.appendChild(t);
  setTimeout(function () { t.remove(); }, ms || (kind === 'err' ? 7000 : 3800));
}

/* ============================================================
   settings
   ============================================================ */
var isMobile = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
var cores = Math.max(1, navigator.hardwareConcurrency || 4);
var maxThreads = Math.min(cores, 16);
// threads: 'auto' (measured per device, see Tuning) or a fixed number of compression threads
var settings = { threads: 'auto', storage: 'auto', wake: true, theme: '', rename: true, scroll: 'auto', keepCue: false };
var outDir = null; // folder picked for direct writing (not persisted)
try {
  var saved = JSON.parse(localStorage.getItem('chdman-web-settings') || '{}');
  for (var sk in saved) if (sk in settings) settings[sk] = saved[sk];
} catch (e) { /* storage may be unavailable */ }
if (settings.threads !== 'auto') settings.threads = Math.max(1, Math.min(maxThreads, settings.threads | 0 || 1));
function saveSettings() {
  try { localStorage.setItem('chdman-web-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
function applyTheme() {
  if (settings.theme) document.documentElement.setAttribute('data-theme', settings.theme);
  else document.documentElement.removeAttribute('data-theme');
}
applyTheme();

/* ============================================================
   engine: WebAssembly + workers
   ============================================================ */
var SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
var EH_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]);

function b64bytes(s) {
  s = s.replace(/\s+/g, '');
  var bin = atob(s), n = bin.length, out = new Uint8Array(n);
  for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// minimal raw-DEFLATE decoder, used only when DecompressionStream is missing
function inflateRaw(src, outLen) {
  var out = new Uint8Array(outLen), op = 0, ip = 0, bb = 0, bc = 0;
  function bits(n) {
    while (bc < n) { bb |= src[ip++] << bc; bc += 8; }
    var v = bb & ((1 << n) - 1);
    bb >>>= n; bc -= n;
    return v;
  }
  function build(lens, n) {
    var count = new Uint16Array(16), sym = new Uint16Array(n), offs = new Uint16Array(16), i;
    for (i = 0; i < n; i++) count[lens[i]]++;
    count[0] = 0;
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (i = 0; i < n; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
    return { count: count, sym: sym };
  }
  function decode(t) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len < 16; len++) {
      code |= bits(1);
      var c = t.count[len];
      if (code - c < first) return t.sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('corrupt data');
  }
  var LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var ORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  var fixedL = null, fixedD = null, last, type, i;
  do {
    last = bits(1); type = bits(2);
    if (type === 0) {
      bb = 0; bc = 0;
      var len = src[ip] | (src[ip + 1] << 8);
      ip += 4;
      out.set(src.subarray(ip, ip + len), op);
      ip += len; op += len;
      continue;
    }
    var lt, dt;
    if (type === 1) {
      if (!fixedL) {
        var l = new Uint8Array(288);
        for (i = 0; i < 144; i++) l[i] = 8;
        for (; i < 256; i++) l[i] = 9;
        for (; i < 280; i++) l[i] = 7;
        for (; i < 288; i++) l[i] = 8;
        fixedL = build(l, 288);
        var d = new Uint8Array(30).fill(5);
        fixedD = build(d, 30);
      }
      lt = fixedL; dt = fixedD;
    } else if (type === 2) {
      var nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      var cl = new Uint8Array(19);
      for (i = 0; i < ncode; i++) cl[ORD[i]] = bits(3);
      var ct = build(cl, 19), lens = new Uint8Array(nlen + ndist);
      for (i = 0; i < nlen + ndist;) {
        var s = decode(ct);
        if (s < 16) lens[i++] = s;
        else {
          var rep = 0, val = 0;
          if (s === 16) { val = lens[i - 1]; rep = 3 + bits(2); }
          else if (s === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          while (rep--) lens[i++] = val;
        }
      }
      lt = build(lens.subarray(0, nlen), nlen);
      dt = build(lens.subarray(nlen), ndist);
    } else throw new Error('corrupt data');
    for (;;) {
      var sym = decode(lt);
      if (sym < 256) out[op++] = sym;
      else if (sym === 256) break;
      else {
        sym -= 257;
        var n = LB[sym] + bits(LE[sym]);
        var ds = decode(dt);
        var dist = DB[ds] + bits(DE[ds]);
        for (var k = 0; k < n; k++, op++) out[op] = out[op - dist];
      }
    }
  } while (!last);
  return out;
}

async function gunzip(bytes, size) {
  if (typeof DecompressionStream === 'function') {
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { /* fall back */ }
  }
  return inflateRaw(bytes.subarray(10), size);
}

// writes results streamed by the worker into a folder the user picked
function makeSink(dir) {
  var files = {}, failed = null;
  function fail(e) { if (!failed) failed = e; }
  function q(id, fn) {
    var f = files[id];
    if (!f) return;
    f.chain = f.chain.then(function () { if (!failed) return fn(f); }).catch(fail);
  }
  return {
    handle: function (m) {
      if (m.type === 's-open') {
        var f = files[m.id] = { name: m.name, w: null, closed: false, size: 0 };
        f.chain = dir.getFileHandle(m.name, { create: true })
          .then(function (fh) { return fh.createWritable({ keepExistingData: false }); })
          .then(function (w) { f.w = w; }).catch(fail);
      } else if (m.type === 's-write') {
        q(m.id, function (f) { return f.w.write({ type: 'write', position: m.pos, data: m.data }); });
      } else if (m.type === 's-trunc') {
        q(m.id, function (f) { return f.w.truncate(m.size); });
      } else if (m.type === 's-close') {
        q(m.id, function (f) { f.closed = true; f.size = m.size; return f.w.close(); });
      } else if (m.type === 's-remove') {
        q(m.id, function (f) { f.closed = true; return f.w.abort().then(function () { return dir.removeEntry(f.name); }).catch(function () {}); });
      }
    },
    finish: function () {
      return Promise.all(Object.keys(files).map(function (k) { return files[k].chain; })).then(function () { if (failed) throw failed; });
    },
    abort: function () {
      Object.keys(files).forEach(function (k) {
        var f = files[k];
        f.chain = f.chain.then(function () {
          if (f.w && !f.closed) return f.w.abort().catch(function () {}).then(function () { return dir.removeEntry(f.name).catch(function () {}); });
        }).catch(function () {});
      });
    }
  };
}

var DEBUG = {};
try { DEBUG = JSON.parse(localStorage.getItem('chdman-web-debug') || '{}'); } catch (e) { /* ignore */ }

var Engine = {
  module: null, bytes: null, url: null, loading: null, error: null, simd: false,
  ready: function () {
    if (!this.loading) this.loading = this._load();
    return this.loading;
  },
  _load: async function () {
    if (typeof WebAssembly !== 'object') throw new Error('This browser does not support WebAssembly.');
    if (!WebAssembly.validate(EH_TEST)) throw new Error('This browser is too old: it lacks WebAssembly exception handling (needs Chrome 95+, Firefox 100+, Safari 15.2+).');
    if (typeof Worker !== 'function') throw new Error('This browser does not support Web Workers.');
    this.simd = WebAssembly.validate(SIMD_TEST);
    var node = document.getElementById(this.simd ? 'wasm-simd' : 'wasm-base');
    var bytes = await gunzip(b64bytes(node.textContent), +node.getAttribute('data-size'));
    node.textContent = '';
    this.bytes = bytes;
    this.module = await WebAssembly.compile(bytes);
    var src = document.getElementById('worker-src').textContent;
    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return this;
  },
  post: function (w, msg, transfer) {
    try { msg.wasmModule = this.module; w.postMessage(msg, transfer || []); }
    catch (e) { delete msg.wasmModule; msg.wasmBytes = this.bytes; w.postMessage(msg, transfer || []); }
  },
  // runs one chdman command; returns {promise, cancel}
  run: function (o) {
    var self = this, worker = null, helpers = [], finished = false, rejectFn;
    var sink = o.outMode === 'stream' ? makeSink(o.outDir) : null;
    var ackWait = null;
    // the worker could not read an input itself: read it here and send it over
    async function feedStage(m) {
      var blob = o.inputs[m.index].blob, step = 4 << 20;
      try {
        for (var pos = m.from; pos < blob.size; pos += step) {
          if (finished) return;
          var ab = await blob.slice(pos, Math.min(blob.size, pos + step)).arrayBuffer();
          await new Promise(function (res) { ackWait = res; worker.postMessage({ type: 'stage-chunk', pos: pos, data: ab }, [ab]); });
        }
        if (!finished) worker.postMessage({ type: 'stage-end' });
      } catch (e) {
        if (!finished) worker.postMessage({ type: 'stage-fail', message: (e && e.message) || String(e) });
      }
    }
    function cleanup() {
      finished = true;
      if (worker) worker.terminate();
      helpers.forEach(function (h) { h.terminate(); });
      helpers = [];
    }
    var promise = new Promise(function (resolve, reject) {
      rejectFn = reject;
      try { worker = new Worker(self.url); }
      catch (e) { reject(new Error('Could not start a background worker (' + e.message + '). If you opened this file directly, try another browser.')); return; }
      var ports = [];
      for (var i = 0; i < (o.helpers || 0); i++) {
        try {
          var hw = new Worker(self.url), ch = new MessageChannel();
          self.post(hw, { type: 'helper', port: ch.port2 }, [ch.port2]);
          helpers.push(hw);
          ports.push(ch.port1);
        } catch (e) { break; }
      }
      worker.onmessage = function (e) {
        var m = e.data;
        if (finished) return;
        if (m.type.charAt(0) === 's' && m.type.charAt(1) === '-') { if (sink) sink.handle(m); }
        else if (m.type === 'stage-request') feedStage(m);
        else if (m.type === 'stage-ack') { var a = ackWait; ackWait = null; if (a) a(); }
        else if (m.type === 'line') o.onLine && o.onLine(m.stream, m.text);
        else if (m.type === 'progress') o.onProgress && o.onProgress(m.text);
        else if (m.type === 'notice') o.onNotice && o.onNotice(m);
        else if (m.type === 'storage') o.onStorage && o.onStorage(m.mode);
        else if (m.type === 'fatal') { cleanup(); if (sink) sink.abort(); reject(new Error(m.message)); }
        else if (m.type === 'done') {
          cleanup();
          if (!sink) { resolve(m); return; }
          o.onProgress && o.onProgress('Saving to folder, 100% complete');
          sink.finish().then(function () { resolve(m); }, function (e) {
            reject(new Error('Could not write to the output folder: ' + (e && e.message || e)));
          });
        }
      };
      worker.onerror = function (e) {
        if (finished) return;
        cleanup();
        reject(new Error(e.message || 'The background worker failed to start.'));
      };
      self.post(worker, {
        type: 'run', jobId: o.jobId, dirPath: o.dirPath, args: o.args, inputs: o.inputs || [],
        writable: o.writable || [], slots: o.slots || 0, outMode: o.outMode || 'mem', ports: ports, debugStage: DEBUG.stage
      }, ports);
    });
    return {
      promise: promise,
      cancel: function () {
        if (finished) return;
        cleanup();
        if (sink) sink.abort();
        var err = new Error('Canceled');
        err.canceled = true;
        rejectFn(err);
      }
    };
  }
};

/* ============================================================
   automatic thread count
   Once per device and browser, helper workers compress the same synthetic data at
   1, 2, 3… threads until an extra thread stops adding speed. Measuring beats guessing
   from the device: browsers may under-report cores, fast and efficient cores differ,
   and nothing depends on recognizing the device, so old devices simply settle low.
   ============================================================ */
var Tuning = {
  result: null, running: null,
  // up to 8 on phones and tablets, 16 elsewhere, whatever the browser reports
  cap: isMobile ? 8 : 16,
  key: function () { return cores + '|' + navigator.userAgent; },
  load: function () {
    try {
      var t = JSON.parse(localStorage.getItem('chdman-web-tuning') || 'null');
      this.result = t && t.key === this.key() && t.threads >= 1 ? t : null;
    } catch (e) { this.result = null; }
  },
  measure: function (onStep) {
    var self = this;
    if (!this.running) {
      this.running = this._measure(onStep).then(function (t) {
        self.result = t;
        try { localStorage.setItem('chdman-web-tuning', JSON.stringify(t)); } catch (e) { /* ignore */ }
        self.running = null;
        updateChips();
        return t;
      }, function (e) { self.running = null; throw e; });
    }
    return this.running;
  },
  _measure: async function (onStep) {
    await Engine.ready();
    var HB = 4096, BATCH = 16, WARM = 250, WINDOW = 500, seq = 0;
    // the default DVD codecs (lzma, zlib, huff, flac): the same work as a real conversion
    var comps = [0x6c7a6d61, 0x7a6c6962, 0x68756666, 0x666c6163];
    var rnd = 0x9e3779b9;
    function batch() {
      var d = new Uint8Array(HB * BATCH), dv = new DataView(d.buffer);
      for (var h = 0; h < BATCH; h++) {
        var o = h * HB;
        dv.setUint32(o, ++seq); // every hunk unique, so none is skipped as a duplicate
        for (var i = 8; i < HB; i++) {
          rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
          // half text-like (compressible), half noise, like a typical disc
          d[o + i] = i < HB / 2 ? 97 + ((rnd >>> 0) % 12) : rnd & 255;
        }
      }
      return d;
    }
    var pool = [], steps = [], best = 0, bestN = 1, misses = 0;
    function spawn() {
      var w = new Worker(Engine.url), ch = new MessageChannel();
      Engine.post(w, { type: 'helper', port: ch.port2 }, [ch.port2]);
      ch.port1.postMessage({ type: 'init', hunkbytes: HB, unitbytes: 2048, comps: comps });
      var h = { w: w, port: ch.port1, done: 0, counting: false, live: false };
      ch.port1.onmessage = function (e) {
        if (e.data.type !== 'result') return;
        if (h.counting) h.done += BATCH;
        send(h);
      };
      return h;
    }
    function send(h) {
      var d = batch();
      h.port.postMessage({ type: 'batch', id: 0, items: new Uint32Array(BATCH), data: d.buffer }, [d.buffer]);
    }
    try {
      var counts = [1, 2, 3, 4, 6, 8, 10, 12, 14, 16].filter(function (n) { return n <= Tuning.cap; });
      for (var ci = 0; ci < counts.length; ci++) {
        var n = counts[ci];
        while (pool.length < n) pool.push(spawn());
        pool.forEach(function (h) { if (!h.live) { h.live = true; send(h); send(h); } });
        await sleep(WARM);
        pool.forEach(function (h) { h.done = 0; h.counting = true; });
        var t0 = performance.now();
        await sleep(WINDOW);
        var dt = (performance.now() - t0) / 1000;
        pool.forEach(function (h) { h.counting = false; });
        var rate = pool.reduce(function (a, h) { return a + h.done; }, 0) * HB / 1048576 / dt;
        steps.push([n, +rate.toFixed(2)]);
        if (onStep) onStep(n, rate);
        if (rate > best * 1.08) { best = rate; bestN = n; misses = 0; }
        // past the reported core count one miss ends it; below it, allow one noisy step
        else if (++misses >= (n > cores ? 1 : 2)) break;
      }
    } finally {
      pool.forEach(function (h) { h.w.terminate(); });
    }
    return { key: this.key(), threads: bestN, rate: +best.toFixed(2), steps: steps, cores: cores, date: Date.now() };
  }
};
Tuning.load();
// compression threads to use now
function threadCount() {
  if (settings.threads !== 'auto') return settings.threads;
  return Tuning.result ? Tuning.result.threads : Math.min(maxThreads, isMobile ? 4 : 8);
}
// helper workers for verify and extract, which decompress the hunks chdman is about to read. The job
// worker stays busy reading, checking and writing (most of the work for DVDs), so it keeps a core.
function readHelpers() {
  var nt = threadCount();
  return nt > 1 ? Math.max(1, Math.min(nt, cores - 1)) : 0;
}
// before a compressing job in automatic mode: measure the device once
async function ensureTuned(report) {
  if (settings.threads !== 'auto' || Tuning.result) return;
  try {
    await Tuning.measure(report);
  } catch (e) { /* fall back to the default guess */ }
}

/* ============================================================
   private browser storage (OPFS) bookkeeping
   ============================================================ */
var Store = {
  available: false,
  session: 's' + Date.now().toString(36) + uid(),
  init: async function () {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) { this.checked = true; return; }
      var root = await navigator.storage.getDirectory();
      var work = await root.getDirectoryHandle('chdman-work', { create: true });
      this.available = true;
      if (navigator.locks && navigator.locks.request) {
        navigator.locks.request('chdman-web-' + this.session, function () { return new Promise(function () {}); });
        await sleep(50);
      }
      await this.cleanupStale(work);
    } catch (e) {
      this.available = false;
    }
    this.checked = true;
  },
  cleanupStale: async function (work) {
    var held = null;
    try {
      if (navigator.locks && navigator.locks.query) {
        var q = await navigator.locks.query();
        held = new Set((q.held || []).map(function (l) { return l.name; }));
      }
    } catch (e) { held = null; }
    var names = [];
    try { for await (var entry of work.keys()) names.push(entry); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (n === this.session) continue;
      var stale;
      if (held) stale = !held.has('chdman-web-' + n);
      else {
        var t = parseInt(n.slice(1, 9), 36);
        stale = !t || Date.now() - t > 6 * 3600e3;
      }
      if (stale) { try { await work.removeEntry(n, { recursive: true }); } catch (e) { /* in use */ } }
    }
  },
  dirPath: function (jobId) { return ['chdman-work', this.session, jobId]; },
  file: async function (jobId, slot) {
    var d = await navigator.storage.getDirectory();
    var p = this.dirPath(jobId);
    for (var i = 0; i < p.length; i++) d = await d.getDirectoryHandle(p[i]);
    return (await d.getFileHandle(slot)).getFile();
  },
  removeJob: async function (jobId) {
    if (!this.available) return;
    try {
      var d = await navigator.storage.getDirectory();
      d = await d.getDirectoryHandle('chdman-work');
      d = await d.getDirectoryHandle(this.session);
      await d.removeEntry(jobId, { recursive: true });
    } catch (e) { /* ignore */ }
  },
  estimate: async function () {
    try { return await navigator.storage.estimate(); } catch (e) { return null; }
  }
};

/* ============================================================
   disc descriptors (.cue / .gdi / .toc)
   ============================================================ */
function tokenize(line) {
  var re = /"([^"]*)"|(\S+)/g, out = [], m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}
function parseRefs(kind, text) {
  var refs = [], lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (kind === 'cue') {
    lines.forEach(function (ln) {
      var m = /^\s*FILE\s+(?:"([^"]*)"|(\S+))/i.exec(ln);
      if (m) refs.push(m[1] != null ? m[1] : m[2]);
    });
  } else if (kind === 'toc') {
    lines.forEach(function (ln) {
      var re = /\b(?:FILE|DATAFILE|AUDIOFILE)\s+"([^"]*)"/gi, m;
      while ((m = re.exec(ln))) refs.push(m[1]);
    });
  } else if (kind === 'gdi') {
    lines.slice(1).forEach(function (ln) {
      var t = tokenize(ln);
      if (t.length >= 5) refs.push(t[4]);
    });
  }
  return refs.filter(function (r, i) { return r && refs.indexOf(r) === i; });
}
function rewriteRefs(kind, text, map) {
  var lines = text.replace(/^﻿/, '').split(/\r?\n/);
  return lines.map(function (ln, idx) {
    if (kind === 'cue') {
      return ln.replace(/^(\s*FILE\s+)(?:"([^"]*)"|(\S+))/i, function (all, pre, q, u) {
        var ref = q != null ? q : u;
        return map[ref] ? pre + '"' + map[ref] + '"' : all;
      });
    }
    if (kind === 'toc') {
      return ln.replace(/\b(FILE|DATAFILE|AUDIOFILE)(\s+)"([^"]*)"/gi, function (all, kw, sp, ref) {
        return map[ref] ? kw + sp + '"' + map[ref] + '"' : all;
      });
    }
    if (kind === 'gdi' && idx > 0) {
      var t = tokenize(ln);
      if (t.length >= 5 && map[t[4]]) {
        t[4] = /\s/.test(map[t[4]]) ? '"' + map[t[4]] + '"' : map[t[4]];
        return t.join(' ');
      }
    }
    return ln;
  }).join('\n');
}
// chdman reads a descriptor's bytes as they are and matches keywords case-sensitively: a byte order
// mark, UTF-16 or lower-case keywords leave it with no tracks, and with no tracks (or a track number
// outside 1-99) it never finishes. So the page decodes the text itself, gives chdman a corrected
// copy when needed (fixDescriptor), and refuses what chdman would not convert.
function decodeText(b) {
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { text: new TextDecoder().decode(b.subarray(3)), recoded: true };
  if (b[0] === 0xFF && b[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), recoded: true };
  if (b[0] === 0xFE && b[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), recoded: true };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), recoded: false }; }
  catch (e) { return { text: new TextDecoder('windows-1252').decode(b), recoded: true }; }
}
// chdman's msf_to_frames: "mm:ss:ff", or a plain number of frames
function tocMsf(s) {
  var m = /^(\d+):(\d+):(\d+)/.exec(s);
  return m ? (+m[1] * 60 + +m[2]) * 75 + +m[3] : parseInt(s, 10) || 0;
}
// the length chdman 0.289 reads from the words after a TOC file name: `#offset length`, `start length`
// or `#offset start length`; a single value is the length only on track 1, elsewhere an offset
function tocFrames(a, first) {
  var i = 0, w = a[i++] || '', num = function (s) { return /^\d/.test(s || ''); };
  if (w === 'SWAP') w = a[i++] || '';
  var offset = w.charAt(0) === '#' ? parseInt(w.slice(1), 10) || 0 : num(w) ? tocMsf(w) : 0;
  var len = a[i++] || '';
  if (num(len)) { var after = a[i++] || ''; return tocMsf(num(after) ? after : len); }
  return first ? offset : 0;
}
// A CloneCD control file (.ccd, INI style) as a cue sheet for its image: the .img holds raw 2,352-byte
// sectors from LBA 0, and each [TRACK n] gives MODE (0 audio, 1 or 2 data) and INDEX n=LBA.
// Returns {text, changed, problem} like fixDescriptor. The .sub (subchannel) has no place in the CHD.
function ccdToCue(text, img) {
  var sec = {}, cur = null;
  text.split(/\r\n|\r|\n/).forEach(function (ln) {
    var m = /^\s*\[([^\]]+)\]\s*$/.exec(ln);
    if (m) { cur = sec[m[1].trim().toUpperCase().replace(/\s+/g, ' ')] = {}; return; }
    m = /^\s*([^=;]+?)\s*=\s*(.*?)\s*$/.exec(ln);
    if (m && cur) cur[m[1].toUpperCase().replace(/\s+/g, ' ')] = m[2];
  });
  var fail = function (why) { return { text: '', changed: true, problem: why }; };
  if (!sec.CLONECD) return fail('This .ccd file is not a CloneCD control file.');
  var disc = sec.DISC || {};
  if (+disc.SESSIONS > 1) return fail('This CloneCD image has ' + (+disc.SESSIONS) + ' sessions; only single-session images can be converted.');
  if (+disc.DATATRACKSSCRAMBLED) return fail('This CloneCD image has scrambled data tracks.');
  var msf = function (f) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(Math.floor(f / 4500)) + ':' + p(Math.floor(f / 75) % 60) + ':' + p(f % 75); };
  var types = ['AUDIO', 'MODE1/2352', 'MODE2/2352'], lines = ['FILE "' + img + '" BINARY'], n = 0, last = -1;
  for (var t = 1; t <= 99; t++) {
    var tr = sec['TRACK ' + t];
    if (!tr) continue;
    var type = /^\d+$/.test(tr.MODE || '') ? types[+tr.MODE] : null, i1 = tr['INDEX 1'], i0 = tr['INDEX 0'];
    if (!type) return fail('Track ' + t + ' has a mode (' + (tr.MODE || 'none') + ') CloneCD images don\u2019t use.');
    if (!/^\d+$/.test(i1 || '') || (i0 != null && !/^\d+$/.test(i0)) || (i0 != null && +i0 > +i1) || +(i0 != null ? i0 : i1) < last)
      return fail('Track ' + t + ' has unreadable or out-of-order index positions.');
    last = +i1;
    // numbered from 1 in order, as chdman reads a cue's track numbers as positions
    lines.push('  TRACK ' + (++n < 10 ? '0' : '') + n + ' ' + type);
    if (i0 != null && +i0 < +i1) lines.push('    INDEX 00 ' + msf(+i0));
    lines.push('    INDEX 01 ' + msf(+i1));
  }
  if (!n) return fail('This .ccd file lists no tracks (CloneCD 3 and later list them as [TRACK n]).');
  return { text: lines.join('\n') + '\n', changed: true, problem: '' };
}
// returns {text, changed, problem}: the text chdman should read, and why it can't be converted.
// Lines may end in CR alone (classic Mac OS), which chdman reads as a single line.
function fixDescriptor(kind, text) {
  var lines = text.split(/\r\n|\r|\n/), tracks = 0, problem = '';
  if (kind === 'cue') {
    lines = lines.map(function (ln) {
      var m = /^(\s*)(\S+)(.*)$/.exec(ln);
      if (!m) return ln;
      var k = m[2].toUpperCase(), rest = m[3];
      if (k === 'FILE') rest = rest.replace(/^(\s+(?:"[^"]*"|\S+)\s+)(\S+)/, function (a, pre, type) { return pre + type.toUpperCase(); });
      else if (k === 'TRACK') {
        rest = rest.toUpperCase();
        tracks++;
        var n = parseInt(rest, 10);
        if (!(n >= 1 && n <= 99) && !problem) problem = 'Track numbers go from 01 to 99, but this CUE file has \u201c' + ln.trim() + '\u201d.';
      } else if (k === 'FLAGS') rest = rest.toUpperCase();
      else if (k === 'REM') rest = rest.replace(/^(\s+)(SESSION|PREGAP|LEAD-OUT|LEAD-IN|SINGLE-DENSITY AREA|HIGH-DENSITY AREA)\b/i, function (a, sp, w) { return sp + w.toUpperCase(); });
      else if (!/^(INDEX|PREGAP|POSTGAP)$/.test(k)) return ln;
      return m[1] + k + rest;
    });
    if (!tracks) problem = 'This CUE file lists no tracks.';
  } else if (kind === 'toc') {
    var frames = 0, file = null, prevFile = null;
    var endTrack = function () {
      if (tracks && !frames && !problem) problem = 'chdman can\u2019t tell the length of track ' + tracks + ' from this TOC file.';
    };
    lines = lines.map(function (ln) {
      var t = tokenize(ln);
      if (t[0] === 'TRACK') { endTrack(); tracks++; prevFile = file; file = null; frames = 0; }
      else if (/^(FILE|DATAFILE|AUDIOFILE)$/.test(t[0]) && tracks && t.length > 1) {
        var a = t.slice(2);
        frames = tocFrames(a, tracks === 1);
        // `DATAFILE "file" length`, as chdman itself writes for one file per track, starts at the
        // beginning of its file; chdman reads the length as an offset past track 1 and drops the track
        if (!frames && t[0] === 'DATAFILE' && tracks > 1 && /^\d/.test(a[0] || '') && !/^\d/.test(a[1] || '') && t[1] !== prevFile) {
          ln = ln.replace(/^(\s*DATAFILE\s+(?:"[^"]*"|\S+)\s+)/, '$1#0 ');
          frames = tocMsf(a[0]);
        }
        file = t[1];
      }
      return ln;
    });
    endTrack();
    if (!tracks) problem = 'This TOC file lists no tracks.';
  } else {
    return { text: text, changed: false, problem: '' };
  }
  var out = lines.join('\n');
  return { text: out, changed: out !== text.split(/\r?\n/).join('\n'), problem: problem };
}
// a CSO (v1 or v2) or ZSO compressed ISO's header: {size} of the ISO inside (0 if the file can't be
// read here: converting it then says why), or null if it is not one
async function sniffCiso(file) {
  var b;
  try { b = new Uint8Array(await file.slice(0, 24).arrayBuffer()); } catch (e) { return { size: 0 }; }
  if (b.length < 24) return null;
  var magic = String.fromCharCode(b[0], b[1], b[2], b[3]), dv = new DataView(b.buffer);
  var size = dv.getUint32(8, true) + dv.getUint32(12, true) * 4294967296, bs = dv.getUint32(16, true);
  if ((magic !== 'CISO' && magic !== 'ZISO') || !bs || bs % 2048 || bs > 1 << 24 || !size) return null;
  return { size: size };
}
// an ECM image (the ecm tools' format, described in wasm/ecm.cpp): null if the file is not one, else
// {sync} of the CD image inside as sniffSync tells it (0: no sync pattern), from its first chunk
async function sniffEcm(file) {
  var b;
  try { b = new Uint8Array(await file.slice(0, 64).arrayBuffer()); } catch (e) { return { sync: 0, unread: true }; }
  if (b.length < 5 || b[0] !== 69 || b[1] !== 67 || b[2] !== 77 || b[3] !== 0) return null;
  var c = b[4], i = 5, n = (c >> 2) & 31, bits = 5;
  if ((c & 3) === 1) return { sync: 1 }; // Mode 1 sectors, stored without their sync pattern
  if (c & 3) return { sync: 0 };         // Mode 2 sectors without sync and header
  while (c & 128 && i < b.length) { c = b[i++]; n += (c & 127) * Math.pow(2, bits); bits += 7; }
  // bytes stored as they are: the image's own
  var s = n >= 15 && i + 16 <= b.length ? b.subarray(i, i + 16) : null;
  if (!s || s[0] !== 0 || s[11] !== 0) return { sync: 0 };
  for (var k = 1; k < 11; k++) if (s[k] !== 255) return { sync: 0 };
  return { sync: s[15] === 2 ? 2 : 1 };
}
async function sniffSync(file) {
  try {
    var b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (b.length < 16 || b[0] !== 0 || b[11] !== 0) return 0;
    for (var i = 1; i < 11; i++) if (b[i] !== 255) return 0;
    return b[15] === 2 ? 2 : 1;
  } catch (e) { return 0; }
}

/*IDENT*/

/* ---------- identification scheduling ---------- */
var identQueue = [], identBusy = false;
function scheduleIdentify(job) {
  if (job.identPromise || (job.kind === 'create' && (job.missing.length || job.needCue || job.invalid))) return;
  job.identState = 'pending';
  job.identPromise = new Promise(function (resolve) { identQueue.push({ job: job, resolve: resolve }); });
  // settles once the game is known, possibly before the checksum that confirms it (identState 'checking')
  job.identKnown = new Promise(function (resolve) { job.identKnownResolve = resolve; });
  pumpIdentify();
}
async function pumpIdentify() {
  if (identBusy) return;
  var it = identQueue.shift();
  if (!it) return;
  identBusy = true;
  var job = it.job;
  if (jobs.indexOf(job) >= 0) {
    job.identState = 'running';
    job.identStatus = 'Identifying game…';
    if (job.ui && job.state !== 'running') renderNotes(job);
    if (DEBUG.identDelay) await sleep(DEBUG.identDelay); // testing: a slow identification
    try {
      job.ident = await identifyJob(job, function (msg, p) {
        job.identStatus = msg + (p ? ' ' + Math.round(p * 100) + '%' : '');
        var n = job.ui && job.ui.identLine;
        if (n) n.textContent = job.identStatus;
      }, function (provisional) {
        job.ident = provisional;
        job.identState = 'checking';
        applyIdent(job);
        job.identKnownResolve();
        if (job.ui) refreshJob(job, job.state !== 'running' && job.state !== 'queued');
      });
    } catch (e) {
      job.ident = { error: e.message, readFail: /I\/O read|NotReadable/i.test(e.message || '') };
    }
    job.identState = 'done';
    applyIdent(job);
    // the checksum finished after the conversion started: name the results after the confirmed release
    if (job.state === 'done') renameOutputs(job);
    job.identKnownResolve();
    if (job.ui) refreshJob(job, job.state !== 'running' && job.state !== 'queued');
  }
  it.resolve();
  identBusy = false;
  pumpIdentify();
}
// starting: the job is about to run (state is already 'running') and may still take the name and type
function applyIdent(job, starting) {
  var id = job.ident;
  if (!id || !id.sys) return;
  var locked = !starting && (job.state === 'running' || job.state === 'done');
  if (settings.rename && id.name && !job.outEdited && !locked) job.opts.out = id.name;
  if (job.kind !== 'create' || locked) return;
  // pick the right CHD flavour for the system
  if ((job.src === 'iso' || job.src === 'cso' || (job.src === 'bin' && job.choices)) && !job.discEdited) {
    // the system settles the type (unless the user picked one) (the "Create as" choice then moves into Options)
    var bySystem = true;
    if (id.sys === 'psp') { job.disc = 'dvd'; if (!job.hunkEdited) job.opts.hunk = '2048'; }
    else if (id.sys === 'ps2') {
      var cdGame = id.entry ? id.entry.ext === 'bin' : (job.isoSize || job.files[0].file.size) < 800 * 1048576;
      job.disc = cdGame ? 'cd' : 'dvd';
    } else if (id.sys === 'gc' || id.sys === 'wii' || id.sys === 'pc') bySystem = false;
    else job.disc = 'cd';
    if (job.choices && job.choices.indexOf(job.disc) < 0) { job.disc = job.choices[0]; bySystem = false; }
    job.discBySystem = bySystem;
    job.action = KIND[job.disc].cmd;
  }
}
// after a conversion that started before the checksum finished, rename its results
// if the confirmed release has a different name (unless the user named them or already saved one)
function renameOutputs(job) {
  var id = job.ident;
  if (job.kind !== 'create' || !id || !id.name || !settings.rename || job.outEdited) return;
  if (job.outputs.some(function (o) { return o.downloaded || o.kind === 'disk'; })) return;
  var from = outBase(job);
  job.opts.out = id.name;
  var to = outBase(job);
  if (from === to) return;
  job.outputs.forEach(function (o) { if (o.name.indexOf(from + '.') === 0) o.name = to + o.name.slice(from.length); });
}
function identNote(job) {
  if (job.identState === 'pending' || job.identState === 'running') {
    var n = el('div', { class: 'note' }, job.identStatus || 'Identifying game…');
    job.ui.identLine = n;
    return n;
  }
  var id = job.ident;
  if (!id) return null;
  if (id.error) return el('div', { class: 'note' + (id.readFail ? ' warn' : '') }, id.readFail ? readFailHint(id.error) : 'Could not identify this game (' + id.error + ').');
  if (!id.sys) return el('div', { class: 'note' }, 'Game not recognized. The output keeps the original name.');
  var box = el('div', { class: 'note ident' + (id.name ? ' ok' : '') });
  var sc = sysColor(id.sys);
  var head = el('div', { class: 'ident-head' }, el('span', { class: 'sysbadge', style: sc ? '--sys:' + sc[0] + ';--sys-fg:' + sc[1] : null }, sysShort(id.sys)), el('b', null, sysName(id.sys)));
  if (id.serial) head.append(el('span', { class: 'mono small' }, id.serial));
  box.append(head);
  if (id.name) {
    box.append(el('div', { class: 'ident-name' }, id.name));
    var how = { hash: 'Exact match in the Redump database (checksum verified)', 'serial+size': 'Matched by serial number and size', serial: 'Matched by serial number', 'serial-ambiguous': 'Matched by serial number; several versions share it', size: 'Matched by size' }[id.method] || '';
    box.append(el('div', { class: 'small ident-how' }, (id.method === 'hash' ? '✓ ' : '') + how));
    if (id.entry && id.entry.alternatives && id.entry.alternatives.length > 1) {
      var sel = el('select', { onchange: function () { id.name = sel.value; if (!job.outEdited && settings.rename) job.opts.out = id.name; refreshJob(job, true); } });
      id.entry.alternatives.forEach(function (n) { sel.append(el('option', { value: n, selected: n === id.name }, n)); });
      box.append(el('label', { class: 'field', style: 'margin-top:6px' }, el('span', null, 'Which version?'), sel));
    }
    if (job.state !== 'running' && job.state !== 'queued') {
      var using = outBase(job) === safeName(id.name);
      box.append(el('div', { class: 'row', style: 'margin-top:6px' },
        using ? el('span', { class: 'small' }, 'Output will be named after this title.')
          : el('button', { class: 'btn sm', onclick: function () { job.opts.out = id.name; job.outEdited = false; refreshJob(job, true); } }, 'Use this name')));
    }
  } else {
    box.append(el('div', { class: 'small' }, (id.headerTitle ? 'Disc title: ' + id.headerTitle + '. ' : '') + 'Not found in the Redump database, so the original name is kept.'));
  }
  if (job.identState === 'checking') {
    var chk = el('div', { class: 'small ident-check' }, job.identStatus || 'Checking against the game database…');
    job.ui.identLine = chk;
    box.append(chk);
  }
  if (id.sys === 'gc' || id.sys === 'wii') box.append(el('div', { class: 'small', style: 'margin-top:4px' }, 'Emulators do not load GameCube/Wii games from CHD. Dolphin uses RVZ instead.'));
  return box;
}
function safeName(s) { return String(s || '').replace(/[\/:*?"<>|]+/g, '_').trim(); }

/* ============================================================
   job model
   ============================================================ */
var jobs = [];
var looseFiles = [];      // files not claimed by any job yet
var seen = new Set();     // dedupe (name+size+mtime)
function fileKey(f) { return f.name + '|' + f.size + '|' + f.lastModified; }
var KIND = {
  cd: { badge: 'CD', cmd: 'createcd', label: 'CD' },
  gdrom: { badge: 'GD', cmd: 'createcd', label: 'GD-ROM' },
  dvd: { badge: 'DVD', cmd: 'createdvd', label: 'DVD' },
  hd: { badge: 'HD', cmd: 'createhd', label: 'Hard disk' },
  raw: { badge: 'RAW', cmd: 'createraw', label: 'Raw' },
  ld: { badge: 'LD', cmd: 'createld', label: 'LaserDisc' }
};
// [value, label, codecs (-c), hint, other options]
var PRESETS = {
  cd: [['default', 'Smallest (default)', null, 'chdman default: CD LZMA + Deflate + FLAC. Works everywhere.'], ['plan', 'Nearly as small, faster', null, 'The same codecs, but each track tries only the one that suits it: LZMA for data, FLAC for audio. About 1.7 times as fast, files at most 0.3% bigger, same checksums. Works everywhere.', ['--codecplan', '--libdeflate']], ['fast', 'Faster to create', 'cdzl,cdfl', 'CD Deflate (by libdeflate) + FLAC: several times faster, files a little bigger, same checksums.', ['--libdeflate']], ['zstd', 'Faster to load (Zstd)', 'cdzs,cdfl', 'CD Zstandard + FLAC: quick to read on weak devices; needs a recent emulator.'], ['none', 'No compression', 'none', 'Stores the data uncompressed.']],
  other: [['default', 'Smallest (default)', null, 'chdman default: LZMA + Deflate + Huffman + FLAC. Works everywhere.'], ['plan', 'Nearly as small, faster', null, 'The same codecs but FLAC, which almost never wins on data. About 1.5 times as fast, and as small, same checksums. Works everywhere.', ['--codecplan', '--libdeflate']], ['fast', 'Faster to create', 'zlib,huff', 'Deflate (by libdeflate) + Huffman: several times faster, files a little bigger, same checksums.', ['--libdeflate']], ['zstd', 'Faster to load (Zstd)', 'zstd', 'Zstandard: quick to read on weak devices; needs a recent emulator.'], ['none', 'No compression', 'none', 'Stores the data uncompressed.']],
  ld: [['default', 'Default (A/V Huffman)', null, 'chdman default for LaserDisc video.'], ['none', 'No compression', 'none', 'Stores the data uncompressed.']]
};
var HUNKS = {
  cd: [['', 'Automatic (19,584 bytes = 8 sectors)']],
  gdrom: [['', 'Automatic (19,584 bytes = 8 sectors)']],
  dvd: [['', 'Automatic (4,096 bytes)'], ['2048', '2,048 bytes (recommended for PSP)'], ['8192', '8,192 bytes'], ['16384', '16,384 bytes'], ['32768', '32,768 bytes']],
  hd: [['', 'Automatic (4,096 bytes)'], ['8192', '8,192 bytes'], ['16384', '16,384 bytes'], ['32768', '32,768 bytes'], ['65536', '65,536 bytes']],
  raw: [['4096', '4,096 bytes'], ['2048', '2,048 bytes'], ['8192', '8,192 bytes'], ['16384', '16,384 bytes']],
  ld: [['', 'Automatic']]
};

function newJob(props) {
  var job = Object.assign({
    id: 'j' + uid(), state: 'ready', files: [], log: [], outputs: [], warnings: [], missing: [],
    opts: { preset: 'default', hunk: '', unit: '512', format: '', out: '', verbose: false },
    action: null, progress: null, run: null
  }, props);
  if (!job.opts.out) job.opts.out = job.title;
  jobs.push(job);
  return job;
}
function jobInputBytes(job) { return job.files.reduce(function (s, f) { return s + f.file.size; }, 0); }
// a job's file for a descriptor's reference: an ECM image stands for the file it holds (Game.bin.ecm
// for Game.bin), and chdman reads that under the referenced name
function trackFile(file, path, ref) {
  var name = base(path);
  if (!/\.ecm$/i.test(file.name || name)) return { file: file, name: name, ref: ref };
  if (/\.ecm$/i.test(name) && !/\.ecm$/i.test(ref)) name = name.slice(0, -4);
  return { file: file, name: name, ref: ref, ecm: true };
}
function refMatches(e, ref) {
  var n = base(e.path).toLowerCase(), want = base(ref).toLowerCase();
  return n === want || n === want + '.ecm';
}
// the type the file shows on a job's card (bin.ecm for an ECM image of a .bin)
function fileKind(f) { return f.ecm ? (ext(f.name) ? ext(f.name) + '.' : '') + 'ecm' : ext(f.name); }

/* ---------- grouping new files into jobs ---------- */
var IGNORE = /^(txt|nfo|sbi|sub|m3u|dat|md5|sfv|sha1|jpg|jpeg|png|gif|webp|pdf|url|ini|cfg|xml|json|html|htm|db|ds_store|zip|7z|rar)$/;

async function addEntries(entries) {
  var fresh = [];
  entries.forEach(function (e) {
    var key = fileKey(e.file);
    if (seen.has(key)) return;
    seen.add(key);
    fresh.push(e);
  });
  if (!fresh.length) { toast('Those files are already in the list.'); return; }

  var created = [], ignored = [];
  var claimed = new Set();

  // 1) new files may complete jobs that were waiting for missing tracks
  jobs.forEach(function (job) {
    if (!job.missing.length || job.state !== 'blocked') return;
    job.missing = job.missing.filter(function (ref) {
      var free = fresh.filter(function (e) { return !claimed.has(e) && refMatches(e, ref); });
      var hit = free.find(function (e) { return base(e.path).toLowerCase() === base(ref).toLowerCase(); }) || free[0];
      if (!hit) return true;
      claimed.add(hit);
      job.files.push(trackFile(hit.file, hit.path, ref));
      return false;
    });
    if (!job.missing.length) finalizeDescriptorJob(job);
  });

  // 2) descriptor files (.cue/.gdi/.toc, and CloneCD .ccd) claim their tracks
  var pool = looseFiles.concat(fresh);
  var descs = fresh.filter(function (e) { return /^(cue|gdi|toc|ccd)$/.test(ext(e.path)); });
  for (var i = 0; i < descs.length; i++) {
    var d = descs[i];
    claimed.add(d);
    var job = await descriptorJob(d, pool, claimed);
    if (job) created.push(job);
    else ignored.push(base(d.path));
  }

  // 3) everything else
  for (var j = 0; j < fresh.length; j++) {
    var e = fresh[j];
    if (claimed.has(e)) continue;
    var x = ext(e.path), name = base(e.path), t = stem(e.path), file = e.file;
    var job2 = null;
    if (x === 'chd') {
      job2 = newJob({ kind: 'chd', title: t, files: [{ file: file, name: name }], state: 'probing', action: 'extract' });
    } else if (x === 'iso' || x === 'cdr' || x === 'toast') {
      var sync = await sniffSync(file);
      // raw sectors get a generated cue with their own mode: given the .iso itself, chdman types the
      // track by file size alone (Mode 2 for any raw image, 2,048-byte sectors when the size allows)
      job2 = newJob({ kind: 'create', src: 'iso', title: t, files: [{ file: file, name: name }], disc: sync ? 'cd' : (x === 'iso' ? 'dvd' : 'cd'), choices: ['dvd', 'cd'], syncMode: sync, autoCue: sync ? (sync === 2 ? 'MODE2/2352' : 'MODE1/2352') : '' });
      if (sync) job2.warnings.push('This .' + x + ' file contains raw 2,352-byte CD sectors, so it will be converted as a CD.');
    } else if (x === 'cso' || x === 'zso') {
      // a compressed ISO (maxcso's CSO or ZSO, for PSP and PS2): chdman is given the ISO inside it
      var ciso = await sniffCiso(file);
      job2 = newJob({ kind: 'create', src: 'cso', title: t, files: [{ file: file, name: name }], disc: 'dvd', choices: ['dvd', 'cd'], isoSize: ciso ? ciso.size : 0 });
      if (!ciso) {
        job2.invalid = true;
        job2.state = 'error';
        job2.errorText = 'This is not a CSO or ZSO compressed ISO that Discpress can read.';
      }
    } else if (x === 'ecm') {
      // an ECM image (usually a .bin): chdman reads the image it holds, under its name without .ecm
      var inner = name.slice(0, -4), ecm = await sniffEcm(file), tn = /\(track\s*0*(\d+)\)/i.exec(inner);
      var fe = { file: file, name: inner, ecm: true }, sync = ecm ? ecm.sync : 0;
      t = stem(inner);
      if (ecm && !ecm.unread && tn && +tn[1] > 1) {
        job2 = newJob({ kind: 'create', src: 'bin', lone: true, title: t, files: [fe], disc: 'cd', autoCue: sync ? (sync === 2 ? 'MODE2/2352' : 'MODE1/2352') : 'AUDIO', state: 'blocked', needCue: true });
      } else {
        job2 = newJob({ kind: 'create', src: 'bin', lone: true, title: t, files: [fe], disc: 'cd', autoCue: sync === 2 ? 'MODE2/2352' : 'MODE1/2352' });
        if (!ecm || ecm.unread || !sync) {
          job2.invalid = true;
          job2.state = 'error';
          job2.errorText = !ecm ? 'This is not an ECM image that Discpress can read.' : ecm.unread ? 'This file could not be read.' :
            'This ECM image doesn\u2019t start with a CD data track, so its tracks are unknown. Add the .cue file that lists it.';
        } else {
          job2.warnings.push('No .cue file was added, so one is generated (a single ' + (sync === 2 ? 'MODE2' : 'MODE1') + ' data track). If the disc has music tracks, add the original .cue and all its files instead.');
        }
      }
    } else if (x === 'nrg') {
      job2 = newJob({ kind: 'create', src: 'nrg', title: t, files: [{ file: file, name: name }], disc: 'cd' });
    } else if (x === 'avi') {
      job2 = newJob({ kind: 'create', src: 'avi', title: t, files: [{ file: file, name: name }], disc: 'ld' });
    } else if (/^(bin|img|ima|hdd|hdi|hd|raw)$/.test(x)) {
      // a data file without its .cue: if the .cue arrives later, it takes the file back
      var mode = await sniffSync(file);
      var trackNo = /\(track\s*0*(\d+)\)/i.exec(name);
      if (trackNo && +trackNo[1] > 1) {
        job2 = newJob({ kind: 'create', src: 'bin', lone: true, title: t, files: [{ file: file, name: name }], disc: 'cd', autoCue: mode ? (mode === 2 ? 'MODE2/2352' : 'MODE1/2352') : 'AUDIO', state: 'blocked', needCue: true });
      } else if (mode) {
        job2 = newJob({ kind: 'create', src: 'bin', lone: true, title: t, files: [{ file: file, name: name }], disc: 'cd', autoCue: mode === 2 ? 'MODE2/2352' : 'MODE1/2352' });
        job2.warnings.push('No .cue file was added, so one is generated (a single ' + (mode === 2 ? 'MODE2' : 'MODE1') + ' data track). If the disc has music tracks, add the original .cue and all its .bin files instead.');
        if (file.size % 2352) job2.warnings.push('The file size is not a multiple of 2,352 bytes; the image may be incomplete.');
      } else if (x === 'bin' && file.size % 2048 === 0) {
        job2 = newJob({ kind: 'create', src: 'bin', lone: true, title: t, files: [{ file: file, name: name }], disc: file.size > 900 * 1048576 ? 'dvd' : 'cd', autoCue: 'MODE1/2048', choices: ['cd', 'dvd', 'hd', 'raw'] });
        job2.warnings.push('No .cue file was added and no CD sync header was found; the file is treated as 2,048-byte data sectors.');
      } else if (x === 'bin' && file.size % 2352 === 0) {
        job2 = newJob({ kind: 'create', src: 'bin', lone: true, title: t, files: [{ file: file, name: name }], disc: 'cd', autoCue: 'AUDIO', choices: ['cd', 'raw'] });
        job2.warnings.push('No .cue file was added and no CD sync header was found; the file is treated as a single audio track. Add the original .cue if you have it.');
      } else {
        job2 = newJob({ kind: 'create', src: 'img', lone: true, title: t, files: [{ file: file, name: name }], disc: x === 'raw' || x === 'bin' ? 'raw' : 'hd', choices: ['hd', 'raw', 'dvd'] });
      }
    } else if (IGNORE.test(x) || name.charAt(0) === '.') {
      ignored.push(name);
      continue;
    } else {
      looseFiles.push(e);
      ignored.push(name);
      continue;
    }
    created.push(job2);
  }

  created.forEach(function (job) {
    if (job.kind === 'create' && !job.missing.length) finalizeCreateJob(job);
    renderJob(job, true);
    if (job.kind === 'chd') probeChd(job);
    else scheduleIdentify(job);
  });
  jobs.forEach(function (job) { if (job.el) refreshJob(job); });
  linkParents();
  updateDock();
  if (created.length) {
    var m = 'Added ' + plural(created.length, 'item');
    if (ignored.length) m += ' · ignored ' + plural(ignored.length, 'file') + ' (' + ignored.slice(0, 3).join(', ') + (ignored.length > 3 ? '…' : '') + ')';
    toast(m);
    var first = created[0].el;
    if (first && first.scrollIntoView) setTimeout(function () { first.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 60);
  } else if (ignored.length) {
    toast('Nothing to convert in ' + plural(ignored.length, 'file') + '. Add .cue/.bin, .gdi, .iso or .chd files.', 'err');
  }
}

async function descriptorJob(d, pool, claimed) {
  var kind = ext(d.path), dec = null;
  try { dec = decodeText(new Uint8Array(await d.file.slice(0, 1 << 20).arrayBuffer())); } catch (e) { /* unreadable */ }
  // not a text file, e.g. a drive's raw table of contents that some dumping tools save as .toc: not a job
  if (dec && (d.file.size > 1 << 20 || dec.text.indexOf('\0') >= 0)) return null;
  var fix = !dec ? { text: '', changed: false, problem: 'This file could not be read.' } : kind === 'ccd' ? ccdToCue(dec.text, stem(d.path) + '.img') : fixDescriptor(kind, dec.text);
  var ccd = kind === 'ccd';
  if (ccd) kind = 'cue'; // CloneCD: chdman gets a cue sheet for the .img instead
  var text = fix.text, refs = parseRefs(kind, text);
  var job = newJob({ kind: 'create', src: kind, title: stem(d.path), disc: kind === 'gdi' ? 'gdrom' : 'cd', descFile: d.file, descName: ccd ? stem(d.path) + '.cue' : base(d.path), descText: text, descDirty: !!dec && (dec.recoded || fix.changed), files: [] });
  if (ccd) {
    job.fromCcd = true;
    var sub = pool.find(function (e) { return !claimed.has(e) && e !== d && base(e.path).toLowerCase() === (stem(d.path) + '.sub').toLowerCase(); });
    if (sub) {
      claimed.add(sub);
      var si = looseFiles.indexOf(sub);
      if (si >= 0) looseFiles.splice(si, 1);
      if (!fix.problem) job.warnings.push('The .sub file (subchannel data) is not kept: CHDs store the discs\u2019 data and audio. For PlayStation games with LibCrypt protection, keep an .sbi file next to the CHD.');
    }
  }
  if (fix.problem) {
    job.invalid = true;
    job.state = 'error';
    job.errorText = dec ? fix.problem + ' chdman can\u2019t convert it as it is.' : fix.problem;
  }
  var dir = dirOf(d.path);
  refs.forEach(function (ref) {
    var want = base(ref).toLowerCase();
    var cands = pool.filter(function (e) { return e !== d && base(e.path).toLowerCase() === want; });
    // or an ECM image of it (Game.bin.ecm for Game.bin)
    if (!cands.length) cands = pool.filter(function (e) { return e !== d && base(e.path).toLowerCase() === want + '.ecm'; });
    // also steal files from not-yet-started auto-cue jobs
    if (!cands.length) {
      jobs.forEach(function (other) {
        if (other.lone && other.state !== 'running' && other.state !== 'queued' && other.state !== 'done' && other.files[0] && other.files[0].name.toLowerCase() === want) {
          cands.push({ file: other.files[0].file, path: other.files[0].name, fromJob: other });
        }
      });
    }
    var hit = cands.find(function (e) { return dirOf(e.path) === dir; }) || cands[0];
    if (!hit) { job.missing.push(ref); return; }
    if (hit.fromJob) removeJob(hit.fromJob, true);
    claimed.add(hit);
    var li = looseFiles.indexOf(hit);
    if (li >= 0) looseFiles.splice(li, 1);
    job.files.push(trackFile(hit.file, hit.path, ref));
  });
  if (!refs.length && !job.invalid) job.warnings.push('No track files are listed in this ' + kind.toUpperCase() + ' file.');
  if (job.missing.length && !job.invalid) job.state = 'blocked';
  return job;
}

function finalizeDescriptorJob(job) {
  job.state = 'ready';
  finalizeCreateJob(job);
  refreshJob(job, true);
  scheduleIdentify(job);
}

function finalizeCreateJob(job) {
  if (job.descFile) {
    // make every track reference match the real file names exactly
    var map = {}, changed = false;
    job.files.forEach(function (f) {
      if (f.ref && f.ref !== f.name) { map[f.ref] = f.name; changed = true; }
    });
    job.descBlob = changed || job.descDirty ? new Blob([rewriteRefs(job.src, job.descText, map)], { type: 'text/plain' }) : job.descFile;
  }
  if (!job.action) job.action = KIND[job.disc].cmd;
}

/* ---------- CHD probing ---------- */
var probeQueue = [], probing = 0;
function probeChd(job) {
  probeQueue.push(job);
  pumpProbes();
}
function pumpProbes() {
  while (probing < 2 && probeQueue.length) {
    var job = probeQueue.shift();
    if (jobs.indexOf(job) < 0) continue;
    probing++;
    doProbe(job).finally(function () { probing--; pumpProbes(); });
  }
}
async function doProbe(job) {
  try {
    await Engine.ready();
    var lines = [];
    var r = Engine.run({
      jobId: job.id + 'p', args: ['info', '-i', '/in/' + job.files[0].name],
      inputs: [{ name: job.files[0].name, blob: job.files[0].file }], outMode: 'mem',
      onLine: function (s, t) { lines.push(t); }
    });
    var res = await r.promise;
    job.info = parseInfo(lines);
    if (res.code !== 0) {
      job.state = 'error';
      job.errorText = lines.filter(function (l) { return /error/i.test(l); }).join('\n') || 'This file could not be read as a CHD.';
    } else {
      job.state = 'ready';
      job.opts.format = defaultFormat(job.info.type);
      if (!job.info.parent) scheduleIdentify(job);
    }
  } catch (e) {
    job.state = 'error';
    job.errorText = e.message;
  }
  linkParents();
  refreshJob(job, true);
  updateDock();
}
function parseInfo(lines) {
  var info = { kv: {}, tags: [], tracks: 0, raw: lines.join('\n') };
  lines.forEach(function (ln) {
    var m = /^([A-Za-z][A-Za-z0-9 ]*?):\s+(.*)$/.exec(ln);
    if (m && m[1] !== 'Metadata') info.kv[m[1]] = m[2].trim();
    var t = /Tag='(.{4})'/.exec(ln);
    if (t) {
      info.tags.push(t[1]);
      if (/^(CHT2|CHTR|CHGT|CHGD)$/.test(t[1])) info.tracks++;
    }
  });
  var tags = info.tags.join(',');
  info.type = /CHGD|CHGT/.test(tags) ? 'gdrom' : /CHT2|CHTR|CHCD/.test(tags) ? 'cd' : /GDDD/.test(tags) ? 'hd' : /DVD /.test(tags) ? 'dvd' : /AVAV|AVLD/.test(tags) ? 'ld' : 'raw';
  var num = function (s) { return s ? +s.replace(/[^0-9]/g, '') : 0; };
  info.logical = num(info.kv['Logical size']);
  info.chdSize = num(info.kv['CHD size']);
  info.sha1 = (info.kv['SHA1'] || '').toLowerCase();
  info.parent = (info.kv['Parent SHA1'] || '').toLowerCase();
  if (/^0+$/.test(info.parent)) info.parent = '';
  info.version = info.kv['File Version'];
  info.compression = info.kv['Compression'] || '';
  return info;
}
function defaultFormat(type) {
  return { cd: 'redump', gdrom: 'gdi', dvd: 'iso', hd: 'img', ld: 'avi', raw: 'raw' }[type] || 'raw';
}
function linkParents() {
  jobs.forEach(function (job) {
    if (job.kind !== 'chd' || !job.info || !job.info.parent) return;
    // never the job itself: a child whose data equals its parent's has the parent's SHA-1
    var p = jobs.find(function (o) { return o !== job && o.kind === 'chd' && o.info && o.info.sha1 === job.info.parent; });
    var had = job.parentJob;
    job.parentJob = p || null;
    if (had !== job.parentJob && job.el) refreshJob(job, true);
  });
}

/* ---------- building the chdman command for a job ---------- */
var FORMATS = {
  cd: [['redump', 'CUE + BIN, as Redump'], ['cue', 'CUE + BIN (one .bin)'], ['cue-split', 'CUE + BIN (one .bin per track)'], ['gdi', 'GDI + tracks'], ['toc', 'TOC + BIN (cdrdao)']],
  gdrom: [['gdi', 'GDI + tracks'], ['redump', 'CUE + BIN, as Redump']],
  dvd: [['iso', 'ISO image']], hd: [['img', 'Raw disk image (.img)']], ld: [['avi', 'AVI video']], raw: [['raw', 'Raw data (.raw)']]
};
function outBase(job) {
  var s = (job.opts.out || job.title || 'output').replace(/[\/\\:*?"<>|]+/g, '_').trim();
  return s || 'output';
}
// a CHD job's inputs for chdman, with its parent CHD if it has one
function chdInputs(job) {
  var name = job.files[0].name, r = { name: name, inputs: [{ name: name, blob: job.files[0].file }], parentArgs: [], parentDisp: [] };
  if (job.parentJob) {
    var pn = job.parentJob.files[0].name;
    if (pn === name) pn = 'parent-' + pn;
    r.inputs.push({ name: pn, blob: job.parentJob.files[0].file });
    r.parentArgs = ['-ip', '/in/' + pn];
    r.parentDisp = ['-ip', job.parentJob.files[0].name];
  }
  return r;
}
function buildJob(job) {
  var args = [], inputs = [], writable = [], slots = 3, helpers = 0, expected = 0, display = [];
  var o = job.opts, ob = outBase(job);
  function presetFor(disc) {
    var list = PRESETS[disc === 'cd' || disc === 'gdrom' ? 'cd' : disc === 'ld' ? 'ld' : 'other'];
    return list.find(function (x) { return x[0] === o.preset; }) || list[0];
  }
  if (job.kind === 'create') {
    var disc = job.disc, cmd = KIND[disc].cmd, inName;
    if (job.descFile) {
      inName = job.descName;
      inputs.push({ name: job.descName, blob: job.descBlob || job.descFile });
      job.files.forEach(function (f) { inputs.push({ name: f.name, blob: f.file, ecm: f.ecm }); }); // ECM: the job worker rebuilds the image
    } else if (job.src === 'cso') {
      // the job worker decompresses the image as chdman reads it
      inName = stem(job.files[0].name) + '.iso';
      inputs.push({ name: inName, blob: job.files[0].file, ciso: true });
    } else if (job.autoCue && disc === 'cd') {
      inName = stem(job.files[0].name) + '.cue';
      var cue = 'FILE "' + job.files[0].name + '" BINARY\n  TRACK 01 ' + job.autoCue + '\n    INDEX 01 00:00:00\n';
      inputs.push({ name: inName, blob: new Blob([cue], { type: 'text/plain' }) });
      inputs.push({ name: job.files[0].name, blob: job.files[0].file, ecm: job.files[0].ecm });
    } else {
      inName = job.files[0].name;
      inputs.push({ name: inName, blob: job.files[0].file });
    }
    args = [cmd, '-i', '/in/' + inName, '-o', '/out/' + ob + '.chd'];
    display = [cmd, '-i', inName, '-o', ob + '.chd'];
    var preset = presetFor(disc), c = preset[2];
    if (c) { args.push('-c', c); display.push('-c', c); }
    (preset[4] || []).forEach(function (a) { args.push(a); display.push(a); });
    var hs = disc === 'raw' ? (o.hunk || '4096') : o.hunk;
    if (hs) { args.push('-hs', hs); display.push('-hs', hs); }
    // the setting: keep a real cue sheet (not one written for chdman here) in the CHD (the engine's --keepcue)
    if (settings.keepCue && job.src === 'cue' && !job.fromCcd && cmd === 'createcd') { args.push('--keepcue'); display.push('--keepcue'); }
    if (disc === 'raw') { args.push('-us', o.unit || '512'); display.push('-us', o.unit || '512'); }
    slots = 2;
    var nt = threadCount();
    helpers = nt > 1 && c !== 'none' ? nt : 0;
    expected = jobInputBytes(job);
  } else {
    var info = job.info || {}, ci = chdInputs(job), name = ci.name;
    inputs = ci.inputs;
    var parentArgs = ci.parentArgs, parentDisp = ci.parentDisp;
    if (job.action === 'rename') {
      return { args: [], inputs: [], writable: [], slots: 0, helpers: 0, outMode: 'mem', expected: 0, cmdline: '(no processing: the CHD is saved again as "' + outBase(job) + '.chd")', rename: true };
    }
    if (job.action === 'info') {
      args = ['info', '-i', '/in/' + name];
      display = ['info', '-i', name];
      if (o.verbose) { args.push('-v'); display.push('-v'); }
      slots = 0;
    } else if (job.action === 'verify') {
      args = ['verify', '-i', '/in/' + name].concat(parentArgs);
      display = ['verify', '-i', name].concat(parentDisp);
      slots = 0;
      helpers = readHelpers();
    } else {
      var fmt = o.format || defaultFormat(info.type), cmdx, oname, extra = [];
      if (info.type === 'cd' || info.type === 'gdrom') {
        cmdx = 'extractcd';
        oname = ob + (fmt === 'gdi' ? '.gdi' : fmt === 'toc' ? '.toc' : '.cue');
        if (fmt === 'cue-split') extra = ['-sb'];
        else if (fmt === 'redump') extra = ['--redump']; // the engine's: Redump's CRLF cue sheet, a .bin per track
        slots = (info.tracks || 99) + 3;
      } else {
        cmdx = { dvd: 'extractdvd', hd: 'extracthd', ld: 'extractld', raw: 'extractraw' }[info.type] || 'extractraw';
        oname = ob + '.' + fmt;
        slots = 2;
      }
      args = [cmdx, '-i', '/in/' + name, '-o', '/out/' + oname].concat(extra, parentArgs);
      display = [cmdx, '-i', name, '-o', oname].concat(extra, parentDisp);
      expected = info.logical || 0;
      if (cmdx !== 'extractld') helpers = readHelpers();
    }
  }
  var outMode = settings.storage === 'memory' || !Store.available ? 'mem' : 'opfs';
  if (settings.storage === 'folder' && outDir) { outMode = 'stream'; slots = 0; }
  if (!slots && outMode !== 'stream') outMode = 'mem';
  return {
    args: args, inputs: inputs, writable: writable, slots: slots, helpers: helpers, outMode: outMode,
    expected: expected, cmdline: 'chdman ' + display.map(quoteArg).join(' ')
  };
}

/* ============================================================
   rendering
   ============================================================ */
var jobsBox = null;
function renderJob(job, append) {
  jobsBox = jobsBox || $('#jobs');
  var card = el('article', { class: 'job', 'data-state': job.state });
  job.el = card;
  job.ui = {};
  var badge = el('div', { class: 'badge' });
  var h3 = el('h3');
  var sub = el('p', { class: 'sub' });
  var rm = el('button', { class: 'icon-btn', 'aria-label': 'Remove', title: 'Remove', onclick: function () { removeJob(job); } }, icon('i-x'));
  card.append(el('div', { class: 'job-head' }, badge, el('div', { class: 'job-title' }, h3, sub), rm));
  var body = el('div', { class: 'job-body' });
  var controls = el('div', { class: 'controls', style: 'display:grid;gap:12px' });
  var notes = el('div', { style: 'display:grid;gap:8px' });
  var prog = el('div', { class: 'prog', hidden: true }, el('div', { class: 'bar' }, el('i')), el('div', { class: 'ptext' }));
  var result = el('div', { class: 'result', hidden: true });
  var logPre = el('pre', { class: 'logtext' });
  var cmd = el('code', { class: 'cmd' });
  var log = el('details', { class: 'log' }, el('summary', null, 'Details'), el('div', { style: 'margin-top:8px' }, cmd, logPre));
  body.append(controls, notes, prog, result, log);
  var foot = el('div', { class: 'job-foot' });
  card.append(body, foot);
  job.ui = { badge: badge, h3: h3, sub: sub, controls: controls, notes: notes, prog: prog, bar: prog.querySelector('i'), ptext: prog.querySelector('.ptext'), result: result, logPre: logPre, cmd: cmd, foot: foot, log: log };
  if (append) jobsBox.appendChild(card);
  refreshJob(job, true);
}

function discLabel(job) {
  if (job.ident && job.ident.sys && job.ident.sys !== 'pc') return sysShort(job.ident.sys);
  if (job.kind === 'chd') {
    if (!job.info) return 'CHD';
    return { cd: 'CD', gdrom: 'GD', dvd: 'DVD', hd: 'HD', ld: 'LD', raw: 'RAW' }[job.info.type];
  }
  return KIND[job.disc].badge;
}

function refreshJob(job, full) {
  var ui = job.ui;
  if (!ui) return;
  job.el.setAttribute('data-state', job.state);
  ui.badge.className = 'badge' + (job.kind === 'chd' ? ' chd' : '');
  var small = job.kind === 'chd' ? 'CHD' : 'image';
  var col = job.ident && sysColor(job.ident.sys);
  if (col) { ui.badge.style.setProperty('--sys', col[0]); ui.badge.style.setProperty('--sys-fg', col[1]); }
  else { ui.badge.style.removeProperty('--sys'); ui.badge.style.removeProperty('--sys-fg'); }
  if (job.ident && job.ident.sys && job.ident.sys !== 'pc') small = job.kind === 'chd' ? 'CHD' : KIND[job.disc].badge;
  ui.badge.replaceChildren(document.createTextNode(discLabel(job)), el('small', null, small));
  ui.h3.textContent = job.title;
  ui.sub.textContent = subtitle(job);
  var busy = job.state === 'running' || job.state === 'queued';
  if (full) renderControls(job);
  else $$('input,select,button', ui.controls).forEach(function (x) { x.disabled = busy; });
  renderNotes(job);
  ui.cmd.textContent = job.state === 'probing' || job.state === 'blocked' || job.invalid ? '' : safeCmd(job);
  ui.prog.hidden = !(job.state === 'running' || job.state === 'queued');
  if (job.state === 'queued') setProgress(job, null, 'Waiting in queue…');
  renderResult(job);
  renderFoot(job);
  updateTabCount();
}
function safeCmd(job) {
  try { return buildJob(job).cmdline; } catch (e) { return ''; }
}
function subtitle(job) {
  var n = jobInputBytes(job);
  if (job.kind === 'chd') {
    if (job.state === 'probing') return 'Reading CHD header…';
    if (!job.info) return fmtBytes(n);
    var i = job.info, typeName = { cd: 'CD-ROM', gdrom: 'GD-ROM (Dreamcast)', dvd: 'DVD-ROM', hd: 'Hard disk', ld: 'LaserDisc', raw: 'Raw data' }[i.type];
    var parts = [typeName];
    if (i.tracks) parts.push(plural(i.tracks, 'track'));
    parts.push(fmtBytes(n) + ' → ' + fmtBytes(i.logical) + ' unpacked');
    if (i.version && i.version !== '5') parts.push('CHD v' + i.version);
    return parts.join(' · ');
  }
  if (job.src === 'cso') return (ext(job.files[0].name) === 'zso' ? 'ZSO' : 'CSO') + ' compressed ISO · ' + fmtBytes(n) + (job.isoSize ? ' → ' + fmtBytes(job.isoSize) + ' unpacked' : '');
  var what;
  var ecms = job.files.filter(function (f) { return f.ecm; }).length;
  if (job.fromCcd) what = 'CloneCD image (.ccd + .' + (job.files[0] ? fileKind(job.files[0]) : 'img') + ')';
  else if (job.descFile) what = job.src.toUpperCase() + ' + ' + plural(job.files.length, 'track file') + (!ecms ? '' : ecms === job.files.length ? ' (ECM)' : ' (' + ecms + ' ECM)');
  else if (job.autoCue && job.src !== 'iso') what = '.' + fileKind(job.files[0]) + ' image (no cue)';
  else what = '.' + fileKind(job.files[0]) + ' image';
  var total = n + (job.descFile ? job.descFile.size : 0);
  return what + ' · ' + fmtBytes(total);
}

function seg(options, value, onpick, disabled) {
  var box = el('div', { class: 'seg', role: 'group' });
  options.forEach(function (o) {
    box.append(el('button', { type: 'button', 'aria-pressed': String(o[0] === value), disabled: disabled, onclick: function () { if (o[0] !== value) onpick(o[0]); } }, o[1]));
  });
  return box;
}
function selectField(label, options, value, onchange, hint, disabled) {
  var s = el('select', { disabled: disabled, onchange: function () { onchange(s.value); } });
  options.forEach(function (o) { s.append(el('option', { value: o[0], selected: o[0] === value }, o[1])); });
  if (!options.some(function (o) { return o[0] === value; }) && options.length) s.value = options[0][0];
  return el('label', { class: 'field' }, el('span', null, label), s, hint ? el('span', { class: 'hint' }, hint) : null);
}
function textField(label, value, onchange, opts) {
  opts = opts || {};
  var i = el('input', { type: opts.type || 'text', value: value || '', placeholder: opts.placeholder || '', inputmode: opts.inputmode, disabled: opts.disabled, autocomplete: 'off', spellcheck: 'false' });
  i.addEventListener('input', function () { onchange(i.value); });
  return el('label', { class: 'field' }, el('span', null, label), i, opts.hint ? el('span', { class: 'hint' }, opts.hint) : null);
}

function renderControls(job) {
  var ui = job.ui, box = ui.controls, o = job.opts;
  var busy = job.state === 'running' || job.state === 'queued';
  box.replaceChildren();
  if (job.state === 'probing' || job.invalid || (job.kind === 'chd' && !job.info)) return;
  var refresh = function () { refreshJob(job, true); };
  var soft = function () { ui.cmd.textContent = safeCmd(job); };

  if (job.kind === 'create') {
    var pickDisc = function (v) {
      if (job.state === 'done' || job.state === 'error' || job.state === 'canceled') {
        var pending = job.outputs.some(function (x) { return !x.downloaded && x.kind !== 'disk'; });
        if (pending && !confirm('Discard the results of the previous run? Download them first if you need them.')) return;
        job.disc = v; job.action = KIND[v].cmd; o.preset = 'default'; o.hunk = ''; job.discEdited = true;
        resetJob(job);
        return;
      }
      job.disc = v; job.action = KIND[v].cmd; o.preset = 'default'; o.hunk = ''; job.discEdited = true; refresh();
    };
    var discChoices = job.choices && job.choices.length > 1 ? job.choices.map(function (k) { return [k, KIND[k].label + ' CHD']; }) : null;
    // an identified game's system settles the type: the choice is in Options instead of up front
    if (discChoices && !job.discBySystem) {
      box.append(el('div', { class: 'row' }, el('span', { class: 'small muted', style: 'font-weight:600' }, 'Create as'), seg(discChoices, job.disc, pickDisc, busy)));
    }
    var disc = job.disc;
    var presets = PRESETS[disc === 'cd' || disc === 'gdrom' ? 'cd' : disc === 'ld' ? 'ld' : 'other'];
    var fields = el('div', { class: 'fields' });
    if (discChoices && job.discBySystem) {
      fields.append(selectField('Create as', discChoices, job.disc, pickDisc,
        (job.ident.sys === 'ps2' ? 'This ' + sysName('ps2') + ' game is on a ' + KIND[job.disc].label + ', so it becomes a ' + KIND[job.disc].label + ' CHD.'
          : sysName(job.ident.sys) + ' games become ' + KIND[job.disc].label + ' CHDs.') + ' Change this only if you know you need the other type.', busy));
    }
    var cur = presets.find(function (p) { return p[0] === o.preset; }) || presets[0];
    fields.append(selectField('Compression', presets.map(function (p) { return [p[0], p[1]]; }), o.preset, function (v) { o.preset = v; refresh(); }, cur[3], busy));
    var hunks = HUNKS[disc] || [['', 'Automatic']];
    if (hunks.length > 1) fields.append(selectField('Hunk size', hunks, o.hunk || hunks[0][0], function (v) { o.hunk = v; job.hunkEdited = true; soft(); }, disc === 'dvd' ? 'Use 2,048 for PSP games.' : null, busy));
    if (disc === 'raw') fields.append(textField('Unit size (bytes)', o.unit, function (v) { o.unit = v.replace(/[^0-9]/g, ''); soft(); }, { inputmode: 'numeric', disabled: busy }));
    fields.append(textField('Output name', o.out, function (v) { o.out = v; job.outEdited = true; soft(); }, { hint: 'Saved as ' + outBase(job) + '.chd', disabled: busy }));
    var det = el('details', { class: 'opts' }, el('summary', null, 'Options'), fields);
    if (job.ui.optsOpen) det.open = true;
    det.addEventListener('toggle', function () { job.ui.optsOpen = det.open; });
    box.append(det);
    if (job.disc === 'dvd' && (job.src === 'iso' || job.src === 'cso') && !(job.ident && job.ident.sys && job.ident.sys !== 'pc')) {
      box.append(el('p', { class: 'small muted', style: 'margin:0' }, 'Use DVD for PS2 DVD games and PSP. Choose CD for CD-based games stored as .iso.'));
    }
  } else {
    var info = job.info;
    var acts = [['extract', 'Extract'], ['verify', 'Verify'], ['info', 'Info']];
    if (job.ident && job.ident.name) acts.push(['rename', 'Rename']);
    box.append(el('div', { class: 'row' }, seg(acts, job.action, function (v) {
      if (job.state === 'done' || job.state === 'error' || job.state === 'canceled') {
        var pending = job.outputs.some(function (x) { return !x.downloaded && x.kind !== 'disk'; });
        if (pending && !confirm('Discard the results of the previous run? Download them first if you need them.')) return;
        job.action = v;
        resetJob(job);
        return;
      }
      job.action = v;
      refresh();
    }, busy)));
    var f2 = el('div', { class: 'fields' });
    if (job.action === 'extract') {
      var fmt = o.format || defaultFormat(info.type);
      f2.append(selectField('Save as', FORMATS[info.type] || FORMATS.raw, fmt, function (v) { o.format = v; refresh(); },
        fmt === 'redump' ? (info.tags && info.tags.indexOf('CUES') >= 0 ? 'The files of a Redump dump: the cue sheet kept in this CHD, and one .bin per track.' :
          'The files of a Redump dump: its cue sheet, and one .bin per track, so they match Redump\u2019s checksums.') : null, busy));
      f2.append(textField('Output name', o.out, function (v) { o.out = v; job.outEdited = true; soft(); }, { disabled: busy }));
    } else if (job.action === 'rename') {
      f2.append(textField('New name', o.out, function (v) { o.out = v; job.outEdited = true; soft(); }, { hint: 'Saved as ' + outBase(job) + '.chd (the CHD itself is not changed)', disabled: busy }));
    } else if (job.action === 'info') {
      f2.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: o.verbose, disabled: busy, onchange: function (e) { o.verbose = e.target.checked; soft(); } }), 'Show hunk statistics (verbose)'));
    }
    if (f2.childNodes.length) box.append(f2);
  }
}

function renderNotes(job) {
  var box = job.ui.notes;
  box.replaceChildren();
  job.ui.identLine = null;
  var idn = identNote(job);
  if (idn) box.append(idn);
  if (job.missing.length) {
    box.append(el('div', { class: 'note warn' }, el('b', null, 'Missing ' + plural(job.missing.length, 'file') + ' listed in ' + (job.fromCcd ? stem(job.descName) + '.ccd' : job.descName) + ':'),
      el('ul', null, job.missing.map(function (m) { return el('li', null, base(m)); })),
      el('div', { style: 'margin-top:6px' }, el('button', { class: 'btn sm', onclick: function () { pickFiles('fileInput', function (l) { addEntries(filesFromList(l)); }); } }, 'Add missing files'))));
  }
  if (job.needCue) box.append(el('div', { class: 'note warn' }, el('b', null, 'This is one track of a multi-track disc. '), 'Add its .cue file (and the other track files) to convert the whole disc.'));
  job.warnings.forEach(function (w) { box.append(el('div', { class: 'note' }, w)); });
  if (job.kind === 'chd' && job.info && job.info.parent) {
    if (job.parentJob) box.append(el('div', { class: 'note' }, 'Uses parent CHD ', el('b', null, job.parentJob.files[0].name), '.'));
    else box.append(el('div', { class: 'note warn' }, 'This CHD depends on a parent CHD (SHA-1 ' + job.info.parent.slice(0, 12) + '…). Add the parent .chd file too.'));
  }
  if (job.state === 'error' && job.errorText) box.append(el('div', { class: 'note err' }, job.errorText));
  if (job.state === 'canceled') box.append(el('div', { class: 'note' }, 'Canceled.'));
  box.hidden = !box.childNodes.length;
}

function renderResult(job) {
  var box = job.ui.result;
  box.replaceChildren();
  box.hidden = true;
  if (job.state !== 'done') return;
  box.hidden = false;
  if (job.kind === 'chd' && job.action === 'verify') {
    box.append(el('div', { class: 'note ok' }, el('b', null, 'Verified. '), 'The data matches the SHA-1 checksums stored in the CHD.'));
    var rd = job.redump, what = rd && (rd.track ? 'Track ' + rd.track : 'The disc');
    if (rd && rd.match) box.append(el('div', { class: 'note ok' }, el('b', null, '\u2713 The Redump dump. '), what + ' has the size and CRC-32 that Redump lists for ' + rd.entry.name + (rd.track ? ', the track the built-in database has' : '') + '.'));
    else if (rd) box.append(el('div', { class: 'note warn' }, el('b', null, 'Not the Redump dump. '), what + (rd.otherSize ? ' has another size than' : ' differs from') + ' what Redump lists for ' + rd.entry.name + '. It may be another release or a modified copy.'));
  } else if (job.kind === 'chd' && job.action === 'info' && job.lastInfo) {
    var kv = el('dl', { class: 'kv' });
    var skip = { 'Input file': 1 };
    Object.keys(job.lastInfo.kv).forEach(function (k) { if (!skip[k]) kv.append(el('dt', null, k), el('dd', null, job.lastInfo.kv[k])); });
    box.append(kv);
    var mi = job.log.findIndex(function (l) { return /^Metadata:/.test(l); });
    if (mi >= 0) box.append(el('pre', { class: 'logtext' }, job.log.slice(mi).join('\n')));
  }
  if (job.outputs.length) {
    var outs = el('div', { class: 'outs' });
    job.outputs.forEach(function (out) { outs.append(outputRow(job, out)); });
    if (job.kind === 'create' && job.outputs[0]) {
      var inBytes = jobInputBytes(job);
      var pct = inBytes ? Math.round(100 * job.outputs[0].size / inBytes) : 0;
      box.append(el('div', { class: 'note ok' }, el('b', null, 'Done. '), fmtBytes(job.outputs[0].size) + ' — ' + pct + '% of the original ' + fmtBytes(inBytes) + (job.elapsed ? ', in ' + fmtDur(job.elapsed / 1000) : '') + '.'));
    } else if (job.kind === 'chd' && job.action === 'rename') {
      box.append(el('div', { class: 'note ok' }, el('b', null, 'Renamed copy ready. '), 'Delete the old file after saving this one.'));
    } else if (job.kind === 'chd' && job.action === 'extract') {
      box.append(el('div', { class: 'note ok' }, el('b', null, 'Extracted ' + plural(job.outputs.length, 'file') + '. '), job.outputs.length > 1 ? 'Keep them together in one folder.' : ''));
    }
    box.append(outs);
    if (job.outputs.length > 1 && job.outputs[0].kind !== 'disk') {
      var row = el('div', { class: 'row end' });
      row.append(saveButton(job.outputs, function () { downloadMany([job]); }, true));
      if (window.showDirectoryPicker) row.append(el('button', { class: 'btn sm', onclick: function () { saveToFolder([job]); } }, icon('i-folder'), 'Save to folder'));
      box.append(row);
    }
  }
}

function outputRow(job, out) {
  if (out.kind === 'disk') {
    return el('div', { class: 'out' }, el('div', { class: 'nm' }, out.name, el('small', null, fmtBytes(out.size) + ' · saved in ' + (job.folderName || 'your folder'))), el('span', { class: 'small', style: 'color:var(--ok);display:inline-flex;align-items:center;gap:4px;padding-right:6px' }, icon('i-check'), 'Saved'));
  }
  var btns = el('div', { class: 'row' });
  btns.append(saveButton([out], function () { saveOutput(job, out); }));
  var tooBig = useShareSheet && !viaShare([out]);
  return el('div', { class: 'out' }, el('div', { class: 'nm' }, out.name, el('small', null, fmtBytes(out.size) + (out.downloaded ? ' · downloaded' : tooBig ? ' · too large for the share sheet, so it downloads' : ''))), btns);
}

function renderFoot(job) {
  var f = job.ui.foot;
  f.replaceChildren();
  var st = { ready: ['', 'Ready'], blocked: ['warn', 'Waiting for files'], probing: ['run', 'Reading…'], queued: ['run', 'Queued'], running: ['run', 'Working…'], done: ['ok', 'Finished'], error: ['err', 'Failed'], canceled: ['warn', 'Canceled'] }[job.state];
  if (job.invalid) st = ['err', 'Can\u2019t convert'];
  f.append(el('span', { class: 'state' }, el('span', { class: 'dot ' + st[0] }), st[1]));
  if (job.state === 'ready') {
    var label = job.kind === 'create' ? 'Create CHD' : job.action === 'extract' ? 'Extract' : job.action === 'verify' ? 'Verify' : job.action === 'rename' ? 'Save renamed copy' : 'Show info';
    f.append(el('button', { class: 'btn primary', onclick: function () { enqueueChecked(job); } }, icon('i-play'), label));
  } else if (job.state === 'queued' || job.state === 'running') {
    f.append(el('button', { class: 'btn danger', onclick: function () { cancelJob(job); } }, 'Cancel'));
  } else if (job.state === 'done' || job.state === 'error' || job.state === 'canceled') {
    if (job.kind === 'chd' && job.info || job.kind === 'create' && !job.invalid) {
      f.append(el('button', { class: 'btn', onclick: function () { resetJob(job); } }, job.state === 'done' ? 'Run again' : 'Try again'));
    }
  }
}

function setProgress(job, pct, text, extra) {
  var ui = job.ui;
  if (!ui) return;
  var barBox = ui.bar.parentNode;
  if (pct == null) { barBox.classList.add('indet'); ui.bar.style.width = ''; }
  else { barBox.classList.remove('indet'); ui.bar.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
  ui.ptext.replaceChildren(el('b', null, text));
  (extra || []).forEach(function (x) { if (x) ui.ptext.append(el('span', null, x)); });
}

function appendLog(job, text) {
  job.log.push(text);
  if (job.log.length > 800) job.log.splice(0, job.log.length - 800);
  if (job.ui) {
    job.ui.logPre.textContent = job.log.join('\n');
  }
}

function updateTabCount() {
  var c = $('#jobCount');
  if (!c) return;
  c.textContent = jobs.length;
  c.hidden = !jobs.length;
  var d = $('#drop');
  if (d) {
    d.classList.toggle('compact', jobs.length > 0);
    $('#tab-convert').classList.toggle('has-jobs', jobs.length > 0);
    d.querySelector('h2').textContent = jobs.length ? 'Add more games' : 'Drop your games here';
    $('#addFiles').lastChild.textContent = jobs.length ? 'Add more files' : 'Choose files';
  }
}

/* ============================================================
   queue
   ============================================================ */
var queue = [], current = null, wakeLock = null, activeTab = 'convert';

async function ensureFolder() {
  if (settings.storage !== 'folder' || outDir) return true;
  return await pickFolder();
}
async function pickFolder() {
  if (!window.showDirectoryPicker) return false;
  try {
    outDir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'chdman-out' });
    updateChips();
    var lbl = $('#folderName');
    if (lbl) lbl.textContent = outDir.name;
    return true;
  } catch (e) { return false; }
}
async function enqueueChecked(job) {
  if (!(await ensureFolder())) { toast('Choose an output folder first (Settings).', 'err'); return; }
  enqueue(job);
}
function enqueue(job) {
  if (job.state !== 'ready') return;
  job.state = 'queued';
  job.errorText = '';
  queue.push(job);
  refreshJob(job);
  updateDock();
  pump();
}
async function startAll() {
  if (!(await ensureFolder())) { toast('Choose an output folder first (Settings).', 'err'); return; }
  var n = 0;
  jobs.forEach(function (j) { if (j.state === 'ready') { enqueue(j); n++; } });
  if (!n) toast('Nothing ready to start.');
}
function resetJob(job) {
  Store.removeJob(job.id);
  job.outputs = [];
  job.log = [];
  job.ui.logPre.textContent = '';
  job.state = job.missing.length ? 'blocked' : 'ready';
  job.errorText = '';
  refreshJob(job, true);
  updateDock();
}
function cancelJob(job) {
  if (job.state === 'queued') {
    queue = queue.filter(function (j) { return j !== job; });
    job.state = 'ready';
    refreshJob(job, true);
    updateDock();
    return;
  }
  if (job.run) job.run.cancel();
}
function removeJob(job, silent) {
  if (job.state === 'running' && !silent && !confirm('Stop and remove "' + job.title + '"?')) return;
  if (job.run) job.run.cancel();
  queue = queue.filter(function (j) { return j !== job; });
  jobs = jobs.filter(function (j) { return j !== job; });
  if (job.el) job.el.remove();
  Store.removeJob(job.id);
  if (!silent) {
    job.files.forEach(function (f) { seen.delete(fileKey(f.file)); });
    if (job.descFile) seen.delete(fileKey(job.descFile));
  }
  jobs.forEach(function (o) { if (o.parentJob === job) { o.parentJob = null; refreshJob(o); } });
  updateDock();
  updateTabCount();
}

async function pump() {
  if (current || !queue.length) { updateDock(); return; }
  var job = queue.shift();
  current = job;
  acquireWake();
  try { await runJobNow(job); }
  finally {
    current = null;
    job.run = null;
    if (!queue.length) {
      releaseWake();
      document.title = 'Discpress';
      if (document.hidden) notifyDone();
    }
    updateDock();
    pump();
  }
}

// chdman never finishes when it finds no data: its progress then reads "nan% complete" (0 of 0)
var STALLED = 'chdman found no data to convert in these files and would never have finished, so it was stopped. Check that the .cue, .gdi or .toc file lists the disc\u2019s tracks.';
function stalledProgress(t) { return /\bnan% complete/i.test(t); }

async function runJobNow(job) {
  job.state = 'running';
  job.stalled = false;
  job.log = [];
  job.outputs = [];
  job.redump = null;
  refreshJob(job, false);
  setProgress(job, null, 'Starting…');
  try { await Engine.ready(); }
  catch (e) { job.state = 'error'; job.errorText = e.message; refreshJob(job, true); return; }
  if (job.identPromise && job.identState !== 'done') {
    setProgress(job, null, 'Identifying game…');
    // start as soon as the game is known; the checksum confirming the exact release can finish
    // meanwhile (results are renamed if needed). Files written straight into a folder are named
    // when created, so that mode waits for the checksum.
    await (settings.storage === 'folder' && outDir ? job.identPromise : job.identKnown);
    if (job.state !== 'running') return;
    applyIdent(job, true);
  }
  // automatic thread count: measure this device once, before its first compression
  if (job.kind === 'create' && job.opts.preset !== 'none' && job.disc !== 'ld' && settings.threads === 'auto' && !Tuning.result) {
    setProgress(job, null, 'Measuring this device\u2019s speed (only once)\u2026');
    await ensureTuned(function (n, rate) {
      setProgress(job, null, 'Measuring this device\u2019s speed (only once)\u2026', [plural(n, 'thread') + ': ' + rate.toFixed(1) + ' MB/s']);
    });
    if (job.state !== 'running') return;
  }
  var spec = buildJob(job);
  if (spec.rename) {
    var nm = outBase(job) + '.chd', src = job.files[0].file;
    try {
      if (settings.storage === 'folder' && outDir) {
        setProgress(job, null, 'Copying to folder…');
        var fh = await outDir.getFileHandle(nm, { create: true });
        var w = await fh.createWritable();
        await src.stream().pipeTo(w);
        job.folderName = outDir.name;
        job.outputs = [{ name: nm, size: src.size, kind: 'disk' }];
      } else {
        job.outputs = [{ name: nm, size: src.size, kind: 'blob', blob: src }];
      }
      job.state = 'done';
    } catch (e) { job.state = 'error'; job.errorText = e.message; }
    refreshJob(job, true);
    return;
  }
  appendLog(job, '$ ' + spec.cmdline);
  if (spec.outMode === 'opfs' && spec.expected) {
    var est = await Store.estimate();
    if (est && est.quota && est.quota - est.usage < spec.expected * 1.05) {
      appendLog(job, 'Warning: browser storage may be too small (' + fmtBytes(est.quota - est.usage) + ' free, about ' + fmtBytes(spec.expected) + ' needed).');
      toast('Browser storage may be too small for this job (' + fmtBytes(est.quota - est.usage) + ' free).', 'err');
    }
  }
  var t0 = performance.now(), phaseStart = t0, lastPhase = '', lastPct = 0, workerError = '';
  job.run = Engine.run({
    jobId: job.id, dirPath: Store.dirPath(job.id), args: spec.args, inputs: spec.inputs, writable: spec.writable,
    slots: spec.slots, helpers: spec.helpers, outMode: spec.outMode, outDir: outDir,
    onLine: function (s, t) {
      appendLog(job, t);
      var fm = /final ratio = ([\d.]+)%/.exec(t);
      if (fm) setProgress(job, 100, 'Finishing…', ['ratio ' + fm[1] + '%']);
    },
    onProgress: function (t) {
      if (stalledProgress(t)) { if (!job.stalled) { job.stalled = true; job.run.cancel(); } return; }
      var m = /^\s*([A-Za-z][A-Za-z ]*?),\s*([\d.]+)% complete(?:.*ratio=([\d.]+)%)?/.exec(t);
      if (!m) return;
      var phase = m[1], pct = parseFloat(m[2]);
      if (phase !== lastPhase) { lastPhase = phase; phaseStart = performance.now(); }
      lastPct = pct;
      var el2 = (performance.now() - phaseStart) / 1000, eta = pct > 1.5 ? el2 * (100 - pct) / pct : NaN;
      var bits = [];
      if (m[3]) bits.push('ratio ' + m[3] + '%');
      if (isFinite(eta)) bits.push(fmtDur(eta) + ' left');
      setProgress(job, pct, phase + ' ' + pct.toFixed(1) + '%', bits);
      if (job === current) document.title = Math.floor(pct) + '% · ' + job.title + ' · Discpress';
      updateDock();
    },
    onNotice: function (m) {
      if (m.level !== 'debug') appendLog(job, m.message);
      if (m.level === 'error') { toast(m.message, 'err'); workerError = workerError || m.message; }
    },
    onStorage: function (mode) {
      job.storage = mode;
      if (spec.outMode === 'opfs' && mode === 'mem') { Store.available = false; updateChips(); }
    }
  });
  job.progressPct = function () { return lastPct; };
  try {
    var res = await job.run.promise;
    job.elapsed = performance.now() - t0;
    if (res.error) appendLog(job, res.error);
    if (res.code === 0) {
      if (job.kind === 'chd' && job.action === 'verify') await redumpCheck(job);
      job.state = 'done';
      job.folderName = spec.outMode === 'stream' && outDir ? outDir.name : '';
      job.outputs = (res.outputs || []).filter(function (o) { return o.name; }).sort(function (a, b) {
        var ea = /\.(cue|gdi|toc)$/i.test(a.name) ? 0 : 1, eb = /\.(cue|gdi|toc)$/i.test(b.name) ? 0 : 1;
        return ea - eb || a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      if (job.kind === 'chd' && job.action === 'info') job.lastInfo = parseInfo(job.log);
      if (job.identState === 'done') renameOutputs(job); // the checksum finished while converting
    } else {
      job.state = 'error';
      if (res.readFail) { job.errorText = readFailHint(res.error); Store.removeJob(job.id); refreshJob(job, true); return; }
      var errs = job.log.filter(function (l) { return /error|failed|invalid|unsupported|missing|not /i.test(l) && !/^\$ /.test(l); });
      job.errorText = (errs.slice(-3).join('\n') || res.error || 'chdman exited with code ' + res.code) + (job.action === 'verify' ? '' : '');
      // the worker's own report (a damaged compressed ISO, an unreadable input, full storage) explains chdman's error best
      if (workerError && job.errorText.indexOf(workerError) < 0) job.errorText = workerError + '\n' + job.errorText;
      if (job.kind === 'chd' && job.action === 'verify') job.errorText = 'Verification failed. ' + job.errorText;
      Store.removeJob(job.id);
    }
  } catch (e) {
    if (e.canceled && job.stalled) { job.state = 'error'; job.errorText = STALLED; }
    else if (e.canceled) { job.state = 'canceled'; }
    else { job.state = 'error'; job.errorText = readFailHint(e.message); appendLog(job, e.message); }
    Store.removeJob(job.id);
  }
  refreshJob(job, true);
}

/* ---------- comparing a CHD with Redump ---------- */
// After a successful verify: extract with Redump's layout into checksums only (the worker's 'crc'
// output, no files), and look the files up in the database by size and CRC-32. The database lists
// one file per disc: the ISO, the only .bin, or the main data track's.
async function redumpCheck(job) {
  job.redump = null;
  var type = job.info && job.info.type;
  if (!/^(cd|gdrom|dvd)$/.test(type)) return;
  var ci = chdInputs(job), cd = type !== 'dvd', res;
  var args = [cd ? 'extractcd' : 'extractdvd', '-i', '/in/' + ci.name, '-o', '/out/check' + (cd ? '.cue' : '.iso')].concat(cd ? ['--redump'] : [], ci.parentArgs);
  setProgress(job, null, 'Comparing with Redump…');
  try {
    await GameDB.ready();
    job.run = Engine.run({
      jobId: job.id, args: args, inputs: ci.inputs, slots: 0, helpers: readHelpers(), outMode: 'crc',
      onLine: function () {},
      onProgress: function (t) {
        var m = /([\d.]+)% complete/.exec(t);
        if (m) setProgress(job, parseFloat(m[1]), 'Comparing with Redump ' + parseFloat(m[1]).toFixed(1) + '%');
      }
    });
    res = await job.run.promise;
  } catch (e) {
    if (e.canceled) throw e;
    appendLog(job, 'Could not compare with Redump: ' + e.message);
    return;
  }
  if (res.code !== 0) { appendLog(job, 'Could not compare with Redump (chdman exited with code ' + res.code + ').'); return; }
  var files = (res.outputs || []).filter(function (o) { return o.crc && !/\.cue$/i.test(o.name); });
  var whole = files.length === 1, id = job.ident || {};
  var trackOf = function (n) { var m = /\(Track 0*(\d+)\)\.\w+$/.exec(n); return m ? m[1] : ''; };
  var hits = [];
  files.forEach(function (f) { GameDB.size(f.size).forEach(function (e) { if (e.crc === f.crc) hits.push({ e: e, f: f }); }); });
  if (hits.length) {
    var serial = normSerial(id.serial), hit = hits.find(function (h) { return serial && normSerial(h.e.serial) === serial; }) || hits[0];
    var names = hits.map(function (h) { return h.e.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
    job.redump = { match: true, entry: hit.e, track: whole ? '' : trackOf(hit.f.name) };
    // the checksum settles which release it is
    var entry = names.length > 1 ? Object.assign({}, hit.e, { alternatives: names }) : hit.e;
    job.ident = Object.assign({}, id, { sys: hit.e.sys, entry: entry, name: hit.e.name, method: 'hash', serial: id.serial || hit.e.serial });
    applyIdent(job);
    return;
  }
  // not Redump's: the file Redump lists for the identified release differs
  var e = id.entry, f = e && (whole ? files[0] : files.find(function (x) { return trackOf(x.name) === String(e.track || 1); }));
  if (f) job.redump = { match: false, entry: e, track: whole ? '' : trackOf(f.name), otherSize: f.size !== e.size };
}

async function acquireWake() {
  if (!settings.wake || !('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', function () { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
function releaseWake() {
  if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && current) acquireWake();
});
function notifyDone() {
  try {
    if (window.Notification && Notification.permission === 'granted') new Notification('Discpress', { body: 'All jobs finished.' });
  } catch (e) { /* ignore */ }
}

/* ============================================================
   outputs: download / share / save to folder
   ============================================================ */
async function outputFile(job, out) {
  if (out.kind === 'blob') return new File([out.blob], out.name, { type: 'application/octet-stream' });
  var f = await Store.file(job.id, out.slot);
  return new File([f], out.name, { type: 'application/octet-stream' });
}
async function downloadOutput(job, out) {
  try {
    var f = await outputFile(job, out);
    var url = URL.createObjectURL(f);
    var a = el('a', { href: url, download: out.name, style: 'display:none' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10 * 60 * 1000);
    if (!isIOS) out.downloaded = true;
    refreshJob(job);
  } catch (e) {
    toast('Could not open the result: ' + e.message, 'err');
  }
}
// one save action per platform: iPhone/iPad use the share sheet ("Save to Files"),
// which also works inside apps that cannot download; everything else downloads
var useShareSheet = isIOS && !!navigator.canShare;
// but not for large files: WebKit's share sheet reads each file whole into memory and hands it to the
// app showing the page, and iOS closes that app when memory runs out (a 1 GB PSP CHD did, in Sitecase).
// Those are downloaded instead, which Safari streams from disk to Downloads in Files.
var SHARE_MAX = DEBUG.shareMax || 512 * 1048576;
function viaShare(outs) {
  return useShareSheet && outs.reduce(function (n, o) { return n + (o.size || 0); }, 0) <= SHARE_MAX;
}
function saveButton(outs, onclick, many) {
  var share = viaShare(outs);
  return el('button', { class: 'btn sm' + (many ? '' : ' primary'), onclick: onclick }, icon(share ? 'i-share' : 'i-download'),
    many ? (share ? 'Save all ' + outs.length + ' to Files' : 'Download all ' + outs.length) : (share ? 'Save to Files' : 'Download'));
}
async function saveOutput(job, out) {
  if (!viaShare([out])) return downloadOutput(job, out);
  var f;
  try { f = await outputFile(job, out); }
  catch (e) { toast('Could not open the result: ' + e.message, 'err'); return; }
  if (!navigator.canShare({ files: [f] })) return downloadOutput(job, out);
  try {
    await navigator.share({ files: [f] });
    out.downloaded = true;
    refreshJob(job);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // closed by the user
    // the share sheet can fail on very large files: download it instead (Safari saves it to Downloads in Files)
    toast('The share sheet could not take this file (' + (e && e.message || e) + '). Downloading it instead.', 'err');
    return downloadOutput(job, out);
  }
}
async function downloadMany(list) {
  var outs = [];
  list.forEach(function (job) { job.outputs.forEach(function (o) { if (o.kind !== 'disk') outs.push([job, o]); }); });
  if (outs.length && viaShare(outs.map(function (x) { return x[1]; }))) {
    // one share sheet for all files
    try {
      var files = [];
      for (var j = 0; j < outs.length; j++) files.push(await outputFile(outs[j][0], outs[j][1]));
      if (navigator.canShare({ files: files })) {
        await navigator.share({ files: files });
        outs.forEach(function (x) { x[1].downloaded = true; });
        list.forEach(function (job) { refreshJob(job); });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    for (var k = 0; k < outs.length; k++) await saveOutput(outs[k][0], outs[k][1]);
    return;
  }
  for (var i = 0; i < outs.length; i++) {
    await downloadOutput(outs[i][0], outs[i][1]);
    await sleep(700);
  }
}
async function saveToFolder(list) {
  var dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'chdman-out' }); }
  catch (e) { return; }
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    var job = list[i];
    for (var k = 0; k < job.outputs.length; k++) {
      var out = job.outputs[k];
      if (out.kind === 'disk') continue;
      try {
        toast('Saving ' + out.name + '…', null, 2000);
        var f = await outputFile(job, out);
        var fh = await dir.getFileHandle(out.name, { create: true });
        var w = await fh.createWritable();
        await f.stream().pipeTo(w);
        out.downloaded = true;
        n++;
      } catch (e) {
        toast('Could not save ' + out.name + ': ' + e.message, 'err');
      }
    }
    refreshJob(job);
  }
  if (n) toast('Saved ' + plural(n, 'file') + ' to ' + dir.name + '.');
}

/* ============================================================
   dock (bottom bar)
   ============================================================ */
function updateDock() {
  var dock = $('#dock');
  if (!dock) return;
  var counts = { ready: 0, queued: 0, running: 0, done: 0, error: 0 };
  jobs.forEach(function (j) { if (counts[j.state] != null) counts[j.state]++; });
  dock.hidden = !jobs.length || activeTab !== 'convert';
  document.body.classList.toggle('has-dock', !dock.hidden);
  var parts = [];
  if (counts.running) parts.push(el('b', null, current ? current.title : 'Working'));
  if (counts.queued) parts.push(counts.queued + ' queued');
  if (counts.ready) parts.push(counts.ready + ' ready');
  if (counts.done) parts.push(counts.done + ' done');
  if (counts.error) parts.push(counts.error + ' failed');
  var t = $('#dockText');
  t.replaceChildren();
  parts.forEach(function (p, i) { if (i) t.append(' · '); t.append(p); });
  var bar = $('#dockBar');
  bar.hidden = !current;
  if (current && current.progressPct) bar.querySelector('i').style.width = current.progressPct() + '%';
  // with a single job the card's own button is enough
  $('#startAll').hidden = counts.ready < 2;
  $('#startAll').lastChild.textContent = 'Start all (' + counts.ready + ')';
  var withOut = jobs.filter(function (j) { return j.state === 'done' && j.outputs.length; });
  var nOut = withOut.reduce(function (s, j) { return s + j.outputs.filter(function (o) { return o.kind !== 'disk'; }).length; }, 0);
  $('#dlAll').hidden = nOut < 2;
  var allOut = [];
  withOut.forEach(function (j) { j.outputs.forEach(function (o) { if (o.kind !== 'disk') allOut.push(o); }); });
  $('#dlAll').lastChild.textContent = viaShare(allOut) ? 'Save all to Files' : 'Download all';
  $('#saveAll').hidden = !window.showDirectoryPicker || nOut < 2;
  $('#clearDone').hidden = !jobs.some(function (j) { return j.state === 'done' || j.state === 'canceled' || j.state === 'error'; });
}

/* ============================================================
   command-line tab
   ============================================================ */
var OPT = {
  input: ['i', 'Input file', 'file'], inputparent: ['ip', 'Input parent CHD', 'file'], output: ['o', 'Output file name', 'out'],
  outputbin: ['ob', 'Output .bin name', 'out'], outputparent: ['op', 'Output parent CHD', 'file'], splitbin: ['sb', 'One .bin file per track', 'bool'],
  redump: ['rd', 'As Redump: CRLF cue sheet, a .bin per track (Discpress)', 'bool'],
  keepcue: ['kc', 'Keep the .cue in the CHD for extractcd --redump; checksums unchanged (Discpress)', 'bool'],
  codecplan: ['cp', 'Try each hunk only with the codecs meant for it (audio: FLAC, CD data: LZMA, other data: all but FLAC); checksums unchanged (Discpress)', 'bool'],
  libdeflate: ['ld', 'Deflate with libdeflate: 2–3× faster, a little smaller; checksums unchanged (Discpress)', 'bool'],
  verbose: ['v', 'Verbose output', 'bool'], fix: ['f', 'Fix the SHA-1 if it is incorrect', 'bool'],
  inputstartbyte: ['isb', 'Input start byte', 'num'], inputstarthunk: ['ish', 'Input start hunk', 'num'], inputbytes: ['ib', 'Input length (bytes)', 'num'],
  inputhunks: ['ih', 'Input length (hunks)', 'num'], inputstartframe: ['isf', 'Input start frame', 'num'], inputframes: ['if', 'Input length (frames)', 'num'],
  hunksize: ['hs', 'Hunk size (bytes)', 'num'], unitsize: ['us', 'Unit size (bytes)', 'num'], compression: ['c', 'Compression codecs', 'codecs'],
  template: ['tp', 'Hard disk template', 'template'], ident: ['id', 'Ident file (CHS info)', 'file'], chs: ['chs', 'CHS geometry (cyl,heads,sectors)', 'text'],
  size: ['s', 'Size (bytes)', 'num'], sectorsize: ['ss', 'Sector size (bytes)', 'num'], tag: ['t', 'Metadata tag (4 characters)', 'text'],
  index: ['ix', 'Metadata index', 'num'], valuetext: ['vt', 'Text value', 'text'], valuefile: ['vf', 'Value from file', 'file'],
  nochecksum: ['nocs', 'Exclude from the overall SHA-1', 'bool']
};
var SLICE = ['inputstartbyte', 'inputstarthunk', 'inputbytes', 'inputhunks'];
var CMDS = [
  ['createcd', 'Create a CD CHD from a .cue, .gdi, .toc, .nrg or .iso', ['*input', '*output', 'compression', 'codecplan', 'libdeflate', 'hunksize', 'outputparent', 'keepcue'], 'Create'],
  ['createdvd', 'Create a DVD CHD from an .iso', ['*input', '*output', 'compression', 'codecplan', 'libdeflate', 'hunksize', 'outputparent'].concat(SLICE), 'Create'],
  ['createhd', 'Create a hard disk CHD from a raw image (or a blank one)', ['input', '*output', 'compression', 'codecplan', 'libdeflate', 'hunksize', 'template', 'chs', 'size', 'sectorsize', 'ident', 'outputparent'].concat(SLICE), 'Create'],
  ['createraw', 'Create a raw CHD from any file', ['*input', '*output', '*hunksize', '*unitsize', 'compression', 'codecplan', 'libdeflate', 'outputparent'].concat(SLICE), 'Create'],
  ['createld', 'Create a LaserDisc CHD from an .avi', ['*input', '*output', 'compression', 'hunksize', 'inputstartframe', 'inputframes', 'outputparent'], 'Create'],
  ['extractcd', 'Extract a CD CHD to .cue/.bin, .gdi or .toc', ['*input', '*output', 'outputbin', 'splitbin', 'redump', 'inputparent'], 'Extract'],
  ['extractdvd', 'Extract a DVD CHD to an .iso', ['*input', '*output', 'inputparent'].concat(SLICE), 'Extract'],
  ['extracthd', 'Extract a hard disk CHD to a raw image', ['*input', '*output', 'inputparent'].concat(SLICE), 'Extract'],
  ['extractraw', 'Extract raw data from a CHD', ['*input', '*output', 'inputparent'].concat(SLICE), 'Extract'],
  ['extractld', 'Extract a LaserDisc CHD to an .avi', ['*input', '*output', 'inputparent', 'inputstartframe', 'inputframes'], 'Extract'],
  ['info', 'Show information about a CHD', ['*input', 'verbose'], 'Inspect'],
  ['verify', 'Verify the integrity of a CHD', ['*input', 'inputparent', 'fix'], 'Inspect'],
  ['copy', 'Copy a CHD to a new CHD (re-compress, change hunk size)', ['*input', '*output', 'compression', 'hunksize', 'inputparent', 'outputparent'].concat(SLICE), 'Other'],
  ['addmeta', 'Add metadata to a CHD (uncompressed CHDs only)', ['*input', '*tag', 'index', 'valuetext', 'valuefile', 'nochecksum'], 'Metadata'],
  ['delmeta', 'Remove metadata from a CHD (uncompressed CHDs only)', ['*input', '*tag', 'index'], 'Metadata'],
  ['dumpmeta', 'Dump metadata from a CHD', ['*input', '*tag', 'index', 'output'], 'Metadata'],
  ['listtemplates', 'List the built-in hard disk templates', [], 'Other']
];
var FILE_FLAGS = { '-i': 1, '--input': 1, '-ip': 1, '--inputparent': 1, '-op': 1, '--outputparent': 1, '-vf': 1, '--valuefile': 1, '-id': 1, '--ident': 1 };
var OUT_FLAGS = { '-o': 1, '--output': 1, '-ob': 1, '--outputbin': 1 };
var cli = { cmd: 'createcd', files: [], vals: {}, textMode: false, run: null, templates: null, outAuto: true };

function cliSpec() { return CMDS.find(function (c) { return c[0] === cli.cmd; }); }
function cliWritable() { return cli.cmd === 'addmeta' || cli.cmd === 'delmeta' || (cli.cmd === 'verify' && cli.vals.fix); }

function cliInit() {
  var sel = $('#cliCmd'), groups = {};
  CMDS.forEach(function (c) {
    if (!groups[c[3]]) { groups[c[3]] = el('optgroup', { label: c[3] }); sel.append(groups[c[3]]); }
    groups[c[3]].append(el('option', { value: c[0] }, c[0] + ' — ' + c[1]));
  });
  sel.value = cli.cmd;
  sel.addEventListener('change', function () { cli.cmd = sel.value; cli.vals = {}; cli.outAuto = true; cliAutofill(); cliRender(); });
  $('#cliAdd').addEventListener('click', function () { pickFiles('cliFileInput', cliAddFiles); });
  function cliAddFiles(list) {
    list.forEach(function (f) {
      cli.files = cli.files.filter(function (x) { return x.name !== f.name; });
      cli.files.push(f);
    });
    
    cliAutofill();
    cliRender();
  }
  $('#cliEditToggle').addEventListener('click', function () {
    cli.textMode = !cli.textMode;
    if (cli.textMode) $('#cliText').value = cliCommand().display;
    cliRender();
  });
  $('#cliText').addEventListener('input', function () {});
  $('#cliRun').addEventListener('click', cliRun);
  $('#cliCancel').addEventListener('click', function () { if (cli.run) cli.run.cancel(); });
  cliRender();
}
function cliAutofill() {
  var spec = cliSpec();
  if (!spec) return;
  var names = cli.files.map(function (f) { return f.name; });
  if (!cli.vals.input && names.length) {
    var pref = /^create(cd)$/.test(cli.cmd) ? /\.(cue|gdi|toc|nrg|iso)$/i : /^create(dvd)$/.test(cli.cmd) ? /\.iso$/i : /^createld$/.test(cli.cmd) ? /\.avi$/i : /^create/.test(cli.cmd) ? /./ : /\.chd$/i;
    cli.vals.input = names.find(function (n) { return pref.test(n); }) || '';
  }
}
function cliDefaultOut() {
  var inName = cli.vals.input ? stem(cli.vals.input) : 'output';
  var e = { createcd: 'chd', createdvd: 'chd', createhd: 'chd', createraw: 'chd', createld: 'chd', copy: 'chd', extractcd: 'cue', extractdvd: 'iso', extracthd: 'img', extractraw: 'raw', extractld: 'avi', dumpmeta: 'bin' }[cli.cmd];
  if (cli.cmd === 'copy') return inName + '-copy.chd';
  return e ? inName + '.' + e : '';
}
function cliRender() {
  var spec = cliSpec();
  $('#cliDesc').textContent = spec[1] + '.';
  var list = $('#cliFiles');
  list.replaceChildren();
  cli.files.forEach(function (f) {
    list.append(el('li', null, el('span', null, f.name), el('small', null, fmtBytes(f.size)),
      el('button', { class: 'icon-btn', 'aria-label': 'Remove ' + f.name, onclick: function () { cli.files = cli.files.filter(function (x) { return x !== f; }); Object.keys(cli.vals).forEach(function (k) { if (cli.vals[k] === f.name) cli.vals[k] = ''; }); cliRender(); } }, icon('i-x'))));
  });
  $('#cliFilesEmpty').hidden = !!cli.files.length;
  var box = $('#cliOpts');
  box.replaceChildren();
  var fileOpts = [['', '— none —']].concat(cli.files.map(function (f) { return [f.name, f.name]; }));
  spec[2].forEach(function (o) {
    var req = o.charAt(0) === '*', key = req ? o.slice(1) : o, d = OPT[key], label = d[1] + (req ? ' *' : ''), type = d[2];
    var set = function (v) { cli.vals[key] = v; cliPreview(); };
    var fld;
    if (type === 'file') {
      fld = selectField(label + '  (-' + d[0] + ')', fileOpts, cli.vals[key] || '', function (v) { set(v); if (key === 'input') cliRender(); });
    } else if (type === 'bool') {
      fld = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!cli.vals[key], onchange: function (e) { set(e.target.checked); if (key === 'fix') cliPreview(); } }), d[1] + '  (-' + d[0] + ')');
    } else if (type === 'out') {
      var def = key === 'output' ? cliDefaultOut() : '';
      if (key === 'output' && cli.outAuto) cli.vals.output = def;
      fld = textField(label + '  (-' + d[0] + ')', cli.vals[key] != null ? cli.vals[key] : '', function (v) { if (key === 'output') cli.outAuto = false; set(v); }, { placeholder: def || 'optional' });
    } else if (type === 'codecs') {
      fld = textField(label + '  (-' + d[0] + ')', cli.vals[key] || '', set, { placeholder: 'default', hint: 'Up to 4 of: lzma, zlib, zstd, huff, flac, cdlz, cdzl, cdzs, cdfl, avhu — or none' });
    } else if (type === 'template') {
      var opts = [['', '— none —']].concat((cli.templates || []).map(function (t) { return [t.id, t.label]; }));
      fld = selectField(label + '  (-' + d[0] + ')', opts, cli.vals[key] || '', set);
      if (!cli.templates) loadTemplates();
    } else {
      fld = textField(label + '  (-' + d[0] + ')', cli.vals[key] || '', set, { inputmode: type === 'num' ? 'numeric' : null });
    }
    box.append(fld);
  });
  if (!spec[2].length) box.append(el('p', { class: 'small muted', style: 'margin:0' }, 'This command has no options.'));
  box.hidden = cli.textMode;
  $('#cliOptsTitle').textContent = cli.textMode ? 'Command' : 'Options';
  $('#cliPreview').hidden = cli.textMode;
  $('#cliText').hidden = !cli.textMode;
  $('#cliTextHint').hidden = !cli.textMode;
  $('#cliEditToggle').textContent = cli.textMode ? 'Use the form' : 'Edit as text';
  cliPreview();
}
async function loadTemplates() {
  cli.templates = [];
  try {
    await Engine.ready();
    var lines = [];
    await Engine.run({ jobId: 'tpl' + uid(), args: ['listtemplates'], onLine: function (s, t) { lines.push(t); } }).promise;
    lines.forEach(function (l) {
      var m = /^\s*(\d+)\s+(.+?)\s{2,}(.+?)\s{2,}\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(l);
      if (m) cli.templates.push({ id: m[1], label: m[1] + ': ' + m[2] + ' ' + m[3] + ' (' + m[8].trim() + ')' });
    });
    if (cli.cmd === 'createhd') cliRender();
  } catch (e) { /* ignore */ }
}
function cliCommand() {
  var spec = cliSpec(), args = [cli.cmd], display = [cli.cmd], missing = [];
  var writable = cliWritable();
  spec[2].forEach(function (o) {
    var req = o.charAt(0) === '*', key = req ? o.slice(1) : o, d = OPT[key], v = cli.vals[key], type = d[2];
    if (type === 'bool') { if (v) { args.push('-' + d[0]); display.push('-' + d[0]); } return; }
    if (v == null || v === '') { if (req) missing.push(d[1]); return; }
    var real = v;
    if (type === 'file') real = (key === 'input' && writable ? '/out/' : '/in/') + v;
    else if (type === 'out') real = '/out/' + base(v);
    args.push('-' + d[0], String(real));
    display.push('-' + d[0], String(v));
  });
  return { args: args, display: 'chdman ' + display.map(quoteArg).join(' '), missing: missing };
}
function cliPreview() {
  var c = cliCommand();
  $('#cliPreview').textContent = c.display + (c.missing.length ? '\n# still needed: ' + c.missing.join(', ') : '');
}
function cliParseText(text) {
  var toks = tokenize(text.trim()), args = [];
  if (toks[0] && /^chdman(\.exe)?$/i.test(toks[0])) toks.shift();
  var cmd = toks[0];
  var writable = cmd === 'addmeta' || cmd === 'delmeta' || (cmd === 'verify' && toks.some(function (t) { return t === '-f' || t === '--fix'; }));
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i], prev = toks[i - 1];
    if (i > 0 && FILE_FLAGS[prev]) {
      var name = base(t);
      var f = cli.files.find(function (x) { return x.name === name; }) || cli.files.find(function (x) { return x.name.toLowerCase() === name.toLowerCase(); });
      if (!f) throw new Error('"' + t + '" is not in the file list. Add it with "Add files" first.');
      args.push((writable && (prev === '-i' || prev === '--input') ? '/out/' : '/in/') + f.name);
    } else if (i > 0 && OUT_FLAGS[prev]) args.push('/out/' + base(t));
    else args.push(t);
  }
  return args;
}

async function cliRun() {
  var args, c;
  if (!(await ensureFolder())) { toast('Choose an output folder first (Settings).', 'err'); return; }
  try {
    if (cli.textMode) args = cliParseText($('#cliText').value);
    else {
      c = cliCommand();
      if (c.missing.length) { toast('Please fill in: ' + c.missing.join(', '), 'err'); return; }
      args = c.args;
    }
  } catch (e) { toast(e.message, 'err'); return; }
  if (!args.length) return;
  var writable = [], inputs = [];
  var writeTarget = args.find(function (a) { return /^\/out\//.test(a) && cli.files.some(function (f) { return '/out/' + f.name === a; }); });
  cli.files.forEach(function (f) {
    if (writeTarget === '/out/' + f.name) writable.push({ name: f.name, blob: f });
    else inputs.push({ name: f.name, blob: f });
  });
  var res = $('#cliResult'), con = $('#cliConsole'), outs = $('#cliOuts'), prog = $('#cliProg');
  res.hidden = false;
  con.textContent = '$ ' + (c ? c.display : $('#cliText').value.trim()) + '\n';
  outs.replaceChildren();
  prog.hidden = false;
  var barI = prog.querySelector('i'), ptext = prog.querySelector('.ptext');
  prog.querySelector('.bar').classList.add('indet');
  ptext.textContent = 'Running…';
  $('#cliRun').disabled = true;
  $('#cliCancel').hidden = false;
  var cjob = { id: 'cli' + uid(), outputs: [], el: null }, stalled = false;
  try {
    await Engine.ready();
    var isCreate = /^(create|copy)/.test(args[0]);
    var comp = args.indexOf('-c') >= 0 ? args[args.indexOf('-c') + 1] : '';
    if (isCreate && comp !== 'none') {
      ptext.textContent = 'Measuring this device\u2019s speed (only once)\u2026';
      await ensureTuned();
      ptext.textContent = 'Running\u2026';
    }
    var nt = threadCount();
    cli.run = Engine.run({
      jobId: cjob.id, dirPath: Store.dirPath(cjob.id), args: args, inputs: inputs, writable: writable,
      slots: /^(info|listtemplates)$/.test(args[0]) || (args[0] === 'verify' && !writable.length) ? 0 : args[0] === 'extractcd' ? 101 : 3,
      outMode: settings.storage === 'folder' && outDir ? 'stream' : settings.storage === 'memory' || !Store.available ? 'mem' : 'opfs', outDir: outDir,
      helpers: isCreate && comp !== 'none' && nt > 1 ? nt : /^(verify|extract(cd|dvd|hd|raw))$/.test(args[0]) ? readHelpers() : 0,
      onLine: function (s, t) { con.textContent += t + '\n'; con.scrollTop = con.scrollHeight; },
      onProgress: function (t) {
        if (stalledProgress(t)) { if (!stalled) { stalled = true; cli.run.cancel(); } return; }
        var m = /([\d.]+)% complete/.exec(t);
        if (m) { prog.querySelector('.bar').classList.remove('indet'); barI.style.width = m[1] + '%'; ptext.textContent = t.trim(); }
      },
      onNotice: function (m) { if (m.level !== 'debug') con.textContent += m.message + '\n'; }
    });
    var r = await cli.run.promise;
    con.textContent += '\n[exit code ' + r.code + (r.error ? ': ' + r.error : '') + ']\n';
    con.scrollTop = con.scrollHeight;
    prog.hidden = true;
    cjob.outputs = r.code === 0 || (r.outputs || []).length ? (r.outputs || []) : [];
    if (r.code !== 0 && cjob.outputs.length && writable.length) cjob.outputs = cjob.outputs.filter(function (o) { return o.name !== writable[0].name; });
    cjob.outputs.forEach(function (o) {
      if (o.kind === 'disk') { outs.append(outputRow({ folderName: outDir && outDir.name }, o)); return; }
      outs.append(el('div', { class: 'out' }, el('div', { class: 'nm' }, o.name, el('small', null, fmtBytes(o.size))),
        el('div', { class: 'row' }, saveButton([o], function () { saveOutput({ id: cjob.id, outputs: cjob.outputs }, o); }))));
    });
  } catch (e) {
    con.textContent += '\n' + (e.canceled ? (stalled ? '[stopped] ' + STALLED : '[canceled]') : 'Error: ' + e.message) + '\n';
    prog.hidden = true;
  } finally {
    cli.run = null;
    $('#cliRun').disabled = false;
    $('#cliCancel').hidden = true;
  }
}

/* ============================================================
   input: pickers and drag & drop
   ============================================================ */
// iOS Safari deletes its temporary copies of picked files when a file input is
// reset or reused, which makes later reads fail ("The I/O read operation failed").
// So every pick uses a brand-new <input>, and used ones are kept, untouched.
var pickerHold = null;
function pickFiles(id, onFiles) {
  var old = document.getElementById(id);
  if (!pickerHold) { pickerHold = el('div', { hidden: true, 'aria-hidden': 'true' }); document.body.appendChild(pickerHold); }
  var inp = old.cloneNode(false);
  inp.removeAttribute('id');
  inp.addEventListener('change', function () {
    var list = Array.prototype.slice.call(inp.files || []);
    if (list.length) onFiles(list);
  });
  pickerHold.appendChild(inp);
  inp.click();
}
function readFailHint(msg) {
  if (!/I\/O read|NotReadable|could not be read|not readable/i.test(msg || '')) return msg;
  return 'The browser could not read the file (' + msg + '). On iPhone and iPad, keep the page open while it works; if the file is in iCloud Drive or another cloud app, make sure it is downloaded (or copy it to "On My iPhone") and add it again.';
}
function filesFromList(list) {
  return Array.prototype.map.call(list, function (f) { return { file: f, path: f.webkitRelativePath || f.name }; });
}
async function entriesFromDrop(dt) {
  var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
  var hasEntries = items.length && items[0].webkitGetAsEntry;
  if (!hasEntries) return filesFromList(dt.files);
  var out = [];
  async function walk(entry, path) {
    if (entry.isFile) {
      await new Promise(function (res) { entry.file(function (f) { out.push({ file: f, path: path + f.name }); res(); }, function () { res(); }); });
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      var batch;
      do {
        batch = await new Promise(function (res) { reader.readEntries(res, function () { res([]); }); });
        for (var i = 0; i < batch.length; i++) await walk(batch[i], path + entry.name + '/');
      } while (batch.length);
    }
  }
  var roots = items.map(function (it) { return it.webkitGetAsEntry && it.webkitGetAsEntry(); }).filter(Boolean);
  for (var i = 0; i < roots.length; i++) await walk(roots[i], '');
  return out;
}

/* ============================================================
   init
   ============================================================ */
/* ============================================================
   viewport, scrolling model and keyboard handling
   ============================================================ */
var rootEl = document.documentElement;
function scrollMode() { return rootEl.classList.contains('mode-shell') ? 'shell' : 'doc'; }
function scrollRoot() { return scrollMode() === 'shell' ? $('#scroller') : (document.scrollingElement || rootEl); }
var tabScroll = {};
var measureQueued = false, touchActive = false;
function shellTouching() { return touchActive; }
function measureViewport() {
  measureQueued = false;
  var vv = window.visualViewport;
  // pinch-zoom only moves the visual viewport: keep the layout as it is
  if (!(vv && vv.scale > 1.01)) {
    var h = Math.round(window.innerHeight);
    if (h > 120) rootEl.style.setProperty('--app-h', h + 'px');
  }
  detectHostInsets();
  var top = $('.top');
  if (top) rootEl.style.setProperty('--top-h-real', top.offsetHeight + 'px');
  // in the shell model the document must never stay scrolled (iOS can leave it
  // offset after the keyboard closes or after a rotation)
  if (scrollMode() === 'shell' && !rootEl.classList.contains('kb-open') && !shellTouching() && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
  if (rootEl.classList.contains('kb-open')) keepFocusedVisible();
  if (diagOpen) fillDiag();
}
// Some in-app viewers already place the page below the status bar (and above the
// home bar) yet still report safe-area insets, which would double the spacing.
// If the visible height is already short by at least that inset, don't add it again.
function safeInsets() {
  var p = document.querySelector('#probes [data-p="safe"]');
  if (!p) return { top: 0, bottom: 0 };
  var cs = getComputedStyle(p);
  return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
}
function detectHostInsets() {
  if (scrollMode() !== 'shell') { rootEl.classList.remove('host-top', 'host-bottom'); return; }
  var ins = safeInsets();
  var landscape = window.innerWidth > window.innerHeight;
  var sw = screen.width, sh = screen.height;
  var screenH = landscape ? Math.min(sw, sh) : Math.max(sw, sh);
  var slack = screenH - window.innerHeight;
  if (window.visualViewport && window.visualViewport.scale > 1.01) return;
  var hostTop = ins.top > 0 && slack >= ins.top - 4;
  var hostBottom = ins.bottom > 0 && slack >= ins.top * (hostTop ? 1 : 0) + ins.bottom - 4;
  rootEl.classList.toggle('host-top', hostTop);
  rootEl.classList.toggle('host-bottom', hostBottom);
}
function queueMeasure() {
  if (measureQueued) return;
  measureQueued = true;
  (window.requestAnimationFrame || setTimeout)(measureViewport);
}
function settleMeasure() {
  // WKWebView reports stale sizes right after rotation: measure again once things settle
  queueMeasure();
  setTimeout(queueMeasure, 120);
  setTimeout(queueMeasure, 450);
  setTimeout(queueMeasure, 1000);
}
function isTextField(n) {
  if (!n || !n.tagName) return false;
  if (n.tagName === 'TEXTAREA') return true;
  return n.tagName === 'INPUT' && /^(text|number|search|email|url|tel|password)$/i.test(n.type || 'text');
}
function keepFocusedVisible() {
  var a = document.activeElement;
  if (isTextField(a) && a.scrollIntoView) a.scrollIntoView({ block: 'center', inline: 'nearest' });
}
function setScrollMode(mode) {
  var want = mode === 'page' ? 'doc' : mode === 'app' ? 'shell' : rootEl.getAttribute('data-auto-mode') || 'doc';
  rootEl.classList.remove('mode-doc', 'mode-shell');
  rootEl.classList.add('mode-' + want);
  window.scrollTo(0, 0);
  var sc = $('#scroller');
  if (sc) sc.scrollTop = 0;
  detectHostInsets();
  settleMeasure();
  updateScrollHint();
}
function updateScrollHint() {
  var h = $('#scrollHint');
  if (!h) return;
  var auto = rootEl.getAttribute('data-auto-mode');
  h.textContent = 'Now using: ' + (scrollMode() === 'shell' ? 'fixed header' : 'page scrolling') +
    (settings.scroll === 'auto' ? ' (picked automatically' + (auto === 'shell' ? ': in-app viewer or installed app detected)' : ': regular browser)') : '') + '.';
}
function initViewport() {
  window.addEventListener('resize', queueMeasure);
  window.addEventListener('orientationchange', settleMeasure);
  window.addEventListener('pageshow', settleMeasure);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) settleMeasure(); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', queueMeasure);
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(queueMeasure);
    ro.observe($('.top'));
    // iOS web views often report safe-area insets only some time after load (WebKit bug 191872):
    // the probe's padding is the inset, so its size changing means the insets changed
    var probe = document.querySelector('#probes [data-p="safe"]');
    if (probe) ro.observe(probe, { box: 'border-box' });
  }
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', settleMeasure);
  // Fixed-header layout: the page itself must never move under the finger, even
  // while the host is still settling its size. Only real scroll areas (the content
  // area, logs, the settings sheet, text boxes) may scroll, and they don't hand the
  // gesture over to the page when they reach their ends.
  var touchY = 0, touchX = 0, touching = false;
  function scrollableAncestor(n, dy) {
    for (; n && n !== document.body && n !== rootEl; n = n.parentElement) {
      if (n.nodeType !== 1) continue;
      var cs = getComputedStyle(n);
      var oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || n.tagName === 'TEXTAREA' || n.tagName === 'DIALOG') && n.scrollHeight > n.clientHeight + 1) {
        var atTop = n.scrollTop <= 0, atBottom = n.scrollTop + n.clientHeight >= n.scrollHeight - 1;
        if ((dy > 0 && !atTop) || (dy < 0 && !atBottom)) return n;
      }
    }
    return null;
  }
  document.addEventListener('touchstart', function (e) {
    touching = touchActive = true;
    if (e.touches.length === 1) { touchY = e.touches[0].clientY; touchX = e.touches[0].clientX; }
  }, { passive: true });
  document.addEventListener('touchend', function (e) { if (!e.touches.length) { touching = touchActive = false; queueMeasure(); } }, { passive: true });
  document.addEventListener('touchcancel', function () { touching = touchActive = false; queueMeasure(); }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (scrollMode() !== 'shell' || e.touches.length !== 1) return; // leave pinch-zoom alone
    var t = e.touches[0], dy = t.clientY - touchY, dx = t.clientX - touchX;
    if (Math.abs(dx) > Math.abs(dy)) return; // horizontal swipes (code blocks, tables) are fine
    if (!scrollableAncestor(e.target, dy) && e.cancelable) e.preventDefault();
  }, { passive: false });
  window.addEventListener('scroll', function () {
    // if the host still managed to move the page, put it back once the finger is up
    if (scrollMode() === 'shell' && !touching && !rootEl.classList.contains('kb-open') && (window.scrollY || window.scrollX)) queueMeasure();
  }, { passive: true });

  // soft keyboard: hide the floating bar while typing on touch screens
  document.addEventListener('focusin', function (e) {
    if (isTextField(e.target) && window.matchMedia && matchMedia('(pointer: coarse)').matches) rootEl.classList.add('kb-open');
  });
  document.addEventListener('focusout', function () {
    setTimeout(function () {
      if (!isTextField(document.activeElement)) { rootEl.classList.remove('kb-open'); settleMeasure(); }
    }, 60);
  });
  settleMeasure();
}

function switchTab(name) {
  var root = scrollRoot();
  if (activeTab === name) {
    // tapping the current tab again jumps to the top, like native tab bars
    root.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  tabScroll[activeTab] = root.scrollTop;
  $$('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-tab') === name)); });
  $$('section.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
  activeTab = name;
  root.scrollTop = tabScroll[name] || 0;
  updateDock();
}

/* screen info for troubleshooting layouts on unusual devices */
var diagOpen = false;
function fillDiag() {
  var out = $('#diagText');
  if (!out) return;
  var probes = {};
  $$('#probes [data-p]').forEach(function (p) { probes[p.getAttribute('data-p')] = p; });
  var cs = getComputedStyle(probes.safe);
  var vv = window.visualViewport;
  var mm = function (q) { return window.matchMedia && matchMedia(q).matches; };
  var lines = [
    'Discpress layout: ' + scrollMode() + ' (auto: ' + rootEl.getAttribute('data-auto-mode') + ', setting: ' + settings.scroll + ')',
    'window inner: ' + innerWidth + ' x ' + innerHeight + '   outer: ' + outerWidth + ' x ' + outerHeight,
    'screen: ' + screen.width + ' x ' + screen.height + '   dpr: ' + (window.devicePixelRatio || 1),
    'visual viewport: ' + (vv ? Math.round(vv.width) + ' x ' + Math.round(vv.height) + ' at ' + Math.round(vv.offsetLeft) + ',' + Math.round(vv.offsetTop) + ' scale ' + vv.scale.toFixed(2) : 'n/a'),
    'units: vh ' + probes.vh.offsetHeight + '  dvh ' + probes.dvh.offsetHeight + '  svh ' + probes.svh.offsetHeight + '  lvh ' + probes.lvh.offsetHeight,
    'safe area (t r b l): ' + [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(function (v) { return parseFloat(v) || 0; }).join(' '),
    'host insets: ' + (rootEl.classList.contains('host-top') ? 'top ' : '') + (rootEl.classList.contains('host-bottom') ? 'bottom' : '') + '   ' +
    'app height: ' + getComputedStyle(rootEl).getPropertyValue('--app-h').trim() + '   header: ' + ($('.top') ? $('.top').offsetHeight : 0),
    'page scroll: ' + Math.round(window.scrollY) + ' / ' + (document.scrollingElement ? document.scrollingElement.scrollHeight : 0) + '   content scroll: ' + Math.round($('#scroller').scrollTop) + ' / ' + $('#scroller').scrollHeight,
    'display: ' + (mm('(display-mode: standalone)') ? 'standalone' : mm('(display-mode: fullscreen)') ? 'fullscreen' : 'browser') +
      '   pointer: ' + (mm('(pointer: coarse)') ? 'coarse' : 'fine') + '   hover: ' + (mm('(hover: hover)') ? 'yes' : 'no') +
      '   orientation: ' + (mm('(orientation: portrait)') ? 'portrait' : 'landscape'),
    'text scale: ' + getComputedStyle(rootEl).fontSize + '   theme: ' + (mm('(prefers-color-scheme: dark)') ? 'dark' : 'light'),
    'cores reported: ' + (navigator.hardwareConcurrency || '?') + '   threads: ' + (settings.threads === 'auto' ? 'auto, using ' : '') + threadCount() + '   SIMD: ' + (Engine.module ? (Engine.simd ? 'yes' : 'no') : '?'),
    'speed test: ' + (Tuning.result ? Tuning.result.steps.map(function (x) { return x[0] + ' → ' + x[1] + ' MB/s'; }).join(', ') + ' (' + new Date(Tuning.result.date).toISOString().slice(0, 10) + ')' : 'not run yet'),
    'agent: ' + navigator.userAgent
  ];
  out.textContent = lines.join('\n');
}

function setChip(id, text, cls) {
  var c = document.getElementById(id);
  if (!c) { c = el('span', { class: 'chip', id: id }, el('i')); $('#chips').append(c); }
  c.className = 'chip' + (cls ? ' ' + cls : '');
  c.replaceChildren(el('i'), text);
}

async function refreshStorageInfo() {
  var est = await Store.estimate(), s = $('#storageInfo');
  if (!s) return;
  if (!Store.available) s.textContent = 'Private storage is not available in this browser; results are kept in memory.';
  else if (est && est.quota) s.textContent = 'Available to this page: about ' + fmtBytes(est.quota - est.usage) + ' free.';
  else s.textContent = '';
}

function init() {
  // tabs
  $('#brandLink').addEventListener('click', function (e) { e.preventDefault(); if (activeTab !== 'convert') switchTab('convert'); scrollRoot().scrollTo({ top: 0, behavior: 'smooth' }); });
  initViewport();
  $$('.tab').forEach(function (t) { t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); }); });

  // pickers
  var fi = $('#fileInput'), di = $('#dirInput');
  $('#addFiles').addEventListener('click', function () { pickFiles('fileInput', function (l) { addEntries(filesFromList(l)); }); });
  if ('webkitdirectory' in di && !isMobile) {
    $('#addFolder').hidden = false;
    $('#addFolder').addEventListener('click', function () { pickFiles('dirInput', function (l) { addEntries(filesFromList(l)); }); });
  }


  // drag & drop anywhere
  var drop = $('#drop'), depth = 0;
  window.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { depth++; drop.classList.add('over'); } });
  window.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('over'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', async function (e) {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('over');
    if (!e.dataTransfer) return;
    var entries = await entriesFromDrop(e.dataTransfer);
    if ($('#tab-cli').hidden === false) {
      entries.forEach(function (x) { cli.files = cli.files.filter(function (f) { return f.name !== x.file.name; }); cli.files.push(x.file); });
      cliAutofill();
      cliRender();
    } else if (entries.length) addEntries(entries);
  });

  // dock
  $('#startAll').addEventListener('click', startAll);
  $('#clearDone').addEventListener('click', function () {
    jobs.filter(function (j) { return j.state === 'done' || j.state === 'canceled' || j.state === 'error'; }).forEach(function (j) { removeJob(j, true); });
  });
  $('#dlAll').addEventListener('click', function () { downloadMany(jobs.filter(function (j) { return j.state === 'done'; })); });
  $('#saveAll').addEventListener('click', function () { saveToFolder(jobs.filter(function (j) { return j.state === 'done' && j.outputs.length; })); });

  // settings
  var dlg = $('#settings'), thr = $('#setThreads');
  thr.append(el('option', { value: 'auto' }, 'Automatic (recommended)'));
  for (var t = 1; t <= maxThreads; t++) thr.append(el('option', { value: t }, t === 1 ? '1 (single thread)' : t + ' threads' + (t === cores ? ' (all cores)' : '')));
  thr.value = settings.threads;
  thr.addEventListener('change', function () { settings.threads = thr.value === 'auto' ? 'auto' : +thr.value; saveSettings(); updateChips(); });
  $('#retune').addEventListener('click', async function () {
    var b = $('#retune'), info = $('#retuneInfo');
    b.disabled = true;
    try {
      await Tuning.measure(function (n, rate) { info.textContent = plural(n, 'thread') + ': ' + rate.toFixed(1) + ' MB/s'; });
      info.textContent = '';
    } catch (e) { info.textContent = 'Measuring failed: ' + e.message; }
    b.disabled = false;
    fillDiag();
  });
  if (!window.showDirectoryPicker) {
    var fo = $('#setStorage option[value="folder"]');
    if (fo) fo.remove();
    if (settings.storage === 'folder') settings.storage = 'auto';
  }
  $('#setStorage').value = settings.storage;
  $('#folderRow').hidden = settings.storage !== 'folder';
  $('#setStorage').addEventListener('change', function (e) {
    settings.storage = e.target.value;
    saveSettings();
    $('#folderRow').hidden = settings.storage !== 'folder';
    if (settings.storage === 'folder' && !outDir) pickFolder();
    updateChips();
  });
  $('#pickFolder').addEventListener('click', function () { pickFolder(); });
  $('#memTipBtn').addEventListener('click', function () {
    settings.storage = 'folder'; saveSettings();
    $('#setStorage').value = 'folder'; $('#folderRow').hidden = false;
    pickFolder().then(updateChips);
  });
  if (!window.showDirectoryPicker) $('#memTipBtn').hidden = true;
  $('#setRename').checked = settings.rename;
  $('#setRename').addEventListener('change', function (e) {
    settings.rename = e.target.checked; saveSettings();
    jobs.forEach(function (j) {
      if (j.state === 'running' || j.state === 'queued' || j.state === 'done' || j.outEdited) return;
      j.opts.out = settings.rename && j.ident && j.ident.name ? j.ident.name : j.title;
      refreshJob(j, true);
    });
  });
  $('#setKeepCue').checked = !!settings.keepCue;
  $('#setKeepCue').addEventListener('change', function (e) {
    settings.keepCue = e.target.checked; saveSettings();
    jobs.forEach(function (j) { if (j.el && j.kind === 'create') refreshJob(j); });
  });
  $('#setWake').checked = settings.wake;
  $('#setWake').addEventListener('change', function (e) { settings.wake = e.target.checked; saveSettings(); if (!settings.wake) releaseWake(); });
  $('#setScroll').value = settings.scroll || 'auto';
  $('#setScroll').addEventListener('change', function (e) { settings.scroll = e.target.value; saveSettings(); setScrollMode(settings.scroll); });
  updateScrollHint();
  $('#diagBox').addEventListener('toggle', function () { diagOpen = $('#diagBox').open; if (diagOpen) fillDiag(); });
  $('#diagCopy').addEventListener('click', function () {
    fillDiag();
    var t = $('#diagText').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { toast('Screen info copied.'); }, function () { toast('Copy failed; take a screenshot instead.', 'err'); });
    else toast('Copy is not available here; take a screenshot instead.', 'err');
  });
  $('#setTheme').value = settings.theme;
  $('#setTheme').addEventListener('change', function (e) { settings.theme = e.target.value; saveSettings(); applyTheme(); });
  $('#settingsBtn').addEventListener('click', function () { refreshStorageInfo(); if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); });
  $('#settingsClose').addEventListener('click', function () { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg && dlg.close) dlg.close(); });
  $('#clearStorage').addEventListener('click', async function () {
    var busy = jobs.some(function (j) { return j.state === 'running'; });
    if (busy) { toast('Wait for the running job to finish first.', 'err'); return; }
    if (!confirm('Delete all finished results from browser storage? Download anything you need first.')) return;
    for (var i = 0; i < jobs.length; i++) if (jobs[i].state === 'done') { await Store.removeJob(jobs[i].id); jobs[i].outputs = []; jobs[i].state = 'ready'; refreshJob(jobs[i], true); }
    try {
      var root = await navigator.storage.getDirectory();
      var work = await root.getDirectoryHandle('chdman-work', { create: true });
      await Store.cleanupStale(work);
    } catch (e) { /* ignore */ }
    refreshStorageInfo();
    updateDock();
    toast('Temporary storage cleared.');
  });

  window.addEventListener('beforeunload', function (e) {
    var busy = jobs.some(function (j) { return j.state === 'running' || j.state === 'queued'; });
    var unsaved = jobs.some(function (j) { return j.state === 'done' && j.outputs.some(function (o) { return !o.downloaded && o.kind !== 'disk'; }); });
    if (busy || unsaved) { e.preventDefault(); e.returnValue = ''; }
  });

  cliInit();
  updateDock();
  updateChips();

  Store.init().then(function () { updateChips(); });
  Engine.ready().then(function () {
    setChip('chipEngine', 'Engine ready' + (Engine.simd ? '' : ' (compatibility mode)'), 'ok');
  }, function (e) {
    setChip('chipEngine', 'Engine unavailable', 'err');
    $('#fatal').append(el('div', { class: 'note err fatal' }, el('b', null, 'This browser cannot run Discpress. '), e.message));
  });
}

function updateChips() {
  var nt = threadCount(), auto = settings.threads === 'auto';
  setChip('chipThreads', (auto ? 'Auto \u00b7 ' : '') + plural(nt, 'thread'), '');
  var ti = $('#threadsInfo'), rr = $('#retuneRow');
  if (ti) {
    ti.textContent = !auto ? '' : Tuning.result
      ? 'Measured on this device: ' + plural(Tuning.result.threads, 'thread') + ' (about ' + Tuning.result.rate.toFixed(1) + ' MB/s of test data).'
      : 'Discpress measures this device the first time it creates a CHD (a few seconds, once).';
    rr.hidden = !auto;
  }
  if (settings.storage === 'folder') setChip('chipStore', outDir ? 'Saving to “' + outDir.name + '”' : 'Output folder not chosen', outDir ? 'ok' : 'warn');
  else {
    var mem = settings.storage === 'memory' || !Store.available;
    setChip('chipStore', mem ? 'Results in memory' : 'Large files OK', mem ? 'warn' : 'ok');
  }
  var tip = $('#memTip');
  if (tip) tip.hidden = !(Store.checked && !Store.available && settings.storage !== 'folder');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
