# G: Encoder technology and platform acceleration for a Discpress `chdman` fork

> Part of the [Discpress chdman research dossier](README.md), 2026-09-27. Written by a research agent from source reading and experiments. `$SP/...` paths name artefacts in the temporary research workspace, which is not part of the repository (reproducible lab tooling is in [lab/](lab/)). Lane letters (A, B, C, D1, D2, E, G) refer to the reports listed in the README.

Lane G of the fork dossier. Written 2026-09-27.

**Scope.** This report covers two things:
- encoders that could make CHD creation faster or the files smaller while every existing CHD reader can still decode the output;
- the acceleration options open to a browser (WebAssembly) encoder.

**Subject.** Discpress's pinned MAME source, commit `76c7d197ed`. That is a post-0.289 master snapshot from 2026-09-27, not the `mame0289` tag; see §1.3. Nothing under `/home/user/discpress` was modified.

**Evidence labels.** Every claim carries one of these tags:
- **[exp]**: my own measurement. The harnesses and raw logs are under `$SP/exp/`, where `$SP` = `$SP`.
- **[code]**: read in the source, with the location given.
- **[doc]**: taken from the cited documentation.
- **[unverified]**: plausible but not checked.

---

## 0. Summary

1. **The format leaves the encoder surprisingly little room, except in hunk size.**
   - Within the existing codecs, parameter changes gain at most about 0.5% on typical data:
     - LZMA `fb`/`mc` settings;
     - better Deflate encoders;
     - FLAC `-p`/`-e`.
   - The exception is very compressible data, where gains reach about 5%.
   - Hunk size is a header parameter every reader honours. Raising it gains 4–18% (§11.5). Readers do impose caps; see D1/D2 and §11.5.
2. **Speed is where the headroom is.** Every hunk tries every codec. In today's time budget:
   - FLAC takes about 19% of CPU on CD data tracks and never wins there;
   - LZMA plus Deflate take about 60% on CD audio tracks and never win there;
   - the double FLAC encode takes about 36% on DVD hunks.

   Simple per-hunk gating plus libdeflate should give about **1.6× on CD data, 2.5× on CD audio and 1.6× on DVD** at a size change of 0 to +0.05%. Some wins are strictly byte-identical and change nothing:
   - early termination;
   - turning off FLAC's MD5;
   - a faster SHA-1.
3. **libdeflate beats zlib for the Deflate trial.**
   - Level 9 is 2–3× faster at the same size. The exception is very compressible data (`img`), where it is +0.13% on the whole image.
   - Level 12 was smaller on every class: 0–4% of Deflate output (about 0 on incompressible data), and up to −2.1% on the whole image for 4 KiB text hunks.
   - Level 10 costs about the same as zlib -9 on binaries and is 1–3% smaller, except on very compressible data.
   - zlib-ng and Chromium's zlib are dominated by it.
   - zopfli is 20–40× slower than libdeflate-12 for a further 0.5–2.7%.
4. **LZMA: the decoders pin only lc=3/lp=0/pb=2.** Dictionary, `fb`, `mc`, match finder and end marker are all free.
   - I checked this against three decoder implementations: MAME/LZMA SDK, libchdr and RetroArch's new clean-room `rchd`.
   - The SDK encoder at `fb=273, mc=1000` is the best compatible LZMA I found. xz/liblzma is no better.
   - SDK 22.01, 23.01 and 26.02 give byte-identical output. 16.04 does not.
5. **The SHA-1 is slow.**
   - MAME's SHA-1 is about 3× slower than a plain unrolled SHA-1 natively and about 5× slower in wasm (about 80 vs 350–580 MB/s).
   - Discpress runs the whole-image SHA-1 serially in the job worker. That caps throughput at about 80 MB/s, which a 16-thread desktop reaches.
6. **New finding: Discpress's CD-audio (`cdfl`) output is not byte-identical to its own native reference build.**
   - With Discpress's own `build/chdman.wasm`, a CUE/BIN made from a CC0 piano track gives 3,958,167 bytes.
   - `build/chdman-native` gives 3,958,171 bytes. The data SHA-1s are identical.
   - **Cause: libm.** Emscripten's `cosf` differs from glibc's in 1 ULP on 1.2% of the window points libFLAC evaluates.
   - Separately, libFLAC's NEON (ARM64) and SSE2 autocorrelation sums in a different order from the C path. So official chdman builds disagree across platforms too.
7. **The SIMD128 build pays off only for FLAC.**
   - libFLAC runs about 2× faster with `-msimd128`.
   - LZMA, zlib, libdeflate and zstd show no measurable change.
8. **Platform notes.**
   - JSPI became Baseline on 2026-09-14 (Chrome 137, Firefox 153, Safari 27), so Asyncify can eventually go. The gain is small and needs a fallback.
   - Relaxed SIMD and Memory64 are still missing in Safari and are of no use to these codecs.
   - Shared-memory threads are out for a `file://` app.
   - WebGPU is not a fit.
   - WebKit caps `navigator.hardwareConcurrency` at **4 (fewer than 8 cores) or 8**. An iPhone reports 4 for its 6 cores (2P+4E).

---

## 1. What "decodable by existing readers" means

### 1.1 Decoder constraints per codec

The readers checked were:
- MAME `chd_*_decompressor`, commit 76c7d19;
- libchdr `rtissera/libchdr@607694c` (2026-09-27; bundles LZMA SDK 26.02, miniz 3.1.2, zstd 1.5.7 and dr_flac 0.13.4, with micro-flac optional);
- rchd, `libretro/libretro-common@92d38df` (`formats/chd/rchd.c`), which D2 identifies as RetroArch's default reader since 2026-07.

| Codec | What the readers do | Pinned for the encoder | Free for the encoder |
|---|---|---|---|
| `zlib` / `cdzl` | MAME calls `inflateInit2(-15)`, requires `Z_STREAM_END` and exactly `destlen` out (`chdcodec.cpp:970-1021`). libchdr requires `tinfl_decompress` to reach `TINFL_STATUS_DONE` with `out==destlen` (`src/libchdr_codec_zlib.c`). rchd uses `rinflate(-15)` and needs `wr==dst_len` (`rchd.c:2062-2088`). [code] | Raw Deflate (no zlib or gzip wrapper); a single stream per hunk that ends exactly at the hunk size | Any valid RFC 1951 stream: any block structure, strategy, window (at most 32 KiB, and hunks are smaller) or encoder |
| `lzma` / `cdlz` | No properties are stored. MAME rebuilds them by running `LzmaEncProps_Normalize(level=6, reduceSize=hunkbytes)` → `LzmaEnc_WriteProperties` and decodes with `LzmaDec_DecodeToBuf(..., LZMA_FINISH_END)`; it requires `consumed==complen` and `decoded==destlen` (`chdcodec.cpp:1330-1397`). libchdr hard-codes props byte `93` (lc=3, lp=0, pb=2), derives the dictionary from the hunk size and decodes **into the output buffer** (`dicBufSize = destlen`) (`src/libchdr_codec_lzma.c`). rchd rebuilds `(2*5+0)*9+3` with a power-of-two dictionary and stops when `pos==dst_len`, never reading further (`rchd.c:1317-1334`, `7z/r7z_lzma.c:344-800`). [code] | **lc=3, lp=0, pb=2**; one raw LZMA1 stream, no header | Dictionary size (distances can never reach past the hunk start), `fb`/nice_len, `mc`/depth, match finder (bt2/bt3/bt4/hc4/hc5), parser (normal or fast), encoder implementation. An end marker is optional: all three decoders accept it [exp §5.5]. |
| `flac` / `cdfl` | The decoder builds a STREAMINFO with `min=max=blocksize(hunk)`: 2352 for CD, and for the generic codec `hunk/4` halved until it is 2048 or less. It also sets 44.1 kHz, 2 channels, 16-bit. `cdfl` finds the subcode by the byte count the FLAC decoder consumed. [code] dr_flac rejects frames larger than the STREAMINFO maximum (`dr_flac.h:5568`) and **Rice partition orders above 8** (`:4869`). rflac, rchd's dr_flac derivative, has the same checks (`rflac.c:2672`). [code] | Every frame's blocksize must be at most the synthesized maximum; partition order at most 8; 16-bit stereo; no metadata; the generic codec's 1-byte `L`/`B` endianness prefix | LPC order up to 32, qlp precision and search, apodization windows, exhaustive model search, stereo decorrelation, and smaller frames. Frames of 4704 samples fail 642 of 642 in dr_flac [exp]. |
| `zstd` / `cdzs` | `ZSTD_initDStream`, then `ZSTD_decompressStream` until the output is full, with no dictionary (MAME `chdcodec.cpp:1126-1146`, libchdr `libchdr_codec_zstd.c`). rchd requires exactly one frame with no trailing bytes and a window of at most 2^27 (D2 §, `rzstd.h:130-178`). [code] | Standard frames only (not magicless); no dictionary ID; a single frame per hunk or sub-stream | Level and strategy parameters, the content-size flag, and the checksum flag (inside the frame). Long-distance matching does nothing within a hunk of 1 MiB or less. |
| `huff` | MAME's 8-bit Huffman with the tree serialized in the stream. [code] | The bitstream format | The tree construction (§8) |

