#!/usr/bin/env python3
"""Inline the app, the WebAssembly builds and the game database into one HTML file.

Usage: scripts/assemble.py [output.html]   (default: dist/discpress.html)
Needs build/chdman.js, build/chdman.wasm and build/chdman-nosimd.wasm (see build.sh). It also records
build/engine-sources.sha256 at the end of the page: the hash of the sources that wasm was built from
(scripts/engine-sources.py), which scripts/check-dist.sh compares with the current sources.
"""
import base64, gzip, html, json, os, re, struct, sys, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(ROOT, 'app')
W = os.path.join(ROOT, 'wasm')
B = os.environ.get('DISCPRESS_BUILD_DIR') or os.path.join(ROOT, 'build')
DB = os.path.join(ROOT, 'db', 'db.json.gz')


def check(cond, msg):
    """Explicit invariant check (never disabled by python3 -O / PYTHONOPTIMIZE)."""
    if not cond:
        sys.exit(msg)


def rd(p, mode='r'):
    with open(p, mode, **({} if 'b' in mode else {'encoding': 'utf-8'})) as f:
        return f.read()


def gzip_fixed(data):
    """gzip at level 9 with a fixed header (mtime 0, OS byte 3), so the bytes don't depend on the Python
    version: 3.11 and 3.12 write zlib's header (OS 3 on Linux, 19 on macOS), 3.10 and 3.13+ write OS 255."""
    c = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    body = c.compress(data) + c.flush()
    return (b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\x03' + body +
            struct.pack('<II', zlib.crc32(data) & 0xffffffff, len(data) & 0xffffffff))


def replace_once(text, mapping, where):
    """Verify every placeholder occurs exactly once, then substitute all in a single pass."""
    for k in mapping:
        check(text.count(k) == 1, '%s in %s (expected 1, found %d)' % (k, where, text.count(k)))
    pat = re.compile('|'.join(re.escape(k) for k in mapping))
    return pat.sub(lambda m: mapping[m.group(0)], text)


# what is known of particular games (db/facts/*.tsv, see db/facts/README.md): validated against the
# database, embedded as {fact: {sys: [serial keys]}} (keys as canonKey in ident.js makes them)
FACTS = {'libcrypt', 'sat_rom_cart', 'sat_mpeg_card', 'sat_ram_4m', 'sat_ram_1m'}
SEGA = {'saturn', 'segacd', 'dc', 'naomi', 'naomi2', 'triforce', 'chihiro'}


def norm_serial(serial):
    return re.sub('[^A-Z0-9]', '', serial.upper())


def canon_key(sys_, serial):
    k = norm_serial(serial)
    return k[2:] if sys_ in SEGA and re.match(r'MK\d', k) else k


def game_facts(db):
    keys = {}
    for sys_, rows in db['systems'].items():
        ks = keys[sys_] = set()
        for line in rows.split('\n'):
            f = line.split('\t')
            for serial in (f[1].split('|') if len(f) > 1 and f[1] else []):  # (a release's serials, joined: db/mkdb.py)
                ks.add(canon_key(sys_, serial))
                ks.add(canon_key(sys_, serial.split('/')[0]))
                parts = re.split(r'[-\s]+', serial)
                if len(parts) > 2:
                    ks.add(canon_key(sys_, parts[0] + parts[1]))
                # Mirror ident.js base-serial rules for Sega two-part suffixes and Sony suffixed serials
                if sys_ in SEGA:
                    sg = re.match(r'^(.+)[-\s]\d{1,2}$', serial)
                    if sg:
                        ks.add(canon_key(sys_, sg.group(1)))
                sn = re.match(r'^([A-Z]{4}\d{5})[A-Z0-9]+$', norm_serial(serial))
                if sn:
                    ks.add(canon_key(sys_, sn.group(1)))
    out = {}
    fdir = os.environ.get('DISCPRESS_FACTS_DIR') or os.path.join(ROOT, 'db', 'facts')  # (the tests' bad facts)
    for name in sorted(os.listdir(fdir)) if os.path.isdir(fdir) else []:
        if not name.endswith('.tsv'):
            continue
        for n, line in enumerate(rd(os.path.join(fdir, name)).split('\n'), 1):
            if not line.strip() or line.startswith('#'):
                continue
            where = 'db/facts/%s:%d' % (name, n)
            f = line.split('\t')
            check(len(f) == 5, where + ': 5 tab-separated fields (sys, serial, fact, value, source)')
            sys_, serial, fact, value, source = f
            check(sys_ in keys, where + ': no system ' + sys_ + ' in the database')
            check(canon_key(sys_, serial) in keys[sys_], where + ': no ' + serial + ' in the database for ' + sys_)
            check(fact in FACTS, where + ': unknown fact ' + fact)
            check(value == '1', where + ': value must be 1')
            check(bool(source.strip()), where + ': no source')
            out.setdefault(fact, {}).setdefault(sys_, set()).add(canon_key(sys_, serial))
    return {fact: {s: sorted(v) for s, v in by.items()} for fact, by in out.items()}


