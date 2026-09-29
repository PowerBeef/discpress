/* ============================================================
   game identification: console detection + Redump database
   ============================================================ */
var SYSTEMS = {
  ps1: ['PS1', 'Sony PlayStation'], ps2: ['PS2', 'Sony PlayStation 2'], psp: ['PSP', 'Sony PlayStation Portable'],
  saturn: ['SAT', 'Sega Saturn'], segacd: ['SCD', 'Sega CD / Mega-CD'], dc: ['DC', 'Sega Dreamcast'],
  pcecd: ['PCE', 'PC Engine CD / TurboGrafx-CD'], pcfx: ['PC-FX', 'NEC PC-FX'], ngcd: ['NGCD', 'Neo Geo CD'],
  '3do': ['3DO', '3DO Interactive Multiplayer'], cdi: ['CD-i', 'Philips CD-i'], cd32: ['CD32', 'Amiga CD32'],
  cdtv: ['CDTV', 'Commodore CDTV'], jagcd: ['JAG', 'Atari Jaguar CD'], naomi: ['NAOMI', 'Sega NAOMI (GD-ROM)'],
  naomi2: ['NAOMI2', 'Sega NAOMI 2 (GD-ROM)'], pc98: ['PC-98', 'NEC PC-98'], gc: ['GC', 'Nintendo GameCube'],
  wii: ['Wii', 'Nintendo Wii'], pc: ['DATA', 'Data disc (PC or unknown system)']
};
var SYS_COLORS = {
  ps1: ['#c8c8d4', '#1c1733'], ps2: ['#2f5bd3', '#ffffff'], psp: ['#26262e', '#ffffff'], saturn: ['#4a4f63', '#ffffff'],
  segacd: ['#1f4ea8', '#ffffff'], dc: ['#ff7a1a', '#1c1733'], pcecd: ['#f1ead6', '#1c1733'], pcfx: ['#3a3a44', '#ffffff'],
  ngcd: ['#d9b23a', '#1c1733'], '3do': ['#b01e2f', '#ffffff'], cdi: ['#1c6fb8', '#ffffff'], cd32: ['#e11d48', '#ffffff'],
  cdtv: ['#33333d', '#ffffff'], jagcd: ['#d62828', '#ffffff'], naomi: ['#6a4fb8', '#ffffff'], naomi2: ['#6a4fb8', '#ffffff'],
  pc98: ['#5b6b7a', '#ffffff'], gc: ['#6a4fb8', '#ffffff'], wii: ['#dfe6ea', '#1c1733']
};
function sysColor(s) { return SYS_COLORS[s] || null; }
function sysShort(s) { return SYSTEMS[s] ? SYSTEMS[s][0] : ''; }
function sysName(s) { return SYSTEMS[s] ? SYSTEMS[s][1] : ''; }
function normSerial(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

var GameDB = {
  // bySerial: exact serials; bySerialBase: serials with a suffix (T-8113H-50) under their base (T-8113H)
  loading: null, version: '', bySerial: new Map(), bySerialBase: new Map(), bySize: new Map(), count: 0,
  ready: function () {
    if (!this.loading) this.loading = this._load();
    return this.loading;
  },
  _load: async function () {
    var node = document.getElementById('gamedb');
    var bytes = await gunzip(b64bytes(node.textContent), +node.getAttribute('data-size'));
    node.textContent = '';
    var data = JSON.parse(new TextDecoder().decode(bytes));
    this.version = data.version;
    var self = this;
    Object.keys(data.systems).forEach(function (sys) {
      data.systems[sys].split('\n').forEach(function (line) {
        if (!line) return;
        var f = line.split('\t');
        var e = { sys: sys, name: f[0], serial: f[1], size: +f[2], crc: f[3], track: f[4] ? +f[4] : 0, ext: f[5] };
        self.count++;
        if (e.serial) {
          var add = function (map, k) {
            if (!k) return;
            var l = map.get(k);
            if (!l) map.set(k, l = []);
            if (l.indexOf(e) < 0) l.push(e);
          };
          add(self.bySerial, normSerial(e.serial));
          var parts = e.serial.split(/[-\s]/);
          if (parts.length > 2) add(self.bySerialBase, normSerial(parts[0] + parts[1]));
        }
        var s = self.bySize.get(e.size);
        if (!s) self.bySize.set(e.size, s = []);
        s.push(e);
      });
    });
    return this;
  },
  // releases with this serial; regional variants (same base, extra suffix) only when none match exactly
  serial: function (serial, sys) {
    var k = normSerial(serial);
    var pick = function (map) {
      var l = map.get(k) || [];
      return sys ? l.filter(function (e) { return e.sys === sys; }) : l;
    };
    var exact = pick(this.bySerial);
    return exact.length ? exact : pick(this.bySerialBase);
  },
  size: function (n) { return this.bySize.get(n) || []; }
};

/* ---------- sector readers ---------- */
function asc(b, off, len) {
  var s = '';
  for (var i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
function clean(s) { return s.replace(/\0/g, ' ').replace(/\s+/g, ' ').trim(); }
function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

// reads 2048-byte user data sectors from a file region with 2048/2336/2352-byte sectors
function fileReader(file, start, sectorSize) {
  return {
    read: async function (lba) {
      var off = start + lba * sectorSize;
      if (off + sectorSize > file.size) return null;
      var b = new Uint8Array(await file.slice(off, off + sectorSize).arrayBuffer());
      if (sectorSize === 2048) return b;
      if (sectorSize === 2336) return b.subarray(8, 2056);
      var o = b[15] === 2 ? 24 : 16;
      return b.subarray(o, o + 2048);
    }
  };
}

// a worker that opens images for reading (the reader role) as msg says; request(q) asks it for data
function readerWorker(msg, timeout) {
  return Engine.ready().then(function () {
    return new Promise(function (resolve, reject) {
      var w = new Worker(Engine.url), seq = 0, waiting = {};
      var timer = setTimeout(function () { w.terminate(); reject(new Error('timeout')); }, timeout || 30000);
      w.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'reader-ready') {
          clearTimeout(timer);
          resolve({
            info: m,
            request: function (q) {
              return new Promise(function (res) { var id = ++seq; waiting[id] = res; q.type = 'read'; q.id = id; w.postMessage(q); });
            },
            close: function () { w.terminate(); }
          });
        } else if (m.type === 'sector') {
          var r = waiting[m.id]; delete waiting[m.id];
          if (r) r(m.data);
        } else if (m.type === 'fatal') { clearTimeout(timer); w.terminate(); reject(new Error(m.message)); }
      };
      w.onerror = function (e) { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'worker error')); };
      Engine.post(w, msg);
    });
  });
}
// opens a CHD in a worker and reads sectors from it (ciso: a CSO/ZSO compressed ISO, read like a DVD CHD)
function chdReader(file, ciso) {
  return readerWorker({ type: 'reader', name: 'x.chd', blob: file, ciso: !!ciso }).then(function (r) {
    var m = r.info;
    return { kind: m.kind, tracks: m.tracks, logical: m.logical, read: function (track, lba) { return r.request({ track: track, lba: lba }); }, close: r.close };
  });
}
// opens ECM images in a worker (which scans each whole file): for each, a stand-in for the image it
// holds that reads like a file (size, slice(a, b).arrayBuffer(), and ecm: the file), or null if it
// can't be read; and close()
function ecmImages(files) {
  return readerWorker({ type: 'reader', ecm: files }, 180000).then(function (r) {
    var views = files.map(function (f, i) {
      var size = r.info.sizes[i];
      return size == null ? null : {
        size: size, ecm: f,
        slice: function (a, b) {
          return {
            arrayBuffer: function () {
              return r.request({ file: i, pos: a, len: b - a }).then(function (d) { if (!d) throw new Error('unreadable'); return d.buffer; });
            }
          };
        }
      };
    });
    return { views: views, close: r.close };
  });
}