Four codecs per CHD is the header limit. The CD default uses three (`cdlz`, `cdzl`, `cdfl`), so one slot is free. The DVD, HD and raw default uses all four (`lzma`, `zlib`, `huff`, `flac`) [code `chdman.cpp:671-673`]. A reader that does not know a listed codec refuses to open the file (libchdr, MAME). rchd fails only the affected hunks (D2).

### 1.2 Verification performed

- **LZMA and Deflate.** I checked 18 encoder variants, in CD and DVD geometry, on 4 data classes, 120 hunks each: 144 combinations and about 17k streams. Every stream was decoded by three decoder styles:
  - MAME style: zlib `inflate` raw, and LZMA SDK 26.02 `LzmaDec_DecodeToBuf` with level-derived props;
  - libchdr style: miniz `tinfl`, and `LzmaDec_DecodeToDic` into the destination;
  - rchd style: libretro `rinflate`, and `r7z_lzma`.

  **There were 0 failures** (`$SP/exp/res/verify3.txt`) [exp]. The variants covered:
  - LZMA SDK at levels 6 and 9, `fb` 273 with `mc` 1000, bt2 and the fast parser;
  - the SDK with an **end marker**;
  - xz/liblzma LZMA1EXT (no end marker) at presets 6 and 9e/273;
  - zlib -9, zlib-ng -9, Chromium zlib -9;
  - libdeflate levels 1, 6, 9 and 12;
  - zopfli;
  - zstd 19 and 22, which were checked with the zstd decoder only.
- **FLAC.** These settings all decode bit-exactly with libchdr's dr_flac wrapper, with the synthesized STREAMINFO (maximum 2352) and the correct consumed-byte count for the subcode offset:
  - `-8`, `-8p`, `-8ep`, `-8 -l32`;
  - `-A subdivide_tukey(5) -l32 -p`.

  Tested on 642 CD hunks each (`drflac_check.c`) [exp].

### 1.3 Library versions and byte identity across MAME versions

| | ≤0.250 | 0.255–0.260 | 0.265–0.289 (tag `f34f025`) | Pinned 76c7d19 (post-0.289) |
|---|---|---|---|---|
| LZMA SDK | 16.04 | 22.01 | 23.01 | **26.02** |
| chdman LZMA `level` | 9 (0.250) | 8 | 8 | **6** (commit `c23567b509`, per report B) |
| zlib | 1.2.11–1.2.12 | 1.2.12 | 1.3–1.3.1 | 1.3.2 |
| libFLAC | **1.2.1** (level 8 includes `-e`) | 1.2.1 | 1.4.3 | 1.4.3 |
| zstd | – | – | 1.5.5 (zstd arrived in 0.262 per D1) | **1.5.7** |

Rows are from `git show <tag>:3rdparty/...` [code].

Output identity, measured with chdman's parameters on my corpus [exp]:
- **LZMA.**
  - SDK 16.04 differs from 22.01, which is **identical** to 23.01 and 26.02. I tested levels 6 and 8.
  - The version history records "minor changes in compression ratio" in 18.06 [doc `3rdparty/lzma/DOC/lzma-history.txt`].
  - At chdman's hunk sizes, level 8 equals level 9, which equals level 6 with `fb=64, mc=48`, because the dictionary is clamped to the hunk. The only data-track difference between the 0.289 release and the pinned build is therefore level 8 versus 6. This agrees with reports B and C.
- **Deflate.** zlib 1.2.11 = 1.2.12 = 1.3 = 1.3.1 = 1.3.2, byte for byte, at chdman's `-9`, raw, `memLevel` 8.
- **zstd.** 1.5.5 ≠ 1.5.7 at chdman's level 22. 1.5.7 is 0.2–0.3% smaller.
- **libFLAC.** 1.4.3 = 1.5.0 at `-8` on 1,204 audio hunks, for both the C and the SSE builds. 1.2.1 and 1.4.x differ by construction: the level 8 table changed.

---

## 2. Method

### 2.1 Corpus

All data is non-proprietary; nothing from a game.

| Class | Content | Size | Why |
|---|---|---|---|
| `bin` | 256 KiB slices of x86-64 `.so` files (`/usr/lib/x86_64-linux-gnu`) | 16 MiB | executables and tables |
| `txt` | Python stdlib source | 8 MiB | scripts and text |
| `img` | Raw pixels from PNG icons (RGB555 or 8-bit paletted) | 6 MiB | graphics; **atypically compressible (about 3–4%)** |
| `cmp` | Concatenated `.gz` documentation | 4 MiB | incompressible; stands in for FMV and ADPCM streams |
| `piano` | CC0 *Open Goldberg Variations*, Var. 4 (K. Ishizaka, archive.org `OpenGoldbergVariations`), 96k/24 → 44.1k/16 with TPDF dither | 68.6 s | acoustic CD-DA |
| `synth` | Synthetic loud electronic mix (drums, bass, pads, soft-clipped) | 60 s | "mastered" CD-DA |

**CD data geometry.** Each hunk is 8 frames, 18,816 bytes of sector data after chdman's front end. I synthesized Mode 1 sectors in exactly the layout the compressors see after ECC stripping:
- the sync bytes zeroed;
- the MSF header;
- 2,048 user bytes;
- 4 EDC-like bytes;
- 284 zero bytes (the 8 reserved bytes plus the zeroed P/Q parity).

The 768-byte subcode (zeros) deflates to 9 bytes for every codec and was left out. **CD audio geometry**: 4,704 samples per hunk. For the LZ codecs the samples are stored big-endian, as in a CHD. **DVD geometry**: 4,096-byte hunks, the chdman default.

### 2.2 Tools

All sources are in `$SP/exp/h/`:
- `enc_bench.c`: per-hunk encoding plus the three decoder checks;
- `flac_bench.c`: libFLAC with chdman's exact settings;
- `lzcmp.c`, `zcmp.c` and `zstd155/zc.c`: version identity;
- `hash/`: hashing;
- `wasm*/`: Emscripten 6.0.10 builds run in Node 22.22;
- `cdtest/runwasm2.js`: drives Discpress's own `build/chdman.js` under Node, single-threaded.

**Caveat on timings.** The host was a 4-vCPU Intel Xeon (Sapphire Rapids class, AVX-512, SHA-NI) shared with other agents, at load average 5–16. Native timings are **process CPU time**. Wasm timings are wall clock, run back to back with their comparison. Treat the absolute MB/s as pessimistic; the ratios are what matter.

---

## 3. Where compression time goes today

Native CPU time with chdman's settings. libFLAC has MD5 enabled, as in chdman (`flac.cpp:78` leaves `set_do_md5(false)` commented out) [exp]:

| Content | LZMA | Deflate | Huffman | FLAC | Other per hunk |
|---|---|---|---|---|---|
| CD data (`bin`) | 52% | 29% | – | 19% (`cdfl` on data sectors, never wins) | ECC verified twice (`cdlz` and `cdzl`): 8.1 µs/sector, about 2.5%; SHA-1 + CRC16 about 3–6% |
| CD audio (`piano`) | 47% | 13% | – | 40% | |
| DVD (`bin`, 4 KiB) | 46% | 14% | 4% | 36% (LE+BE; chdman does 2–3 encodes, so the real share is higher) | |

Which codec wins [exp; `$SP/exp/res/analysis_*.txt`]:

| | lzma/cdlz | zlib/cdzl | huff | flac/cdfl | Notes |
|---|---|---|---|---|---|
| CD `bin` | 1012 | 12 | – | 0 | Skipping `cdzl` costs +0.014% |
| CD `txt` | 512 | 0 | – | 0 | |
| CD `img` | 348 | 36 | – | 0 | Skipping `cdzl` costs +0.35% |
| CD `cmp` | 0 | **256** | – | 0 | Skipping `cdzl` costs **+0.90%**: LZMA overhead on high-entropy data |
| CD audio (1,204 hunks) | 0 | 0 | – | **1204** | Digital silence: FLAC 32 B, Deflate 34+3 B, LZMA 57+3 B |
| DVD `bin` (4,096) | 3662 | 302 | 11 | **112** | Dropping FLAC costs **+0.49%**; dropping Huffman +110 B |
| DVD `txt` (2,048) | 363 | **1685** | 0 | 0 | Deflate beats LZMA on 4 KiB text |
| DVD `img` (1,536) | 830 | 606 | 0 | 100 | Dropping FLAC costs +0.23% |
| DVD `cmp` (1,024) | 6 | 16 | 0 | 0 | 1,002 hunks stored |

---

## 4. Deflate (raw) encoders