def pack_bytes(raw):
    return base64.b64encode(gzip_fixed(raw)).decode(), len(raw)


def pack(path):
    return pack_bytes(rd(path, 'rb'))


def inline_script(src, what):
    """A script inlined in the page must not end it early (</script), nor put the HTML parser in its
    escaped states (<!--, <script), where a later </script> may no longer end it."""
    low = src.lower()
    for bad in ('</script', '<!--', '<script'):
        check(bad not in low, '%s in %s' % (bad, what))
    return src


def encode_gamedb_bin(db):
    """Pack db/db.json.gz into the compact columnar binary format DPDB\\x02:
      b'DPDB\\x02' + u32_le(json_len) + utf8_json + u32_le[total_rows](crc32) + u32_le[multi_rows](discDigest)
    Columns store prefix-delta names, exact sector counts (bin/2352, iso/2048, or negative byte fallback),
    and binary uint32 CRCs/digests, shrinking dist/discpress.html by ~220 KiB while speeding up GameDB._load()."""
    systems_out = []
    crcs = bytearray()
    digests = bytearray()
    for sys_key, rows_str in db['systems'].items():
        lines = [ln for ln in rows_str.split('\n') if ln]
        names_delta, serials, sizes, tracks, ntrks, exts = [], [], [], [], [], []
        prev_name = ''
        any_trk = False
        any_ntrk = False
        for line in lines:
            f = line.split('\t')
            nm = f[0]
            ser = f[1] if len(f) > 1 else ''
            sz = int(f[2])
            crc = int(f[3], 16) & 0xffffffff
            trk = f[4] if len(f) > 4 else ''
            ex = f[5] if len(f) > 5 else ''
            ntrk = int(f[6]) if len(f) > 6 and f[6] else 0
            dig = int(f[7], 16) & 0xffffffff if len(f) > 7 and f[7] else 0
            # shared prefix length with previous title (base-36)
            p = 0
            lim = min(len(prev_name), len(nm))
            while p < lim and prev_name[p] == nm[p]:
                p += 1
            names_delta.append((format(p, 'x') if p else '') + '\t' + nm[p:])
            prev_name = nm
            serials.append(ser)
            if ex == 'bin' and sz % 2352 == 0:
                sizes.append(str(sz // 2352))
            elif ex == 'iso' and sz % 2048 == 0:
                sizes.append(str(sz // 2048))
            else:
                sizes.append('-' + str(sz))
            tracks.append(trk)
            if trk:
                any_trk = True
            if ntrk >= 2:
                ntrks.append(str(ntrk))
                any_ntrk = True
                digests += struct.pack('<I', dig)
            else:
                ntrks.append('')
            exts.append(ex)
            crcs += struct.pack('<I', crc)
        uniq_ext = set(exts)
        if len(uniq_ext) == 1:
            ext_enc = next(iter(uniq_ext))
        elif uniq_ext <= {'bin', 'iso'}:
            ext_enc = ':' + ''.join('b' if x == 'bin' else 'i' for x in exts)
        else:
            ext_enc = '\t' + '\t'.join(exts)
        systems_out.append([
            sys_key, len(lines), ext_enc,
            '\n'.join(names_delta), '\n'.join(serials),
            ','.join(sizes),
            ','.join(tracks) if any_trk else '',
            ','.join(ntrks) if any_ntrk else ''
        ])
    meta = json.dumps({'v': db['version'], 's': systems_out}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return b'DPDB\x02' + struct.pack('<I', len(meta)) + meta + bytes(crcs) + bytes(digests)


db_raw = rd(DB, 'rb')
db_json = gzip.decompress(db_raw)
db_obj = json.loads(db_json)
dbver = db_obj['version']
# Checked first, so a bad fact is reported even where there is no build (CI tests the committed page).
facts = game_facts(db_obj)
db_bin = encode_gamedb_bin(db_obj)
db_b64, db_size = pack_bytes(db_bin)

# The worker is the Emscripten glue followed by our worker code.
wsrc = inline_script(rd(os.path.join(B, 'chdman.js')) + '\n' + rd(os.path.join(A, 'worker.js')),
                     'the worker source (build/chdman.js + app/worker.js)')
worker_crc = '%08x' % (zlib.crc32(wsrc.encode('utf-8')) & 0xffffffff)
simd_b64, simd_size = pack(os.path.join(B, 'chdman.wasm'))
base_b64, base_size = pack(os.path.join(B, 'chdman-nosimd.wasm'))
ver_file = os.path.join(ROOT, 'VERSION')
app_ver = rd(ver_file).strip() if os.path.exists(ver_file) else 'dev'
src_file = os.path.join(B, 'engine-sources.sha256')
src_hash = rd(src_file).strip() if os.path.exists(src_file) else ''
if src_hash:
    check(bool(re.fullmatch('[0-9a-f]{64}', src_hash)), 'no SHA-256 in ' + src_file)
engine_sha = src_hash[:12] if src_hash else 'dev'

# Shown in Help > About: every change the engine makes to MAME 0.289 (scripts/engine-diff.sh),
# plus the new files (gzip+base64 packed and inflated lazily when Help is opened).
patch = rd(os.path.join(ROOT, 'engine', 'mame-0.289.diff'))
for path, name, label in [(os.path.join(W, 'wasm_helper.cpp'), 'wasm_helper.cpp', 'new file'),
                          (os.path.join(W, 'ecm.cpp'), 'ecm.cpp', 'new file'),
                          (os.path.join(W, 'audio.cpp'), 'audio.cpp', 'new file, windowed audio decoder'),
                          (os.path.join(W, '7z_stream.c'), '7z_stream.c', 'new file, streaming .7z unpacker'),
                          (os.path.join(W, 'lz4_block.c'), 'lz4_block.c', 'new file, LZ4/libdeflate CSO/ZSO encoder'),
                          (os.path.join(W, 'par_lib.js'), 'par_lib.js', 'new file, Emscripten JS library'),
                          (os.path.join(W, 'version.cpp'), 'version.cpp', 'new file'),
                          (os.path.join(W, 'shim', 'SDL2', 'SDL.h'), 'shim/SDL2/SDL.h', 'new file, minimal SDL header shim'),
                          (os.path.join(ROOT, 'engine', 'libm', 'flac_libm.h'), 'engine/libm/flac_libm.h', 'new file, libFLAC deterministic libm header'),
                          (os.path.join(ROOT, 'engine', 'libm', 'flac_libm.c'), 'engine/libm/flac_libm.c', 'new file, from Arm optimized-routines')]:
    patch += '\n--- /dev/null\n+++ %s (%s)\n' % (name, label)
    patch += ''.join('+' + l + '\n' for l in rd(path).splitlines())
patch_b64, patch_size = pack_bytes(patch.encode('utf-8'))

helpc = replace_once(rd(os.path.join(A, 'help.html')), {
    '/*DBVER*/': 'version ' + html.escape(dbver),
    '/*VERSION*/': html.escape(app_ver),
}, 'app/help.html')
ident_src = replace_once(rd(os.path.join(A, 'ident.js')),
                         {'/*GAMEFACTS*/{}': json.dumps(facts, sort_keys=True, separators=(',', ':'))},
                         'app/ident.js')
ui_src = replace_once(rd(os.path.join(A, 'ui.js')), {
    '/*IDENT*/': ident_src,
    '/*QUIRKS*/': rd(os.path.join(A, 'quirks.js')),
    '/*VERSION*/': app_ver,
    '/*ENGINE_SHA*/': engine_sha,
}, 'app/ui.js')
ui = inline_script(ui_src, 'app/ui.js + app/ident.js + app/quirks.js')
style = rd(os.path.join(A, 'style.css'))
check('</style' not in style.lower(), '</style in app/style.css')

page = replace_once(rd(os.path.join(A, 'index.html')), {
    '/*STYLE*/': style,
    '<!--HELP-->': helpc,
    '/*WORKER_CRC*/': worker_crc,
    '/*WORKER*/': wsrc,
    '/*SIMD_SIZE*/': str(simd_size),
    '/*WASM_SIMD*/': simd_b64,
    '/*BASE_SIZE*/': str(base_size),
    '/*WASM_BASE*/': base_b64,
    '/*DB_SIZE*/': str(db_size),
    '/*GAMEDB*/': db_b64,
    '/*PATCH_SIZE*/': str(patch_size),
    '/*PATCH*/': patch_b64,
    '/*UI*/': ui,
}, 'app/index.html')

# The sources the wasm was built from, after </html> (build.sh writes the file; extract-build.py
# recovers it from a page).
if src_hash:
    page += '<!-- engine sources sha256 %s -->\n' % src_hash
else:
    print('warning: no %s, so the page records no engine sources and scripts/check-dist.sh refuses it '
          '(./build.sh writes the file; extract-build.py recovers it from a page that has it)' % src_file, file=sys.stderr)

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'discpress.html')
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, 'w', encoding='utf-8', newline='') as f:
    f.write(page)
print(out, os.path.getsize(out), 'bytes')
