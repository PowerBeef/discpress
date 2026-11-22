/* ============================================================
   game identification: console detection + Redump database
   ============================================================ */
var SYSTEMS = {
  ps1: ['PS1', 'Sony PlayStation'], ps2: ['PS2', 'Sony PlayStation 2'], psp: ['PSP', 'Sony PlayStation Portable'],
  saturn: ['SAT', 'Sega Saturn'], segacd: ['SCD', 'Sega CD / Mega-CD'], dc: ['DC', 'Sega Dreamcast'],
  pcecd: ['PCE', 'PC Engine CD / TurboGrafx-CD'], pcfx: ['PC-FX', 'NEC PC-FX'], ngcd: ['NGCD', 'Neo Geo CD'],
  '3do': ['3DO', '3DO Interactive Multiplayer'], cdi: ['CD-i', 'Philips CD-i'], cd32: ['CD32', 'Amiga CD32'],
  cdtv: ['CDTV', 'Commodore CDTV'], amigacd: ['AMCD', 'Commodore Amiga CD'], jagcd: ['JAG', 'Atari Jaguar CD'],
  naomi: ['NAOMI', 'Sega NAOMI (GD-ROM)'], naomi2: ['NAOMI2', 'Sega NAOMI 2 (GD-ROM)'],
  triforce: ['TRI', 'Triforce (GD-ROM)'], chihiro: ['CHIH', 'Sega Chihiro (GD-ROM)'],
  ks573: ['S573', 'Konami System 573'], ns246: ['S246', 'Namco System 246 / 256'],
  pc98: ['PC-98', 'NEC PC-98'], fmtowns: ['FM-T', 'Fujitsu FM Towns'], x68k: ['X68K', 'Sharp X68000'],
  pippin: ['PIP', 'Bandai Pippin'], playdia: ['PLD', 'Bandai Playdia'], nuon: ['NUON', 'VM Labs Nuon'],
  gc: ['GC', 'Nintendo GameCube'], wii: ['Wii', 'Nintendo Wii'],
  xbox: ['XBOX', 'Microsoft Xbox'], xbox360: ['X360', 'Microsoft Xbox 360'], ps3: ['PS3', 'Sony PlayStation 3'],
  vcd: ['VCD', 'Video CD'], video: ['VIDEO', 'Video disc (DVD-Video, Blu-ray, Photo CD)'],
  pc: ['DATA', 'Data disc (PC or unknown system)']
};
var SYS_COLORS = {
  ps1: ['#c8c8d4', '#1c1733'], ps2: ['#2f5bd3', '#ffffff'], psp: ['#26262e', '#ffffff'], saturn: ['#4a4f63', '#ffffff'],
  segacd: ['#1f4ea8', '#ffffff'], dc: ['#ff7a1a', '#1c1733'], pcecd: ['#f1ead6', '#1c1733'], pcfx: ['#3a3a44', '#ffffff'],
  ngcd: ['#d9b23a', '#1c1733'], '3do': ['#b01e2f', '#ffffff'], cdi: ['#1c6fb8', '#ffffff'], cd32: ['#e11d48', '#ffffff'],
  cdtv: ['#33333d', '#ffffff'], amigacd: ['#c4264f', '#ffffff'], jagcd: ['#d62828', '#ffffff'],
  naomi: ['#6a4fb8', '#ffffff'], naomi2: ['#6a4fb8', '#ffffff'], triforce: ['#6a4fb8', '#ffffff'], chihiro: ['#6a4fb8', '#ffffff'],
  ks573: ['#b01e2f', '#ffffff'], ns246: ['#2f5bd3', '#ffffff'],
  pc98: ['#5b6b7a', '#ffffff'], fmtowns: ['#4e5d6c', '#ffffff'], x68k: ['#384552', '#ffffff'],
  pippin: ['#5f4b8b', '#ffffff'], playdia: ['#d97706', '#ffffff'], nuon: ['#0e7490', '#ffffff'],
  gc: ['#6a4fb8', '#ffffff'], wii: ['#dfe6ea', '#1c1733'], xbox: ['#107c10', '#ffffff'], xbox360: ['#107c10', '#ffffff'],
  ps3: ['#26262e', '#ffffff']
};
function sysColor(s) { return SYS_COLORS[s] || null; }
function sysShort(s) { return SYSTEMS[s] ? SYSTEMS[s][0] : ''; }
function sysName(s) { return SYSTEMS[s] ? SYSTEMS[s][1] : ''; }
function normSerial(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
// a serial's key in the database. Sega's first-party discs say MK-51064 (Dreamcast), MK-81064 (Saturn)
// or MK-4432 (Sega CD) where Redump lists the US release as 51064 and the others as MK-51064-50: one key
var SEGA_SYS = /^(saturn|segacd|dc|naomi2?|triforce|chihiro)$/;
function canonKey(sys, s) {
  var k = normSerial(s);
  return SEGA_SYS.test(sys) && /^MK\d/.test(k) ? k.slice(2) : k;
}
function sameSerial(sys, a, b) { var k = canonKey(sys, a); return !!k && k === canonKey(sys, b); }
// whether a database release is listed under this serial (one of its serials)
function hasSerial(e, s) { return (e.serials || [e.serial]).some(function (x) { return sameSerial(e.sys, x, s); }); }
// the keys to look a disc's serial up under: its own; without a version suffix the disc carries and
// Redump leaves out (Sega CD's T-93175-00); for PlayStation discs, the boot file's name as it is
// (LSP_200.110, DTL_S30.30: serials of other shapes than SLUS-00594)
function serialCandidates(det) {
  var out = [];
  var add = function (s, how) { if (s && !out.some(function (c) { return canonKey(det.sys, c.serial) === canonKey(det.sys, s); })) out.push({ serial: s, how: how }); };
  add(det.serial, 'serial');
  var m = /^(.+?)[-\s]+\d{1,2}$/.exec(det.serial || '');
  if (m && /\d/.test(m[1])) add(m[1], 'trim');
  if (det.boot) add(det.boot, 'boot');
  return out;
}

// a release's disc number from its name ("(Disc 2)", "(Disc B)"), or null; a set may start at 0
// (Enemy Zero's "(Disc 0) (Opening Disc)")
function discNo(name) {
  var m = /\((?:Disc|Disk) (\d+|[A-Z])\)/.exec(name || '');
  return !m ? null : /\d/.test(m[1]) ? +m[1] : m[1].charCodeAt(0) - 64;
}
// the area symbols (Sega's) of the regions a release's name gives in its first parentheses
var REGION_AREA = [
  [/^(Japan)$/, 'J'], [/^(USA|Canada)$/, 'U'], [/^(Brazil)$/, 'BU'], [/^(Korea)$/, 'KJ'], [/^(Asia)$/, 'TAJ'],
  [/^(Taiwan|Hong Kong|China)$/, 'TJ'], [/^(Latin America|Mexico|Argentina)$/, 'LU'], [/^(World)$/, 'JTUBKAEL'],
  [/^(Europe|Germany|France|Italy|Spain|UK|Netherlands|Sweden|Scandinavia|Australia|New Zealand|Portugal|Russia|Greece|Poland|Denmark|Norway|Finland|Belgium|Austria|Switzerland|Ireland)$/, 'E']
];
// 1 if the release may be the disc of these area symbols (or its name gives no region), else 0
function regionFits(name, area) {
  var re = /\(([^)]*)\)/g, m, letters = '';
  while ((m = re.exec(name || ''))) {
    m[1].split(/,\s*/).forEach(function (w) { REGION_AREA.forEach(function (r) { if (r[0].test(w)) letters += r[1]; }); });
  }
  if (!letters) return 1;
  for (var i = 0; i < letters.length; i++) if (area.indexOf(letters[i]) >= 0) return 1;
  return 0;
}
// whether the title in a disc's header may be this release's name: they share a word, and their
// numbers are the same ("DORIMAGA GD VOL.10" isn't Dorimaga GD Vol. 1, "DOOM" isn't Hexen). True when
// the header has no title in letters
var TITLE_STOP = /^(THE|AND|VOL|DISC|DISK|EDITION)$/, ROMAN = { II: '2', III: '3', IV: '4', VI: '6', VII: '7', VIII: '8', IX: '9' };
function titleWords(s) {
  return (s || '').toUpperCase().replace(/\([^)]*\)/g, ' ').replace(/'/g, '').replace(/([A-Z])(\d)/g, '$1 $2').replace(/(\d)([A-Z])/g, '$1 $2')
    .split(/[^A-Z0-9]+/).filter(function (w) { return w && !TITLE_STOP.test(w); })
    .map(function (w) { return ROMAN[w] || w.replace(/^0+(?=\d)/, ''); });
}
function titleFits(title, name) {
  var t = titleWords(title), n = titleWords(name);
  var alpha = t.filter(function (w) { return w.length > 1 && /[A-Z]/.test(w); });
  var num = function (a) { return a.filter(function (w) { return /^\d+$/.test(w); }); };
  if (!alpha.length) return true;
  return alpha.some(function (w) { return n.indexOf(w) >= 0; }) &&
    num(t).every(function (w) { return n.indexOf(w) >= 0; }) && num(n).every(function (w) { return t.indexOf(w) >= 0; });
}

