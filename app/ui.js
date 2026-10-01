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
// quoted as the Advanced tab reads commands back (shellWords)
function quoteArg(a) { return /^[A-Za-z0-9_.,:\/=+-]+$/.test(a) ? a : '"' + a.replace(/(["\\])/g, '\\$1') + '"'; }
function plural(n, w, p) { return n + ' ' + (n === 1 ? w : (p || w + 's')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var toastBox = null;
function toast(msg, kind, ms) {
  toastBox = toastBox || $('#toasts');
  var t = el('div', { class: 'toast' + (kind === 'err' ? ' err' : ''), role: kind === 'err' ? 'alert' : 'status' }, msg);
  toastBox.appendChild(t);
  setTimeout(function () { t.remove(); }, ms || (kind === 'err' ? 7000 : 3800));
}
// for screen readers: what finished or failed, which the page otherwise only shows
function announce(msg) {
  var a = $('#announce');
  if (!a) return;
  a.textContent = '';
  setTimeout(function () { a.textContent = msg; }, 50);
}

/* ============================================================
   settings
   ============================================================ */
var isMobile = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
var isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
var cores = Math.max(1, navigator.hardwareConcurrency || 4);
// an iPhone/iPad app's web view (not Safari, not a home-screen web app): usually no downloads (docs/ios)
var iosWebView = isIOS && !/Safari\//.test(navigator.userAgent) && navigator.standalone !== true && !(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
// opened from the Home Screen as a web app, where iOS may not start downloads (docs/ios/hosting.md)
var iosHomeApp = isIOS && !iosWebView && (navigator.standalone === true || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches));
// the online version: nothing to download, and big results on iPhone and iPad in Safari (web/README.md)
var HOSTED_URL = 'https://powerbeef.github.io/discpress/';
// iPhones report 4 cores whatever they have (docs/ios): the speed test tries at most that many there
var iosThreadCap = isIOS && !(/iPad/.test(navigator.userAgent) || navigator.platform === 'MacIntel') ? 4 : 0;
var maxThreads = Math.min(cores, 16);
// threads: 'auto' (measured per device, see Tuning) or a fixed number of compression threads
var settings = { threads: 'auto', storage: 'auto', wake: true, theme: '', rename: true, scroll: 'auto', keepCue: false, notify: false, ps2dvd: 'dvd' };
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
// opts.agreed: names the user already agreed to replace; opts.onFail(err): the first failure (a write
// the folder refused, or a file the user chose to keep), which stops the run
function makeSink(dir, opts) {
  opts = opts || {};
  var files = {}, failed = null, agreed = new Set(opts.agreed || []);
  function fail(e) {
    if (failed) return;
    failed = e;
    if (opts.onFail) opts.onFail(e);
  }
  function q(id, fn) {
    var f = files[id];
    if (!f) return;
    f.chain = f.chain.then(function () { if (!failed) return fn(f); }).catch(fail);
  }
  return {
    handle: function (m, worker) {
      if (m.type === 's-open') {
        // existed: a file of that name was already in the folder (the user agreed to replace it). The
        // browser writes to a temporary copy until close, so on cancel or failure it stays as it was:
        // only files this job created are removed
        var f = files[m.id] = { name: m.name, w: null, closed: false, size: 0, existed: false };
        f.chain = dir.getFileHandle(m.name).then(function () { f.existed = true; }, function () {})
          .then(function () {
            // a file of the result (an extract's track file, say) that nobody asked about yet
            if (f.existed && !agreed.has(m.name)) {
              if (!confirm('\u201c' + m.name + '\u201d is already in the folder \u201c' + dir.name + '\u201d. Replace it?')) {
                var e = new Error('Stopped: \u201c' + m.name + '\u201d is already in the folder, and you chose to keep it.');
                e.kept = true;
                throw e;
              }
              agreed.add(m.name);
            }
            return dir.getFileHandle(m.name, { create: true });
          })
          .then(function (fh) { return fh.createWritable({ keepExistingData: false }); })
          .then(function (w) { f.w = w; }).catch(fail);
      } else if (m.type === 's-write') {
        q(m.id, function (f) { return f.w.write({ type: 'write', position: m.pos, data: m.data }); });
        // tells the worker, which pauses chdman while too much waits here (a slow USB drive or network folder)
        var n = m.data.byteLength, ack = function () { worker.postMessage({ type: 's-ack', bytes: n }); };
        if (files[m.id]) files[m.id].chain = files[m.id].chain.then(ack); else ack();
      } else if (m.type === 's-trunc') {
        q(m.id, function (f) { return f.w.truncate(m.size); });
      } else if (m.type === 's-close') {
        q(m.id, function (f) { f.closed = true; f.size = m.size; return f.w.close(); });
      } else if (m.type === 's-remove') {
        q(m.id, function (f) { f.closed = true; return f.w.abort().then(function () { if (!f.existed) return dir.removeEntry(f.name); }).catch(function () {}); });
      }
    },
    finish: function () {
      return Promise.all(Object.keys(files).map(function (k) { return files[k].chain; })).then(function () { if (failed) throw failed; });
    },
    abort: function () {
      // writes still queued are skipped (a cancel while the last ones are saved: "Saving to folder")
      if (!failed) failed = new Error('canceled');
      Object.keys(files).forEach(function (k) {
        var f = files[k];
        f.chain = f.chain.then(function () {
          if (f.w && !f.closed) return f.w.abort().catch(function () {}).then(function () { if (!f.existed) return dir.removeEntry(f.name).catch(function () {}); });
        }).catch(function () {});
      });
    }
  };
}

var DEBUG = {};
try { DEBUG = JSON.parse(localStorage.getItem('chdman-web-debug') || '{}') || {}; } catch (e) { /* ignore */ }
if (typeof DEBUG !== 'object') DEBUG = {}; // a stored null, number or string: no debug options

var Engine = {
  module: null, bytes: null, url: null, loading: null, error: null, simd: false,
  ready: function () {
    if (!this.loading) this.loading = this._load();
    return this.loading;
  },
  _load: async function () {
    if (typeof WebAssembly !== 'object') throw new Error(isIOS ? 'WebAssembly is turned off, which Lockdown Mode does. Discpress needs it: turn Lockdown Mode off for this app or website (Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing).' : 'This browser does not support WebAssembly.');
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
    var self = this, worker = null, helpers = [], finished = false, saving = false, rejectFn;
    var sink = o.outMode === 'stream' ? makeSink(o.outDir, {
      agreed: o.agreed,
      // a write into the folder failed, or the user kept a file: stop now (not after the whole conversion)
      onFail: function (e) {
        if (finished && !saving) return;
        if (e.kept) { e.canceled = true; toast(e.message); } // the user said no: canceled, as for the main file
        saving = false;
        cleanup();
        sink.abort();
        rejectFn(e);
      }
    }) : null;
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
      // a helper that can't start (WebAssembly out of memory, on iPhones especially) would leave the job
      // worker waiting for its results forever: stop the job instead
      function helperFailed(message) {
        if (finished) return;
        cleanup();
        if (sink) sink.abort();
        reject(new Error('A helper thread stopped (' + message + '). Try again with fewer threads (Settings).'));
      }
      for (var i = 0; i < (o.helpers || 0); i++) {
        try {
          var hw = new Worker(self.url), ch = new MessageChannel();
          hw.onmessage = function (e) { if (e.data && e.data.type === 'fatal') helperFailed(e.data.message); };
          hw.onerror = function (e) { helperFailed(e.message || 'failed to start'); };
          // (tests: DEBUG.failHelpers makes helpers fail as a miscompiling WebAssembly engine does)
          self.post(hw, { type: 'helper', port: ch.port2, fail: o.debugFail === 'all' || (o.debugFail === 'one' && i === 0) }, [ch.port2]);
          helpers.push(hw);
          ports.push(ch.port1);
        } catch (e) { break; }
      }
      worker.onmessage = function (e) {
        var m = e.data;
        if (finished) return;
        if (m.type.charAt(0) === 's' && m.type.charAt(1) === '-') { if (sink) sink.handle(m, worker); }
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
          // chdman is done, the last writes are still going: Cancel can still stop them (saving)
          saving = true;
          sink.finish().then(function () { if (saving) { saving = false; resolve(m); } }, function (e) {
            if (!saving) return;
            saving = false;
            sink.abort(); // the files it created go (a failed write left an empty or partial one)
            reject(e && e.kept ? e : new Error('Could not write to the output folder: ' + (e && e.message || e)));
          });
        }
      };
      worker.onerror = function (e) {
        if (finished) return;
        cleanup();
        if (sink) sink.abort(); // a crashed worker's files in the folder: thrown away, like a cancel's
        reject(new Error(e.message || 'The background worker failed to start.'));
      };
      self.post(worker, {
        type: 'run', jobId: o.jobId, dirPath: o.dirPath, args: o.args, inputs: o.inputs || [],
        writable: o.writable || [], slots: o.slots || 0, outMode: o.outMode || 'mem', ports: ports, debugStage: DEBUG.stage, debugSinkMax: DEBUG.sinkMax
      }, ports);
    });
    return {
      promise: promise,
      cancel: function () {
        if (finished && !saving) return;
        saving = false;
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
  // up to 8 on phones and tablets (4 on iPhones), 16 elsewhere, whatever the browser reports
  cap: iosThreadCap || (isMobile ? 8 : 16),
  key: function () { return cores + '|' + navigator.userAgent; },
  load: function () {
    try {
      var t = JSON.parse(localStorage.getItem('chdman-web-tuning') || 'null');
      // a result that stopped at a lower limit than today's (1.3.1 tried 2 threads on iPhones) is measured again
      this.result = t && t.key === this.key() && t.threads >= 1 && !(t.cap < this.cap && t.threads >= t.cap) ? t : null;
    } catch (e) { this.result = null; }
  },
  measure: function (onStep) {
    var self = this;
    if (!this.running) {
      this.running = this._measure(onStep).then(function (t) {
        self.result = t;
        // measured while the page was hidden (iOS pauses its workers) or nothing got done: used now,
        // but not kept for later visits
        if (!t.skewed) { try { localStorage.setItem('chdman-web-tuning', JSON.stringify(t)); } catch (e) { /* ignore */ } }
        self.running = null;
        updateChips();
        return t;
      }, function (e) { self.running = null; throw e; });
    }
    return this.running;
  },
  _measure: async function (onStep) {
    await Engine.ready();
    // a game's checksum (a core busy) stops now and starts over after the test (crcOf)
    pauseChecksums();
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
    var pool = [], steps = [], best = 0, bestN = 1, misses = 0, hidden = document.hidden;
    function onVisibility() { if (document.hidden) hidden = true; }
    document.addEventListener('visibilitychange', onVisibility);
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
      document.removeEventListener('visibilitychange', onVisibility);
    }
    var t = { key: this.key(), threads: bestN, rate: +best.toFixed(2), steps: steps, cores: cores, cap: Tuning.cap, date: Date.now() };
    if (hidden || !(best > 0)) t.skewed = true;
    return t;
  }
};
Tuning.load();
// compression threads to use now
function threadCount() {
  if (settings.threads !== 'auto') return settings.threads;
  return Tuning.result ? Math.min(Tuning.result.threads, Tuning.cap) : Math.min(maxThreads, isMobile ? 4 : 8, Tuning.cap);
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
// the names of the Web Locks held now (open visits), or null where the browser can't tell
async function heldLocks() {
  try {
    if (navigator.locks && navigator.locks.query) {
      var q = await navigator.locks.query();
      return new Set((q.held || []).map(function (l) { return l.name; }));
    }
  } catch (e) { /* unknown */ }
  return null;
}
var Store = {
  available: false,
  session: 's' + Date.now().toString(36) + uid(),
  init: async function () {
    // held while this visit lasts, so other visits can tell it is still open (Recovery)
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('chdman-web-' + this.session, function () { return new Promise(function () {}); });
      await sleep(50);
    }
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('no private storage');
      var root = await navigator.storage.getDirectory();
      var work = await root.getDirectoryHandle('chdman-work', { create: true });
      this.available = true;
      await this.cleanupStale(work);
      await Unzip.cleanup();
    } catch (e) {
      this.available = false;
      // results in memory (a page opened as a file in Chrome or Edge, older browsers): nothing to keep,
      // but say what an ended visit lost
      Recovery.settle(Recovery.read(), [], await heldLocks());
    }
    this.checked = true;
  },
  cleanupStale: async function (work) {
    var held = await heldLocks();
    var names = [];
    try { for await (var entry of work.keys()) names.push(entry); } catch (e) { return; }
    var records = Recovery.read();
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (n === this.session) continue;
      var stale;
      if (held) stale = !held.has('chdman-web-' + n);
      else {
        var t = parseInt(n.slice(1, 9), 36);
        stale = !t || Date.now() - t > 6 * 3600e3;
      }
      if (!stale) continue;
      // a closed or reloaded visit: keep its finished results that weren't saved (Recovery)
      if (Recovery.adopt(n, records[n])) continue;
      try { await work.removeEntry(n, { recursive: true }); } catch (e) { /* in use */ }
    }
    Recovery.settle(records, names, held);
  },
  dirPath: function (jobId, session) { return ['chdman-work', session || this.session, jobId]; },
  // a run about to write the job's folder: a removal still retrying on it (removeJob) gives up
  runs: {},
  claim: function (jobId) { this.runs[jobId] = (this.runs[jobId] || 0) + 1; return this.dirPath(jobId); },
  // session: an earlier visit's (Recovery), else this one's
  file: async function (jobId, slot, session) {
    var d = await navigator.storage.getDirectory();
    var p = this.dirPath(jobId, session);
    for (var i = 0; i < p.length; i++) d = await d.getDirectoryHandle(p[i]);
    return (await d.getFileHandle(slot)).getFile();
  },
  removeJob: async function (jobId, session) {
    Recovery.forget(jobId, session);
    if (!this.available) return;
    try {
      var d = await navigator.storage.getDirectory();
      d = await d.getDirectoryHandle('chdman-work');
      d = await d.getDirectoryHandle(session || this.session);
      // right after a cancel, the stopped worker's files can stay locked for a moment: try again,
      // unless the job runs again meanwhile
      var run = this.runs[jobId];
      for (var t = 0; ; t++) {
        try { await d.removeEntry(jobId, { recursive: true }); break; }
        catch (e) { if (e && e.name === 'NotFoundError' || t >= 5) throw e; await sleep(200 << t); }
        if (!session && this.runs[jobId] !== run) return;
      }
      if (session) { // an earlier visit's folder goes once it's empty
        var left = false;
        for await (var k of d.keys()) { left = true; void k; break; }
        if (!left) await (await (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-work')).removeEntry(session, { recursive: true });
      }
    } catch (e) { /* ignore */ }
  },
  estimate: async function () {
    try { return await navigator.storage.estimate(); } catch (e) { return null; }
  }
};

/* ============================================================
   results that outlive a reload
   iOS reloads a page that it stopped to free memory or after it sat in the background
   (docs/ios/limits.md), and an unsaved CHD went with the old visit's storage. So each visit
   keeps a small record in localStorage (the job running now, and finished results in private
   storage not saved yet); at the next start, Store.cleanupStale keeps those results, and the
   page lists them, with the job that didn't finish.
   ============================================================ */
var Recovery = {
  KEY: 'chdman-web-sessions',
  earlier: [], // [{ session, jobId, title, outputs: [{ name, size, slot, kind, session }] }]
  stopped: [], // titles of jobs that were running when their visit ended
  lost: [], // results an ended visit held only in memory: [{ title, name }]
  read: function () {
    try { var v = JSON.parse(localStorage.getItem(this.KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
  },
  write: function (all) {
    try {
      if (Object.keys(all).length) localStorage.setItem(this.KEY, JSON.stringify(all));
      else localStorage.removeItem(this.KEY);
    } catch (e) { /* ignore */ }
  },
  update: function (fn, session) {
    var all = this.read(), key = session || Store.session;
    var rec = all[key] || { results: {} };
    rec.results = rec.results || {};
    fn(rec);
    if (key === Store.session) rec.alive = Date.now(); // for visits in browsers without Web Locks (settle)
    if (!rec.running && !Object.keys(rec.results).length) delete all[key];
    else all[key] = rec;
    this.write(all);
  },
  running: function (job) {
    this.update(function (rec) { rec.running = job ? job.title : null; });
  },
  // results in memory ('blob') are recorded too: a reload loses them, and the next visit says so
  finished: function (job) {
    var outs = job.outputs.filter(function (o) { return (o.kind === 'opfs' || o.kind === 'blob') && !o.downloaded && !o.input; });
    this.update(function (rec) {
      if (outs.length) rec.results[job.id] = { title: job.title, outputs: outs.map(function (o) { return { name: o.name, size: o.size, slot: o.slot, kind: o.kind }; }) };
      else delete rec.results[job.id];
    });
  },
  saved: function (job, out) {
    var id = job.id;
    this.update(function (rec) {
      var r = rec.results[id];
      if (!r) return;
      r.outputs = r.outputs.filter(function (o) { return o.slot !== out.slot; });
      if (!r.outputs.length) delete rec.results[id];
    }, out.session);
  },
  forget: function (jobId, session) {
    this.update(function (rec) { delete rec.results[jobId]; }, session);
  },
  // a record's results still in storage (records from before 1.3.4 have only those)
  kept: function (rec) {
    var out = {};
    Object.keys(rec.results || {}).forEach(function (id) {
      var r = rec.results[id], o = r.outputs.filter(function (x) { return (x.kind || 'opfs') === 'opfs'; });
      if (o.length) out[id] = { title: r.title, outputs: o };
    });
    return out;
  },
  // an ended visit's losses: the job it was running, and the results it held in memory
  report: function (rec) {
    var self = this;
    if (rec.running) this.stopped.push(rec.running);
    Object.keys(rec.results || {}).forEach(function (id) {
      var r = rec.results[id];
      r.outputs.forEach(function (o) { if (o.kind === 'blob') self.lost.push({ title: r.title, name: o.name }); });
    });
  },
  // at start, for a visit that has ended: true if it left unsaved results (its folder is then kept)
  adopt: function (session, rec) {
    if (!rec) return false;
    if (this.earlier.some(function (e) { return e.session === session; })) return true; // listed already
    this.report(rec);
    var res = this.kept(rec), ids = Object.keys(res);
    for (var i = 0; i < ids.length; i++) {
      var r = res[ids[i]];
      this.earlier.push({ session: session, jobId: ids[i], title: r.title, outputs: r.outputs.map(function (o) { return { name: o.name, size: o.size, slot: o.slot, kind: 'opfs', session: session }; }) });
    }
    return ids.length > 0;
  },
  // records of other visits: keep those still open, and ended ones' results still in storage; report
  // what ended visits without a folder lost (they kept everything in memory, or ran no job to the end)
  settle: function (records, names, held) {
    var keep = {}, self = this;
    Object.keys(records).forEach(function (k) {
      if (k === Store.session) return;
      // open: holds its Web Lock; where the browser has none, wrote its record in the last few minutes
      var rec = records[k], open = held ? held.has('chdman-web-' + k) : !!rec.alive && Date.now() - rec.alive < 5 * 60000;
      if (open) { keep[k] = rec; return; }
      if (names.indexOf(k) >= 0) {
        var res = self.kept(rec);
        if (Object.keys(res).length) keep[k] = { results: res };
        return;
      }
      self.report(rec);
    });
    // records written meanwhile, while old folders were deleted: this visit's, and those of other open
    // visits (or visits opened since), which keep their newest state
    var all = this.read();
    Object.keys(all).forEach(function (k) {
      var open = held ? held.has('chdman-web-' + k) : !!all[k].alive && Date.now() - all[k].alive < 5 * 60000;
      if (k === Store.session || open || !(k in records)) keep[k] = all[k];
    });
    this.write(keep);
  }
};

// without Web Locks, a visit with a record keeps it fresh, so other visits leave it alone (settle)
if (!(navigator.locks && navigator.locks.query)) {
  setInterval(function () { if (Recovery.read()[Store.session]) Recovery.update(function () {}); }, 60000);
}

/* ============================================================
   disc descriptors (.cue / .gdi / .toc)
   ============================================================ */
// what to do about a descriptor without tracks: the image can come on its own
var NO_TRACKS_NEXT = ' Remove this card and add the image (.bin or .img) by itself: Discpress reads a data disc\u2019s image without a cue sheet, as a single track.';
// a descriptor line's words as chdman 0.289 reads them (cdrom_file::tokenize): double and single
// quotes each group a word and can start or end anywhere in it, and aren't part of it.
// Each word: {text, start, end} (its span in the line, quotes included)
function chdWords(line) {
  var out = [], i = 0, n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    var start = i, text = '', dq = false, sq = false;
    for (; i < n; i++) {
      var c = line[i];
      if (!sq && c === '"') dq = !dq;
      else if (!dq && c === "'") sq = !sq;
      else if (!sq && !dq && /\s/.test(c)) break;
      else text += c;
    }
    out.push({ text: text, start: start, end: i });
  }
  return out;
}
function tokenize(line) { return chdWords(line).map(function (w) { return w.text; }); }
// the file a cue FILE line or a TOC FILE/DATAFILE/AUDIOFILE line names: its word, or null
function refWord(kind, line) {
  var w = chdWords(line), k = w[0] && w[0].text.toUpperCase();
  if (w.length < 2) return null;
  if (kind === 'cue' ? k === 'FILE' : kind === 'toc' && /^(FILE|DATAFILE|AUDIOFILE)$/.test(k)) return w[1];
  return null;
}
function parseRefs(kind, text) {
  var refs = [], lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (kind === 'cue' || kind === 'toc') {
    lines.forEach(function (ln) {
      var w = refWord(kind, ln);
      if (w) refs.push(w.text);
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
    if (kind === 'cue' || kind === 'toc') {
      var w = refWord(kind, ln);
      return w && map[w.text] ? ln.slice(0, w.start) + '"' + map[w.text] + '"' + ln.slice(w.end) : ln;
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
  if (!n) return fail('This .ccd file lists no tracks (CloneCD 3 and later list them as [TRACK n]).' + NO_TRACKS_NEXT);
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
    if (!tracks) problem = 'This CUE file lists no tracks.' + NO_TRACKS_NEXT;
  } else if (kind === 'toc') {
    // the engine reads cdrdao's TOC grammar (a missing length is the rest of the file); a TOC without
    // tracks is still refused, as chdman 0.289 never finished on one
    lines.forEach(function (ln) { if (tokenize(ln)[0] === 'TRACK') tracks++; });
    if (!tracks) problem = 'This TOC file lists no tracks.' + NO_TRACKS_NEXT;
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
// a PS1 EBOOT.PBP (popstation's format): {discs: [{at, sectors, tracks, cue(binName)}], title}, or {problem}
// if it can't be converted, or null if it isn't a PBP. DATA.PSAR holds one disc (PSISOIMG0000) or a
// table of up to five (PSTITLEIMG000000, at +0x200); each disc's TOC (at +0x800, 10-byte entries:
// type, point, pregap and INDEX 01 times in BCD) lists its tracks: A0 the first, A1 the last, A2 the
// lead-out, then one per track. The image on file starts at track 1's INDEX 01.
async function sniffPbp(file) {
  var rd = async function (at, n) { return new Uint8Array(await file.slice(at, at + n).arrayBuffer()); };
  var h;
  try { h = await rd(0, 0x28); } catch (e) { return { problem: 'This file could not be read.' }; }
  if (h.length < 0x28 || h[0] !== 0 || h[1] !== 0x50 || h[2] !== 0x42 || h[3] !== 0x50) return null;
  var psar = le32(h, 0x24), m = await rd(psar, 16), magic = String.fromCharCode.apply(null, m), at = [];
  if (magic === 'PSTITLEIMG000000') {
    var t = await rd(psar + 0x200, 20);
    for (var i = 0; i < 5; i++) {
      var o = le32(t, i * 4);
      if (o === 0x44475000) return { problem: 'This PBP file is encrypted (a PlayStation Store download), so it can\u2019t be read.' };
      if (o) at.push(psar + o);
    }
  } else if (magic.slice(0, 12) === 'PSISOIMG0000') at.push(psar);
  else if (le32(m, 0) === 0x44475000) return { problem: 'This PBP file is encrypted (a PlayStation Store download), so it can\u2019t be read.' };
  else return { problem: 'This PBP file holds a PSP program, not a PlayStation disc. PSP games convert from their .iso or .cso.' };
  var bcd = function (v) { return (v >> 4) * 10 + (v & 15); }, fr = function (b, o) { return (bcd(b[o]) * 60 + bcd(b[o + 1])) * 75 + bcd(b[o + 2]); };
  var discs = [];
  for (var d = 0; d < at.length; d++) {
    var hd = await rd(at[d], 0xC00);
    if (String.fromCharCode.apply(null, hd.subarray(0, 12)) !== 'PSISOIMG0000') return { problem: 'Disc ' + (d + 1) + ' of this PBP file is damaged.' };
    if (le32(hd, 0x400) === 0x44475000) return { problem: 'This PBP file is encrypted (a PlayStation Store download), so it can\u2019t be read.' };
    var toc = hd.subarray(0x800, 0x800 + 1020), e = function (k) { return toc.subarray(k * 10, k * 10 + 10); };
    if (e(0)[2] !== 0xA0 || e(1)[2] !== 0xA1 || e(2)[2] !== 0xA2) return { problem: 'Disc ' + (d + 1) + ' of this PBP file has no track list that can be read.' };
    var last = bcd(e(1)[7]), lead = fr(e(2), 7), tracks = [];
    for (var k = 1; k <= last && k <= 99; k++) {
      var te = e(k + 2);
      tracks.push({ no: k, audio: !(te[0] & 0x40), pregap: fr(te, 3), start: fr(te, 7) });
    }
    var base0 = tracks.length ? tracks[0].start : 0, sectors = lead - base0, ok = tracks.length && !tracks[0].audio && sectors > 0;
    for (var q = 1; ok && q < tracks.length; q++) ok = tracks[q].start > tracks[q - 1].start && tracks[q].pregap >= tracks[q - 1].start && tracks[q].start - base0 < sectors;
    if (!ok) return { problem: 'Disc ' + (d + 1) + ' of this PBP file has a track list Discpress can\u2019t read.' };
    discs.push({ at: at[d], sectors: sectors, tracks: tracks.length, list: tracks, base: base0 });
  }
  // its title, from PARAM.SFO: the file is usually named EBOOT.PBP, in a folder named after the serial
  var title = '';
  try {
    var so = le32(h, 8), se = le32(h, 12);
    if (se > so && se - so < 65536) title = (parseSfo(await rd(so, se - so)).TITLE || '').replace(/\s+/g, ' ').trim();
  } catch (e2) { /* no title then */ }
  discs.forEach(function (dd) {
    dd.cue = function (bin) {
      var out = 'FILE "' + bin + '" BINARY\n';
      dd.list.forEach(function (t) {
        out += '  TRACK ' + ('0' + t.no).slice(-2) + (t.audio ? ' AUDIO' : ' MODE2/2352') + '\n';
        if (t.no > 1 && t.pregap < t.start) out += '    INDEX 00 ' + cueMsf(t.pregap - dd.base) + '\n';
        out += '    INDEX 01 ' + cueMsf(t.start - dd.base) + '\n';
      });
      return out;
    };
  });
  return { discs: discs, title: title };
}
function cueMsf(n) { var p = function (v) { return ('0' + v).slice(-2); }; return p(Math.floor(n / 4500)) + ':' + p(Math.floor(n / 75) % 60) + ':' + p(n % 75); }
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
  // the speed test measures the device: identification (its checksums) waits until it's done
  if (Tuning.running && identQueue.length) {
    identBusy = true;
    try { await Tuning.running; } catch (e) { /* measured or not, go on */ }
    identBusy = false;
    return pumpIdentify();
  }
  var it = identQueue.shift();
  if (!it) return;
  identBusy = true;
  // whatever happens to this job, the queue moves on
  try {
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
          job.ident = keepPick(job, provisional);
          job.identState = 'checking';
          applyIdent(job);
          scanSub(job);
          job.identKnownResolve();
          if (job.ui) refreshJob(job, job.state !== 'running' && job.state !== 'queued');
        });
      } catch (e) {
        job.ident = { error: e.message, readFail: /I\/O read|NotReadable/i.test(e.message || '') };
      }
      keepPick(job, job.ident);
      job.identState = 'done';
      applyIdent(job);
      scanSub(job);
      if (job.subScan) await job.subScan;
      await datCheck(job);
      // the checksum finished after the conversion started: name the results after the confirmed release
      if (job.state === 'done') renameOutputs(job);
      job.identKnownResolve();
      if (job.ui) refreshJob(job, job.state !== 'running' && job.state !== 'queued');
    } else if (job.identKnownResolve) {
      job.identKnownResolve(); // removed before its turn: a start waiting on it must not wait forever
    }
  } finally {
    it.resolve();
    identBusy = false;
    pumpIdentify();
  }
}
// a version picked under "Which version?" while the checksum ran stays picked, unless the checksum
// proved another release
function keepPick(job, id) {
  var alt = id && id.entry && id.entry.alternatives;
  if (job.versionPicked && alt && alt.indexOf(job.versionPicked) >= 0) id.name = job.versionPicked;
  return id;
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
    var bySystem = true, pf = profile(id.sys);
    if (id.sys === 'ps2') {
      var cdGame = id.entry ? id.entry.ext === 'bin' : (job.isoSize || job.files[0].file.size) < 800 * 1048576;
      job.ps2dvd = !cdGame;
      // AetherSX2 and NetherSX2 (Android) read CD CHDs only (Settings)
      job.disc = cdGame || settings.ps2dvd === 'cd' ? 'cd' : 'dvd';
    } else if (pf.keep) bySystem = false;
    else {
      job.disc = pf.disc || 'cd';
      if (pf.hunk && !job.hunkEdited) job.opts.hunk = pf.hunk;
    }
    if (job.choices && job.choices.indexOf(job.disc) < 0) { job.disc = job.choices[0]; bySystem = false; }
    if (!(HUNKS[job.disc] || []).some(function (h) { return h[0] === job.opts.hunk; })) job.opts.hunk = '';
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
  if (job.state === 'done') { Recovery.finished(job); refreshDiscSets(); }
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
  // a compressed ISO or ECM image whose checksum step found it damaged: converting it will stop too
  var damage = id.damaged ? id.damaged + ' Converting it stops with this error.' : '';
  if (!id.sys) return id.method === 'dat' ? null : el('div', { class: 'note' + (damage ? ' warn' : '') }, damage || 'Not a game Discpress recognizes, so the CHD keeps the file\u2019s name.');
  var box = el('div', { class: 'note ident' + (id.name ? ' ok' : '') });
  var sc = sysColor(id.sys);
  var head = el('div', { class: 'ident-head' }, el('span', { class: 'sysbadge', style: sc ? '--sys:' + sc[0] + ';--sys-fg:' + sc[1] : null }, sysShort(id.sys)), el('b', null, sysName(id.sys)));
  if (id.serial) head.append(el('span', { class: 'mono small' }, id.serial));
  box.append(head);
  if (id.name) {
    // (the game's title is the card's heading)
    var how = { dat: '\u2713 Every track matches your DAT file', hash: 'Exact match in the Redump database (checksum verified)', 'serial+size': 'Matched by serial number and size', serial: 'Matched by serial number', 'serial-ambiguous': 'Matched by serial number; several versions share it', size: 'Matched by size' }[id.method] || '';
    head.append(el('span', { class: 'small ident-how' }, (id.method === 'hash' ? '✓ ' : '') + how));
    if (id.entry && id.entry.alternatives && id.entry.alternatives.length > 1) {
      // a running job keeps its name until it finishes, then its results are renamed (renameOutputs)
      var sel = el('select', { onchange: function () {
        id.name = job.versionPicked = sel.value;
        if (job.state === 'done') renameOutputs(job);
        // until chdman runs (queued, or started but still waiting), the name is still to be used
        else if (!job.run && !job.outEdited && settings.rename) job.opts.out = id.name;
        refreshJob(job, true);
      } });
      id.entry.alternatives.forEach(function (n) { sel.append(el('option', { value: n, selected: n === id.name }, n)); });
      box.append(el('label', { class: 'field', style: 'margin-top:6px' }, el('span', null, 'Which version?'), sel));
    }
    // the output's name is in Options; only when it isn't the title, offer to use the title
    if (job.state !== 'running' && job.state !== 'queued' && outBase(job) !== safeName(id.name)) {
      box.append(el('div', { class: 'row', style: 'margin-top:4px' },
        el('span', { class: 'small muted' }, 'Saved as \u201c' + outBase(job) + '\u201d.'),
        el('button', { class: 'btn sm', onclick: function () { job.opts.out = id.name; job.outEdited = false; refreshJob(job, true); } }, 'Use this name')));
    }
  } else {
    box.append(el('div', { class: 'small' }, (id.headerTitle ? 'Disc title: ' + id.headerTitle + '. ' : '') + 'Not in the Redump database, so the CHD keeps the file\u2019s name.'));
  }
  if (job.identState === 'checking') {
    var chk = el('div', { class: 'small ident-check' }, job.identStatus || 'Checking against the game database…');
    job.ui.identLine = chk;
    box.append(chk);
  }
  if (damage) box.append(el('div', { class: 'small ident-damaged', style: 'margin-top:4px;color:var(--warn)' }, damage));
  if (profile(id.sys).note) box.append(el('div', { class: 'small ident-note', style: 'margin-top:4px' }, profile(id.sys).note));
  compatNotes(job, id).forEach(function (n) { box.append(el('div', { class: 'small compat-note', style: 'margin-top:4px' }, n)); });
  return box;
}
// what a known emulator does with this particular disc's CHD (from the cue sheet or TOC it is made from)
function compatNotes(job, id) {
  var notes = [], text = job.kind === 'create' && (job.src === 'cue' || job.src === 'toc') ? job.descText || '' : '';
  if (!text || job.disc !== 'cd') return notes;
  var audio = job.src === 'cue' ? /^\s*TRACK\s+\d+\s+AUDIO\b/im.test(text) : /^\s*TRACK\s+AUDIO\b/m.test(text);
  // PCSX2's CHD reader (ChdFileReader) reads a CD's first track only
  if (id.sys === 'ps2' && audio) notes.push('PCSX2 plays only the first track of a CD CHD, so this game\u2019s music tracks won\u2019t play in it. They are kept in the CHD.');
  // a GD-ROM (Redump's cue lists its high-density area) is laid out as chdman 0.289 does; a CD-based
  // Dreamcast disc with pregaps is rejected by Flycast up to 2.7 ("Unsupported subtype or pre/postgap")
  var gd = /HIGH-DENSITY AREA/i.test(text);
  var gaps = job.src === 'cue' ? /^\s*(INDEX\s+0*0\s|PREGAP\b|POSTGAP\b)/im.test(text) : /^\s*(PREGAP|START)\b/m.test(text);
  if (id.sys === 'dc' && !gd && gaps) notes.push('Flycast 2.7 and earlier can\u2019t load CD-based Dreamcast CHDs whose tracks have pregaps, as this one\u2019s do; newer Flycast builds can. Keep the original files if you use an older one.');
  return notes;
}
function safeName(s) { return String(s || '').replace(/[\/:*?"<>|]+/g, '_').trim(); }

/* ============================================================
   job model
   ============================================================ */
var jobs = [];
var looseFiles = [];      // files not claimed by any job yet
var looseSbi = [];        // .sbi files (PS1 LibCrypt data) waiting for their game's job
var seen = new Set();     // dedupe (name+size+mtime)
// the path counts: generic track names (every GDI has track01.bin) can match in name, size and date,
// on FAT/exFAT cards especially, across the games of one folder
function fileKey(f, path) { return (path || f.name) + '|' + f.size + '|' + f.lastModified; }
var seenKeys = new WeakMap(); // file -> its key in seen
function forgetFile(f) { seen.delete(seenKeys.get(f) || fileKey(f)); }
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
  cd: [['default', 'Smallest (default)', null, 'The smallest files. Works in every emulator. (chdman\u2019s own settings: LZMA, Deflate and FLAC.)'], ['plan', 'Nearly as small, faster', null, 'About 1.7 times as fast to create, at most 0.3% bigger, same checksums. Works in every emulator. (The same codecs, but each track tries only the one that suits it: LZMA for data, FLAC for audio.)', ['--codecplan', '--libdeflate']], ['fast', 'Faster to create', 'cdzl,cdfl', 'Several times faster to create, a little bigger, same checksums. (Deflate by libdeflate, and FLAC.)', ['--libdeflate']], ['zstd', 'Faster to load (Zstd)', 'cdzs,cdfl', 'Quicker to load on weak devices. Needs a recent emulator. (Zstandard and FLAC.)'], ['mister', 'For MiSTer FPGA', 'cdzs,cdfl', 'Zstandard and FLAC in 4-sector hunks, which MiSTer\u2019s CD cores decompress fast enough for 8\u00d7 CD speed. Other emulators read it too, if they read Zstd.', ['-hs', '9792']], ['none', 'No compression', 'none', 'Full size: the data is stored as it is.']],
  other: [['default', 'Smallest (default)', null, 'The smallest files. Works in every emulator. (chdman\u2019s own settings: LZMA, Deflate, Huffman and FLAC.)'], ['plan', 'Nearly as small, faster', null, 'About 1.5 times as fast to create, just as small, same checksums. Works in every emulator. (The same codecs but FLAC, which almost never wins on data.)', ['--codecplan', '--libdeflate']], ['fast', 'Faster to create', 'zlib,huff', 'Several times faster to create, a little bigger, same checksums. (Deflate by libdeflate, and Huffman.)', ['--libdeflate']], ['zstd', 'Faster to load (Zstd)', 'zstd', 'Quicker to load on weak devices. Needs a recent emulator. (Zstandard.)'], ['none', 'No compression', 'none', 'Full size: the data is stored as it is.']],
  ld: [['default', 'Default (A/V Huffman)', null, 'chdman\u2019s own setting for LaserDisc video.'], ['none', 'No compression', 'none', 'Full size: the data is stored as it is.']]
};
var HUNKS = {
  cd: [['', 'Automatic (19,584 bytes = 8 sectors)']],
  gdrom: [['', 'Automatic (19,584 bytes = 8 sectors)']],
  dvd: [['', 'Automatic (4,096 bytes)'], ['2048', '2,048 bytes (recommended for PSP)'], ['8192', '8,192 bytes'], ['16384', '16,384 bytes'], ['32768', '32,768 bytes']],
  hd: [['', 'Automatic (4,096 bytes)'], ['8192', '8,192 bytes'], ['16384', '16,384 bytes'], ['32768', '32,768 bytes'], ['65536', '65,536 bytes']],
  raw: [['4096', '4,096 bytes'], ['2048', '2,048 bytes'], ['8192', '8,192 bytes'], ['16384', '16,384 bytes']],
  ld: [['', 'Automatic']]
};
// what the emulators of each system need (docs/chd/ecosystem-*.md). The type and hunk size are set
// from it when a game is identified (applyIdent); compression never changes by itself.
// disc/hunk: the CHD to make from an .iso; why: its reason, shown under "Create as"; noZstd: its readers that
// can't decode Zstandard (the Zstd preset warns); hint: added to the compression hint;
// note: shown with the game (emulators that won't load it)
var PROFILES = {
  psp: { disc: 'dvd', hunk: '2048', why: 'with 2,048-byte hunks, as PPSSPP recommends' },
  ps1: { noZstd: 'SwanStation (before March 2026)' },
  saturn: { noZstd: 'Kronos and Yabause' },
  segacd: { noZstd: 'BlastEm (RetroArch)' },
  pcecd: { noZstd: 'Beetle SuperGrafx' },
  '3do': { noZstd: 'Opera (RetroArch)' },
  cd32: { noZstd: 'WinUAE' },
  cdtv: { noZstd: 'WinUAE' },
  jagcd: { note: 'Jaguar CD emulators may not load this CHD: BigPEmu doesn\u2019t take CHDs, and Virtual Jaguar (RetroArch) needs session data that chdman 0.289 doesn\u2019t write. Keep the original files too.' },
  pc: { keep: true, hint: 'DOSBox Pure opens only uncompressed CHDs (No compression).' },
  gc: { keep: true, note: 'Emulators do not load GameCube/Wii games from CHD. Dolphin uses RVZ instead.' },
  wii: { keep: true, note: 'Emulators do not load GameCube/Wii games from CHD. Dolphin uses RVZ instead.' },
  xbox: { keep: true, note: 'Xbox emulators (xemu, Xenia) do not load CHDs. They use the ISO itself.' },
  ps3: { keep: true, note: 'RPCS3 does not load CHDs. It uses the ISO or the game\u2019s folder.' }
};
function profile(sys) { return PROFILES[sys] || {}; }

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
// the file a descriptor in folder `dir` names as `ref`, among candidates in order of preference: one in
// the same folder, or in the subfolder the reference names, or picked on its own (no folder); never a
// same-named file from another folder (another game's track01.bin) or one already claimed
function pickTrack(cands, dir, ref, claimed) {
  var free = cands.filter(function (e) { return !claimed.has(e); });
  var rel = ref.replace(/\\/g, '/'), sub = rel.indexOf('/') >= 0 ? dirOf(rel) : null;
  var want = sub === null ? null : dir ? dir + '/' + sub : sub;
  return free.find(function (e) { return dirOf(e.path) === dir; }) ||
    (want === null ? undefined : free.find(function (e) { return dirOf(e.path) === want; })) ||
    free.find(function (e) { return !dir || dirOf(e.path) === ''; });
}
function refMatches(e, ref) {
  var n = base(e.path).toLowerCase(), want = base(ref).toLowerCase();
  return n === want || n === want + '.ecm';
}
// the type the file shows on a job's card (bin.ecm for an ECM image of a .bin)
function fileKind(f) { return f.ecm ? (ext(f.name) ? ext(f.name) + '.' : '') + 'ecm' : ext(f.name); }

/* ---------- grouping new files into jobs ---------- */
var IGNORE = /^(txt|nfo|sub|m3u|dat|md5|sfv|sha1|jpg|jpeg|png|gif|webp|pdf|url|ini|cfg|xml|json|html|htm|db|ds_store)$/;
// disc images and archives Discpress can't read: a card says why and what to do, rather than ignoring them
var UNSUPPORTED = {
  cdi: 'DiscJuggler (.cdi) images can\u2019t become CHDs that emulators load: most hold two sessions, which a CHD made by chdman 0.289 can\u2019t place. Flycast and Redream load .cdi files as they are, so keep this one.',
  mds: 'Alcohol 120% images (.mds with .mdf) can\u2019t be read here yet. Convert them to .cue/.bin with another tool first.',
  isz: 'UltraISO compressed images (.isz) can\u2019t be read here. Convert them to .iso with UltraISO first.',
  '7z': '7-Zip archives can\u2019t be opened here. Extract the files from it first.',
  rar: 'RAR archives can\u2019t be opened here. Extract the files from it first.'
};
UNSUPPORTED.mdf = UNSUPPORTED.mds;

// adds run one after another: a second pick or drop while the first still reads its files (slow
// cloud files) would otherwise work from a list of jobs that is about to change
var addChain = Promise.resolve();
/* ============================================================
   zip archives
   A zip's files join the list as if picked one by one (their paths inside the zip, under its name).
   Stored files are read in place, as slices of the zip; deflated ones are unpacked first, into private
   storage (chdman-unzip/<visit>, like results, cleared once the visit is over), else into memory up to
   UNZIP_MEM_MAX, and their CRC-32 must be the zip's. Other methods and encrypted files are refused.
   ============================================================ */
var UNZIP_MEM_MAX = 1024 * 1048576;
var ZIP_METHODS = { 1: 'Shrink', 6: 'Implode', 9: 'Deflate64', 12: 'BZIP2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 98: 'PPMd' };
function le16(b, o) { return b[o] | (b[o + 1] << 8); }
function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function le64(b, o) { return le32(b, o) + le32(b, o + 4) * 4294967296; }
async function zipBytes(file, at, n) { return new Uint8Array(await file.slice(at, at + n).arrayBuffer()); }
// the zip's files: [{name, method, csize, usize, crc, local, time, encrypted}], or throws with the reason
async function zipDirectory(file) {
  var tailLen = Math.min(file.size, 65557), tail = await zipBytes(file, file.size - tailLen, tailLen), e = -1;
  for (var i = tail.length - 22; i >= 0; i--) if (le32(tail, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('it is not a zip archive, or it is damaged');
  var count = le16(tail, e + 10), cdSize = le32(tail, e + 12), cdAt = le32(tail, e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdAt === 0xffffffff) {
    // zip64: its locator sits just before the end record
    var loc = e - 20;
    if (loc < 0 || le32(tail, loc) !== 0x07064b50) throw new Error('its zip64 directory is missing');
    var z = await zipBytes(file, le64(tail, loc + 8), 56);
    if (le32(z, 0) !== 0x06064b50) throw new Error('its zip64 directory is damaged');
    count = le64(z, 32); cdSize = le64(z, 40); cdAt = le64(z, 48);
  }
  if (cdSize > 64 << 20 || cdAt + cdSize > file.size) throw new Error('its directory is damaged');
  var cd = await zipBytes(file, cdAt, cdSize), out = [], p = 0;
  for (var k = 0; k < count; k++) {
    if (p + 46 > cd.length || le32(cd, p) !== 0x02014b50) throw new Error('its directory is damaged');
    var flags = le16(cd, p + 8), nl = le16(cd, p + 28), xl = le16(cd, p + 30), cl = le16(cd, p + 32);
    var ent = { method: le16(cd, p + 10), crc: le32(cd, p + 16), csize: le32(cd, p + 20), usize: le32(cd, p + 24), local: le32(cd, p + 42), encrypted: !!(flags & 1) };
    var raw = cd.subarray(p + 46, p + 46 + nl), name = null;
    // extras: zip64 sizes and offset (only the fields that overflowed, in this order); Info-ZIP's UTF-8 name
    for (var x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
      var id = le16(cd, x), len = le16(cd, x + 2), d = x + 4;
      if (id === 1) {
        if (ent.usize === 0xffffffff) { ent.usize = le64(cd, d); d += 8; }
        if (ent.csize === 0xffffffff) { ent.csize = le64(cd, d); d += 8; }
        if (ent.local === 0xffffffff) { ent.local = le64(cd, d); d += 8; }
      } else if (id === 0x7075 && len > 5) {
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(cd.subarray(x + 9, x + 4 + len)); } catch (err) { /* keep the other */ }
      }
      x += 4 + len;
    }
    if (name === null) {
      try { name = new TextDecoder('utf-8', { fatal: !(flags & 0x800) }).decode(raw); }
      catch (err) { name = new TextDecoder('windows-1252').decode(raw); }
    }
    var tm = le16(cd, p + 12), dt = le16(cd, p + 14);
    ent.time = new Date(1980 + (dt >> 9), ((dt >> 5) & 15) - 1, dt & 31, tm >> 11, (tm >> 5) & 63, (tm & 31) * 2).getTime();
    ent.name = name.replace(/\\/g, '/');
    if (!/\/$/.test(ent.name)) out.push(ent);
    p += 46 + nl + xl + cl;
  }
  return out;
}
var crc32Table = null;
function crc32Update(crc, b) {
  if (!crc32Table) {
    crc32Table = new Int32Array(2048);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc32Table[n] = c; }
    for (n = 0; n < 256; n++) { c = crc32Table[n]; for (k = 1; k < 8; k++) { c = crc32Table[c & 255] ^ (c >>> 8); crc32Table[k * 256 + n] = c; } }
  }
  var T = crc32Table, i = 0, len = b.length;
  for (; i + 8 <= len; i += 8) {
    var a = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) ^ crc;
    crc = T[1792 + (a & 255)] ^ T[1536 + ((a >>> 8) & 255)] ^ T[1280 + ((a >>> 16) & 255)] ^ T[1024 + (a >>> 24)] ^
      T[768 + b[i + 4]] ^ T[512 + b[i + 5]] ^ T[256 + b[i + 6]] ^ T[b[i + 7]];
  }
  for (; i < len; i++) crc = T[(crc ^ b[i]) & 255] ^ (crc >>> 8);
  return crc;
}
var Unzip = {
  seq: 0,
  root: async function () { return (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-unzip', { create: true }); },
  // the files unpacked in visits that are over
  cleanup: async function () {
    var held = await heldLocks(), root, names = [];
    try { root = await this.root(); for await (var n of root.keys()) names.push(n); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      if (names[i] === Store.session) continue;
      var t = parseInt(names[i].slice(1, 9), 36);
      if (held ? held.has('chdman-web-' + names[i]) : t && Date.now() - t < 6 * 3600e3) continue;
      try { await root.removeEntry(names[i], { recursive: true }); } catch (e) { /* in use */ }
    }
  },
  // this visit's unpacked files that no job uses any more
  prune: async function () {
    var used = new Set();
    jobs.forEach(function (j) {
      j.files.forEach(function (f) { if (f.file.unzipDir) used.add(f.file.unzipDir); });
      if (j.descFile && j.descFile.unzipDir) used.add(j.descFile.unzipDir);
      if (j.subFile && j.subFile.unzipDir) used.add(j.subFile.unzipDir);
      if (j.sbi && j.sbi.file.unzipDir) used.add(j.sbi.file.unzipDir);
    });
    looseFiles.concat(looseSbi).forEach(function (e) { if (e.file.unzipDir) used.add(e.file.unzipDir); });
    try {
      var dir = await (await this.root()).getDirectoryHandle(Store.session), names = [];
      for await (var n of dir.keys()) names.push(n);
      for (var i = 0; i < names.length; i++) if (!used.has(names[i])) { try { await dir.removeEntry(names[i], { recursive: true }); } catch (e) { /* in use */ } }
    } catch (e) { /* nothing unpacked */ }
  },
  // a deflated file unpacked: a File, its CRC-32 checked against the zip's
  unpack: async function (zip, ent, at, onProgress) {
    var stream = zip.slice(at, at + ent.csize).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    var reader = stream.getReader(), crc = -1, done = 0, parts = [], writer = null, fh = null, id = 'u' + (++this.seq);
    var base_ = ent.name.replace(/^.*\//, '');
    if (Store.available) {
      try {
        var dir = await (await (await this.root()).getDirectoryHandle(Store.session, { create: true })).getDirectoryHandle(id, { create: true });
        fh = await dir.getFileHandle(base_, { create: true });
        if (typeof fh.createWritable !== 'function') throw new Error('no writable streams');
        writer = await fh.createWritable();
      } catch (e) { writer = null; }
    }
    if (!writer && ent.usize > UNZIP_MEM_MAX) throw new Error(base_ + ' is too large (' + fmtBytes(ent.usize) + ') to unpack in this browser. Unzip it first, or use a browser with private storage (Discpress online).');
    try {
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        crc = crc32Update(crc, r.value);
        done += r.value.length;
        if (writer) await writer.write(r.value); else parts.push(r.value);
        onProgress(done);
      }
      if (writer) await writer.close();
    } catch (e) {
      if (writer) try { await writer.abort(); } catch (x) { /* ignore */ }
      throw new Error(base_ + ' could not be unpacked (' + (e && e.name === 'QuotaExceededError' ? 'the browser\u2019s storage is full' : e && e.message || e) + ')');
    }
    if (((crc ^ -1) >>> 0) !== ent.crc || done !== ent.usize) throw new Error(base_ + ' is damaged in the zip: its checksum doesn\u2019t match');
    var f = writer ? await fh.getFile() : new File(parts, base_, { lastModified: ent.time });
    if (writer) f.unzipDir = id;
    return f;
  }
};
// a picked .zip's files as picked files ({file, path}), and the reasons some couldn't be read
async function zipEntries(e) {
  var zip = e.file, out = [], problems = [], skipped = [];
  var list;
  try { list = await zipDirectory(zip); }
  catch (err) { return { entries: [], problems: ['This zip can\u2019t be read: ' + err.message + '.'], skipped: [] }; }
  var total = 0, doneBefore = 0;
  list.forEach(function (ent) { if (ent.method === 8) total += ent.usize; });
  for (var i = 0; i < list.length; i++) {
    var ent = list[i], nm = ent.name.replace(/^.*\//, ''), x = ext(nm), path = e.path + '/' + ent.name;
    // what the page would ignore anyway isn't unpacked
    if (/^\._/.test(nm) || /(^|\/)__MACOSX\//.test(ent.name) || (IGNORE.test(x) && !/^(dat|xml)$/.test(x))) { skipped.push(nm); continue; }
    if (ent.encrypted) { problems.push(nm + ' is encrypted.'); continue; }
    if (ent.method !== 0 && ent.method !== 8) { problems.push(nm + ' uses ' + (ZIP_METHODS[ent.method] || 'method ' + ent.method) + ' compression, which can\u2019t be read here. Re-zip it with ordinary (Deflate) compression, or unzip it first.'); continue; }
    var head;
    try { head = await zipBytes(zip, ent.local, 30); } catch (err) { problems.push(nm + ' can\u2019t be read.'); continue; }
    if (le32(head, 0) !== 0x04034b50) { problems.push(nm + ' is damaged in the zip.'); continue; }
    var at = ent.local + 30 + le16(head, 26) + le16(head, 28), file;
    if (ent.method === 0) {
      if (at + ent.usize > zip.size) { problems.push(nm + ' is cut short in the zip.'); continue; }
      file = new File([zip.slice(at, at + ent.usize)], nm, { lastModified: ent.time });
    } else {
      if (typeof DecompressionStream !== 'function') { problems.push(nm + ' is compressed, and this browser can\u2019t unpack it. Unzip it first.'); continue; }
      try {
        file = await Unzip.unpack(zip, ent, at, function (n) {
          setChip('chipUnzip', 'Unpacking ' + base(e.path) + ', ' + (total ? Math.floor(100 * (doneBefore + n) / total) : 100) + '%', '');
        });
      } catch (err) { problems.push(err.message); continue; }
      finally { doneBefore += ent.usize; }
    }
    out.push({ file: file, path: path });
  }
  var chip = document.getElementById('chipUnzip');
  if (chip) chip.remove();
  return { entries: out, problems: problems, skipped: skipped };
}

function addEntries(entries) {
  var p = addChain.then(function () { return addEntriesNow(entries); });
  addChain = p.catch(function () {});
  return p;
}
async function addEntriesNow(entries) {
  // zips: their files join the list, unpacked if they need it (once per zip)
  var zipCards = [], zipSkipped = [];
  if (entries.some(function (e) { return ext(e.path) === 'zip'; })) {
    var flat = [];
    for (var zi = 0; zi < entries.length; zi++) {
      var ze = entries[zi];
      if (ext(ze.path) !== 'zip') { flat.push(ze); continue; }
      var zkey = fileKey(ze.file, ze.path);
      if (seen.has(zkey)) continue;
      seen.add(zkey);
      seenKeys.set(ze.file, zkey);
      var zr = await zipEntries(ze);
      zr.entries.forEach(function (x) { x.file.fromZip = ze.file; });
      flat = flat.concat(zr.entries);
      zipSkipped = zipSkipped.concat(zr.skipped);
      if (zr.problems.length) {
        // a card for what couldn't be read; the rest goes on
        zipCards.push(newJob({ kind: 'create', src: 'zip', title: stem(ze.path), files: [{ file: ze.file, name: base(ze.path) }], disc: 'cd', state: 'error', invalid: true,
          errorText: (zr.entries.length ? plural(zr.problems.length, 'file') + ' in this zip can\u2019t be converted. ' : '') + zr.problems.join(' ') }));
      }
    }
    entries = flat;
    if (!entries.length && !zipCards.length) { toast('Nothing to convert in ' + plural(zipSkipped.length, 'file') + ' of the zip.', 'err'); return; }
  }
  // macOS keeps metadata in "._name" companion files (on FAT and exFAT drives, and in zips' __MACOSX
  // folders): they share the game files' extensions but aren't games
  var junk = zipSkipped.slice();
  entries = entries.filter(function (e) {
    if (/^\._/.test(base(e.path)) || /(^|\/)__MACOSX\//.test(e.path)) { junk.push(base(e.path)); return false; }
    return true;
  });
  var fresh = [];
  entries.forEach(function (e) {
    var key = fileKey(e.file, e.path);
    if (seen.has(key)) return;
    seen.add(key);
    seenKeys.set(e.file, key);
    fresh.push(e);
  });
  // DAT files (Redump, No-Intro): kept, and every job checked against them again
  var datAdded = [];
  var datCands = fresh.filter(function (e) { return /^(dat|xml)$/.test(ext(e.path)); });
  if (datCands.length) {
    fresh = fresh.filter(function (e) { return datCands.indexOf(e) < 0; });
    for (var di = 0; di < datCands.length; di++) {
      var dm = await loadDat(datCands[di].file);
      if (dm) datAdded.push(dm); else junk.push(base(datCands[di].path));
    }
    if (datAdded.length) {
      toast('Added ' + datAdded.map(function (d) { return '\u201c' + d.name + '\u201d (' + d.games.toLocaleString('en-US') + ' games)'; }).join(', ') + '. Discs are checked against it now.');
      renderDatList();
      datRecheck();
      if (!fresh.length && !zipCards.length) return;
    }
  }
  if (!fresh.length && !zipCards.length) { toast(entries.length ? 'Those files are already in the list.' : 'Nothing to convert in ' + plural(junk.length, 'file') + '. Add .cue/.bin, .gdi, .iso or .chd files.', entries.length ? null : 'err'); return; }

  var created = zipCards.slice(), ignored = junk.slice();
  var claimed = new Set();

  // 1) new files may complete jobs that were waiting for missing tracks
  jobs.forEach(function (job) {
    if (!job.missing.length || job.state !== 'blocked') return;
    job.missing = job.missing.filter(function (ref) {
      var want = base(ref).toLowerCase();
      var cands = fresh.filter(function (e) { return refMatches(e, ref); });
      cands.sort(function (a, b) { return (base(a.path).toLowerCase() === want ? 0 : 1) - (base(b.path).toLowerCase() === want ? 0 : 1); });
      var hit = pickTrack(cands, job.descDir || '', ref, claimed);
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
    } else if (x === 'pbp') {
      // a PS1 EBOOT.PBP: a job per disc, chdman given the disc's image and a cue sheet from its TOC
      var pb = await sniffPbp(file);
      if (!pb || pb.problem) {
        job2 = newJob({ kind: 'create', src: 'pbp', title: t, files: [{ file: file, name: name }], disc: 'cd', invalid: true, state: 'error', errorText: pb ? pb.problem : 'This is not a PBP file Discpress can read.' });
      } else {
        var pt = /^eboot$/i.test(t) && safeName(pb.title) || t;
        for (var pd = 0; pd < pb.discs.length; pd++) {
          var disc_ = pb.discs[pd], dt = pt + (pb.discs.length > 1 ? ' (Disc ' + (pd + 1) + ')' : ''), bin = dt + '.bin';
          var pj = newJob({ kind: 'create', src: 'pbp', title: dt, files: [{ file: file, name: bin, pbp: { at: disc_.at, sectors: disc_.sectors } }], disc: 'cd', pbpCue: disc_.cue(bin), pbpTracks: disc_.tracks });
          if (pd < pb.discs.length - 1) { pj.files[0].path = e.path; created.push(pj); } else job2 = pj;
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
    } else if (x === 'sbi') {
      looseSbi.push(e); // paired with its game below
      continue;
    } else if (UNSUPPORTED[x]) {
      // an Alcohol 120% image is one card, for its .mds (its .mdf beside it says the same)
      if (x === 'mdf' && fresh.some(function (o) { return ext(o.path) === 'mds' && stem(o.path).toLowerCase() === t.toLowerCase(); })) continue;
      job2 = newJob({ kind: 'create', src: x, title: t, files: [{ file: file, name: name }], disc: 'cd', invalid: true, state: 'error', errorText: UNSUPPORTED[x] });
    } else if (IGNORE.test(x) || name.charAt(0) === '.') {
      ignored.push(name);
      continue;
    } else {
      looseFiles.push(e);
      ignored.push(name);
      continue;
    }
    // where the file came from (its folder): a cue sheet taking it over later needs it (pickTrack)
    if (job2.files.length === 1 && !job2.files[0].path) job2.files[0].path = e.path;
    created.push(job2);
  }

  // a PS1 disc's LibCrypt data (.sbi) goes next to its CHD, named after it: emulators look for
  // it by name (DuckStation, Beetle PSX, SwanStation, PCSX ReARMed, MiSTer)
  looseSbi = looseSbi.filter(function (e) {
    var job = sbiJob(e, created.concat(jobs));
    if (job) { job.sbi = { file: e.file, name: base(e.path) }; if (job.el && created.indexOf(job) < 0) refreshJob(job, true); return false; }
    if (fresh.indexOf(e) >= 0) ignored.push(base(e.path));
    return true;
  });
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
    var nChd = created.filter(function (j) { return j.kind === 'chd'; }).length, nDisc = created.length - nChd;
    var m = 'Added ' + [nDisc ? plural(nDisc, 'disc') : '', nChd ? plural(nChd, 'CHD') : ''].filter(Boolean).join(' and ');
    if (ignored.length) m += ' · ignored ' + plural(ignored.length, 'file') + ' (' + ignored.slice(0, 3).join(', ') + (ignored.length > 3 ? '…' : '') + ')';
    toast(m);
    var first = created[0].el;
    if (first && first.scrollIntoView) setTimeout(function () { first.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 60);
  } else if (ignored.length) {
    toast('Nothing to convert in ' + plural(ignored.length, 'file') + '. Add .cue/.bin, .gdi, .iso or .chd files.', 'err');
  }
}

// the job an .sbi file belongs to: a CD job not started yet whose cue sheet, image or title has its
// name ("Game (Europe).sbi" beside "Game (Europe).cue"), in the same folder if one is
function sbiJob(e, list) {
  var want = stem(e.path).toLowerCase(), dir = dirOf(e.path);
  var cands = list.filter(function (j) {
    if (j.kind !== 'create' || (j.sbi && !j.sbi.fromSub) || j.disc === 'dvd' || (j.state !== 'ready' && j.state !== 'blocked' && j.state !== 'probing')) return false;
    var names = [j.title, j.descName ? stem(j.descName) : ''].concat(j.files.map(function (f) { return stem(f.name); }));
    return names.some(function (n) { return n && n.toLowerCase() === want; });
  });
  var same = cands.filter(function (j) {
    return (j.descDir != null ? j.descDir : dirOf((j.files[0] && j.files[0].path) || '')) === dir;
  });
  return (same.length ? same : cands)[0] || null;
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
      // a PS1 disc's LibCrypt sectors are in it: once the console is known, they become an .sbi (sbiFromSub)
      job.subFile = sub.file;
      if (!fix.problem) job.warnings.push('The .sub file (subchannel data) isn\u2019t kept in the CHD: CHDs store the disc\u2019s data and audio.');
    }
  }
  if (fix.problem) {
    job.invalid = true;
    job.state = 'error';
    // the reason, then what to do about it
    var next = fix.problem.indexOf(NO_TRACKS_NEXT) > 0 ? NO_TRACKS_NEXT : '', why = fix.problem.replace(NO_TRACKS_NEXT, '');
    job.errorText = (dec ? why + ' chdman can\u2019t convert it as it is.' : why) + next;
  }
  var dir = job.descDir = dirOf(d.path);
  refs.forEach(function (ref) {
    var want = base(ref).toLowerCase();
    var cands = pool.filter(function (e) { return e !== d && base(e.path).toLowerCase() === want; });
    // or an ECM image of it (Game.bin.ecm for Game.bin)
    if (!cands.length) cands = pool.filter(function (e) { return e !== d && base(e.path).toLowerCase() === want + '.ecm'; });
    // also steal files from not-yet-started jobs of a lone image (a .bin with a generated cue, an .iso)
    if (!cands.length) {
      jobs.forEach(function (other) {
        if ((other.lone || (other.src === 'iso' && other.files.length === 1)) && other.state !== 'running' && other.state !== 'queued' && other.state !== 'done' && other.files[0] && other.files[0].name.toLowerCase() === want) {
          cands.push({ file: other.files[0].file, path: other.files[0].path || other.files[0].name, fromJob: other });
        }
      });
    }
    var hit = pickTrack(cands, dir, ref, claimed);
    if (!hit) { job.missing.push(ref); return; }
    if (hit.fromJob) removeJob(hit.fromJob, true, true);
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
      if (!job.info.parent) scheduleIdentify(job); // a child CHD: once its parent is here (linkParents)
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
    // identified through its parent, which holds the data it shares
    if (job.parentJob && !job.identPromise && job.state !== 'error') scheduleIdentify(job);
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
    } else if (job.src === 'pbp') {
      // a PS1 PBP's disc: the job worker unpacks its image as chdman reads it, with a cue sheet from its TOC
      inName = stem(job.files[0].name) + '.cue';
      inputs.push({ name: inName, blob: new Blob([job.pbpCue], { type: 'text/plain' }) });
      inputs.push({ name: job.files[0].name, blob: job.files[0].file, pbp: job.files[0].pbp });
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
    // a hunk size picked for another disc type (identification can turn an ISO's DVD into a CD) doesn't carry over
    var hs = (HUNKS[disc] || []).some(function (h) { return h[0] === o.hunk; }) ? o.hunk : '';
    if (disc === 'raw') hs = hs || '4096';
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
  // data-title: the files' name, whatever the heading shows (the game once it's identified)
  var card = el('article', { class: 'job', 'data-state': job.state, 'data-title': job.title });
  job.el = card;
  job.ui = {};
  var badge = el('div', { class: 'badge' });
  var h3 = el('h3');
  var sub = el('p', { class: 'sub' });
  var rm = el('button', { class: 'icon-btn', 'aria-label': 'Remove ' + job.title, title: 'Remove', onclick: function () { removeJob(job); } }, icon('i-x'));
  card.append(el('div', { class: 'job-head' }, badge, el('div', { class: 'job-title' }, h3, sub), rm));
  var body = el('div', { class: 'job-body' });
  var controls = el('div', { class: 'controls', style: 'display:grid;gap:12px' });
  var notes = el('div', { style: 'display:grid;gap:8px' });
  var prog = el('div', { class: 'prog', hidden: true }, el('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('i')), el('div', { class: 'ptext' }));
  var result = el('div', { class: 'result', hidden: true });
  var logPre = el('pre', { class: 'logtext' });
  var cmd = el('code', { class: 'cmd' });
  var log = el('details', { class: 'log' }, el('summary', null, 'Details'), el('div', { style: 'margin-top:8px' }, cmd, logPre));
  // what the disc is (identification, missing files, errors) before how to convert it
  body.append(notes, controls, prog, result, log);
  var foot = el('div', { class: 'job-foot' });
  card.append(body, foot);
  job.ui = { badge: badge, h3: h3, sub: sub, rm: rm, controls: controls, notes: notes, prog: prog, bar: prog.querySelector('i'), ptext: prog.querySelector('.ptext'), result: result, logPre: logPre, cmd: cmd, foot: foot, log: log };
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
  // the card becomes the game once it's identified: its title leads, the files' name goes below
  var game = job.ident && job.ident.name;
  ui.h3.textContent = game || job.title;
  ui.h3.className = game ? 'ident-name' : '';
  ui.sub.textContent = (game && game !== job.title ? job.title + ' \u00b7 ' : '') + subtitle(job);
  ui.rm.setAttribute('aria-label', 'Remove ' + (game || job.title));
  if (job.state !== ui.said && (job.state === 'done' || job.state === 'error')) {
    var outBytes = (job.outputs || []).reduce(function (a, o) { return a + (o.size || 0); }, 0);
    announce((game || job.title) + (job.state === 'done' ? ': finished' + (outBytes ? ', ' + fmtBytes(outBytes) : '') + '.' : ': failed.'));
  }
  ui.said = job.state;
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
  if (job.src === 'pbp' && job.files[0].pbp) return 'PS1 PBP file · ' + plural(job.pbpTracks, 'track') + ' · ' + fmtBytes(job.files[0].pbp.sectors * 2352) + ' unpacked';
  // a descriptor that can't be converted: only the file itself, not the tracks it doesn't list
  if (job.invalid) {
    var f0 = job.descFile || (job.files[0] && job.files[0].file);
    return f0 ? '.' + ext(f0.name) + ' file · ' + fmtBytes(f0.size) : fmtBytes(n);
  }
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
  return el('label', { class: 'field' + (opts.wide ? ' wide' : '') }, el('span', null, label), i, opts.hint ? el('span', { class: 'hint' }, opts.hint) : null);
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
      var sys = job.ident.sys, why;
      if (sys === 'ps2' && job.ps2dvd && job.disc === 'cd' && settings.ps2dvd === 'cd') why = 'This ' + sysName('ps2') + ' game is on a DVD. It becomes a CD CHD, for AetherSX2 and NetherSX2 (Settings).';
      else if (sys === 'ps2') why = 'This ' + sysName('ps2') + ' game is on a ' + KIND[job.ps2dvd ? 'dvd' : 'cd'].label + ', so it becomes a ' + KIND[job.disc].label + ' CHD.';
      else why = sysName(sys) + ' games become ' + KIND[job.disc].label + ' CHDs' + (profile(sys).why && job.disc === profile(sys).disc ? ' ' + profile(sys).why : '') + '.';
      fields.append(selectField('Create as', discChoices, job.disc, pickDisc, why + ' Change this only if you know you need the other type.', busy));
    }
    var cur = presets.find(function (p) { return p[0] === o.preset; }) || presets[0];
    var pfc = profile(job.ident && job.ident.sys), chint = cur[3];
    if (cur[0] === 'zstd' && pfc.noZstd) chint += ' ' + pfc.noZstd + ' can\u2019t read Zstd CHDs of ' + sysName(job.ident.sys) + ' games.';
    if (pfc.hint && cur[0] !== 'none') chint += ' ' + pfc.hint;
    var zwarn = cur[0] === 'zstd' && pfc.noZstd;
    var cfield = selectField('Compression', presets.map(function (p) { return [p[0], p[1]]; }), o.preset, function (v) { o.preset = v; refresh(); }, chint, busy);
    if (zwarn) cfield.lastChild.style.color = 'var(--warn)';
    fields.append(cfield);
    var hunks = HUNKS[disc] || [['', 'Automatic']];
    if (hunks.length > 1) fields.append(selectField('Hunk size', hunks, o.hunk || hunks[0][0], function (v) { o.hunk = v; job.hunkEdited = true; soft(); }, disc === 'dvd' ? 'Use 2,048 for PSP games.' : null, busy));
    if (disc === 'raw') fields.append(textField('Unit size (bytes)', o.unit, function (v) { o.unit = v.replace(/[^0-9]/g, ''); soft(); }, { inputmode: 'numeric', disabled: busy }));
    fields.append(textField('Output name', o.out, function (v) { o.out = v; job.outEdited = true; soft(); }, { hint: 'Saved as ' + outBase(job) + '.chd', disabled: busy, wide: true }));
    var det = el('details', { class: 'opts' }, el('summary', null, 'Options'), fields);
    if (job.ui.optsOpen) det.open = true;
    det.addEventListener('toggle', function () { job.ui.optsOpen = det.open; });
    box.append(det);
    if (job.sbi) box.append(el('p', { class: 'small muted sbi-note', style: 'margin:0' }, job.sbi.fromSub
      ? 'Its LibCrypt data (' + plural(job.sbi.count, 'protected sector') + ', read from the .sub file) is saved with the CHD as an .sbi file, under the CHD\u2019s name.'
      : 'Its LibCrypt data (' + job.sbi.name + ') is saved with the CHD, under the CHD\u2019s name.'));
    if (job.subNote) box.append(el('p', { class: 'small muted sub-note', style: 'margin:0' }, job.subNote));
    if (job.disc === 'dvd' && (job.src === 'iso' || job.src === 'cso') && !(job.ident && job.ident.sys && job.ident.sys !== 'pc')) {
      box.append(el('p', { class: 'small muted', style: 'margin:0' }, 'The console isn\u2019t known, so check the type: DVD for PSP games and PS2 games on DVD, CD for games that came on a CD.'));
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
  var dn = datNote(job);
  if (dn) box.append(dn);
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
    var set = discSet(job);
    if (set && set.discs[0].job === job) box.append(playlistRow(set));
  }
}

/* ---------- playlists for multi-disc games ---------- */
// Redump names a game's discs "Name (Region) (Disc 1)": when two or more of them are converted, the
// first disc's card offers an .m3u listing the CHDs, which RetroArch, DuckStation, ES-DE and
// Batocera use to swap discs. It is made when saved, from the names the CHDs have then.
var DISC_RE = /^(.*?) \((?:Disc|Disk) (\d+)(?: of \d+)?\)(.*)\.chd$/i;
function discOf(job) {
  if (job.kind !== 'create' || job.state !== 'done' || !job.outputs[0]) return null;
  var m = DISC_RE.exec(job.outputs[0].name);
  // the same name on another console (or one identified and one not) is another game
  var sys = job.ident && job.ident.sys || '';
  return m ? { key: sys + '|' + (m[1] + m[3]).toLowerCase(), name: (m[1] + m[3]).trim(), n: +m[2], job: job } : null;
}
function discSet(job) {
  var me = discOf(job);
  if (!me) return null;
  var discs = [], nums = new Set();
  jobs.forEach(function (j) {
    var d = discOf(j);
    if (d && d.key === me.key && !nums.has(d.n)) { nums.add(d.n); discs.push(d); }
  });
  if (discs.length < 2) return null;
  discs.sort(function (a, b) { return a.n - b.n; });
  return { name: me.name, discs: discs };
}
function playlistRow(set) {
  var name = set.name + '.m3u', inFolder = set.discs.every(function (d) { return d.job.outputs[0].kind === 'disk'; });
  var text = function () { return set.discs.map(function (d) { return d.job.outputs[0].name; }).join('\n') + '\n'; };
  var btn = el('button', { class: 'btn sm', onclick: async function () {
    var blob = new Blob([text()], { type: 'audio/x-mpegurl' });
    if (inFolder && outDir) {
      try {
        if (!(await confirmReplace(outDir, [name]))) return;
        var w = await (await outDir.getFileHandle(name, { create: true })).createWritable();
        await w.write(blob); await w.close();
        toast('Saved ' + name + ' in ' + outDir.name + '.');
      } catch (e) { toast('Could not save the playlist: ' + e.message, 'err'); }
      return;
    }
    var f = new File([blob], name, { type: blob.type });
    if (useShareSheet && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f] }); } catch (e) { /* closed */ }
      return;
    }
    var url = URL.createObjectURL(f), a = el('a', { href: url, download: name, style: 'display:none' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  } }, icon(useShareSheet ? 'i-share' : inFolder ? 'i-folder' : 'i-download'), 'Playlist (.m3u)');
  return el('div', { class: 'note playlist' }, el('div', null, el('b', null, 'A game on ' + set.discs.length + ' discs. '),
    'Emulators swap discs through a playlist: keep ' + name + ' in the same folder as the CHDs, and open it instead of Disc 1.'),
    el('div', { class: 'row end', style: 'margin-top:6px' }, btn));
}
// a disc finishing, renamed or removed changes its game's playlist, shown on the first disc's card
function refreshDiscSets() {
  jobs.forEach(function (j) { if (j.kind === 'create' && j.state === 'done' && j.ui) renderResult(j); });
}

function outputRow(job, out) {
  if (out.kind === 'disk') {
    return el('div', { class: 'out' }, el('div', { class: 'nm' }, out.name, el('small', null, fmtBytes(out.size) + ' · saved in ' + (job.folderName || 'your folder'))), el('span', { class: 'small', style: 'color:var(--ok);display:inline-flex;align-items:center;gap:4px;padding-right:6px' }, icon('i-check'), 'Saved'));
  }
  var btns = el('div', { class: 'row' });
  btns.append(saveButton([out], function () { saveOutput(job, out); }));
  var tooBig = useShareSheet && !viaShare([out]);
  var host = HOSTED_URL.replace(/^https:\/\//, '');
  var note = out.downloaded ? ' · downloaded' : !tooBig ? '' : iosWebView ? ' · too large for the share sheet; if this app can\u2019t download it, use Discpress online in Safari: ' + host
    : iosHomeApp ? ' · too large for the share sheet, so it downloads; if nothing happens, open ' + host + ' in Safari itself' : ' · too large for the share sheet, so it downloads';
  return el('div', { class: 'out' }, el('div', { class: 'nm' }, out.name, el('small', null, fmtBytes(out.size) + note)), btns);
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
    f.append(el('button', { class: 'btn danger sm fit', onclick: function () { cancelJob(job); } }, 'Cancel'));
  } else if (job.state === 'done' || job.state === 'error' || job.state === 'canceled') {
    if (job.kind === 'chd' && job.info || job.kind === 'create' && !job.invalid) {
      f.append(el('button', { class: 'btn' + (job.state === 'done' ? ' sm fit' : ''), onclick: function () { resetJob(job); } }, job.state === 'done' ? 'Run again' : 'Try again'));
    }
  }
}

function setProgress(job, pct, text, extra) {
  var ui = job.ui;
  if (!ui) return;
  var barBox = ui.bar.parentNode;
  if (pct == null) { barBox.classList.add('indet'); ui.bar.style.width = ''; barBox.removeAttribute('aria-valuenow'); }
  else {
    barBox.classList.remove('indet');
    ui.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    barBox.setAttribute('aria-valuenow', Math.round(Math.max(0, Math.min(100, pct))));
  }
  barBox.setAttribute('aria-valuetext', text + (pct == null ? '' : ', ' + Math.round(pct) + '%'));
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
    // touch screens have nothing to drop from
    var touch = window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches;
    d.querySelector('h2').textContent = jobs.length ? 'Add more games' : touch ? 'Choose your games' : 'Drop your games here';
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
  else if (job.state === 'running') abortStart(job);
}
// a job started but still loading the engine, waiting for identification or measuring the device:
// there is no chdman run to cancel yet, so runJobNow's waits are cut short (see waitUnlessAborted)
function abortStart(job) {
  job.aborted = true;
  if (job.abortResolve) job.abortResolve();
}
// results not saved anywhere yet (downloaded, shared or written into a folder)
function unsaved(job) {
  return job.state === 'done' && job.outputs.some(function (o) { return !o.downloaded && o.kind !== 'disk' && !o.input; });
}
// silent: don't ask; keepFiles: its files moved to another job, so they stay known (no re-adding them)
function removeJob(job, silent, keepFiles) {
  if (!silent && job.state === 'running' && !confirm('Stop and remove "' + job.title + '"?')) return;
  if (!silent && unsaved(job) && !confirm('Remove "' + job.title + '"? Its results haven\u2019t been saved and will be deleted.')) return;
  if (job.run) job.run.cancel();
  else if (job.state === 'running') abortStart(job);
  queue = queue.filter(function (j) { return j !== job; });
  jobs = jobs.filter(function (j) { return j !== job; });
  if (job.el) job.el.remove();
  Store.removeJob(job.id);
  if (!keepFiles) {
    job.files.forEach(function (f) { forgetFile(f.file); });
    if (job.descFile) forgetFile(job.descFile);
    if (job.sbi) forgetFile(job.sbi.file);
    // a zip whose files are all gone can be added again; what was unpacked from it is deleted
    var zips = new Set();
    job.files.concat(job.descFile ? [{ file: job.descFile }] : []).forEach(function (f) { if (f.file.fromZip) zips.add(f.file.fromZip); });
    if (job.src === 'zip') zips.add(job.files[0].file);
    zips.forEach(function (z) {
      var inUse = jobs.some(function (o) { return o.files.some(function (f) { return f.file.fromZip === z || f.file === z; }) || (o.descFile && o.descFile.fromZip === z); });
      if (!inUse) forgetFile(z);
    });
    if (zips.size) Unzip.prune();
  }
  jobs.forEach(function (o) { if (o.parentJob === job) { o.parentJob = null; refreshJob(o); } });
  if (job.state === 'done') refreshDiscSets();
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
    if (job.state === 'done') refreshDiscSets();
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
  job.aborted = false;
  job.progressPct = null; // the dock's bar: not the last run's until this one reports
  var aborted = new Promise(function (resolve) { job.abortResolve = resolve; });
  // wait for p, or until the job is canceled or removed; true when it was
  async function stopped(p) {
    await Promise.race([p, aborted]);
    if (!job.aborted) return false;
    job.state = 'canceled';
    if (jobs.indexOf(job) >= 0) refreshJob(job, true);
    return true;
  }
  job.stalled = false;
  job.log = job.retryLog || []; // a run again after the engine failed keeps the first run's log
  job.retryLog = null;
  job.outputs = [];
  job.redump = null;
  refreshJob(job, false);
  setProgress(job, null, 'Starting…');
  try { if (await stopped(Engine.ready())) return; }
  catch (e) { job.state = 'error'; job.errorText = e.message; refreshJob(job, true); return; }
  if (job.identPromise && job.identState !== 'done') {
    setProgress(job, null, 'Identifying game…');
    // start as soon as the game is known; the checksum confirming the exact release can finish
    // meanwhile (results are renamed if needed). Files written straight into a folder are named
    // when created, so that mode waits for the checksum.
    if (await stopped(settings.storage === 'folder' && outDir ? job.identPromise : job.identKnown)) return;
    if (job.state !== 'running') return;
    applyIdent(job, true);
  }
  // automatic thread count: measure this device once, before its first compression
  if (job.kind === 'create' && job.opts.preset !== 'none' && job.disc !== 'ld' && settings.threads === 'auto' && !Tuning.result) {
    setProgress(job, null, 'Measuring this device\u2019s speed (only once)\u2026');
    if (await stopped(ensureTuned(function (n, rate) {
      if (!job.aborted) setProgress(job, null, 'Measuring this device\u2019s speed (only once)\u2026', [plural(n, 'thread') + ': ' + rate.toFixed(1) + ' MB/s']);
    }))) return;
    if (job.state !== 'running') return;
  }
  if (job.subScan && await stopped(job.subScan)) return;
  var spec = buildJob(job);
  if (settings.storage === 'folder' && outDir && (spec.rename || spec.outMode === 'stream')) {
    var oi = spec.args.indexOf('-o'), main = spec.rename ? outBase(job) + '.chd' : oi >= 0 ? spec.args[oi + 1].replace(/^.*\//, '') : '';
    var sideNames = !spec.rename && job.kind === 'create' && job.sbi ? [outBase(job) + '.sbi'] : [];
    if (main && !(await confirmReplace(outDir, [main].concat(sideNames)))) { job.state = 'canceled'; refreshJob(job, true); return; }
    if (job.aborted) { job.state = 'canceled'; if (jobs.indexOf(job) >= 0) refreshJob(job, true); return; }
  }
  if (spec.rename) {
    var nm = outBase(job) + '.chd', src = job.files[0].file;
    try {
      if (settings.storage === 'folder' && outDir) {
        setProgress(job, null, 'Copying to folder…');
        var had = await outDir.getFileHandle(nm).then(function () { return true; }, function () { return false; });
        var fh = await outDir.getFileHandle(nm, { create: true });
        var w = await fh.createWritable();
        // Cancel or Remove stop the copy (the writable is aborted: a file that was there stays as it was)
        var ac = new AbortController();
        aborted.then(function () { ac.abort(); });
        try { await src.stream().pipeTo(w, { signal: ac.signal }); }
        catch (e) {
          if (!job.aborted) throw e;
          if (!had) await outDir.removeEntry(nm).catch(function () {});
          job.state = 'canceled';
          if (jobs.indexOf(job) >= 0) refreshJob(job, true);
          return;
        }
        job.folderName = outDir.name;
        job.outputs = [{ name: nm, size: src.size, kind: 'disk' }];
      } else {
        job.outputs = [{ name: nm, size: src.size, kind: 'blob', blob: src, input: true }]; // the user's own file, renamed
      }
      job.state = 'done';
    } catch (e) { job.state = 'error'; job.errorText = e.message; }
    refreshJob(job, true);
    return;
  }
  appendLog(job, '$ ' + spec.cmdline);
  Recovery.running(job);
  if (spec.outMode === 'opfs' && spec.expected) {
    var est = await Store.estimate();
    if (est && est.quota && est.quota - est.usage < spec.expected * 1.05) {
      appendLog(job, 'Warning: browser storage may be too small (' + fmtBytes(est.quota - est.usage) + ' free, about ' + fmtBytes(spec.expected) + ' needed).');
      toast('Browser storage may be too small for this job (' + fmtBytes(est.quota - est.usage) + ' free).', 'err');
    }
  }
  if (job.aborted) { Recovery.running(null); job.state = 'canceled'; if (jobs.indexOf(job) >= 0) refreshJob(job, true); return; }
  var t0 = performance.now(), phaseStart = t0, lastPhase = '', lastPct = 0, workerError = '';
  job.run = Engine.run({
    jobId: job.id, dirPath: Store.claim(job.id), args: spec.args, inputs: spec.inputs, writable: spec.writable,
    slots: spec.slots, helpers: spec.helpers, outMode: spec.outMode, outDir: outDir, agreed: main ? [main] : [],
    // tests: 'one' or 'all' helpers fail on the first run, 'always' (all) on every run
    debugFail: DEBUG.failHelpers === 'always' ? 'all' : job.engineRetried ? null : DEBUG.failHelpers,
    onLine: function (s, t) {
      appendLog(job, t);
      var fm = /final ratio = ([\d.]+)%/.exec(t);
      if (fm) setProgress(job, 100, 'Finishing…', [fm[1] + '% of the original']);
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
      if (m[3]) bits.push(m[3] + '% of the original');
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
    Recovery.running(null);
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
      if (job.kind === 'create' && job.sbi) await addSbi(job, spec);
      if (job.identState === 'done') renameOutputs(job); // the checksum finished while converting
      Recovery.finished(job);
    } else {
      job.state = 'error';
      if (res.readFail) { job.errorText = readFailHint(res.error); Store.removeJob(job.id); refreshJob(job, true); return; }
      // (a helper that stopped, whose work the others did, isn't why)
      var errs = job.log.filter(function (l) { return /error|failed|invalid|unsupported|missing|not /i.test(l) && !/^\$ |^A helper thread stopped/.test(l); });
      job.errorText = (errs.slice(-3).join('\n') || res.error || 'chdman exited with code ' + res.code) + (job.action === 'verify' ? '' : '');
      if (engineFailure(res.error)) job.errorText = res.error; // the job worker's WebAssembly trapped
      // the worker's own report (a damaged compressed ISO, an unreadable input, full storage) explains chdman's error best
      if (workerError && job.errorText.indexOf(workerError) < 0) job.errorText = workerError + '\n' + job.errorText;
      if (job.kind === 'chd' && job.action === 'verify') job.errorText = 'Verification failed. ' + job.errorText;
      Store.removeJob(job.id);
    }
  } catch (e) {
    Recovery.running(null);
    if (e.canceled && job.stalled) { job.state = 'error'; job.errorText = STALLED; }
    else if (e.canceled) { job.state = 'canceled'; }
    else { job.state = 'error'; job.errorText = readFailHint(e.message); appendLog(job, e.message); }
    Store.removeJob(job.id);
  }
  if (job.state === 'error' && engineFailure(job.errorText)) {
    // the browser's WebAssembly engine failed, not the conversion: once, run it again from the start
    // (the same CHD when it works); a second failure says what to do about the browser
    if (!job.engineRetried && !job.aborted && jobs.indexOf(job) >= 0) {
      job.engineRetried = true;
      appendLog(job, 'The browser\u2019s WebAssembly engine failed (' + job.errorText.split('\n')[0] + '). Converting again\u2026');
      job.retryLog = job.log.slice();
      await Store.removeJob(job.id);
      if (!job.aborted && jobs.indexOf(job) >= 0) return runJobNow(job);
    }
    job.errorText += '\n' + ENGINE_HINT;
  }
  job.engineRetried = false;
  refreshJob(job, true);
}

// WebAssembly traps, which the conversion itself can't cause: some browsers' compilers (the optimizing tier
// of some Safari versions) miscompile now and then (docs/ios/README.md)
function engineFailure(text) { return /out of bounds memory access|memory access out of bounds|Multi-core compression failed/i.test(text || ''); }
var ENGINE_HINT = isIOS ? 'This is a fault in the browser engine of this iOS version, not in your files. Update iOS (Settings \u2192 General \u2192 Software Update), then try again.'
  : /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(navigator.userAgent) ? 'This is a fault in this version of Safari, not in your files. Update Safari (or macOS), or convert in Chrome, Edge or Firefox.'
  : 'This is a fault in the browser, not in your files. Update the browser, or convert in another one.';

// the job's .sbi file, as a result named after its CHD: written into the folder with the CHD, or
// given as the user's own file (nothing to store)
/* ---------- LibCrypt data from a CloneCD .sub ----------
   A CloneCD .sub holds 96 bytes of subchannel per sector of the .img, P to W in 12-byte blocks. A PS1
   disc's LibCrypt sectors carry Q subchannel with a deliberately wrong CRC; an .sbi lists them for
   emulators: "SBI\0", then per sector its absolute time (BCD minutes, seconds, frames: the .img's
   sector n is at n + 150), type 1 and the 10 bytes of Q without the CRC (DuckStation's LoadSBI). */
var SUB_MAX_BAD = 200; // more than LibCrypt ever uses: a damaged .sub, not a protection
function scanSub(job) {
  if (!job.subFile || job.subScan || (job.sbi && !job.sbi.fromSub) || !job.ident || job.ident.sys !== 'ps1') return;
  job.subScan = sbiFromSub(job.subFile).then(function (r) {
    if (jobs.indexOf(job) < 0) return;
    if (r.bad > SUB_MAX_BAD) job.subNote = 'The .sub file has ' + r.bad.toLocaleString('en-US') + ' sectors whose subchannel data is damaged, far more than LibCrypt protection uses, so no .sbi file is made from it.';
    else if (r.sbi && !job.sbi) job.sbi = { file: new File([r.sbi], stem(job.descName || job.title) + '.sbi'), name: stem(job.descName || job.title) + '.sbi', fromSub: true, count: r.bad };
    if (job.ui && job.state !== 'running') refreshJob(job, true);
  }, function (e) { appendLog(job, 'The .sub file could not be read: ' + e.message); });
}
function subCrc(b, o) {
  var c = 0;
  for (var i = 0; i < 10; i++) {
    c ^= b[o + i] << 8;
    for (var k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return ~c & 0xffff;
}
async function sbiFromSub(file) {
  var n = Math.floor(file.size / 96), step = 96 * 43690, entries = [], bad = 0, bcd = function (v) { return ((v / 10) | 0) * 16 + v % 10; };
  for (var pos = 0; pos < n * 96; pos += step) {
    var b = new Uint8Array(await file.slice(pos, Math.min(n * 96, pos + step)).arrayBuffer());
    for (var o = 0; o + 96 <= b.length; o += 96) {
      var q = o + 12, any = 0;
      for (var z = 0; z < 12; z++) any |= b[q + z];
      if (!any) continue; // no subchannel read for this sector
      if (subCrc(b, q) === ((b[q + 10] << 8) | b[q + 11])) continue;
      bad++;
      if (bad > SUB_MAX_BAD) return { bad: bad };
      var lba = (pos + o) / 96 + 150, e = new Uint8Array(14);
      e[0] = bcd(Math.floor(lba / 4500)); e[1] = bcd(Math.floor(lba / 75) % 60); e[2] = bcd(lba % 75); e[3] = 1;
      e.set(b.subarray(q, q + 10), 4);
      entries.push(e);
    }
  }
  if (!entries.length) return { bad: 0 };
  var out = new Uint8Array(4 + 14 * entries.length);
  out.set([83, 66, 73, 0]);
  entries.forEach(function (e, i) { out.set(e, 4 + 14 * i); });
  return { bad: bad, sbi: out };
}

async function addSbi(job, spec) {
  var nm = outBase(job) + '.sbi', f = job.sbi.file;
  if (spec.outMode === 'stream' && outDir) {
    try {
      var w = await (await outDir.getFileHandle(nm, { create: true })).createWritable();
      await f.stream().pipeTo(w);
      job.outputs.push({ name: nm, size: f.size, kind: 'disk' });
    } catch (e) { appendLog(job, 'The .sbi file could not be written into the folder: ' + e.message); toast('The .sbi file could not be written into the folder.', 'err'); }
  } else {
    job.outputs.push({ name: nm, size: f.size, kind: 'blob', blob: f, input: true });
  }
}

/* ---------- DAT files ----------
   Kept in private storage (chdman-dats/<id>.json), else for this visit. A disc being converted is
   checked once identified (its files, by size and CRC-32; checksums already computed are reused); a
   CHD after Verify, from the files Redump's layout gives back (redumpCheck). Every track matching a
   game names the results after it, as identification does. */
async function loadDat(file) {
  if (file.size > 256 << 20) return null;
  var text;
  try { text = await file.text(); } catch (e) { return null; }
  var dat = parseDat(text);
  if (!dat) return null;
  if (!dat.meta.name) dat.meta.name = stem(file.name);
  var old = Dats.add(dat);
  if (old) DatStore.remove(old.id);
  DatStore.save(dat);
  return dat.meta;
}
var DatStore = {
  dir: async function () { return (await navigator.storage.getDirectory()).getDirectoryHandle('chdman-dats', { create: true }); },
  save: async function (dat) {
    if (!Store.available) return;
    try {
      var w = await (await (await this.dir()).getFileHandle(dat.meta.id + '.json', { create: true })).createWritable();
      await w.write(JSON.stringify({ meta: dat.meta, games: dat.games.map(function (g) { return [g.name, g.roms.map(function (r) { return [r.name, r.size, r.crc]; })]; }) }));
      await w.close();
      dat.meta.kept = true;
    } catch (e) { /* kept for this visit */ }
  },
  remove: async function (id) {
    try { await (await this.dir()).removeEntry(id + '.json'); } catch (e) { /* not kept */ }
  },
  load: async function () {
    if (!Store.available) return;
    try {
      var dir = await this.dir();
      for await (var h of dir.values()) {
        try {
          var d = JSON.parse(await (await h.getFile()).text());
          d.meta.kept = true;
          Dats.add({ meta: d.meta, games: d.games.map(function (g) { return { name: g[0], roms: g[1].map(function (r) { return { name: r[0], size: r[1], crc: r[2] }; }) }; }) });
        } catch (e) { /* a damaged one is skipped */ }
      }
    } catch (e) { /* none */ }
    renderDatList();
    if (Dats.list.length) datRecheck();
  }
};
// a job's files with what to checksum: [{file, size, how}]
function datItems(job) {
  var items = [];
  job.files.forEach(function (f) {
    if (f.ecm) { if (f.imageSize) items.push({ file: f.file, size: f.imageSize, how: 'ecm' }); }
    else if (f.pbp) items.push({ file: f.file, size: f.pbp.sectors * 2352, how: 'pbp@' + f.pbp.at + ':' + f.pbp.sectors });
    else if (job.src === 'cso') { if (job.isoSize) items.push({ file: f.file, size: job.isoSize, how: 'ciso' }); }
    else items.push({ file: f.file, size: f.file.size, how: '' });
  });
  if (job.descFile) items.push({ file: job.descFile, size: job.descFile.size, how: '' });
  return items;
}
async function datCheck(job) {
  if (!Dats.list.length || job.kind !== 'create' || job.invalid || job.missing.length || job.needCue) return;
  var items = datItems(job).filter(function (it) { return Dats.size(it.size).length; });
  if (!items.length) { job.dat = { none: true }; return; }
  job.datState = 'checking';
  if (job.ui && job.state !== 'running') renderNotes(job);
  var total = items.reduce(function (n, it) { return n + it.size; }, 0), before = 0;
  try {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      it.crc = await crcCached(it.file, 0, it.size, function (p) {
        var n = job.ui && job.ui.datLine;
        if (n) n.textContent = 'Checking against your DAT files\u2026 ' + Math.round(100 * (before + p * it.size) / total) + '%';
      }, it.how);
      before += it.size;
    }
  } catch (e) { job.datState = null; appendLog(job, 'Could not check against the DAT files: ' + e.message); return; }
  job.datState = null;
  if (jobs.indexOf(job) < 0) return;
  datApply(job, datMatch(items));
}
// the result of a DAT check: a full match names the disc after the DAT's game
function datApply(job, res) {
  job.dat = res;
  if (res.full) {
    var id = job.ident || {};
    job.ident = Object.assign({}, id, { name: res.game, method: 'dat', entry: id.entry ? Object.assign({}, id.entry, { alternatives: null, name: res.game }) : null });
    applyIdent(job);
    if (job.state === 'done') renameOutputs(job);
  }
  if (job.ui) refreshJob(job, job.state !== 'running' && job.state !== 'queued');
}
// after DATs were added or removed: every job again
var datChain = Promise.resolve();
function datRecheck() {
  jobs.forEach(function (job) {
    if (job.kind === 'chd') {
      if (job.redumpFiles) datApply(job, Dats.list.length ? datMatch(job.redumpFiles) : null);
      return;
    }
    if (job.identState !== 'done') return; // checked when identified
    job.dat = null;
    if (job.ui) renderNotes(job);
    datChain = datChain.then(function () { return datCheck(job); });
  });
}
function datNote(job) {
  job.ui.datLine = null;
  if (job.datState === 'checking') {
    var n = el('div', { class: 'note dat-note' }, 'Checking against your DAT files\u2026');
    job.ui.datLine = n;
    return n;
  }
  var d = job.dat;
  if (!d || !Dats.list.length) return null;
  if (d.none) return el('div', { class: 'note dat-note' }, 'Not in your DAT files.');
  var where = ' \u201c' + d.game + '\u201d in ' + d.dat.name;
  if (d.full) {
    return el('div', { class: 'note ok dat-note' }, el('b', null, '\u2713 Verified with your DAT file. '),
      (d.total === 1 ? 'It matches' : 'All ' + d.total + ' tracks match') + where + '.' + (d.descDiffers ? ' The cue sheet differs from the DAT\u2019s, which doesn\u2019t change the disc.' : ''));
  }
  return el('div', { class: 'note warn dat-note' }, el('b', null, 'Partly matches your DAT file. '),
    d.matched + ' of ' + d.total + ' tracks match' + where + '. Not matched: ' + d.missing.slice(0, 3).join(', ') + (d.missing.length > 3 ? ' and ' + (d.missing.length - 3) + ' more' : '') + '.');
}
function renderDatList() {
  var ul = $('#datList');
  if (!ul) return;
  ul.replaceChildren();
  Dats.list.forEach(function (d) {
    ul.append(el('li', null, el('span', null, d.name), el('small', null, d.games.toLocaleString('en-US') + ' games' + (d.version ? ' \u00b7 ' + d.version : '') + (d.kept ? '' : ' \u00b7 this visit only')),
      el('button', { class: 'icon-btn', 'aria-label': 'Remove ' + d.name, onclick: function () { Dats.remove(d.id); DatStore.remove(d.id); renderDatList(); datRecheck(); } }, icon('i-x'))));
  });
  $('#datEmpty').hidden = Dats.list.length > 0;
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
  job.redumpFiles = (res.outputs || []).filter(function (o) { return o.crc; }).map(function (o) { return { name: o.name, size: o.size, crc: o.crc }; });
  var files = (res.outputs || []).filter(function (o) { return o.crc && !/\.cue$/i.test(o.name); });
  redumpMatch(job, files);
  // the user's DAT files, every track: a full match names the CHD after its game
  if (Dats.list.length) datApply(job, datMatch(job.redumpFiles));
}
// the files Redump's layout gave back, looked up in the built-in database
function redumpMatch(job, files) {
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
// Settings: "Notify me when all jobs are done" (asks the browser's permission when turned on). Android's
// Chrome only shows notifications through a service worker: the online version's, when it has one
async function notifyDone() {
  if (!settings.notify || !window.Notification || Notification.permission !== 'granted') return;
  var body = 'All jobs are done.';
  try {
    var reg = navigator.serviceWorker && location.protocol === 'https:' ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.showNotification('Discpress', { body: body });
    else new Notification('Discpress', { body: body });
  } catch (e) { /* not shown here: nothing to do */ }
}

// the hosted copy (https, web/README.md): an installable web app that works offline. The file stays the same
// bytes as the release, so it adds the manifest, the PNG touch icon and the service worker itself.
function initHosted() {
  if (!(location.protocol === 'https:' || DEBUG.hosted) || !('serviceWorker' in navigator)) return;
  // the manifest and icons are the online version's files: link them only where its service worker is
  // (a copy of the file on another site keeps its built-in icon); private windows may refuse workers
  navigator.serviceWorker.register('sw.js').then(function () {
    document.head.append(el('link', { rel: 'manifest', href: 'manifest.webmanifest' }));
    var icon = document.querySelector('link[rel="apple-touch-icon"]');
    if (icon) icon.setAttribute('href', 'apple-touch-icon.png');
  }, function () { /* not the online version */ });
}
// in an iPhone/iPad app's web view: big results can't leave it, so point to Safari
function initIosTip() {
  var tip = $('#iosTip');
  if (!tip || !iosWebView) return;
  try { if (localStorage.getItem('chdman-web-ios-tip')) return; } catch (e) { /* show it */ }
  tip.hidden = false;
  $('#copyHosted').addEventListener('click', async function () {
    try { await navigator.clipboard.writeText(HOSTED_URL); toast('Link copied. Paste it in Safari.'); }
    catch (e) { toast('Copy it from here: ' + HOSTED_URL, null, 8000); }
  });
  $('#iosTipOk').addEventListener('click', function () {
    tip.hidden = true;
    try { localStorage.setItem('chdman-web-ios-tip', '1'); } catch (e) { /* ignore */ }
  });
}

// results of an earlier visit that weren't saved, and the job that didn't finish (Recovery)
// what to do when results can only be kept in memory
function keepResultsAdvice() {
  var ways = ['save each result as soon as it is ready'];
  if (window.showDirectoryPicker) ways.push('have results written into a folder (Settings \u2192 Where to keep results)');
  if (location.protocol !== 'https:') ways.push('use Discpress online at ' + HOSTED_URL.replace(/^https:\/\//, '') + ', where results stay on disk until you save them');
  var last = ways.pop();
  return 'To keep them, ' + (ways.length ? ways.join(', ') + ', or ' : '') + last + '.';
}
function renderEarlier() {
  var box = $('#earlier');
  if (!box) return;
  box.replaceChildren();
  var items = Recovery.earlier, stopped = Recovery.stopped, lost = Recovery.lost;
  box.hidden = !items.length && !stopped.length && !lost.length;
  if (box.hidden) return;
  var card = el('div', { class: 'card earlier' });
  if (lost.length) {
    var names = lost.map(function (l) { return '\u201c' + l.name + '\u201d'; }).join(', ');
    card.append(el('div', { class: 'note warn' }, el('b', null, (lost.length > 1 ? 'Results lost when the page was closed or reloaded: ' : 'A result was lost when the page was closed or reloaded: ') + names + '. '),
      'This page keeps results in memory, since the browser gives it no storage of its own here (for example when it is opened as a file). ' + keepResultsAdvice(),
      el('button', { class: 'btn sm', style: 'margin-left:8px', onclick: function () { Recovery.lost = []; renderEarlier(); } }, 'OK')));
  }
  if (stopped.length) {
    var why = isIOS ? ' iOS does this to free memory, or when the screen was locked or another app was used for a while.' : '';
    card.append(el('div', { class: 'note warn' }, el('b', null, (stopped.length > 1 ? 'Conversions that didn\u2019t finish: ' : 'A conversion didn\u2019t finish: ') + stopped.map(function (t) { return '\u201c' + t + '\u201d'; }).join(', ') + '. '),
      'The page was closed or reloaded while it ran.' + why + ' Add its files again to start over.',
      el('button', { class: 'btn sm', style: 'margin-left:8px', onclick: function () { Recovery.stopped = []; renderEarlier(); } }, 'OK')));
  }
  if (items.length) {
    card.append(el('h2', null, 'From your last visit'));
    card.append(el('p', { class: 'small muted', style: 'margin:0 0 8px' }, 'These results were finished but not saved when the page was closed or reloaded. Save them, or delete them to free space.'));
    items.forEach(function (it) {
      var job = { id: it.jobId, outputs: it.outputs };
      it.outputs.forEach(function (out, i) {
        var btns = el('div', { class: 'row' });
        btns.append(saveButton([out], function () { saveOutput(job, out); }));
        // one Delete for the job's results together (they are stored together), on its first file
        var n = it.outputs.length;
        if (i === 0) btns.append(el('button', { class: 'btn sm', onclick: async function () {
          if (n > 1 && !confirm('Delete all ' + n + ' files of \u201c' + it.title + '\u201d?')) return;
          Recovery.earlier = Recovery.earlier.filter(function (e) { return e !== it; });
          await Store.removeJob(it.jobId, it.session);
          renderEarlier();
          refreshStorageInfo();
        } }, n > 1 ? 'Delete all ' + n : 'Delete'));
        card.append(el('div', { class: 'out' }, el('div', { class: 'nm' }, out.name, el('small', null, fmtBytes(out.size) + ' \u00b7 ' + it.title)), btns));
      });
    });
  }
  box.append(card);
}

/* ============================================================
   outputs: download / share / save to folder
   ============================================================ */
function markSaved(job, out) {
  out.downloaded = true;
  if (out.kind === 'opfs' || out.kind === 'blob') Recovery.saved(job, out);
}
async function outputFile(job, out) {
  if (out.kind === 'blob') return new File([out.blob], out.name, { type: 'application/octet-stream' });
  var f = await Store.file(job.id, out.slot, out.session);
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
    if (!isIOS) markSaved(job, out);
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
    markSaved(job, out);
    refreshJob(job);
  } catch (e) {
    // closed by the user; WebKit reports a file it could not read as an AbortError too, with its own message
    if (e && e.name === 'AbortError' && !/error while reading/i.test(e.message || '')) return;
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
        outs.forEach(function (x) { markSaved(x[0], x[1]); });
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
  // browsers ask before a page downloads several files, and a "Block" there can't be seen from here
  if (outs.length > 1) toast('If your browser asks whether to allow several downloads, allow them. A file that didn\u2019t arrive can be downloaded again from its card.', null, 8000);
}
// never replace a file already in the folder without asking: an earlier run's result, another game's
// that got the same name, or anything else the user keeps there
async function confirmReplace(dir, names) {
  var there = [];
  for (var i = 0; i < names.length; i++) {
    try { await dir.getFileHandle(names[i]); there.push(names[i]); } catch (e) { /* not there */ }
  }
  if (!there.length) return true;
  return confirm(there.length === 1
    ? '\u201c' + there[0] + '\u201d is already in the folder \u201c' + dir.name + '\u201d. Replace it?'
    : 'These files are already in the folder \u201c' + dir.name + '\u201d: ' + there.join(', ') + '. Replace them?');
}
async function saveToFolder(list) {
  var dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'chdman-out' }); }
  catch (e) { return; }
  var names = [];
  list.forEach(function (job) { job.outputs.forEach(function (o) { if (o.kind !== 'disk') names.push(o.name); }); });
  if (!(await confirmReplace(dir, names))) return;
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
        markSaved(job, out);
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
  var counts = { ready: 0, queued: 0, running: 0, done: 0, error: 0, cant: 0 };
  // a job whose files can't be converted never ran: not "failed"
  jobs.forEach(function (j) { if (j.invalid) counts.cant++; else if (counts[j.state] != null) counts[j.state]++; });
  dock.hidden = !jobs.length || activeTab !== 'convert';
  document.body.classList.toggle('has-dock', !dock.hidden);
  document.documentElement.classList.toggle('has-dock', !dock.hidden);
  var parts = [];
  if (counts.running) parts.push(el('b', null, current ? current.title : 'Working'));
  if (counts.queued) parts.push(counts.queued + ' queued');
  if (counts.ready) parts.push(counts.ready + ' ready');
  if (counts.done) parts.push(counts.done + ' done');
  if (counts.error) parts.push(counts.error + ' failed');
  if (counts.cant) parts.push(counts.cant + ' can\u2019t convert');
  var t = $('#dockText');
  t.replaceChildren();
  parts.forEach(function (p, i) { if (i) t.append(' · '); t.append(p); });
  var bar = $('#dockBar');
  bar.hidden = !current;
  if (current) bar.querySelector('i').style.width = (current.progressPct ? current.progressPct() : 0) + '%';
  // with a single job the card's own button is enough
  $('#startAll').hidden = counts.ready < 2;
  $('#startAll').lastChild.textContent = 'Start all (' + counts.ready + ')';
  var withOut = jobs.filter(function (j) { return j.state === 'done' && j.outputs.length; });
  var nOut = withOut.reduce(function (s, j) { return s + j.outputs.filter(function (o) { return o.kind !== 'disk'; }).length; }, 0);
  $('#dlAll').hidden = nOut < 2;
  var allOut = [];
  withOut.forEach(function (j) { j.outputs.forEach(function (o) { if (o.kind !== 'disk') allOut.push(o); }); });
  $('#dlAll').lastChild.textContent = (viaShare(allOut) ? 'Save all to Files' : 'Download all') + ' (' + nOut + ')';
  $('#saveAll').hidden = !window.showDirectoryPicker || nOut < 2;
  // one primary action at a time: start what's ready, then, once nothing is left to do, save the results
  var settledAll = !counts.ready && !counts.queued && !counts.running;
  $('#dlAll').className = 'btn' + (settledAll ? ' primary' : ' sm');
  $('#saveAll').className = 'btn' + (settledAll ? '' : ' sm');
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
var cli = { cmd: 'createcd', files: [], vals: {}, textMode: false, run: null, last: null, templates: null, outAuto: true };

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
// a typed command's words as a shell splits them: "…" (where \" and \\ stand for " and \), '…' as
// it is, and \ before a space or a quote outside quotes (a name with a space: my\ game.cue)
function shellWords(line) {
  var out = [], cur = null, q = null;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    if (cur === null) cur = '';
    if (c === '"' || c === "'") q = c;
    // \ escapes a space, a quote or itself; before anything else it stays (a Windows path: C:\games\x.cue)
    else if (c === '\\' && i + 1 < line.length && /[\s"'\\]/.test(line[i + 1])) cur += line[++i];
    else cur += c;
  }
  if (cur !== null) out.push(cur);
  return out;
}
function cliParseText(text) {
  // quotes as phones type them (iOS smart punctuation) count as plain ones where they open or close a
  // word; inside one (Tony Hawk\u2019s.iso) they are part of the name
  var plain = text.trim()
    .replace(/(^|\s)[\u201c\u201d\u201e]/g, '$1"').replace(/[\u201c\u201d](?=\s|$)/g, '"')
    .replace(/(^|\s)[\u2018\u2019]/g, "$1'").replace(/[\u2018\u2019](?=\s|$)/g, "'");
  var toks = shellWords(plain), args = [];
  if (toks[0] && /^chdman(\.exe)?$/i.test(toks[0])) toks.shift();
  var cmd = toks[0];
  var writable = cmd === 'addmeta' || cmd === 'delmeta' || (cmd === 'verify' && toks.some(function (t) { return t === '-f' || t === '--fix'; }));
  for (var i = 0; i < toks.length; i++) {
    var t = toks[i], prev = toks[i - 1];
    if (i > 0 && FILE_FLAGS[prev]) {
      var name = base(t);
      // (apostrophes typed either way: ' or \u2019)
      var loose = function (n) { return n.toLowerCase().replace(/[\u2018\u2019]/g, "'"); };
      var f = cli.files.find(function (x) { return x.name === name; }) || cli.files.find(function (x) { return loose(x.name) === loose(name); });
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
  // the last command's results give way to this one's (only one command's results are shown)
  if (cli.last) {
    if (unsaved(cli.last) && !confirm('The last command\u2019s results haven\u2019t been saved. Run this one and delete them?')) return;
    Store.removeJob(cli.last.id);
    cli.last = null;
  }
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
  var cjob = { id: 'cli' + uid(), state: 'done', outputs: [], el: null }, stalled = false;
  cli.last = cjob;
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
      jobId: cjob.id, dirPath: Store.claim(cjob.id), args: args, inputs: inputs, writable: writable,
      slots: /^(info|listtemplates)$/.test(args[0]) || (args[0] === 'verify' && !writable.length) ? 0 : args[0] === 'extractcd' ? 101 : 3,
      outMode: settings.storage === 'folder' && outDir ? 'stream' : settings.storage === 'memory' || !Store.available ? 'mem' : 'opfs', outDir: outDir,
      helpers: isCreate && comp !== 'none' && nt > 1 ? nt : /^(verify|extract(cd|dvd|hd|raw))$/.test(args[0]) ? readHelpers() : 0,
      onLine: function (s, t) { con.textContent += t + '\n'; con.scrollTop = con.scrollHeight; },
      onProgress: function (t) {
        if (stalledProgress(t)) { if (!stalled) { stalled = true; cli.run.cancel(); } return; }
        var m = /([\d.]+)% complete/.exec(t);
        if (m) { prog.querySelector('.bar').classList.remove('indet'); prog.querySelector('.bar').setAttribute('aria-valuenow', Math.round(+m[1])); barI.style.width = m[1] + '%'; ptext.textContent = t.trim(); }
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
    if (!cjob.outputs.some(function (o) { return o.kind !== 'disk'; })) { Store.removeJob(cjob.id); if (cli.last === cjob) cli.last = null; }
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
  // the status line's own width: window resizes, and also a scrollbar appearing or fonts loading
  if (window.ResizeObserver) new ResizeObserver(function () { fitChips(); }).observe($('#chips'));
  else window.addEventListener('resize', fitChips);
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
  $$('.tab').forEach(function (t) {
    var on = t.getAttribute('data-tab') === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
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
  // text: a string, or a list of strings and elements (a span.opt is left out on narrow screens)
  c.replaceChildren.apply(c, [el('i')].concat(text));
  fitChips();
}
// the status line stays on one line: the threads item leaves when it would be cut short
function fitChips() {
  var t = document.getElementById('chipThreads');
  if (!t) return;
  t.classList.remove('squeezed');
  if (t.scrollWidth > t.clientWidth + 1) t.classList.add('squeezed');
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
  updateTabCount(); // the drop zone's wording for this device (touch screens choose, others drop)
  $$('.tab').forEach(function (t) { t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); }); });
  // the tab list's keys: arrows, Home and End move to and open a tab
  $('.tabs').addEventListener('keydown', function (e) {
    var tabs = $$('.tab'), i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    var to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    var t = tabs[(to + tabs.length) % tabs.length];
    switchTab(t.getAttribute('data-tab'));
    t.focus();
  });

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
    var done = jobs.filter(function (j) { return j.state === 'done' || j.state === 'canceled' || j.state === 'error'; });
    var n = done.filter(unsaved).length;
    if (n && !confirm(plural(n, 'finished job') + ' ha' + (n > 1 ? 've' : 's') + ' results that haven\u2019t been saved. Remove ' + (n > 1 ? 'them' : 'it') + ' and delete the results?')) return;
    done.forEach(function (j) { removeJob(j, true); });
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
  var ways = [];
  if (window.showDirectoryPicker) ways.push('have results written straight into a folder');
  if (location.protocol !== 'https:') ways.push('use Discpress online at ' + HOSTED_URL.replace(/^https:\/\//, '') + ', which keeps results on disk');
  $('#memTipWays').textContent = ways.length ? ways.join(', or ') + '.' : 'save each result as soon as it is ready.';
  $('#setRename').checked = settings.rename;
  $('#setRename').addEventListener('change', function (e) {
    settings.rename = e.target.checked; saveSettings();
    jobs.forEach(function (j) {
      if (j.state === 'running' || j.state === 'queued' || j.state === 'done' || j.outEdited) return;
      j.opts.out = settings.rename && j.ident && j.ident.name ? j.ident.name : j.title;
      refreshJob(j, true);
    });
  });
  $('#setPs2Dvd').value = settings.ps2dvd === 'cd' ? 'cd' : 'dvd';
  $('#setPs2Dvd').addEventListener('change', function (e) {
    settings.ps2dvd = e.target.value; saveSettings();
    // jobs not started yet follow it (unless their type was picked by hand)
    jobs.forEach(function (j) {
      if (j.kind !== 'create' || !j.ident || j.ident.sys !== 'ps2' || !j.ps2dvd || j.discEdited) return;
      if (j.state !== 'ready') return;
      applyIdent(j);
      refreshJob(j, true);
    });
  });
  $('#setKeepCue').checked = !!settings.keepCue;
  $('#setKeepCue').addEventListener('change', function (e) {
    settings.keepCue = e.target.checked; saveSettings();
    jobs.forEach(function (j) { if (j.el && j.kind === 'create') refreshJob(j); });
  });
  if (window.Notification) {
    $('#notifyRow').hidden = false;
    $('#setNotify').checked = !!settings.notify && Notification.permission === 'granted';
    $('#setNotify').addEventListener('change', async function (e) {
      var box = e.target;
      if (box.checked && Notification.permission !== 'granted') {
        var p = 'denied';
        try { p = await Notification.requestPermission(); } catch (x) { /* not allowed to ask */ }
        if (p !== 'granted') { box.checked = false; toast('The browser didn\u2019t allow notifications for this page. You can allow them in its site settings.', 'err'); }
      }
      settings.notify = box.checked; saveSettings();
    });
  }
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
    if (cli.last && !cli.run) { await Store.removeJob(cli.last.id); cli.last = null; $('#cliOuts').replaceChildren(); }
    var earlier = Recovery.earlier;
    Recovery.earlier = [];
    for (var j = 0; j < earlier.length; j++) await Store.removeJob(earlier[j].jobId, earlier[j].session);
    renderEarlier();
    try {
      var root = await navigator.storage.getDirectory();
      var work = await root.getDirectoryHandle('chdman-work', { create: true });
      await Store.cleanupStale(work);
      await Unzip.prune();
      await Unzip.cleanup();
    } catch (e) { /* ignore */ }
    refreshStorageInfo();
    updateDock();
    toast('Temporary storage cleared.');
  });

  window.addEventListener('beforeunload', function (e) {
    var busy = jobs.some(function (j) { return j.state === 'running' || j.state === 'queued'; }) || !!cli.run;
    var left = jobs.some(unsaved) || (cli.last && unsaved(cli.last));
    if (busy || left) { e.preventDefault(); e.returnValue = ''; }
  });

  cliInit();
  updateDock();
  updateChips();

  Store.init().then(function () { updateChips(); renderEarlier(); DatStore.load(); });
  $('#datAdd').addEventListener('click', function () { pickFiles('datInput', function (l) { addEntries(filesFromList(l)); }); });
  initHosted();
  initIosTip();
  Engine.ready().then(function () {
    setChip('chipEngine', ['Engine ready', Engine.simd ? '' : el('span', { class: 'opt' }, ' (compatibility mode)')], 'ok');
  }, function (e) {
    setChip('chipEngine', 'Engine unavailable', 'err');
    $('#fatal').append(el('div', { class: 'note err fatal' }, el('b', null, 'This browser cannot run Discpress. '), e.message));
  });
}

function updateChips() {
  var nt = threadCount(), auto = settings.threads === 'auto';
  setChip('chipThreads', [auto ? el('span', { class: 'opt' }, 'Auto \u00b7 ') : '', plural(nt, 'thread')], '');
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
