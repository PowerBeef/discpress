# Hard-forking chdman for Discpress: strategy and roadmap

This is the synthesis of the research dossier in this folder (see [README.md](README.md)). It turns the findings into decisions and an ordered plan. The claims are sourced in the lane reports and in [measurements.md](measurements.md); section references like "C §5" point to [optical-media.md](optical-media.md) and its siblings:

| Letter | Lane report |
|---|---|
| A | [format.md](format.md) |
| B | [chdman-internals.md](chdman-internals.md) |
| C | [optical-media.md](optical-media.md) |
| D1 | [ecosystem-sony-dreamcast.md](ecosystem-sony-dreamcast.md) |
| D2 | [ecosystem-other.md](ecosystem-other.md) |
| E | [history-community.md](history-community.md) |
| G | [encoders.md](encoders.md) |

## 1. Where Discpress stands today

**Engine.** Up to 1.2.0, Discpress compiled MAME's chdman from a pinned MAME **master** commit, `76c7d19` (0.289 plus 1,167 commits, including output-changing ones); 1.2.1 pins the `mame0289` release tag instead (milestone 0). On top sits a 130-line patch that farms hunk compression out to helper Web Workers, with Asyncify yielding to JavaScript. The engine is driven through `callMain`, and progress is scraped from text (B §6).

**Promise.** The app, CLAUDE.md and every release note say the CHDs are "byte for byte" what desktop chdman 0.289 makes. The research shows that promise is false in three ways:

