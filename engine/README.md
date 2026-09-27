# The Discpress chdman engine

`engine/mame` holds **chdman from MAME 0.289** (tag `mame0289`, commit `f34f025`) and exactly the parts of MAME it links: 75 source files and the headers they include, listed in [`FILES`](FILES). It is a fork. Discpress builds it with [`wasm/Makefile`](../wasm/Makefile), for the browser (`build.sh`) and natively (`scripts/build-native.sh`), and nothing else from MAME is needed.

The paths mirror MAME's, so every file can be compared with its original. **[`mame-0.289.diff`](mame-0.289.diff)** lists every change the fork makes; Help → About shows it too. Current changes:

- **Browser build:** helper-worker hooks in `chd_file_compressor` (`chd.cpp`, `chd.h`) and in chdman's compress loop (`chdman.cpp`), all under `#ifdef __EMSCRIPTEN__`.
- **`unicode.cpp`/`.h`:** the functions that needed utf8proc are removed; nothing in chdman used them.

## Contents

| Directory | Origin | License |
|---|---|---|
| `src/tools/chdman.cpp` | MAME | BSD-3-Clause |
| `src/lib/util` (18 of MAME's utility files) | MAME | BSD-3-Clause; `md5.h` public domain (Colin Plumb) |
| `src/osd` (core, sync, string conversion, POSIX files) | MAME | BSD-3-Clause |
| `3rdparty/zlib` | zlib 1.3.2, as bundled by MAME | zlib ([`LICENSE`](mame/3rdparty/zlib/LICENSE)) |
| `3rdparty/lzma/C` (`LzmaEnc`, `LzmaDec`, `LzFind`, `CpuArch`) | LZMA SDK 23.01, as bundled by MAME | public domain ([`lzma-sdk.txt`](mame/3rdparty/lzma/DOC/lzma-sdk.txt)) |
| `3rdparty/flac` (libFLAC, 14 files) | FLAC 1.4.3, as bundled by MAME | BSD-3-Clause, Xiph.Org ([`COPYING.Xiph`](mame/3rdparty/flac/COPYING.Xiph)) |
| `3rdparty/zstd/lib` | Zstandard 1.5.5, as bundled by MAME | BSD-3-Clause, chosen from its BSD/GPLv2 dual license ([`LICENSE`](mame/3rdparty/zstd/LICENSE)) |

MAME as a whole is GPL-2.0-or-later, but every MAME file here carries a BSD-3-Clause header (`md5.h`: public domain), so the whole engine is under permissive licenses. The MAME copyright holders are named in each file's header.

## Rules

- **CHDs stay identical to chdman 0.289's.** Unless a change is an explicit, opt-in output tier (see [`docs/chd/fork-plan.md`](../docs/chd/fork-plan.md)), the default output must stay byte-identical to unmodified chdman 0.289. The tests check it against `build/chdman-0.289`, which `scripts/build-upstream.sh` builds from the MAME release with the same compiler flags.
- **`engine/mame` only holds files that come from MAME.** Change them in place, keep MAME's paths, and run `scripts/engine-diff.sh` to refresh `mame-0.289.diff` (`--check` only verifies it). New code goes elsewhere, like the browser glue in [`wasm/`](../wasm).
- **Moving to a newer MAME release:** fetch it (`scripts/fetch-mame.sh`, after changing its commit), apply `mame-0.289.diff` to the new files, copy them over, and check the output against the new upstream build.
