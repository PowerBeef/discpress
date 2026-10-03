# CHD and chdman: research dossier for the Discpress fork

This is research done on 2026-09-27 to prepare a hard fork of MAME's `chdman` for Discpress. It covers:

- the CHD format and its codecs;
- chdman's internals;
- how CD, GD-ROM and DVD discs are modelled;
- how some 60 emulators, frontends and tools read CHDs;
- chdman's history and community;
- encoder technology;
- first-hand measurements.

**How it was produced.** Seven research lanes worked in parallel from primary sources: MAME's git history, plus the source of each emulator and library at a recorded commit. Each lane ran its own experiments. A codec lab (in [lab/](lab/)) produced the measurements.

**How to read it.** Start with this page and [fork-plan.md](fork-plan.md). The lane reports are the reference material behind them.

| Document | What it covers |
|---|---|
| [fork-plan.md](fork-plan.md) | **The synthesis:** the compatibility contract, output tiers, and a milestone roadmap with measured gains and each milestone's status (milestones 0, 5 and 6 done, 1 to 4 mostly, 7 planned) |
| [measurements.md](measurements.md) | Per-codec economics, codec-selection policies, encoder variants, hunk sizes, the 0.289 drift, native vs wasm |
| [format.md](format.md) (lane A) | Byte-level spec of CHD V1–V5 (headers, maps, metadata, hashes), every codec, and what decoders let an encoder change (tested with MAME, five libchdr versions and chd-rs) |
| [chdman-internals.md](chdman-internals.md) (lane B) | Every command and option, the compression pipeline and threading, performance, defects, the Discpress wasm patch, licensing of every file |
| [optical-media.md](optical-media.md) (lane C) | The CD/GD/DVD data model, cue/gdi/toc/nrg parsing, sessions, CD+G, round-trips against 72,022 Redump cues, parser bugs, input formats |
| [ecosystem-sony-dreamcast.md](ecosystem-sony-dreamcast.md) (lane D1) | PS1/PS2/PSP/Dreamcast emulators, RetroArch's scanner, RetroAchievements hashing, MiSTer, frontend conventions |
| [ecosystem-other.md](ecosystem-other.md) (lane D2) | Sega CD, Saturn, NEC, Neo Geo CD, 3DO, Amiga, CD-i, Jaguar, PC and multi-system emulators; the libchdr family tree; who can read zstd |
| [history-community.md](history-community.md) (lane E) | Release-by-release history of chdman and CHD, user pain points, third-party tools, alternative implementations, competing formats |
| [encoders.md](encoders.md) (lane G) | Deflate, LZMA, FLAC and zstd encoders the readers still accept, hashing, WebAssembly and platform features, a ranked option table |
| [lab/](lab/README.md) | The measurement harness, encoder-variant build, corpus builder and scripts |

---

## Problems in the shipped app (1.0–1.2.0)

Found during this research and verified independently of the lane that found them. Discpress 1.2.1 fixes 1–3 and guards against 4 (see [fork-plan.md](fork-plan.md), milestone 0).

### 1. Dreamcast CHDs made by Discpress 1.0–1.2 don't load in any released Flycast, and GDI-sourced ones are mis-mastered

**Cause.** Discpress builds chdman from MAME **master** `76c7d19`, which is not the 0.289 release. Two unreleased commits from July/August 2026 changed the GD-ROM layout:

- #15808 keeps Redump pregaps as `PREGAP:n PGTYPE:V…`;
- #15870 turns `.gdi` gaps into virtual pregaps.

**Consequences:**

- Every Flycast release up to v2.7 (August 2026) throws "Unsupported subtype or pre/postgap" on such CHDs. I checked this against the `v2.7` tag's `core/imgread/chd.cpp:183-184`.
- For `.gdi` input, the high-density area also lands 150 or more sectors late in MAME's own reader and in Flycast master. For example, the repo's `aerowings.gdi` fixture puts track 3 at LBA 45,428 instead of 45,000.
- Round-trip tests pass anyway, which is why nobody noticed.

**Fix.** Lane C validated a fix: restore 0.289's GD handling. The output then matches official 0.289 byte for byte (optical-media.md §5, §13; ecosystem-sony-dreamcast.md §1.5).

**Status: fixed in 1.2.1** by building the `mame0289` tag; `tests/ui/gdrom.spec.js` checks the layout. Dreamcast CHDs made with 1.0–1.2.0 should be converted again from the original files.

### 2. "Byte for byte the same as chdman 0.289" is not true

Three separate causes:

- **The LZMA level changed.** Commit `c23567b509` (2026-08-04, after 0.289) lowered it from 8 to 6. Every CHD with LZMA hunks differs from 0.289 in its file bytes, and the size is within ±0.05%. I rebuilt the actual `mame0289` tag and compared all fixtures; lanes B and C showed that setting the level back to 8 alone restores identity.
- **CD audio isn't deterministic across builds.** libFLAC's window functions use `cosf`/`log`, and Emscripten's libm differs from glibc by one unit in the last place. The app's wasm output therefore differs from its own native build by a few bytes on real music (reproduced here on a Chopin recording). Official ARM64 builds (NEON) differ from x86 for the same kind of reason. The tests missed this because their audio is synthetic sine waves and the oracle was built from the same tree. **Fixed in milestone 2.3:** libFLAC now uses copies of glibc's `cosf` and `log` in every build (`engine/libm`), and the page's CD audio matches chdman on Linux byte for byte. The `music-cd` fixture, 10 s of synthetic piano, would catch a regression.
- **What does hold is the CHD SHA-1**, i.e. content identity (data plus metadata), for everything except GD-ROM. That is what MAME and DAT tools check.

The claim in the README, the help page, CLAUDE.md and the release notes should be reworded until the fork restores identity (fork-plan.md, milestones 0 and 2.3).

**Status in 1.2.1:** the 0.289 tag restores byte identity for data (verified on every fixture against an independent 0.289 build). The FLAC caveat remains, and the wording now says so.

### 3. Other unreleased upstream changes shipped with the pin

- **The `CHSE` session tag.** It is written for multi-session sources, and changes the SHA-1 compared with 0.289. Virtual Jaguar requires it for Jaguar CD. Kronos, Yabause and jgenesis refuse any disc that has it.
- **CD+G cue input.** Every Beetle core and Flycast ≤ 2.7 refuse discs with subcode.

**Status:** gone in 1.2.1; 0.289 has neither.

### 4. Inputs that hang or crash chdman

Any input that yields 0 tracks makes chdman loop forever; this is also in 0.289. Causes include:

- a lone `.bin`;
- a `.ccd`;
- a lowercase or BOM-prefixed cue;
- redumper's binary `.toc`.

A 100-track cue crashes it.

Hostile CHDs are a risk too: a malformed FLAC hunk hangs MAME's decoder, and a self-referencing hunk overflows the stack. Discpress reads user-supplied CHDs for identification, so these apply to the app. See optical-media.md §12 and format.md §11.

**Status in 1.2.1:**
- The Convert tab refuses descriptors with no tracks or out-of-range track numbers, and repairs BOM, encoding, line endings and keyword case.
- It skips binary `.toc` files, and lone `.bin`/raw `.iso` images get a generated cue.
- A watchdog stops any run whose progress reads `nan%`, in the Advanced tab too.
- Hardening against hostile CHDs was left to the fork; the engine fixes 0.289's crashes on bad input (`engine/README.md`), and `.github/workflows/sanitizers.yml` runs its tests under ASan, LSan and UBSan.

---

## Main findings by topic

### The format leaves room for encoders but not for layout (A, G)

**Readers fix only a few things.** They re-derive codec parameters from the hunk size and never read them from the file. The constraints they impose are:

- LZMA lc/lp/pb = 3/0/2;
- raw deflate;
- zstd without dictionaries, one frame per hunk, window ≤ 2²⁷;
- FLAC frames ≤ 2352 samples (CD) with partition order ≤ 8;
- hunks contiguous and in order;
- compressed length ≤ hunk size;
- map fields ≤ 25 bits;
- no codec listed twice.

**Everything else is free:** the encoder implementation, its settings and the hunk size. Three decoder families (MAME, libchdr, chd-rs/rchd) decoded more than 17,000 variant streams correctly.

### chdman wastes most of its encoding time (B, G, measurements)

Every codec compresses every hunk, although chdman knows each track's type:

| Content | Codecs that never won | CPU they took |
|---|---|---|
| CD audio | `cdlz`, `cdzl` | 64% |
| CD data | `cdfl` | 18.5% |
| DVD | `flac` (won 0.4% of hunks) | 36% |

Separately, the generic FLAC codec encodes each hunk two or three times.

**Measured on a freely licensed corpus:**

| Change | Speed | Size |
|---|---|---|
| Codec plan per track type, CD audio | **2.8× faster** | identical |
| Codec plan per track type, CD data | 2.0× faster | +0.22% |
| Codec plan per track type, DVD | 1.55× faster | +0.06% |
| Byte-identical early abort (built, milestone 2.4) | 1.06× (CD data), 1.47× (CD audio), 1.10× (DVD) less CPU | identical |
| Codec plan (built, milestone 2.5, opt-in; on top of early abort) | 1.81× (CD data), 1.91× (CD audio), 1.38× (DVD) less CPU | +0.22%, identical, +0.06% |

