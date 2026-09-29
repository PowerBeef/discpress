#!/usr/bin/env python3
"""Inline the app, the WebAssembly builds and the game database into one HTML file.

Usage: scripts/assemble.py [output.html]   (default: dist/discpress.html)
Needs build/chdman.js, build/chdman.wasm and build/chdman-nosimd.wasm (see build.sh).
"""
import base64, gzip, html, json, os, struct, sys, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(ROOT, 'app')
W = os.path.join(ROOT, 'wasm')
B = os.environ.get('DISCPRESS_BUILD_DIR') or os.path.join(ROOT, 'build')
DB = os.path.join(ROOT, 'db', 'db.json.gz')


def rd(p, mode='r'):
    with open(p, mode) as f:
        return f.read()


def gzip_fixed(data):
    """gzip at level 9 with a fixed header (mtime 0, OS byte 3), so the bytes don't depend on the Python
    version: 3.11 and 3.12 write zlib's header (OS 3 on Linux, 19 on macOS), 3.10 and 3.13+ write OS 255."""
    c = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    body = c.compress(data) + c.flush()
    return (b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\x03' + body +
            struct.pack('<II', zlib.crc32(data) & 0xffffffff, len(data) & 0xffffffff))


def pack(path):
    raw = rd(path, 'rb')
    return base64.b64encode(gzip_fixed(raw)).decode(), len(raw)


# The worker is the Emscripten glue followed by our worker code.
wsrc = rd(os.path.join(B, 'chdman.js')) + '\n' + rd(os.path.join(A, 'worker.js'))
assert '</script' not in wsrc.lower(), 'script end tag in worker source'
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

db_raw = rd(DB, 'rb')
db_json = gzip.decompress(db_raw)
dbver = json.loads(db_json)['version']
helpc = rd(os.path.join(A, 'help.html')).replace('/*PATCH*/', html.escape(patch)).replace('/*DBVER*/', 'version ' + dbver)
ui = rd(os.path.join(A, 'ui.js')).replace('/*IDENT*/', rd(os.path.join(A, 'ident.js')))
assert '</script' not in ui.lower()

page = rd(os.path.join(A, 'index.html'))
for k, v in [('/*STYLE*/', rd(os.path.join(A, 'style.css'))), ('<!--HELP-->', helpc), ('/*WORKER*/', wsrc),
             ('/*SIMD_SIZE*/', str(simd_size)), ('/*WASM_SIMD*/', simd_b64), ('/*BASE_SIZE*/', str(base_size)),
             ('/*WASM_BASE*/', base_b64), ('/*DB_SIZE*/', str(len(db_json))),
             ('/*GAMEDB*/', base64.b64encode(db_raw).decode()), ('/*UI*/', ui)]:
    assert page.count(k) == 1, k
    page = page.replace(k, v)

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'discpress.html')
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, 'w') as f:
    f.write(page)
print(out, os.path.getsize(out), 'bytes')
