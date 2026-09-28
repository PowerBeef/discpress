# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Discpress is MAME 0.289's `chdman` compiled to WebAssembly and shipped as **one self-contained, offline HTML file** (`dist/discpress.html`) that converts game disc images to/from CHD in the browser, on phones and desktops. It also identifies the console/game and names outputs from a built-in Redump database. The app has no server, no bundler and no npm dependencies; the end-to-end tests and benchmarks in `tests/` (Playwright, see `tests/README.md`) are the only tooling with a `package.json`. There is no linter.

Research for the planned chdman fork (CHD format, chdman internals, disc layouts, emulator compatibility, measurements, roadmap) lives in `docs/chd/`: start with `docs/chd/README.md` and `docs/chd/fork-plan.md`. Check a change against the compatibility contract there before it alters CHD output.

## Commands

```sh
# one-time: Emscripten 6.0.10 (emsdk); the engine source is in engine/ (no MAME checkout needed)
# full build: compiles SIMD and non-SIMD wasm from engine/, links, then assembles
source ~/emsdk/emsdk_env.sh
./build.sh                         # -> build/ (gitignored) and dist/discpress.html; JOBS= optional

# after changing only app/ or db/: no Emscripten needed
python3 scripts/extract-build.py   # once: recovers build/chdman.js + both .wasm from dist/discpress.html
python3 scripts/assemble.py        # [output.html], default dist/discpress.html

# native chdman: the tests' reference, and the engine itself
./scripts/build-upstream.sh        # -> build/chdman-0.289: unmodified MAME 0.289 (fetches it into third_party/mame)
./scripts/build-native.sh          # -> build/chdman-native: engine/ built natively
./scripts/engine-diff.sh           # after changing engine/mame: refresh engine/mame-0.289.diff (--check to verify)

# tests and benchmarks (run from tests/; see tests/README.md)
npm test                           # UI tests on dist/discpress.html; `npm run test:dev` tests app/ as assembled now
npx playwright test ui/convert.spec.js -g ps2 --project=desktop   # a single test
npm run bench -- --quick           # conversion benchmark; `npm run bench:dev -- --compare latest` to compare

# refresh the Redump game database, then re-assemble
./scripts/update-db.sh             # clones libretro-database into third_party/, runs db/mkdb.py -> db/db.json.gz

# README graphics (docs/brand/*.png) from scripts/brand/brand.html; needs Playwright + Chromium
python3 scripts/brand/render.py
```

Compiler experiments: `make -C wasm ... EXTRA="<flags>"` adds flags to every compile (empty by default). Measured with Emscripten 6.0.10: single-threaded conversion is within about 10–12% of native chdman; `-flto` gave no measurable speedup and breaks C++ exceptions under `-fwasm-exceptions` (DVD creation dies with an uncaught `WebAssembly.Exception`), so don't use it. Never use flags that change results (e.g. `-ffast-math` alters FLAC output).

`wasm/Makefile`'s `native` target builds the same sources without `wasm_helper.cpp`: from `engine/` for `build-native.sh`, from unmodified MAME 0.289 (`UPSTREAM=1`) for `build-upstream.sh`. For default settings the app's CHDs must be byte-identical to upstream chdman 0.289's, whatever the thread count or SIMD choice; the tests compare with `build/chdman-0.289` (else `build/chdman-native`). They also match other 0.289 builds that use MAME's bundled codec libraries (distro builds with system FLAC or zlib-ng can differ). That includes CD audio: libFLAC's output depends on the last bits of `cosf` and `log`, so it calls `engine/libm`'s copies of glibc's algorithms in every build (`engine/libm/README.md`). Never let it use the system libm; the `music-cd` fixture fails when the math differs. Don't take engine code from MAME master: post-0.289 master lowered the LZMA level (8 → 6, different bytes) and broke the GD-ROM layout that Dreamcast emulators read (`tests/ui/gdrom.spec.js`).

## Testing workflow

When changing `app/`: `npm run dev-page` (in `tests/`) re-assembles `build/discpress-dev.html` in under a second, `npm run test:dev` runs the suite on it, and `npm run bench:dev -- --compare latest` checks performance. Tests fail on any console error or network request. Review UI changes with the screenshots the layout spec writes to `tests/.cache/screens/<size>/<theme>-<screen>.png`. Once satisfied, `python3 scripts/assemble.py` updates `dist/discpress.html`, which must be committed with the source change. Bugs found but not fixed yet are pinned with `test.fail()` in the relevant spec, or in the `ACCEPTED` list of `tests/ui/a11y.spec.js`; remove the marker when fixing one. Fixtures are synthetic (`tests/fixtures/`); never add real game data to the repo.

