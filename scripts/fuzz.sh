#!/usr/bin/env bash
# Fuzzes the engine with libFuzzer, under AddressSanitizer and UndefinedBehaviorSanitizer
# (tests/fuzz/README.md: what each fuzzer feeds the engine, and how to read a finding).
#
#   scripts/fuzz.sh build                     the fuzzers (build/fuzz/<name>) and their seeds (build/fuzz/seeds/<name>)
#   scripts/fuzz.sh run <name|all> [seconds]  fuzz (default 300 s each); new inputs go to build/fuzz/corpus/<name>,
#                                             findings to build/fuzz/findings/; with "all", the four run at once
#   scripts/fuzz.sh check <name|all>          every seed, past finding (tests/fuzz/regressions) and corpus input
#                                             once: fails on any finding (CI)
#   scripts/fuzz.sh repro <name> <file>       one input, with the engine's output
#   scripts/fuzz.sh prune <name|all>          the corpus without the inputs that add no coverage
#
# The fuzzers are chd, desc, codec and ecm. The engine is built with __EMSCRIPTEN__ defined, so that its
# browser-only code is in, with tests/fuzz/host.cpp doing what the page's JavaScript does for it.
# Needs clang with its libFuzzer runtime (Debian and Ubuntu: clang and libclang-rt-<version>-dev) and make.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}"
CC="${CC:-clang}"
CXX="${CXX:-clang++}"
OUT="${FUZZ_OUT:-$ROOT/build/fuzz}"
FUZZERS=(chd desc codec ecm)

# (without clang's check of calls through a pointer to another function type, which gcc's UBSan, as in
# scripts/build-sanitized.sh, doesn't have: the LZMA SDK calls its match finder's functions through
# pointers that take void *, which every ABI makes the same call, WebAssembly's call_indirect included)
SAN="-fsanitize=address,undefined -fno-sanitize=function -fno-sanitize-recover=undefined -fno-omit-frame-pointer"
# -Dmain=...: chdman's main gives way to libFuzzer's (host.cpp runs commands with chdman_begin)
OPT="-O1 -g $SAN -fsanitize=fuzzer-no-link -D__EMSCRIPTEN__ -Dmain=chdman_native_main -I$ROOT/tests/fuzz/shim"
# the native build of every engine source, wasm_helper.cpp and ecm.cpp too
MAKEVARS=(T=native "OPT=$OPT" "CC=$CC" "CXX=$CXX" "O=$OUT/obj" 'CPP_SRC=$(UTIL_SRC) $(OSD_SRC) $(TOOL_SRC)')

# failing to allocate more than 1 GB at once (as a phone's browser does) must be an error, not a crash;
# leaks that unmodified chdman 0.289 has too are suppressed, as for the sanitized build
export ASAN_OPTIONS="${ASAN_OPTIONS:-allocator_may_return_null=1:max_allocation_size_mb=1024:detect_stack_use_after_return=1:strict_string_checks=1}"
export LSAN_OPTIONS="${LSAN_OPTIONS:-suppressions=$ROOT/tests/support/lsan.supp}"
export UBSAN_OPTIONS="${UBSAN_OPTIONS:-print_stacktrace=1}"
FUZZ_OPTS=(-timeout=25 -rss_limit_mb=2560 -malloc_limit_mb=2048)

build() {
  mkdir -p "$OUT"
  # objects built with other flags are built again (the Makefile only tracks sources and headers)
  if [ "$(cat "$OUT/obj/flags" 2>/dev/null)" != "$OPT $CC $CXX" ]; then rm -rf "$OUT/obj"; mkdir -p "$OUT/obj"; echo "$OPT $CC $CXX" > "$OUT/obj/flags"; fi
  make -s -C "$ROOT/wasm" -j"$JOBS" "${MAKEVARS[@]}" objs
  local cxxflags
  # (the engine's flags, but for the main rename: seeds.cpp has its own)
  cxxflags="$(make -s -C "$ROOT/wasm" "${MAKEVARS[@]}" --eval 'print-cxxflags: ; @echo $(CXXFLAGS)' print-cxxflags)"
  cxxflags="${cxxflags//-Dmain=chdman_native_main/}"
  local objs
  mapfile -t objs < "$OUT/obj/objs.rsp"
  local f
  for f in host "${FUZZERS[@]/#/fuzz_}" seeds; do
    # shellcheck disable=SC2086
    $CXX $cxxflags -c "$ROOT/tests/fuzz/$f.cpp" -o "$OUT/obj/$f.o" &
  done
  wait
  for f in "${FUZZERS[@]}"; do
    # shellcheck disable=SC2086
    $CXX $SAN -fsanitize=fuzzer "$OUT/obj/fuzz_$f.o" "$OUT/obj/host.o" "${objs[@]}" -o "$OUT/$f" -lpthread &
  done
  # shellcheck disable=SC2086
  $CXX $SAN "$OUT/obj/seeds.o" "$OUT/obj/host.o" "${objs[@]}" -o "$OUT/seeds-tool" -lpthread &
  wait
  rm -rf "$OUT/seeds"
  ASAN_OPTIONS="$ASAN_OPTIONS:detect_leaks=0" "$OUT/seeds-tool" "$OUT/seeds" > /dev/null 2> "$OUT/seeds.log" || { cat "$OUT/seeds.log" >&2; exit 1; }
  echo "fuzzers: ${FUZZERS[*]/#/$OUT/}; seeds: $(find "$OUT/seeds" -type f | wc -l) in $OUT/seeds"
}

