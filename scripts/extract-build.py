#!/usr/bin/env python3
"""Recover the WebAssembly build outputs from a finished dist/discpress.html.

Writes build/chdman.js, build/chdman.wasm and build/chdman-nosimd.wasm, which is
everything scripts/assemble.py needs. This lets you change app/ or db/ and
re-assemble without installing Emscripten or rebuilding MAME.

Usage: scripts/extract-build.py [discpress.html] [build dir]
The result is checked by re-assembling and comparing with the input byte for byte
(only meaningful when app/ and db/ still match the input).
"""
import base64, gzip, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'discpress.html')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'build')

page = open(SRC).read()


def script(id_):
    m = re.search(r'<script type="[^"]+" id="%s"[^>]*>(.*?)</script>' % id_, page, re.S)
    if not m:
        sys.exit('no <script id="%s"> in %s' % (id_, SRC))
    return m.group(1)


# The worker script is the Emscripten glue, a newline, then app/worker.js.
worker = script('worker-src')
tail = '\n' + open(os.path.join(ROOT, 'app', 'worker.js')).read()
if worker.endswith(tail):
    glue = worker[:-len(tail)]
else:
    # app/worker.js changed since the page was built: cut at the worker's header comment.
    i = worker.find('\n/* chdman web worker:')
    if i < 0:
        sys.exit('cannot find where app/worker.js starts inside the worker script')
    glue = worker[:i]

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'chdman.js'), 'w') as f:
    f.write(glue)
for id_, name in [('wasm-simd', 'chdman.wasm'), ('wasm-base', 'chdman-nosimd.wasm')]:
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(gzip.decompress(base64.b64decode(script(id_))))
print('wrote', ', '.join(os.path.join(OUT, n) for n in ('chdman.js', 'chdman.wasm', 'chdman-nosimd.wasm')))

# Round trip: assembling from the recovered files should reproduce the page exactly.
with tempfile.TemporaryDirectory() as tmp:
    again = os.path.join(tmp, 'check.html')
    env = dict(os.environ, DISCPRESS_BUILD_DIR=OUT)
    subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'assemble.py'), again], check=True,
                   stdout=subprocess.DEVNULL, env=env)
    same = open(again, 'rb').read() == open(SRC, 'rb').read()
print('round trip:', 'identical' if same else 'differs (expected if app/ or db/ changed since %s was built)' % os.path.basename(SRC))
