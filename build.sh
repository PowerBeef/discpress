#!/usr/bin/env bash
# Build Discpress: compile the chdman engine (engine/) to WebAssembly (SIMD and
# non-SIMD) and assemble everything into the single file dist/discpress.html.
#
# Requirements: Emscripten 6.0.10 on PATH (source emsdk_env.sh), python3 and make. Another version
# can give other WebAssembly bytes, so the build refuses it (EMSCRIPTEN_ANY=1 allows it, for experiments:
# the page it makes is not a release build).
#
# Environment: JOBS (default: CPU count); WASM_EH=exnref builds with WebAssembly's new exception format
# (exnref: Chrome 137+, Firefox 131+, Safari 18.4+) instead of the legacy one, to try it before switching
# (which also needs app/ui.js's EH_TEST to test for it). Like EMSCRIPTEN_ANY's, that page records no
# sources, so scripts/check-dist.sh and a release refuse it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/build"

if ! command -v em++ >/dev/null; then
  echo "Emscripten not found. Install emsdk and run: source <emsdk>/emsdk_env.sh" >&2
  exit 1
fi
# the exact Emscripten release (emsdk 6.0.10: emscripten commit d6c521a7f...); this file is part of the
# sources the page records (scripts/engine-sources.py), so the pin is too
EMSCRIPTEN_VERSION=6.0.10
EMSCRIPTEN_COMMIT=d6c521a7f05449857c76bd99e396895583cf2083
have="$(em++ --version)"; have="${have%%$'\n'*}" # its first line
pinned=1
[ "$have" = "${have%" $EMSCRIPTEN_VERSION ($EMSCRIPTEN_COMMIT)"}" ] && pinned=
if [ -z "$pinned" ] && [ -z "${EMSCRIPTEN_ANY:-}" ]; then
  echo "Emscripten $EMSCRIPTEN_VERSION ($EMSCRIPTEN_COMMIT) is required, found: $have" >&2
  echo "Install it: emsdk install $EMSCRIPTEN_VERSION && emsdk activate $EMSCRIPTEN_VERSION (or set EMSCRIPTEN_ANY=1 to try another)" >&2
  exit 1
fi
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
# (its own objects: the Makefile doesn't rebuild what other flags compiled)
case "${WASM_EH:-legacy}" in
  legacy) EH=; EHO= ;;
  exnref) EH=-sWASM_LEGACY_EXCEPTIONS=0; EHO=-exnref ;;
  *) echo "WASM_EH: legacy or exnref, not $WASM_EH" >&2; exit 1 ;;
esac
mkdir -p "$OUT"
# The sources this wasm is built from, which the page records for scripts/check-dist.sh: hashed before
# compiling, written to build/ only once the build succeeded.
SOURCES="$(python3 "$ROOT/scripts/engine-sources.py")"
rm -f "$OUT/engine-sources.sha256"

echo "==> Compiling (SIMD)"
make -s -C "$ROOT/wasm" -j"$JOBS" T=wasm O="$OUT/obj-wasm$EHO" EXTRA="${EXTRA:-} $EH" objs
echo "==> Compiling (no SIMD, for older devices)"
make -s -C "$ROOT/wasm" -j"$JOBS" T=wasm SIMD= O="$OUT/obj-wasm-nosimd$EHO" EXTRA="${EXTRA:-} $EH" objs

echo "==> Linking"
W="-sMODULARIZE=1 -sEXPORT_NAME=createChdman -sENVIRONMENT=web,worker -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1"
cd "$OUT"
OBJDIR=obj-wasm$EHO "$ROOT/wasm/link.sh" chdman.js $W $EH
OBJDIR=obj-wasm-nosimd$EHO "$ROOT/wasm/link.sh" nosimd-tmp.js $W $EH
mv nosimd-tmp.wasm chdman-nosimd.wasm
# Both variants share one JS glue file, so it must be identical.
if ! diff <(sed 's/nosimd-tmp/chdman/g' nosimd-tmp.js) chdman.js >/dev/null; then
  echo "SIMD and non-SIMD glue code differ" >&2
  exit 1
fi
rm -f nosimd-tmp.js
# Another Emscripten's page records no sources: scripts/check-dist.sh and a release refuse it
if [ -n "$pinned" ] && [ -z "$EH" ]; then
  echo "$SOURCES" > engine-sources.sha256
elif [ -n "$EH" ]; then
  echo "warning: built with WebAssembly's exnref exceptions (WASM_EH=exnref): the page is for experiments, and check-dist.sh refuses it" >&2
else
  echo "warning: built with $have, not Emscripten $EMSCRIPTEN_VERSION: the page is for experiments, and check-dist.sh refuses it" >&2
fi

echo "==> Assembling"
python3 "$ROOT/scripts/assemble.py"