// facts about particular games (db/facts/*.tsv, checked and embedded by scripts/assemble.py):
// {fact: {sys: [serial keys]}}
var GAME_FACTS = /*GAMEFACTS*/{};
function serialKeys(sys, serial) {
  var out = [];
  var push = function (s) { var k = canonKey(sys, s); if (k && out.indexOf(k) < 0) out.push(k); };
  if (!serial) return out;
  push(serial);
  var parts = serial.split(/[-\s]+/);
  if (parts.length > 2) push(parts[0] + parts[1]);
  if (serial.indexOf('/') > 0) push(serial.split('/')[0]);
  var sg = SEGA_SYS.test(sys) && /^(.+)[-\s]\d{1,2}$/.exec(serial);
  if (sg) push(sg[1]);
  var sn = /^([A-Z]{4}\d{5})[A-Z0-9]+$/.exec(normSerial(serial));
  if (sn) push(sn[1]);
  return out;
}
var GameFacts = {
  // the facts known of a disc of this system and these serials (the disc's and its release's)
  of: function (sys, serials) {
    var out = {}, keys = [];
    serials.forEach(function (s) { serialKeys(sys, s).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    Object.keys(GAME_FACTS).forEach(function (fact) {
      var list = (GAME_FACTS[fact] || {})[sys];
      if (list && keys.some(function (k) { return list.indexOf(k) >= 0; })) out[fact] = true;
    });
    return out;
  }
};

// non-commutative 32-bit digest over ordered track (size, crc32) pairs (matches db/mkdb.py disc_digest)
function discDigest(tracks) {
  var h = (0x811C9DC5 ^ tracks.length) >>> 0;
  for (var i = 0; i < tracks.length; i++) {
    var sz = tracks[i].size, lo = sz >>> 0, hi = Math.floor(sz / 4294967296) >>> 0;
    var c = (typeof tracks[i].crc === 'number' ? tracks[i].crc : parseInt(tracks[i].crc, 16)) >>> 0;
    h = Math.imul(h ^ lo, 0x01000193) >>> 0;
    h = Math.imul(h ^ hi, 0x01000193) >>> 0;
    h = Math.imul(h ^ c, 0x01000193) >>> 0;
    h = Math.imul((h >>> 16) ^ h, 0x85EBCA6B) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0xC2B2AE35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

var GameDB = {
  // bySerial: exact serials; bySerialBase: serials with a suffix (T-8113H-50) under their base (T-8113H).
  // Keys are 'sys:' + canonKey
  loading: null, version: '', bySerial: new Map(), bySerialBase: new Map(), bySize: new Map(), count: 0, systems: [],
  ready: function () {
    if (!this.loading) this.loading = this._load();
    return this.loading;
  },
  _addRow: function (sys, e) {
    var self = this;
    if (self.systems.indexOf(sys) < 0) self.systems.push(sys);
    self.count++;
    var key = function (s) { var k = canonKey(sys, s); return k ? sys + ':' + k : ''; };
    var add = function (map, k) {
      if (!k) return;
      var l = map.get(k);
      if (!l) map.set(k, l = []);
      if (l.indexOf(e) < 0) l.push(e);
    };
    e.serials.forEach(function (serial) {
      add(self.bySerial, key(serial));
      // (empty parts aside: SLES--51117 has no base serial SLES)
      var parts = serial.split(/[-\s]+/);
      if (parts.length > 2) add(self.bySerialBase, key(parts[0] + parts[1]));
      // Redump's release suffixes (SCES-53449/ANZ, UCES-00786/E): the disc itself says SCES-53449
      if (serial.indexOf('/') > 0) add(self.bySerialBase, key(serial.split('/')[0]));
      // Sega's region and disc suffixes on two-part serials (4432-50, MK81064-50)
      var sg = SEGA_SYS.test(sys) && /^(.+)[-\s]\d{1,2}$/.exec(serial);
      if (sg) add(self.bySerialBase, key(sg[1]));
      // Sony serials with letters or a digit after the number (SLUS-01272GH, SLES-017482): the disc says SLUS-01272
      var sn = /^([A-Z]{4}\d{5})[A-Z0-9]+$/.exec(normSerial(serial));
      if (sn) add(self.bySerialBase, key(sn[1]));
    });
    var s = self.bySize.get(e.size);
    if (!s) self.bySize.set(e.size, s = []);
    s.push(e);
  },
  _addTsvLines: function (sys, lines) {
    var self = this;
    lines.forEach(function (line) {
      if (!line) return;
      var f = line.split('\t');
      var ss = f[1] ? f[1].split('|') : [];
      var ntrk = f[6] ? +f[6] : 0;
      var dig = f[7] ? (parseInt(f[7], 16) >>> 0) : 0;
      self._addRow(sys, { sys: sys, name: f[0], serial: ss[0] || '', serials: ss, size: +f[2], crc: f[3],
        track: f[4] ? +f[4] : 0, ext: f[5] || '', ntrk: ntrk, digest: dig });
    });
  },
  _load: async function () {
    var node = document.getElementById('gamedb');
    var bytes = await gunzip(b64bytes(node.textContent), +node.getAttribute('data-size'));
    node.textContent = '';
    var self = this;
    if (bytes.length >= 9 && bytes[0] === 68 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 66 && bytes[4] === 2) {
      // DPDB\x02 columnar binary format (scripts/assemble.py)
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var jlen = dv.getUint32(5, true);
      var meta = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + jlen)));
      this.version = meta.v;
      var crcOfs = 9 + jlen, tot = 0;
      meta.s.forEach(function (sd) { tot += sd[1]; });
      var digOfs = crcOfs + tot * 4;
      meta.s.forEach(function (sd) {
        var sys = sd[0], cnt = sd[1], extEnc = sd[2];
        var names = sd[3] ? sd[3].split('\n') : [], sers = sd[4] ? sd[4].split('\n') : [];
        var szs = sd[5] ? sd[5].split(',') : [], trks = sd[6] ? sd[6].split(',') : [], ntrks = sd[7] ? sd[7].split(',') : [];
        var extArr = extEnc.charAt(0) === '\t' ? extEnc.slice(1).split('\t') : null;
        var extBits = extEnc.charAt(0) === ':' ? extEnc : '';
        var prev = '';
        for (var i = 0; i < cnt; i++) {
          var nl = names[i] || '', tab = nl.indexOf('\t');
          var p = tab > 0 ? parseInt(nl.slice(0, tab), 16) : 0;
          var nm = prev.slice(0, p) + (tab >= 0 ? nl.slice(tab + 1) : nl);
          prev = nm;
          var ex = extBits ? (extBits.charAt(i + 1) === 'b' ? 'bin' : 'iso') : extArr ? extArr[i] : extEnc;
          var sv = szs[i] || '0';
          var sz = sv.charAt(0) === '-' ? +sv.slice(1) : (+sv) * (ex === 'bin' ? 2352 : 2048);
          var crc = ('00000000' + dv.getUint32(crcOfs, true).toString(16)).slice(-8).toUpperCase();
          crcOfs += 4;
          var ntrk = ntrks[i] ? +ntrks[i] : 0;
          var dig = 0;
          if (ntrk >= 2) { dig = dv.getUint32(digOfs, true) >>> 0; digOfs += 4; }
          var ss = sers[i] ? sers[i].split('|') : [];
          self._addRow(sys, { sys: sys, name: nm, serial: ss[0] || '', serials: ss, size: sz, crc: crc,
            track: trks[i] ? +trks[i] : 0, ext: ex, ntrk: ntrk, digest: dig });
        }
      });
    } else {
      var data = JSON.parse(new TextDecoder().decode(bytes));
      this.version = data.version;
      Object.keys(data.systems).forEach(function (sys) { self._addTsvLines(sys, data.systems[sys].split('\n')); });
    }
    var tb = document.getElementById('testdb');
    if (tb && tb.textContent) {
      var extra = JSON.parse(tb.textContent);
      tb.textContent = '';
      Object.keys(extra).forEach(function (sys) { self._addTsvLines(sys, extra[sys]); });
    }
    return this;
  },
  // the releases listed under this serial (base: those under it as a base serial), on one system, or
  // on any system when sys isn't given
  lookup: function (serial, sys, base) {
    var map = base ? this.bySerialBase : this.bySerial;
    var one = function (s) { var k = canonKey(s, serial); return k && map.get(s + ':' + k) || []; };
    if (sys) return one(sys);
    var out = [];
    this.systems.forEach(function (s) { out = out.concat(one(s)); });
    return out;
  },
  // releases with this serial; regional variants (same base, extra suffix) only when none match exactly
  serial: function (serial, sys) {
    var exact = this.lookup(serial, sys, false);
    return exact.length ? exact : this.lookup(serial, sys, true);
  },
  size: function (n) { return this.bySize.get(n) || []; },
  // how many discs a game's set has: the disc numbers of the names that read as this one up to its
  // "(Disc N)" ("(Disc 3) (Special CD-ROM)" and "(Disc 1) (Rev 1)" count too; 0 when the database lists none)
  discCount: function (sys, name) {
    var key = function (n) { return n.replace(/ \((?:Disc|Disk) (?:\d+|[A-Z])\).*$/, ''); }, nos = new Set(), self = this;
    if (!this.byName) {
      this.byName = new Map();
      this.bySize.forEach(function (l) {
        l.forEach(function (e) { var k = e.sys + '|' + key(e.name), a = self.byName.get(k); if (!a) self.byName.set(k, a = []); if (a.indexOf(e.name) < 0) a.push(e.name); });
      });
    }
    (this.byName.get(sys + '|' + key(name)) || []).forEach(function (n) { var d = discNo(n); if (d != null) nos.add(d); });
    return nos.size;
  }
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
// (stride: bytes from one sector to the next, when subchannel data follows each)
function fileReader(file, start, sectorSize, stride) {
  stride = stride || sectorSize;
  return {
    read: async function (lba) {
      var off = start + lba * stride;
      if (off + sectorSize > file.size) return null;
      var b = new Uint8Array(await file.slice(off, off + sectorSize).arrayBuffer());
      if (sectorSize === 2048) return b;
      if (sectorSize === 2324) return b.subarray(0, 2048);
      if (sectorSize === 2336) return b.subarray(8, 2056);
      var o = b[15] === 2 ? 24 : 16;
      return b.subarray(o, o + 2048);
    }
  };
}

// a worker that opens images for reading (the reader role) as msg says; request(q) asks it for data.
// If the worker dies or stops answering (a read taking over a minute), every request waiting on it
// and every later one fails, so identification reports an error instead of waiting forever
// onScan: how far a worker scanning an ECM image got (0..1); each report restarts the timeout
function readerWorker(msg, timeout, onScan) {
  return Engine.ready().then(function () {
    return new Promise(function (resolve, reject) {
      var w = new Worker(Engine.url), seq = 0, waiting = {}, dead = null, ready = false;
      var timer = setTimeout(function () { fail(new Error('timeout')); }, timeout || 30000);
      function fail(err) {
        clearTimeout(timer);
        if (dead) return;
        dead = err;
        w.terminate();
        if (!ready) reject(err);
        Object.keys(waiting).forEach(function (id) { var q = waiting[id]; delete waiting[id]; clearTimeout(q.timer); q.reject(err); });
      }
      w.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'reader-ready') {
          clearTimeout(timer);
          ready = true;
          resolve({
            info: m,
            request: function (q) {
              return new Promise(function (res, rej) {
                if (dead) return rej(dead);
                var id = ++seq;
                waiting[id] = { resolve: res, reject: rej, timer: setTimeout(function () { fail(new Error('The reader stopped responding.')); }, 60000) };
                q.type = 'read'; q.id = id; w.postMessage(q);
              });
            },
            close: function () { fail(new Error('closed')); }
          });
        } else if (m.type === 'sector') {
          var r = waiting[m.id]; delete waiting[m.id];
          if (r) { clearTimeout(r.timer); r.resolve(m.data); }
        } else if (m.type === 'scan' && !ready) {
          clearTimeout(timer);
          timer = setTimeout(function () { fail(new Error('timeout')); }, timeout || 30000);
          if (onScan) onScan(m.done / m.total);
        } else if (m.type === 'fatal') fail(new Error(m.message));
      };
      w.onerror = function (e) { e.preventDefault && e.preventDefault(); fail(new Error(e.message || 'worker error')); };
      Engine.post(w, msg);
    });
  });
}
// opens a CHD in a worker and reads sectors from it (ciso: a CSO/ZSO compressed ISO, read like a DVD CHD)
// (parent: the parent CHD a child CHD needs)
function chdReader(file, ciso, parent) {
  return readerWorker({ type: 'reader', name: 'x.chd', blob: file, ciso: !!ciso, parent: parent || null }).then(function (r) {
    var m = r.info;
    return { kind: m.kind, tracks: m.tracks, logical: m.logical, inspect: m.inspect || null, read: function (track, lba) { return r.request({ track: track, lba: lba }); }, close: r.close };
  });
}
// opens ECM images, and PS1 PBP files' discs, in a worker (which scans each ECM file whole): for each,
// a stand-in for the image it holds that reads like a file (size, slice(a, b).arrayBuffer(), and pack:
// {file, how}, what checksums it), or null if it can't be read; and close().
// files: the job's file entries ({file, ecm} or {file, pbp})
function ecmImages(files, onScan) {
  return readerWorker({ type: 'reader', ecm: files.map(function (f) { return f.pbp ? { blob: f.file, pbp: f.pbp } : f.file; }) }, 180000, onScan).then(function (r) {
    var views = files.map(function (f, i) {
      var size = r.info.sizes[i];
      return size == null ? null : {
        size: size, pack: { file: f.file, how: f.pbp ? 'pbp@' + f.pbp.at + ':' + f.pbp.sectors : 'ecm' },
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
    if (Tuning.running) { try { await Tuning.running; } catch (e) { /* measured or not, go on */ } }
  }
  crc = (crc ^ -1) >>> 0;
  return ('00000000' + crc.toString(16).toUpperCase()).slice(-8);
}
// how: 'ciso', the checksum of the ISO inside a CSO/ZSO image, or 'ecm', of the image inside an ECM
// file, which only a worker can unpack
function crcOf(blob, start, end, onProgress, how) {
  // a checksum stopped for the device's speed test (pauseChecksums) starts over once the test is done
  var run = function () {
    // not while the speed test measures (one that starts meanwhile is stopped by pauseChecksums)
    var w = Promise.resolve(Tuning.running).catch(function () {}).then(function () {
      return DEBUG.stage && !how ? Promise.reject(new Error('debug')) : crcWorker(blob, start, end, onProgress, how);
    });
    return w.catch(function (e) {
      if (e && e.paused) return Promise.resolve(Tuning.running).catch(function () {}).then(run);
      if (e && e.aborted) throw e; // its card was removed
      if (how) throw e;
      return crcHere(blob, start, end, onProgress);
    });
  };
  var p = run();
  // DEBUG.crcDelay (ms): a slow checksum, for testing that conversions don't wait for it
  return DEBUG.crcDelay ? p.then(function (c) { return sleep(DEBUG.crcDelay).then(function () { return c; }); }) : p;
}
// the same checksum asked for twice (identification, then the DAT check) is computed once
var crcCache = new WeakMap();
function crcCached(blob, start, end, onProgress, how) {
  var m = crcCache.get(blob);
  if (!m) crcCache.set(blob, m = new Map());
  var k = (start || 0) + ':' + (end == null ? blob.size : end) + ':' + (how || '');
  if (!m.has(k)) {
    var p = crcOf(blob, start, end, onProgress, how);
    m.set(k, p);
    p.catch(function () { m.delete(k); });
  }
  return m.get(k);
}
// checksum workers running now, which the speed test stops so that it measures an idle device
var crcRunning = new Set();
function pauseChecksums() {
  crcRunning.forEach(function (c) { c.stop(); });
}
// the checksums of these files stop: their card was removed, and the next card's identification goes on
function abortChecksums(blobs) {
  crcRunning.forEach(function (c) { if (blobs.indexOf(c.blob) >= 0) c.abort(); });
}
function crcWorker(blob, start, end, onProgress, how) {
  return Engine.ready().then(function () {
    return new Promise(function (resolveRaw, rejectRaw) {
      var w = new Worker(Engine.url);
      var entry = {
        blob: blob,
        stop: function () { w.terminate(); var e = new Error('paused'); e.paused = true; reject(e); },
        abort: function () { w.terminate(); var e = new Error('stopped'); e.aborted = true; reject(e); }
      };
      var resolve = function (v) { crcRunning.delete(entry); resolveRaw(v); };
      var reject = function (e) { crcRunning.delete(entry); rejectRaw(e); };
      crcRunning.add(entry);
      var why = null; // what the worker said was wrong (a damaged compressed ISO or ECM image)
      w.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'crc-progress') onProgress && onProgress(m.done / m.total);
        else if (m.type === 'crc') { w.terminate(); resolve(m.crc); }
        else if (m.type === 'notice') { if (m.level === 'error' && !why) why = m.message; }
        else if (m.type === 'fatal') { w.terminate(); reject(new Error(why || m.message)); }
      };
      w.onerror = function (e) { w.terminate(); reject(new Error(e.message || 'worker error')); };
      var pbp = /^pbp@(\d+):(\d+)$/.exec(how || ''); // a PS1 PBP's disc: its header's offset and its sectors
      Engine.post(w, { type: 'crc', blob: blob, start: start || 0, end: end, ciso: how === 'ciso', ecm: how === 'ecm', pbp: pbp ? { at: +pbp[1], sectors: +pbp[2] } : null, debugSlow: DEBUG.crcSlow }); // with the compiled module, for zlib's crc32
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
      if (!len || len < 34 || off + len > 2048) break;
      var nlen = b[off + 32];
      if (33 + nlen > len) break;
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
  if (b.length < 20 || asc(b, 0, 4) !== '\0PSF') return res;
  var keyT = u32le(b, 8), dataT = u32le(b, 12), cnt = u32le(b, 16);
  for (var i = 0; i < cnt && i < 64; i++) {
    var e = 20 + i * 16;
    if (e + 16 > b.length) break;
    var ko = b[e] | (b[e + 1] << 8), len = u32le(b, e + 4), dof = u32le(b, e + 12);
    var k = '';
    for (var p = keyT + ko; p < b.length && b[p]; p++) k += String.fromCharCode(b[p]);
    if (!k || dataT + dof >= b.length) continue;
    res[k] = new TextDecoder().decode(b.subarray(dataT + dof, Math.min(b.length, dataT + dof + len))).replace(/\0+$/, '');
  }
  return res;
}
// a boot file's name without its folder and version (cdrom:\LSP_200.110;1 -> LSP_200.110)
function bootName(path) { return String(path).trim().replace(/^.*[\\\/:]/, '').replace(/;.*$/, '').toUpperCase(); }
function psSerial(path) {
  var n = path.replace(/^.*[\\\/:]/, '').replace(/;.*$/, '').toUpperCase();
  var m = /^([A-Z]{4})[_-]?(\d{3})\.?(\d{2})/.exec(n);
  return m ? m[1] + '-' + m[2] + m[3] : '';
}

// systems whose disc formats share headers or family boundaries in Redump
function sameSys(a, b) {
  return a === b
    || (/^naomi2?$/.test(a) && /^naomi2?$/.test(b))
    || (/^(cd32|cdtv|amigacd)$/.test(a) && /^(cd32|cdtv|amigacd)$/.test(b))
    || (/^(ps2|ns246)$/.test(a) && /^(ps2|ns246)$/.test(b))
    || (/^(ps1|ks573)$/.test(a) && /^(ps1|ks573)$/.test(b));
}

/* ---------- console detection from the first sectors of a data track ---------- */
// Xbox and Xbox 360 game partitions (XDVDFS): the volume descriptor is sector 32 of the partition,
// which starts at 0 (extracted XISO) or after the video partition: 0x18300000 (XGD1 OG Xbox),
// 0x0FD90000 (XGD2 Xbox 360), or 0x02080000 (XGD3 Xbox 360). Walking the XDVDFS root BST also
// separates extracted XISOs (DEFAULT.XBE vs DEFAULT.XEX) and extracts Title ID, title, and disc N/M.
var XDVDFS_AT = [[0, ''], [0x18300000 / 2048, 'xbox'], [0x0FD90000 / 2048, 'xbox360'], [0x02080000 / 2048, 'xbox360']];
function formatXboxTid(tid) {
  var c1 = (tid >>> 24) & 0xFF, c2 = (tid >>> 16) & 0xFF, num = tid & 0xFFFF;
  if (((c1 >= 65 && c1 <= 90) || (c1 >= 48 && c1 <= 57)) && ((c2 >= 65 && c2 <= 90) || (c2 >= 48 && c2 <= 57))) {
    return String.fromCharCode(c1, c2) + '-' + ('000' + num).slice(-3);
  }
  return ('00000000' + (tid >>> 0).toString(16)).slice(-8).toUpperCase();
}
async function detectXbox(rd) {
  for (var i = 0; i < XDVDFS_AT.length; i++) {
    var partLba = XDVDFS_AT[i][0], hintSys = XDVDFS_AT[i][1], vd = null;
    try { vd = await rd.read(partLba + 32); } catch (e) { /* past the end */ }
    if (!vd || asc(vd, 0, 20) !== 'MICROSOFT*XBOX*MEDIA' || asc(vd, 0x7EC, 20) !== 'MICROSOFT*XBOX*MEDIA') continue;
    var rootSec = u32le(vd, 0x14), rootSize = u32le(vd, 0x18);
    var res = { sys: hintSys || 'xbox', partLba: partLba };
    if (rootSec && rootSize && rootSize < (1 << 20)) {
      try {
        var nsec = Math.min(Math.ceil(rootSize / 2048), 8), dir = new Uint8Array(nsec * 2048);
        for (var s = 0; s < nsec; s++) {
          var sb = await rd.read(partLba + rootSec + s);
          if (!sb) break;
          dir.set(sb, s * 2048);
        }
        var dv = new DataView(dir.buffer), stack = [0], seenOff = new Set(), found = null;
        while (stack.length && seenOff.size < 256) {
          var off = stack.pop();
          if (seenOff.has(off) || off + 14 > Math.min(rootSize, dir.length)) continue;
          seenOff.add(off);
          var left = dv.getUint16(off, true), right = dv.getUint16(off + 2, true);
          var fsec = dv.getUint32(off + 4, true), fsize = dv.getUint32(off + 8, true), nlen = dir[off + 13];
          if (left && left !== 0xFFFF) stack.push(left * 4);
          if (right && right !== 0xFFFF) stack.push(right * 4);
          if (nlen > 0 && off + 14 + nlen <= dir.length) {
            var fn = asc(dir, off + 14, nlen).toUpperCase();
            if (fn === 'DEFAULT.XBE' || fn === 'DEFAULT.XEX') { found = { name: fn, sec: fsec, size: fsize }; break; }
          }
        }
        if (found && found.sec) {
          var hdr = await rd.read(partLba + found.sec);
          if (hdr && found.name === 'DEFAULT.XBE' && asc(hdr, 0, 4) === 'XBEH') {
            res.sys = 'xbox';
            var baseA = u32le(hdr, 0x104), certA = u32le(hdr, 0x118), certOff = certA - baseA;
            if (certOff >= 0 && certOff + 0x5C <= hdr.length) {
              var tid = u32le(hdr, certOff + 0x08);
              if (tid) res.serial = formatXboxTid(tid);
              var tbuf = hdr.subarray(certOff + 0x0C, certOff + 0x5C);
              var tstr = new TextDecoder('utf-16le').decode(tbuf).replace(/\0.*$/, '').trim();
              if (tstr) res.title = clean(tstr);
            }
          } else if (hdr && found.name === 'DEFAULT.XEX' && asc(hdr, 0, 4) === 'XEX2') {
            res.sys = 'xbox360';
            var optCnt = Math.min(u32be(hdr, 0x14), 64);
            for (var k = 0; k < optCnt && 0x18 + k * 8 + 8 <= hdr.length; k++) {
              if (u32be(hdr, 0x18 + k * 8) === 0x00040006) {
                var eoff = u32be(hdr, 0x18 + k * 8 + 4);
                if (eoff > 0 && eoff + 20 <= hdr.length) {
                  var xtid = u32be(hdr, eoff + 0x0C);
                  if (xtid) res.serial = formatXboxTid(xtid);
                  var dn = hdr[eoff + 0x12], dof = hdr[eoff + 0x13];
                  if (dof > 1 && dn >= 1 && dn <= dof) res.disc = { n: dn, of: dof };
                }
                break;
              }
            }
          }
        }
      } catch (e) { /* unreadable root dir: partition offset still identifies console */ }
    }
    return res;
  }
  return null;
}
function sonyRegion(serial) {
  var k = normSerial(serial);
  if (/^(S[LC]P[SM]|PAPX|PCPX|PBPX|PDBX|UCJM|UCJS|ULJM|ULJS|BCJS|BLJM|BLJS)/.test(k)) return 'J';
  if (/^(S[LC]US|LSP|PAPU|UCUS|ULUS|BCUS|BLUS)/.test(k)) return 'U';
  if (/^(S[LC]ES|S[LC]ED|UCES|ULES|BCES|BLES)/.test(k)) return 'E';
  if (/^(S[LC]KA|UCKS|ULKS|BCKS|BLKS)/.test(k)) return 'K';
  if (/^(S[LC]AJ|SCCS|UCAS|ULAS|BCAS|BLAS)/.test(k)) return 'A';
  return '';
}
async function detectPippin(rd, s0) {
  if (s0[0] !== 0x45 || s0[1] !== 0x52 || ((s0[2] << 8) | s0[3]) !== 512) return null;
  if (asc(s0, 0x200, 2) !== 'PM') return null;
  var mapCnt = Math.min(u32be(s0, 0x204) || 1, 12), hfsBlk = 0, isPippin = false;
  var readBlk = async function (blk) {
    var sec = await rd.read(blk >>> 2);
    return sec ? sec.subarray((blk & 3) * 512, ((blk & 3) + 1) * 512) : null;
  };
  for (var blk = 1; blk <= mapCnt; blk++) {
    var p = blk < 4 ? s0.subarray(blk * 512, (blk + 1) * 512) : await readBlk(blk);
    if (!p || asc(p, 0, 2) !== 'PM') break;
    var pname = clean(asc(p, 16, 32)), ptype = clean(asc(p, 48, 32));
    if (/Pippin/i.test(pname + ' ' + ptype)) isPippin = true;
    if (!hfsBlk && /^Apple_HFS$/i.test(ptype)) hfsBlk = u32be(p, 8);
  }
  var title = '';
  if (hfsBlk) {
    try {
      var bb = await readBlk(hfsBlk);
      if (bb && asc(bb, 0, 2) === 'LK' && /Pippin/i.test(asc(bb, 0, 512))) isPippin = true;
      var mdb = await readBlk(hfsBlk + 2);
      if (mdb && asc(mdb, 0, 2) === 'BD') {
        var vlen = Math.min(mdb[0x24], 27);
        if (vlen > 0) title = clean(asc(mdb, 0x25, vlen));
        // Pippin authentication pointer in MDB tail (+0x1F8..0x1FF)
        if (!isPippin && (u32be(mdb, 0x1F8) || u32be(mdb, 0x1FC))) isPippin = true;
      }
    } catch (e) { /* ignore */ }
  }
  return isPippin ? { sys: 'pippin', title: title } : null;
}
function sega(r, device, area) {
  // (CD-10/12; CD-0/3 is a set's opening disc 0)
  var d = /(\d+)\s*\/\s*(\d+)/.exec(device);
  if (d && +d[2] >= 1 && +d[1] <= +d[2]) r.disc = { n: +d[1], of: +d[2] };
  var a = area.replace(r.sys === 'saturn' ? /[^JTUBKAEL]/g : /[^JUE]/g, '');
  if (a) r.area = a.split('').filter(function (c, i, all) { return all.indexOf(c) === i; }).join('');
  return r;
}
// a UDF volume (BEA01, NSR02 or NSR03 descriptors after the ISO 9660 ones): a DVD's, as on PS2 DVDs;
// PS2 CDs have ISO 9660 only
async function hasUdf(rd) {
  for (var lba = 17; lba < 33; lba++) {
    var b = null;
    try { b = await rd.read(lba); } catch (e) { /* past the end */ }
    if (!b) return false;
    if (/^(BEA01|NSR02|NSR03)$/.test(asc(b, 1, 5))) return true;
  }
  return false;
}
// a Jaguar CD's boot track holds "ATARI APPROVED DATA HEADER ATRI" in audio sectors, in either byte order;
// file: its track file, at: where the track starts in it
var JAG_MARK = 'ATARI APPROVED DATA HEADER ATRI';
async function detectJaguar(file, at) {
  var b = new Uint8Array(await file.slice(at, at + 32 * 2352).arrayBuffer());
  var s = asc(b, 0, b.length), w = '';
  for (var i = 0; i + 1 < b.length; i += 2) w += String.fromCharCode(b[i + 1], b[i]);
  return s.indexOf(JAG_MARK) >= 0 || w.indexOf(JAG_MARK) >= 0;
}
async function detectTrack(rd) {
  var s0 = await rd.read(0);
  if (!s0) return null;
  var h = asc(s0, 0, 16);
  // Sega's headers (IP.BIN, Saturn and Dreamcast; the Sega CD's system area) also say which disc of a
  // set this is (CD-2/3, GD-ROM1/2) and where it may be sold (area symbols: J, U, E, and the Saturn's
  // T, B, K, A, L)
  if (h === 'SEGA SEGASATURN ') {
    return sega({ sys: 'saturn', serial: clean(asc(s0, 0x20, 10)), title: clean(asc(s0, 0x60, 112)),
      satCart: asc(s0, 0x50, 16).indexOf('W') >= 0 ? 'W' : undefined }, asc(s0, 0x38, 8), asc(s0, 0x40, 10));
  }
  if (h === 'SEGA SEGAKATANA ') {
    var serial = clean(asc(s0, 0x40, 10));
    // NAOMI, Triforce and Chihiro GD-ROMs share SEGA SEGAKATANA with Dreamcast, distinguished by header and serial
    var arcade = clean(asc(s0, 0x10, 0x50));
    var katSys = /TRIFORCE/i.test(arcade) || /^GDT-?\d{4}/i.test(serial) ? 'triforce'
      : /CHIHIRO/i.test(arcade) || /^GDX-?\d{4}/i.test(serial) ? 'chihiro'
      : /NAOMI\s*2/i.test(arcade) ? 'naomi2'
      : (/NAOMI/i.test(arcade) || /^GD[LS]-?\d{4}/i.test(serial)) ? 'naomi' : 'dc';
    var wince = katSys === 'dc' && (/^0WINCEOS\.BIN/i.test(clean(asc(s0, 0x60, 16))) || s0[0x38] === 0x31);
    return sega({ sys: katSys, serial: serial, title: clean(asc(s0, 0x80, 128)), wince: wince || undefined }, asc(s0, 0x20, 16), asc(s0, 0x30, 8));
  }
  if (/^SEGADISCSYSTEM|^SEGABOOTDISC|^SEGA-CD|^SEGA_CD/.test(h)) {
    var m = /^\s*(?:GM|AI|OS|BR)?\s*([A-Z0-9][A-Z0-9-]*)/.exec(asc(s0, 0x180, 14));
    return sega({ sys: 'segacd', serial: m ? m[1] : '', title: clean(asc(s0, 0x150, 48)) || clean(asc(s0, 0x120, 48)),
      cd32x: /^SEGA 32X/.test(asc(s0, 0x100, 8)) || undefined }, '', asc(s0, 0x1F0, 3));
  }
  if (s0[0] === 1 && asc(s0, 1, 5) === 'ZZZZZ' && (s0[6] === 1 || s0[6] === 2)) return { sys: '3do', title: clean(asc(s0, 0x28, 32)) };
  if (u32be(s0, 0x1C) === 0xC2339F3D) return { sys: 'gc', serial: clean(asc(s0, 0, 6)), title: clean(asc(s0, 0x20, 64)) };
  if (u32be(s0, 0x18) === 0x5D1C9EA3) return { sys: 'wii', serial: clean(asc(s0, 0, 6)), title: clean(asc(s0, 0x20, 64)) };
  if (asc(s0, 0, 4) === 'IPL4') return { sys: 'fmtowns' };
  if (asc(s0, 4, 4) === 'IPL1') return { sys: 'pc98' };
  if (asc(s0, 0, 8) === 'X68SCSI1') return { sys: 'x68k' };
  var pip = await detectPippin(rd, s0);
  if (pip) return pip;

  // PC Engine / PC-FX / backup 3DO OperaFS boot sectors: before the ISO 9660 volume some of these discs also have
  for (var l = 0; l < 16; l++) {
    var b = null;
    try { b = l === 0 ? s0 : await rd.read(l); } catch (e) { /* a short or damaged image: the volume below decides */ }
    if (!b) break;
    if (asc(b, 0x20, 23) === 'PC Engine CD-ROM SYSTEM') return { sys: 'pcecd' };
    if (asc(b, 0, 15) === 'PC-FX:Hu_CD-ROM') return { sys: 'pcfx' };
    if (l > 0 && b[0] === 1 && asc(b, 1, 5) === 'ZZZZZ' && (b[6] === 1 || b[6] === 2) && asc(b, 8, 6) === 'CD-ROM') return { sys: '3do', title: clean(asc(b, 0x28, 32)) };
  }
  var pvd = null, cdiPvd = null;
  for (var vd = 16; vd < 32; vd++) {
    var vb = null;
    try { vb = await rd.read(vd); } catch (e) { break; }
    if (!vb) break;
    var sig = asc(vb, 1, 5);
    if (sig === 'CD-I ') { cdiPvd = vb; break; }
    if (sig === 'CD001') {
      if (vb[0] === 1) { pvd = vb; break; }
      if (vb[0] === 255) break;
    } else if (vd === 16) break;
  }
  if (cdiPvd) return { sys: 'cdi', title: clean(asc(cdiPvd, 40, 32)) };
  if (pvd) {
    var sysId = clean(asc(pvd, 8, 32)), volId = clean(asc(pvd, 40, 32));
    var volSet = pvd[120] | (pvd[121] << 8), volSeq = pvd[124] | (pvd[125] << 8);
    var pvdDisc = volSet > 1 && volSeq >= 1 && volSeq <= volSet ? { n: volSeq, of: volSet } : undefined;
    var files = new Map();
    try { files = await isoDir(rd, u32le(pvd, 158), u32le(pvd, 166)); } catch (e) { /* ignore */ }
    if (files.has('UMD_DATA.BIN') || /^PSP GAME/.test(sysId)) {
      // UMD Video and UMD Audio discs carry UMD_DATA.BIN too, but without PSP_GAME
      var r = { sys: 'psp', title: volId, video: files.has('UMD_VIDEO') && !files.has('PSP_GAME'), umdAudio: files.has('UMD_AUDIO') && !files.has('PSP_GAME'), disc: pvdDisc };
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
      var pa = sonyRegion(r.serial);
      if (pa) r.area = pa;
      return r;
    }
    // a boot file named after the serial (SLUS_005.94) in the root: for discs whose SYSTEM.CNF boots
    // a generic PSX.EXE, and those without one
    var exe = null;
    files.forEach(function (v, k) { if (!exe && /^[A-Z]{4}_\d{3}\.\d{2}(;1)?$/.test(k)) exe = k; });
    var ps1Area = async function (ser) {
      try {
        var s4 = await rd.read(4), lic = s4 ? asc(s4, 0, 96) : '';
        if (/America/i.test(lic)) return 'U';
        if (/Europe/i.test(lic)) return 'E';
        if (/Entertainment Inc/i.test(lic)) return 'J';
      } catch (e) { /* ignore */ }
      return sonyRegion(ser);
    };
    if (files.has('SYSTEM.CNF')) {
      var cnf = '';
      try { cnf = new TextDecoder().decode(await isoFile(rd, files.get('SYSTEM.CNF'), 2048)); } catch (e) { /* unreadable */ }
      var b2 = /BOOT2\s*=\s*([^\r\n]+)/i.exec(cnf), b1 = /BOOT\s*=\s*([^\r\n]+)/i.exec(cnf);
      if (b2) {
        var ser2 = psSerial(b2[1].trim()) || (exe ? psSerial(exe) : ''), udf2 = await hasUdf(rd);
        var dvd9 = false, layerBreak = 0;
        if (udf2) {
          var volSpace0 = u32le(pvd, 80);
          if (volSpace0 > 16) {
            try {
              var pvd1 = await rd.read(volSpace0 + 16);
              if (pvd1 && pvd1[0] === 1 && asc(pvd1, 1, 5) === 'CD001') { dvd9 = true; layerBreak = volSpace0; }
            } catch (e) { /* single-layer or truncated */ }
          }
        }
        return { sys: 'ps2', serial: ser2, boot: bootName(b2[1]), title: volId, udf: udf2, area: sonyRegion(ser2) || undefined,
          disc: pvdDisc, dvd9: dvd9 || undefined, layerBreak: layerBreak || undefined };
      }
      if (b1) {
        var ser1 = psSerial(b1[1].trim()) || (exe ? psSerial(exe) : '');
        return { sys: 'ps1', serial: ser1, boot: bootName(b1[1]), title: volId, area: (await ps1Area(ser1)) || undefined, disc: pvdDisc };
      }
    }
    // Konami System 573 (PS1-based arcade CDs without consumer SLxx serial)
    var pvdMeta = sysId + ' ' + clean(asc(pvd, 318, 256));
    if (!exe && /KONAMI/i.test(pvdMeta) && (files.has('GAME.DAT') || files.has('GSE.NXX') || files.has('NSE.GXX') || files.has('OSE.FXX') || files.has('QSU.DXH') || files.has('RSU.CXH') || files.has('KONAMI573'))) {
      return { sys: 'ks573', title: volId };
    }
    // no boot line: a PS2 DVD still has its UDF volume (a PS1 disc never has one)
    if (/PLAYSTATION/i.test(sysId)) {
      var udf = await hasUdf(rd), serP = exe ? psSerial(exe) : '';
      return { sys: udf ? 'ps2' : 'ps1', serial: serP, title: volId, udf: udf || undefined,
        area: (udf ? sonyRegion(serP) : await ps1Area(serP)) || undefined, disc: pvdDisc };
    }
    // SYSTEM.CNF-less PS1 discs (early launch titles, Net Yaroze, prototypes booting PSX.EXE)
    if (files.has('PSX.EXE')) {
      try {
        var px = await isoFile(rd, files.get('PSX.EXE'), 8);
        if (asc(px, 0, 8) === 'PS-X EXE') {
          var serX = exe ? psSerial(exe) : '';
          return { sys: 'ps1', serial: serX, title: volId, area: (await ps1Area(serX)) || undefined, disc: pvdDisc };
        }
      } catch (e) { /* ignore */ }
    }
    if (files.has('PS3_DISC.SFB') || files.has('PS3_GAME')) {
      var r3 = { sys: 'ps3', title: volId, disc: pvdDisc };
      try {
        var g3 = files.get('PS3_GAME'), sub3 = g3 ? await isoDir(rd, g3.lba, g3.size) : new Map();
        if (sub3.has('PARAM.SFO')) {
          var sfo3 = parseSfo(await isoFile(rd, sub3.get('PARAM.SFO'), 8192));
          if (sfo3.TITLE) r3.title = sfo3.TITLE;
          if (sfo3.TITLE_ID) r3.serial = sfo3.TITLE_ID.slice(0, 4) + '-' + sfo3.TITLE_ID.slice(4);
        }
      } catch (e) { /* ignore */ }
      var a3 = sonyRegion(r3.serial);
      if (a3) r3.area = a3;
      return r3;
    }
    // Video CDs (a VCD folder: MPF) and CD-i Bridge discs, which Video CDs are too (CD-RTOS CD-BRIDGE, a CDI folder)
    if (files.has('VCD') || files.has('MPEGAV') || files.has('SVCD')) return { sys: 'vcd', title: volId }; // (and Super Video CDs)
    if (/CD-RTOS CD-BRIDGE/i.test(sysId) && files.has('CDI') && !files.has('PHOTO_CD')) return { sys: 'cdi', title: volId };
    // Neo Geo CD: IPL.TXT, or (MPF) the disc's text files
    if (files.has('IPL.TXT') || ['ABS.TXT', 'BIB.TXT', 'CPY.TXT'].filter(function (n) { return files.has(n); }).length >= 2) return { sys: 'ngcd', title: volId };
    // Bandai Playdia (Asahi Kasei AK8000 / .AJS + .GLB pairs)
    var fkeys = Array.from(files.keys());
    if (/^(ASAHI-CD|PLAYDIA)/i.test(sysId) || (fkeys.some(function (k) { return /\.AJS$/.test(k); }) && fkeys.some(function (k) { return /\.GLB$/.test(k); }))) {
      return { sys: 'playdia', title: volId };
    }
    // Fujitsu FM Towns, NEC PC-98, and Sharp X68000 ISO 9660 discs without boot sector magic
    if (/FM[\s_-]?TOWNS/i.test(sysId) || (files.has('TBIOS.SYS') && files.has('IO.SYS'))) return { sys: 'fmtowns', title: volId };
    if (/PC-?98/i.test(sysId) || files.has('NEC_CD.SYS')) return { sys: 'pc98', title: volId };
    if (/X68000/i.test(sysId) || files.has('HUMAN.SYS') || files.has('SUSIE.X')) return { sys: 'x68k', title: volId };
    // CDTV, CD32, and Amiga CD share Amiga files; CDTV has CDTV.TM, CD32 has CD32.TM or S/STARTUP-SEQUENCE
    if (files.has('CDTV.TM')) return { sys: 'cdtv', title: volId };
    if (files.has('CD32.TM') || /CD32/i.test(sysId)) return { sys: 'cd32', title: volId };
    if (/CDTV/i.test(sysId)) return { sys: 'cdtv', title: volId };
    if (files.has('S') && files.get('S').dir) {
      var sdir = new Map();
      try { sdir = await isoDir(rd, files.get('S').lba, files.get('S').size); } catch (e) { /* ignore */ }
      if (sdir.has('STARTUP-SEQUENCE')) return { sys: 'cd32', title: volId };
    }
    if (files.has('DISK.INFO')) {
      try {
        var di = await isoFile(rd, files.get('DISK.INFO'), 2);
        if (di.length >= 2 && di[0] === 0xE3 && di[1] === 0x10) return { sys: 'amigacd', title: volId };
      } catch (e) { /* ignore */ }
    }
    // a full Xbox dump starts with a video partition, which reads as ISO 9660
    var xbox = await detectXbox(rd);
    if (xbox) return xbox;
    // VM Labs Nuon: MUST run before VIDEO_TS because hybrid Nuon discs also carry DVD-Video VIDEO_TS!
    if (files.has('NUON.CD') || files.has('NUON.RUN')) return { sys: 'nuon', title: volId };
    if (files.has('NUON') && files.get('NUON').dir) {
      try {
        var ndir = await isoDir(rd, files.get('NUON').lba, files.get('NUON').size);
        if (ndir.has('NUON.CD') || ndir.has('NUON.RUN')) return { sys: 'nuon', title: volId };
      } catch (e) { /* ignore */ }
    }
    // video discs (MPF): not games
    var video = files.has('BDMV') ? 'Blu-ray' : files.has('HVDVD_TS') ? 'HD DVD' : files.has('AUDIO_TS') && files.get('AUDIO_TS').size && !files.has('VIDEO_TS') ? 'DVD-Audio' : files.has('VIDEO_TS') ? 'DVD-Video' : files.has('PHOTO_CD') ? 'Photo CD' : '';
    // (with other files and folders too, a disc of PC software that comes with a film: weak, so other
    // data tracks are looked at too, and a checksum may still name it)
    var mediaDirs = /^(VIDEO_TS|AUDIO_TS|JACKET_P|BDMV|CERTIFICATE|HVDVD_TS|ADV_OBJ|PHOTO_CD)$/;
    if (video) return { sys: 'video', title: volId, video: video, weak: fkeys.some(function (n) { return !mediaDirs.test(n); }) || undefined };
    return { sys: 'pc', title: volId, udf: (await hasUdf(rd)) || undefined, disc: pvdDisc, weak: true };
  }
  return detectXbox(rd);
}

/* ---------- describing what to look at for each job ---------- */
function msfFrames(s) {
  var m = /(\d+):(\d+):(\d+)/.exec(s || '');
  return m ? (+m[1] * 60 + +m[2]) * 75 + +m[3] : 0;
}
// a cue sheet's layout, as the per-disc rules (quirks.js) see it: its tracks (number, mode, session,
// INDEX 00 and 01 and PREGAP and POSTGAP in frames), its sessions (REM SESSION nn, as Redump writes),
// whether it is a GD-ROM's (REM HIGH-DENSITY AREA), and whether it has audio, CD+G or gaps
function cueModel(text) {
  var m = { tracks: [], sessions: 1, gd: /^\s*REM\s+HIGH-DENSITY AREA/im.test(text), audio: false, cdg: false, gaps: false };
  var cur = null, session = 1, fileNo = 0;
  text.split(/\r?\n/).forEach(function (ln) {
    var r;
    if (/^\s*FILE\s/i.test(ln)) fileNo++;
    else if ((r = /^\s*REM\s+SESSION\s+0*(\d+)/i.exec(ln))) { session = +r[1]; m.sessions = Math.max(m.sessions, session); }
    else if ((r = /^\s*TRACK\s+(\d+)\s+(\S+)/i.exec(ln))) {
      cur = { no: +r[1], mode: r[2].toUpperCase(), session: session, index: {}, indexFile: {}, pregap: 0, postgap: 0, pregapCmd: false };
      m.tracks.push(cur);
    } else if (cur && (r = /^\s*INDEX\s+(\d+)\s+(\S+)/i.exec(ln))) {
      var idx = +r[1];
      cur.index[idx] = msfFrames(r[2]);
      cur.indexFile[idx] = fileNo;
    } else if (cur && (r = /^\s*(PREGAP|POSTGAP)\s+(\S+)/i.exec(ln))) {
      var kind = r[1].toLowerCase(), fr = msfFrames(r[2]);
      cur[kind] = fr;
      if (kind === 'pregap' && fr > 0) cur.pregapCmd = true; // a virtual pregap (not in the file)
    }
  });
  m.tracks.forEach(function (t) {
    if ((0 in t.index) && (1 in t.index) && t.indexFile[0] === t.indexFile[1] && t.index[0] === t.index[1]) delete t.index[0];
  });
  m.audio = m.tracks.some(function (t) { return t.mode === 'AUDIO'; });
  m.cdg = m.tracks.some(function (t) { return t.mode === 'CDG'; });
  m.gaps = m.tracks.some(function (t) { return (0 in t.index) || t.pregap > 0 || t.postgap > 0; });
  return m;
}
// the same of a TOC file (cdrdao's), mirroring cdrom.cpp: leading ZERO/SILENCE/PREGAP runs up to
// START are virtual pregaps (not in the file), while file data before START is a stored pregap (INDEX 00)
var TOC_MODES = { AUDIO: 'AUDIO', MODE1: 'MODE1/2048', MODE1_RAW: 'MODE1/2352', MODE2: 'MODE2/2336', MODE2_RAW: 'MODE2/2352',
  MODE2_FORM1: 'MODE2/2048', MODE2_FORM2: 'MODE2/2324', MODE2_FORM_MIX: 'MODE2_FORM_MIX' };
function tocModel(text) {
  var m = { tracks: [], sessions: 1, gd: false, audio: false, cdg: false, gaps: false }, cur = null;
  var units = function (w, stride, sample) {
    if (/^\d+:\d+:\d+$/.test(w)) return msfFrames(w) * stride;
    return (+w || 0) * (sample ? 4 : 1);
  };
  var frames = function (w) { return /:/.test(w) ? msfFrames(w) : +w || 0; };
  var num = function (w) { return /^\d/.test(w || '') || /^#\d/.test(w || ''); };
  text.split(/\r?\n/).forEach(function (ln) {
    var a = tokenize(ln.replace(/\/\/.*$/, '')), k = (a[0] || '').toUpperCase();
    if (k === 'TRACK' && a[1]) {
      var mode = TOC_MODES[a[1].toUpperCase()] || a[1].toUpperCase();
      var ss = { MODE1: 2048, MODE2_FORM1: 2048, MODE2: 2336, MODE2_FORM_MIX: 2336, MODE2_FORM2: 2324, MODE1_RAW: 2352, MODE2_RAW: 2352, AUDIO: 2352 }[a[1].toUpperCase()] || 2352;
      cur = { no: m.tracks.length + 1, mode: mode, session: 1, index: { 1: 0 }, pregap: 0, postgap: 0, pregapCmd: false,
        _stride: ss + (/^RW(_RAW)?$/i.test(a[2] || '') ? 96 : 0), _runs: [], _frames: 0, _start: 0 };
      m.tracks.push(cur);
    } else if (!cur) return;
    else if (/^(DATAFILE|AUDIOFILE|FILE)$/.test(k) && a[1] != null) {
      var i = a[2] === 'SWAP' ? 3 : 2, audio = k !== 'DATAFILE';
      if (/^#\d/.test(a[i] || '')) i++;
      if (num(a[i]) && (audio || num(a[i + 1]))) i++;
      var lenB = num(a[i]) ? units(a[i], cur._stride, audio) : 0;
      var fr = lenB > 0 ? Math.ceil(lenB / cur._stride) : 1;
      cur._runs.push({ file: true, frames: fr });
      cur._frames += fr;
    } else if ((k === 'ZERO' || k === 'SILENCE') && num(a[a.length - 1])) {
      var zf = Math.ceil(units(a[a.length - 1], cur._stride, k === 'SILENCE') / cur._stride);
      cur._runs.push({ file: false, frames: zf });
      cur._frames += zf;
    } else if (k === 'PREGAP' && a[1]) {
      var pf = frames(a[1]);
      cur._runs.push({ file: false, frames: pf });
      cur._frames += pf;
      cur._start = cur._frames;
    } else if (k === 'START') {
      cur._start = a[1] ? frames(a[1]) : cur._frames;
    }
  });
  m.tracks.forEach(function (t) {
    var zeros = 0;
    for (var i = 0; i < t._runs.length && !t._runs[i].file; i++) zeros += t._runs[i].frames;
    if (t._start > 0 && t._start <= zeros) {
      t.pregap = t._start;
      t.pregapCmd = true;
    } else if (t._start > 0) {
      t.index[0] = 0;
      t.index[1] = t._start;
    }
    delete t._stride; delete t._runs; delete t._frames; delete t._start;
  });
  m.audio = m.tracks.some(function (t) { return t.mode === 'AUDIO'; });
  m.gaps = m.tracks.some(function (t) { return (0 in t.index) || t.pregap > 0 || t.postgap > 0; });
  return m;
}
function nrgModel(nrg) {
  if (!nrg || !nrg.length) return null;
  var m = { tracks: [], sessions: 1, gd: false, audio: false, cdg: false, gaps: false };
  nrg.forEach(function (t) {
    var mode = t.mode === 0x700 ? 'AUDIO'
      : t.mode === 0 ? (t.size === 2048 ? 'MODE1/2048' : 'MODE1/2352')
      : t.mode === 0x600 ? (t.size === 2048 ? 'MODE2/2048' : t.size === 2336 ? 'MODE2/2336' : 'MODE2/2352')
      : 'MODE1/' + (t.size || 2352);
    var index = { 1: 0 };
    if (t.index1 > t.index0) {
      index[0] = 0;
      index[1] = Math.round((t.index1 - t.index0) / (t.size || 2352));
    }
    m.tracks.push({ no: t.no, mode: mode, session: 1, index: index, pregap: 0, postgap: 0, pregapCmd: false });
  });
  m.audio = m.tracks.some(function (t) { return t.mode === 'AUDIO'; });
  m.gaps = m.tracks.some(function (t) { return 0 in t.index; });
  return m;
}
// data tracks + hashable files of a "create" job; images: the stand-ins for its ECM files (ecmImages);
// nrg: the tracks of a Nero image (nrgTracks)
function probePlan(job, images, nrg) {
  var readers = [], hashes = [], audio = [];
  var fileOf = function (f) { return f && (f.ecm || f.pbp ? images && images.get(f) : f.file); };
  var normNfc = function (s) { return s.normalize ? s.normalize('NFC') : s; };
  var byName = function (n) {
    var full = normNfc(String(n || '').replace(/\\/g, '/').replace(/^\.\//, '')).toLowerCase();
    var lc = base(full);
    return fileOf(job.files.find(function (x) {
      return (x.ref && normNfc(x.ref.replace(/\\/g, '/').replace(/^\.\//, '')).toLowerCase() === full) ||
        normNfc(x.name).toLowerCase() === lc ||
        (x.ref && normNfc(base(x.ref)).toLowerCase() === lc);
    }));
  };
  if (job.src === 'cue' && job.descText) {
    var curFile = null, curTrack = null, fileTracks = [], byFile = new Map(), session = 1;
    var slotOf = function (f) {
      if (!f) return null;
      var ft = byFile.get(f);
      if (!ft) { ft = { file: f, tracks: [] }; byFile.set(f, ft); fileTracks.push(ft); }
      return ft;
    };
    var attach = function (t, f) {
      if (!t || t.attached) return;
      t.attached = true;
      var ft = slotOf(f || t.file);
      if (ft) ft.tracks.push(t);
    };
    job.descText.split(/\r?\n/).forEach(function (ln) {
      var m, fw = refWord('cue', ln);
      if (fw) { curFile = byName(fw.text); slotOf(curFile); }
      else if ((m = /^\s*REM\s+SESSION\s+0*(\d+)/i.exec(ln))) session = +m[1];
      else if ((m = /^\s*TRACK\s+(\d+)\s+(\S+)/i.exec(ln))) {
        if (curTrack) attach(curTrack, curTrack.file);
        curTrack = { no: +m[1], mode: m[2].toUpperCase(), index: 0, index0: null, session: session, file: curFile, attached: false };
      } else if (curTrack && (m = /^\s*INDEX\s+0*0\s+(\S+)/i.exec(ln))) {
        curTrack.index0 = msfFrames(m[1]);
      } else if (curTrack && (m = /^\s*INDEX\s+0*1\s+(\S+)/i.exec(ln))) {
        curTrack.index = msfFrames(m[1]);
        attach(curTrack, curFile);
      }
    });
    if (curTrack) attach(curTrack, curTrack.file);
    fileTracks.forEach(function (ft) {
      if (!ft.file) return;
      var trackSs = function (m) { return /2048/.test(m) ? 2048 : /2324/.test(m) ? 2324 : /2336/.test(m) ? 2336 : 2352; };
      if (ft.tracks.length === 1) {
        hashes.push({ file: ft.file, track: ft.tracks[0].no });
      } else {
        // single-bin multi-track .cue/.ccd: slice each track's Redump [start, end) range (plus whole-file fallback)
        var starts = ft.tracks.map(function (t, idx) {
          var fr = idx === 0 ? 0 : (t.index0 != null ? t.index0 : t.index);
          return fr * trackSs(t.mode);
        });
        ft.tracks.forEach(function (t, idx) {
          var st = starts[idx], en = idx + 1 < starts.length ? starts[idx + 1] : ft.file.size;
          if (en > st) hashes.push({ file: ft.file, start: st, end: en, size: en - st, track: t.no });
        });
        hashes.push({ file: ft.file, track: 0 });
      }
      ft.tracks.forEach(function (t) {
        if (t.mode === 'AUDIO') return;
        var ss = trackSs(t.mode);
        readers.push(fileReader(ft.file, t.index * ss, ss));
      });
    });
    // a disc of audio tracks only: a Jaguar CD's boot track is the first of its last session (Redump
    // marks the sessions), or else track 2
    var all = [];
    fileTracks.forEach(function (ft) { ft.tracks.forEach(function (t) { if (ft.file) all.push({ file: ft.file, t: t }); }); });
    if (all.length > 1 && all.every(function (x) { return x.t.mode === 'AUDIO'; })) {
      var last = all[all.length - 1].t.session;
      var boot = last > 1 ? all.find(function (x) { return x.t.session === last; }) : all[1];
      audio.push({ file: boot.file, at: boot.t.index * 2352 });
    }
  } else if (job.src === 'toc' && job.descText) {
    // where the engine finds each track (cdrdao's grammar, cdrom_file::parse_toc): a track is a run of
    // pieces, files and zeros (ZERO, SILENCE, PREGAP); INDEX 01 is at START, else at its first frame.
    // Times are mm:ss:ff; plain numbers are bytes (DATAFILE, ZERO) or samples of 4 bytes (AUDIOFILE,
    // SILENCE), but frames for START and PREGAP (msf_to_frames). A run ends on a whole sector (zeros pad it)
    var tt = [];
    var units = function (w, stride, sample) {
      if (/^\d+:\d+:\d+$/.test(w)) return msfFrames(w) * stride;
      return (+w || 0) * (sample ? 4 : 1);
    };
    var frames = function (w) { return /:/.test(w) ? msfFrames(w) : +w || 0; };
    var sectors = function (bytes, stride) { return Math.ceil(bytes / stride) * stride; };
    job.descText.split(/\r?\n/).forEach(function (ln) {
      var a = tokenize(ln.replace(/\/\/.*$/, '')), t = tt[tt.length - 1], k = a[0];
      if (k === 'TRACK' && a[1]) {
        var ss = { MODE1: 2048, MODE2_FORM1: 2048, MODE2: 2336, MODE2_FORM_MIX: 2336, MODE2_FORM2: 2324, MODE1_RAW: 2352, MODE2_RAW: 2352 }[a[1]] || 0;
        tt.push({ no: tt.length + 1, size: ss, stride: (ss || 2352) + (/^RW(_RAW)?$/.test(a[2] || '') ? 96 : 0), runs: [], bytes: 0, start: null });
        return;
      }
      if (!t) return;
      var num = function (w) { return /^\d/.test(w || '') || /^#\d/.test(w || ''); };
      if (/^(DATAFILE|AUDIOFILE|FILE)$/.test(k) && a[1] != null) {
        var f = byName(a[1]), i = a[2] === 'SWAP' ? 3 : 2, audio = k !== 'DATAFILE', off;
        off = /^#\d/.test(a[i] || '') ? +a[i++].slice(1) : 0;
        // AUDIOFILE/FILE: the start in the file; chdman 0.289's DATAFILE "f" start length: likewise
        if (num(a[i]) && (audio || num(a[i + 1]))) off += units(a[i++], t.stride, audio);
        var rawLen = num(a[i]) ? units(a[i], t.stride, audio) : 0;
        var len = rawLen > 0 ? rawLen : f ? Math.max(0, f.size - off) : 0;
        len = sectors(len, t.stride);
        t.runs.push({ file: f, offset: off, bytes: len });
        t.bytes += len;
      } else if ((k === 'ZERO' || k === 'SILENCE') && num(a[a.length - 1])) {
        var z = sectors(units(a[a.length - 1], t.stride, k === 'SILENCE'), t.stride);
        t.runs.push({ file: null, bytes: z }); t.bytes += z;
      } else if (k === 'PREGAP' && a[1]) {
        var pg = frames(a[1]) * t.stride;
        t.runs.push({ file: null, bytes: pg }); t.bytes += pg;
        t.start = t.bytes;
      } else if (k === 'START') t.start = a[1] ? frames(a[1]) * t.stride : t.bytes;
    });
    var tracksOf = new Map();
    tt.forEach(function (t) { t.runs.forEach(function (r) { if (r.file) (tracksOf.get(r.file) || tracksOf.set(r.file, new Set()).get(r.file)).add(t.no); }); });
    tracksOf.forEach(function (nos, f) {
      if (nos.size === 1) hashes.push({ file: f, track: nos.values().next().value });
      else {
        tt.forEach(function (t) {
          var fRuns = t.runs.filter(function (r) { return r.file === f && r.bytes > 0; });
          if (fRuns.length === 1 && t.runs.length === 1 && t.stride === (t.size || 2352)) {
            hashes.push({ file: f, start: fRuns[0].offset, end: fRuns[0].offset + fRuns[0].bytes, size: fRuns[0].bytes, track: t.no });
          }
        });
        hashes.push({ file: f, track: 0 });
      }
    });
    tt.forEach(function (t) {
      if (!t.size) return; // audio
      // INDEX 01: the byte `start` of the track's runs; from zeros, the next file's first byte
      var at = t.start || 0, pos = 0;
      for (var r = 0; r < t.runs.length; r++) {
        var run = t.runs[r];
        if (at < pos + run.bytes || r === t.runs.length - 1) {
          var fr = run.file ? run : t.runs.slice(r).find(function (x) { return x.file; });
          if (fr) readers.push(fileReader(fr.file, fr.offset + (fr === run ? at - pos : 0), t.size, t.stride));
          break;
        }
        pos += run.bytes;
      }
    });
  } else if (job.src === 'nrg' && nrg) {
    // a Nero image: one file, its track list at the end (read by nrgTracks); each track's data from index1
    var nf = fileOf(job.files[0]);
    nrg.forEach(function (t) {
      var st = t.no === 1 ? t.index1 : t.index0;
      if (t.size === 2352 && t.end > st) hashes.push({ file: nf, start: st, end: t.end, size: t.end - st, track: t.no });
      if (t.mode === 0 || t.mode === 0x600) readers.push(fileReader(nf, t.index1, t.size));
    });
  } else if (job.src === 'gdi' && job.descText) {
    var gdiRows = [];
    job.descText.replace(/\r/g, '').split('\n').slice(1).forEach(function (ln) {
      var t = tokenize(ln);
      if (t.length < 5) return;
      var f = byName(t[4]);
      if (!f) return;
      gdiRows.push({ no: +t[0], type: t[2], ss: +t[3] || 2352, file: f });
      hashes.push({ file: f, track: +t[0] });
      if (t[2] === '4') readers.push(fileReader(f, 0, +t[3] || 2352));
    });
    // Multi-track 2352-byte TOSEC .gdi: track03.bin appends the next track's pregap (150 or 225 frames);
    // also offer the Redump-trimmed slice so raw .gdi dumps hash-match GameDB before conversion
    if (gdiRows.length > 3 && gdiRows[2].type === '4' && gdiRows[2].ss === 2352) {
      var pad = (gdiRows.length === 4 && gdiRows[3].type === '4') ? 225 : 150;
      var trim = gdiRows[2].file.size - pad * 2352;
      if (trim > 0) hashes.push({ file: gdiRows[2].file, start: 0, end: trim, size: trim, track: gdiRows[2].no });
    }
    readers.reverse(); // the high-density data track carries the IP.BIN header
  } else if (job.src === 'pbp') {
    // a PS1 PBP's disc: read through a worker (ecmImages); slice multi-track PBPs by their TOC
    var pv = fileOf(job.files[0]), pbpMeta = job.files[0] && job.files[0].pbp;
    if (pv) {
      readers.push(fileReader(pv, 0, 2352));
      if (job.pbpTracks === 1) hashes.push({ file: pv, track: 0 });
      else if (pbpMeta && pbpMeta.list && pbpMeta.list.length > 1) {
        var pl = pbpMeta.list, base0 = pbpMeta.base || 0, totB = pbpMeta.sectors * 2352;
        var pstarts = pl.map(function (t, idx) {
          var fr = idx === 0 ? 0 : Math.max(0, (t.pregap < t.start ? t.pregap : t.start) - base0);
          return fr * 2352;
        });
        pl.forEach(function (t, idx) {
          var st = pstarts[idx], en = idx + 1 < pstarts.length ? pstarts[idx + 1] : totB;
          if (en > st) hashes.push({ file: pv, start: st, end: en, size: en - st, track: t.no });
        });
      }
    }
  } else if (job.src === 'cso') {
    // a compressed ISO: identifyJob reads it through a worker; the checksum is the ISO's
    hashes.push({ file: job.files[0].file, track: 0, size: job.isoSize, ciso: true });
  } else if (job.files.length === 1) {
    var f1 = fileOf(job.files[0]), x = ext(job.files[0].name);
    if (!f1) return { readers: readers, hashes: hashes, audio: audio };
    hashes.push({ file: f1, track: 0 });
    if (job.autoCue) readers.push(fileReader(f1, 0, /2048/.test(job.autoCue) ? 2048 : 2352));
    else if (x === 'iso' || x === 'cdr' || x === 'toast' || x === 'bin' || x === 'img') readers.push(fileReader(f1, 0, job.disc === 'cd' && job.syncMode ? 2352 : 2048));
  } else {
    job.files.forEach(function (f) { if (fileOf(f)) hashes.push({ file: fileOf(f), track: 0 }); });
  }
  return { readers: readers, hashes: hashes, audio: audio };
}

// the tracks of a Nero 5.5 or later image (.nrg), as the engine reads them (cdrom_file::parse_nero):
// the file ends with "NER5" and the offset of a chain of chunks, DAOX lists the tracks. null if not one
async function nrgTracks(file) {
  var bytes = async function (at, n) { return new Uint8Array(await file.slice(at, at + n).arrayBuffer()); };
  if (file.size < 12) return null;
  var b = await bytes(file.size - 12, 12);
  if (asc(b, 0, 4) !== 'NER5' || u32be(b, 4)) return null;
  for (var at = u32be(b, 8), n = 0; at + 8 <= file.size && n < 64; n++) {
    var h = await bytes(at, 8), id = asc(h, 0, 4), len = u32be(h, 4);
    if (id === 'END!') break;
    if (id === 'DAOX') {
      if (len < 22) return null;
      var c = await bytes(at + 8, Math.min(len, 22 + 99 * 42));
      if (c.length < 22) return null;
      var first = c[20], last = c[21], out = [];
      if (first < 1 || last < first || last > 99) return null;
      for (var t = first; t <= last; t++) {
        var o = 22 + (t - first) * 42;
        if (o + 42 > c.length) break;
        var u64 = function (p) { return u32be(c, p) * 4294967296 + u32be(c, p + 4); };
        out.push({ no: t, size: (c[o + 12] << 8) | c[o + 13], mode: (c[o + 14] << 8) | c[o + 15], index0: u64(o + 18), index1: u64(o + 26), end: u64(o + 34) });
      }
      return out;
    }
    at += len + 8;
  }
  return null;
}

/* ---------- the identification itself ---------- */
// onProvisional(result), if given, receives what is known before the slow checksum step
// (console, serial, sizes), so a conversion can start while the checksum confirms the release
async function identifyJob(job, onStatus, onProvisional) {
  await GameDB.ready();
  var det = null, sizes = [], dataSizes = [], exact = null, damaged = '';
  var chd = null, ecm = null;
  try {
    if (job.kind === 'chd') {
      chd = await chdReader(job.files[0].file, false, job.parentJob && job.parentJob.files[0].file);
      job.chdTracks = chd.tracks || [];
      job.chdInspect = chd.inspect || null;
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
        // audio-only CD CHD: check for Jaguar CD boot marker in track 2
        if (!det && chd.tracks.length > 1 && chd.tracks.every(function (tr) { return tr.type === 7; })) {
          var jFound = false;
          for (var jl = 0; jl < 32 && !jFound; jl++) {
            var jb = null;
            try { jb = await chd.read(1, jl); } catch (e) { break; }
            if (!jb) break;
            var js = asc(jb, 0, jb.length), jw = '';
            for (var ji = 0; ji + 1 < jb.length; ji += 2) jw += String.fromCharCode(jb[ji + 1], jb[ji]);
            if (js.indexOf(JAG_MARK) >= 0 || jw.indexOf(JAG_MARK) >= 0) jFound = true;
          }
          if (jFound) det = { sys: 'jagcd' };
        }
        chd.tracks.forEach(function (tr) {
          var sz = tr.frames * (tr.datasize || 2352);
          sizes.push(sz);
          if (tr.type !== 7) dataSizes.push(sz);
        });
      } else if (chd.kind === 2) {
        det = await detectTrack({ read: function (lba) { return chd.read(0, lba); } });
        sizes.push(chd.logical);
        dataSizes.push(chd.logical);
      }
    } else {
      // ECM images and PS1 PBP files: a worker rebuilds the images they hold
      var ecms = job.files.filter(function (f) { return f.ecm || f.pbp; }), images = null;
      if (ecms.length) {
        var reading = job.src === 'pbp' ? 'Reading the PBP file\u2026' : 'Reading the ECM image' + (ecms.length > 1 ? 's' : '') + '\u2026';
        onStatus && onStatus(reading, 0);
        var ei = await ecmImages(ecms, function (f) { if (onStatus) onStatus(reading, f); });
        ecm = ei;
        images = new Map();
        ecms.forEach(function (f, i) { if (ei.views[i]) { images.set(f, ei.views[i]); f.imageSize = ei.views[i].size; } });
      }
      var nrg = job.src === 'nrg' ? await nrgTracks(job.files[0].file) : null;
      if (nrg) job.nrgTracks = nrg;
      var plan = probePlan(job, images, nrg);
      if (job.src === 'cso') {
        chd = await chdReader(job.files[0].file, true);
        plan.readers.push({ read: function (lba) { return chd.read(0, lba); } });
      }
      for (var i = 0; i < plan.readers.length && (!det || det.weak); i++) {
        var d = await detectTrack(plan.readers[i]);
        if (d && (!det || !d.weak)) det = d;
      }
      // a disc without data tracks: a Jaguar CD's header is in an audio track
      for (var a = 0; a < plan.audio.length && !det; a++) {
        try { if (await detectJaguar(plan.audio[a].file, plan.audio[a].at)) det = { sys: 'jagcd' }; } catch (e) { /* unreadable */ }
      }
      if (chd) { chd.close(); chd = null; }
      if (ecm) { ecm.close(); ecm = null; }
      // exact match: size + CRC-32 of a data file against the Redump database
      var toHash = [];
      plan.hashes.forEach(function (hsh) {
        var size = hsh.size != null ? hsh.size : hsh.file.size;
        sizes.push(size);
        var bySize = GameDB.size(size);
        if (hsh.track) bySize = bySize.filter(function (e) { return !e.track || e.track === hsh.track; });
        if (det && !det.weak) {
          var same = bySize.filter(function (e) { return sameSys(e.sys, det.sys); });
          if (same.length) bySize = same;
        }
        // the checksum of what a CSO/ZSO or ECM file holds: a worker unpacks it again
        var pk = hsh.file.pack;
        if (bySize.length) toHash.push({ file: pk ? pk.file : hsh.file, start: hsh.start || 0, end: hsh.end != null ? hsh.end : size, size: size, how: hsh.ciso ? 'ciso' : pk ? pk.how : '', bySize: bySize });
      });
      if (toHash.length && onProvisional) onProvisional(result(null, true));
      for (var k = 0; k < toHash.length && !exact; k++) {
        var th = toHash[k];
        onStatus && onStatus('Checking against the game database…', 0);
        var crc = null;
        try { crc = await crcCached(th.file, th.start, th.end, function (p) { onStatus && onStatus('Checking against the game database…', p); }, th.how); }
        catch (e) { if ((e && e.aborted) || !th.how) throw e; damaged = e.message; } // a damaged compressed ISO or ECM image: no exact match, and the card says why
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
    var entry = null, method = '', pick, related = null, how = '';
    if (exact) {
      entry = exact[0];
      if (det && det.serial && exact.length > 1) entry = exact.find(function (e) { return hasSerial(e, det.serial); }) || entry;
      method = 'hash';
      // one checksum listed under several names (the same dump released twice): the choice stays
      var hn = exact.map(function (e) { return e.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
      if (hn.length > 1) entry = Object.assign({}, entry, { alternatives: hn });
    } else if (det && (det.serial || det.boot) && (pick = bySerial()).length) {
      var names = pick.map(function (c) { return c.e.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
      how = pick[0].how; // (which serial found it: the disc's, without its suffix, its boot file's, or a base one)
      if (pick.related) { method = 'serial-related'; related = names; }
      else {
        entry = pick[0].e;
        method = names.length > 1 ? 'serial-ambiguous' : pick[0].size ? 'serial+size' : 'serial';
        if (names.length > 1) entry = Object.assign({}, entry, { alternatives: names });
      }
    } else if (job.kind === 'chd' && det && !det.weak && dataSizes.length) {
      // CHD of a recognized console's disc without a readable serial: a unique size match of a data
      // track is still a strong hint. Not without the console: among 40,000 discs, an audio track or a
      // PC disc often has the size of some game's (a music CD was named after one)
      var pool = [];
      dataSizes.forEach(function (s) { GameDB.size(s).forEach(function (e) { if (sameSys(e.sys, det.sys)) pool.push(e); }); });
      var uniq = pool.map(function (e) { return e.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
      if (uniq.length === 1) { entry = pool[0]; method = 'size'; }
    }
    var sys = entry ? entry.sys : det ? det.sys : null;
    return {
      sys: sys, detected: det, entry: entry, method: method,
      name: entry ? entry.name : '', serial: (det && det.serial) || (entry && entry.serial) || '',
      headerTitle: det && det.title || '', checking: checking, damaged: damaged, related: related, how: how
    };
  }
  // the releases the disc's serial names, best first: those on the disc's console (any console when
  // none is), of the disc's number in a set (Disc 2 of 3), then by size (a matching track), how the
  // serial matched (exactly, then without a suffix, then as a base serial) and whether the release's
  // region is one the disc may be sold in. Only those that rank first
  function bySerial() {
    var cs = serialCandidates(det), hits = [];
    var collect = function (sys) {
      cs.forEach(function (c, ci) {
        if (!sys && c.how === 'boot') return;
        [false, true].forEach(function (base) {
          GameDB.lookup(c.serial, sys, base).forEach(function (e) {
            var kind = (base ? 2 : ci ? 1 : 0), how = base ? 'base' : c.how, had = hits.find(function (h) { return h.e === e; });
            if (had) { if (kind < had.kind) { had.kind = kind; had.how = how; } }
            else hits.push({ e: e, kind: kind, how: how });
          });
        });
      });
    };
    collect(det.sys);
    if (/^naomi2?$/.test(det.sys)) collect(det.sys === 'naomi' ? 'naomi2' : 'naomi');
    if (!hits.length) collect(null);
    if (!hits.length) return [];
    hits.forEach(function (h) {
      h.size = sizes.indexOf(h.e.size) >= 0;
      h.region = det.area ? regionFits(h.e.name, det.area) : 1;
      h.score = [h.size ? 0 : 1, h.kind, 2 - h.region];
    });
    // a release found only without the disc's suffix or under a base serial, for another region than
    // the disc's: not this disc (filtered before disc-number matching so wrong-region sets don't hide it)
    hits = hits.filter(function (h) { return h.size || !h.kind || h.region; });
    if (!hits.length) return [];
    var discInfo = det.disc || job.pbpDisc;
    if (discInfo) {
      var same = discInfo.of > 1
        ? hits.filter(function (h) { return discNo(h.e.name) === discInfo.n; })
        : hits.filter(function (h) { return discNo(h.e.name) === null; });
      if (same.length) hits = same;
    }
    var cmp = function (a, b) { for (var i = 0; i < 3; i++) if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i]; return 0; };
    var best = hits.slice().sort(cmp)[0];
    var top = hits.filter(function (h) { return !cmp(h, best); });
    // ... nor, only suggested, when a Sega header's title isn't the release's: Sega's publishers gave
    // other games the same serial with another suffix (T-25406H is Hexen, T-25406H-50 Doom). (Not a
    // PlayStation disc's volume label: ALLSTAR is All Star Action)
    if (!best.size && best.kind && SEGA_SYS.test(det.sys) && det.title && !top.some(function (h) { return titleFits(det.title, h.e.name); })) top.related = true;
    return top;
  }
}

/* ---------- DAT files (Redump, No-Intro): every track checked ----------
   Users add Logiqx XML or clrmamepro DAT files; each game's files (roms) are indexed by size, and a
   disc's files are matched by size and CRC-32. A disc matches a game when every file the game lists,
   its cue sheet or GDI aside, is among them. */
var Dats = {
  list: [],         // [{id, name, description, version, games, roms}]
  data: new Map(),  // id -> {meta, games: [{name, roms: [{name, size, crc}]}]}
  bySize: new Map(), // size -> [{dat, game, rom}]
  loaded: false,
  add: function (dat) {
    // the same list again (name and version) replaces the one kept
    var same = this.list.find(function (d) { return d.name === dat.meta.name && d.version === dat.meta.version; });
    if (same) this.remove(same.id, true);
    this.data.set(dat.meta.id, dat);
    this.list.push(dat.meta);
    this.index(dat);
    return same;
  },
  index: function (dat) {
    var self = this;
    dat.games.forEach(function (g) {
      g.roms.forEach(function (r) {
        var l = self.bySize.get(r.size);
        if (!l) self.bySize.set(r.size, l = []);
        l.push({ dat: dat.meta, game: g, rom: r });
      });
    });
  },
  remove: function (id, quiet) {
    this.data.delete(id);
    this.list = this.list.filter(function (d) { return d.id !== id; });
    this.bySize = new Map();
    var self = this;
    this.data.forEach(function (d) { self.index(d); });
  },
  size: function (n) { return this.bySize.get(n) || []; }
};
function datCrc(v) { return ('00000000' + String(v || '').trim().replace(/^0x/i, '')).slice(-8).toUpperCase(); }
// a DAT file's text: {meta, games} or null if it isn't one
function parseDat(text) {
  var head = text.slice(0, 65536), games = [], meta = { name: '', description: '', version: '' };
  if (/<datafile[\s>]/.test(head)) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    var hd = doc.getElementsByTagName('header')[0], hv = function (t) { var n = hd && hd.getElementsByTagName(t)[0]; return n ? n.textContent.trim() : ''; };
    meta.name = hv('name'); meta.description = hv('description'); meta.version = hv('version');
    var root = doc.documentElement, nodes = root.children;
    for (var i = 0; i < nodes.length; i++) {
      var g = nodes[i];
      if (g.tagName !== 'game' && g.tagName !== 'machine') continue;
      var roms = [], rl = g.getElementsByTagName('rom');
      for (var j = 0; j < rl.length; j++) {
        var r = rl[j], size = r.getAttribute('size'), crc = r.getAttribute('crc');
        if (size && crc) roms.push({ name: r.getAttribute('name') || '', size: +size, crc: datCrc(crc) });
      }
      if (roms.length) games.push({ name: g.getAttribute('name') || '', roms: roms });
    }
  } else if (/^\s*clrmamepro\s*\(/m.test(head)) {
    // clrmamepro's format: key value pairs in nested parentheses, strings in double quotes;
    // skip # and // comments outside quotes, unescape \" and \\, and recognize unary flags
    var UNARY = { baddump: 1, nodump: 1, verified: 1, good: 1 };
    var lines = text.split(/\r?\n/), cleanLines = [];
    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li], inQ = false, esc = false, cut = ln.length;
      for (var ci = 0; ci < ln.length; ci++) {
        var ch = ln[ci];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inQ) { esc = true; continue; }
        if (ch === '"') { inQ = !inQ; continue; }
        if (!inQ && (ch === '#' || (ch === '/' && ln[ci + 1] === '/'))) { cut = ci; break; }
      }
      cleanLines.push(ln.slice(0, cut));
    }
    var src = cleanLines.join('\n');
    var re = /"((?:[^"\\]|\\.)*)"|([()])|([^\s()"]+)/g, m, stack = [], cur = null, key = null;
    while ((m = re.exec(src))) {
      var quoted = m[1] != null;
      var tok = quoted ? m[1].replace(/\\(.)/g, '$1') : m[2] || m[3];
      if (!quoted && m[2] === '(') {
        var blk = { name: key, fields: {}, kids: [] };
        if (cur) cur.kids.push(blk);
        stack.push(cur); cur = blk; key = null;
        continue;
      }
      if (!quoted && m[2] === ')') {
        var done_ = cur; cur = stack.pop();
        if (!cur && done_) {
          if (done_.name === 'clrmamepro') { meta.name = done_.fields.name || ''; meta.description = done_.fields.description || ''; meta.version = done_.fields.version || ''; }
          else if (done_.name === 'game' || done_.name === 'machine') {
            var rs = done_.kids.filter(function (k) { return k.name === 'rom' && k.fields.size && k.fields.crc; })
              .map(function (k) { return { name: k.fields.name || '', size: +k.fields.size, crc: datCrc(k.fields.crc) }; });
            if (rs.length) games.push({ name: done_.fields.name || '', roms: rs });
          }
        }
        key = null;
        continue;
      }
      if (!cur) { key = tok; continue; }
      if (key == null) {
        if (!quoted && UNARY[tok.toLowerCase()]) cur.fields[tok.toLowerCase()] = true;
        else key = tok;
      } else {
        cur.fields[key] = tok; key = null;
      }
    }
  } else return null;
  if (!games.length) return null;
  meta.games = games.length;
  meta.roms = games.reduce(function (n, g) { return n + g.roms.length; }, 0);
  meta.id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { meta: meta, games: games };
}
// files: [{size, crc}] with their checksums: the game they match best, and how well (1-to-1 multiset)
function datMatch(files) {
  var avail = new Map();
  files.forEach(function (f) {
    if (!f.crc) return;
    var k = f.size + ':' + f.crc;
    avail.set(k, (avail.get(k) || 0) + 1);
  });
  var games = new Map();
  avail.forEach(function (cnt, k) {
    var sep = k.indexOf(':'), sz = +k.slice(0, sep), crc = k.slice(sep + 1);
    Dats.size(sz).forEach(function (h) {
      if (h.rom.crc !== crc) return;
      if (!games.has(h.game)) games.set(h.game, { dat: h.dat, game: h.game });
    });
  });
  var desc = function (r) { return /\.(cue|gdi|toc|ccd)$/i.test(r.name); };
  var best = null;
  games.forEach(function (e) {
    var tracks = e.game.roms.filter(function (r) { return !desc(r); });
    if (!tracks.length) return;
    var rem = new Map(avail), got = 0, missing = [];
    tracks.forEach(function (r) {
      var k = r.size + ':' + r.crc, left = rem.get(k) || 0;
      if (left > 0) { rem.set(k, left - 1); got++; }
      else missing.push(r.name);
    });
    if (!got) return;
    var full = got === tracks.length;
    var score = (full ? 1e9 : 0) + got * 1000 - (tracks.length - got);
    if (!best || score > best.score) {
      var descs = e.game.roms.filter(desc);
      var descMatch = descs.some(function (r) { return (rem.get(r.size + ':' + r.crc) || 0) > 0; });
      best = { e: e, tracks: tracks, got: got, missing: missing, full: full, descDiffers: descs.length > 0 && !descMatch, score: score };
    }
  });
  if (!best) return { none: true };
  return {
    dat: best.e.dat, game: best.e.game.name, total: best.tracks.length, matched: best.got, missing: best.missing,
    full: best.full, descDiffers: best.descDiffers
  };
}
