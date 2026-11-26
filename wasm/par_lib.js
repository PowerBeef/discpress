addToLibrary({
  // flags: bit 0 = libdeflate (--libdeflate), bit 1 = ultra (--ultra), bits 8..15 = zstd level (--zstd-level)
  wasm_par_enabled: function (hunkbytes, unitbytes, comp, flags) {
    if (!Module['parSetup']) return 0;
    var p = comp >>> 2;
    var list = [HEAPU32[p], HEAPU32[p + 1], HEAPU32[p + 2], HEAPU32[p + 3]];
    return Module['parSetup'](hunkbytes >>> 0, unitbytes >>> 0, list, flags >>> 0) ? 1 : 0;
  },
  // codecs: the codec slots to try for this hunk, a bit each (the codec plan; 15 = all)
  wasm_par_submit: function (item, data, length, codecs) {
    Module['parSubmit'](item >>> 0, data >>> 0, length >>> 0, codecs >>> 0);
  },
  // while helper workers compress, chdman pauses after each compression step
  // (chdman_begin/chdman_resume return -1) so that their results can arrive
  wasm_par_active: function () {
    return Module['parActive'] ? 1 : 0;
  },
  // results streamed into a folder the page hasn't written yet are over the limit: chdman pauses
  // (at the same points) until the page catches up
  wasm_out_full: function () {
    return Module['outFull'] && Module['outFull']() ? 1 : 0;
  },
  // extract and verify: helper workers decompress the hunks chdman is about to read
  // (chd_file::wasm_read_ahead); results come back through _wasm_rd_slot/_wasm_rd_done
  wasm_rd_enabled: function (chd, hunkbytes, unitbytes, comp) {
    if (!Module['rdSetup']) return 0;
    var p = comp >>> 2;
    var list = [HEAPU32[p], HEAPU32[p + 1], HEAPU32[p + 2], HEAPU32[p + 3]];
    return Module['rdSetup'](chd >>> 0, hunkbytes >>> 0, unitbytes >>> 0, list) ? 1 : 0;
  },
  wasm_rd_submit: function (chd, hunk, codec, data, length) {
    Module['rdSubmit'](chd >>> 0, hunk >>> 0, codec, data >>> 0, length >>> 0);
  },
  wasm_rd_close: function (chd) {
    if (Module['rdClose']) Module['rdClose'](chd >>> 0);
  },
  // crash-resumable checkpoints (OPFS-backed compressed non-parent conversions)
  wasm_ckpt_enabled: function (hunkbytes, hunkcount) {
    return Module['ckptEnabled'] ? (Module['ckptEnabled'](hunkbytes >>> 0, hunkcount >>> 0) >>> 0) : 0;
  },
  wasm_ckpt_requested: function () {
    return Module['ckptRequested'] && Module['ckptRequested']() ? 1 : 0;
  },
  wasm_ckpt_save: function (next_hunk, hunk_count, write_offset, total_out, sha1_ptr, delta_ptr, delta_count) {
    if (!Module['ckptSave']) return 0;
    return Module['ckptSave'](next_hunk >>> 0, hunk_count >>> 0, write_offset, total_out, sha1_ptr >>> 0, delta_ptr >>> 0, delta_count >>> 0) ? 1 : 0;
  },
  wasm_ckpt_try_resume: function (comp, hunk_bytes, hunk_count, unit_bytes, comps_ptr, logical_bytes, meta_end, out_state_ptr) {
    if (!Module['ckptTryResume']) return 0;
    var p = comps_ptr >>> 2;
    var comps = [HEAPU32[p], HEAPU32[p + 1], HEAPU32[p + 2], HEAPU32[p + 3]];
    return Module['ckptTryResume'](comp >>> 0, hunk_bytes >>> 0, hunk_count >>> 0, unit_bytes >>> 0, comps, logical_bytes, meta_end, out_state_ptr >>> 0) ? 1 : 0;
  },
  // streaming .7z unpacker callback: delivers <=2 MiB slices straight to OPFS/memory
  wasm_7z_write: function (file_idx, ptr, len) {
    return Module['on7zWrite'] ? (Module['on7zWrite'](file_idx >>> 0, ptr >>> 0, len >>> 0) | 0) : -1;
  },
});
