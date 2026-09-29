#!/usr/bin/env python3
"""Recover the WebAssembly build outputs from a finished dist/discpress.html.

Writes build/chdman.js, build/chdman.wasm and build/chdman-nosimd.wasm, which is
everything scripts/assemble.py needs, and build/engine-sources.sha256 when the page
records the engine sources its wasm was built from. This lets you change app/ or db/
and re-assemble without installing Emscripten or rebuilding MAME.

Usage: scripts/extract-build.py [--if-stale] [discpress.html] [build dir]
The result is checked by re-assembling and comparing with the input byte for byte
(only meaningful when app/ and db/ still match the input).
--if-stale does nothing when the build dir already holds this page's build, or holds a
build newer than the page (./build.sh output from newer sources is left alone).
"""
import base64, gzip, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
if_stale = '--if-stale' in args
args = [a for a in args if a != '--if-stale']
SRC = args[0] if len(args) > 0 else os.path.join(ROOT, 'dist', 'discpress.html')
OUT = args[1] if len(args) > 1 else os.path.join(ROOT, 'build')
NAMES = ('chdman.js', 'chdman.wasm', 'chdman-nosimd.wasm')
SOURCES = 'engine-sources.sha256'

with open(SRC, encoding='utf-8', newline='') as f:
    page = f.read()


def script(id_):
    m = re.search(r'<script type="[^"]+" id="%s"[^>]*>(.*?)</script>' % id_, page, re.S)
    if not m:
        sys.exit('no <script id="%s"> in %s' % (id_, SRC))
    return m.group(1)


def read(path, mode='r'):
    try:
        with open(path, mode, **({} if 'b' in mode else {'encoding': 'utf-8', 'newline': ''})) as f:
            return f.read()
    except FileNotFoundError:
        return None


# The worker script is the Emscripten glue, a newline, then app/worker.js.
worker = script('worker-src')
with open(os.path.join(ROOT, 'app', 'worker.js'), encoding='utf-8') as f:
    tail = '\n' + f.read()
if worker.endswith(tail):
    glue = worker[:-len(tail)]
else:
    # app/worker.js changed since the page was built: cut at the worker's header comment.
    i = worker.find('\n/* chdman web worker:')
    if i < 0:
        sys.exit('cannot find where app/worker.js starts inside the worker script')
    glue = worker[:i]
wasm = {name: gzip.decompress(base64.b64decode(script(id_)))
        for id_, name in [('wasm-simd', 'chdman.wasm'), ('wasm-base', 'chdman-nosimd.wasm')]}
# the engine sources the wasm was built from (scripts/assemble.py puts them after </html>)
m = re.search(r'<!-- engine sources sha256 ([0-9a-f]{64}) -->\n?$', page)
sources = m.group(1) + '\n' if m else None

if if_stale:
    simd = os.path.join(OUT, 'chdman.wasm')
    if os.path.exists(simd) and os.path.getmtime(simd) >= os.path.getmtime(SRC):
        sys.exit(0)  # built (or extracted) after the page was made: keep it
    if (read(os.path.join(OUT, 'chdman.js')) == glue and all(read(os.path.join(OUT, n), 'rb') == wasm[n] for n in wasm)
            and read(os.path.join(OUT, SOURCES)) == sources):
        sys.exit(0)

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'chdman.js'), 'w', encoding='utf-8', newline='') as f:
    f.write(glue)
for name, data in wasm.items():
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data)
if sources:
    with open(os.path.join(OUT, SOURCES), 'w', encoding='utf-8', newline='') as f:
        f.write(sources)
elif os.path.exists(os.path.join(OUT, SOURCES)):
    os.remove(os.path.join(OUT, SOURCES))  # another build's, not this wasm's
print('wrote', ', '.join(os.path.join(OUT, n) for n in NAMES + ((SOURCES,) if sources else ())))

# Round trip: assembling from the recovered files should reproduce the page exactly.
with tempfile.TemporaryDirectory() as tmp:
    again = os.path.join(tmp, 'check.html')
    env = dict(os.environ, DISCPRESS_BUILD_DIR=OUT)
    subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'assemble.py'), again], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    same = read(again, 'rb') == read(SRC, 'rb')
print('round trip:', 'identical' if same else 'differs (expected if app/ or db/ changed since %s was built)' % os.path.basename(SRC))
