// The fuzzers (tests/fuzz, scripts/fuzz.sh) build the engine natively with __EMSCRIPTEN__ defined, so that
// the browser-only code is in (chd_file::wasm_read_ahead, wasm/wasm_helper.cpp, wasm/ecm.cpp). This
// stands in for Emscripten's header, of which the engine uses only EMSCRIPTEN_KEEPALIVE.
#pragma once
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
