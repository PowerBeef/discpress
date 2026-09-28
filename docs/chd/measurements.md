# CHD codec measurements

Measured on 2026-09-27 for the chdman fork dossier. Everything here can be reproduced with [`lab/lab.sh`](lab/lab.sh); see [lab/README.md](lab/README.md).

**What was measured.** The subject is chdman built from the source Discpress shipped at the time: MAME `76c7d19`, i.e. 0.289 plus 1,167 commits. Codecs were driven through MAME's own classes (`chdcodec.cpp`), linked from `build/obj-native`. Discpress 1.2.1 moved to the 0.289 release, whose only codec difference is LZMA level 8 instead of 6 (§5): LZMA figures shift by about 0.1% in size and LZMA is about 1.35× slower there; everything else is unchanged. The lab scripts now build against the 0.289 pin.

**Build and host.** The native build uses `-O2`, `FLAC__NO_ASM` and `Z7_ST`, as `scripts/build-native.sh` builds it. The host is a 4 vCPU Intel Xeon at 2.1 GHz shared with other jobs. **Timings are per-thread CPU time** (`CLOCK_THREAD_CPUTIME_ID`, or `rusage` for whole processes), so contention mostly cancels out. Wall-clock comparisons are marked as such.

## Test material

No game data was used. The corpora are built by [`lab/build_corpus.py`](lab/build_corpus.py) from freely licensed sources, downloaded locally and never committed.

| Corpus | Contents | Size |
|---|---|---|
| `payload.iso` (2048-byte sectors) | Freedoom 0.13 WADs (BSD-3; classic uncompressed game graphics, sound and maps, 57.6 MB), ~8 MB of ELF shared objects, ~4 MB of Python sources, 8 MB of random bytes (stands in for FMV and other pre-compressed data), 4 MB of zeros (padding files) | 40,668 sectors, 83.3 MB |
| `data_m1.bin` / `data_m2.bin` | the same payload as raw MODE1/2352 and MODE2/2352 (Form 1, PS1-style) sectors with valid EDC/ECC (`tests/fixtures/discgen.py`) | 95.7 MB each |
| `audio.bin` (CD-DA) | Chopin, *Albumleaf* and *Berceuse* (Musopen, CC0); Nine Inch Nails, *999,999* and *Lights in the Sky* (*The Slip*, CC BY-NC-SA 4.0). 24-bit masters resampled to 44.1 kHz / 16-bit with TPDF dither | 48,471 frames, 10.8 min, 114.0 MB |
| `mixed.cue` | Redump-style mixed-mode disc: the MODE2 data track, then the four audio tracks, each with a 2-second INDEX 00 pregap | 210 MB |

These are *representative*, not *real* game discs. Ratios on commercial games will differ; the relative codec economics are what matter here.

## 1. Per-codec economics

Single thread, per-hunk CPU time. "Size alone" is the output size if that codec were the only one. "Hunks won" applies chdman's rule: smallest output wins, ties go to the earlier codec, and a hunk is stored uncompressed if nothing beats it.

**CD data, MODE2 (5,084 hunks of 19,584 bytes, 99.6 MB):**

| Codec | Size alone | Compress MB/s | Decompress MB/s | Hunks won (default set) | Share of default-trial CPU |
|---|---|---|---|---|---|
| `cdlz` | 32.94% | 6.26 | 35.7 | 4,559 | 49.0% |
| `cdzl` | 36.73% | 9.43 | 118.1 | 525 | 32.5% |
| `cdfl` | 90.19% | 16.58 | 190.1 | **0** | 18.5% |
| `cdzs` (zstd level 22) | 35.00% | 2.18 | 173.7 | not in default | not in default |

**CD audio (6,059 hunks, 118.7 MB):**

| Codec | Size alone | Compress MB/s | Decompress MB/s | Hunks won (default set) | Share of default-trial CPU |
|---|---|---|---|---|---|
| `cdlz` | 68.48% | 11.25 | 19.8 | **0** | 48.1% |
| `cdzl` | 83.37% | 34.08 | 141.5 | **0** | 15.9% |
| `cdfl` | 26.57% | 15.02 | 174.4 | 6,059 (all) | 36.0% |
| `cdzs` | 82.97% | 12.58 | 458.4 | not in default | not in default |

**DVD, 2048-byte sectors in 4 KiB hunks (19,293 unique hunks plus 1,041 duplicates, 79.0 MB):**

