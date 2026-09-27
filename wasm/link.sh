#!/usr/bin/env bash
# Link the compiled objects into an Emscripten module.
# Usage: OBJDIR=<object dir> wasm/link.sh <output.js> [extra emcc flags...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=$1; shift
em++ -O3 -fwasm-exceptions "${OBJDIR:-obj-wasm}"/*.o -o "$OUT" \
 --js-library "$HERE/par_lib.js" \
 -sASYNCIFY=1 -sASYNCIFY_IGNORE_INDIRECT=1 "-sASYNCIFY_ADD=['main','do_create*','do_copy*','compress_common*']" -sASYNCIFY_IMPORTS=wasm_par_yield \
 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sASYNCIFY_STACK_SIZE=65536 -sINITIAL_MEMORY=16MB -sSTACK_SIZE=5MB \
 -sEXPORTED_FUNCTIONS=_main,_fflush,_malloc,_free,_crc32,_wasm_par_complete,_wasm_helper_init,_wasm_helper_inbuf,_wasm_helper_outbuf,_wasm_helper_compress,_wasm_probe_open,_wasm_probe_tracks,_wasm_probe_track_info,_wasm_probe_read,_wasm_probe_logical \
 -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8,HEAPU32 "$@"
