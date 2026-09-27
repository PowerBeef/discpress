# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Discpress is MAME 0.289's `chdman` compiled to WebAssembly and shipped as **one self-contained, offline HTML file** (`dist/discpress.html`) that converts game disc images to/from CHD in the browser, on phones and desktops. It also identifies the console/game and names outputs from a built-in Redump database. There is no server, no bundler, no npm, and no test suite or linter.

## Commands

```sh
# one-time: Emscripten 6.0.10 (emsdk), then the pinned MAME source + browser patch
./scripts/fetch-mame.sh            # -> third_party/mame (sparse checkout of MAME 76c7d19, applies wasm/mame.patch)

# full build: compiles SIMD and non-SIMD wasm, links, then assembles
source ~/emsdk/emsdk_env.sh
./build.sh                         # -> build/ (gitignored) and dist/discpress.html; JOBS=, MAME_DIR= optional

# after changing only app/ or db/ (requires build/chdman.js, chdman.wasm, chdman-nosimd.wasm from a prior full build)
python3 scripts/assemble.py        # [output.html], default dist/discpress.html

# refresh the Redump game database, then re-assemble
./scripts/update-db.sh             # clones libretro-database into third_party/, runs db/mkdb.py -> db/db.json.gz

# README graphics (docs/brand/*.png) from scripts/brand/brand.html; needs Playwright + Chromium
python3 scripts/brand/render.py
```

`wasm/Makefile` also has a `native` target (`T=native`) that builds a native `chdman-native` from the same objects, useful for comparing output against the wasm build.

The build is reproducible: a clean build must produce a byte-identical `dist/discpress.html` (gzip uses `mtime=0`; `build.sh` fails if the SIMD and non-SIMD JS glue differ). `dist/discpress.html` is committed and is what releases ship, so **regenerate and commit it whenever `app/`, `wasm/` or `db/` change**.

To try the app, open `dist/discpress.html` directly in a browser (`file://` works). Setting `localStorage['chdman-web-debug'] = '{"stage":true}'` forces the input-staging fallback path and main-thread CRC (see below); `"stage":2` makes staging fail.

## How the single file is assembled

`scripts/assemble.py` substitutes placeholders in `app/index.html`; each must appear exactly once:

- `/*STYLE*/` ← `app/style.css`; `<!--HELP-->` ← `app/help.html` (with `/*PATCH*/` → the full MAME patch + new files, `/*DBVER*/` → database version)
- `/*UI*/` ← `app/ui.js`, with `/*IDENT*/` inside it replaced by `app/ident.js`
- `/*WORKER*/` ← Emscripten glue `build/chdman.js` + `app/worker.js`, stored as `text/plain` and turned into a Blob URL at runtime
- `/*WASM_SIMD*/`, `/*WASM_BASE*/` ← gzip+base64 wasm; `/*GAMEDB*/` ← base64 `db/db.json.gz` (with `*_SIZE` placeholders)

Consequences: app JS is plain browser script (no modules/imports, ES5-style `var`/functions), and no source may contain `</script` (asserted). `ui.js` picks the SIMD or baseline wasm at runtime via `WebAssembly.validate`.

## Runtime architecture

- **`app/ui.js`** (main thread, one IIFE): job model (files grouped into jobs by descriptor `.cue`/`.gdi`/etc.), building chdman argument lists per job (`buildJob`), the Advanced tab CLI builder (`CMDS`/`OPT`), OPFS bookkeeping (`Store`), settings, and the `Engine` that runs commands. `Engine.run` starts one **job worker** per chdman command plus N **helper workers** connected to it by `MessageChannel`s.
- **`app/worker.js`** (Web Worker, appended to the Emscripten glue): message roles `run` (execute `callMain` with args), `helper` (compress hunks for the job worker), `reader` (open a CHD and serve sectors for identification) and `crc`. It mounts a custom Emscripten filesystem (`makeFS`) over storage backends: `BlobStore` (read inputs in place via `FileReaderSync`), `OpfsStore` (outputs to Origin Private File System), `MemStore` (fallback), and `StreamStore` (outputs streamed to a user-chosen folder: `s-*` messages handled by `makeSink` in `ui.js` via the File System Access API). When a worker can't read picked files (some iOS file-viewer web views), it sends `stage-request` and the page streams chunks (`stage-chunk`/`stage-ack`/`stage-end`).
- **Multi-core compression** doesn't use pthreads/SharedArrayBuffer (so no COOP/COEP headers are needed). `wasm/mame.patch` adds hooks in `chd_file_compressor` and chdman's `compress_common`; `wasm/par_lib.js` (Emscripten JS library) hands hunks to `Module.parSubmit` and suspends chdman with **Asyncify** in `wasm_par_yield`; helper workers run a second wasm instance whose `wasm_helper_*` exports (`wasm/wasm_helper.cpp`) compress hunks exactly as `chd_file_compressor` would. Asyncify-instrumented functions are listed in `wasm/link.sh` (`ASYNCIFY_ADD`); new exported C functions must be added to `EXPORTED_FUNCTIONS` there.
- **Game identification** (`app/ident.js`, runs on the main thread): reads boot data (IP.BIN, SYSTEM.CNF, PARAM.SFO, …) via ISO 9660 from raw images, or from inside CHDs via the worker `reader` role backed by `wasm_probe_*` in `wasm_helper.cpp`; matches serial, or size + CRC-32 (computed in a worker), against the database. `db/db.json.gz` is `{version, systems: {key: "name\tserial\tsize\tcrc\ttrack\text" rows}}`; system keys in `db/mkdb.py` must match `SYSTEMS` in `ident.js`.
- **`wasm/`**: `sources.mk` lists exactly which MAME `lib/util`, OSD and 3rdparty sources are compiled; `shim/SDL2/SDL.h` stubs the only SDL calls chdman needs; `version.cpp` supplies the version strings. Keep every MAME change inside `wasm/mame.patch` (it is also displayed in Help → About); `scripts/fetch-mame.sh` pins the MAME commit.

## Releases

`.github/workflows/release.yml` attaches the committed `dist/discpress.html` to a GitHub release. It runs on a `v*` tag push, a published release, or manually (Actions → Release → Run workflow with a tag). If `.github/release-notes/<tag>.md` exists it becomes the release notes (and replaces existing notes on re-run); otherwise notes are auto-generated. The README's download button points at `releases/latest/download/discpress.html`.