names() {
  if [ "${1:-}" = all ]; then echo "${FUZZERS[@]}"; return; fi
  local f
  for f in "${FUZZERS[@]}"; do [ "$f" = "${1:-}" ] && { echo "$f"; return; }; done
  echo "unknown fuzzer '${1:-}' (${FUZZERS[*]} or all)" >&2
  exit 2
}

need_build() {
  local f
  for f in "$@"; do [ -x "$OUT/$f" ] || { echo "no $OUT/$f: scripts/fuzz.sh build first" >&2; exit 1; }; done
}

# libFuzzer writes new inputs into the first folder; the seeds are only read
run() {
  local secs="${2:-300}" pids=() status=0 f
  local list
  read -ra list <<< "$(names "$1")"
  need_build "${list[@]}"
  mkdir -p "$OUT/findings"
  for f in "${list[@]}"; do
    mkdir -p "$OUT/corpus/$f"
    "$OUT/$f" "${FUZZ_OPTS[@]}" -max_total_time="$secs" -close_fd_mask=3 -print_final_stats=1 \
      -artifact_prefix="$OUT/findings/$f-" "$OUT/corpus/$f" "$OUT/seeds/$f" $([ -d "$ROOT/tests/fuzz/regressions/$f" ] && echo "$ROOT/tests/fuzz/regressions/$f") > "$OUT/$f.log" 2>&1 &
    pids+=($!)
  done
  for i in "${!pids[@]}"; do
    f="${list[$i]}"
    if wait "${pids[$i]}"; then
      echo "$f: $(grep -m1 -o 'stat::number_of_executed_units: *[0-9]*' "$OUT/$f.log" | grep -o '[0-9]*$') runs, corpus $(find "$OUT/corpus/$f" -type f | wc -l), no findings"
    else
      status=1
      echo "$f: FINDING (log: $OUT/$f.log)"
      grep -m3 -E 'ERROR:|runtime error:|SUMMARY:|keeps pausing|Test unit written' "$OUT/$f.log" || tail -20 "$OUT/$f.log"
    fi
  done
  return $status
}

check() {
  local status=0 f dirs
  local list
  read -ra list <<< "$(names "$1")"
  need_build "${list[@]}"
  mkdir -p "$OUT/findings"
  for f in "${list[@]}"; do
    dirs=("$OUT/seeds/$f")
    [ -d "$ROOT/tests/fuzz/regressions/$f" ] && dirs+=("$ROOT/tests/fuzz/regressions/$f")
    [ -d "$OUT/corpus/$f" ] && dirs+=("$OUT/corpus/$f")
    if "$OUT/$f" "${FUZZ_OPTS[@]}" -runs=0 -close_fd_mask=3 -artifact_prefix="$OUT/findings/$f-" "${dirs[@]}" > "$OUT/$f-check.log" 2>&1; then
      echo "$f: $(find "${dirs[@]}" -type f | wc -l) inputs, no findings"
    else
      status=1
      echo "$f: FINDING (log: $OUT/$f-check.log)"
      grep -m3 -E 'ERROR:|runtime error:|SUMMARY:|keeps pausing' "$OUT/$f-check.log" || tail -20 "$OUT/$f-check.log"
    fi
  done
  return $status
}

# keeps only the corpus inputs that add coverage (libFuzzer's merge), so the saved corpus doesn't grow forever
prune() {
  local f
  local list
  read -ra list <<< "$(names "$1")"
  need_build "${list[@]}"
  for f in "${list[@]}"; do
    [ -d "$OUT/corpus/$f" ] || continue
    rm -rf "$OUT/corpus/$f.new"
    mkdir -p "$OUT/corpus/$f.new"
    "$OUT/$f" "${FUZZ_OPTS[@]}" -merge=1 -close_fd_mask=3 "$OUT/corpus/$f.new" "$OUT/corpus/$f" > "$OUT/$f-prune.log" 2>&1 \
      || { echo "$f: merge failed (log: $OUT/$f-prune.log)"; return 1; }
    echo "$f: corpus $(find "$OUT/corpus/$f" -type f | wc -l) -> $(find "$OUT/corpus/$f.new" -type f | wc -l)"
    rm -rf "$OUT/corpus/$f"
    mv "$OUT/corpus/$f.new" "$OUT/corpus/$f"
  done
}

case "${1:-}" in
  build) build ;;
  run) run "${2:-all}" "${3:-300}" ;;
  check) check "${2:-all}" ;;
  prune) prune "${2:-all}" ;;
  repro)
    [ $# -eq 3 ] || { echo "usage: scripts/fuzz.sh repro <name> <file>" >&2; exit 2; }
    need_build "$(names "$2")"
    exec "$OUT/$2" "${FUZZ_OPTS[@]}" "$3" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
