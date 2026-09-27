#!/usr/bin/env bash
# Build the engine (engine/) as a native chdman, build/chdman-native: the same code the page
# runs, compiled for this machine. Needs a C++20 compiler and make.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
make -s -C "$ROOT/wasm" -j"$JOBS" T=native O="$ROOT/build/obj-native" native
# chdman without arguments prints its version and usage, and exits non-zero
{ "$ROOT/build/chdman-native" || true; } 2>&1 | head -1