### 4.1 Results

Ratios are compressed/original in %. Times are relative to zlib -9, which is chdman. Complete runs [exp]:

| Encoder | CD bin | CD txt | CD img | CD cmp | DVD bin | DVD txt | DVD img |
|---|---|---|---|---|---|---|---|
| **zlib 1.3.2 -9** (chdman: `deflateInit2(9, -15, 8, Z_DEFAULT_STRATEGY)`) | 41.582 (1.00×) | 24.487 | 3.462 | 87.751 | 50.773 | 30.899 | 4.086 |
| zlib -9, `memLevel` 9 | 41.582 | – | – | – | 50.773 | 30.899 | – |
| zlib -6 | 41.740 (0.41×) | 24.668 (0.41×) | 3.741 | 87.792 | 50.813 (0.80×) | 30.986 | 4.328 |
| zlib -9 `Z_FILTERED` | 44.937 | – | – | – | 54.619 | – | – |
| zlib-ng 2.3.3 -9 (compat and native produce **identical** bytes) | 41.599 (0.66×) | 24.565 (0.63×) | 3.461 | 87.771 | 50.775 (0.78×) | 30.899 (0.77×) | 4.086 |
| zlib-ng -6 | 42.764 (0.24×) | 24.657 | 3.780 | 87.769 | 52.122 (0.61×) | 30.861 | 4.396 |
| Chromium zlib -9 (default ANZAC++ 4-byte hash) | 42.543 (0.58×) | 24.416 | – | – | – | – | – |
| **libdeflate 1.26 -6** | 41.474 (**0.15×**) | 24.494 (0.18×) | 3.810 | 87.723 | 50.732 (0.33×) | 30.670 (0.38×) | 4.465 |
| **libdeflate -9** | 41.377 (**0.31×**) | 24.241 (0.49×) | 3.483 | 87.746 | 50.684 (0.47×) | 30.536 (0.69×) | 4.107 |
| **libdeflate -10** | 40.815 (0.98×) | 23.722 (2.1×) | 3.508 | 87.702 | 50.242 (1.5×) | 30.141 (3.3×) | 4.167 |
| libdeflate -12 | 40.777 (2.6×) | 23.671 (5.2×) | 3.320 (12.9×) | 87.720 | 50.211 (2.9×) | 30.084 (6.6×) | 3.972 (18.9×) |
| zopfli (15 iterations), first 256 hunks* | 36.346 vs 37.269 (zlib) and 36.537 (ldf-12) | 23.221 / 24.298 / 23.413 | 3.325 / 3.570 / 3.417 | 87.690 / 87.751 / 87.720 | 51.846 / 52.818 / 52.206 | 29.704 / 30.821 / 29.838 | 4.713 / 5.059 / 4.867 |

\*zopfli speed: 0.05–0.14 MB/s. That is roughly **100× zlib -9 and 20–40× libdeflate-12**. With 1 iteration it is only about 25% faster.

### 4.2 What the choice does to the final file

This is the Deflate-trial replacement effect on the whole image, with the chdman choice still taken per hunk [exp]:

| zlib -9 replaced by | CD bin | CD txt | CD img | CD cmp | DVD bin | DVD txt | DVD img |
|---|---|---|---|---|---|---|---|
| libdeflate -6 | +0.001% | 0 | +0.32% | −0.03% | −0.015% | −0.51% | +1.8% |
| libdeflate -9 | 0.000% | −0.006% | +0.13% | −0.006% | −0.04% | −0.90% | −0.007% |
| libdeflate -10 | −0.017% | −0.14% | +0.23% | −0.06% | −0.12% | −1.94% | +0.99% |
| libdeflate -12 | −0.025% | −0.21% | −0.68% | −0.04% | −0.13% | **−2.09%** | −0.96% |

### 4.3 Encoder notes

