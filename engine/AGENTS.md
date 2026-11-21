# Engine & WebAssembly Rules (`engine/AGENTS.md`)

Applies to `engine/` (`mame/`, `libdeflate/`, `libm/`, `FILES`, `mame-0.289.diff`), `wasm/` (`Makefile`, `sources.mk`, `link.sh`, `par_lib.js`, `wasm_helper.cpp`, `ecm.cpp`, `version.cpp`, `shim/`), and `build.sh`.

## Fork Layout & Licensing

- **`engine/mame/`** holds MAME 0.289 (`mame0289`, commit `f34f02505e32c1993c6a782b6814232cbfc74e36`) `chdman` and **only** the 77 source files (75 compiled translation units + 2 `#include`d libFLAC `.c` files), 123 headers, and 4 license files it links (204 files total, listed in `engine/FILES`), at MAME's original paths.
  - Edit forked MAME files in place, keep their paths, and run `./scripts/engine-diff.sh` to update `engine/mame-0.289.diff` (displayed in Help → About; verified in CI via `--check`). On macOS, install GNU `diffutils` (`brew install diffutils`) so `engine-diff.sh` uses `gdiff` and matches CI's Ubuntu hunk alignment byte for byte.
  - **All new code goes outside `engine/mame/`** (e.g., `wasm/`, `engine/libdeflate/`, `engine/libm/`).
  - Unmodified MAME 0.289 is fetched on demand into `third_party/mame` via `./scripts/fetch-mame.sh` for diffing and building the upstream oracle (`scripts/build-upstream.sh`).
- **Permissive licensing only (`scripts/check-licenses.sh`):**
  - Every file under `engine/mame/src/` must declare `license:BSD-3-Clause` in its first 3 lines (exception: `engine/mame/src/lib/util/md5.h` is `license:Public Domain`).
  - No GPL, LGPL, AGPL, or CC-BY-NC code or license text may exist anywhere in `engine/`, and top-level entries in `engine/` are restricted to an allowlist (`mame`, `libdeflate`, `libm`, `FILES`, `mame-0.289.diff`, `README.md`, `AGENTS.md`).
  - Bundled MAME 3rdparty libraries (`zlib`, `lzma`, `flac`, `zstd` under its BSD option) and external libraries (`engine/libdeflate`, `engine/libm`, both MIT) must retain their license files.

## Output Compatibility Contract (`docs/chd/fork-plan.md`)

Check `docs/chd/fork-plan.md` §3 before any change that affects CHD output:

- **Tier R (Reference — default):** Default settings must produce CHDs **byte-identical to unmodified MAME 0.289 `chdman`** (as built on Linux with MAME's bundled codecs and glibc FMA `libm`), regardless of thread count or SIMD vs. non-SIMD build.
  - Never pull code blindly from MAME `master`: post-0.289 lowered LZMA level `8 → 6` and broke Dreamcast GD-ROM layout (`tests/ui/gdrom.spec.js`).
- **Tier C (Compatible — opt-in):** Same CHD SHA-1 and codec list/hunk size as Tier R, but different compressed bytes or non-checksummed metadata (e.g., `--codecplan`, `--libdeflate`, `--keepcue`). Must remain strictly opt-in.
- **Tier X (Extended — opt-in with emulator warnings):** Zstd (`cdzs`/`zstd`), non-default hunk sizes (except PSP `2048`), subcode ingest, sessions (`CHSE`), parent CHDs.
- **Deterministic libFLAC math (`engine/libm/`):** libFLAC's Tukey window (`cosf`) and residual estimation (`log`) depend on the last bits of `libm`. Every engine build (native and wasm) must call `engine/libm/flac_libm.c` (`discpress_cosf`, `discpress_log`, compiled with `-ffp-contract=off`) and **never** the system `libm`, or `music-cd` fails byte-for-byte checks.

## Multi-Core Coroutines & Browser Hooks

Discpress achieves multi-core compression and decompression **without pthreads or `SharedArrayBuffer`** (no COOP/COEP headers required):

- **Resumable C++20 coroutines (`chdman_task` in `chdman.cpp`, no Asyncify):**
  - Compressing commands (`createraw`, `createhd`, `createcd`, `createdvd`, `createld`, `copy`, `compress_common`) and reading commands (`verify`, `extractraw`, `extracthd`, `extractdvd`, `extractcd`) are C++20 coroutines.
  - In the browser (`#ifdef __EMSCRIPTEN__`), `worker.js` calls `chdman_begin` and, while it returns `-1` (paused), awaits `Module.parWait()` or `Module.rdWait()` and calls `chdman_resume`. Natively, `main` runs commands straight through.
- **C++20 native thread pool & browser memory footprint (`chd.h`, `chd.cpp`):** `chd_file_compressor` replaces MAME's `osd_work_queue` with a C++20 `std::thread`/`std::mutex`/`std::condition_variable` worker pool (no 16-thread cap; `-np 1` runs inline with zero worker threads; `hashmap` uses `std::atomic` acquire/release bucket heads; `compress_abort()` stops and joins reader/worker threads cleanly on early error/unwind). Under `#ifdef __EMSCRIPTEN__`, it allocates only 1 `chd_compressor_group` instead of 16 (~30 MiB less memory per browser job worker).
- **Multi-core compression:** `chd_file_compressor` (`chd.cpp`) hands hunks via `wasm/par_lib.js` (`Module.parSubmit`) with per-hunk codec-slot bitmasks (`codec_plan_codecs` for `--codecplan`, `wasm_par_enabled` flags for `--libdeflate`) to helper workers running `wasm_helper_*` (`wasm/wasm_helper.cpp`).
- **Multi-core extract & verify:** Before each buffer's reads, commands `co_await read_ahead(...)`. `chd_file::wasm_read_ahead` (`chd.cpp`, browser-only) reads stored windows in one chunk, dispatches compressed hunks via `wasm_rd_submit` → `Module.rdSubmit` (completed via `wasm_rd_slot`/`wasm_rd_done`), and lets `read_hunk` verify CRCs from memory.
- **Streamed output backpressure:** `wasm_out_full` pauses compression and `read_ahead` while `StreamStore` has > 64 MB unwritten.
- **Exporting C functions:** Any new `extern "C" EMSCRIPTEN_KEEPALIVE` symbol in `wasm/` or `engine/` **must** be added to `-sEXPORTED_FUNCTIONS=...` in `wasm/link.sh`.
- **`wasm/` support files:** `sources.mk` lists compiled engine sources; `shim/SDL2/SDL.h` stubs minimal SDL types; `version.cpp` supplies version strings; `ecm.cpp` implements ECM sector reconstruction reusing `cdrom.cpp`'s word-at-a-time `ecc_generate`.

## Compiler Flags & Reproducible Build Rules

- **Experiment flags:** `make -C wasm ... EXTRA="<flags>"` appends flags to every compile (empty by default).
  - **Never use `-flto`:** yields no measurable speedup and breaks C++ exceptions under `-fwasm-exceptions` (DVD creation dies with an uncaught `WebAssembly.Exception`).
  - **Never use output-changing flags** such as `-ffast-math` (alters FLAC bytes).
- **Pinned Emscripten version (`6.0.10`):**
  - `build.sh` requires exact Emscripten `6.0.10` (commit `d6c521a7f05449857c76bd99e396895583cf2083`) so `.github/workflows/rebuild.yml` reproduces `dist/discpress.html` byte for byte on another machine.
  - `EMSCRIPTEN_ANY=1` allows experimental builds with other versions, but omits `build/engine-sources.sha256` so `scripts/check-dist.sh` and releases refuse the output.
  - `build.sh` fails if the SIMD and non-SIMD Emscripten JS glue differ, and tracks compiler version + `EXTRA` in `.build-stamp` inside `build/obj-wasm*` to clean stale object dirs automatically.
- **Source hash boundary (`scripts/engine-sources.py`):**
  - Hashes `build.sh` plus every tracked or non-ignored file in `engine/` and `wasm/` **except** `*.md`, `engine/FILES`, and `engine/mame-0.289.diff`.
  - Any edit to `build.sh`, `engine/`, or `wasm/` (other than those exclusions) **requires running `./build.sh` with Emscripten `6.0.10` and committing the updated `dist/discpress.html`**.
- **Paths with spaces:** `wasm/sources.mk` (`M := ../engine/mame`) and `build.sh` (`M=../engine/mame O=../build/obj-wasm*`) pass relative paths to GNU Make so checkouts with spaces work natively without a symlink; do not reintroduce `$(abspath ...)` or absolute paths into Make variables.
- **Sanitizers (`scripts/build-sanitized.sh`):** Builds `build/chdman-san` and `build/cdprobe-san` with ASan + UBSan (`-fno-sanitize-recover=undefined`), passed to `ui/engine.spec.js` via `CHDMAN_ENGINE` and `CDPROBE_ENGINE`. On macOS `arm64`, Apple Clang runs ASan + UBSan (`ASAN_OPTIONS=detect_leaks=0`); full LeakSanitizer parity with `tests/support/lsan.supp` runs in `.github/workflows/sanitizers.yml`. Only leaks verified present in unmodified chdman 0.289 belong in `tests/support/lsan.supp`.