The build is reproducible: a clean build must produce a byte-identical `dist/discpress.html` (gzip uses `mtime=0`; `build.sh` fails if the SIMD and non-SIMD JS glue differ). `dist/discpress.html` is committed and is what releases ship, so **regenerate and commit it whenever `app/`, `wasm/` or `db/` change**.

To try the app, open `dist/discpress.html` directly in a browser (`file://` works). Setting `localStorage['chdman-web-debug'] = '{"stage":1}'` makes the worker copy every input into storage with async reads before running, and uses the main-thread CRC; `"stage":2` also makes those reads fail, so the page streams inputs to the worker (the iOS web view path, see below). For tests, `"identDelay"` and `"crcDelay"` (ms) slow identification and its checksum step.

## How the single file is assembled

`scripts/assemble.py` substitutes placeholders in `app/index.html`; each must appear exactly once:

- `/*STYLE*/` ← `app/style.css`; `<!--HELP-->` ← `app/help.html` (with `/*PATCH*/` → the full MAME patch + new files, `/*DBVER*/` → database version)
- `/*UI*/` ← `app/ui.js`, with `/*IDENT*/` inside it replaced by `app/ident.js`
- `/*WORKER*/` ← Emscripten glue `build/chdman.js` + `app/worker.js`, stored as `text/plain` and turned into a Blob URL at runtime
- `/*WASM_SIMD*/`, `/*WASM_BASE*/` ← gzip+base64 wasm; `/*GAMEDB*/` ← base64 `db/db.json.gz` (with `*_SIZE` placeholders)

Consequences: app JS is plain browser script (no modules/imports, ES5-style `var`/functions), and no source may contain `</script` (asserted). `ui.js` picks the SIMD or baseline wasm at runtime via `WebAssembly.validate`.

## Runtime architecture