- **zlib 1.3.x.**
  - chdman's `-9` is the zlib optimum. `memLevel` 9 is identical. `Z_FILTERED` is much worse.
  - Output has been stable since 1.2.11 (§1.3).
  - Licence: zlib. Builds in wasm (it is Discpress's current code).
- **zlib-ng 2.3.3.**
  - Compat and native modes produce the same bytes. Both differ from zlib.
  - At `-9` it is +0.0–0.04% larger and 1.3–1.6× faster. Its "medium" strategy at `-6` loses 3% on CD bin.
  - Its speed comes from SIMD compare256, hashing and slide_hash on x86 and NEON [doc zlib-ng README]. Those paths have no wasm SIMD version [unverified; none seen in the source tree].
  - Dominated by libdeflate. Licence: zlib.
- **Chromium zlib (2026-09).**
  - It replaced the rolling hash with a 4-byte multiplicative "ANZAC++" hash and forces `hash_bits` to at least 15 (`deflate.c:483-490`, `contrib/optimizations/insert_string.h`) [code].
  - The output is deterministic across CPUs but **differs from canonical zlib** (crbug 1316541). It is +2.3% on CD bin because it cannot see 3-byte matches.
  - Not recommended.
- **libdeflate 1.26.**
  - Single-shot whole-buffer compression with near-optimal parsing at levels 10–12, where zlib's lazy matching falls short [doc README "Compression levels"].
  - Level 12 never lost to zlib -9.
  - Levels 9–10 lost only on the atypically compressible `img` class: +0.6% and +1.3% of Deflate output, +0.13% and +0.23% on the whole image.
  - It is the recommendation.
  - Licence MIT. Portable C: it built with `emcc -O3` and ran at speed parity with native in Node [exp §10.1].
- **zopfli.**
  - Apache-2.0; builds in wasm [exp].
  - Buys a further 0.5–2.7% over libdeflate-12 on Deflate output. Too slow for a browser, where it would make DVD conversion about 50× slower.
  - It could be an "extreme" pass run only on hunks where Deflate already won or came within 1%. Not measured.
- **ECT / Zopfli-KrzYmod.** Faster or stronger zopfli forks (github.com/fhanau/Efficient-Compression-Tool, github.com/MrKrzYch00/zopfli). Still well below 1 MB/s; not measured [unverified].
- **igzip (Intel ISA-L).**
  - Levels 0–3, designed for GB/s rather than ratio; assembly for x86-64 and aarch64, with slower C fallbacks.
  - Useless for a ratio trial against LZMA [doc; not measured].
- **Block size.** Every one of these encoders splits blocks inside a 19 KiB hunk as it sees fit. Decoders accept any number of blocks; rinflate's `BLOCK` status appears only when it is opted into (`encoding_deflate.c:1093-1103`). What matters far more is the **hunk** size (§11.5). Deflate at `-9` goes from 50.8% at 4 KiB, to 46.8% at 16 KiB, to 44.8% at 64 KiB on DVD bin.

---

## 5. LZMA1 (raw, fixed properties)

### 5.1 Parameter sweep

LZMA SDK 26.02, lc/lp/pb fixed at 3/0/2. Relative time is against level 6 [exp]:

| Setting | CD bin | CD txt | CD img | CD cmp | DVD bin | DVD txt | DVD img |
|---|---|---|---|---|---|---|---|
| **level 6** (pinned HEAD: `fb` 32, `mc` 32, bt4, normal parser) | 37.279 (1.00×) | 23.134 | 3.091 | 88.541 | 47.259 | 31.004 | 3.870 |
| **level 8 = 9** (`fb` 64, `mc` 48; chdman 0.260–0.289) | 37.233 (1.11×) | 23.044 (1.13×) | 3.017 (1.85×) | 88.565 | 47.239 (1.07×) | 30.954 | 3.772 |
| `fb` 128 | 37.227 (1.25×) | – | – | – | 47.234 | – | – |
| **`fb` 273, `mc` 1000** | **37.195 (1.72×)** | **23.015 (1.62×)** | **2.931 (9.2×)** | 88.538 | 47.232 (1.22×) | 30.949 | 3.635 (7.8×) |
| `fb` 273, `mc` 10000 | 37.195 | – | – | – | 47.232 | 30.949 | – |
| bt2 (2-byte hash) | 37.227 (1.14×) | 23.136 | 3.088 | 88.566 | 47.228 | 31.005 | 3.869 |
| bt3 | 37.261 (1.04×) | – | – | – | 47.254 | 31.002 | – |
| hc4 | 37.348 (0.87×) | 23.345 (0.76×) | 3.125 | 88.565 | 47.288 (0.90×) | 31.137 | 3.909 |
| hc5 | 37.433 (0.82×) | – | – | – | 47.405 | 31.121 | – |
| **fast parser (`algo` 0)** | 38.607 (**0.30×**) | 24.227 (0.19×) | 3.232 (0.15×) | 88.701 | 48.644 (0.41×) | 32.021 (0.29×) | 4.033 |
| end marker (`writeEndMark` 1) | +0.08% (+5.6 B per hunk) | – | – | – | +0.26% | – | – |
| xz/liblzma 5.8.x LZMA1EXT, preset 6 | 37.269 (1.27×) | 23.034 | 3.017 | 88.557 | 47.317 | 30.953 | 3.773 |
| xz preset 9e, nice 273 | 37.259 (2.0×) | 23.035 | 2.934 (9.1×) | 88.530 | 47.340 | 30.952 | 3.635 |

Effect on the whole CD image, per-hunk minimum with `cdzl` [exp]:

| Change | bin | txt | img | cmp |
|---|---|---|---|---|
| level 6 → 8 (= 0.289) | −0.12% | −0.39% | −2.2% | 0 |
| → `fb` 273, `mc` 1000 | −0.22% | −0.51% | −4.8% | 0 |
| → xz 9e | −0.05% | −0.43% | −4.8% | 0 |

### 5.2 Notes

- **SDK versions.** 16.04 differs from 22.01, which equals 23.01 and 26.02 byte for byte (§1.3). 16.04 was about 0.01–0.12% *smaller* on `bin`/`txt` and about 20% slower. Any 22.01+ SDK is interchangeable for chdman output.
- **xz/liblzma.**
  - With `LZMA_FILTER_LZMA1EXT` and `ext_flags=0` there is no end marker, and the result decodes in all three decoders.
  - At equal nice length it matches the SDK within ±0.1%, but it is 1.2–2× slower. No reason to switch.
  - Licence: 0BSD. Portable C; not built for wasm here [unverified, likely trivial].
- **7-Zip "ultra"** (`-mx9 -mfb=273 -mmc=10000`) is the `fb` 273 row. Above `mc` ≈ 1000 there is nothing left on hunk-sized input.
- **Fast-LZMA2 and other LZMA2 encoders.** An LZMA2 chunk that is compressed, is the first in its stream and uses lc/lp/pb = 3/0/2 carries a plain LZMA1 range-coded payload. So a single-chunk LZMA2 encode could in principle be unwrapped into a CHD LZMA stream [unverified; not tried]. Fast-LZMA2's radix match finder pays off on multi-MB inputs and threads, not on 19 KiB blocks. Not recommended.
- **End marker.** It costs about 5.6 bytes per hunk:
  - MAME/SDK `FINISH_END` reads it;
  - libchdr `DecodeToDic` reads it;
  - rchd stops at `dst_len` and never reads it (`r7z_lzma.c:670-677`).

  All accept it [exp]. Never emit it, but it means encoders that can only write an end marker, such as Python's `lzma` `FORMAT_RAW`, still produce valid CHDs.
- **Dictionary and lc/lp/pb.**
  - The decoder dictionary is derived from the hunk size:
    - MAME uses the level-6 normalization, which clamps to the hunk; 18,816 becomes 24,576;
    - libchdr ignores it and decodes into `dest`;
    - rchd uses a power of two.
  - Distances cannot reach before the hunk start, so any encoder dictionary at least as large as the hunk is equivalent.
  - **lc/lp/pb cannot change.** Per D2, this breaks every reader.
- **Speed without changing output.** Per-call setup (`LzmaEnc_Create`, `Init`) is 16–21 µs, under 1% of a 2.8 ms hunk [exp]. The time is in the bt4 match finder and the optimal parser, which do not vectorize (§10.1).

---

## 6. FLAC

### 6.1 Versions

- MAME at the pinned commit and at 0.289 ships **libFLAC 1.4.3** (`3rdparty/flac/CMakeLists.txt:11`).
- Before 0.261 it shipped **1.2.1** (`3rdparty/libflac`), whose level 8 includes exhaustive model search [code, §1.3].
- 1.4.3 and 1.5.0 give **byte-identical** output at chdman's settings [exp].
- 1.5.0 (2025-02-11):
  - adds frame-level multithreading, of no use here because a CD hunk has 2 frames and the helpers already run in parallel;
  - changes the "loose mid-side" heuristic, which `-8` does not use [doc CHANGELOG].
- No release since 1.5.0 as of 2026-09 [exp `git ls-remote`].

### 6.2 chdman's settings

From `flac.cpp:67-88` and `chdcodec.cpp:1465-1689` [code]:
- `compression_level 8`, which in 1.4.3 means:
  - `max_lpc_order` 12;
  - apodization `subdivide_tukey(3)`;
  - mid-side exhaustive;
  - partition order 0–6.
- `streamable_subset(false)`, `verify(false)`.
- **MD5 still computed.**
- The blocksize is fixed:
  - `cdfl` uses **2352** = 4704/2, two frames per hunk. 2352 = 2⁴·147, so the **partition order is effectively at most 4**.
  - The generic `flac` codec uses `hunk/4`, halved until it is 2048 or less; a 4 KiB DVD hunk gives 1024. It encodes little-endian **and** big-endian and re-encodes when big-endian wins.

### 6.3 Settings sweep

Libflac 1.4.3 C path, CD geometry, 642 piano and 562 synth hunks [exp]:

| Setting | piano size | synth size | FLAC CPU vs chdman |
|---|---|---|---|
| chdman (`-8`, MD5 on) | 32.670% | 76.743% | 1.00× |
| MD5 off (**identical bytes**) | = | = | **0.90–0.95×** |
| `-8 -p` (qlp precision search) | −0.38% | −0.10% | ~5× |
| `-8 -e` | −0.06% | −0.01% | ~5× |
| `-8 -ep` | −0.45% | −0.11% | ~40× |
| `-8 -l 32` | −0.08% | +0.0003% | ~1.8× |
| `-A subdivide_tukey(5)` | −0.06% | −0.01% | ~2.3× |
| `subdivide_tukey(5) -l32 -p` | −0.50% | −0.11% | ~17× |
| 1.3.x-style apodization | +0.04% | −0.001% | ~1× |
| `-5` | +0.47% | +0.09% | 0.25× |
| `-0` | +8.5% | +6.2% | 0.07× |
| blocksize 1176 | +1.5% | +0.2% | – |
| *(reference only, not decodable)* 1 frame of 4704 per hunk | −0.71% | +0.12% | – |
| *(reference)* whole-track stream, blocksize 4096 (plain `flac -8`) | −0.37% | −0.015% | – |

**Blocksize, 4704 versus 4096.** The per-hunk framing and the 2352 blocksize cost at most about 0.4% against an ordinary `.flac` file. Frames larger than 2352 are **rejected by dr_flac and rflac** (642 of 642 failed), and smaller frames only lose.

Variable-blocksize encoders reach about 1% at great cost (flaccid, CUETools.Flake, justinruggles' flake: xiph/flac#639). Every frame would still have to be at most 2352, and libFLAC 1.5's decoder now flags missing or irregular frames. I rate it **risky for a gain of 1% or less on audio only**. Not recommended.

**Alternative encoders.**
- **FLACCL** (CUETools, OpenCL GPU): C#/.NET, not portable to wasm or WebGPU; see §10.3.
- **CUETools.Flake** and justinruggles' **flake**: "slightly better than libFLAC -8" [doc cue.tools wiki]; their levels 9–11 are non-subset.
- **flaccid** (github.com/chocolate42/flaccid): variable blocksize on a patched libFLAC.

None is needed. libFLAC with `-p` is the practical ceiling, and it is subset-safe provided partition order stays at 8 or less.

### 6.4 Determinism problems found (new)

1. **libm dependence.**
   - The encoder computes window functions with `cosf()` (`window.c:217-288`) and order estimates with `log()` (`lpc.c:1591`, `fixed.c:284+`).
   - glibc and Emscripten's musl-derived libm disagree by 1 ULP on **8,937 of 721,800** `cosf` values over FLAC's argument pattern, and on 1 of 199,999 `log` values [exp `$SP/exp/libm/`].
   - Result with Discpress's own artifacts on a CUE/BIN with one audio track made from `piano.pcm`:

     | Build | Size | SHA-1 |
     |---|---|---|
     | `build/chdman.wasm` (SIMD) | 3,958,167 B | `ab21de53…` |
     | `build/chdman-nosimd.wasm` | 3,958,167 B | `ab21de53…` |
     | `build/chdman-native` | 3,958,171 B | `7d5b1de6…` |

   - The data SHA-1 is the same everywhere (`57ec62d9…`) and all 643 hunks are CD FLAC in every build [exp `$SP/exp/cdtest/`].
   - **CLAUDE.md says Discpress's CHDs are byte-identical to native chdman "for default settings", and the release notes promise the same. That is false for CD-DA.** Native builds from gcc -O2/-O3 and clang -O3 on glibc all agree with each other.
2. **SIMD summation order.**
   - The SSE2 and NEON autocorrelation kernels accumulate **backwards over samples** (`deduplication/lpc_compute_autocorrelation_intrin_{sse2,neon}.c`). The C and FMA kernels go forwards.
   - Products of float samples are exact in double, so FMA versus multiply-add does not matter; only the order does.
   - Forcing the SSE2 path changed 2 of 642 piano hunks [exp].
   - Official MAME builds do not define `FLAC__NO_ASM`, and `3rdparty.lua` has no `FLAC__NO_ASM` [code].
     - **ARM64** builds use NEON unconditionally (`stream_encoder.c:945-956`), so Apple Silicon chdman gives different `cdfl` bytes.
     - x86 GCC builds lack `HAVE_CPUID_H`, so `cpuinfo_x86` returns zero and they use the C path (`cpu.c:131-155`).
     - MSVC builds would use SSE2 [unverified].
3. **Consequence for a fork.** Byte identity for FLAC needs two things:
   - vendor one deterministic `cosf`/`log` (musl's sources, or a correctly-rounded one such as CORE-MATH) into both native and wasm, and route libFLAC to it;
   - pin the C autocorrelation, or write a lane-per-lag SIMD kernel, which preserves each lag's forward order. That is what LLVM's auto-vectorization already produced here: wasm SIMD and non-SIMD were identical.

---

## 7. zstd

| | CD bin | CD txt | CD img | CD cmp | DVD bin | DVD txt | DVD img |
|---|---|---|---|---|---|---|---|
| LZMA level 6 (reference) | 37.279 | 23.134 | 3.091 | 88.541 | 47.259 | 31.004 | 3.870 |
| zstd -3 | 43.681 (0.03× LZMA time) | 26.075 | 3.920 | 87.926 | 52.472 | 32.605 | 4.906 |
| zstd -9 | 41.519 (0.12×) | 24.182 | 3.488 | 87.865 | 51.338 | 31.105 | 4.248 |
| zstd -19 | 39.342 (1.4×) | 23.360 (1.6×) | 3.061 (4.3×) | 87.563 | 49.087 (1.3×) | 30.503 (1.6×) | 3.976 |
| **zstd -22** (`ZSTD_maxCLevel()`, what chdman uses) | 39.337 (2.3×) | 23.359 (3.6×) | 3.008 (22×) | 87.564 | 49.086 (1.5×) | 30.502 | 3.943 (18×) |
| -22, no content-size field | −0.02% | – | −0.01% | – | −0.08% | −0.08% | – |

[exp]

- **Ratio.**
  - As a **replacement** for `cdlz` (`cdzs` plus `cdzl`): +5.5% on CD bin, +1.0% on txt, −2.4% on img, −0.2% on cmp.
  - As an **extra 4th CD codec**: −0.05% (bin), −0.33% (txt), −5.4% (img), −0.21% (cmp).
  - On DVD, in place of `flac`: −0.24% (txt) and −1.1% (img), but +0.42% (bin), because FLAC's wins are lost.
- **Speed.** At these hunk sizes zstd -22 is *slower* to encode than LZMA. **-19 gives the same ratio (within 0.02%) in about 60% of -22's time.**
- **Decode.** About 650–680 MB/s, against 245–255 for Deflate (miniz) and 42 for LZMA, all in libchdr style on this loaded box. zstd is roughly 16× faster than LZMA [exp]. This matters to emulators, not to Discpress.
- **Window.** chdman makes one `ZSTD_e_end` call, so the source size is known and the parameters adapt: `windowLog` is 15 for 18,816 B and 12 for 4 KiB [code `clevels.h`]. With hunks capped at 1 MiB, `windowLog` is at most 20, far under `ZSTD_WINDOWLOG_LIMIT_DEFAULT` = 27. Long-distance matching is pointless within a hunk.
- **Dictionaries.** Impossible. No reader loads one, and a frame with a dictionary ID fails.
- **Wasm.** Encode speed is at parity with native (§10.1). The zstd build uses no SIMD.
- **Compatibility.** Owned by D1 and D2. Not safe as a default: older libchdr copies, rchd without `HAVE_RCHD_ZSTD` (for example Opera 3DO) and MAME before 0.262 cannot read it.
- **Versions.** 1.5.5 at the 0.289 tag and 1.5.7 at HEAD give different bytes (§1.3).

---

## 8. The CHD Huffman codec

- It is in the default list only for HD, DVD and raw.
- It won **11 of 4,096** DVD `bin` hunks and nothing in any other class. Dropping it costs +110 B (0.001%) [exp]. It costs about 4% of DVD CPU.
- It wins on hunks with a skewed byte histogram and few repeats, for example tables of small values.
- The encoder builds a length-limited tree from the histogram and serializes it with RLE (`huffman.cpp`). A package-merge optimal tree would save a few bytes on the hunks it already wins. The effect on file size is unmeasurable.
- Keep it, since it is cheap, or gate it. It is not worth improving.

---

## 9. Hashing

Per 64 MiB processed in 19,584-byte hunks [exp `$SP/exp/hash/`]:

| | Native (CPU time) | Wasm (Node, wall) |
|---|---|---|
| MAME `sha1_creator` (`hashing.cpp:46-110`) | 170–190 MB/s | **76–84 MB/s** |
| Straightforward unrolled SHA-1 (Steve Reid layout, same digests) | 600–640 MB/s | **350–580 MB/s** |
| OpenSSL SHA-1 (SHA-NI) | 1.36–1.39 GB/s (loaded) | n/a |
| MAME CRC16 (byte-table) | 250 MB/s | 175 MB/s |
| zlib 1.3.2 `crc32` (braided) | 1.9–2.0 GB/s | 1.1–2.1 GB/s |

**Why MAME's SHA-1 is slow.**
- It copies input byte by byte through a swizzle (`append`, `hashing.cpp:188-214`).
- It indexes the state as `d[i % 5]` inside non-unrolled `while` loops. The state therefore stays in memory.
- The digests are identical with `LSB_FIRST`, so a replacement is **byte-identical**.

**Where SHA-1 runs in Discpress.**
- `chd_file_compressor` hashes every byte twice:
  - a per-hunk SHA-1 + CRC16 for the duplicate map, now computed in the helpers (`wasm_helper_compress`);
  - the whole-image raw SHA-1 (`m_compsha1.append` in `async_read`, `chd.cpp:3509`), which runs in the **single job worker**.
- At about 80 MB/s in wasm, the job worker saturates once aggregate compression passes about 60–80 MB/s. That is 10–16 threads on CD data after the speedups in §11.
- A faster SHA-1 removes this serial ceiling and about 5% of helper CPU.

**Hardware SHA and CRC.**
- SHA-NI, ARMv8 SHA1/CRC32 and PCLMUL are unreachable from wasm; wasm SIMD has no crypto or carry-less multiply.
- `crypto.subtle.digest('SHA-1')` runs natively but is one-shot and async, so it cannot stream a whole disc. It could hash each 19 KiB hunk alongside the synchronous compress call in a helper.
- A slicing-by-8 CRC16 would make CRC16 negligible [unverified, standard].

**Share of total time.** About 3–6% of today's helper CPU; after the §11 speedups about 10%, plus the serial job-worker limit.

---

## 10. Platform acceleration

### 10.1 WebAssembly features

| Feature | Chrome | Firefox | Safari / iOS | Use for this encoder |
|---|---|---|---|---|
| SIMD128 | 91 | 89 | 16.4 | Measured with Emscripten 6.0.10 `-O3` in Node 22 [exp]. **libFLAC: about 2× faster with `-msimd128`** (17.7–22.7 vs 9.8–10.9 MB/s; auto-vectorized autocorrelation and residual loops; identical output). LZMA SDK, zlib, libdeflate, zstd: **no measurable difference** (hot loops are match finding, parsing and bit I/O). The dual build is justified by FLAC alone. |
| Relaxed SIMD | 114 | 146 | ✗ | Nothing to gain: no FMA-sensitive or shuffle-heavy hot loops. Output could depend on hardware. Skip. |
| Threads (shared memory, `SharedArrayBuffer`) | 74 (Android 88) | 79 | 15.2 | `SharedArrayBuffer` requires **cross-origin isolation** (COOP `same-origin` plus COEP `require-corp`/`credentialless`). A single HTML file opened from `file://` cannot send headers, which is why Discpress uses message-passing helpers with private wasm instances. Shared memory would enable the LZMA SDK's MT match finder and zero-copy hunks, but only for an HTTPS-hosted build. |
| Memory64 | 133 | 134 | ✗ | Not needed; per-worker working sets are MBs. It also carries bounds-check overhead. Skip. |
| JSPI | **137** | **153** | **27** | Baseline "low" since 2026-09-14. It could replace Asyncify, which today instruments only `main`, `do_create*`, `do_copy*` and `compress_common*` (`wasm/link.sh`). The expected gain is small: codecs are not instrumented, and "Asyncify … overhead … 50% or so" applies only to instrumented code [doc Emscripten]. Browsers older than Safari 27 need a fallback build. Low priority. |
| Exception handling (exnref) | 137 | 131 | 18.4 | Already used (`-fwasm-exceptions`). |
| WebGPU | 113 on Windows, macOS and ChromeOS; all desktops by 144 per web-features; Android 121 | Windows since 141 [unverified] | 26 | See §10.3. |

Sources: web-features 3.40.0 `data.json`, caniuse, MDN Firefox 153 notes, WebKit Safari 27 beta post.

**Wasm against native.** Back-to-back runs in Node gave roughly parity for LZMA, zlib, libdeflate and zstd (0.7–1.1× native wall time, noisy). Discpress's own single-threaded `createcd` on the audio disc took 2.7–3.1 s in wasm and 2.8–4.8 s natively (`-np 1`) [exp].

### 10.2 CPUs, core counts and workers

- **`navigator.hardwareConcurrency`.**
  - **WebKit** returns `numberOfProcessorCores() < 8 ? 4 : 8`. Under script-tracking privacy protection it returns 4 or 8 (`NavigatorBase.cpp:185-197`) [code].
    - An iPhone with an A19 Pro (2P+4E) reports **4**.
    - iPads and Macs with 8 or more cores report **8**, even an M-series Max.
  - **Chromium** returns `sysconf(_SC_NPROCESSORS_CONF)`. That is configured, not online, cores: all 8 on Snapdragon, masked by CPU affinity on Linux, and possibly physical cores on Mac when mitigations are on (`sys_info_posix.cc:115-160`) [code].
  - **Firefox** caps at `dom.maxHardwareConcurrency` = **128** (`StaticPrefList.yaml:6033`). `resistFingerprinting` spoofs it [doc].
  - Discpress's tuner ignores the reported count and measures (up to 8 threads on touch devices, 16 elsewhere). That is the right call.
- **Worker limits.** Firefox allows `dom.workers.maxPerDomain` = **512** and queues any beyond that (`all.js:117`, `RuntimeService.cpp:121`). Chromium and WebKit have no documented hard cap [unverified]. Each worker runs its own wasm instance of 16 MB or more, and on iOS the practical limit is WebKit's process memory limit [unverified].
- **Heterogeneous cores.**
  - A19 Pro: 2 P-cores at 4.26 GHz and 4 E-cores at 2.6 GHz.
  - Snapdragon 8 Elite Gen 5: 2 Oryon "prime" cores at 4.6 GHz and 6 at 3.62 GHz, **no E-cores**.
  - Apple Silicon Macs: 4–12 P-cores plus 4–6 E-cores.
  - Pages cannot choose worker QoS. The W3C TPAC 2023 `new Worker(url, {qualityOfService})` proposal from Intel has only a Windows Chromium prototype. Background tabs get demoted.
  - A measuring tuner already accounts for the P/E asymmetry.
- **Thermals.** The Snapdragon 8 Elite Gen 5 holds about 58% of peak over a 15-minute CPU throttling test, and some phones fall below 30% under sustained load [doc Beebom, BigGo]. The iPhone 17 Pro adds a vapor chamber. A one-off tuning run on a cold device overestimates sustained throughput, so re-tune or adapt during long jobs. Cheaper codec paths (§11) help most on phones.

### 10.3 GPU (WebGPU) compute

Not a fit.
- **LZMA** is an adaptive range coder with an optimal parser that depends on sequential state. Only match finding could be offloaded. Hunks are 4–19 KiB, and the CPU↔GPU copies plus wasm-heap marshalling would dominate.
- **Deflate** could be batched, one hunk per workgroup. But GPU LZ77 encoders (GPULZ, nvCOMP) trade ratio for throughput, and the Deflate trial only matters when it beats LZMA.
- **nvCOMP's GDeflate** is a bit-swizzled format, **not** Deflate-compatible [doc nvCOMP]. nvCOMP is CUDA-only anyway.
- **FLAC LPC** on the GPU is proven (FLACCL). But WGSL has **no f64**, so libFLAC's double-precision analysis cannot be reproduced and bytes would diverge. Audio is a minority of disc data, and CPU FLAC with SIMD128 already runs at 20+ MB/s per core.

---

## 11. Algorithmic ideas within the format

### 11.1 Per-hunk codec gating

This means predicting the winner so the other trials can be skipped [exp; sizes are exact per-hunk simulations over the corpus].

| Rule | Where | Size effect | CPU saved | Byte-identical? |
|---|---|---|---|---|
| Skip `cdfl` if **all 8 frames** carry the sync pattern (data sectors) | CD | 0 (`cdfl` won 0 of 2,176 data hunks; FLAC on data ≈ 95%) | ≈19% of data-track CPU | Identical on all tests; not guaranteed |
| Skip `cdlz` (and optionally `cdzl`) if **no frame** has a sync pattern (audio) | CD | 0 (`cdfl` won 1,204 of 1,204; it also wins digital silence) | ≈47–60% of audio-track CPU | Same |
| Mixed hunks (track boundaries: tracks pad to 4 frames, hunks are 8) | CD | – | – | Run every codec |
| **FLAC-0 probe**: run full FLAC-8 (LE+BE) only if FLAC-0 ≤ 1.2 × best so far, and never when everything else failed | DVD, HD, raw | +0.051% bin, 0 txt/img/cmp | FLAC-8 runs on 5.5% (bin) and 0–6.5% of hunks; saves ≈85–90% of FLAC time, ≈30% of DVD CPU | No |
| Probe also picks the byte order (run FLAC-8 once, not 2–3 times) | DVD | small [unverified] | Another ≈50% of the remaining FLAC time | No |
| Drop Huffman | DVD | +0.001% | ≈4% | No |
| Drop `cdzl` on CD | CD | +0.01 to **+0.9%** (cmp) | ≈29% | No. Use libdeflate instead. |

Fast-mode arithmetic from the measured component times:

| Content | Recipe | Time | Size |
|---|---|---|---|
| CD data | LZMA + libdeflate-9 + no `cdfl` | 5.31 → 3.24 s (**1.64×**) | +0.00% bin, +0.13% img, −0.01% cmp |
| CD audio | FLAC only, MD5 off | 2.0 → 0.75 s (**2.7×**) | 0 |
| DVD | LZMA + libdeflate-9 + Huffman + FLAC probe | 5.26 → 3.34 s (**1.57×**) | ≈ ±0.05% |

### 11.2 Early termination

Pass `best − 1` as the output limit to each later codec. **This is byte-identical**: an aborted codec could not have won, because chdman only takes a strictly smaller result.
- The LZMA SDK returns `SZ_ERROR_OUTPUT_EOF`; the 21.06 fix makes a small output buffer safe.
- zlib runs out of `avail_out`.
- FLAC's write callback returns an error. Then call `finish()` to reset the encoder.

Measured [exp]:
- `cdfl` on CD data hunks stops after frame 1 on **88% (bin), 100% (txt), 99.7% (img) and 0% (cmp)** of hunks, which saves about 45–50% of `cdfl` CPU. The cmp figure is with ECC bytes zeroed; real ECC bytes would make FLAC stop earlier.
- For zlib after LZMA the saving is small, 10% of zlib time or less, because Deflate flushes blocks late [unverified estimate].
- Reordering codecs (cheap first) is byte-identical if ties are resolved in chdman's order, but saves little.

### 11.3 Parallelism inside a hunk

- An LZMA stream is one adaptive range-coded sequence and cannot be split.
- The SDK's only parallelism is `LzFindMt` (the match finder in a second thread, `numThreads=2`). Discpress builds with `Z7_ST`. That thread needs shared memory: under Discpress's message-passing model **not possible**. It is also unnecessary, because hunk-level parallelism already fills every core.
- libFLAC 1.5's threads work per frame, and a hunk has only 2 frames.
- Parallelism inside a hunk only helps latency when there are fewer hunks than cores, which never happens for disc images.

### 11.4 Sharing work between codecs

- `cdlz` and `cdzl` each copy, deinterleave and **ECC-verify** all 8 sectors (`chdcodec.cpp:365-378`).
  - One verify costs 8.1 µs per sector [exp `$SP/exp/eccb/`].
  - Doing it once saves about 1.2% of CD data CPU, and a faster ECC routine a little more. Byte-identical.
- LZMA, Deflate and FLAC share no search state that could be reused in practice.
- The quick FLAC-0 or fixed-predictor probe (§11.1) is the useful kind of reuse: a cheap model predicts an expensive one.

### 11.5 Hunk size

A header parameter, not a format change. It is by far the largest lever [exp]:

| Hunk | DVD bin LZMA | DVD bin zlib | DVD txt LZMA | Note |
|---|---|---|---|---|
| 2 KiB | 51.42% | 54.31% | 35.18% | `-hs 2048`, required by MAME's `dvdrom_file` (report C) |
| 4 KiB (chdman default) | 47.26% | 50.77% | 31.00% | |
| 8 KiB | 44.20% | 48.39% | – | |
| 16 KiB | 41.86% | 46.82% | 25.65% | −11% / −17% vs 4 KiB |
| 32 KiB | 40.09% | 45.65% | – | |
| 64 KiB | 38.63% | 44.84% | 22.60% | −18% / −27% |

CD with LZMA:
- `bin`: 37.28% at 8 frames (default), 35.73% at 16 frames (−4.2%), 34.44% at 32 frames (−7.6%).
- `txt`: 23.13%, 21.62% and 20.48%.

CPU per byte rises only 5–20%. The costs fall on readers:
- more decompression per random read, and more cache memory;
- rchd caps hunks at 512 KiB;
- MAME cannot mount DVD CHDs whose hunk is not 2048;
- embedded libchdr targets are sized for the defaults (D2).

Whether to use it is a policy decision for D1 and D2, not an encoder question. It dwarfs every encoder change in this report.

### 11.6 Ideas that need format changes (reference only)

| Idea | Expected gain | Why it is out |
|---|---|---|
| Solid or cross-hunk dictionaries (shared LZMA dictionary or zstd prefix) | Large; like the hunk-size effect, but with random access kept via restart points | Every reader would break |
| zstd trained dictionaries per disc | 2–10% on small hunks [unverified] | No reader loads one |
| Per-hunk LZMA properties (lc/lp/pb) | Small; mostly for 16-bit or text data [not measured] | Properties are not stored |
| FLAC blocks larger than 2352, or variable block sizes | 0.4–1% of audio | Rejected by dr_flac and rflac |
| Sector-level deduplication (sub-hunk "copy" references) | Discs with padding or repeated files [unverified] | No such map entry type |

---

## 12. Ranked options

"Identical" means byte-identical to chdman built from the same source on the same platform. See §6.4 for why even that fails for FLAC across libm and ISA.

| # | Option | All current decoders? | Byte-identical to chdman? | Size effect | Speed effect | License | Wasm feasibility | Effort |
|---|---|---|---|---|---|---|---|---|
| 1 | **Faster SHA-1** (unrolled; optionally WebCrypto per hunk) and slicing CRC16 | Yes | **Yes** | 0 | Removes the ~80 MB/s serial job-worker ceiling; −3–6% helper CPU | Public domain / own | Trivial (tested: 350–580 MB/s) | Low |
| 2 | **FLAC MD5 off** (`set_do_md5(false)`) | Yes | **Yes** | 0 | −5–10% FLAC CPU | – | Trivial | Trivial |
| 3 | **Early termination** (output limit = best−1; stop `cdfl` after frame 1) | Yes | **Yes** | 0 | −45–50% of `cdfl` on compressible data tracks (≈−9% CD data CPU) | – | Yes | Low–medium (codec API change) |
| 4 | **ECC verify once per hunk** | Yes | **Yes** | 0 | ≈−1.2% CD data | – | Yes | Low |
| 5 | **Gate `cdfl` / `cdlz` on sync patterns** | Yes | Identical on 3,380 of 3,380 test hunks, not guaranteed | 0 measured | CD data ≈−19%; CD audio ≈−50–60% | – | Yes | Low |
| 6 | **libdeflate -9** replaces zlib in the Deflate trial | Yes (raw Deflate; three decoders tested) | No | 0 to −0.9% (DVD txt); worst +0.13% (CD img) | Deflate trial 2–3× faster (≈−20% CD data, −10% DVD) | MIT | Yes (tested) | Low |
| 7 | **FLAC-0 probe** for the generic `flac` codec | Yes | No | ≤+0.05% | ≈−30% DVD/HD CPU | – | Yes | Low |
| 8 | **LZMA level 8** (`fb` 64, `mc` 48), the 0.260–0.289 setting | Yes | No against HEAD; **yes against the 0.289 release** (data tracks) | −0.1 to −0.4% typical, −2.2% very compressible | LZMA +7–13% (+85% very compressible) | Public domain (SDK) | Trivial | Trivial |
| 9 | **LZMA `fb` 273, `mc` 1000** | Yes | No | −0.2 to −0.5% typical, −4.8% very compressible | LZMA ×1.2–1.7 (×9 very compressible) | Public domain | Trivial | Trivial |
| 10 | libdeflate -12 for the Deflate trial (-10 is cheaper but can lose on very compressible data: CD img +0.23%) | Yes | No | DVD txt −2.1%; CD −0.03 to −0.7% | ×2.6–6.6 zlib time (×13–19 very compressible); -10 ≈×1–3 | MIT | Yes | Low |
| 11 | **Larger hunks** (`-hs`) | Header-legal. Reader caps apply: rchd ≤512 KiB; MAME DVD needs 2048 (D1, D2, C) | No | **−4 to −18%** | CPU ≈same; readers pay | – | Yes | Trivial (policy) |
| 12 | FLAC `-p` (+ `subdivide_tukey(5)`, `-l 32`), partition order ≤8 | Yes (dr_flac tested) | No | −0.1 to −0.5% of audio | FLAC ×5–17 | BSD (Xiph) | Yes | Trivial |
| 13 | **Deterministic libm for libFLAC** + C (or lane-per-lag) autocorrelation | Yes | Restores identity between wasm, native and ARM | 0 | 0 | MIT (musl) / own | Yes | Low |
| 14 | LZMA fast parser (`algo` 0) as a "fast" preset | Yes | No | +2.9 to +4.7% | LZMA 2.5–5× faster | Public domain | Trivial | Trivial |
| 15 | zstd -19 (not -22) whenever zstd is used | Needs zstd readers (D1/D2) | No | ±0.02% vs -22 | 1.6× faster | BSD | Yes | Trivial |
| 16 | `cdzs` as the free 4th CD codec | **No** (older libchdr, rchd without zstd, MAME before 0.262) | No | −0.05 to −5.4% | +1.4–4× LZMA time | BSD | Yes | Low (compatibility risk) |
| 17 | zopfli (Deflate) | Yes | No | −0.5 to −2.7% of Deflate output vs ldf-12 | ×20–40 slower than ldf-12 | Apache-2.0 | Yes (built) | Low, impractical |
| 18 | xz/liblzma LZMA1EXT | Yes (tested) | No | −0.05 to +0.17% vs SDK | ×1.2–2 slower | 0BSD | Likely | Low; no benefit |
| 19 | zlib-ng (compat = native bytes) | Yes | No | +0.00 to +0.04% | ×0.63–0.78 | zlib | Likely (generic C) | Low; dominated by libdeflate |
| 20 | Chromium zlib | Yes | No | +2.3% | ×0.58 | zlib/BSD | Yes | Not recommended |
| 21 | JSPI instead of Asyncify | n/a | Yes | 0 | Small (<5%, unmeasured); smaller wasm | – | Chrome 137, Firefox 153, Safari 27 only | Medium (fallback build) |
| 22 | Shared-memory threads (MT match finder) | n/a | Yes [unverified for MT MF] | 0 | Some gain per job; hunk parallelism already saturates | – | **Not possible from `file://`** (COOP/COEP) | High |
| 23 | Variable FLAC block sizes (≤2352) | Risky (libFLAC 1.5 frame checks) | No | ≤1% of audio | Much slower | – | Yes | Not recommended |
| 24 | Better Huffman tree builder | Yes | No | ≈0.001% | 0 | – | Yes | Skip |
| 25 | WebGPU, relaxed SIMD, Memory64 | – | – | – | None for these codecs; not in Safari (relaxed SIMD, Memory64) | – | – | Skip |

---

## 13. Sources

### Code

- MAME at the pinned commit `76c7d197ed` (`src/lib/util/chdcodec.cpp`, `flac.cpp`, `hashing.cpp`, `chd.cpp`, `src/tools/chdman.cpp`, `3rdparty/{lzma,flac,zlib,zstd}`) and the tags `mame0180`–`mame0289` (fetched with `git show`).
- https://github.com/mamedev/mame/blob/76c7d197ed46e844ffb1fbad5cc21c9ab3cdc9c0/scripts/src/3rdparty.lua (FLAC build flags: no `FLAC__NO_ASM`)
- https://github.com/rtissera/libchdr (`607694c`): `src/libchdr_codec_{lzma,zlib,zstd,flac,cdfl}.c`, `src/libchdr_flac.c`, `include/dr_libs/dr_flac.h`
- https://github.com/libretro/libretro-common (`92d38df`): `formats/chd/rchd.c`, `formats/7z/r7z_lzma.c`, `encodings/encoding_deflate.c`, `formats/flac/rflac.c`
- https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/NavigatorBase.cpp
- https://github.com/chromium/chromium/blob/main/base/system/sys_info_posix.cc
- https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc
- https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml (`dom.maxHardwareConcurrency: 128`); `modules/libpref/init/all.js` (`dom.workers.maxPerDomain`)
- https://chromium.googlesource.com/chromium/src/third_party/zlib (`deflate.c`, `contrib/optimizations/insert_string.h`)
- Libraries measured:
  - https://github.com/ebiggers/libdeflate (v1.26)
  - https://github.com/zlib-ng/zlib-ng (2.3.3)
  - https://github.com/google/zopfli
  - https://github.com/tukaani-project/xz (5.8.x)
  - https://github.com/xiph/flac (1.5.0)

### Documentation

- LZMA SDK history: `3rdparty/lzma/DOC/lzma-history.txt` (18.06, 21.06 and 24.09 entries)
- FLAC format, RFC 9639: https://www.rfc-editor.org/rfc/rfc9639.html (subset: block ≤4608 at ≤48 kHz, LPC order ≤12, partition order ≤8)
- web-features 3.40.0: https://cdn.jsdelivr.net/npm/web-features/data.json
- JSPI:
  - https://caniuse.com/wf-wasm-jspi
  - https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/153
  - https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/
  - https://v8.dev/blog/jspi
- Emscripten asynchronous code (Asyncify, JSPI): https://emscripten.org/docs/porting/asyncify.html
- Worker QoS proposal: https://www.w3.org/2023/Talks/TPAC/breakouts/web-worker-qos
- nvCOMP GDeflate: https://docs.nvidia.com/cuda/nvcomp/gdeflate.html
- FLAC encoders:
  - https://github.com/xiph/flac/issues/639
  - https://github.com/chocolate42/flaccid
  - http://cue.tools/wiki/CUETools_FLAC_encoders_comparison
  - http://cue.tools/wiki/FLACCL
- SoCs and thermals:
  - https://en.wikipedia.org/wiki/Apple_A19
  - https://gadgets.beebom.com/guides/snapdragon-8-elite-gen-5-benchmark-specs
  - https://biggo.com/news/202511080303_Snapdragon-8-Elite-Gen-5-Thermal-Throttling
  - https://www.qualcomm.com/smartphones/products/8-series/snapdragon-8-elite-gen-5
- Firefox `resistFingerprinting` spoofing `hardwareConcurrency`: https://bugzilla.mozilla.org/show_bug.cgi?id=1360039
- Audio source (CC0): https://archive.org/details/OpenGoldbergVariations

### Companion reports

In `$SP/research/`:
- B (chdman internals: LZMA level change, pinned commit);
- C (optical media: MAME `dvdrom` hunk requirement);
- D1 and D2 (reader matrix, rchd limits, zstd support).

## 14. Reproduction

All paths are under `$SP/exp/`.

**Corpus.** `mkcorpus.py`, `mkaudio.py` and `mkcdbase.py` write to `corpus/`.

**Encoders.**
- `h/enc_bench.c`, built as `h/enc_bench4`: `./enc_bench4 {cd|dvd|raw:N} file enc...`. Encoder specs:
  - `sdk:L:fb:mc:bt:hb:algo`, `sdkeos`;
  - `xz:P:nice:mf:depth`;
  - `zlib:L:mem:strat`, `zng:L`, `crz:L`;
  - `ldf:L`, `zop:I`;
  - `zstd:L[:1]`, `huff`.
- Environment variables: `SIZESDIR` (dump per-hunk sizes), `DECBENCH`, `LIMIT`.

**FLAC.** `h/flac_bench.c`, built as `h/fb_*`:
- libFLAC variants: `143c` (C), `143x` (SSE2), `143a` (AVX/FMA), `150c`, `150s`;
- `h/drflac_check.c` decodes the output with dr_flac.

**Analyses.** `analyze_cd.py`, `analyze_dvd.py` and `gate_dvd.py`, with outputs in `res/`.

**Version identity.**
- LZMA SDK: `lzsdk/bench/lzcmp*`;
- zlib: `zlibv/zc_*`;
- zstd: `zstd155/zc155` and `zc157`.

**Other checks.**
- Hashing: `hash/hbench.cpp`, `hash/fastsha1.c`;
- libm: `libm/lm2.c`;
- ECC: `eccb/eccb.cpp`;
- wasm: `wasm/wbench.js`, `wasm-nosimd/wbench.js`, `wflac-{simd,nosimd}/fb.js`;
- Discpress wasm against native: `cdtest/runwasm2.js`, `cdtest/{chdman,chdman-nosimd,native}.chd`.

---

## Implications for a Discpress fork

1. **Offer two presets, and keep the identical one honest.**
   - **"chdman-identical"** (default) takes only the provably byte-identical changes: rows 1–4 and 13.
   - **Fix row 13 first.** Right now `cdfl` output already differs from the native reference (§6.4). The test suite presumably passes because its short synthetic audio (a few sine tones plus light noise, `tests/fixtures/discgen.py:115-128`) never reaches a borderline LPC decision. Add a longer, real-music-like CC0 fixture to catch this.
   - Also correct the release-note and CLAUDE.md claims. Reports B and C show the pinned build is not the 0.289 release either: LZMA level 6 against 8, zstd 1.5.7 against 1.5.5, and GD-ROM pregaps.
2. **Pick the identity target on purpose.**
   - Row 8 (LZMA level 8) makes data tracks byte-identical to the *0.289 release*, and 0.1–2% smaller, at +10% LZMA time.
   - Staying on level 6 tracks MAME master, which is presumably where 0.290 will land [unverified].
   - Either way, pin the LZMA SDK at 22.01 or later. Its output is stable through 26.02.
3. **A "fast, compatible" preset** gives large wins at essentially no size cost:
   - rows 5–7 together: libdeflate-9, codec gating, the FLAC-0 probe;
   - about 1.6× on data CDs and DVDs, and 2.7× on audio.
   - It matters most on phones: iPhones have only 2 P-cores, and Snapdragon parts throttle to 30–58%.
4. **A "smallest, compatible" preset** keeps every file readable everywhere:
   - rows 9, 10 and 12: LZMA `fb` 273 / `mc` 1000, libdeflate-12, FLAC `-p`;
   - about −0.2 to −0.6% on typical data and up to −5% on very compressible data;
   - costs about 1.7–2.5× CPU.
   - Beyond that, only larger hunks (row 11) move the needle, and that decision belongs with D1 and D2 because of reader caps and seek cost.
5. **Libraries to add or change.** Add libdeflate (MIT; about 100 KB of wasm); nothing else.
   - zlib stays, for decompression and identical mode.
   - zopfli, zlib-ng, Chromium zlib and xz buy nothing here.
   - zstd stays optional (compatibility).
6. **Platform.**
   - Keep the SIMD/baseline dual build; it is worth about 2× for FLAC.
   - Keep message-passing helpers; shared memory is impossible from `file://`.
   - Keep the measuring thread tuner, since Safari reports only 4 or 8. Add re-tuning or throttle detection for long jobs.
   - Watch JSPI (Baseline since 2026-09-14) as a later clean-up of Asyncify, with a fallback.
   - Ignore WebGPU, relaxed SIMD and Memory64.
7. **Serial bottleneck.** Once helpers get 1.6× faster, the job worker's whole-image SHA-1 (MAME's, about 80 MB/s in wasm) and I/O become the limit on 12–16-thread desktops. Row 1 is a prerequisite for scaling.
8. **Test matrix.** Every non-identical preset must be checked with three decoder families, as I did in §1.2:
   - MAME's decoders;
   - libchdr (dr_flac, miniz, LZMA into `dest`);
   - rchd (rinflate, r7z_lzma, rflac).

   Also include an old vendored libchdr (per D2). Keep the dr_flac constraints as hard asserts in the encoder: frames of 2352 or less, partition order 8 or less.

## Open questions

1. **Real-disc validation of the gating rules** (rows 5 and 7) and of the early-termination rates. Does `cdfl` ever win on a real data hunk, or `cdlz` on a real audio hunk? How large is the FLAC-probe loss on real PS2 and PSP DVDs, where audio streams may be raw PCM? The main agent's exact per-codec harness should replay these rules on user-supplied images.
2. **How often do official chdman builds disagree on real CD-DA?** Compare Windows (MinGW or UCRT libm), macOS ARM64 (NEON plus Apple libm) and Linux x86 (glibc). The same check applies to Discpress's wasm against each. That decides which "identity" can be promised.
3. **Why did MAME move the LZMA level from 8 to 6** in `c23567b509`? Will 0.290 ship it? This decides the identity target (report B has the commit).
4. **Hunk-size policy.** What are the seek and decode costs, and the caps, per emulator? rchd ≤512 KiB and MAME `dvdrom_file` needing 2048 are known; libchdr cache behaviour and embedded targets are not. For D1 and D2.
5. **Asyncify's real overhead** in Discpress, which decides whether JSPI is worth a dual build. Profile `main`, `compress_common` and the yield path.
6. **Worker memory on iOS.** What is the per-tab ceiling with 8 helpers, each running its own wasm instance and FLAC/LZMA state? [unverified]
7. **WebKit JSC against V8 speed** for LZMA and libdeflate wasm. Only V8 (Node) was measured here.
8. **Fast-LZMA2 unwrapping** (§5.2) and ECT were not measured. Both are unlikely to matter.
9. **The exact gain from rows 1 and 3 inside the real app.** Estimated here from component timings; confirm by profiling the job worker and helpers.
