#!/usr/bin/env bash
# Read-only readiness check for a local Discpress workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

ok()   { printf '  [ok]   %s\n' "$1"; }
miss() { printf '  [miss] %s\n' "$1"; }

echo "Discpress environment check ($ROOT)"

if [ -f build/chdman.wasm ] && [ -f build/chdman-nosimd.wasm ] && [ -f build/chdman.js ] && [ -f build/engine-sources.sha256 ]; then
  ok "extracted wasm + sources hash in build/"
else
  miss "build/ wasm outputs (run: python3 scripts/extract-build.py --if-stale)"
fi

if [ -x build/chdman-native ]; then
  ok "build/chdman-native ($({ build/chdman-native || true; } 2>&1 | head -1))"
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

if [ -f tests/.cache/fixtures/manifest.json ]; then
  ok "synthetic fixtures in tests/.cache/fixtures/"
else
  miss "synthetic fixtures (run: ${PY:-.venv/bin/python3} tests/fixtures/make_fixtures.py)"
fi

if command -v em++ >/dev/null 2>&1; then
  ok "em++ on PATH ($(em++ --version | head -1))"
elif [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
  ok "emsdk installed at ~/emsdk (source ~/emsdk/emsdk_env.sh before ./build.sh)"
else
  miss "Emscripten 6.0.10 (needed only for engine/, wasm/, or build.sh changes)"
fi

if diff --version 2>/dev/null | grep -qi 'GNU diffutils'; then
  ok "GNU diff on PATH"
elif command -v gdiff >/dev/null 2>&1; then
  ok "GNU gdiff available ($(gdiff --version | head -1))"
else
  miss "GNU diffutils (on macOS run: brew install diffutils, needed by scripts/engine-diff.sh)"
fi

if [ -d tests/node_modules/@playwright/test ]; then
  ok "tests/node_modules (@playwright/test installed)"
else
  miss "tests/node_modules (optional: interactive previews use Antigravity browser; npm ci needed only for Playwright specs)"
fi
