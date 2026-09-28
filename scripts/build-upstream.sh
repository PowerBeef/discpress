#!/usr/bin/env bash
# Build unmodified chdman 0.289 from the MAME release, with the same compiler flags as the
# engine: build/chdman-0.289. The tests prefer it as the reference, so the page is checked
# against upstream rather than against its own engine. Fetches MAME (scripts/fetch-mame.sh)
# if needed; needs a C++20 compiler and make.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="${MAME_DIR:-$ROOT/third_party/mame}"
[ -f "$UP/src/tools/chdman.cpp" ] || "$ROOT/scripts/fetch-mame.sh" "$UP"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
make -s -C "$ROOT/wasm" -j"$JOBS" T=native UPSTREAM=1 M="$(cd "$UP" && pwd)" O="$ROOT/build/obj-upstream" NATIVE="$ROOT/build/chdman-0.289" native
{ "$ROOT/build/chdman-0.289" || true; } 2>&1 | head -1