// page-side CRC-32, used when a worker cannot read the file
var CRC_TAB = null;
async function crcHere(blob, start, end, onProgress) {
  if (!CRC_TAB) {
    CRC_TAB = new Int32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TAB[n] = c; }
  }
  var crc = -1, step = 4 << 20, T = CRC_TAB;
  end = end != null ? end : blob.size;
  for (var pos = start || 0; pos < end; pos += step) {
    var b = new Uint8Array(await blob.slice(pos, Math.min(end, pos + step)).arrayBuffer());
    for (var i = 0, l = b.length; i < l; i++) crc = T[(crc ^ b[i]) & 255] ^ (crc >>> 8);
    onProgress && onProgress((pos - (start || 0)) / (end - (start || 0)));
    await sleep(0);
  }
  crc = (crc ^ -1) >>> 0;
  return ('00000000' + crc.toString(16).toUpperCase()).slice(-8);
}
// how: 'ciso', the checksum of the ISO inside a CSO/ZSO image, or 'ecm', of the image inside an ECM
// file, which only a worker can unpack
function crcOf(blob, start, end, onProgress, how) {
  var w = DEBUG.stage && !how ? Promise.reject(new Error('debug')) : crcWorker(blob, start, end, onProgress, how);
  var p = how ? w : w.catch(function () { return crcHere(blob, start, end, onProgress); });
  // DEBUG.crcDelay (ms): a slow checksum, for testing that conversions don't wait for it
  return DEBUG.crcDelay ? p.then(function (c) { return sleep(DEBUG.crcDelay).then(function () { return c; }); }) : p;
}
function crcWorker(blob, start, end, onProgress, how) {
  return Engine.ready().then(function () {
    return new Promise(function (resolve, reject) {
      var w = new Worker(Engine.url);
      w.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'crc-progress') onProgress && onProgress(m.done / m.total);
        else if (m.type === 'crc') { w.terminate(); resolve(m.crc); }
        else if (m.type === 'fatal') { w.terminate(); reject(new Error(m.message)); }
      };
      w.onerror = function (e) { w.terminate(); reject(new Error(e.message || 'worker error')); };
      Engine.post(w, { type: 'crc', blob: blob, start: start || 0, end: end, ciso: how === 'ciso', ecm: how === 'ecm' }); // with the compiled module, for zlib's crc32
    });
  });
}

