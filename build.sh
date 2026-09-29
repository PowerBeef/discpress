#!/usr/bin/env bash
# Build Discpress: compile the chdman engine (engine/) to WebAssembly (SIMD and
# non-SIMD) and assemble everything into the single file dist/discpress.html.
#
# Requirements: Emscripten 6.0.x on PATH (source emsdk_env.sh), python3 and make.
#
# Environment: JOBS (default: CPU count)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/build"

if ! command -v em++ >/dev/null; then
  echo "Emscripten not found. Install emsdk and run: source <emsdk>/emsdk_env.sh" >&2
  exit 1
fi
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
mkdir -p "$OUT"
# The sources this wasm is built from, which the page records for scripts/check-dist.sh: hashed before
# compiling, written to build/ only once the build succeeded.
SOURCES="$(python3 "$ROOT/scripts/engine-sources.py")"
rm -f "$OUT/engine-sources.sha256"

echo "==> Compiling (SIMD)"
make -s -C "$ROOT/wasm" -j"$JOBS" T=wasm O="$OUT/obj-wasm" objs
echo "==> Compiling (no SIMD, for older devices)"
make -s -C "$ROOT/wasm" -j"$JOBS" T=wasm SIMD= O="$OUT/obj-wasm-nosimd" objs

echo "==> Linking"
W="-sMODULARIZE=1 -sEXPORT_NAME=createChdman -sENVIRONMENT=web,worker -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1"
cd "$OUT"
OBJDIR=obj-wasm "$ROOT/wasm/link.sh" chdman.js $W
OBJDIR=obj-wasm-nosimd "$ROOT/wasm/link.sh" nosimd-tmp.js $W
mv nosimd-tmp.wasm chdman-nosimd.wasm
# Both variants share one JS glue file, so it must be identical.
if ! diff <(sed 's/nosimd-tmp/chdman/g' nosimd-tmp.js) chdman.js >/dev/null; then
  echo "SIMD and non-SIMD glue code differ" >&2
  exit 1
fi
rm -f nosimd-tmp.js
echo "$SOURCES" > engine-sources.sha256

echo "==> Assembling"
python3 "$ROOT/scripts/assemble.py"
