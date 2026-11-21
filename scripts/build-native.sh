#!/usr/bin/env bash
# Build the engine (engine/) as a native chdman, build/chdman-native: the same code the page
# runs, compiled for this machine. Needs a C++20 compiler and make.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
# Relative paths avoid breaking GNU Make if the repo path contains spaces
make -s -C "$ROOT/wasm" -j"$JOBS" T=native M=../engine/mame O=../build/obj-native NATIVE=../build/chdman-native native
# chdman without arguments prints its version and usage, and exits non-zero
{ "$ROOT/build/chdman-native" || true; } 2>&1 | head -1
