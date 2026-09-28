#!/usr/bin/env bash
# Link the compiled objects into an Emscripten module.
# Usage: OBJDIR=<object dir> wasm/link.sh <output.js> [extra emcc flags...]
# Links the objects listed in <object dir>/objs.rsp, written by `make objs`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=$1; shift
em++ -O3 -fwasm-exceptions @"${OBJDIR:-obj-wasm}/objs.rsp" -o "$OUT" \
 --js-library "$HERE/par_lib.js" \
 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sINITIAL_MEMORY=16MB -sSTACK_SIZE=5MB \
 -sEXPORTED_FUNCTIONS=_chdman_begin,_chdman_resume,_fflush,_malloc,_free,_crc32,_wasm_par_complete,_wasm_helper_init,_wasm_helper_inbuf,_wasm_helper_outbuf,_wasm_helper_compress,_wasm_probe_open,_wasm_probe_tracks,_wasm_probe_track_info,_wasm_probe_read,_wasm_probe_logical \
 -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPU32,stringToNewUTF8 "$@"
