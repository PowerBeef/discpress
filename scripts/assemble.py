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


# what is known of particular games (db/facts/*.tsv, see db/facts/README.md): validated against the
# database, embedded as {fact: {sys: [serial keys]}} (keys as canonKey in ident.js makes them)
FACTS = {'libcrypt'}
SEGA = {'saturn', 'segacd', 'dc', 'naomi', 'naomi2'}


def canon_key(sys_, serial):
    k = re.sub('[^A-Z0-9]', '', serial.upper())
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
            assert len(f) == 5, where + ': 5 tab-separated fields (sys, serial, fact, value, source)'
            sys_, serial, fact, value, source = f
            assert sys_ in keys, where + ': no system ' + sys_ + ' in the database'
            assert canon_key(sys_, serial) in keys[sys_], where + ': no ' + serial + ' in the database for ' + sys_
            assert fact in FACTS, where + ': unknown fact ' + fact
            assert value == '1', where + ': value must be 1'
            assert source.strip(), where + ': no source'
            out.setdefault(fact, {}).setdefault(sys_, set()).add(canon_key(sys_, serial))
    return {fact: {s: sorted(v) for s, v in by.items()} for fact, by in out.items()}


def pack(path):
    raw = rd(path, 'rb')
    return base64.b64encode(gzip_fixed(raw)).decode(), len(raw)


def inline_script(src, what):
    """A script inlined in the page must not end it early (</script), nor put the HTML parser in its
    escaped states (<!--, <script), where a later </script> may no longer end it."""
    for bad in ('</script', '<!--', '<script'):
        assert bad not in src.lower(), '%s in %s' % (bad, what)
    return src


db_raw = rd(DB, 'rb')
db_json = gzip.decompress(db_raw)
dbver = json.loads(db_json)['version']
# Checked first, so a bad fact is reported even where there is no build (CI tests the committed page).
facts = game_facts(json.loads(db_json))

# The worker is the Emscripten glue followed by our worker code.
wsrc = inline_script(rd(os.path.join(B, 'chdman.js')) + '\n' + rd(os.path.join(A, 'worker.js')),
                     'the worker source (build/chdman.js + app/worker.js)')
simd_b64, simd_size = pack(os.path.join(B, 'chdman.wasm'))
base_b64, base_size = pack(os.path.join(B, 'chdman-nosimd.wasm'))

# Shown in Help > About: every change the engine makes to MAME 0.289 (scripts/engine-diff.sh),
# plus the new files.
patch = rd(os.path.join(ROOT, 'engine', 'mame-0.289.diff'))
for path, name, label in [(os.path.join(W, 'wasm_helper.cpp'), 'wasm_helper.cpp', 'new file'),
                          (os.path.join(W, 'ecm.cpp'), 'ecm.cpp', 'new file'),
                          (os.path.join(W, 'par_lib.js'), 'par_lib.js', 'new file, Emscripten JS library'),
                          (os.path.join(ROOT, 'engine', 'libm', 'flac_libm.c'), 'engine/libm/flac_libm.c', 'new file, from Arm optimized-routines')]:
    patch += '\n--- /dev/null\n+++ %s (%s)\n' % (name, label)
    patch += ''.join('+' + l + '\n' for l in rd(path).splitlines())

helpc = rd(os.path.join(A, 'help.html')).replace('/*PATCH*/', html.escape(patch)).replace('/*DBVER*/', 'version ' + html.escape(dbver))
ui_src = rd(os.path.join(A, 'ui.js'))
for k in ('/*IDENT*/', '/*QUIRKS*/'):
    assert ui_src.count(k) == 1, k + ' in app/ui.js'
ui_src = ui_src.replace('/*IDENT*/', rd(os.path.join(A, 'ident.js'))).replace('/*QUIRKS*/', rd(os.path.join(A, 'quirks.js')))
assert ui_src.count('/*GAMEFACTS*/{}') == 1, '/*GAMEFACTS*/{} in app/ident.js'
ui = inline_script(ui_src.replace('/*GAMEFACTS*/{}', json.dumps(facts, sort_keys=True, separators=(',', ':'))),
                   'app/ui.js + app/ident.js + app/quirks.js')
style = rd(os.path.join(A, 'style.css'))
assert '</style' not in style.lower(), '</style in app/style.css'

page = rd(os.path.join(A, 'index.html'))
for k, v in [('/*STYLE*/', style), ('<!--HELP-->', helpc), ('/*WORKER*/', wsrc),
             ('/*SIMD_SIZE*/', str(simd_size)), ('/*WASM_SIMD*/', simd_b64), ('/*BASE_SIZE*/', str(base_size)),
             ('/*WASM_BASE*/', base_b64), ('/*DB_SIZE*/', str(len(db_json))),
             ('/*GAMEDB*/', base64.b64encode(db_raw).decode()), ('/*UI*/', ui)]:
    assert page.count(k) == 1, k
    page = page.replace(k, v)

# The sources the wasm was built from, after </html> (build.sh writes the file; extract-build.py
# recovers it from a page).
src_file = os.path.join(B, 'engine-sources.sha256')
if os.path.exists(src_file):
    src_hash = rd(src_file).strip()
    assert re.fullmatch('[0-9a-f]{64}', src_hash), 'no SHA-256 in ' + src_file
    page += '<!-- engine sources sha256 %s -->\n' % src_hash
else:
    print('warning: no %s, so the page records no engine sources and scripts/check-dist.sh refuses it '
          '(./build.sh writes the file; extract-build.py recovers it from a page that has it)' % src_file, file=sys.stderr)

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'discpress.html')
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, 'w', encoding='utf-8', newline='') as f:
    f.write(page)
print(out, os.path.getsize(out), 'bytes')
