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
- **Faster ECC with the same results (`cdrom.cpp`, `cdrom.h`):** `ecc_verify` and `ecc_generate` compute P and Q for eight vectors at a time in 64-bit words, instead of a byte at a time from tables of offsets (removed): 3.4 times faster natively. The CD codecs verify every data sector's ECC once per codec they try, and extracting rebuilds it. Checked against an independent byte-at-a-time implementation on 200,000 sectors (all-zero, all-0xFF, random and damaged ones, every mode byte), and CHDs and extracted files equal 0.289's. The page's ECM decoder (`wasm/ecm.cpp`) uses it too.
- **Redump's layout for extracted CDs (`extractcd --redump`, `-rd`; `chdman.cpp`):** a `.cue` with CRLF line ends on any platform, and one `.bin` per track unless there is only one (then `<name>.bin`). That is how Redump's dumps are laid out, so a disc made from one comes back as the same files; the page extracts CDs this way by default. Without the option, output is upstream's.
- **Keeping the cue sheet (`createcd --keepcue`, `-kc`; `chdman.cpp`), opt-in:** the input `.cue` is stored as it is, as metadata (`CUES`) after the CD metadata and without the checksum flag, so neither SHA-1 changes and every reader ignores it; chdman 0.289 reads, verifies and extracts such CHDs as usual. `extractcd --redump` writes that sheet back, with the names of the files it writes, when those are laid out as the sheet's files (one `BINARY` file per track, or one for a single track); otherwise it writes its own. So what a CHD's tracks don't hold comes back: CATALOG, FLAGS, ISRC, INDEX 02 and later, `CDI/2352`. The CHD's bytes then differ from 0.289's (the plan's tier C), which is why it is off by default, in the page too.
- **The codec plan (`createcd`, `createdvd`, `createhd`, `createraw` with `--codecplan`, `-cp`; `chd.cpp`, `chd.h`, `chdcodec.cpp`, `chdman.cpp`), opt-in:** chdman tries every codec in the list on every hunk and keeps the smallest result, though most of them hardly ever win. With the plan, each hunk tries only the codecs meant for what it holds: a CD hunk in audio tracks `cdfl`, one in data tracks `cdlz` (`cdzl` wins about one data hunk in ten, by a few bytes), and a hunk of any other CHD every codec but `flac`. A CD hunk that holds both, or a codec list without those codecs, tries them all. The codec list in the header is unchanged, so every reader decodes the result, and the data and both SHA-1s are the same; the bytes differ where a codec left out would have won (the plan's tier C), so it is off by default. The choice depends only on where a hunk lies, so the CHD is the same at any thread count, and in the page (the codec slots travel with each hunk to the helper workers). Natively, `-np 4`, against the default: CD data 1.8 times less CPU and 0.22% larger, CD audio 1.9 times less and the same size, a mixed CD 2.0 times less and 0.11% larger, a DVD 1.4 times less and 0.06% larger (`docs/chd/measurements.md`).
- **libdeflate for the deflate codec (`--libdeflate`, `-ld` on the same four commands; `chd.h`, `chdcodec.cpp`, `chdman.cpp`), opt-in:** `chd_zlib_compressor`, which does `zlib`, `cdzl` and the subcode of `cdlz`, encodes with [libdeflate](libdeflate/README.md) at its level 9 instead of zlib's level 9: standard raw deflate that every reader decodes with zlib, so the checksums are the same, but not zlib's bytes (tier C). Natively, `-np 4`, CPU: with the default codecs 1.1–1.5 times less and a little smaller; with `-c cdzl,cdfl` (the page's "Faster to create") 1.5–1.8 times less and 0.3–0.7% smaller; with the codec plan on a DVD 1.17 times less than the plan alone, and smaller than chdman's default. Helper workers are told with the codecs (`wasm_par_enabled`'s flags).
- **Fixes to 0.289's failure handling (`chdman.cpp`); output for valid input is unchanged:**
  - `verify` exits 1 when the data doesn't match the header's SHA-1, unless `--fix` corrects it. Upstream exits 0, so scripts and the page reported success.
  - An output is never written over an input: `copy -i x -o x -f` used to truncate `x` and then delete it.
  - `extractcd` of a CHD that isn't a CD, and a unit or sector size of 0, are errors (exit 1). Upstream aborts on `throw nullptr` or divides by zero.
  - A failed or short read of the input of `createraw`, `createhd` or `createdvd` is an error (exit 1). Upstream ignores it, compresses whatever its buffer holds and exits 0, so the CHD silently holds the wrong data; for an unreadable input it can't even open the result.
  - Cue sheets it read wrong, silently: audio in a `MOTOROLA` (big-endian) file was byte-swapped anyway; a file with several tracks after another file was read at offsets carried over from the first file; a `.wav` with several tracks gave the first track all of it. Each now gives the CHD of the same disc laid out plainly, one file per track. 5,676 real Redump cue sheets give upstream's CHDs byte for byte.
  - A descriptor with no tracks, tracks without data (a cdrdao TOC without lengths) or track numbers outside 1–99 is an error (exit 1). Upstream spins forever, aborts or segfaults.
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