/* ---------- ISO 9660 helpers ---------- */
async function isoDir(rd, lba, size) {
  var out = new Map(), n = Math.min(Math.ceil(size / 2048), 64);
  for (var s = 0; s < n; s++) {
    var b = await rd.read(lba + s);
    if (!b) break;
    var off = 0;
    while (off < 2048) {
      var len = b[off];
      if (!len) break;
      var nlen = b[off + 32];
      var name = asc(b, off + 33, nlen).replace(/;\d+$/, '').replace(/\.$/, '').toUpperCase();
      if (nlen > 1 || (b[off + 33] > 1)) out.set(name, { lba: u32le(b, off + 2), size: u32le(b, off + 10), dir: !!(b[off + 25] & 2) });
      off += len;
    }
  }
  return out;
}
async function isoFile(rd, ent, max) {
  var n = Math.min(ent.size, max || 65536), parts = [];
  for (var s = 0; s * 2048 < n; s++) {
    var b = await rd.read(ent.lba + s);
    if (!b) break;
    parts.push(b.slice(0, Math.min(2048, n - s * 2048)));
  }
  var out = new Uint8Array(parts.reduce(function (a, p) { return a + p.length; }, 0)), o = 0;
  parts.forEach(function (p) { out.set(p, o); o += p.length; });
  return out;
}
function parseSfo(b) {
  var res = {};
  if (asc(b, 0, 4) !== '\0PSF') return res;
  var keyT = u32le(b, 8), dataT = u32le(b, 12), cnt = u32le(b, 16);
  for (var i = 0; i < cnt && i < 64; i++) {
    var e = 20 + i * 16, ko = b[e] | (b[e + 1] << 8), len = u32le(b, e + 4), dof = u32le(b, e + 12);
    var k = '';
    for (var p = keyT + ko; b[p]; p++) k += String.fromCharCode(b[p]);
    res[k] = new TextDecoder().decode(b.subarray(dataT + dof, dataT + dof + len)).replace(/\0+$/, '');
  }
  return res;
}
function psSerial(path) {
  var n = path.replace(/^.*[\\\/:]/, '').replace(/;.*$/, '').toUpperCase();
  var m = /^([A-Z]{4})[_-]?(\d{3})\.?(\d{2})/.exec(n);
  return m ? m[1] + '-' + m[2] + m[3] : '';
}

