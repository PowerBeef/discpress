addToLibrary({
  // flags: 1 = the deflate codec encodes with libdeflate (--libdeflate)
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
});
