# The Discpress chdman engine

`engine/mame` holds **chdman from MAME 0.289** (tag `mame0289`, commit `f34f025`) and exactly the parts of MAME it links: 75 source files and the headers they include, listed in [`FILES`](FILES). It is a fork. Discpress builds it with [`wasm/Makefile`](../wasm/Makefile), for the browser (`build.sh`) and natively (`scripts/build-native.sh`), and nothing else from MAME is needed.

The paths mirror MAME's, so every file can be compared with its original. **[`mame-0.289.diff`](mame-0.289.diff)** lists every change the fork makes; Help → About shows it too. Current changes:

- **Browser build**, under `#ifdef __EMSCRIPTEN__`:
  - helper-worker hooks in `chd_file_compressor` (`chd.cpp`, `chd.h`);
  - `chd_file::wasm_read_ahead`, which reads a window of stored hunks in one go for `verify` and the extract commands, hands the compressed ones to helper workers, and lets `read_hunk` take them from memory (with the usual CRC check);
  - verify and extract read in 8 MB buffers instead of 32 MB.
- **Resumable commands (`chdman.cpp`):**
  - The commands that compress (`createraw`, `createhd`, `createcd`, `createdvd`, `createld`, `copy`) and `compress_common` are C++20 coroutines (`chdman_task`). So are `verify`, `extractraw`, `extracthd`, `extractdvd` and `extractcd`, which pause while helpers decompress what they are about to read (`read_ahead`).
  - `main` is split into `chdman_start` (parse the command line) and `chdman_continue`.
  - In the browser, the page starts a command with `chdman_begin` and calls `chdman_resume` whenever the compression loop pauses to let helper workers' results arrive. This needs no Asyncify.
  - Natively nothing pauses and `main` runs each command straight through, with the same output, messages and exit codes as upstream.
- **`unicode.cpp`/`.h`:** the functions that needed utf8proc are removed; nothing in chdman used them.
- **Faster codec trials with the same output (`chdcodec.cpp`, `flac.cpp`, LZMA SDK `LzmaEnc.c`):**
  - For each hunk, the codec that won the previous hunk is tried first. Every other codec gets the best size so far as a limit and gives up as soon as its result can't win. As upstream, a codec listed earlier wins a tie, so the chosen codec and the compressed bytes don't change.
  - zlib, zstd and Huffman write into buffers only as large as a winning result. LZMA stops once its output passes that size (a check added to the SDK's encoder loop). FLAC stops after a block whose output passes it.
  - The generic `flac` codec keeps its big-endian encoding in its own buffer instead of encoding it a third time when it wins.
  - FLAC skips the MD5 of the audio when encoding to memory; the MD5 never reaches the CHD.
- **libFLAC's math (`window.c`, `lpc.c`, `fixed.c`):** `cosf` and `log` come from [`engine/libm`](libm/README.md), copies of glibc's algorithms, so CD audio encodes to the same bytes in the page as with chdman on Linux.
- **Faster hashing with the same results (`hashing.cpp`):** SHA-1 reads whole blocks as big-endian words and runs its 80 rounds unrolled. CRC-16 folds in eight bytes at a time (slice-by-8). In wasm, SHA-1 went from 120 to 650 MB/s and CRC-16 from 300 to 1,450 MB/s.
- **Redump's layout for extracted CDs (`extractcd --redump`, `-rd`; `chdman.cpp`):** a `.cue` with CRLF line ends on any platform, and one `.bin` per track unless there is only one (then `<name>.bin`). That is how Redump's dumps are laid out, so a disc made from one comes back as the same files; the page extracts CDs this way by default. Without the option, output is upstream's.
- **Fixes to 0.289's failure handling (`chdman.cpp`); output for valid input is unchanged:**
  - `verify` exits 1 when the data doesn't match the header's SHA-1, unless `--fix` corrects it. Upstream exits 0, so scripts and the page reported success.
  - An output is never written over an input: `copy -i x -o x -f` used to truncate `x` and then delete it.
  - `extractcd` of a CHD that isn't a CD, and a unit or sector size of 0, are errors (exit 1). Upstream aborts on `throw nullptr` or divides by zero.
  - A failed or short read of the input of `createraw`, `createhd` or `createdvd` is an error (exit 1). Upstream ignores it, compresses whatever its buffer holds and exits 0, so the CHD silently holds the wrong data; for an unreadable input it can't even open the result.
  - `dumpmeta` without `-o` prints its banner on stderr, so stdout carries only the metadata.
  - Any other unexpected exception is an error instead of a crash.
  - `tests/ui/engine.spec.js` compares each of these with upstream.

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
| `../libm` (outside `mame/`) | `cosf` and `log` from Arm optimized-routines, for libFLAC | MIT ([`LICENSE`](libm/LICENSE)) |

MAME as a whole is GPL-2.0-or-later, but every MAME file here carries a BSD-3-Clause header (`md5.h`: public domain), so the whole engine is under permissive licenses. The MAME copyright holders are named in each file's header.

## Rules

- **CHDs stay identical to chdman 0.289's.** Unless a change is an explicit, opt-in output tier (see [`docs/chd/fork-plan.md`](../docs/chd/fork-plan.md)), the default output must stay byte-identical to unmodified chdman 0.289. The tests check it against `build/chdman-0.289`, which `scripts/build-upstream.sh` builds from the MAME release with the same compiler flags.
- **`engine/mame` only holds files that come from MAME.** Change them in place, keep MAME's paths, and run `scripts/engine-diff.sh` to refresh `mame-0.289.diff` (`--check` only verifies it). New code goes elsewhere, like the browser glue in [`wasm/`](../wasm).
- **Moving to a newer MAME release:** fetch it (`scripts/fetch-mame.sh`, after changing its commit), apply `mame-0.289.diff` to the new files, copy them over, and check the output against the new upstream build.