| Codec | Size alone | Compress MB/s | Decompress MB/s | Hunks won (default set) | Share of default-trial CPU |
|---|---|---|---|---|---|
| `lzma` | 44.51% | 5.62 | 34.7 | 13,847 | 45.0% |
| `zlib` | 47.42% | 15.84 | 125.8 | 2,661 | 16.0% |
| `huff` | 61.40% | 75.07 | 74.4 | 661 | 3.4% |
| `flac` | 88.27% | 7.10 | 150.6 | **76** | 35.6% |
| `zstd` (level 22) | 46.06% | 3.69 | 237.0 | not in default | not in default |

In the DVD run, the 2,048 random-data hunks stay uncompressed.

**Findings:**

- **chdman's default trial is dominated by codecs that lose.** chdman already knows each track's type from the cue, but still runs every codec on every hunk. On audio, `cdlz` and `cdzl` take 64% of the CPU and never win. On data, `cdfl` takes 18.5% and never wins, and `cdzl` takes 32.5% to win 10% of hunks by a few bytes. On DVD, `flac` takes 35.6% to win 0.4% of hunks.
  - The generic `flac` codec is slow on data because it encodes each hunk two or three times (big-endian, little-endian, then the winner again).
  - Lane B measured the same pattern on the synthetic benchmark fixtures.