1. **LZMA level.** Upstream commit `c23567b509` (2026-08-04) moved the CHD LZMA level from 8 to 6. Every CHD with LZMA hunks therefore differs from the 0.289 release in its file bytes. The CHD SHA-1 is unchanged (B §5.5, C §11, measurements §5).
2. **GD-ROM layout.** Two post-0.289 commits (#15808, #15870) changed how Dreamcast images are laid out:
   - `.gdi`-sourced CHDs put the high-density area 150+ sectors late, even in MAME's own reader;
   - every GD CHD now carries pregaps, which **every released Flycast (≤ 2.7) rejects**.

   Different metadata also means a different CHD SHA-1 (C §5, D1 §1.5).
3. **FLAC is not deterministic across builds.** libFLAC's windows use `cosf`/`log`, so Emscripten's libm and glibc can pick different LPC coefficients. The app's wasm output then differs from its own native build by a few bytes on real music, with the same Data SHA-1. Official chdman builds for ARM64 (NEON) and x86 disagree for a similar reason (G §6.4; reproduced independently).

   The test suite never saw this, because its synthetic audio is sine tones and because the oracle was a native build of the *same* pinned tree.

**What does hold everywhere is the CHD's SHA-1 identity** (raw data plus checksummed metadata), except for GD-ROM. That identity is what MAME, DAT managers and software lists check.

## 2. Why a hard fork, and what kind

**Upstream does not treat CHD bytes, or even disc layout, as stable.**
- MAME's own chdman regression tests have not been updated since 2015; 20 of 31 fail today (B §1.5).
- Output-changing commits land between releases (B §5.5, E).
- Maintainers review AI-drafted or redundant patches strictly and revert them (B §5.5).

**Discpress needs things chdman does not provide:**
- stable, verifiable output across platforms;
- a library-shaped engine for the browser (no `main()`, no Asyncify, streamed input, events);
- system-aware policies (the app knows the console);
- Redump-exact extraction and verification;
- robust input handling.

**Recommendation.** Make a **hard fork of chdman's minimal closure** into the Discpress repo, as `engine/`, and keep it BSD-3-Clause.

- chdman needs only **78 of the 144 objects** the build compiles today. Every one is BSD-3, zlib, MIT, Xiph-BSD or public domain, with zstd's BSD option chosen. Two compiled files have no licence header and must be dropped: `disasmintf.cpp` and the `nanosvg.cpp` wrapper (B §7).
- Track upstream by reviewed cherry-picks, not by re-pinning master.
- Keep a **reference build of an official MAME release** as the byte-identity oracle.

A rewrite, for example in Rust, is not recommended. Byte identity depends on the exact library code, and the ring-buffer "stale tail" semantics would have to be reproduced (B §2.12). chd-rs and rchd already exist as *readers* and make good test oracles.

## 3. The compatibility contract

These rules come from the emulator survey (D1 §8, D2 §15, G §1). A Discpress CHD must satisfy all of them by default.

**CD (all CD-based systems)**

| Aspect | Rule | Evidence |
|---|---|---|
| Codec list | `cdlz,cdzl,cdfl` exactly. **Never list zstd/cdzs**: libchdr and MAME refuse to open a CHD whose header merely *lists* an unknown codec, and at least ten current readers lack zstd (Opera, Kronos, Yabause, Beetle SuperGrafx, WinUAE, BlastEm-libretro, AetherSX2/NetherSX2, RetroArch ≤ 1.21, …) | D1 §8.1, D2 §15.1; verified in `libchdr_chd.c:2150` |
| Hunk size | 19,584 bytes (8 frames). Any multiple of 2448 is legal, but never exceed 512 KiB (rchd limit), and the default is the only size that is battle-tested | D1 §8.2, D2 §15.2 |
| Metadata strings | Exactly MAME's `CHT2` format and type spellings. sscanf readers require all 8 fields. Beetle PSX accepts only `MODE2_RAW`/`AUDIO` | D1 §8.3 |
| Pregaps | INDEX 00 frames present in the file are **stored** and flagged `PGTYPE:V…`. `PREGAP` commands become virtual. Seven readers assume "stored", two read `V` inverted, and BizHawk rejects `V` with `PREGAP:0` | D2 §15.4 |
| Postgap | Only when the cue has one: three readers wrongly add it to the storage offset | D2 §15.4 |
| Subcode | `SUBTYPE:NONE` unless the source really carries subcode. Every Beetle core refuses a disc with any subcode track, and so does Flycast ≤ 2.7 | D2 §15.3, D1 §5.1 |
| Sessions | `CHSE` only for true multi-session sources (post-0.289 behaviour). It is **required** by Virtual Jaguar (Jaguar CD), **fatal** to Kronos, Yabause and jgenesis, and ignored elsewhere. Redump has multi-session discs only for Jaguar CD (38/38), Dreamcast MIL-CD (89) and PC (161) | D2 §15.3, C §3.5 |
| Parent CHDs | Never by default. Only DuckStation, Beetle PSX, PCSX2, LRPS2 and MAME load them | D1 §8.6, D2 §15.5 |

**GD-ROM (Dreamcast, NAOMI)**

| Aspect | Rule | Evidence |
|---|---|---|
| Layout | chdman 0.264–0.289 layout: `PREGAP:0` everywhere, pregap frames absorbed into the previous track, `PAD` only before LBA 45000. It is the only layout every Flycast release and MAME place correctly | D1 §1.5, C §5 |

**DVD (PS2, PSP)**

| Aspect | Rule | Evidence |
|---|---|---|
| Codec list | `lzma,zlib,huff,flac` | D1 §8.4 |
| Hunk size | 2048 for PSP (PPSSPP docs). 2048 is also the only size MAME's `dvdrom_file` accepts, even though chdman's default is 4096 | D1 §4, C §6 |
| Metadata | Keep the 1-byte `DVD ` tag (Play! and RetroArch need it) and 2048-byte units | D1 §8.3 |
| Emulator notes | AetherSX2/NetherSX2 cannot read DVD CHDs, so offer `createcd` there | D1 §3.4 |

**Encoder freedom inside the codecs** (G §1, verified against MAME, libchdr and rchd decoders)

| Codec | Fixed by readers | Free for the encoder |
|---|---|---|
| LZMA | lc/lp/pb = 3/0/2 | dictionary (at least the hunk), fb, mc, match finder |
| FLAC | frames ≤ `blocksize()` (2352 for CD), Rice partition order ≤ 8 | LPC order, precision, apodization |
| Deflate | raw deflate | any conforming encoder |
| zstd | one frame per hunk, window ≤ 2²⁷ | level |

**Identity.** Codec and hunk choices never change the CHD SHA-1. Metadata changes always do. Extra *non-checksummed* metadata changes neither the SHA-1 nor any reader's behaviour (C §2).

### Output tiers

| Tier | What it guarantees | What it may change | Use |
|---|---|---|---|
| **R: reference** | File bytes identical to a named official chdman release on the reference platform, with the same CHD SHA-1 | nothing | default "compatible" output; test oracle |
| **C: compatible** | Same CHD SHA-1 as tier R; the same codec list and hunk size, so it is readable wherever tier R is | encoder choices (codec planning, early abort, better encoders) | "Fast" and "Smallest" presets |
| **X: extended** | Readable only by newer or specific readers, or a different SHA-1 | zstd/cdzs, hunk size, subcode ingest, sessions, parents, fidelity metadata that is checksummed | explicit opt-in, with per-system reader warnings |

Discpress knows the system of every job, so policies can be **system-aware**. Examples:
- write `CHSE` for Jaguar CD, where Virtual Jaguar needs it;
- warn about it for Saturn, where Kronos and Yabause break;
- disable zstd for 3DO, Saturn, SuperGrafx and Amiga;
- use `createdvd -hs 2048` for PSP.

## 4. Roadmap

Effort estimates assume one developer working with the existing test harness.

### Milestone 0: correctness hotfix (days)

This affects users today, so it ships as its own small release before any fork work.

**Status: shipped in Discpress 1.2.1.**
- Re-pinned to the `mame0289` tag: GD-ROM layout and LZMA level are 0.289's, and the native build is byte-identical to an independent 0.289 build on every fixture.
- `tests/ui/gdrom.spec.js` checks the layout for a `.gdi` and a Redump cue.
- The claims now say "same checksums as chdman 0.289, the same bytes for data".
- Guard rails in the app:
  - descriptors are decoded (BOM, UTF-16, Windows-1252, CR-only line ends) and cue keywords upper-cased;
  - cues without tracks or with track numbers outside 1–99 are refused, and so are TOCs with a track length chdman can't read;
  - chdman's own one-file-per-track TOC is repaired (`DATAFILE "f" #0 length`; chdman drops those tracks otherwise);
  - binary `.toc` files are skipped;
  - raw `.iso` images get a cue with their sector mode;
  - a `nan%` progress watchdog stops any remaining endless run.
- Still open: more GD types (1, 2 and 3-split) and the CC0 music fixture for the FLAC divergence.

1. **GD-ROM.**
   - **Minimal fix:** revert #15870's `.gdi` virtual-pregap branch to 0.289's "gap becomes `PAD` of the previous track".
   - **Full parity:** also restore 0.289's Redump-cue pregap absorption (`splitframes`) and its extract-to-cue heuristics.
   - Lane C validated this: output is byte-identical to 0.289 for four DC layouts and `aerowings.gdi`, with track 3 at 45000 (C §13.1).
   - Add fixtures for GD types 1, 2, 3 and 3-split in both `.gdi` and Redump `.cue` form, with golden `CHGD` strings and a reader-layout assertion (track 3 at LBA 45000 in MAME's `cdrom_file` and in the Flycast model).
2. **Identity baseline.**
   - Set `props.level = 8` in `chdcodec.cpp`. This restores byte identity with the 0.289 release for data; lanes B and C verified it on four fixtures with the 26.02 SDK.
   - Or re-pin to the `mame0289` tag. Either way, pick **one** named reference and say so.
3. **Honest claims.**
   - Change the wording in the README, the help page, CLAUDE.md and the next release notes to "same CHD SHA-1 as chdman 0.289", not "byte for byte", until milestone 2.3 makes the stronger claim true.
   - Change the test oracle to a build of the **official release tag** plus the Discpress build. Add a long CC0 music fixture that exposes the FLAC divergence.
4. **Input guard rails in the app** (C §9, §12):
   - refuse inputs that parse to 0 tracks (chdman loops forever) or more than 99 tracks (it crashes);
   - strip the UTF-8 BOM and upper-case cue keywords;
   - never pass a binary `.toc` (redumper) as a cdrdao TOC;
   - build explicit cues for raw `.iso` images that `parse_iso` would mis-type.

### Milestone 1: the engine fork (1–2 weeks)

**Status: step 1 done.**
- The engine is in `engine/` (see `engine/README.md`): 75 MAME 0.289 source files and their headers, with the browser patch applied as ordinary code.
- The unused utf8proc-backed functions are gone, and so are disasmintf, nanosvg, expat and the unused LZMA/7z files.
- It builds without a MAME checkout. The objects are byte-identical to the old build's (except `unicode.o`), and the build stays reproducible.
- The tests now compare with unmodified chdman 0.289 (`scripts/build-upstream.sh`).

**Step 2 (Asyncify) done.**
- The compressing commands are C++20 coroutines, so the page drives them step by step (`chdman_begin`/`chdman_resume`) and the whole CLI keeps working, the Advanced tab included.
- Asyncify is gone from the build, so the wasm and its glue are smaller.
- Natively, output, messages and exit codes match upstream.
- Still to do in step 2: structured progress events and the push-input API that would retire `FileReaderSync` and the iOS staging protocol.

**Step 3, the defect fixes: done** (see `engine/README.md`).
- `verify` exits 1 on a mismatch.
- `copy x→x` no longer destroys the input; no output is ever written over an input.
- `extractcd` of a non-CD, and `-us 0`/`-ss 0`, are errors, not crashes.
- `dumpmeta` keeps stdout clean.
- Still open: the `-np 1` busy-wait and a native thread pool without the 16-thread cap. Both matter for the native CLI only.

1. **Extract `engine/`.** Take the 78-object closure (B §7.1) at the reference tag, re-apply `mame.patch` as ordinary code, and drop `disasmintf`, `nanosvg`, expat and the unused LZMA/7z files. Fix `THIRD_PARTY_NOTICES.md`.
2. **Library API instead of `callMain`.** `chd_file_compressor` is already a resumable state machine (`compress_begin`/`compress_continue`). Expose:
   - `create_open` → `step` → `finish`;
   - metadata writers;
   - an explicit **codec plan**;
   - structured **progress events** and error codes;
   - **push input**, i.e. "here are the next N bytes". This replaces `FileReaderSync` and the iOS staging protocol.

   This **removes Asyncify** (JSPI is Baseline since 2026-09-14 but is no longer needed) and removes the text scraping (B §6.5, G §10.1). Tier-R identity requires keeping the ring and stale-tail semantics bit-exact (B §2.12).
3. **Pluggable executor.** Web Workers in the browser; a native thread pool without the 16-thread cap and with correct `-np` semantics. The writer and dedupe decisions stay single-threaded and ordered, which is why output does not depend on thread count.
4. **Keep a thin `chdman`-compatible CLI** over the library for native tests and power users. Fix the defects that change nothing for valid input (B §5.1):
   - `verify` exits 0 on a mismatch;
   - `copy x→x` destroys the input;
   - `throw nullptr` / SIGFPE crashes;
   - the banner on stdout;
   - the `-np 1` busy-wait.

### Milestone 2: performance (1–2 weeks)

**Status: 2.1, 2.3, 2.4 and 2.8 done (2.8 for extract and verify), and part of 2.2** (see `engine/README.md`; measured in measurements §2).
- **2.3 deterministic libm.** libFLAC calls `engine/libm`'s `cosf` and `log`, Arm's optimized-routines code that glibc is built from. The `log` gives the fused results where GCC fuses glibc's multiply-adds for FMA CPUs.
  - Checked against glibc: `cosf` on all 1.97 billion window arguments, `log` on 200 million inputs. Both are identical natively and in wasm.
  - The page's CD-audio CHDs of 114 MB of real music now match unmodified chdman 0.289 byte for byte (before: different).
  - The `music-cd` fixture fails without it.
  - The autocorrelation was already the C one (`FLAC__NO_ASM`, as MAME's x86 GCC builds).
  - Cost: wasm has no FMA instruction. With musl's exact software `fma()`, `log` took 160 ns against musl's own `log` at 6 ns, and DVD creation got 20% slower (a DVD hunk calls `log` about 670 times). Now `log` computes the fused results from plain operations: two exactly, the rest unfused where a proven bound shows that can't change the result, and emulated otherwise (about 1 call in 2,500; `engine/libm/README.md`). It takes 11–13 ns, and creating CHDs is within 1% of the time with musl's functions.
  - Still different: chdman on non-FMA x86, Apple's libm and MSVC's CRT round differently, and ARM64 builds sum the autocorrelation with NEON.
- **2.8 parallel decompression.** In the page, helper workers decompress the hunks `verify` and the extract commands are about to read, a window at a time. The windows' stored data is read in one go, since each small read costs far more in the browser than its bytes do.
  - Benchmark CD (332 MB), extracting with 4 threads: 2.5× faster (7.2 s → 2.8 s).
  - Benchmark DVD (1 GB): 1.4× faster (13.4 s → 9.3 s). Its 4 KB hunks leave most of the time to the job worker, which reads, checks and writes 1 GB.
  - With 1 thread: 5–12% faster, from the larger reads.
  - Still open for 2.8: the parent walk (creating with `-op`) and `copy`. Identification of a CHD only reads a few sectors, so it doesn't need it.
- **2.1 hashing.** SHA-1 is unrolled and reads whole big-endian words; CRC-16 is slice-by-8. Both give the same results, 5× faster in wasm (SHA-1 650 MB/s, CRC-16 1,450 MB/s). So the whole-image SHA-1 no longer limits the job worker, and Web Crypto isn't needed.
- In the page, 2.1 makes the benchmark CD and DVD convert 5–10% faster. Together with milestone 1's coroutines and 2.4, conversions are about 25% faster than in 1.2.1.
- **2.4 early abort.** Each hunk tries the previous hunk's winner first, and every other codec stops once it can't beat the best result. The output is byte-identical: 294 fixture, stress-image and codec-list combinations match unmodified 0.289, and `tests/ui/engine.spec.js` keeps checking it.
- Measured CPU savings: 1.06× on CD data, 1.47× on CD audio, 1.10× on DVD. That is below the estimate, because deflate and single-frame FLAC can't stop partway through a hunk.
- In the page, the benchmark CD and DVD convert 5–8% faster with 1 or 4 threads.
- **2.2, done so far:** FLAC skips its MD5 in memory, and generic `flac` never encodes a hunk a third time.
- **2.2, still open:** ECC verify once per CD hunk, and in-flight dedupe.
- **Build fix found on the way:** `wasm/Makefile` now tracks header dependencies. A stale object had disagreed with a changed class layout.

Numbers are single-core CPU unless noted (measurements §1–2, G §11–12).

| # | Change | Tier | Measured or estimated gain |
|---|---|---|---|
| 2.1 | Faster SHA-1 (unrolled; the Web Crypto API per hunk) and slice-by-8 CRC-16 | R | Removes the serial job-worker ceiling of about 80 MB/s in wasm (150 MB/s native); −3–6% helper CPU |
| 2.2 | FLAC MD5 off; generic `flac` encodes into two buffers (no third encode); ECC verify once per CD hunk; in-flight dedupe | R | −5–10% FLAC CPU; −20–33% generic FLAC; −1–2% CD data |
| 2.3 | **Deterministic libm for libFLAC** (vendored `cosf`/`log`, forward-order autocorrelation) in every build | R | Makes wasm = native = ARM64 for CD audio. The prerequisite for any "byte-identical" claim |
| 2.4 | **Early abort**: run the predicted winner first; cap later codecs at the current best; small LZMA SDK patch to check the output size during the block | R | 1.2× (CD data), 1.65× (CD audio), 1.24× (DVD), estimated |
| 2.5 | **Codec plan per track type**: data tracks `cdlz`(+`cdzl`), audio tracks `cdfl`; DVD without generic FLAC, or with a FLAC-0 probe | C | 2.0× CD data (+0.22%), **2.8× CD audio (±0)**, 1.55× DVD (+0.06%) |
| 2.6 | libdeflate-9 in place of zlib-9 for the deflate trial | C | Deflate 2–3× faster at equal size |
| 2.7 | "Smallest" preset: LZMA fb 273/mc 1000, libdeflate-12, FLAC `-p` | C | Measured −0.47% (CD) and −0.84% (DVD) at about 2.5× CPU; up to −5% on very compressible data (G) |
| 2.8 | Parallel decompression for extract, verify, identification and parent walk | R (read only) | Today these are single-threaded at 45–50 MB/s native: 4–8× on typical devices |
| 2.9 | Per-system hunk-size policy (for example PS2 DVD at 16 KiB) | X | −9% (16 KiB) to −16% (64 KiB) on DVD; costs random-read latency; MAME needs 2048 |

Presets:
- **Compatible** (default) = 2.1–2.4 + 2.8.
- **Fast** = plus 2.5 and 2.6, for phones: G measured Snapdragon parts throttling to 30–58% and iPhones exposing 2 performance cores.
- **Smallest** = plus 2.7.
- Anything in tier X is an explicit expert choice with reader warnings.

### Milestone 3: fidelity and verification (2–3 weeks)

**Status: Redump's layout on extraction done** (`extractcd --redump`, the page's default for CDs). Real Redump cue sheets, 500 per system with synthetic bins, come back byte for byte through createcd and `extractcd --redump`: PS2 99.8%, PS1 98.4%, Naomi 100%, Dreamcast 94% (the rest are multi-session MIL-CDs), CDTV 92%, 53% of all 5,676. The others need the metadata below (CATALOG, FLAGS, INDEX ≥ 2, `CDI/2352`). The built-in database (libretro-database) has one ROM per game, so verifying every track needs Redump's own DATs. With it, **Verify** now also compares a CHD with Redump: the page extracts with Redump's layout into checksums only (the worker's `crc` output) and looks the files up by size and CRC-32, which checks the ISO, the only `.bin` or the main data track, and confirms the exact release.

1. **Redump-exact extraction.**
   - Store CATALOG, ISRC, FLAGS, INDEX ≥ 2, the original track-type string and the original cue text as **non-checksummed metadata**, appended after the CD tags. The CHD SHA-1 is unchanged and every reader ignores them (C §2, §7).
   - Extract with CRLF line endings and Redump naming.
   - This lifts cue reproducibility from 77% of 72,022 Redump cues to about 100%.
2. **Verify inside the CHD.** Hash each track range straight from the CHD, with audio swapped back to little-endian and stored pregaps included, and match it against a per-track Redump DB. This extends `db/mkdb.py`, which today keeps only the first ROM per game. It also gives the app a "Verified dump" badge with no extraction step (C §7.2, D1 §2.1).
3. **Fix the cue/TOC/NRG parser bugs** (C §12), each with a synthetic fixture:
   - MOTOROLA audio double-swapped;
   - shared-file offsets;
   - multi-track WAVE files;
   - EAC-style gaps;
   - the NRG pregap offset;
   - `parse_iso` mis-typing;
   - cdrdao TOC semantics;
   - 0-track hang and 100-track crash.
4. **Session geometry.** Store the lead-out/lead-in gap as non-checksummed metadata, and fix the `CHSE` metadata-order fragility (C §3.3). Report both upstream.

### Milestone 4: more inputs (ongoing, by demand)

**Status: CloneCD (single-session) and CSO/ZSO done.**
- CloneCD: the page turns a `.ccd` into a cue sheet for its `.img` (`ccdToCue`). The `.sub` is noted and left out; subchannel ingest stays tier X. Multi-session, scrambled and track-list-less (CloneCD 2) files are refused with the reason.
- CSO v1 and v2 and ZSO (maxcso's formats, for PSP and PS2): the job worker hands chdman the ISO inside, decompressing blocks as they are read (`CisoStore`), so the CHD is the one chdman makes from that ISO. Identification reads the ISO the same way, and its checksum is the ISO's. A damaged block stops the job with its number.
- Found on the way: 0.289's `createraw`/`createhd`/`createdvd` ignore input read errors and write a CHD they can't open. The engine now stops with an error (`tests/ui/engine.spec.js`).

Priority order (C §9):
1. CloneCD `.ccd/.img/.sub`, which also enables subchannel ingest for LibCrypt and CD+G;
2. DiscJuggler `.cdi` for Dreamcast homebrew and MIL-CD;
3. ECM;
4. FLAC, WAV or AIFF audio referenced from cues;
5. CSO/ZSO → DVD;
6. MDS/MDF;
7. fuller NRG support.

**Subchannel ingest** writes `SUBTYPE:RW_RAW`, i.e. tier X, because Beetle cores and Flycast ≤ 2.7 refuse such discs. Offer it per system (PS1 LibCrypt, CD+G), with warnings. Keep recommending `.sbi` sidecars for PS1 by default.

**GameCube and Wii** have no CHD reader anywhere; their format is RVZ (D2 §12). It is out of scope for this fork.

## 5. Test and verification strategy

- **Oracles.** Each output is checked against a set of oracles, not one:
  - the official chdman release build (tier-R bytes);
  - MAME's decoders plus `cdrom_file`/`dvdrom_file` layout probes;
  - upstream libchdr, both HEAD and a 2024-06 snapshot (the libretro cores' vendored base);
  - rchd, with and without zstd;
  - chd-rs;
  - a Flycast layout model that includes the v2.7 rejection rule;
  - three behavioural reader models from D2: "assumes stored", "wildcard metadata" and "`V` = virtual".
- **Checks:** the CHD SHA-1, the per-track INDEX 01 LBAs, and CD-DA sample offsets.
- **Corpora:**
  - the existing synthetic fixtures;
  - the generators from lanes C and D1 (GD types, multi-session, CD+G, MOTOROLA, virtual gaps, HTOA);
  - [the codec lab](lab/README.md), with its freely licensed corpus for performance work;
  - at least one long CC0 music track to catch FLAC nondeterminism.
- **Layout lint.** Add a `verify --layout` mode that prints how MAME and libchdr would see the disc (INDEX 01 LBAs, session starts, the 45000 boundary, `V` semantics) and flags the ambiguous cases. It should run in CI and be offered to users.

## 6. Upstream relations

These bugs are worth reporting to MAME with minimal repros; lane C and D1 files can serve as those repros:
- the `.gdi` regression from #15870 and the GD cue mounting regression;
- the `dvdrom_file` 2048-byte requirement versus chdman's 4096 default;
- `verify` exit codes;
- the `CHSE` order fragility;
- the 0-track loop and the 100-track crash;
- MOTOROLA double-swap.

Also report to the reader projects:
- BlastEm-libretro and Virtual Jaguar invert the meaning of `V`;
- Kronos, Yabause and jgenesis abort on unknown metadata tags;
- PCSX ReARMed, Ymir and DOSBox-X ignore the 4-frame padding;
- Flycast 2.8 should ship its pregap support.

Upstream maintainers are selective, so send small, well-argued, tested patches (B §5.5).

## 7. Risks

- **Reader fragmentation is growing.** In 2026 alone:
  - libretro moved to rchd, a clean-room reader with different limits;
  - libchdr gained LOWRAM/MCU targets;
  - Flycast changed its pregap rules.

  Compatibility must be re-tested whenever major readers release (D1 §0.9, D2 §14).
- **Byte identity is fragile.** It depends on library versions, compiler flags, libm and SIMD kernels (B §5.4, G §6.4). Only the CHD SHA-1 is robust. Promise that, plus tier-R bytes on the *reference platform*.
- **Real-disc validation is missing.** All measurements use synthetic or freely licensed data. The codec-plan and early-abort gains need confirmation on real discs; the lab can replay user-supplied images locally.
- **Upstream will keep changing.** MAME 0.290 may ship the GD layout, or fix it, and may keep LZMA level 6. The reference tier must name its release, and moving to a new one should be a deliberate, tested step.