/* ---------- console detection from the first sectors of a data track ---------- */
async function detectTrack(rd) {
  var s0 = await rd.read(0);
  if (!s0) return null;
  var h = asc(s0, 0, 16);
  if (h === 'SEGA SEGASATURN ') return { sys: 'saturn', serial: clean(asc(s0, 0x20, 10)), title: clean(asc(s0, 0x60, 112)) };
  if (h === 'SEGA SEGAKATANA ') {
    var hw = clean(asc(s0, 0x30, 16));
    return { sys: /NAOMI/i.test(clean(asc(s0, 0x10, 16)) + hw) ? 'naomi' : 'dc', serial: clean(asc(s0, 0x40, 10)), title: clean(asc(s0, 0x80, 128)) };
  }
  if (/^SEGADISCSYSTEM|^SEGABOOTDISC|^SEGA-CD|^SEGA_CD/.test(h)) {
    var m = /^\s*(?:GM|AI|OS|BR)?\s*([A-Z0-9][A-Z0-9-]*)/.exec(asc(s0, 0x180, 14));
    return { sys: 'segacd', serial: m ? m[1] : '', title: clean(asc(s0, 0x150, 48)) || clean(asc(s0, 0x120, 48)) };
  }
  if (s0[0] === 1 && asc(s0, 1, 5) === 'ZZZZZ' && s0[6] === 1) return { sys: '3do', title: clean(asc(s0, 0x28, 32)) };
  if (u32be(s0, 0x1C) === 0xC2339F3D) return { sys: 'gc', serial: clean(asc(s0, 0, 6)), title: clean(asc(s0, 0x20, 64)) };
  if (u32be(s0, 0x18) === 0x5D1C9EA3) return { sys: 'wii', serial: clean(asc(s0, 0, 6)), title: clean(asc(s0, 0x20, 64)) };

  var pvd = await rd.read(16);
  if (pvd && asc(pvd, 1, 5) === 'CD-I ') return { sys: 'cdi', title: clean(asc(pvd, 40, 32)) };
  if (pvd && asc(pvd, 1, 5) === 'CD001') {
    var sysId = clean(asc(pvd, 8, 32)), volId = clean(asc(pvd, 40, 32));
    var files = new Map();
    try { files = await isoDir(rd, u32le(pvd, 158), u32le(pvd, 166)); } catch (e) { /* ignore */ }
    if (files.has('UMD_DATA.BIN') || /^PSP GAME/.test(sysId)) {
      var r = { sys: 'psp', title: volId };
      try {
        if (files.has('UMD_DATA.BIN')) r.serial = new TextDecoder().decode(await isoFile(rd, files.get('UMD_DATA.BIN'), 64)).split('|')[0].trim();
        var pg = files.get('PSP_GAME');
        if (pg) {
          var sub = await isoDir(rd, pg.lba, pg.size);
          if (sub.has('PARAM.SFO')) {
            var sfo = parseSfo(await isoFile(rd, sub.get('PARAM.SFO'), 8192));
            if (sfo.TITLE) r.title = sfo.TITLE;
            if (sfo.DISC_ID && !r.serial) r.serial = sfo.DISC_ID.slice(0, 4) + '-' + sfo.DISC_ID.slice(4);
          }
        }
      } catch (e) { /* ignore */ }
      return r;
    }
    if (files.has('SYSTEM.CNF')) {
      var cnf = new TextDecoder().decode(await isoFile(rd, files.get('SYSTEM.CNF'), 2048));
      var b2 = /BOOT2\s*=\s*([^\r\n]+)/i.exec(cnf), b1 = /BOOT\s*=\s*([^\r\n]+)/i.exec(cnf);
      if (b2) return { sys: 'ps2', serial: psSerial(b2[1].trim()), title: volId };
      if (b1) return { sys: 'ps1', serial: psSerial(b1[1].trim()), title: volId };
    }
    var exe = null;
    files.forEach(function (v, k) { if (!exe && /^[A-Z]{4}_\d{3}\.\d{2}$/.test(k)) exe = k; });
    if (/PLAYSTATION/i.test(sysId)) return { sys: 'ps1', serial: exe ? psSerial(exe) : '', title: volId };
    if (files.has('IPL.TXT')) return { sys: 'ngcd', title: volId };
    if (/CDTV/i.test(sysId)) return { sys: 'cdtv', title: volId };
    if (files.has('CD32.TM') || /CD32/i.test(sysId)) return { sys: 'cd32', title: volId };
    return { sys: 'pc', title: volId, weak: true };
  }
  // PC Engine / PC-FX boot sectors
  for (var l = 0; l < 16; l++) {
    var b = l === 0 ? s0 : l === 16 ? pvd : await rd.read(l);
    if (!b) break;
    if (asc(b, 0x20, 23) === 'PC Engine CD-ROM SYSTEM') return { sys: 'pcecd' };
    if (asc(b, 0, 15) === 'PC-FX:Hu_CD-ROM') return { sys: 'pcfx' };
  }
  return null;
}