There are serial bottlenecks too:

- MAME's SHA-1 runs at about 80 MB/s in wasm (about 150 MB/s native), for the whole-image hash on one thread (the engine's runs at 650 MB/s since milestone 2.1);
- `-np N` gives N−1 workers, capped at 16;
- `-np 1` busy-waits;
- verify and extract are single-threaded (in the page they use several cores since milestone 2.8).

### Compatible ways to shrink files are small, except hunk size (A, G, measurements)

| Change | CD | DVD |
|---|---|---|
| LZMA fb 273 | −0.2% | −0.1% |
| libdeflate-12 | −0.1% | −0.8% |
| FLAC `-p` | −0.2% (2× CPU) | — |
| **Larger hunks** | −2.3% (16 frames) | **−9% (16 KiB), −16% (64 KiB)** |

Larger hunks are the only big lever, and every reader decodes them. But MAME's own DVD reader accepts only 2048-byte hunks, rchd caps hunks at 512 KiB, and random reads cost more. So hunk size is a per-system policy choice, not a free win.

### The reader ecosystem is fragmented and moving (D1, D2)

- **zstd/cdzs.** At least ten current readers can't decode them: Opera, Kronos, Yabause, Beetle SuperGrafx, WinUAE, BlastEm-libretro, AetherSX2/NetherSX2, and RetroArch ≤ 1.21 for scanning and achievements. libchdr and MAME refuse to open a CHD whose header merely **lists** an unknown codec.
- **The meaning of `PGTYPE:V` is disputed:**
  - seven readers assume the pregap is always stored;
  - two read the `V` flag inverted;
  - BizHawk rejects `V` together with `PREGAP:0`.
- **Parent CHDs** load only in DuckStation, Beetle PSX, PCSX2, LRPS2 and MAME.
- **DVD CHDs** fail in every CD-system emulator.
- **Libraries are diverging.** libretro moved RetroArch and several cores to rchd, a clean-room reader with different limits. libchdr gained embedded targets and dozens of fixes in September 2026. Flycast changed its pregap rules.
- **Conclusion.** chdman's default layout is the only one that works everywhere, and compatibility must be tested against several reader families, not just libchdr.

### Fidelity is recoverable without breaking anything (C)

**What round-trips today.** Track data round-trips bit-exactly, including deliberately bad sectors. Only the cue text loses information: chdman can rebuild 77% of 72,022 real Redump cue sheets. The losses are:

- CATALOG, ISRC and FLAGS;
- INDEX 02 and later;
- `CDI/2352`;
- CRLF line endings and single-track naming.

**How to recover it.** Store the missing fields, or the original cue, as **non-checksummed metadata**. The CHD SHA-1 stays the same and every reader ignores the extra tags. That makes byte-exact Redump extraction possible, as well as per-track Redump verification straight from a CHD.

**Other fixes needed:**

- a family of cue/TOC/NRG parser bugs that silently corrupt data: MOTOROLA audio, shared files, multi-track WAVE, EAC gaps, NRG pregaps, `.iso` mis-typing;
- session geometry, which is still lost.

### Platform (G)

- The SIMD build doubles FLAC speed and does nothing for the LZ codecs.
- JSPI is Baseline since 2026-09-14, so Asyncify can go. (It went: the engine's commands are C++20 coroutines, milestone 1.)
- Shared-memory threads are impossible from `file://`.
- WebGPU is not a fit.
- Safari reports only 4 or 8 cores, so measuring throughput, as Discpress's tuner does, is the right approach.

---

## Recommendation in one paragraph

1. **Ship a correctness hotfix now:**
   - GD-ROM back to the 0.289 layout;
   - LZMA level 8;
   - honest identity wording;
   - input guard rails.
2. **Hard-fork chdman's minimal BSD-3 closure** (78 objects; 75 MAME source files in the end) into `engine/`, exposed as a library that the browser drives directly, with no `callMain` or Asyncify, and with an explicit compatibility contract and output tiers: reference, compatible and extended.
3. **Take the free speed.** Fast hashing, early abort, a per-track codec plan and parallel decoding give a 1.5–2.8× faster "compatible" mode.
4. **Add fidelity features:** Redump-exact extraction and verification, the parser fixes, and new input formats.
5. **Test every output** against several independent readers, not just the build it came from.

Details, ordering and effort are in [fork-plan.md](fork-plan.md).
