# CHD codec lab

These tools produced the numbers in [../measurements.md](../measurements.md). They are research tooling, not part of the app. Keep them working if the fork changes the codec code, because they are the quickest way to measure a codec or encoder change.

| File | What it is |
|---|---|
| `lab.sh` | Entry point: `fetch`, `corpus`, `build`, `harness`, `variants`, `hunks`. Everything is written to `tests/.cache/chd-lab/` (gitignored). |
| `harness.cpp` | Runs chosen codecs on every hunk of a raw CD (2352-byte sectors) or DVD (2048) image through MAME's own `chdcodec` classes. For each hunk it times compression and decompression (per-thread CPU time), verifies the round trip, applies chdman's selection rule and dumps a per-hunk CSV. CD hunks are built as chdman builds them: 2448-byte frames, audio byte-swapped to big endian. Identical hunks are counted once. |
| `analyze.py` | Offline policy analysis on those CSVs: time shares, the oracle, codec-plan policies and the byte-identical early-abort estimate. |
| `build_corpus.py` | Builds the test discs from the fetched, freely licensed material: a game-like data payload as ISO, MODE1/2352 and MODE2/2352, CD-DA music, and a Redump-style mixed-mode cue. |
| `chdcodec-variants.diff`, `flac-variants.diff` | Patches to copies of `chdcodec.cpp`/`flac.cpp` adding environment-selected encoder variants (see below). With no variable set, the result is byte-identical to stock (checked by `lab.sh build`). |
| `run_variants.py` | Creates CHDs with each variant, then checks every file with stock `chdman verify` (MAME decoders + SHA-1) and with a libchdr reader (Data SHA-1). |
| `run_hunks.py` | Hunk-size sweep: size, create CPU and libchdr decode cost per hunk. |
| `chdread.c` | libchdr reader: writes a CHD's logical data to stdout. |

Encoder variants of `chdman-variant`:

| Variable | Values | Effect |
|---|---|---|
| `CHDV_LZMA` | e.g. `level=9,fb=273,mc=512,algo=1,bt=1,hb=4` | LZMA encoder properties. The dictionary and lc/lp/pb stay as decoders rebuild them; the variant warns if they would change. |
| `CHDV_DEFLATE` | `libdeflate:<1-12>`, `zopfli:<iterations>` | Replaces raw deflate everywhere: `zlib`, `cdzl`, and the subcode streams of `cdlz`/`cdfl`. |
| `CHDV_FLAC` | e.g. `lvl=8,e,p,l=32,r=8,a=subdivide_tukey(5)` | libFLAC settings on top of level 8. Block size, channels and depth are unchanged. |
| `CHDV_ZSTD` | level (default 22) | zstd level for `zstd`/`cdzs`. |

**Requirements.**

- `./scripts/build-native.sh` must have been run, for `build/obj-native` and `build/chdman-native`.
- Tools: gcc/g++, cmake, curl.
- Python with numpy, soundfile and scipy.

A full run takes about an hour on 4 cores. The exhaustive-search FLAC variants alone take about 10 minutes of CPU each.

**The corpus.** It comes from Freedoom (BSD-3) and from music under CC0 and CC BY-NC-SA. It is downloaded for local measurement only and must never be committed (see `CLAUDE.md`: no real game data, and nothing we cannot redistribute).
