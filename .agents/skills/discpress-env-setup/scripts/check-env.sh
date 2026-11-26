#!/usr/bin/env bash
# Read-only readiness check for a local Discpress workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

EMSCRIPTEN_VERSION=6.0.10
EMSCRIPTEN_COMMIT=d6c521a7f05449857c76bd99e396895583cf2083

ok()   { printf '  [ok]   %s\n' "$1"; }
miss() { printf '  [miss] %s\n' "$1"; }

echo "Discpress environment check ($ROOT)"

if [ -f build/chdman.wasm ] && [ -f build/chdman-nosimd.wasm ] && [ -f build/chdman.js ] && [ -f build/engine-sources.sha256 ]; then
  want_sha="$(python3 scripts/engine-sources.py 2>/dev/null || true)"
  have_sha="$(tr -d '[:space:]' < build/engine-sources.sha256)"
  if [ -n "$want_sha" ] && [ "$have_sha" = "$want_sha" ]; then
    ok "extracted wasm + matching engine-sources.sha256 in build/"
  else
    miss "build/engine-sources.sha256 is stale vs scripts/engine-sources.py (run: python3 scripts/extract-build.py --if-stale, or ./build.sh if engine/wasm changed)"
  fi
else
  miss "build/ wasm outputs (run: python3 scripts/extract-build.py --if-stale)"
fi

if [ -x build/chdman-native ]; then
  if python3 -c '
import os, subprocess, sys
bin_m = os.path.getmtime("build/chdman-native")
out = subprocess.check_output([sys.executable, "scripts/engine-sources.py", "--list"], text=True)
newest = 0.0
for ln in out.splitlines():
    p = ln[66:]
    if p and p != "build.sh" and os.path.exists(p):
        newest = max(newest, os.path.getmtime(p))
sys.exit(0 if bin_m >= newest else 1)
' 2>/dev/null; then
    ok "build/chdman-native ($({ build/chdman-native || true; } 2>&1 | head -1))"
  else
    miss "build/chdman-native is older than engine/ or wasm/ (run: ./scripts/build-native.sh)"
  fi
else
  miss "build/chdman-native (run: ./scripts/build-native.sh)"
fi

if [ -x build/chdman-0.289 ]; then
  ok "build/chdman-0.289 ($({ build/chdman-0.289 || true; } 2>&1 | head -1))"
else
  miss "build/chdman-0.289 (run: ./scripts/build-upstream.sh)"
fi

if [ -f third_party/mame/src/tools/chdman.cpp ]; then
  ok "third_party/mame (MAME 0.289 upstream checkout)"
else
  miss "third_party/mame (run: ./scripts/fetch-mame.sh)"
fi

PY=""
if [ -x .venv/bin/python3 ] && .venv/bin/python3 -c 'import numpy' 2>/dev/null; then
  PY=".venv/bin/python3"
elif python3 -c 'import numpy' 2>/dev/null; then
  PY="python3"
fi
if [ -n "$PY" ]; then
  ok "numpy available via $PY"
else
  miss "numpy (create .venv and install numpy for make_fixtures.py)"
fi

if [ -f tests/.cache/fixtures/manifest.json ] && [ -f tests/.cache/fixtures/generator.sha256 ]; then
  if python3 -c '
import hashlib, sys
h = hashlib.sha256()
for n in ("tests/fixtures/make_fixtures.py", "tests/fixtures/discgen.py"):
    with open(n, "rb") as f:
        h.update(f.read())
with open("tests/.cache/fixtures/generator.sha256", "r", encoding="utf-8") as f:
    have = f.read().strip()
sys.exit(0 if have == h.hexdigest() else 1)
' 2>/dev/null; then
    ok "synthetic fixtures in tests/.cache/fixtures/ (up to date)"
  else
    miss "synthetic fixtures are stale vs generator.sha256 (run: ${PY:-.venv/bin/python3} tests/fixtures/make_fixtures.py)"
  fi
elif [ -f tests/.cache/fixtures/manifest.json ]; then
  miss "synthetic fixtures missing generator.sha256 (run: ${PY:-.venv/bin/python3} tests/fixtures/make_fixtures.py)"
else
  miss "synthetic fixtures (run: ${PY:-.venv/bin/python3} tests/fixtures/make_fixtures.py)"
fi

if command -v em++ >/dev/null 2>&1; then
  em_ver="$(em++ --version 2>/dev/null | head -1 || true)"
  if [ "$em_ver" != "${em_ver%" $EMSCRIPTEN_VERSION ($EMSCRIPTEN_COMMIT)"}" ]; then
    ok "em++ on PATH ($em_ver)"
  else
    miss "em++ on PATH is wrong version ($em_ver; build.sh requires $EMSCRIPTEN_VERSION ($EMSCRIPTEN_COMMIT))"
  fi
elif [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
  ok "emsdk installed at ~/emsdk (source ~/emsdk/emsdk_env.sh; build.sh requires $EMSCRIPTEN_VERSION)"
else
  miss "Emscripten $EMSCRIPTEN_VERSION (needed only for engine/, wasm/, or build.sh changes)"
fi

if diff --version 2>/dev/null | grep -qi 'GNU diffutils'; then
  ok "GNU diff on PATH"
elif command -v gdiff >/dev/null 2>&1; then
  ok "GNU gdiff available ($(gdiff --version | head -1))"
else
  miss "GNU diffutils (on macOS run: brew install diffutils for GNU diff/gdiff, needed by scripts/engine-diff.sh)"
fi

if [ -d tests/node_modules/@playwright/test ]; then
  ok "tests/node_modules (@playwright/test installed)"
else
  miss "tests/node_modules (optional: interactive previews use Antigravity browser; npm ci needed only for Playwright specs)"
fi
