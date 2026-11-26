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

## 1. Where Discpress stood at the research (1.2.0)

This section describes the app as the research found it. Since then the engine has become the fork in `engine/` (milestone 1) and the promise below holds again; the table at the start of the roadmap (§4) says where each milestone stands.

**Engine.** Up to 1.2.0, Discpress compiled MAME's chdman from a pinned MAME **master** commit, `76c7d19` (0.289 plus 1,167 commits, including output-changing ones); 1.2.1 pins the `mame0289` release tag instead (milestone 0). On top sits a 130-line patch that farms hunk compression out to helper Web Workers, with Asyncify yielding to JavaScript. The engine is driven through `callMain`, and progress is scraped from text (B §6).

**Promise.** The app, CLAUDE.md (now `AGENTS.md`) and every release note say the CHDs are "byte for byte" what desktop chdman 0.289 makes. The research shows that promise is false in three ways:

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
| Subcode | `SUBTYPE:NONE` by default unless the source really carries subcode. Every Beetle core refuses a disc with any subcode track, and so does Flycast ≤ 2.7. Since 2.0.0, CD+G cue tracks (`AUDIO RW_RAW`) and opt-in CloneCD `.sub` `RW_RAW` ingest are supported as Tier X with per-emulator warnings | D2 §15.3, D1 §5.1 |
| Sessions | Never written by default: chdman 0.289 never writes `CHSE`, and Kronos, Yabause and jgenesis refuse any disc that carries it. Since 2.0.0, `createcd --sessions` writes `CHSE` opt-in for Jaguar CD (where Virtual Jaguar requires it; milestone 7, step 2) and never for Saturn, Sega CD or PC Engine CD. Redump has multi-session discs only for Jaguar CD (38/38), Dreamcast MIL-CD (89) and PC (161) | D2 §15.3, C §3.5 |
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
| Emulator notes | AetherSX2/NetherSX2 and PCSX2 builds from before April 2023 cannot read DVD CHDs, so the app offers `createcd` there. Since 2.0.0, Settings → Target Environment profiles (`TARGETS` in `app/ui.js`) replaced the standalone compatibility toggle: `Handheld` and `Legacy` turn on PS2 DVD → CD CHDs (upgraded from 1.8.1's `settings.compat` / 1.4.0's "PlayStation 2 DVD games"), and without them the card says which emulators need a CD CHD | D1 §0, §3.4 |

**Encoder freedom inside the codecs** (G §1, verified against MAME, libchdr and rchd decoders)

| Codec | Fixed by readers | Free for the encoder |
|---|---|---|
| LZMA | lc/lp/pb = 3/0/2 | dictionary (at least the hunk), fb, mc, match finder |
| FLAC | frames ≤ `blocksize()` (2352 for CD), Rice partition order ≤ 8 | LPC order, precision, apodization |
| Deflate | raw deflate | any conforming encoder |
| zstd | one frame per hunk, window ≤ 2²⁷ | level |

**Identity.** Codec and hunk choices never change the CHD SHA-1. Metadata changes always do. Extra *non-checksummed* metadata doesn't change the SHA-1s, and most readers ignore it (C §2), but not all: Kronos and Yabause (Saturn) and jgenesis (Sega CD, PC Engine CD) refuse a CHD with any tag that isn't a track's (D2 §0). So the app leaves `--keepcue`, whose `CUES` tag is such metadata, out for those three consoles (`keepcue-strict` in `app/quirks.js`).

### Output tiers