/* ---------- describing what to look at for each job ---------- */
function msfFrames(s) {
  var m = /(\d+):(\d+):(\d+)/.exec(s || '');
  return m ? (+m[1] * 60 + +m[2]) * 75 + +m[3] : 0;
}
// data tracks + hashable files of a "create" job; images: the stand-ins for its ECM files (ecmImages)
function probePlan(job, images) {
  var readers = [], hashes = [];
  var fileOf = function (f) { return f && (f.ecm ? images && images.get(f) : f.file); };
  var byName = function (n) {
    var lc = base(n).toLowerCase();
    return fileOf(job.files.find(function (x) { return x.name.toLowerCase() === lc || (x.ref && base(x.ref).toLowerCase() === lc); }));
  };
  if (job.src === 'cue' && job.descText) {
    var cur = null, curMode = null, fileTracks = [];
    job.descText.split(/\r?\n/).forEach(function (ln) {
      var m;
      if ((m = /^\s*FILE\s+(?:"([^"]*)"|(\S+))/i.exec(ln))) { cur = byName(m[1] != null ? m[1] : m[2]); fileTracks.push({ file: cur, tracks: [] }); }
      else if ((m = /^\s*TRACK\s+(\d+)\s+(\S+)/i.exec(ln))) { curMode = m[2].toUpperCase(); fileTracks.length && fileTracks[fileTracks.length - 1].tracks.push({ no: +m[1], mode: curMode, index: 0 }); }
      else if ((m = /^\s*INDEX\s+01\s+(\S+)/i.exec(ln))) { var ft = fileTracks[fileTracks.length - 1]; if (ft && ft.tracks.length) ft.tracks[ft.tracks.length - 1].index = msfFrames(m[1]); }
    });
    fileTracks.forEach(function (ft) {
      if (!ft.file) return;
      hashes.push({ file: ft.file, track: ft.tracks.length === 1 ? ft.tracks[0].no : 0 });
      ft.tracks.forEach(function (t) {
        if (t.mode === 'AUDIO') return;
        var ss = /2048/.test(t.mode) ? 2048 : /2336/.test(t.mode) ? 2336 : 2352;
        readers.push(fileReader(ft.file, t.index * ss, ss));
      });
    });
  } else if (job.src === 'gdi' && job.descText) {
    job.descText.split(/\r?\n/).slice(1).forEach(function (ln) {
      var t = tokenize(ln);
      if (t.length < 5) return;
      var f = byName(t[4]);
      if (!f) return;
      hashes.push({ file: f, track: +t[0] });
      if (t[2] === '4') readers.push(fileReader(f, 0, +t[3] || 2352));
    });
    readers.reverse(); // the high-density data track carries the IP.BIN header
  } else if (job.src === 'cso') {
    // a compressed ISO: identifyJob reads it through a worker; the checksum is the ISO's
    hashes.push({ file: job.files[0].file, track: 0, size: job.isoSize, ciso: true });
  } else if (job.files.length === 1) {
    var f1 = fileOf(job.files[0]), x = ext(job.files[0].name);
    if (!f1) return { readers: readers, hashes: hashes };
    hashes.push({ file: f1, track: 0 });
    if (job.autoCue) readers.push(fileReader(f1, 0, /2048/.test(job.autoCue) ? 2048 : 2352));
    else if (x === 'iso' || x === 'cdr' || x === 'toast' || x === 'bin' || x === 'img') readers.push(fileReader(f1, 0, job.disc === 'cd' && job.syncMode ? 2352 : 2048));
  } else {
    job.files.forEach(function (f) { if (fileOf(f)) hashes.push({ file: fileOf(f), track: 0 }); });
  }
  return { readers: readers, hashes: hashes };
}

/* ---------- the identification itself ---------- */
// onProvisional(result), if given, receives what is known before the slow checksum step
// (console, serial, sizes), so a conversion can start while the checksum confirms the release
async function identifyJob(job, onStatus, onProvisional) {
  await GameDB.ready();
  var det = null, sizes = [], dataSizes = [], exact = null, cands = [];
  var chd = null, ecm = null;
  try {
    if (job.kind === 'chd') {
      chd = await chdReader(job.files[0].file);
      if (chd.kind === 1) {
        // as for .gdi files, a GD-ROM's IP.BIN header is on the high-density data track, the last one;
        // the low-density track 1 holds a plain ISO 9660 volume that alone would pass for a PC disc
        var order = chd.tracks.map(function (tr, i) { return i; });
        if (chd.tracks.length && chd.tracks[0].gdrom) order.reverse();
        for (var j = 0; j < order.length && (!det || det.weak); j++) {
          var t = order[j];
          if (chd.tracks[t].type === 7) continue;
          var dt = await detectTrack({ read: (function (tt) { return function (lba) { return chd.read(tt, lba); }; })(t) });
          if (dt && (!det || !dt.weak)) det = dt;
        }
        chd.tracks.forEach(function (tr) { sizes.push(tr.frames * 2352); if (tr.type !== 7) dataSizes.push(tr.frames * 2352); });
      } else if (chd.kind === 2) {
        det = await detectTrack({ read: function (lba) { return chd.read(0, lba); } });
        sizes.push(chd.logical);
        dataSizes.push(chd.logical);
      }
    } else {
      // ECM images: a worker rebuilds the images they hold
      var ecms = job.files.filter(function (f) { return f.ecm; }), images = null;
      if (ecms.length) {
        onStatus && onStatus('Reading the ECM image' + (ecms.length > 1 ? 's' : '') + '\u2026', 0);
        var ei = await ecmImages(ecms.map(function (f) { return f.file; }));
        ecm = ei;
        images = new Map();
        ecms.forEach(function (f, i) { if (ei.views[i]) images.set(f, ei.views[i]); });
      }
      var plan = probePlan(job, images);
      if (job.src === 'cso') {
        chd = await chdReader(job.files[0].file, true);
        plan.readers.push({ read: function (lba) { return chd.read(0, lba); } });
      }
      for (var i = 0; i < plan.readers.length && (!det || det.weak); i++) {
        var d = await detectTrack(plan.readers[i]);
        if (d && (!det || !d.weak)) det = d;
      }
      if (chd) { chd.close(); chd = null; }
      if (ecm) { ecm.close(); ecm = null; }
      // exact match: size + CRC-32 of a data file against the Redump database
      var toHash = [];
      plan.hashes.forEach(function (hsh) {
        var size = hsh.size != null ? hsh.size : hsh.file.size;
        sizes.push(size);
        var bySize = GameDB.size(size);
        if (det && !det.weak) {
          var same = bySize.filter(function (e) { return e.sys === det.sys; });
          if (same.length) bySize = same;
        }
        // the checksum of what a CSO/ZSO or ECM file holds: a worker unpacks it again
        if (bySize.length) toHash.push({ file: hsh.file.ecm || hsh.file, size: size, how: hsh.ciso ? 'ciso' : hsh.file.ecm ? 'ecm' : '', bySize: bySize });
      });
      if (toHash.length && onProvisional) onProvisional(result(null, true));
      for (var k = 0; k < toHash.length && !exact; k++) {
        var th = toHash[k];
        onStatus && onStatus('Checking against the game database…', 0);
        var crc = null;
        try { crc = await crcOf(th.file, 0, th.size, function (p) { onStatus && onStatus('Checking against the game database…', p); }, th.how); }
        catch (e) { if (!th.how) throw e; } // a damaged compressed ISO or ECM image: no exact match (converting it reports the damage)
        var hits = th.bySize.filter(function (e) { return e.crc === crc; });
        if (hits.length) exact = hits;
      }
    }
  } finally {
    if (chd) chd.close();
    if (ecm) ecm.close();
  }
  return result(exact, false);

  function result(exact, checking) {
    var entry = null, method = '';
    if (exact) {
      entry = exact[0];
      if (det && det.serial && exact.length > 1) entry = exact.find(function (e) { return normSerial(e.serial) === normSerial(det.serial); }) || entry;
      method = 'hash';
    } else if (det && det.serial) {
      cands = GameDB.serial(det.serial, det.sys);
      if (!cands.length) cands = GameDB.serial(det.serial);
      var bySz = cands.filter(function (e) { return sizes.indexOf(e.size) >= 0; });
      var pick = bySz.length ? bySz : cands;
      if (pick.length) {
        var names = pick.map(function (e) { return e.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
        entry = pick[0];
        method = names.length > 1 ? 'serial-ambiguous' : bySz.length ? 'serial+size' : 'serial';
        if (names.length > 1) entry = Object.assign({}, pick[0], { alternatives: names });
      }
    } else if (job.kind === 'chd' && det && !det.weak && dataSizes.length) {
      // CHD of a recognized console's disc without a readable serial: a unique size match of a data
      // track is still a strong hint. Not without the console: among 40,000 discs, an audio track or a
      // PC disc often has the size of some game's (a music CD was named after one)
      var pool = [];
      dataSizes.forEach(function (s) { GameDB.size(s).forEach(function (e) { if (e.sys === det.sys) pool.push(e); }); });
      var uniq = pool.map(function (e) { return e.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
      if (uniq.length === 1) { entry = pool[0]; method = 'size'; }
    }
    var sys = entry ? entry.sys : det ? det.sys : null;
    return {
      sys: sys, detected: det, entry: entry, method: method,
      name: entry ? entry.name : '', serial: (det && det.serial) || (entry && entry.serial) || '',
      headerTitle: det && det.title || '', checking: checking
    };
  }
}
