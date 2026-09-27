addToLibrary({
  wasm_par_enabled__deps: ['$Asyncify'],
  wasm_par_enabled: function (hunkbytes, unitbytes, comp) {
    Module['__asyncify'] = Asyncify;
    if (!Module['parSetup']) return 0;
    var p = comp >>> 2;
    var list = [HEAPU32[p], HEAPU32[p + 1], HEAPU32[p + 2], HEAPU32[p + 3]];
    return Module['parSetup'](hunkbytes >>> 0, unitbytes >>> 0, list) ? 1 : 0;
  },
  wasm_par_submit: function (item, data, length) {
    Module['parSubmit'](item >>> 0, data >>> 0, length >>> 0);
  },
  wasm_par_yield__async: true,
  wasm_par_yield: function () {
    if (!Module['parActive']) return;
    return Asyncify.handleSleep(function (wakeUp) { Module['parYield'](wakeUp); });
  },
});
