#!/usr/bin/env bash
# Link the compiled objects into an Emscripten module.
# Usage: OBJDIR=<object dir> wasm/link.sh <output.js> [extra emcc flags...]
# Links the objects listed in <object dir>/objs.rsp, written by `make objs`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=$1; shift
em++ -O3 -fwasm-exceptions @"${OBJDIR:-obj-wasm}/objs.rsp" -o "$OUT" \
 --js-library "$HERE/par_lib.js" \
 -sENVIRONMENT=worker -sEXIT_RUNTIME=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sINITIAL_MEMORY=16MB -sSTACK_SIZE=5MB \
 -sEXPORTED_FUNCTIONS=_chdman_begin,_chdman_resume,_chdman_abort,_wasm_progress_ptr,_fflush,_malloc,_free,_crc32,_wasm_par_complete,_wasm_par_item_compbuf,_wasm_par_complete_inplace,_wasm_ckpt_restore_chunk,_wasm_rd_slot,_wasm_rd_done,_wasm_helper_init,_wasm_helper_inbuf,_wasm_helper_outbuf,_wasm_helper_compress,_wasm_helper_inbuf_batch,_wasm_helper_outbuf_batch,_wasm_helper_compress_batch,_wasm_helper_dinit,_wasm_helper_dinbuf,_wasm_helper_doutbuf,_wasm_helper_decompress,_wasm_inflate_raw,_wasm_lz4_block,_wasm_lz4_compress_block,_wasm_deflate_raw,_wasm_7z_open,_wasm_7z_info,_wasm_7z_extract_folder,_wasm_7z_close,_wasm_aud_open,_wasm_aud_read,_wasm_aud_close,_wasm_probe_open,_wasm_probe_tracks,_wasm_probe_track_info,_wasm_probe_read,_wasm_probe_logical,_wasm_chd_inspect,_wasm_chd_sha1,_wasm_chd_metadata_list,_wasm_ecm_decode,_wasm_ecm_edc,_wasm_ecm_edc_combine \
 -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPU32,stringToNewUTF8 "$@"