| Tier | What it guarantees | What it may change | Use |
|---|---|---|---|
| **R: reference** | File bytes identical to a named official chdman release on the reference platform, with the same CHD SHA-1 | nothing | the default output and the test oracle. In the app this is the preset "Smallest (default)", which is chdman's own default settings |
| **C: compatible** | Same CHD SHA-1 as tier R; no codec that tier R's list lacks, and the same hunk size, so every reader of tier R decodes it | encoder choices (codec planning, better encoders), a shorter codec list, extra non-checksummed metadata (which three readers refuse: see Identity) | opt-in: "Nearly as small, faster" (`--codecplan --libdeflate`), "Faster to create" (`cdzl,cdfl` or DVD `zlib` with `--libdeflate`), "Smaller still" (`--ultra --libdeflate`, shipped in 2.0.0), and `--keepcue` |
| **X: extended** | Readable only by newer or specific readers, or a different SHA-1 | zstd/cdzs, hunk size (except the contract's 2048 for PSP), subcode ingest, sessions, parents, fidelity metadata that is checksummed | explicit opt-in, with per-system reader warnings: "Faster to load (Zstd)" and "For MiSTer FPGA" (`--zstd-level 19`), a chosen hunk size, CloneCD `.sub` `RW_RAW` / CD+G, and milestone 7's layout repairs (`--sessions`, `--trailer`) |

The preset names are the app's. "Smaller still" (2.7, `--ultra --libdeflate`) shipped in 2.0.0 as an opt-in tier-C preset; earlier versions of the plan called it "Smallest", which in the app is the default tier-R preset ("Smallest (default)"). Early abort (2.4) keeps chdman's bytes, so it is tier R, not an encoder choice of tier C.

Discpress knows the system of every job, so policies can be **system-aware**. Examples, with what became of each:
- write `CHSE` for Jaguar CD, where Virtual Jaguar needs it (shipped in 2.0.0: `createcd --sessions`, milestone 7 step 2);
- protect strict-metadata readers (Kronos, Yabause, jgenesis): `CUES` and `CHSE` are never written for Saturn, Sega CD or PC Engine CD, and milestone 7's lossless repair record uses an unlinked `DPRC0001` EOF trailer (`--trailer`) outside CHD's metadata chain;
- warn about zstd for 3DO, Saturn, SuperGrafx, Amiga, PS2, Dreamcast, NAOMI and PC-FX, and choose sensible per-console presets inside the 6 Target Environment profiles (`TARGETS` in `app/ui.js`: e.g. `MiSTer` falls back to `plan` on consoles without a MiSTer core or 32X CD, and `Legacy` uses `-c none` on PC CDs for DOSBox Pure);
- use `createdvd -hs 2048` for PSP (built).

## 4. Roadmap

Effort estimates assume one developer working with the existing test harness. The statuses are as of Discpress 2.0.1.

| Milestone | Status |
|---|---|
| 0. Correctness hotfix | Shipped in 1.2.1 |
| 1. The engine fork | Steps 1, 3 and 4 done; step 2 mostly done (Asyncify gone; 48-byte `_wasm_progress_ptr` exposed for custom workers while chdman UI still parses text; push input open) |
| 2. Performance | 2.1–2.8 done (2.2 ECC once via `cd_prep_cache` done; native in-flight dedupe open); 2.9 remains user-chosen beyond PSP 2048 and MiSTer 9792 |
| 3. Fidelity and verification | Done (single-pass `verify --redump`, Redump-exact extraction, parser fixes, `DPDB v2` multi-track schema, and milestone 7 session handling) |
| 4. More inputs | Done for CD/DVD/archive/audio inputs (CloneCD + opt-in `.sub`, CSO/ZSO, ECM, PBP, `.zip`, `.7z`, `.mds`/`.mdf`, `.cdi`, FLAC/WAV/RF64/AIFF/OGG/MP3, CD+G); `.isz`/`.mdx`/`.rar` refused |
| 5. What users ask for | Done (1.5.0) |
| 6. Detection that knows the game | Done (1.7.0; Saturn cartridges and PC-98 + Phase 2 detectors completed in 2.0.0) |
| 7. Layouts each emulator reads right | Done (2.0.0: all 5 repair steps + unlinked `DPRC0001` trailer + 12-check browser CHD Auditor; CSO/ZSO & scrubbed XISO writers shipped; PBP writer, RVZ, and external C/Rust CI oracles remain open) |

The releases after milestone 6 are summarized below (technical fork details live in [`engine/README.md`](../../engine/README.md)):
- **1.8.0** fixed what a full review of the app found: discs that took another game's tracks or name, results that could be lost, slow adding of big folders.
- **1.8.1** replaced 1.4.0's setting "PlayStation 2 DVD games" with Settings → "Compatibility mode for older emulators" (`settings.compat`). On, PS2 games on DVD become CD CHDs (§3, DVD), and the Zstd presets warn for every console that older emulators can't open them.
- **1.8.2** aligned documentation with the app and hardened self-referencing and oversized hunks.
- **1.9.0** completed Milestone 1 step 3 (C++20 native thread pool replacing `osd_work_queue`, removing the 16-thread cap and `-np 1` busy-wait), cut browser job-worker memory (~30 MiB) and single-file size (~220 KB), hardened CHD metadata/header/map/codec and descriptor parsing, expanded emulator quirks (`pcecd` `keepcue-strict`, `MODE2_FORM_MIX`, `jgenesis`, `PCSX ReARMed`, `nrgModel`), and completed all 197 LibCrypt entries.
- **2.0.0** completed Milestone 7 (all 5 Tier-X layout repairs, `createcd --sessions`, unlinked `DPRC0001` `--trailer` reversed by `extractcd --redump`, `copy --stripmeta`, and the 12-check browser CHD Health Auditor), finished Milestone 2 (`cd_prep_cache`, adaptive `--codecplan`, `--ultra` **Smaller still**, `--zstd-level`, persistent LZMA + `LzFind.c` epoch hash reuse, WASM SIMD128 & 64-bit codec paths, dynamic 8 MiB work buffer, 32-byte WASM hash entries, DVD-9 early memory release, parallel `copy`/`-op` decompression), added single-pass `verify --redump`, crash-resumable OPFS checkpoints, warm worker pool, 6 Target Environment profiles, `.7z`/`.cdi`/`.mds`/`.mdf`/audio-cue/CD+G/opt-in `.sub` inputs, CSO/ZSO and scrubbed XISO writers, `saturn-cart.tsv` (32 entries), PC-98 + Phase 2 console detectors, `#16644` legacy FLAC EOS handling, and Phase 2 security hardening.
- **2.0.1** tightened `chdcodec.cpp`'s PCM probe to eliminate DVD false positives, replaced ARM64-heavy short-match SIMD loops with 64-bit `i64` XOR+`ctzll`, aligned worker batching with the 256-hunk work buffer, and verified up to 9.6% faster 4-thread DVD `plan` throughput alongside 15–19% lower 4-thread peak RSS vs 1.8.2 ([measurements.md](measurements.md) §8).

### Milestone 0: correctness hotfix (days)

This affects users today, so it ships as its own small release before any fork work.

**Status: shipped in Discpress 1.2.1.**
- Re-pinned to the `mame0289` tag: GD-ROM layout and LZMA level are 0.289's, and the native build is byte-identical to an independent 0.289 build on every fixture.
- `tests/ui/gdrom.spec.js` checks the layout for a `.gdi` and a Redump cue.
- The claims then said "same checksums as chdman 0.289, the same bytes for data". Since milestone 2.3 (1.3.0) they say "byte for byte" again, CD audio included.
- Guard rails in the app:
  - descriptors are decoded (BOM, UTF-16, Windows-1252, CR-only line ends) and cue keywords upper-cased;
  - cues without tracks or with track numbers outside 1–99 are refused, and so are TOCs without tracks;
  - 1.2.1 also refused TOCs with a track length chdman couldn't read, and repaired chdman's own one-file-per-track TOC (`DATAFILE "f" #0 length`; chdman dropped those tracks otherwise). Both left the app in 1.4.0: the engine reads cdrdao's TOC grammar since (milestone 3, B11), so `fixDescriptor` only refuses a TOC without tracks;
  - binary `.toc` files are skipped;
  - raw `.iso` images get a cue with their sector mode;
  - a `nan%` progress watchdog stops any remaining endless run.
- Done since: `tests/ui/engine.spec.js` builds GD types 1, 2, 3 and 3-split (`gd1`, `gd2`, `gd3`, `gd3s`), each as a GDI and as a Redump cue sheet, and checks that both give 0.289's CHD and layout (no pregaps, the high-density area at LBA 45000). The FLAC divergence is caught by the `music-cd` fixture: 10 s of synthetic piano, not a CC0 recording, since fixtures are generated.
- Still open: the reader-layout assertion against a Flycast model (§5).

1. **GD-ROM.**
   - **Minimal fix:** revert #15870's `.gdi` virtual-pregap branch to 0.289's "gap becomes `PAD` of the previous track".
   - **Full parity:** also restore 0.289's Redump-cue pregap absorption (`splitframes`) and its extract-to-cue heuristics.
   - Lane C validated this: output is byte-identical to 0.289 for four DC layouts and `aerowings.gdi`, with track 3 at 45000 (C §13.1).
   - Add fixtures for GD types 1, 2, 3 and 3-split in both `.gdi` and Redump `.cue` form, with golden `CHGD` strings and a reader-layout assertion (track 3 at LBA 45000 in MAME's `cdrom_file` and in the Flycast model).
2. **Identity baseline.**
   - Set `props.level = 8` in `chdcodec.cpp`. This restores byte identity with the 0.289 release for data; lanes B and C verified it on four fixtures with the 26.02 SDK.
   - Or re-pin to the `mame0289` tag. Either way, pick **one** named reference and say so.
3. **Honest claims.**
   - Change the wording in the README, the help page, CLAUDE.md (now `AGENTS.md`) and the next release notes to "same CHD SHA-1 as chdman 0.289", not "byte for byte", until milestone 2.3 makes the stronger claim true.
   - Change the test oracle to a build of the **official release tag** plus the Discpress build. Add a long CC0 music fixture that exposes the FLAC divergence.
4. **Input guard rails in the app** (C §9, §12):
   - refuse inputs that parse to 0 tracks (chdman loops forever) or more than 99 tracks (it crashes);
   - strip the UTF-8 BOM and upper-case cue keywords;
   - never pass a binary `.toc` (redumper) as a cdrdao TOC;
   - build explicit cues for raw `.iso` images that `parse_iso` would mis-type.

### Milestone 1: the engine fork (1–2 weeks)

**Status: steps 1, 3 and 4 done, step 2 mostly done** (the steps are the numbered list below).
- The engine is in `engine/` (see [`engine/README.md`](../../engine/README.md)): `engine/FILES` lists 228 MAME 0.289 files including 91 `.c`/`.cpp` files (75 core MAME/codec translation units, 14 LZMA SDK `.7z` decoder/filter C files added in 2.0.0, and 2 `#include`d libFLAC `.c` files) and their headers, with the browser patch applied as ordinary code.
- The unused utf8proc-backed functions are gone, and so are disasmintf, nanosvg, and expat.
- It builds without a MAME checkout. The objects are byte-identical to the old build's (except `unicode.o`), and the build stays reproducible.
- The tests now compare with unmodified chdman 0.289 (`scripts/build-upstream.sh`).

**Step 2: Asyncify gone; binary progress exposed.**
- The compressing commands are C++20 coroutines, so the page drives them step by step (`chdman_begin`/`chdman_resume`) and the whole CLI keeps working, the Advanced tab included.
- Asyncify is gone from the build, so the wasm and its glue are smaller.
- Natively, output, messages and exit codes match upstream.
- Structured progress & push input: since 2.0.0, `chdman.cpp` exposes a 48-byte binary progress snapshot (`_wasm_progress_ptr`) and `worker.js` emits `prog-bin`, though `app/ui.js` (`onBinProgress`) currently gates binary progress to custom workers (CSO/XISO/CDI) and still scrapes chdman's progress text; push input (retiring `FileReaderSync` / iOS staging) remains open.

**Steps 3 and 4, the native thread pool and defect fixes: done** (see `engine/README.md`).
- `verify` exits 1 on a mismatch.
- `copy x→x` no longer destroys the input; no output is ever written over an input.
- `extractcd` of a non-CD, and `-us 0`/`-ss 0`, are errors, not crashes.
- `dumpmeta` keeps stdout clean.
- C++20 native thread pool (`chd_file_compressor` in `chd.h`/`chd.cpp`, 1.9.0) replaces MAME's `osd_work_queue`: removes the 16-thread cap, runs `-np 1` inline without busy-waiting, and joins threads cleanly via `compress_abort()` on early errors.

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

**Status: 2.1–2.8 done (2.2 ECC once via `cd_prep_cache` done; native in-flight dedupe open); 2.9 remains user-chosen beyond PSP 2048 and MiSTer 9792** (see [`engine/README.md`](../../engine/README.md) for the v2.0.0–2.0.1 SIMD128/64-bit, persistent LZMA, and memory reductions, and [measurements.md](measurements.md) §2 & §8).
- **2.5 codec plan (done, opt-in).** `--codecplan` (`-cp`) on `createcd`, `createdvd`, `createhd`, `createraw` and `copy`: a CD hunk in audio tracks tries `cdfl`, one in data tracks tries `cdlz` (since 2.0.0, with an adaptive `cdzl` fallback reusing `cd_prep_cache` whenever `cdlz` exceeds 75% of the hunk), and DVD/raw hunks skip `flac` unless a ~200 ns 64-sample LE/BE stereo PCM probe detects audio; a CD hunk holding both tries all. The page's "Nearly as small, faster" preset.
  - Same codec list, data and SHA-1s as the default; 0.289 verifies the result. The same CHD at any thread count, and in the page.
  - Native, `-np 4`, CPU against the default (after 2.4, before v2.0.0 adaptive additions): CD data 1.81× (+0.22%), CD audio 1.91× (±0), a mixed CD 2.00× (+0.11%), DVD 1.38× (+0.06%).
  - In the page: the benchmark CD 1.73× faster with 1 thread and 1.62× with 4 (44.3% → 44.5% of the input), the benchmark DVD 1.53× and 1.31× (41.0% either way); v2.0.1 browser figures are in [measurements.md](measurements.md) §8.
- **2.6 libdeflate (done, opt-in).** `--libdeflate` (`-ld` on the same five commands): `zlib`, `cdzl`, `cdlz` subcode, and (since 2.0.0) `cdfl` subcode encode with [`engine/libdeflate`](../../engine/libdeflate/README.md) (MIT, with small WASM 64-bit/SIMD128 edits) at level 9 — or level 12 with `--ultra` — instead of zlib's level 9. Both faster presets and "Smaller still" use it.
  - Per hunk: 2.0× (DVD) and 2.8× (CD) faster than zlib-9, 0.4–0.5% smaller. Level 6 would be 3.7–6× faster at zlib-9's size; level 12 2.0–2.3% smaller at 2.5–3.6× zlib's time (now used by "Smaller still", 2.7).
  - Native, `-np 4`, CPU: default list 1.1–1.5× less; `cdzl,cdfl` 1.5–1.8× less and 0.3–0.7% smaller; plan + libdeflate on DVD 1.17× less than the plan alone and smaller than chdman's default.
  - In the page with 1 thread: "Faster to create" 1.26× (CD, 1.1% smaller) and 1.32× (DVD); "Nearly as small, faster" 1.10× on DVD. With 4 threads the job worker sets the pace, and neither changes.
  - The same CHDs natively, in wasm with and without SIMD, and at any thread count.
- **2.7 "Smaller still" (done in 2.0.0, opt-in).** `--ultra` (`-ul`, paired with `--libdeflate` in the page's **Smaller still** preset, Tier C): LZMA level 9 (`fb=273`, `mc=1000`, decoder-visible properties unchanged), libdeflate level 12, and libFLAC exhaustive + precision search (`-e -p`) with `"tukey(0.5);partial_tukey(2);punchout_tukey(3)"` apodization within max LPC order 12.
- **2.3 deterministic libm.** libFLAC calls `engine/libm`'s `cosf` and `log`, Arm's optimized-routines code that glibc is built from. The `log` gives the fused results where GCC fuses glibc's multiply-adds for FMA CPUs.
  - Checked against glibc: `cosf` on all 1.97 billion window arguments, `log` on 200 million inputs. Both are identical natively and in wasm.
  - The page's CD-audio CHDs of 114 MB of real music now match unmodified chdman 0.289 byte for byte (before: different).
  - The `music-cd` fixture fails without it.
  - The autocorrelation was already the C one (`FLAC__NO_ASM`, as MAME's x86 GCC builds).
  - Cost: wasm has no FMA instruction. With musl's exact software `fma()`, `log` took 160 ns against musl's own `log` at 6 ns, and DVD creation got 20% slower (a DVD hunk calls `log` about 670 times). Now `log` computes the fused results from plain operations: two exactly, the rest unfused where a proven bound shows that can't change the result, and emulated otherwise (about 1 call in 2,500; `engine/libm/README.md`). It takes 11–13 ns, and creating CHDs is within 1% of the time with musl's functions.
  - Still different: chdman on non-FMA x86, Apple's libm and MSVC's CRT round differently, and ARM64 builds sum the autocorrelation with NEON.
- **2.8 parallel decompression (done).** In the page, helper workers decompress the hunks `verify`, the extract commands, and (since 2.0.0) `copy` and `-op` parent walks are about to read, a window at a time (`wasm_read_ahead`). The windows' stored data is read in one go, since each small read costs far more in the browser than its bytes do.
  - Benchmark CD (332 MB), extracting with 4 threads: 2.5× faster (7.2 s → 2.8 s).
  - Benchmark DVD (1 GB): 1.4× faster (13.4 s → 9.3 s). Its 4 KB hunks leave most of the time to the job worker, which reads, checks and writes 1 GB.
  - With 1 thread: 5–12% faster, from the larger reads.
  - Identification of a CHD only reads a few sectors, so it doesn't need it.
- **2.1 hashing.** SHA-1 is unrolled and reads whole big-endian words (plus a WASM SIMD128 helper since 2.0.0); CRC-16 is slice-by-8. Both give the same results, about 5× faster in wasm: SHA-1 went from 120 to 650 MB/s and CRC-16 from 300 to 1,450 MB/s (natively 200 → 650 and 270 → 2,000), measured when it was built (commit `31902a4`). The research's figure for MAME's SHA-1, about 80 MB/s in wasm (150 natively), is a separate measurement of the same code: lane G's harness in Node, wall clock (G §9), and lane B's natively. So the whole-image SHA-1 no longer limits the job worker, and Web Crypto isn't needed.
- In the page, 2.1 makes the benchmark CD and DVD convert 5–10% faster. Together with milestone 1's coroutines and 2.4, conversions are about 25% faster than in 1.2.1.
- **2.4 early abort.** Each hunk tries the previous hunk's winner first, and every other codec stops once it can't beat the best result. The output is byte-identical: 294 fixture, stress-image and codec-list combinations match unmodified 0.289, and `tests/ui/engine.spec.js` keeps checking it.
- Measured CPU savings: 1.06× on CD data, 1.47× on CD audio, 1.10× on DVD. That is below the estimate, because deflate and single-frame FLAC can't stop partway through a hunk.
- In the page, the benchmark CD and DVD convert 5–8% faster with 1 or 4 threads.
- **2.2, done:** FLAC skips its MD5 in memory, generic `flac` never encodes a hunk a third time, `ecc_verify`/`ecc_generate` compute P and Q eight vectors at a time in 64-bit words (3.4× faster natively, plus WASM SIMD128 since 2.0.0), and since 2.0.0 CD codecs share per-hunk ECC/deinterleave + subcode preparation via `cd_prep_cache` (`engine/README.md`). Only native in-flight dedupe remains open.
- **Build fix found on the way:** `wasm/Makefile` now tracks header dependencies. A stale object had disagreed with a changed class layout.

The table says what was built and what it measured. CPU figures are native, `-np 4`, over all threads (measurements §2); "in the page" means the benchmark CD and DVD, wall clock. Estimates are the lab's, from per-hunk times on one core (measurements §1–3, G §11–12), and are marked as such.

| # | Change, as built | Tier | Measured gain (estimates marked) |
|---|---|---|---|
| 2.1 | Faster SHA-1 (unrolled, whole big-endian words + SIMD128 helper) and slice-by-8 CRC-16. Done. Web Crypto per hunk, an early idea, wasn't needed | R | SHA-1 120 → 650 MB/s and CRC-16 300 → 1,450 MB/s in wasm, which removes the serial job-worker ceiling; 5–10% faster in the page. Estimated: −3–6% helper CPU |
| 2.2 | FLAC MD5 off; generic `flac` keeps its big-endian encoding; word-parallel/SIMD128 ECC; shared per-hunk CD prep (`cd_prep_cache`, 2.0.0). Native in-flight dedupe still open | R | ECC 3.4× faster: `createcd` of the benchmark CD takes 2% less CPU, `extractcd` 12% less. The FLAC changes came with 2.4 and are in its figures (estimated before: −5–10% FLAC CPU, −20–33% generic FLAC) |
| 2.3 | **Deterministic libm for libFLAC**: `engine/libm`'s `cosf` and `log` in every build (the autocorrelation was already the C one). Done | R | The page's CD audio = chdman 0.289 on Linux (x86-64 with FMA), byte for byte: the prerequisite for the "byte-identical" claim. chdman's ARM64 builds (NEON autocorrelation), non-FMA x86, Apple's libm and MSVC's CRT still differ. Costs under 1% of creation time |
| 2.4 | **Early abort**: the previous hunk's winner first; later codecs capped at the best result; a small LZMA SDK patch checks the output size during the block. Done | R | 1.06× less CPU (CD data), 1.47× (CD audio), 1.10× (DVD); 5–8% faster in the page. Estimated: 1.21×, 1.65×, 1.24× |
| 2.5 | **Codec plan per track type** (`--codecplan`, opt-in): CD audio `cdfl`, CD data `cdlz` with adaptive `cdzl` fallback (>75% hunk), DVD/raw skips `flac` unless 64-sample stereo PCM probe hits. Done (adaptive fallback & PCM probe added in 2.0.0–2.0.1) | C | Against the default after 2.4: 1.81× less CPU on CD data (+0.22%), 1.91× on CD audio (±0), 2.00× on a mixed CD (+0.11%), 1.38× on DVD (+0.06%); 1.31–1.73× faster in the page; v2.0.1 4T DVD `plan` −9.6% vs v1.9.0 ([measurements.md](measurements.md) §8) |
| 2.6 | libdeflate level 9 (or level 12 with `--ultra`) for `zlib`, `cdzl`, `cdlz` subcode, and `cdfl` subcode (`--libdeflate`, opt-in). Done | C | Per hunk 2.0× (DVD) and 2.8× (CD) faster than zlib-9, and 0.4–0.5% smaller (the plan expected equal size); a whole job takes 1.1–1.8× less CPU, depending on the codec list |
| 2.7 | "Smaller still" preset (`--ultra --libdeflate`): LZMA level 9 `fb=273`/`mc=1000`, libdeflate-12, FLAC `-e -p` + custom apodization (max LPC order 12). Done in 2.0.0 | C | Lab (with FLAC `-p`): −0.47% (CD) and −0.84% (DVD) at about 2.5× CPU; up to −5% on very compressible data (G) |
| 2.8 | Parallel decompression (`wasm_read_ahead`) in the page for extract, verify, `copy`, and `-op` parent walks. Done; identification doesn't need it | R (read only) | With 4 threads the benchmark CD extracts 2.5× faster and the benchmark DVD 1.4×; 5–12% with 1 thread. Estimated: 4–8×; the job worker, which reads, checks and writes everything, sets the pace |
| 2.9 | Per-system hunk-size policy (for example PS2 DVD at 16 KiB). Not automatic: PSP gets 2,048 bytes and MiSTer CDs get 9,792 bytes, and other hunk sizes remain user-chosen | X | Lab: −9% (16 KiB) to −16% (64 KiB) on DVD; costs random-read latency; MAME needs 2048 |

Presets, as the plan named them and as the app has them:
- **Compatible** (default) = 2.1–2.4 + 2.8: tier R. The app calls it "Smallest (default)": chdman's own default settings and bytes.
- **Fast** = plus 2.5 and 2.6: tier C. In the app, "Nearly as small, faster" (2.5 and 2.6) and "Faster to create" (the codec list `cdzl,cdfl` on CD or `zlib` on DVD, with 2.6). They are for phones: G measured Snapdragon parts throttling to 30–58% and iPhones exposing 2 performance cores.
- **Smaller still** (shipped in 2.0.0) = plus 2.7 (`--ultra --libdeflate`): tier C.
- Anything in tier X is an explicit expert choice with reader warnings: "Faster to load (Zstd)" and "For MiSTer FPGA" (both using `--zstd-level 19`), a chosen hunk size, or milestone 7's layout repairs. Settings → Target Environment (`TARGETS` in `app/ui.js`) bundles these choices into six profiles: `Universal`, `Fast Universal`, `ES-DE / PC`, `Handheld`, `MiSTer FPGA`, and `Legacy`.

### Milestone 3: fidelity and verification (2–3 weeks)

**Status: done** (completed in 2.0.0 with single-pass `verify --redump` and milestone 7 session handling). `extractcd --redump` (the page's default for CDs) writes Redump's layout. Real Redump cue sheets, 500 per system with synthetic bins, come back byte for byte through createcd and `extractcd --redump`: PS2 99.8%, PS1 98.4%, Naomi 100%, Dreamcast 94% (the rest are multi-session MIL-CDs), CDTV 92%, 53% of all 5,676. With the cue sheet kept (`createcd --keepcue`, opt-in, below), all 5,676 do, on all 19 systems. **Verify** compares a CHD directly with Redump via single-pass `verify --redump` (`chdman.cpp`, with `CrcStore` extraction only as fallback) and checks the built-in database as well as any loaded user DATs for every track.

1. **Redump-exact extraction.** **Done:** `createcd --keepcue` stores the original cue text as it is, as non-checksummed metadata (`CUES`) after the CD tags; `extractcd --redump` writes it back with the names of the files it writes, when those are laid out as the sheet's (one `BINARY` file per track). Tier C, so opt-in (a page setting, off by default). chdman 0.289 reads, verifies and extracts such CHDs as usual (`tests/ui/engine.spec.js`).
   - Store CATALOG, ISRC, FLAGS, INDEX ≥ 2, the original track-type string and the original cue text as **non-checksummed metadata**, appended after the CD tags. The CHD SHA-1 is unchanged and most readers ignore them (C §2, §7). Kronos, Yabause and jgenesis refuse them (§3, Identity), so Saturn, Sega CD and PC Engine CD jobs leave `--keepcue` out.
   - Extract with CRLF line endings and Redump naming.
   - This lifts cue reproducibility from 77% of 72,022 Redump cues to about 100%.
2. **Verify inside the CHD.** **Done in 2.0.0:** `verify --redump` (`chdman.cpp`) hashes each track or ISO straight from the CHD in a single pass during `verify` (audio swapped back to little-endian, stored pregaps included, no extraction step), emitting `Redump: <size> <crc> <name>` lines matched against the built-in database and any loaded user DATs (milestone 5, step 4). `db/mkdb.py` and the embedded `DPDB v2` schema also support optional multi-track `discDigest` (populated via `--redump-xml`; committed `db/db.json.gz` from libretro-database currently carries 1 ROM per game with 0 populated multi-track digests).
3. **Fix the cue/TOC/NRG parser bugs** (C §12), each with a synthetic fixture. **Status:** B3 (no tracks, or tracks without data), B4 (100 tracks), B5 (MOTOROLA, audio and data), B6 (a shared file after another file, or before one) and B7 (several tracks in one `.wav`) are fixed, with fixtures that have plain twins; 5,676 real Redump cue sheets still give upstream's CHDs. So is B18 (CHDs of a few hunks that can't be read). Malformed input is an error instead of a crash, a hang or silent damage: track lines before the first `TRACK` in a cue or TOC, a missing GDI track file, NRG images that crashed or hung 0.289, an output that is also a track file, and `extractcd` of a damaged CHD (`tests/ui/engine.spec.js`). B8 (EAC gaps at the end of the previous file: the track is read in two pieces), B9 (NRG tracks start at their INDEX 00 and keep their pregap), B10 (`parse_iso` also checks the sync pattern) and B11 (cdrdao TOCs read as cdrdao reads them: START, PREGAP, ZERO, SILENCE, several files per track, no length) are fixed too, each giving the CHD of the same disc as a cue sheet that 0.289 reads right; so is B16 (`extractdvd` of a CD is an error). These change the CHDs of inputs 0.289 read wrong, among them the `ps1-nrg` and `ps1-toc` fixtures, whose audio pregap is now stored as in `mgs disc1.cue`. TOCs also read `.wav` files as WAVE and pad a last partial sector with zeros, as cdrdao does. B12 is fixed: `extractcd`'s `.toc` no longer writes `ZERO` before a pregap the CHD holds, so every CD fixture reads back from its TOC as the same CHD, byte for byte; this changes the `.toc` output of CHDs with a stored pregap by that one line. B13 is fixed too: `cdrom_file`'s logical reads, which no chdman command uses but the page's identification does, read each pregap from its own track and a gap the CHD doesn't hold as zeros, and every chdman output stays the same. B19: every GD-ROM output reads back (`.gdi` and `.cue` as the same CHD, `--redump` as Redump's files), and `.toc`, which can't describe a GD-ROM, is refused. B20 and B21: cue sheets with INDEX points out of order or tracks without data, and TOC statements past their files, huge numbers, samples in sub-channel tracks and ZERO in another mode are errors; a `.wav`'s `#offset` is where its header is, as in cdrdao. B15 is MAME's DVD reader, not chdman, and B14 doesn't apply to 0.289.
   - MOTOROLA audio double-swapped;
   - shared-file offsets;
   - multi-track WAVE files;
   - EAC-style gaps;
   - the NRG pregap offset;
   - `parse_iso` mis-typing;
   - cdrdao TOC semantics;
   - 0-track hang and 100-track crash.
4. **Session geometry.** **Done in 2.0.0** via milestone 7 steps 2, 4 and 5: opt-in `createcd --sessions` writes `CHSE` for Jaguar CD, PC Enhanced CD session gaps can be padded as silent frames, and `createcd --trailer` records repairs in an unlinked `DPRC0001` EOF trailer reversed by `extractcd --redump`.

### Milestone 4: more inputs (ongoing, by demand)

**Status: done for CD/DVD/archive/audio inputs (completed in 2.0.0).** CloneCD (with opt-in `.sub` `RW_RAW` subchannel ingest), CSO/ZSO, ECM, PS1 `EBOOT.PBP`, `.zip`, `.7z`, `.mds`/`.mdf` (including `.mdf` LibCrypt `.sbi` extraction), DiscJuggler `.cdi`, compressed/uncompressed audio cues (FLAC, WAV, RF64, AIFF, OGG via `wasm/stb_vorbis.c`, MP3 via `wasm/minimp3_ex.h`), and CD+G cue tracks (`TRACK nn CDG` → `AUDIO RW_RAW`) are all supported. Only `.isz`, `.mdx`, and `.rar` remain refused with a clear card.
- CloneCD: the page turns a `.ccd` into a cue sheet for its `.img` (`ccdToCue`). By default `.sub` generates an `.sbi` sidecar for PAL PS1 LibCrypt and is otherwise left out; since 2.0.0, opt-in `.sub` `RW_RAW` subchannel ingest (Tier X) is also supported with per-emulator warnings. Multi-session, scrambled and track-list-less (CloneCD 2) files are refused with the reason.
- CSO v1 and v2 and ZSO (maxcso's formats, for PSP and PS2): the job worker hands chdman the ISO inside, decompressing blocks as they are read (`CisoStore`, using `wasm_lz4_block` for ZSO), so the CHD is the one chdman makes from that ISO. Identification reads the ISO the same way, and its checksum is the ISO's. A damaged block stops the job with its number.
- Found on the way: 0.289's `createraw`/`createhd`/`createdvd` ignore input read errors and write a CHD they can't open. The engine now stops with an error (`tests/ui/engine.spec.js`).
- ECM (`.bin.ecm`, the ecm tools' format; common in PS1 collections, and emulators don't read it): an ECM image stands for the file it packs, the track a cue sheet, GDI or CloneCD `.ccd` names, or a lone `.bin`. The job worker rebuilds the image as chdman reads it (`EcmStore`, `wasm/ecm.cpp`), so the CHD is the one chdman makes from the unpacked image. It rebuilds ECC with the engine's `ecc_generate`, which works a word at a time since 2.2. The image's EDC, at the end of the file, is checked when the image is read in order, so a damaged file stops the job instead of making a CHD of the wrong data. Identification reads the image through a worker, and the checksum that confirms the release is the image's. The fixture encoder writes the same bytes as the ecm tools' `bin2ecm` (checked with a local build of it, not part of the repository).

Priority order (C §9):
1. CloneCD `.ccd/.img/.sub`, including `.sbi` extraction and opt-in `RW_RAW` subchannel ingest (done; opt-in `RW_RAW` added in 2.0.0);
2. DiscJuggler `.cdi` for Dreamcast homebrew and MIL-CD (done in 2.0.0 via `wasm/cdi.cpp`);
3. ECM (done);
4. FLAC, WAV, RF64, AIFF, OGG and MP3 audio referenced from cues, plus CD+G cue rewrite (done in 2.0.0);
5. CSO/ZSO → DVD (done; CSO/ZSO writer also shipped in 2.0.0);
6. MDS/MDF, including `.mdf` LibCrypt `.sbi` extraction (done in 2.0.0);
7. `.7z` archives (done in 2.0.0 via LZMA SDK 23.01 7z/LZMA/LZMA2/BCJ/BCJ2/Delta/PPMd7 decoder) and fuller NRG support.

**Subchannel ingest** writes `SUBTYPE:RW_RAW`, i.e. tier X, because Beetle cores and Flycast ≤ 2.7 refuse such discs. Offer it per system (PS1 LibCrypt, CD+G), with warnings. Keep recommending `.sbi` sidecars for PS1 by default.

**GameCube and Wii** have no CHD reader anywhere; their format is RVZ (D2 §12). It is out of scope for this fork.

### Milestone 5: what users ask for (research of 2026-09-30)

A survey of MAME's trackers, emulator and tool trackers and forums (the report "chdman: what users report and ask for") found the biggest unmet needs: checking CHDs against Redump or No-Intro DATs without extracting them, zipped inputs, and LibCrypt data for PAL PS1 games. None of the steps below changes the CHDs Discpress writes by default: they are tier R, or tier C or X only when a preset is chosen.

**Status: steps 1 to 5 done** (Discpress 1.5.0; tests in `tests/ui/profiles.spec.js`, `zip.spec.js`, `dat.spec.js` and `pbp.spec.js`, and the `ps1-libcrypt` and `ps1-pbp*` fixtures). A PBP's audio tracks are read from its image, where popstation puts them; a disc whose track list doesn't fit its image is refused.

1. **Compatibility notes and clearer refusals** (small).
   - PS2 discs on CD with audio tracks: PCSX2 plays only the first track of a CD CHD (its `ChdFileReader`, draft PR #12037).
   - Dreamcast CD-based discs (CD-R, MIL-CD) whose cue has pregaps: every Flycast release up to 2.7 rejects such CHDs ("Unsupported subtype or pre/postgap", flycast #906; fixed on master only).
   - PS1 and Zstd: SwanStation builds from before the end of March 2026 can't read Zstd CHDs. RetroArch #18867 reported it on 2026-03-27 (RetroArch 1.22.2 and a nightly) and was closed the next day, when libretro/swanstation#159 was merged: its commit "Update libchdr." of 2026-03-12 "introduces support for Zstandard compression". (Read on GitHub on 2026-11-11. D1 §2.2 dates that commit 2024-03-12, unverified: the year is wrong, and SwanStation's `dep/libchdr` has no commit of March 2024. The app's note and the README took "before about March 2024" from it until 1.8.1; since 1.8.2 they say "before April 2026".)
   - Formats Discpress can't read (`.cdi`, `.mds`/`.mdf`, `.isz`, `.7z`, `.rar` in 1.5.0; `.cdi`, `.mds`/`.mdf`, and `.7z` subsequently shipped in 2.0.0, leaving `.isz`, `.mdx`, and `.rar`) get a card that says so and what to do, instead of being ignored.
   - A "For MiSTer FPGA" preset for CDs: Zstd (`--zstd-level 19`) and FLAC with 4-sector hunks (`-c cdzs,cdfl -hs 9792`), what MiSTer needs for 8× CD speed (mkchd). Tier X (Zstd, and a hunk size of its own): chosen, never automatic.
2. **`.sbi` from a CloneCD `.sub`** (small). A PS1 disc's LibCrypt sectors carry Q subchannel with a deliberately wrong CRC. The page reads the `.sub`'s Q channel, lists the sectors whose CRC fails, and saves them as an `.sbi` next to the CHD, as for an `.sbi` the user adds. Too many bad sectors means a damaged `.sub`, not LibCrypt: no `.sbi` then, and the card says why.
3. **`.zip` input** (medium). The page reads a zip's central directory (zip64 too). Stored entries are read in place, as slices of the zip. Deflated ones are unpacked first, into private storage where there is some, else into memory up to a limit, and their CRC-32 must match the zip's. The entries then join the list like picked files, so cue sheets find their tracks inside the zip. Other compression methods and encrypted entries are refused by name.
4. **DAT verification** (medium). Users add Logiqx DAT files (Redump, No-Intro), plain or zipped; the page keeps them across visits (private storage, else for the visit). Every track of a disc is matched by size and CRC-32: before converting, from the input files (the checksums identification already computes are reused), and for a CHD after Verify, from the checksums of `extractcd --redump`'s files. The card says which DAT entry it matches and whether every track does; results can be named after it. Settings lists the loaded DATs.
5. **PS1 `.pbp` input** (medium). Unencrypted PS1 `EBOOT.PBP` files (popstation's format: `PSISOIMG0000` for one disc, `PSTITLEIMG` for up to five) hold the disc's raw sectors in deflated 16-sector blocks with an index, so they read like a CSO: a worker store (`PbpStore`) serves the image, and the disc's TOC gives the cue sheet. Encrypted PBPs (PSN downloads), and ones whose audio tracks aren't in the image, are refused with the reason.

Deferred in 1.5.0 (subsequently shipped in 2.0.0, except `.rar`):
- **DiscJuggler `.cdi` conversion and multi-session discs.** Deferred in 1.5.0; shipped in 2.0.0 (`wasm/cdi.cpp`).
- **`.7z` and `.rar`.** `.7z` shipped in 2.0.0 via LZMA SDK 23.01; `.rar` (plus `.isz` and `.mdx`) remains refused.
- **MDF/MDS.** Deferred in 1.5.0; shipped in 2.0.0 (including `.mdf` LibCrypt subchannel extraction).

### Milestone 6: detection that knows the game (research of 2026-10-02)

Identification picked settings per console and from the cue sheet's text, never per game, and named some discs wrongly. The audit (code, `docs/chd/`, and the emulators' own sources and trackers) found:
- **Wrong or missing names.** Sega's US first-party discs say MK-51064 where Redump lists 51064 (91 Dreamcast, 120 Saturn and 126 Sega CD rows), so the US disc got the European name, and Sega CD discs none. Sega headers' disc numbers weren't read: 146 Saturn and 81 Dreamcast serials are shared by the discs of a set, so Disc 2 was named Disc 1 and playlists broke. An exact serial won even when its size disagreed, and regions were ignored.
- **CHDs that won't load.** "Keep the cue sheet" writes a tag Kronos, Yabause and jgenesis reject (Saturn, Sega CD); renaming NAOMI discs breaks MAME's and Flycast's romset lookup; Zstd warnings were missing for PS2, Dreamcast, NAOMI and PC-FX.
- **Discs 0.289 mishandles without a word**: multi-session discs, CD+G tracks, cooked PS1 ISOs, cue layouts specific emulators misread.
- **Detection gaps**: Jaguar CD and PC-98 never detected, PC Engine discs with an ISO 9660 volume taken for PC discs, CD32 and CDTV checked in the wrong order, video discs not recognized.

None of the steps changes the CHDs Discpress writes by default. The only automatic changes allowed are dropping an opt-in flag that makes a CHD unbootable (which gives the default output), choosing the CHD type, and refusing inputs 0.289 mishandles; everything else is a note or a warning. Each step is one pull request.

**Status: done** (Discpress 1.7.0 for steps 1 to 5; Saturn expansion cartridges and PC-98 + Phase 2 detectors completed in 2.0.0) (tests: the `dc-firstparty`, `saturn-firstparty`, `segacd-firstparty`, `saturn-disc1`, `saturn-disc2`, `dc-disc2`, `ps1-size-rank` and `saturn-other-region` fixtures for step 1; `quirks.spec.js`; the `segacd-layout`, `saturn-pregap-cmd`, `dc-mode2-2048`, `dc-multisession`, `ps1-postgap` and `ngcd-mode2` fixtures, whose manifest entries list the rules their cards show, for step 3; `pcecd-iso`, `pcfx-iso`, `cd32-cdtvid`, `cd32-startup`, `cdtv-tm`, `ngcd-abs`, `cdi-bridge`, `vcd`, `dvd-video`, `umd-video`, `ps2-dvd-small`, `ps2-cd-iso` and `jagcd` for step 4).

1. **Correct names.** A serial's key drops Sega's `MK` (`canonKey`); base keys also cover Sega's two-part suffixes (4432-50) and Sony serials with letters after the number (SLUS-01272GH). A disc is also looked up without the version suffix it carries (T-93175-00) and, for PlayStation discs, under its boot file's name (`serialCandidates`). The Saturn's and Dreamcast's IP.BIN give the disc of a set (CD-2/3, GD-ROM2/2) and the area symbols, the Sega CD's system area its region. Releases are ranked: the disc's number in its set first, then a matching size, then how the serial matched (exact, trimmed, base), then whether the release's region fits the disc's; a release found only under a base serial for another region names nothing. Lettered sets (Disc A, Disc B) get playlists too.
2. **A rule table** (`app/quirks.js`) for per-console and per-disc rules, each with a stable id: Saturn, Sega CD and PC Engine CD jobs leave out `--keepcue` and say why (its `CUES` tag is fatal to Kronos, Yabause and jgenesis, which fail on any metadata tag but a track's: [ecosystem-other.md](ecosystem-other.md) §0), NAOMI results keep their romset names, the Zstd warnings cover PS2 (AetherSX2), Dreamcast and NAOMI (Flycast before 2.3) and PC-FX (Beetle PC-FX before 2026-08), and apply to the MiSTer preset too, which also warns where MiSTer has no core (Dreamcast, NAOMI, PS2, PC-FX, Jaguar CD, PC-98). The PCSX2 and Flycast notes of milestone 5 moved into the table.
3. **Disc-layout rules**, from the emulators' readers ([ecosystem-other.md](ecosystem-other.md), [ecosystem-sony-dreamcast.md](ecosystem-sony-dreamcast.md)):
   - CD+G tracks: refused in 1.7.0–1.9.0 because chdman 0.289 rejects `TRACK nn CDG`; since 2.0.0, `fixDescriptor()` rewrites `TRACK nn CDG` → `AUDIO RW_RAW` (preserving CD+G subcode in the CHD, with Beetle/Flycast subcode warnings).
   - Multi-session discs warn: a CHD keeps no session gap, so the second session is read about 11,400 sectors early; only Flycast master guesses it, for MIL-CDs. Every Jaguar CD warns that BigPEmu takes no CHDs and Virtual Jaguar needs session data (repaired opt-in since 2.0.0 via milestone 7).
   - Dreamcast and NAOMI MODE2/2048, /2324 and `MODE2_FORM_MIX` tracks warn: they become Mode 2 Form 1, Form 2 or mixed form, which Flycast refuses.
   - A 2,048-byte PS1 ISO warns: its XA sectors are lost, and Beetle PSX takes only raw Mode 2.
   - Sega CD: a data track after track 1 stops Genesis Plus GX's track list; 80 minutes or more is too long for PicoDrive; stored pregaps may start libretro BlastEm's audio late.
   - `PREGAP` and `POSTGAP` lines: Beetle Saturn, Kronos and Yabause misplace what follows either, the Beetle PCE family, Beetle PC-FX, Beetle PSX and jgenesis what follows a postgap, and ares, jgenesis and PCSX ReARMed misplace tracks after virtual `PREGAP` lines.
   - NeoCD refuses Mode 2 tracks and misreads PREGAP lines from track 3 on.
   - More than two notes go into one group; warnings stay in view.
4. **Detection gaps** (some markers follow [MPF](https://github.com/SabreTools/MPF), MIT, rewritten):
   - PC Engine and PC-FX boot sectors are looked for before an ISO 9660 volume, which some of these discs have too (they were taken for PC discs).
   - CD32 and CDTV: CDTV.TM, then CD32.TM or a CD32 system id, then a CDTV system id; an Amiga startup sequence alone is a CD32 disc (MPF).
   - Neo Geo CD from two of ABS.TXT, BIB.TXT and CPY.TXT without IPL.TXT (MPF).
   - Jaguar CD: a disc of audio tracks whose last session's first track holds "ATARI APPROVED DATA HEADER ATRI", in either byte order.
   - CD-i Bridge discs (CD-RTOS CD-BRIDGE and a CDI folder) are CD-i; Video CDs (VCD, MPEGAV), DVD-Video, DVD-Audio, HD DVD, Blu-ray and Photo CD are films (MPF), after the Xbox check, since a full Xbox dump starts with a DVD-Video partition. UMD Video (a UMD_VIDEO folder, no PSP_GAME) warns.
   - A PS2 disc without a database entry is a DVD when it has a UDF volume (BEA01, NSR02, NSR03), else when it is over 800 MB.
   - NRG: nothing to do; the engine reads Mode 1, raw Mode 2 and audio tracks, and the identifier already reads both data modes.
5. **Per-game facts** (`db/facts/`, kept by hand with sources, checked by `scripts/assemble.py` against the database and embedded in the page; `tests/ui/facts.spec.js`):
   - `libcrypt.tsv`: 197 PAL PlayStation serials protected by LibCrypt (psxdatacenter's SBI list, all matched in the built-in database). A disc of one without an `.sbi`, `.lsd` or CloneCD `.sub` (or `.mdf` subchannel) warns.
   - DuckStation's `.lsd` files are paired and saved like `.sbi` files; an `.sbi` paired by name with a disc of another console is left out of its results.
   - A disc of a set says how many discs the set has (from the database's names) until all of them are converted.
   - `saturn-cart.tsv` (**shipped in 2.0.0**): 32 hand-curated Sega Saturn games requiring 1 MB RAM, 4 MB RAM, ROM, or MPEG expansion cartridges, verified against primary sources.

Still deferred: naming GameCube, Wii, Xbox, Xbox 360 and PS3 discs in the built-in DB (+530 KB, and their emulators don't take CHDs; optional via user DATs or `--redump-xml`); checksumming CHD tracks while identifying (single-pass `verify --redump` does it in Verify). Items deferred in 1.7.0 that **shipped in 2.0.0**: PC-98 detection (`IPL1` + ISO `/PC-?98/i`/`NEC_CD.SYS`), Phase 2 console/computer detectors (FM Towns, X68000, Pippin, Playdia, NUON, Konami System 573, Namco System 246, Triforce, Chihiro, Xbox 360), and opt-in `CHSE` session metadata (`createcd --sessions`, milestone 7 step 2).

### Milestone 7: layouts each emulator reads right (decision of 2026-10-03)

**Decision: no new conversion engine.** The question was whether replacing chdman with a CHD writer of our own would make discs work better in their emulators. The assessment (code, these documents, and experiments with unmodified chdman 0.289 on the synthetic test discs) found:
- **Size:** at most about 1% smaller files within the codecs every reader decodes: −0.5% on CD and −0.8% on DVD with better encoders (measurements §3), −1.4% on DVD with zopfli at 30–60 times the CPU time. The fork can take those encoders. Larger hunks (−9% to −16% on DVD) are already a setting.
- **Speed:** nothing left to gain. On the benchmark CD the engine already takes 1.2× less CPU than 0.289 with the default (the same file), 2.1× less with the codec plan and 3.2× less with `cdzl,cdfl` and libdeflate (native, `-np 4`; measurements §2, measured again on 2026-11-11). This paragraph first said 1.6×, 2.8× and 4×, of which no record was kept, not even whether it was CPU or wall-clock time. LZMA's time is in its match finder, which doesn't vectorize.
- **Compatibility:** nothing that rewriting the cue sheet in front of the fork can't do. Unmodified chdman 0.289 produced every layout below from a rewritten cue sheet: a PREGAP line stored as data (`PGTYPE:VAUDIO`), a session gap stored as frames, a MODE2/2048 track relabelled MODE1 (same data SHA-1), a pregap absorbed into the previous track.
- **Cost:** about 8 to 12 person-weeks to get back to today's output. It would also lose the byte-for-byte oracle and the "chdman 0.289" trust.

What keeps discs from working is mostly the readers (§3, [ecosystem-other.md](ecosystem-other.md) §15.4, [ecosystem-sony-dreamcast.md](ecosystem-sony-dreamcast.md) §5.1), not chdman's encoder, and some limits are the format's own (session geometry; PCSX2 reading track 1 only). So this milestone keeps the fork and lets particular consoles' CHDs move away from 0.289's layout, where it is broken for their emulators.

Every rule of this milestone:
- applies only to the consoles it names;
- is labelled tier X on the card;
- is tested against models of the readers it targets (§5);
- is undone when extracting (step 5).

The CHD's SHA-1 then differs from chdman's for the same input, which MAME's software lists and DAT tools see. The data the disc holds is unchanged. No emulator was run for this assessment: what a reader does comes from its code, as these documents describe it, and each step below checks it on the emulator before it ships where it can.

**Status: shipped in Discpress 2.0.0 (all 5 layout-repair steps + 12-check browser CHD Health Auditor).** Opt-in repairs (`REPAIR_INFO.{gaps,sessions,mode2,dcgaps,pcsession}` in `app/ui.js`) are enabled per card or automatically by the `ES-DE / PC`, `Handheld`, `MiSTer`, and `Legacy` Target Environment profiles, leaving `Universal` (default) Tier R byte-identical to chdman 0.289. Engine support (`createcd --sessions`, `createcd --trailer`, `extractcd --redump` trailer reversal, `copy --stripmeta`) is documented in [`engine/README.md`](../../engine/README.md).

1. **PREGAP and POSTGAP lines stored as real silent frames** (`REPAIR_INFO.gaps`, **done in 2.0.0**) for Saturn, Sega CD, PC Engine CD, PC-FX, Neo Geo CD and PS1.
   - The page rewrites such a cue sheet before chdman reads it: a PREGAP line becomes zero frames in the track, with INDEX 00 and 01; a POSTGAP line becomes zero frames at the track's end, backed by `ZeroStore` in the worker filesystem.
   - Beetle Saturn, Kronos, Yabause, Ymir, jgenesis and NeoCD, which take every pregap as stored, then place the following tracks correctly, and ares keeps them.
   - The Beetle PCE, PC-FX and PSX cores and Geargrafx count a postgap into the file offset. Storing it should fix them too, though that remains unchecked directly in those cores.
   - Redump-style cue sheets (INDEX 00, no PREGAP or POSTGAP lines) are unchanged, and so is their CHD.
   - The `saturn-gapcmd`, `postgap`, `ares-pregap` and `ngcd-layout` warnings become opt-in repairs.
2. **The Jaguar CD session tag** (`REPAIR_INFO.sessions` + `createcd --sessions`, **done in 2.0.0**), only for Jaguar CD.
   - Engine work: `createcd --sessions` writes checksummed `CHSE` metadata (`cdrom.cpp`) where MAME expects it; the page passes it only for Jaguar CD (never for Saturn, Sega CD or PC Engine CD, where Kronos, Yabause and jgenesis reject unknown tags).
   - Virtual Jaguar requires `CHSE` to load Jaguar CD CHDs; BigPEmu still takes no CHDs.
3. **An opt-in mode for Flycast 2.7 and earlier** (`REPAIR_INFO.mode2` & `REPAIR_INFO.dcgaps`, **done in 2.0.0**).
   - MODE2/2048 tracks are written as MODE1 (same data SHA-1), and a MIL-CD's pregaps are absorbed into the previous track (`PREGAP:0`). Never enabled by default because it changes track layout (and Flycast master/2.8 reads chdman's layout).
4. **Session gaps stored as silent frames for PC Enhanced CDs** (`REPAIR_INFO.pcsession`, **done in 2.0.0**; 161 Redump discs).
   - The gap of 11,400 frames becomes zero frames (`ZeroStore`) at the end of the first session's last track so single-session readers (DOSBox-X, 86Box, MAME) locate session 2 at its expected LBA.
5. **A lossless record of each change inside the CHD** (`createcd --trailer`, **done in 2.0.0**).
   - Instead of adding a CHD metadata tag (which Kronos, Yabause and jgenesis would reject on Saturn, Sega CD and PC Engine CD), `createcd --trailer` appends an unlinked `DPRC0001` EOF trailer outside CHD's metadata chain — invisible to all CHD readers and leaving both SHA-1s unchanged.
   - `extractcd --redump` reads the trailer and reverses the repairs byte for byte so original Redump files, Verify's Redump comparison, and DAT checks keep working. `copy --stripmeta` also strips non-checksummed metadata tags such as `CUES`.

Also shipped in 2.0.0: the 12-check browser **CHD Health Auditor** (`auditChd`, checking CHD header/metadata/track layout issues, LibCrypt sidecars, strict-metadata tags, and Flycast/Saturn/Sega CD quirks). Automated external C/Rust reader CI oracles (libchdr, rchd, chd-rs) and CLI `verify --layout` (§5) remain open.

Other format writers: **CSO v1/v2 & ZSO** (`--block=2048`, deflate via `engine/libdeflate` and LZ4 via `wasm/lz4_block.c`, for real PSP and PS2 hardware) and **scrubbed Xbox XISO** (`.xiso.iso` for xemu) **shipped in 2.0.0**. **PBP writer** (for PS1 on PSP/Vita) and **RVZ** (for Dolphin, which converts to RVZ itself) remain unbuilt.

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
  - music to catch FLAC nondeterminism: in the tests the `music-cd` fixture (synthetic piano), in the lab the CC0 recordings.
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