- **`app/ui.js`** (main thread, one IIFE): job model (files grouped into jobs by descriptor `.cue`/`.gdi`/etc.; a CloneCD `.ccd` is turned into a cue sheet for its `.img` by `ccdToCue`; a `.cso`/`.zso` becomes an input flagged `ciso`, given to chdman as `<name>.iso`), building chdman argument lists per job (`buildJob`), the Advanced tab CLI builder (`CMDS`/`OPT`), OPFS bookkeeping (`Store`), settings, and the `Engine` that runs commands. `Engine.run` starts one **job worker** per chdman command plus N **helper workers** connected to it by `MessageChannel`s. N comes from the thread setting: `'auto'` (default) uses `Tuning`, a one-off per-device speed test (helpers compress synthetic DVD hunks at 1, 2, 3… threads until an extra one adds under 8%; cached in `localStorage['chdman-web-tuning']` keyed by core count + user agent; up to 8 threads on touch devices, 16 elsewhere, regardless of the reported core count), run before the first compressing job; `threadCount()` resolves the setting.
- **Input guard rails** (`app/ui.js`): chdman 0.289 reads descriptors byte for byte with case-sensitive keywords, and loops forever when it finds no tracks. So `descriptorJob` decodes a descriptor itself (`decodeText`: BOM, UTF-16, Windows-1252), and `fixDescriptor` either gives chdman a corrected copy (LF line ends, cue keywords upper-cased; chdman's own one-file-per-track TOC gets `#0` offsets) or refuses the job (`job.invalid`: no tracks, track numbers outside 1–99, TOC lengths chdman can't read). Binary `.toc` files are skipped, raw-sector `.iso` files get an `autoCue`, and a `nan% complete` progress line stops the run (`STALLED`), in the Advanced tab too.
- **`app/worker.js`** (Web Worker, appended to the Emscripten glue): message roles `run` (run a chdman command line with `chdman_begin`/`chdman_resume`), `helper` (compress or decompress hunks for the job worker), `reader` (open a CHD and serve sectors for identification) and `crc`. It mounts a custom Emscripten filesystem (`makeFS`) over storage backends: `BlobStore` (read inputs in place via `FileReaderSync`), `OpfsStore` (outputs to Origin Private File System), `MemStore` (fallback), `CisoStore` (a CSO v1/v2 or ZSO compressed ISO read as the ISO inside, over any of the others: deflate blocks through the wasm's `wasm_inflate_raw`, LZ4 in JS; also used by the `reader` and `crc` roles to identify it), and `StreamStore` (outputs streamed to a user-chosen folder: `s-*` messages handled by `makeSink` in `ui.js` via the File System Access API). When a worker can't read picked files (some iOS file-viewer web views), it sends `stage-request` and the page streams chunks (`stage-chunk`/`stage-ack`/`stage-end`).
- **Multi-core compression** doesn't use pthreads/SharedArrayBuffer (so no COOP/COEP headers are needed). The engine has hooks in `chd_file_compressor` (`engine/mame/src/lib/util/chd.cpp`); `wasm/par_lib.js` (Emscripten JS library) hands hunks to `Module.parSubmit`, and helper workers run a second wasm instance whose `wasm_helper_*` exports (`wasm/wasm_helper.cpp`) compress hunks exactly as `chd_file_compressor` would. The commands that compress are C++20 coroutines (`chdman_task` in `chdman.cpp`, no Asyncify): the worker starts a command with `chdman_begin` and, while it returns -1 (paused after a compression step), awaits `Module.parWait()` and calls `chdman_resume`; natively `main` runs them straight through. New exported C functions must be added to `EXPORTED_FUNCTIONS` in `wasm/link.sh`.
- **Multi-core extract and verify** work the same way in reverse. `verify` and the extract commands are coroutines too, and before each buffer's worth of reading they `co_await read_ahead(...)`. `chd_file::wasm_read_ahead` (`chd.cpp`, browser only) reads the stored data of that window and the next in one file read (small reads are expensive in the browser). It hands codec-compressed hunks to helpers (`wasm_rd_submit` → `Module.rdSubmit`; results come back through `wasm_rd_slot`/`wasm_rd_done`), and pauses the command until the window is in (`Module.rdWait()`). `read_hunk` then serves hunks from memory with chdman's usual CRC check, so errors are unchanged. With one thread it keeps the window's compressed bytes and decompresses them when read. Verify and extract jobs get `readHelpers()`: the thread setting, but at most one fewer than the cores, since the job worker stays busy.
- **Game identification** (`app/ident.js`, runs on the main thread): reads boot data (IP.BIN, SYSTEM.CNF, PARAM.SFO, …) via ISO 9660 from raw images, or from inside CHDs via the worker `reader` role backed by `wasm_probe_*` in `wasm_helper.cpp`; matches serial, or size + CRC-32 (computed in a worker with zlib's `crc32` exported from the wasm, JS fallbacks in the worker and on the page), against the database. Identification is two-phase: once console/serial/sizes are known, `onProvisional` lets a conversion start (`job.identKnown`); the checksum then confirms the exact release and `renameOutputs` renames finished results if it differs (not when results were already saved, named by the user, or written straight into a folder, which waits for the checksum). `db/db.json.gz` is `{version, systems: {key: "name\tserial\tsize\tcrc\ttrack\text" rows}}`; system keys in `db/mkdb.py` must match `SYSTEMS` in `ident.js`.
- **`engine/`** (see `engine/README.md`): the chdman fork. `engine/mame` holds MAME 0.289's chdman and exactly the MAME sources it links (`engine/FILES`), at MAME's paths. Change them in place, then run `scripts/engine-diff.sh`: `engine/mame-0.289.diff` lists every change and is shown in Help → About. New code goes outside `engine/mame`. `scripts/fetch-mame.sh` fetches the unmodified release for the diff and for `build-upstream.sh`.
- **`wasm/`**: `sources.mk` lists the engine sources that are compiled; `shim/SDL2/SDL.h` stubs the only SDL calls chdman needs; `version.cpp` supplies the version strings.

## Releases

`.github/workflows/release.yml` attaches the committed `dist/discpress.html` to a GitHub release. It runs on a `v*` tag push, a published release, or manually (Actions → Release → Run workflow with a tag). If `.github/release-notes/<tag>.md` exists it becomes the release notes (and replaces existing notes on re-run); otherwise notes are auto-generated. The README's download button points at `releases/latest/download/discpress.html`.