- **zstd at level 22** (chdman's only zstd setting) is the slowest encoder of all, and never smaller than LZMA overall. It decodes 5–7× faster than LZMA.
- **CD sectors never deduplicate.** Their headers carry the sector address, so no two hunks are identical. On DVD, 5% of hunks were duplicates (the zero padding).

## 2. What smarter codec selection would buy

These figures are computed from the per-hunk data (`lab/analyze.py`). "Size" is the total compressed hunk payload relative to chdman's default rule.

| Corpus | Policy | Size vs default | CPU vs default |
|---|---|---|---|
| CD data | default `cdlz+cdzl+cdfl` | — | 1.00× |
| CD data | oracle (only the eventual winner runs) | identical | 2.09× faster |
| CD data | data tracks: `cdlz` only | **+0.22%** | **2.04× faster** |
| CD data | data tracks: `cdlz+cdzl` (skip `cdfl`) | identical | 1.23× faster |
| CD data | add `cdzs` as a 4th codec | −0.17% | 2.4× slower |
| CD audio | default | — | 1.00× |
| CD audio | audio tracks: `cdfl` only | **identical** | **2.78× faster** |
| DVD | default `lzma+zlib+huff+flac` | — | 1.00× |
| DVD | skip `flac` | **+0.06%** | **1.55× faster** |
| DVD | `lzma+zlib` | +0.24% | 1.64× faster |
| DVD | `lzma` only | +0.64% | 2.22× faster |
| DVD | add `zstd` (level 22) as a 5th codec | −0.36% | 1.7× slower |

A "codec plan per track type" keeps the same codec list in the header, so every existing reader decodes the result. But the output bytes differ from chdman on the hunks where a skipped codec would have won. The audio case is identical here because `cdfl` won every hunk. Digital silence would be the exception to watch, but silent hunks mostly deduplicate anyway.

**Byte-identical alternative: run the likely winner first, and stop other codecs early.** Tie-breaking still follows slot order, so the output is unchanged. This is an estimate that assumes output grows linearly with input consumed:

| Corpus | Trial order | Size | CPU |
|---|---|---|---|
| CD data | `cdlz`, `cdzl`, `cdfl` | identical | 1.21× faster |
| CD audio | `cdfl`, `cdlz`, `cdzl` | identical | 1.65× faster |
| DVD | `lzma`, `zlib`, `huff`, `flac` | identical | 1.24× faster |

How easy this is depends on the library:

- zlib stops by itself when `avail_out` runs out.
- libFLAC can abort from its write callback, at frame granularity.
- The LZMA SDK has a pack-size stop in `LzmaEnc_CodeOneBlock` (used by LZMA2). In the one-shot LZMA1 path, however, the encoder only returns every 128 KB and the range coder buffers 64 KB. Early abort for hunk-sized inputs therefore needs a small SDK patch, which cannot change the bits.

**Measured, as built (milestone 2.4, `engine/README.md`).** CPU time over all threads, `-np 4`, the engine against unmodified chdman 0.289, same bytes every time (4-core Xeon, 2.1 GHz):

| Input | chdman 0.289 | Engine | Less CPU |
|---|---|---|---|
| CD data (`data_m2`, 96 MB) | 30.2 s | 28.5 s | 1.06× |
| CD audio (the music, 114 MB) | 20.4 s | 13.9 s | 1.47× |
| DVD (`payload.iso`, 83 MB) | 30.5 s | 27.8 s | 1.10× |
| Benchmark CD (300 MB, 70% data) | 58.5 s | 50.6 s | 1.16× |
| Benchmark DVD (1 GB) | 211.8 s | 192.0 s | 1.10× |

The gains are below the estimate because codecs don't emit output evenly. Deflate writes a hunk as one block, so it can't stop early. Generic FLAC on 4 KB DVD hunks encodes one frame. CD FLAC stops after the first of its two frames. LZMA stops as soon as its output passes the best result, which is where CD audio gains the most. The DVD figure also includes the generic `flac` codec no longer encoding a third time (milestone 2.2).

## 3. Encoder tuning that every reader can decode

This test used a chdman variant whose encoders are selected by environment variables (`lab/chdcodec-variants.diff`, `lab/flac-variants.diff`). With no variable set it is byte-identical to stock.

**Verification.** Every CHD below passed two independent decoders:

- stock chdman `verify`, i.e. MAME's decoders plus the SHA-1 check;
- a libchdr reader (`rtissera/libchdr@607694c`, dr_flac backend), which decoded every hunk and matched the recorded Data SHA-1.

What each variant changes:

- **LZMA variants** change only encoder-side properties. Dictionary and lc/lp/pb are unchanged, because readers rebuild those rather than read them.
- **FLAC variants** keep the block size, channels and bit depth.
- **Deflate variants** only replace the raw-deflate encoder.

| Variant | CD (`mixed.cue`, 210 MB) | Δ size | CPU | DVD (`payload.iso`, 83 MB) | Δ size | CPU |
|---|---|---|---|---|---|---|
| stock (LZMA level 6, zlib 9, FLAC 8) | 64,296,770 | — | 56.9 s | 35,019,351 | — | 33.4 s |
| LZMA level 9 (fb 64) | 64,188,797 | −0.17% | 59.2 s | 34,995,372 | −0.07% | 33.9 s |
| LZMA level 9, fb 273 | 64,172,233 | −0.19% | 67.9 s | 34,988,923 | −0.09% | 36.1 s |
| LZMA level 9, fb 273, mc 512 | 64,173,556 | −0.19% | 69.7 s | 34,988,945 | −0.09% | 36.6 s |
| libdeflate level 12 for all deflate | 64,239,217 | −0.09% | 75.1 s | 34,754,057 | **−0.76%** | 43.5 s |
| FLAC max LPC order 32 | 64,207,438 | −0.14% | 70.8 s | 35,019,415 | ±0 | 44.0 s |
| FLAC exhaustive model + precision search | 64,108,876 | −0.29% | **695 s** | 35,014,389 | −0.01% | 663 s |
| FLAC precision search (`-p`) | 64,164,215 | −0.21% | 113 s | — | — | — |
| **"Smallest" preset**: LZMA level 9 fb 273 mc 1000 + libdeflate-12 + FLAC `-p` | **63,991,305** | **−0.47%** | 140 s | **34,724,995** | **−0.84%** | 90 s |

**Findings:**

- **Compatible encoder tuning buys about 1% at most.**
  - The best single change is libdeflate on DVD/raw data: −0.76% for about 30% more CPU. The same encoder is also *faster* than zlib at comparable levels.
  - LZMA tuning gains 0.1–0.2%.
  - FLAC `-p` gains 0.2% on CD for 2× CPU, while exhaustive search costs 12× for 0.3%.
  - All together, the "Smallest" preset gives −0.47% (CD) and −0.84% (DVD) for about 2.5× the CPU, and every reader decodes it.
- **The 0.289 → HEAD LZMA level change (8 → 6)** cost about 0.1% in size and made LZMA about 1.35× faster (lane B). Level 9 recovers the size.
- None of these changes is worth breaking byte identity by default. They fit an explicit "smallest" preset.

**Deflate at its limit.** zopfli (15 iterations) is too slow for the full corpus, so it ran on smaller discs built from the same material (`small.cue`: the first 6,000 data frames plus the Chopin *Albumleaf* and NIN *999,999* tracks, 46.6 MB; `small.iso`: the first 12,000 sectors of `payload.iso`, 24.6 MB). Four threads; CPU is the process total. MAME and libchdr decoded every output to the same data SHA-1.

| Deflate encoder | CD (`small.cue`) | Δ size | CPU | DVD (`small.iso`) | Δ size | CPU |
|---|---|---|---|---|---|---|
| zlib level 9 (stock) | 13,482,845 | — | 13.0 s | 8,899,830 | — | 11.1 s |
| libdeflate level 12 | 13,479,960 | −0.02% | 15.3 s | 8,816,313 | −0.94% | 14.7 s |
| zopfli, 15 iterations | 13,479,348 | −0.03% | 455 s | 8,773,999 | −1.41% | 867 s |

zopfli buys another 0.5% on DVD data over libdeflate for 30–60 times libdeflate's CPU time: at most an offline "archive" setting, never a default. On CD it gains almost nothing: LZMA wins about 90% of the data hunks, and deflate wins the rest by only a few bytes (§1).

## 4. Hunk size

Stock chdman with `-hs`; libchdr decoding. "Decode per hunk" is the libchdr CPU time to decode one hunk, i.e. the cost of a random read that misses the hunk cache.

| Media | Hunk | CHD size | vs default | Create CPU | Decode per hunk | Decode per KiB |
|---|---|---|---|---|---|---|
| CD (`mixed.cue`) | 9,792 (4 frames) | 66,072,624 | +2.76% | 52.7 s | 131 µs | 13.8 µs |
| CD | **19,584 (8 frames, default)** | 64,296,770 | — | 57.6 s | 246 µs | 12.9 µs |
| CD | 39,168 (16 frames) | 62,816,445 | −2.30% | 63.2 s | 481 µs | 12.6 µs |
| CD | 78,336 (32 frames) | 61,653,792 | −4.11% | 69.8 s | 923 µs | 12.1 µs |
| DVD (`payload.iso`) | 2,048 | 36,764,688 | +4.98% | 33.7 s | 39 µs | 19.5 µs |
| DVD | **4,096 (default)** | 35,019,351 | — | 32.1 s | 85 µs | 21.2 µs |
| DVD | 8,192 | 33,466,893 | −4.43% | 33.6 s | 177 µs | 22.1 µs |
| DVD | 16,384 | 31,871,468 | **−8.99%** | 33.0 s | 311 µs | 19.4 µs |
| DVD | 32,768 | 30,457,602 | −13.03% | 34.4 s | 586 µs | 18.3 µs |
| DVD | 65,536 | 29,330,656 | **−16.24%** | 36.9 s | 1,157 µs | 18.1 µs |

**Findings:**

- **Hunk size is the largest size lever that stays inside the format.**
  - Every size above decoded correctly in libchdr.
  - Throughput per KiB is flat, so sequential streaming is not slowed. Only a random single-sector read pays for the whole hunk.
- **The ecosystem, not the format, is the constraint.** See [ecosystem-other.md](ecosystem-other.md) §15.2 and [ecosystem-sony-dreamcast.md](ecosystem-sony-dreamcast.md) §8.2:
  - MAME's own `dvdrom_file` accepts **only 2048-byte DVD hunks**, even though chdman's default is 4096.
  - PPSSPP documents `-hs 2048`.
  - rchd rejects hunks over 512 KiB.
  - Small devices budget RAM for the defaults.

## 5. Version drift: Discpress (pinned master) vs the official 0.289 release

MAME was built at tag `mame0289` with the same Makefile, and both builds were run on every fixture in `tests/.cache/fixtures`:

| Fixture | File bytes | CHD SHA-1 | Data SHA-1 |
|---|---|---|---|
| ps1-multitrack, ps1-single, ps1-as-iso, ps1-verified, psp-umd, saturn, saturn-region, segacd, homebrew-iso | **differ** (±0.05% size) | same | same |
| ps2-dvd (`createdvd`) | **differ** | same | same |
| dreamcast-gdi (`aerowings.gdi`) | differ | **differ** | **differ** (GD-ROM layout change, see [optical-media.md](optical-media.md) §5) |

**Root cause of the byte differences.** Commit `c23567b509` (2026-08-04, four days after 0.289) updated the LZMA SDK to 26.02 *and* changed the CHD LZMA level from 8 to 6, "to keep the same dictionary size with updated LZMA SDK". Two checks confirm the level alone is responsible:

- Lanes B and C each showed that the pinned tree with the level set back to 8 reproduces the 0.289 files byte for byte.
- Here, 0.289's code rebuilt with only the new LZMA SDK 26.02 gives files **identical** to official 0.289 on the PS1, Saturn and PS2 fixtures. Lanes A and G also found SDKs 22.01, 23.01 and 26.02 byte-identical at chdman's settings.

The SDK update changes nothing. So the shipped claim of "byte for byte the same as chdman 0.289" is inaccurate. The CHD identity (SHA-1) matches, except for GD-ROM.

**Resolved in Discpress 1.2.1.** The pin is now the `mame0289` tag. Its native build gives files byte-identical to the independent 0.289 build on every fixture above, GD-ROM included, and `tests/ui/gdrom.spec.js` guards the GD-ROM layout.

## 6. Mode 1 vs Mode 2: ECC stripping check

**Hypothesis.** chdman's CD codecs strip regenerable ECC only when `ecc_verify()` passes, and Mode 2 ECC is computed with a zeroed header. PS1 discs might therefore keep 276 bytes of incompressible parity per sector.

**Result: refuted.** The identical payload compresses to 32,695,083 bytes as MODE1 and 32,746,765 bytes as MODE2 (+0.16%). `cdrom_file::ecc_source_byte` already masks the header for Mode 2 (`cdrom.cpp:1363-1367`).

What is still never stripped:

- the 4-byte EDC;
- the Mode 2 subheader;
- whole Form 2 sectors (XA audio and video), which have no P/Q parity to verify.

Stripping these would need a new codec, which no reader has.

## 7. Native vs WebAssembly

This uses the same harness compiled with Emscripten 6.0.10 at `-O3 -fwasm-exceptions`, with and without `-msimd128`, as the app builds it, run in Node 22. It is **wall-clock, best of three runs**, on 1,600-hunk subsets. Throughput is in MB/s.

| Corpus | Codec | Native | wasm SIMD | wasm without SIMD | SIMD vs native |
|---|---|---|---|---|---|
| CD data | `cdlz` compress / decompress | 5.40 / 43.3 | 4.52 / 40.5 | 4.54 / 41.1 | 0.84 / 0.93 |
| CD data | `cdzl` | 4.62 / 121 | 3.61 / 112 | 3.60 / 107 | 0.78 / 0.93 |
| CD data | `cdfl` | 16.7 / 183 | **22.7** / 139 | 12.4 / 132 | **1.36** / 0.76 |
| CD audio | `cdlz` | 11.4 / 21.3 | 8.36 / 20.3 | 8.30 / 20.1 | 0.73 / 0.95 |
| CD audio | `cdfl` | 15.7 / 179 | **24.3** / 151 | 12.0 / 147 | **1.55** / 0.84 |
| CD audio | `cdzs` | 12.0 / 473 | 10.7 / 243 | 10.4 / 236 | 0.89 / 0.51 |
| DVD | `lzma` | 4.98 / 42.4 | 4.09 / 39.7 | 4.02 / 39.8 | 0.82 / 0.94 |
| DVD | `zlib` | 10.3 / 140 | 8.36 / 125 | 8.26 / 123 | 0.81 / 0.89 |
| DVD | `huff` | 66.3 / 79.3 | 35.3 / 90.4 | 34.7 / 61.8 | **0.53** / 1.14 |
| DVD | `flac` | 7.40 / 158 | **9.06** / 118 | 5.13 / 108 | **1.23** / 0.74 |
| DVD | `zstd` | 2.98 / 258 | 2.64 / 157 | 2.63 / 150 | 0.89 / 0.61 |

**Findings:**

- **LZMA and deflate run at 0.73–0.84× native** in the browser. End to end, lane B and the project's own benchmark measured about 1.1× slower overall.
- **FLAC is faster in the SIMD wasm build than in the native reference.** LLVM auto-vectorises libFLAC's LPC loops for SIMD128, whereas the native reference uses gcc `-O2` with FLAC's intrinsics disabled. **Without SIMD, wasm FLAC is about 1.9× slower than with it.** Devices without wasm SIMD (Safari before 16.4) therefore pay most on audio.
- **Huffman encoding is the weakest wasm path (0.53×).** It is a small share of a DVD trial, but the obvious target if `huff` ever matters.
- **Decompression** (extract, verify, identification) runs at 0.5–0.95× native. zstd decoding suffers most.
