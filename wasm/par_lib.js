addToLibrary({
  wasm_par_enabled: function (hunkbytes, unitbytes, comp) {
    if (!Module['parSetup']) return 0;
    var p = comp >>> 2;
    var list = [HEAPU32[p], HEAPU32[p + 1], HEAPU32[p + 2], HEAPU32[p + 3]];
    return Module['parSetup'](hunkbytes >>> 0, unitbytes >>> 0, list) ? 1 : 0;
  },
  wasm_par_submit: function (item, data, length) {
    Module['parSubmit'](item >>> 0, data >>> 0, length >>> 0);
  },
  // while helper workers compress, chdman pauses after each compression step
  // (chdman_begin/chdman_resume return -1) so that their results can arrive
  wasm_par_active: function () {
    return Module['parActive'] ? 1 : 0;
  },
});
