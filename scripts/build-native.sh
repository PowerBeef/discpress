#!/usr/bin/env bash
# Build a native (Linux/macOS) chdman from the exact MAME source and patch the app
# uses, as a reference for tests and benchmarks: build/chdman-native.
# Needs a C++20 compiler and make; fetches MAME with scripts/fetch-mame.sh if needed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAME="${MAME_DIR:-$ROOT/third_party/mame}"
[ -f "$MAME/src/tools/chdman.cpp" ] || "$ROOT/scripts/fetch-mame.sh" "$MAME"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
make -s -C "$ROOT/wasm" -j"$JOBS" T=native M="$(cd "$MAME" && pwd)" O="$ROOT/build/obj-native" native
# chdman without arguments prints its version and usage, and exits non-zero
{ "$ROOT/build/chdman-native" || true; } 2>&1 | head -1
