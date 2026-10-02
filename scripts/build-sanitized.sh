#!/usr/bin/env bash
# Build the engine (engine/) natively with AddressSanitizer and UndefinedBehaviorSanitizer:
# build/chdman-san. Undefined behavior aborts (-fno-sanitize-recover), as do memory errors and leaks,
# so a test that runs it on the fixtures fails on any of them:
#   CHDMAN_ENGINE=../build/chdman-san LSAN_OPTIONS=suppressions=$PWD/support/lsan.supp \
#     npx playwright test ui/engine.spec.js   (in tests/; lsan.supp: leaks chdman 0.289 has too)
# CI runs that when engine/ or wasm/ change (.github/workflows/sanitizers.yml). Needs gcc, g++ and make.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
SAN="-fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer"
# (command-line variables override the Makefile's: its native flags are -O2 -g0)
make -s -C "$ROOT/wasm" -j"$JOBS" T=native OPT="-O1 -g $SAN" CXX="g++ $SAN" CC="gcc" \
  O="$ROOT/build/obj-san" NATIVE="$ROOT/build/chdman-san" native
{ ASAN_OPTIONS=detect_leaks=0 "$ROOT/build/chdman-san" || true; } 2>&1 | head -1
