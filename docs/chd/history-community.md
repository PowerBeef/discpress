# E: chdman and CHD history, community pain points, ecosystem, alternative implementations, competing formats

> Part of the [Discpress chdman research dossier](README.md), 2026-09-27. Written by a research agent from source reading and experiments. `$SP/...` paths name artefacts in the temporary research workspace, which is not part of the repository (reproducible lab tooling is in [lab/](lab/)). Lane letters (A, B, C, D1, D2, E, G) refer to the reports listed in the README.

Lane E of the Discpress chdman-fork dossier. Written 2026-09-27.

**Sources:** the MAME git history (a blobless clone of `mamedev/mame` at `origin/master` 02342fb054 = mame0289-1176, plus the read-only Discpress tree at 76c7d197ed = mame0289-1167), MAME release notes, GitHub issues, PRs and discussions, MAME Testers, the Reddit archive (Pullpush API), and project READMEs. I also ran my own codec-drift and end-to-end experiments (§1.7).

**Evidence labels:**
- **[V]** I verified it myself, from git or code or by experiment.
- **[S]** A cited source says it; I did not re-verify it.
- **[U]** Unverified or inferred.

**Release mapping:** "0.xxxuN" is an interim update. Its changes first ship in the full release 0.(xxx+1). Tag dates come from the git tags.

**Limitations:**
- The GitHub REST API for mamedev was not available, so issue timelines and closing commits come only from what the web UI showed.
- The Emulation General wiki, psxdev forum and web.archive.org were blocked (Cloudflare or proxy).
- Reddit came via the Pullpush archive, which is rate-limited and thin before 2024.
- The whatsnew files on mamedev.org start at 0.100.

---

## 0. Key findings (read this first)

1. **The Discpress pin is not chdman 0.289.** `76c7d197ed` is `mame0289-1167`, which is 1,167 commits *after* the 0.289 tag (f34f02505e, 2026-07-30) [V]. It includes several post-0.289 chdman changes [V]:
   - LZMA SDK 26.02, with the CHD LZMA level changed from 8 to 6 (c23567b509);
   - zstd 1.5.7 (f9050e8508);
   - a GD-ROM pregap rework (1cf0f9e986, ac47a71ce1);
   - session metadata (b93961fd52, 20661546b2);
   - CD+G input (c9e87a6b7e);
   - several hardening commits.

   **What this does to output (end-to-end tests, §1.7):**
   - **Non-GD CD, DVD and HD CHDs:** every fixture produced a different file from a native chdman built at the `mame0289` tag. The SHA1 and data SHA1 were the same, and the LZMA level change alone explains the byte difference: 0.289 patched to level 6 gives files byte-identical to the pin, 7 of 7 [V].
   - **GD-ROM CHDs** (from both GDI and Redump cue) also differ in **SHA1 and data SHA1** [V].
   - **Consequence:** the Discpress release notes' claim "byte for byte … as the ones desktop chdman 0.289 makes" is only true against a native build of the same post-0.289 snapshot, not against official 0.289.
   - **Fix:** a one-line change back to `props.level = 8` in the pin makes all non-GD fixtures byte-identical to 0.289 [V end-to-end]. GD-ROM needs the two GD commits reverted.
   - **Resolved in Discpress 1.2.1:** the pin moved to the `mame0289` tag. Its native build matched 0.289 on all 9 fixtures [V], and the test suite now checks the GD-ROM layout.
2. **Several upstream changes altered the output bytes of CHDs** for the same input and options (full ledger in §1.6):
   - **Codec libraries:**
     - LZMA SDK 16.04 → 22.01 (0.255);
     - FLAC 1.2.1 → 1.4.3 (0.262);
     - the LZMA level change and zstd 1.5.7 (post-0.289).
   - **Defaults:** the DVD hunk size, 2048 → 4096 (0.263).
   - **Metadata and layout:**
     - `PGSUB:NONE` (0.176, still open as issue #2517);
     - the GD-ROM audio byte-swap and `CHGD` tag (0.154);
     - pregap handling (0.149);
     - the GD-ROM layout, several times.

   Every zlib bump from 1.2.3 to 1.3.2 left the bytes unchanged [V].
3. **Output also depends on the build, not just the MAME version:**
   - FLAC 1.3.3 (e.g. distro system libFLAC) differs from both 1.2.1 and 1.4.3 [V].
   - zlib-ng as system zlib differs from zlib [V].
   - Debian builds with system zlib and FLAC [S].
   - Before 0.147, the Huffman tree depended on the libc `qsort` [V code]; MSVC builds were affected by uninitialised last-hunk memory until 0.148 [V code].
   - Before 0.150, 32-bit x87 FLAC builds differed [V code].
   - "Byte-identical to chdman X" is therefore only well-defined if you also name the build.
4. **A byte-identity trap is still live:** the tail of the final, partial hunk contains stale bytes from chdman's ring buffer. For example, an ISO with an odd sector count leaves 2048 bytes copied from sector 489 earlier in the input [V, experiment]. Reported as #13048; a fix PR (#16043) was reverted in 2026-09. Any reimplementation must reproduce this to be byte-identical.
5. **Upstream pace and culture:**
   - **Activity:** after the 2012 V5 burst (66 commits), the CHD code saw 4–49 commits a year: 49 in the 2016 refactors, 5–8 a year in 2017–2019, and only 4 in 2025. July–September 2026 saw a surge of 19 commits, driven by GD-ROM work (MetalSlug) and AI-assisted hardening PRs (Heath/simzy39). The maintainer (Vas Crabb) reverted two of these as "AI slop" [V].
   - **Review:** PRs that changed output were merged without review discussion (#15870) [S].
   - **Tests:** the chdman regression tests in `regtests/chdman` date from 2015 and only cover empty or silent inputs [V].
   - **Maintainer view:** Vas Crabb (cuavas): *"The chdman code is pretty dire to be honest"*, while lib/util is *"isolated pretty well … relatively easy to integrate into other projects"* ([mamedev discussion #89](https://github.com/orgs/mamedev/discussions/89)) [S].
6. **What the community wants most:**
   - batch or folder conversion and a GUI (dozens of wrappers exist; namDHC has 636★);
   - automatic CD vs DVD choice;
   - PSP-safe defaults (`-hs 2048`);
   - more input formats (CDI, MDS/MDF, CCD, PBP, CSO, ECM, ISZ, MP3 or FLAC audio in cue);
   - Redump-faithful round trips and verification against Redump DATs (cue metadata is lost: CATALOG, INDEX 02+, CD-TEXT);
   - compatibility presets (older cores choke on zstd or DVD CHDs);
   - more speed.

   Browser-based chdman ports now exist; they compete directly with Discpress (§4.2).
7. **Other writers now exist:**
   - CHDSharp (pure C#, July 2026) claims byte-parity with chdman 0.289 [S].
   - igir now embeds MAME at the **0.289 tag** as a Node native addon [V].
   - libchdr (reader) is very active in 2026: LZMA 26.02, zstd 1.5.7, AVHuff, MCU targets [V].

---

## 1. Timeline from the MAME history

### 1.1 Before git (MAME 0.59–0.120)

| Version (date) | Event | Source |
|---|---|---|
| 0.59 (2002-03-22) | Aaron Giles implements CHD, "Compressed Hard Disk", later renamed "Compressed Hunks of Data". Created for the Atari/Midway Seattle hard-disk games. | [mamedev history](https://github.com/mamedev/www.mamedev.org/blob/master/history-temp.php), [Aaron Giles](https://aarongiles.com/programming/war-mame/) [S] |
| 0.63 (2003-01-12) | First real CHD (War Gods). | same [S] |
| 0.70u1 (2003-06-12) | **CHD V2** (adds a `seclen` field; 80-byte header). | same; header layout in 0.121 `chd.h` [V] |
| 0.77u1 (2003-11-21) | **CHD V3** (120-byte header: logical bytes, metadata offset, MD5+SHA1, parent SHA1). `hdcomp` is replaced by **chdman**. | same [S]; layout [V] |
| pre-0.100 [U] | CD-ROM CHDs (CDRDAO `.toc` input; `CHCD` binary metadata, then `CHTR` text metadata). | 0.121 source has `cdrom.c`/`chdcd.c` "CDRDAO TOC parser" [V]; exact version not found [U] |
| 0.103/0.104 (2006) | 64-bit / >4 GB file support in chdman on *nix (Lawrence Gold). | [whatsnew 0.103/0.104](https://www.mamedev.org/releases/whatsnew_0104.txt) [S] |
| 0.107 (2006) | "RAW" 2352-byte CD CHDs; non-RAW CD CHDs deprecated (R. Belmont). | whatsnew 0.107 [S] |
| 0.111 (2006-12) | Hunks up to 16 MB (from 64 KB); codec config hooks; split CHD files (`chdman -split`); metadata converted to text. | whatsnew 0.111 [S] |

Compression in V1–V4 was **one codec per file**: none, zlib, "zlib+" or A/V. The A/V codec came with laserdisc support in 0.127 (2008) [V].

### 1.2 Release-by-release table (git era, 0.121 → master)

Only releases that touched CHD, chdman, cdrom, the codecs, the codec libraries or the chdman work queue are listed. The commit lists are in `research/E/core-log.txt` and `research/E/libs-log.txt` in the scratchpad.

| MAME (tag date) | Notable changes (commit) | Output impact |
|---|---|---|
| 0.121 (2007-12-17) | Git history starts. chdman.c options: `-createhd/-createraw/-createblankhd/-createcd input.toc/-createav/-extract/-extractcd/-verify(fix)/-update/-chomp/-merge/-diff/-setchs`. CHD **V3**. | — |
| 0.127 (2008-08-19) | Laserdisc era: `huffman.c` rewritten for interleaved streams + delta-RLE (a85c4c754d); per-frame metadata removed from chdman, A/V from AVI only (776b251aa2); `ldverify`. First LD game (Cube Quest). | new A/V format |
| 0.128 (2008-10-16) | LD CHDs need pre-decoded VBI metadata `AVLD`; `chdman -fixavdata` (1eb3c2d964). | LD metadata |
| 0.130u1 → **0.131** (2009-04-23) | **CHD V4** (21b5f27224, d2d22a19af, Aaron Giles): separate raw-data SHA1 plus an overall SHA1 over data and metadata; metadata checksummed by default; "all existing CHD diff files are invalid"; `-addmeta`. Metadata flags added in 0.129u6 (e8c09b35f6). | all SHA1s change |
| 0.134u3 → 0.135 (2009-10-31) | lib/util and Aaron's tools relicensed to **BSD** (a6c5893732, 17576a7e6a, 8b430a357f); uncompressed writable HD for MESS (505c25f0c7). | — |
| 0.138 (2010-05-15) | cdrom stack-corruption fix; form-2 raw header length. | — |
| 0.138u2 → **0.139** (2010-07-29) | **CDRWIN .bin/.cue** input and output; pregap/postgap kept in new **`CHT2`** metadata (842282c0fa, R. Belmont). | new metadata tag |
| 0.139u3 → 0.140 (2010-10-21) | bin/cue parser rewritten from specs (f4aa843155); **audio tracks byte-swapped** from cue (2fd7b88586), so CD-DA is stored big-endian; `.wav` tracks in cue (32e006222b); extractcd improvements. | cue audio data changes |
| 0.141u3 → 0.142 (2011-04-03) | Experimental **.nrg** import (6dd5dc47db). | — |
| 0.143u4 → 0.144 (2011-11-13) | **GDI** input (paths, spaces) and loading of non-CHD images in the cdrom device (45359b609b, 36136e2293, M. Milanovic). | — |
| 0.144u7 → 0.145 (2012-02-05) | FLAC codec added (8703f92910, D. Haywood, R. Belmont). `-createcdflac` disabled because the result was not V4-compatible (48a2c8260d); FLAC samples-vs-bytes fix (56e6ba8b7c). | experimental |
| **0.145u1 → 0.146** (2012-05-21) | **CHD V5** (f0823886a6, Aaron Giles, 2012-02-16; see §1.3 for what it added). Also:<br>• CD-FLAC codec (`cdfl`), used by default for CDs (9e8ea7466f, idea by Haze)<br>• **CD hunk 4 → 8 frames** (19,584 B) and FLAC added to HD defaults (5409b54206, u2)<br>• CD codecs strip ECC (7818ba99ea, u6)<br>• GDI processing corrected, `CHGT` GD-ROM tag, extract to `.gdi` (bb993d1174, u4)<br>• `dumpmeta` (1824c80bdd)<br>• SDL `num_processors` for multicore on non-Windows (a0b7883fa3)<br>• LZMA/7z (d75dbab0de, LZMA SDK 9.22 beta)<br>• FLAC LPC regression introduced (e8829d3ac9, u8; see 0.148) | new format |
| 0.146u2 → 0.147 (2012-09-17) | Huffman `qsort` comparator never returns "equal" and uninitialised variables fixed, "working around unstable system libc implementations" (6b1346e865, jmak); zlib **1.2.7** (dade33f755); libflac md5 memory leak (MT 04864). | determinism fix |
| 0.148 (2013-01-11) | **ISO input** (9f35153021, `.cdr` alias); NRG fixes; logical sector addresses (a6a1b82868); **FLAC LPC regression fixed** (d1a912fae7: "FLAC encoder did not use FIR Linear prediction"); uninitialised memory in the last hunk fixed (e111fe61f3: "potentially different filesize with each compiler"). | FLAC and last-hunk bytes change |
| 0.149 (2013-06-11) | Correct import/export of cues with **pregap sectors present**; TOC normalised; `V` prefix in `PGTYPE` (22d69c1f2b, R. Belmont). | CHT2 and layout change for INDEX 00 cues |
| 0.150 (2013-09-17) | zlib **1.2.8** (2d650cda4e). FLAC autocorrelation optimisation disabled for 32-bit GCC "to prevent different output filesizes" (bb590452dd, 3a7c6bac73); libFLAC always built unoptimised (bb8d90c0fa). `-c` no longer leaks default codecs (f365fbecc2); hang on read failure fixed (ac76a12974). | x87 build determinism |
| 0.151 (2013-11-05) | `OSDWORKQUEUEMAXTHREADS` env hack "so chdman doesn't hang" (db806d8476, smf; MT 04709). | — |
| 0.154 (2014-07-23) | **GD-ROM audio tracks byte-swapped** so FLAC works, plus new tag **`CHGD`** (3eb1f14701, MetalliC). Commit note: "this will change the SHA1s of every GD-ROM CHD in MAME … `chdman copy` suffices". Fixes MT 05522. `.gdi` output quoting and `.raw` audio (bd320e789d). | all GD-ROM SHA1s change |
| 0.155 (2014-10-15) | winwork/sdlwork consolidation (O. Stöneberg). The Windows `osd_get_num_processors()` now returns `MIN(dwNumberOfProcessors, 4)` ("max out at 4 for now since scaling above that seems to do poorly"), so **Windows chdman defaults to ≤4 threads**; SDL/Unix stays uncapped (`sysconf`). `OSDWORKQUEUEMAXTHREADS` on SDL too. | speed only |
| 0.158 (2015-01-28) | `createhd -s` blank-disk size (33ebcc9120); zlib, LZMA and FLAC moved to `3rdparty/`; winwork and sdlwork merged into `work_osd`. | — |
| 0.169 (2015-12-30) | `info -v` metadata (7ae681b010). | — |
| 0.173 (2016-04-27) | LZMA SDK **15.14** (e925c494fe). New `std::thread` work queue in `osdsync.cpp`: **`osd_get_num_processors()` = `MIN(hardware_concurrency, 4)` on every platform**, so Linux and macOS are now capped too. An explicit `-np N` or `OSDPROCESSORS` could still go up to `4 × 4 = 16`. extractcd name fix. | no byte change [V] |
| 0.174 / 0.180 | LZMA **16.00** (7a423d0160) / **16.04** (bb99eba11d). | no byte change [V] |
| 0.176 (2016-07-27) | **`PGSUB` set to `NONE` for .cue/.toc** (85488e4328, MetalliC): metadata grows by 2 bytes and overall SHA1s mismatch the softlists ([#2517](https://github.com/mamedev/mame/issues/2517), open since 2017). >2 GB ISO and 64-bit fixes (0c85178c1e, 2cf35d78d8). | SHA1 of every cue/toc CD changes |
| 0.182 (2017-01-25) | **HD templates** (`-tp`, `listtemplates`; c6043bac17, Dirk Best); zlib **1.2.9**. | — |
| 0.183 | zlib **1.2.11**. | no byte change [V] |
| 0.194 / 0.202 / 0.206 | ISO with 2336-byte sectors; `.toast`; GDI 2048 extraction fix. | — |
| 0.222 | chdman accepts non-ASCII command-line arguments on Windows. | — |
| **0.227** (2020-12-31) | **Redump multi-cue GD-ROM input** (ccacd0f165, nhand42, #7422), converted to TOSEC layout; before this, Redump-cue CHDs would not boot in Flycast ([flycast#960](https://github.com/libretro/flycast/issues/960)). | new GD path |
| 0.235 / 0.236 | More HD templates; HD block size option. | — |
| **0.239** (2021-12-29) | **4-thread cap removed** for chdman's queues; wake-up race fixed (0b418d65ba, tellowkrinkle, #9006). | speed |
| 0.243 (2022-04-29) | zlib **1.2.12**; `cdrom_file` and `hard_disk_file` classes (O. Galibert). | no byte change [V] |
| 0.247 / 0.250 | TOC session type in extractcd; at least one worker thread on thread-less platforms (Emscripten). | — |
| **0.255** (2023-05-30) | **`createdvd`/`extractdvd`**, `DVD ` metadata (28104cdbdf, d4f0d95e91, O. Galibert); DVD hunk fixed at **2048**. **LZMA SDK 22.01** with CHD level 9 → 8 (a504bde3a7). | **LZMA bytes change** [V] |
| 0.260 (2023-10-24) | Clone CHDs can use parent CHDs (d1172bf710). | — |
| **0.262** (2024-01-31) | **Zstandard** codecs `zstd` and `cdzs` (05e69b43e9, #11827, zstd 1.5.5, level `ZSTD_maxCLevel()`). **FLAC 1.4.3** (faf991a563). LZMA **23.01**. zlib **1.3**. "Don't strip GD-ROM track pre-gaps when reading cue" (b75b8d80e8, #11913). | **FLAC bytes change** [V]; LZMA and zlib unchanged [V] |
| **0.263** (2024-02-27) | chdman overhaul (5731492874, fa9d0fc32a, Vas Crabb): unknown options rejected, `verify -f` fixed, conflicting options detected, `createdvd -hs`, **default DVD hunk 4096**, first docs page. Bitstream writer dropped bits, giving bad maps on huge CHDs (0b15781e69, #12057). Map buffer sizing (d64e3f7cf2, #12023). | **DVD bytes change**; PPSSPP backlash ([#12143](https://github.com/mamedev/mame/issues/12143)) |
| 0.264 | `parse_cue`/`parse_gdicue` refactored, fixing 0.263's Dreamcast breakage (853db181d2, #12081). | GD-ROM cue path |
| **0.265** (2024-04-24) | **`extractcd --splitbin`** and Redump-style GD-ROM cue output (79c1ae350d, #12191); TOC zeroing (067afa1a2e). | extraction |
| 0.266 | **Multisession**, all INDEXes and FLAGS read from cue, preliminary (df62ba1451, #12201). | cue parse |
| 0.271 (2024-10-30) | chd API moves from exceptions to `std::error_condition`; compressor keeps read errors (43584224eb, beb81e4842, 46521af559, ad459a9025). | — |
| 0.272 | CUE/TOC/GDI parsers hardened; last line without a newline no longer ignored (2c8de2ee29, #12948); TOC control flags (e9dcdb5200). | parse fixes |
| 0.276 | Delta-CHD workaround (65c263749e, #13029: "no worse than it was in 0.270"). | — |
| 0.277 | zlib **1.3.1**. | no byte change [V] |
| 0.280 (2025-08-30) | `verify --fix` asks for write permission (02fc472f18, #14019). | — |
| **0.289** (2026-07-30) | zlib **1.3.2** (60dd3aeeb1; the commit message says "3.1.2", a typo, since `zlib.h` says 1.3.2 of 2026-02-17); Quantum Fireball HD templates. | no byte change [V] |
| **post-0.289 master** (2026-07-31 → 09-27; all in the Discpress pin) | **GD-ROM:** `--removepregap/--addpregap` (1cf0f9e986, #15808), then removed again when GDI virtual pregaps arrived (ac47a71ce1, #15870, MetalSlug, merged by R. Belmont without review comments).<br>**Codec libraries:** LZMA SDK **26.02** with CHD **level 8 → 6** (c23567b509); zstd **1.5.7** (f9050e8508).<br>**Metadata:** session metadata **`CHSE`** (b93961fd52, 20661546b2).<br>**New input:** **CD+G** (c9e87a6b7e, #15910).<br>**Hardening:** `util/chd` modernisation and range fixes, including a byte-wise zero-hunk check (954cbbe49f, e5e82312c2). CD-extraction read errors (14d07e35c1) and dumpmeta stdout errors (8a00440d2d) now handled; AVHuff capped at 16 audio channels (1736a9595b). Two PRs reverted as "AI slop": short writes (ebe430d9fd reverting e0b94b77a5) and raw-input padding (c2f6ac79c1 reverting 33d4dc0aff). | **LZMA, zstd and GD-ROM bytes and SHA1s change** [V] |

**First release with V5:** V5 first appeared in 0.145u1 (2012-02-19) and first shipped in **MAME 0.146 (2012-05-21)**.

**Latest release:** as of 2026-09-27 it is 0.289. 0.290 is presumably imminent, since the tags run roughly monthly or bimonthly [U]. Whether 0.290 keeps level 6 and the GD-ROM changes is an open question.

### 1.3 The format and its metadata tags over time

| Item | Introduced | Notes |
|---|---|---|
| V1 header (76 B, MD5, 512-byte sectors per hunk) | 0.59 | read support dropped in V5 ("versions prior to 3 are unsupported") [V commit msg] |
| V2 (80 B, `seclen`) | 0.70u1 | same |
| V3 (120 B, logical bytes, metadata, SHA1) | 0.77u1 | readable, not writable, by V5 code |
| V4 (108 B, raw SHA1 + combined SHA1 + parent SHA1) | 0.130u1 → 0.131 | readable, not writable |
| **V5** (124 B) | 0.145u1 → **0.146** | V5 added [V]:<br>• up to 4 codecs per file, chosen per hunk<br>• LZMA, FLAC, Huffman and CD-FLAC codecs; AVHuff with FLAC audio<br>• **compressed map** (Huffman, with CRC16 per hunk)<br>• "unit" size, with parent diffing per unit<br>• self and parent hunk references (dedup)<br>• threaded compressor<br>• CD padding to 4-frame boundaries "so the same SHA1 is produced regardless of hunk size" |
| Codecs after V5 | `zstd` and `cdzs` in 0.262 | codec IDs added without a version bump; old readers fail with "unsupported format" |
| `GDDD` (HD geometry), `IDNT`, `KEY `, `CIS ` | pre-0.121 / 0.12x | hard-disk metadata |
| `CHCD` (binary CD TOC) → `CHTR` (text) | pre-0.121 | both still parsed |
| `CHT2` (adds PREGAP, PGTYPE, PGSUB, POSTGAP) | 0.138u2 → 0.139 (842282c0fa) | `V` prefix on PGTYPE = pregap data present (0.149); `PGSUB:NONE` for cue/toc (0.176) |
| `CHGT` (GD-ROM) | 0.145u4 → 0.146 (bb993d1174) | superseded |
| `CHGD` (GD-ROM, byte-swapped audio) | 0.154 (3eb1f14701) | GD metadata `PREGAP` becomes non-zero for GDI, and the `V` prefix is used, post-0.289 |
| `AVAV`, `AVLD` (laserdisc) | ≤0.121 / 0.128 | |
| `DVD ` | 0.255 (28104cdbdf) | DVD CHDs: fixed 2048-byte units, no other metadata |
| `CHSE` ("SESSION:%d") | post-0.289 (b93961fd52) | written only for multi-session discs |

No **"CHD v6" proposal** exists upstream [V: git, issues, discussions].
- The closest items are the zstd request [#7402](https://github.com/mamedev/mame/issues/7402) (2020, closed by 0.262) and the codec-selection-threshold idea in [discussion #163](https://github.com/orgs/mamedev/discussions/163), which had no replies.
- A psxdev forum page mentions a "CHDv6" EDC fix [U, page blocked].
- chyyran's formal CHD specification PR [#10222](https://github.com/mamedev/mame/pull/10222) (2022) is a stale draft [S].

### 1.4 chdman defaults over time

| Setting | History |
|---|---|
| CD hunk | 4 frames × 2448 = 9,792 B (V3/V4) → **8 frames = 19,584 B** from 0.145u2 / 0.146 (`CD_FRAMES_PER_HUNK`) [V] |
| HD / raw hunk | largest multiple of the sector size ≤ 4 KiB (V5 onwards) [V] |
| DVD hunk | **2048** (0.255–0.262, no `-hs` option) → **4096** (0.263+) [V]. PPSSPP warns on anything other than 2048 ([ppsspp#18803](https://github.com/hrydgard/ppsspp/pull/18803), [PPSSPP docs](https://dev.ppsspp.org/docs/getting-started/dumping-games/)) [S] |
| LD hunk | one frame [V] |
| createcd codecs | `cdlz,cdzl,cdfl` since 0.145u1 (CD LZMA = LZMA on sectors + zlib on subcode; CD FLAC = FLAC + zlib) [V] |
| createhd/raw/dvd codecs | `lzma,zlib,huff,flac` (FLAC added in 0.145u2). DVD reuses the HD list ("No reason to be different than HD") [V]. Community lore that createdvd defaults to zstd is **false** [V]. |
| createld codecs | `avhu` [V] |
| LZMA level (`configure_properties`) | **9** (0.146–0.254) → **8** (0.255–0.289) → **6** (post-0.289). The resulting parameters (all levels use algo=1, bt4 matcher, lc3/lp0/pb2) [V]:<br>• 9.22 at L9: dict 64 KiB (`reduceSize` rounding from i=15), fb=64, mc=48<br>• 15.14–16.04 at L9: dict rounded up (CD 24 KiB, 4 KiB hunk 4 KiB), fb=64, mc=48<br>• 22.01+ at L8: dict = max(hunk, 4 KiB), fb=64, mc=48<br>• 26.02 at L6: same dict, **fb=32, mc=32** |
| zstd level | `ZSTD_maxCLevel()` = 22, one frame per hunk [V] |
| FLAC | level 8, block size = bytes/4 halved down to ≤2048 (1176 samples for CD hunks, 1024 for 4 KiB hunks), stereo 16-bit 44.1 kHz, both endiannesses tried (non-CD FLAC) [V] |
| zlib | level 9, raw deflate (−15), memLevel 8, default strategy [V] |
| Threads | Default worker count [V code]:<br>• 0.146–0.154: all logical CPUs (Windows `GetSystemInfo`, SDL `sysconf`)<br>• 0.155–0.172: **Windows ≤4**, Unix uncapped<br>• 0.173–0.238: **≤4 everywhere** (`-np N` could reach 16)<br>• 0.239+: all hardware threads<br>`-np` sets an explicit count |

### 1.5 Codec-library versions per release

| Library | Versions (first MAME release that shipped it) | Output change at chdman settings |
|---|---|---|
| zlib | 1.2.3 (≤0.146) · 1.2.7 (0.147) · 1.2.8 (0.150) · 1.2.9 (0.182) · 1.2.11 (0.183) · 1.2.12 (0.243) · 1.3 (0.262) · 1.3.1 (0.277) · 1.3.2 (0.289) | **none observed** in any step [V] |
| LZMA SDK | 9.22β (0.146) · 15.14 (0.173) · 16.00 (0.174) · 16.04 (0.180) · 22.01 (0.255) · 23.01 (0.262) · 26.02 (post-0.289) | **16.04 → 22.01 changed** [V]; the others did not [V] |
| libFLAC | 1.2.1 (0.145–0.261; built `FLAC__NO_ASM`, and `-O0` from 0.150) · 1.4.3 (0.262+, optimised, SSE/NEON intrinsics compiled in, AVX/FMA off because `FLAC__USE_AVX` is undefined) | **1.2.1 → 1.4.3 changed** [V] |
| zstd | 1.5.5 (0.262–0.289) · 1.5.7 (post-0.289) | **changed** (zstd/cdzs only) [V] |
| Distro builds | Debian: `USE_SYSTEM_LIB_ZLIB=1`, `USE_SYSTEM_LIB_FLAC=1` ([debian/rules](https://sources.debian.org/data/main/m/mame/0.289+dfsg1-1/debian/rules)); versions per suite: sid 0.289, trixie 0.276, bookworm 0.251 (no createdvd) | FLAC 1.3.3 ≠ 1.2.1 ≠ 1.4.3 = 1.5.0; zlib-ng ≠ zlib [V] |

### 1.6 Ledger of changes to CHD output bytes (same input, same options)

This ledger is what "byte-identical to chdman X" depends on. Each item says whether it changes the **file bytes only** (header SHA1s unchanged) or also the **SHA1** or **data SHA1**.

| # | Release (commit) | Change | Scope | Evidence |
|---|---|---|---|---|
| 1 | 0.131 (21b5f27224) | CHD V4 | everything | [V] |
| 2 | 0.140 (2fd7b88586) | cue/bin audio stored byte-swapped | data SHA1 of CD-DA tracks from cue | [V code] |
| 3 | 0.146 (f0823886a6 …) | V5 plus u-release tuning:<br>• CD-FLAC codec<br>• 8-frame CD hunks<br>• FLAC for HD<br>• ECC stripping (7818ba99ea) | everything | [V] |
| 4 | 0.146–0.147 → fixed 0.148 | libFLAC `lpc.c` VS-warning edit (e8829d3ac9) removed `r/=err`, so the LPC path went unused; fixed by d1a912fae7 | FLAC and cdfl hunks (bytes only) | [V code] |
| 5 | 0.147 (6b1346e865) | Huffman `qsort` tie-break; uninitialised vars | huff hunks and map, **platform-dependent before** | [V code] |
| 6 | 0.148 (e111fe61f3) | last hunk zeroed on creation | last hunk; **compiler-dependent before** | [V commit msg] |
| 7 | 0.149 (22d69c1f2b) | pregap sectors present in cue are imported as `V` pregaps; TOC normalised | CHT2 metadata and layout for INDEX 00 cues | [V code] |
| 8 | 0.150 (bb590452dd, bb8d90c0fa) | FLAC autocorrelation unoptimised / libFLAC `-O0` | only 32-bit x87 builds changed (made consistent) | [V commit msg] |
| 9 | 0.154 (3eb1f14701) | GD-ROM audio byte-swapped; `CHGT` → `CHGD` | **SHA1 of every GD-ROM CHD** | [V commit msg] |
| 10 | 0.176 (85488e4328) | `PGSUB:NONE` for cue/toc | **overall SHA1 of every cue/toc CD** (metadata +2 bytes; [#2517](https://github.com/mamedev/mame/issues/2517)) | [V code] + [S] |
| 11 | 0.176 (0c85178c1e, 2cf35d78d8) | >2 GB ISO and 64-bit fixes | large inputs (previously wrong) | [V commit msg] |
| 12 | 0.227 (ccacd0f165) | Redump GD-ROM cue parsed into TOSEC layout | new input path (previously treated as plain CD) | [V] |
| 13 | **0.255 (a504bde3a7)** | **LZMA SDK 16.04 → 22.01** (level 9→8 is neutral) | every `lzma`/`cdlz` hunk (bytes only) | **[V experiment]** |
| 14 | 0.255 (28104cdbdf) | createdvd (new command) | — | [V] |
| 15 | **0.262 (faf991a563)** | **libFLAC 1.2.1 → 1.4.3** | every `flac`/`cdfl` hunk (bytes only) | **[V experiment]** |
| 16 | 0.262 (b75b8d80e8), 0.264 (853db181d2), 0.272 (2c8de2ee29) | GD-ROM cue pregap handling; parser fixes (last line without newline) | Redump GD cue; unterminated cues | [V code, not re-run] |
| 17 | **0.263 (fa9d0fc32a)** | **createdvd default hunk 2048 → 4096** | every DVD CHD | [V code] |
| 18 | 0.263 (0b15781e69, d64e3f7cf2) | bitstream writer dropped bits; map buffer size | maps of very large or delta CHDs (entries needing >24 bits); previously corrupt | [V code] |
| 19 | 0.266 (df62ba1451) | multisession, INDEXes and FLAGS parsed from cue | multisession cues (layout) [U: no SESSION metadata until post-0.289] | [V code] |
| 20 | **post-0.289 (c23567b509)** | **LZMA level 8 → 6** (fb 64→32, mc 48→32), alongside SDK 26.02 (which alone is neutral) | every `lzma`/`cdlz` hunk (bytes only); **includes the Discpress pin** | **[V end-to-end]** |
| 21 | **post-0.289 (f9050e8508)** | **zstd 1.5.5 → 1.5.7** | `zstd`/`cdzs` hunks (only with `-c` choosing them) | **[V experiment]** |
| 22 | **post-0.289 (1cf0f9e986, ac47a71ce1)** | GD-ROM: Redump cue keeps its own pregaps (`VAUDIO`); GDI gaps become "virtual pregaps" instead of zero padding | **SHA1 and data SHA1 of every GD-ROM CHD**; Redump-cue and GDI CHDs of one disc no longer share a data SHA1 | **[V end-to-end]** |
| 23 | post-0.289 (b93961fd52) | `CHSE` session metadata | overall SHA1 of multi-session CDs | [V code] |
| 24 | post-0.289 (e5e82312c2) | zero-hunk detection byte-wise (old code missed 1–3 trailing bytes) | only when the hunk size is not a multiple of 4 (previously **silent corruption**) | [V code] |
| 25 | post-0.289 (c9e87a6b7e) | `CDG` cue/toc track type | new input | [V] |
| — | never fixed | **stale data in the tail of a partial last hunk** (ring-buffer leftovers; the #16043 fix was reverted) | last hunk bytes; must be reproduced for byte identity | **[V experiment]** |

**Not output-changing** [V experiment unless noted]:
- all zlib bumps;
- LZMA 9.22 → 16.04;
- LZMA 22.01 → 23.01 → 26.02 at the same level;
- libFLAC 1.4.3 → 1.5.0;
- the libFLAC 1.4.3 SSE, AVX/FMA or `FLAC__NO_ASM` build variants, and `-ffp-contract=fast` (no difference on my 12 MB test audio; rounding-boundary cases are still possible [U]).

### 1.7 Experiments (reproducible, all under `$SP/src/`)

`$SP` is the temporary research workspace.

**Corpus** (`drift-E/gen.py`):
- `data.bin`: 23.7 MB of mixed system binaries, libraries and text, 1 MB of zeros, 1 MB of random bytes and repeated text.
- `audio.raw`: 12.4 MB of synthetic 16-bit stereo "music" plus noise and silence.

**Method:** each harness (`zt.c`, `lt.c`, `ft.c`, `zst.c`) mirrors chdman's compressor call exactly:
- zlib: `deflateInit2(9,-15,8)`, then `deflateReset` + `deflate(Z_FINISH)` per hunk;
- LZMA: `LzmaEncProps` with level and `reduceSize = hunk`, then `LzmaEnc_MemEncode`, no end mark;
- FLAC: MAME's `flac_encoder` settings, including metadata stripping;
- zstd: `ZSTD_initCStream(maxCLevel)` + `ZSTD_compressStream2(e_end)`.

Library sources were exported from MAME at each release tag (`codecs-E/v0xxx`).

**LZMA, total compressed bytes and SHA1 of the output stream:**

| SDK / level | 4 KiB hunks (HD/DVD) | 18,816 B (CD `cdlz` base) |
|---|---|---|
| 9.22β, 15.14, 16.00, 16.04 @ L9 | 8,099,518 `0559ed5f` | 7,306,838 `ce3c8b2b` |
| 22.01 @ L9 or L8; 23.01 @ L8; 26.02 @ L8 | 8,085,538 `96c16fa5` | 7,300,087 `b20445cc` |
| 23.01 or 26.02 @ **L6** | 8,090,519 `9943e49a` | 7,308,032 `6a2f5ad8` |

**FLAC** (`cdfl` block size 1176 / `flac` 1024), SHA1 of the output stream:
- 1.2.1: `fb563e44` / `b1f86171`
- 1.3.3: `3448f211` / `8fb5ca0d`
- 1.4.3 (every build variant) and 1.5.0: `bda52d0d` / `71d94b8c`

**zstd L22:**

| Hunk size | 1.5.5 | 1.5.7 |
|---|---|---|
| 4 KiB | 8,351,557 B | 8,316,889 B |
| 18,816 B | 7,721,307 B | 7,679,301 B |

**zlib-ng** (2026-07 master, compat mode):

| Hunk size | zlib-ng | zlib |
|---|---|---|
| 4 KiB | 10,374,703 B | 10,374,458 B |
| 18,816 B | 9,634,271 B | 9,629,374 B |

**End to end** (`build289-E/chdman-289`):
- I built native chdman from the **mame0289 tag** with Discpress's own `wasm/Makefile` native rules, minus two post-0.289 files and `-DZLIB_CONST`.
- I compared it with Discpress's `build/chdman-native` (the pin plus patch) on the Discpress synthetic fixtures (`tests/fixtures/make_fixtures.py` → `fixtures-E`), plus a Redump-style GD-ROM cue I made (`aw.cue`).

| Fixture | 0.289 file size | pin file size | Files | SHA1 / data SHA1 |
|---|---|---|---|---|
| PS1 multi-track cue | 1,520,854 | 1,520,984 | differ | same |
| Saturn cue | 573,490 | 573,539 | differ | same |
| Sega CD cue | 983,791 | 983,892 | differ | same |
| PS2 ISO (createdvd) | 10,450,303 | 10,449,039 | differ | same |
| PSP ISO (createdvd) | 5,816,128 | 5,815,240 | differ | same |
| HD img | 4,117,491 | 4,117,242 | differ | same |
| **Dreamcast GDI** | 1,017,053 | 1,017,846 | differ | **both differ** (0.289 `7eb71b50`/`953a3015` vs pin `462b9469`/`d9ee7e58`) |
| PS1 single-track cue | 740,775 | 740,926 | differ | same |
| **Redump GD cue** | 1,017,051 | 1,017,370 | differ | **both differ** (0.289 `68a7b53d`/`953a3015` vs pin `c1626093`/`7458e483`; logical size 112,735,296 vs 112,725,504) |

In 0.289, a GDI and the equivalent Redump cue produce the **same data SHA1** (`953a3015…`), which was the stated goal of #7422. In the pin they do not.

**Controls:**
1. I rebuilt 0.289 with only `props.level = 6`. The result is **byte-identical to the pin for all 7 non-GD fixtures**, so the LZMA level is the only cause there.
2. I rebuilt the pin (76c7d19, from my own clone, without the Discpress patch) in two variants:
   - **Unchanged (level 6):** byte-identical to Discpress's own `build/chdman-native` on all 9 fixtures. So the Discpress patch does not alter native output, and my build method is faithful.
   - **With the one-line change to level 8:** byte-identical to 0.289 on all 7 non-GD fixtures. This also confirms end-to-end that LZMA 26.02 at level 8 matches 23.01.
   - The two GD-ROM fixtures still differ, which isolates the GD-ROM commits as the remaining cause [V, `src/pinL8-E/build/chdman-pin-L6`, `chdman-pin-L8`].

**Stale tail:** `createdvd` of a 1,001-sector ISO gives a 4 KiB-hunk CHD whose last hunk holds 2,048 bytes of input sector 489 after the logical end (read back with libchdr, `drift-E/lasthunk.c`). The result is identical in 0.289 and the pin.

A quick single-thread timing of level 6 vs 8 was inconclusive (noisy shared machine); level 6 output was 0.02–0.1 % larger on CD data.

### 1.8 Threading and speed history

- **V5 (0.146):** hunks are compressed in parallel through `osd_work_queue`. Reading, hashing and map building stay serial [V].
  - `-np`/`--numprocessors` is available.
  - At first the queue used every logical CPU: `winwork.c` `effective_num_processors()` returned `dwNumberOfProcessors`, and SDL got a `num_processors` API (a0b7883fa3).
- **2012–2015 hangs:** MAME Testers [04709 "chdman: random deadlocks"](https://mametesters.org/view.php?id=4709) (2012, still "Acknowledged"). Workarounds:
  - `OSDWORKQUEUEMAXTHREADS` (0.151, 0.155);
  - ThreadSanitizer fixes (0.158);
  - a "workaround hang" (0.175, 2cea059009).
- **The 4-thread cap:**
  - Windows builds were capped at **4** threads by default from **0.155** (2014).
  - The `std::thread` rewrite in **0.173** (2016) extended the cap to every platform. An explicit `-np` could still reach 16.
  - So for about seven years, most users' chdman used at most 4 threads by default, which fed the "chdman is slow" reputation.
  - **0.239** removed the cap for chdman's non-high-frequency queues (0b418d65ba, [#9006](https://github.com/mamedev/mame/pull/9006) by tellowkrinkle: "Remove 4-thread limit … Fix race condition that made work queues not wake up enough threads").
- **Extraction and verify** are single-threaded [V code].
- Third-party speed work:
  - [chdman-simd](https://github.com/grouik1er-coder/chdman-simd) (2026): 3-slot pipeline, SHA-NI, CRC16 slice-by-16, LZMA asm decoder, zlib-ng; "11.15 s → 3.26 s" on a verify-type workload. Not byte-identical if it compresses with zlib-ng [V: zlib-ng output differs].
  - RomVault 3.6: its native CHD scan is "3–4× faster than chdman.exe" [S].
  - Community forks also note the triple FLAC encode (big-endian, little-endian, then re-encode the winner) as waste [S chdman-simd].

### 1.9 The GD-ROM saga (the most unstable area)

| Release | Step |
|---|---|
| 0.144 | GDI input |
| 0.146 | GDI processing corrected, `CHGT`, extract to GDI |
| 0.154 | Audio byte-swapped, `CHGD`; all SHA1s change |
| 0.206 | GDI 2048 extraction fix |
| 0.227 | Redump multi-cue input, normalised to the TOSEC layout |
| 0.262 | "Don't strip GD-ROM pregaps", which prompted [#11903](https://github.com/mamedev/mame/issues/11903) |
| 0.263 | Regression "does not compress dreamcast games" ([#12081](https://github.com/mamedev/mame/issues/12081)) |
| 0.264 | Refactor |
| 0.265 | Redump-style cue output and `--splitbin` |
| 0.272 | Parser rewrite |
| post-0.289 | `--removepregap/--addpregap` (#15808), then removed, with GDI virtual pregaps (#15870) |

The post-0.289 author's rationale is "cue↔gdi reversibility" ([#15808](https://github.com/mamedev/mame/pull/15808)). He also maintains [MAMERedump](https://github.com/MetalSlug/MAMERedump), a DAT project whose README admits *"You will need to re-compress any Mame CHDs that don't match since 0.263"*.

The dc.xml software-list hashes were **not** updated alongside the post-0.289 change (git log of `hash/dc.xml`) [V]. So CHDs made with the post-0.289 GDI code will not match MAME's own Dreamcast list [V inference from the SHA1 change].

### 1.10 Error-handling and hardening work, 2024–2026

- **0.263:** chdman validation overhaul (5731492874) [V].
- **0.271:** API moved to `std::error_condition` (AJR, Vas Crabb) [V]. It broke delta-CHD creation, which was then hacked around in 0.276 (#13029) [V].
- **2026 (post-0.289), Heath/simzy39, AI-assisted with explicit disclosures in the commit messages** [V]:

| PR | Change | Outcome |
|---|---|---|
| #15889 | modern C++ in `util/chd` | merged |
| #15893 | size and range checks; byte-wise zero-hunk test; reject zero hunk or unit sizes; 64-bit parent units | merged |
| #16044 | extractcd read errors | merged |
| #16045 | dumpmeta stdout errors | merged |
| #16077 | AVHuff channel limit | merged (build fix by AJR) |
| #15902 | short writes | **reverted**: "util::write correctly deals with … This is "AI"-generated rubbish" |
| #16043 | raw input read errors, zero-padding the last hunk | **reverted**, with a five-point rationale ending "He is not capable of addressing TODO or FIXME items" |
| #15901 | validate compressed hunk lengths | open |
| #15904 | non-zero exit code when verify fails | open |
| #15905 | preserve extra CD INDEXes | open |

  - Lesson: upstreaming needs tight, well-reasoned patches; the maintainer rejects speculative hardening.

### 1.11 People and pace

**Top authors of commits touching CHD, chdman or cdrom code, by era** [V git shortlog]:

| Period | Commits | Top authors |
|---|---|---|
| 2007–2011 | 86 | Aaron Giles 49, R. Belmont 16 |
| 2012–2014 | 111 | Oliver Stöneberg 27, Miodrag Milanovic 27, R. Belmont 21, Aaron Giles 19 |
| 2015–2019 | 99 | Milanovic 37, Vas Crabb 14, MetalliC 9 |
| 2020–2023 | 61 | Vas Crabb 20, AJR 15, Olivier Galibert 8 |
| 2024 → 2026-09 | 51 | Vas Crabb 20, Heath 7, MetalSlug 5, AJR 5, "987123879113" 5 |

**Commits per year:** 2012: 66, 2013: 27, 2014: 18, 2015: 30, 2016: 49, 2017: 7, 2018: 5, 2019: 8, 2020: 13, 2021: 13, 2022: 14, 2023: 21, 2024: 26, **2025: 4**, 2026: 21 (19 of them in Jul–Sep).

**Roles:**
- **Creator:** Aaron Giles (V1–V5, the codecs, the chdman rewrite).
- **CD, cue and FLAC:** R. Belmont (arbee), with D. Haywood (Haze) behind the FLAC, LZMA and CD-FLAC ideas.
- **GD-ROM:** MetalliC; later 987123879113 and MetalSlug.
- **DVD:** O. Galibert.
- **Current gatekeeper:** Vas Crabb (cuavas). R. Belmont still merges some PRs.
- **Downstream reader:** libchdr is maintained by Romain Tisserand (rtissera).

---

## 2. Upstream issues, PRs and bug reports

MAME's GitHub issue tracker is small; most emulation bugs go to MAME Testers. The GitHub API for mamedev was not usable from this session, so I read the web UI and did not see full timelines.

### 2.1 Open or recent GitHub issues about chdman and CHD

| # | Title (date) | State | Notes |
|---|---|---|---|
| [2517](https://github.com/mamedev/mame/issues/2517) | chdman creates different metadata since 0.176, mismatches the XML hashes (2017-07) | **open** | Voyeur II (CD-i): 0.175 SHA1 `9dfffd67…` vs 0.187 `1890d51e…`; metadata 91 → 93 bytes (`PGSUB:RW` → `PGSUB:NONE`) |
| [10308](https://github.com/mamedev/mame/issues/10308) | CHD does not store CD track indexes from cuesheet (2022-09) | **open** | INDEX 02+ lost (purikura); PR [#15905](https://github.com/mamedev/mame/pull/15905) is open |
| [12095](https://github.com/mamedev/mame/issues/12095) | createcd fails on input paths with accents on Windows (2024-03) | **open** | third-party GUIs route around it with ASCII staging paths |
| [12805](https://github.com/mamedev/mame/issues/12805) | CHD CD images do not retain CD-TEXT (2024-09) | **open** | |
| [12806](https://github.com/mamedev/mame/issues/12806) | CHD CDs not reproducible between 2048 B and 2352 B images of the same data (2024-09) | **open** | an ISO and a regenerated raw bin give different CHDs |
| [15529](https://github.com/mamedev/mame/issues/15529) | CHD CD images do not retain CATALOG (2026-06) | **open** | |
| [16186](https://github.com/mamedev/mame/issues/16186) | CHDMAN doesn't output byte-identical .cue sheets (2026-09) | closed as dup of #10308 | CATALOG, INDEX 02 and CRLF lost |
| [15214](https://github.com/mamedev/mame/issues/15214) | Split-track extraction omits `REM SESSION` (2026-04) | closed | MIL-CD Dreamcast (Dux); session support in #15886 post-0.289 [U linkage] |
| [13650](https://github.com/mamedev/mame/issues/13650) | extractcd corrupts audio tracks with a "wrong" extension (2025-05) | closed **wontfix** | any extension other than `.cue` or `.gdi` selects TOC mode, which writes CD-DA unswapped (big-endian) [V code] |
| [13608](https://github.com/mamedev/mame/issues/13608) | extractcd on Linux writes cue/gdi without CR (2025) | closed completed | |
| [13048](https://github.com/mamedev/mame/issues/13048) | chdman leaves trailing garbage in the last hunk (2024-12, schellingb) | closed | behaviour still present at the pin [V]; fix PR #16043 reverted |
| [13029](https://github.com/mamedev/mame/issues/13029) | creating a delta CHD with a large parent errors | closed 2025-11 | 0.276 hack 65c263749e |
| [12605](https://github.com/mamedev/mame/issues/12605) | createdvd writes corrupt CHDs on CIFS (2024-07) | closed 2026-02 | no root cause published [S] |
| [12143](https://github.com/mamedev/mame/issues/12143) | chdman 0.263 "Bad CHD-file" for PSP (2024-03) | closed not planned | 4 KiB DVD hunks vs PPSSPP |
| [12081](https://github.com/mamedev/mame/issues/12081), [11903](https://github.com/mamedev/mame/issues/11903) | Dreamcast regressions 0.262/0.263 | closed | fixed by #12087 / #11913 |
| [15801](https://github.com/mamedev/mame/issues/15801) | Update embedded LZMA SDK (2026-07, brad0) | closed | wanted for FreeBSD/OpenBSD aarch64 builds; led to 26.02 **and the level change** |
| [7402](https://github.com/mamedev/mame/issues/7402) | CHD improved compression (zstd) (2020-10) | closed | shipped in 0.262 |

### 2.2 Open or recent PRs and discussions

**Open PRs:**
- [#15901](https://github.com/mamedev/mame/pull/15901) validate compressed hunk lengths;
- [#15904](https://github.com/mamedev/mame/pull/15904) failing exit code when verify fails;
- [#15905](https://github.com/mamedev/mame/pull/15905) preserve extra CD INDEXes;
- [#13282](https://github.com/mamedev/mame/pull/13282) "Minimize tools-only build";
- [#11252](https://github.com/mamedev/mame/pull/11252) PSX CHD hash updates (since 2023; see also closed #11224 on softlist hash churn, where angelosa warns about `.toc` data loss when bulk re-converting);
- [#11145](https://github.com/mamedev/mame/pull/11145) convert old CDTV CHDs to v5 (draft);
- [#10222](https://github.com/mamedev/mame/pull/10222) formal CHD spec (draft, chyyran);
- [#7788](https://github.com/mamedev/mame/pull/7788) Python integration tests for tools (2021).

**Closed but relevant PRs:**
- [#7594](https://github.com/mamedev/mame/pull/7594) automatic recursive parent search for chdman (2020 → closed 2023);
- [#2834](https://github.com/mamedev/mame/pull/2834) chdman access to physical drives on Windows 10.

**Discussions** (mamedev org):
- [#89 "Official CHDMAN GUI"](https://github.com/orgs/mamedev/discussions/89) and #90 poll. cuavas: a "wizard" UI would suit it; *"the chdman code is pretty dire"*; *"The only parts of chdman you'd actually need … are the compressor classes"*; a front-end is *"something that could be handled well by someone outside the team"*.
- #130 "chdman for folders".
- #138 static tool builds.
- [#163](https://github.com/orgs/mamedev/discussions/163) prefer zstd, FLAC or Huffman unless LZMA wins by more than 5.6 %, for decode speed (no replies).
- [#188](https://github.com/orgs/mamedev/discussions/188) CD/DVD auto-switch. galibert: *"there's no visible difference between a dvd dump and a 2048bytes/sector cd dump"*; angelosa suggests "SKU reverse database lookup".
- #71 Android build.
- #96 Zarchive → answer: zstd is in 0.262.
- #282 / [#290](https://github.com/orgs/mamedev/discussions/290) compiling only chdman (MSYS2, **WebAssembly**). The WASM asker points to their own project RetroShrink.

### 2.3 MAME Testers (chdman)

| ID | Summary | Status |
|---|---|---|
| [04709](https://mametesters.org/view.php?id=4709) | chdman random deadlocks (2012) | **Acknowledged / open** |
| 04707 | createcd from GDI not working (2012) | historical |
| [04728](https://mametesters.org/view.php?id=4728) | LD CHDs fail verify after V5 copy | fixed 0.145u8 |
| [04864](https://mametesters.org/view.php?id=4864) | v4 → v5 conversion fails (FLAC leak) | fixed 0.146u1 |
| 05008 / 05079 | "file not writeable" on create / addmeta | historical |
| [05522](https://mametesters.org/view.php?id=5522) | CD-FLAC doesn't work for GDI (`CHGT` vs `CHT2`) | fixed 0.154 |
| [05535](https://mametesters.org/view.php?id=5535) | extractcd doesn't produce proper PCE bins (regression 0.146 → 0.153) | **Confirmed / open** (last touched 2023) |
| [06561](https://mametesters.org/view.php?id=6561) | chdman "incorrect" HD geometry | not a bug |

These show three recurring themes: threading hangs (2012–2016), extraction fidelity, and GD-ROM handling.

---

## 3. Community pain points and feature requests

**Method:**
- I queried the Pullpush Reddit archive for 16 queries. 219 unique posts matched "chd/chdman"; the non-emulation "CHD" hits were filtered out. Raw data is in `research/E/reddit/*.json`.
- Pullpush coverage is thin before about 2024, so recent years dominate.
- I added GitHub issues, emulator docs and forum pages.
- Reddit links are given as `reddit.com/r/<sub>/comments/<id>`.

### 3.1 Speed and time to convert a library

- **"Realizing that it is worth it to convert PS1/PS2 to lossless .chd has been terrible"** ([r/SBCGaming 1q7hgvz](https://reddit.com/r/SBCGaming/comments/1q7hgvz/), 2026-01, 66 comments). A Mac user relying on a chdman *website* complains it "is not a fast process" (PS1 175 → 80 GB; PS2 900 GB). The replies mostly offer shell loops or say "download sets already in CHD".
- The history explains the "slow" reputation:
  - chdman defaulted to at most 4 threads: on Windows from 0.155, everywhere in 0.173–0.238;
  - extraction and verify are single-threaded;
  - LZMA level 8/9 is costly.
- Faster third-party tools advertise their speed: chdman-simd, RomVault's parallel scanner, CHDSharp's parallel encoder.
- Wishes: use all cores, batch jobs in parallel (tochd `-p`, GNU parallel recipes in [r/EmulationOnAndroid 1ayhjxl](https://reddit.com/r/EmulationOnAndroid/comments/1ayhjxl/)), and fast-decode presets.

### 3.2 createcd vs createdvd (PS2, PSP) is confusing

**PSP:**
- PPSSPP added CHD in 1.17 (January 2024) and warns about CHDs whose hunk is not 2048: *"No other hunk size than 2048 makes sense"* ([ppsspp#18803](https://github.com/hrydgard/ppsspp/pull/18803)).
- The official docs say *"Preferably, don't use the createcd or createraw commands"* ([docs](https://dev.ppsspp.org/docs/getting-started/dumping-games/)).
- CD-mode PSP CHDs perform badly ([r/SBCGaming 1owku2k](https://reddit.com/r/SBCGaming/comments/1owku2k/)).
- Users hit "Data size … is not divisible by sector size 2048" when re-converting CD-mode CHDs ([1ij2jwv](https://reddit.com/r/SBCGaming/comments/1ij2jwv/)).
- Users cannot get ISOs back with extractdvd ([r/MAME 1sfevyo](https://reddit.com/r/MAME/comments/1sfevyo/)).
- MAME 0.263's switch to 4 KiB DVD hunks broke PPSSPP files ([#12143](https://github.com/mamedev/mame/issues/12143)).

**PS2:**
- AetherSX2 and NetherSX2 cannot read DVD CHDs ([NetherSX2-patch#37](https://github.com/Trixarian/NetherSX2-patch/issues/37), [1i2ko8d](https://reddit.com/r/EmulationOnAndroid/comments/1i2ko8d/), [1qzfzh7](https://reddit.com/r/EmulationOnAndroid/comments/1qzfzh7/)).
- Guides therefore still say "use createcd" or "`createdvd -c zlib`" and wrongly blame zstd as the "default" ([Retro Game Corps guide](https://retrogamecorps.com/2023/02/06/the-ultimate-rom-file-compression-guide/)).
- The real default is `lzma,zlib,huff,flac` [V]. The likely cause is AetherSX2's pre-2023 libchdr, which knows no `DVD ` tag [U].
- RetroAchievements hashing of DVD CHDs failed in RetroArch ([RetroArch#19040](https://github.com/libretro/RetroArch/issues/19040), 2026; earlier #18005, #16145).

**Auto-detection:**
- Requested upstream ([discussion #188](https://github.com/orgs/mamedev/discussions/188)); galibert says a 2048-byte CD dump is indistinguishable from a DVD dump.
- tochd uses a 750 MB threshold in `-m auto`.
- **A Redump database lookup (media type per serial and size) is the only exact answer**, and Discpress already ships that database.

### 3.3 Dreamcast: GDI vs Redump cue, and verification

- Before 0.227, CHDs from Redump cues would not boot in Flycast ([flycast#960](https://github.com/libretro/flycast/issues/960)).
- Users still ask which input to use ([1ch3y0k](https://reddit.com/r/Roms/comments/1ch3y0k/)).
- Users get multiple CHDs per game ([1938mbg](https://reddit.com/r/Roms/comments/1938mbg/)).
- Users cannot reproduce Redump bins and cue from a Dreamcast CHD, even though PS1/PS2 work with binmerge ([r/MAME 1m8czs1](https://reddit.com/r/MAME/comments/1m8czs1/)).
- Nobody can find a DAT matching a Dreamcast "CHD-ZSTD" set, even with MAMERedump DATs ([r/Roms 1u3xwz2](https://reddit.com/r/Roms/comments/1u3xwz2/), 2026-06).
- Weak devices stutter with DC CHDs ([ManicEMU 1nn5tb9](https://reddit.com/r/ManicEMU/comments/1nn5tb9/), [RGCubeXX 1vdorlw](https://reddit.com/r/RGCubeXX/comments/1vdorlw/): "Games that were jittery as CHD are now smooth" after going back to GDI).
- The post-0.289 GD-ROM rework (§1.9) will **change the hashes again**.

### 3.4 extractcd output does not match Redump

Reasons [V code, S reports]:
1. **Single bin by default.** Redump uses one bin per track, so users need `--splitbin` (0.265+) or binmerge.
2. **Cue text is regenerated.** CATALOG, INDEX 02+, CD-TEXT, ISRC, REM lines and some FLAGS are lost; line endings too ([#10308](https://github.com/mamedev/mame/issues/10308), [#12805](https://github.com/mamedev/mame/issues/12805), [#15529](https://github.com/mamedev/mame/issues/15529), [#16186](https://github.com/mamedev/mame/issues/16186), [#13608](https://github.com/mamedev/mame/issues/13608)).
3. **Byte-swapped audio** when the output extension isn't `.cue` ([#13650](https://github.com/mamedev/mame/issues/13650) wontfix; [r/MAME 4drv74](https://reddit.com/r/MAME/comments/4drv74/) from 2016, where R. Belmont diagnoses it).
4. **GD-ROM layout** conversions (§1.9).
5. **LibCrypt subchannel.** Redump SBI isn't stored; users keep `.sbi` files beside the CHD (a 2026 tool automates the downloads: [psx-sbi-downloader](https://github.com/cylfox/psx-sbi-downloader)).

Workarounds:
- [verifydump](https://github.com/j68k/verifydump): extract, then compare "essential structure"; the original cues can be supplied.
- DuckStation's built-in "Verify" shows Redump track hashes computed from the CHD ([1f5svqe](https://reddit.com/r/Roms/comments/1f5svqe/)).
- The 2021 thread asking for a ROM manager that can hash CHDs "as if they were BIN/CUE" ([lwdhef](https://reddit.com/r/Roms/comments/lwdhef/)) is now answered by RomVault 3.6 and igir.

### 3.5 No batch mode and no GUI

- There are dozens of GUIs and scripts (§4.1). namDHC is the most popular (636★), launched on r/emulation in 2022 "to help anyone who hates having to write windows batch files" ([tdo7qm](https://reddit.com/r/emulation/comments/tdo7qm/)).
- [r/MAME 4xwpkt](https://reddit.com/r/MAME/comments/4xwpkt/) (2016): "CHDman is the biggest headache … documentation is so sparse".
- Upstream: discussions #89 and #130; cuavas says this belongs outside the team.

### 3.6 Missing input formats and fragile input parsing

- chdman `createcd` reads only `.cue`, `.toc`, `.gdi`, `.nrg` (experimental) and `.iso`/`.cdr`/`.toast` [V code]. The cue parser accepts only `BINARY`, `MOTOROLA` (byte-swapped) and `WAVE` file types [V code].
- Users want (evidence: [BatchConvertToCHD](https://github.com/purelogiccode/BatchConvertToCHD) implements every one of these as pre-conversion steps):

| Group | Wanted inputs |
|---|---|
| Disc images | CDI (DiscJuggler Dreamcast), **MDS/MDF/MDX**, **CCD/IMG/SUB**, PBP (single and multi-disc), CSO/ZSO/CISO, ISZ, ECM |
| Audio tracks in cues | MP3, and APE/FLAC [U for APE/FLAC] |
| Containers | zip, 7z, rar and split volumes |

- Robustness failures users hit (BatchConvertToCHD documents a workaround for each):
  - a UTF-8 **BOM** in the cue breaks chdman's parser ("couldn't find bin file []");
  - Shift-JIS and CP949 cue encodings;
  - `.raw` audio needs `-us 2352`;
  - non-ASCII paths and MAX_PATH on Windows ([#12095](https://github.com/mamedev/mame/issues/12095));
  - **chdman truncates the output file before it can fail**, destroying an existing good CHD of the same name;
  - illegal-instruction crashes of AVX2-built binaries on old CPUs.

### 3.7 Multi-disc and m3u

- CHD is one disc per file.
- Libretro guidance is to write an `.m3u` listing the CHDs ([libretro docs](https://docs.libretro.com/library/beetle_psx_hw/)). Duplicates in frontends remain a nuisance ([r/R36S 1wr34r8](https://reddit.com/r/R36S/comments/1wr34r8/), [1rdyrsy](https://reddit.com/r/EmulationOnAndroid/comments/1rdyrsy/)).
- New tools exist just for this ("M3U Organizer", [1qgfi0n](https://reddit.com/r/RetroArch/comments/1qgfi0n/)).
- PBP's multi-disc container is the one thing people miss.

### 3.8 Hunk-size folklore

- MAME devs on larger hunks ([r/MAME xnh53i](https://reddit.com/r/MAME/comments/xnh53i/)):
  - MameHaze: *"larger hunk sizes will introduce more 'microstutter' … for anything making a lot of small random accesses it will also have a severe negative effect"*.
  - arbee37 (R. Belmont): *"Larger hunks give better compression ratios, but make actually reading the data more expensive."*
- Users ask for "the BEST settings" and cite conflicting wiki advice ([1q22jbm](https://reddit.com/r/Roms/comments/1q22jbm/)).

### 3.9 "CHD not supported by emulator or loader X"

- **No CHD support:**
  - Dolphin, xemu, Xenia, RPCS3 (a 2026 launcher adds CHD for these by *mounting* CHDs through Dokan: [Simple Launcher](https://reddit.com/r/emulation/comments/1s5vpfc/));
  - PS3 webMAN PSX needs bin/cue ([1qvz1n3](https://reddit.com/r/ps3homebrew/comments/1qvz1n3/));
  - PS2 OPL needs ISO ([1stzkg7](https://reddit.com/r/Roms/comments/1stzkg7/)).
- **Partial or problematic:** AetherSX2 and NetherSX2 (DVD CHDs); some handheld cores ([PicoDrive on 3DS](https://reddit.com/r/3dspiracy/comments/1s1p1s6/), [MiyooMini PSX](https://reddit.com/r/MiyooMini/comments/1tlhd84/)).
- **Recent adoptions:** PPSSPP 1.17 (2024); [Ymir](https://reddit.com/r/emulation/comments/1l1e6rp/) (Saturn, 2025).
- The per-emulator matrix is in lanes D1/D2.
- **Implication:** users need both CHD → ISO/cue *and* CHD creation.

### 3.10 zstd CHDs and older readers

- The zstd request came in 2020 (#7402); MAME shipped it in 0.262 (2024-01); libchdr got a zstd codec on 2024-01-31 (Zakk, PR #106) [V git].
- Readers catch up slowly:
  - PPSSPP updated libchdr ([ppsspp#18824](https://github.com/hrydgard/ppsspp/pull/18824));
  - PCSX2 feature request [#10823](https://github.com/PCSX2/pcsx2/issues/10823);
  - RetroArch [#16193](https://github.com/libretro/RetroArch/issues/16193);
  - as late as 2026-03, cdzs CHDs fail in SwanStation builds ([RetroArch#18867](https://github.com/libretro/RetroArch/issues/18867));
  - MiSTer supports it ([forum](https://misterfpga.org/viewtopic.php?t=8219)).
- Community "CHD-ZSTD" re-encodes are sometimes **larger** than LZMA sets ([1gb70uj](https://reddit.com/r/Roms/comments/1gb70uj/): "lzma at max setting generally compresses stronger than zstd … 2-5%"), and they break DAT matching (§3.3).
- Wish: compatibility presets ("max compatibility", "fast decode", "smallest").

### 3.11 Parent/child confusion and hash drift

- Parent (delta) CHDs are a MAME feature. libchdr only gained parent support in 2020 (SleepyMan), and MAME's automatic parent search PR (#7594) was never merged.
- Delta creation broke in 0.271 and was hacked around in 0.276 (#13029). Mismatched hunk or unit sizes are rejected since 0.263.
- Users mostly meet this indirectly, as MAME software-list hash mismatches after chdman changes: #2517; the "hash updates" PRs #9385, #11224, #11252; the MAMERedump README.

### 3.12 Verification

- `chdman verify` only re-hashes against the CHD's own SHA1s.
- Real needs:
  - verify against Redump or No-Intro DATs by track;
  - verify without temporary files;
  - verify quickly.
- Tools that do it:
  - ClrMamePro compares header SHA1s and delegates deep checks to chdman ([docs](https://mamedev.emulab.it/clrmamepro/docs/htm/scanner.htm));
  - RomVault 3.6: built-in, 3–4× faster ([release](https://www.emulationrealm.net/news/multiple-platform/romvault-v3-6-0-released)); it still has an open request to fix CHD contents against Redump DATs ([request](https://romvault.convas.io/requests/ability-to-scanfix-chd-contents-against-a-redumporg-dat-cl7dv8vkc125763124q30jejxf7t));
  - igir: native;
  - RomM wants CHD hash matching ([romm#2241](https://github.com/rommapp/romm/issues/2241)).

### 3.13 Distribution lag and lossy demand

- **Distro packages lag:** Debian bookworm ships 0.251 (no createdvd); Ubuntu users have 0.242 ([r/MAME 1q9ajya](https://reddit.com/r/MAME/comments/1q9ajya/)).
- **Some users want lossy audio** for space: a browser chdman with "FSLAC (~450 kbps)" ([1lvey56](https://reddit.com/r/SBCGaming/comments/1lvey56/), sets like "PSXLA" on archive.org). That is anti-preservation, but it shows how far space pressure goes.

---

## 4. Third-party tools around chdman

Last-commit dates come from shallow clones on 2026-09-27 [V]. Stars come from the GitHub search API [V].

### 4.1 GUIs, wrappers and batch tools

| Tool | Platform / language | What it adds | Last commit | Status |
|---|---|---|---|---|
| [namDHC](https://github.com/umageddon/namDHC) (636★) | Windows, AutoHotkey | batch create, extract, verify and info; parallel jobs; GDI/cue/ISO/TOC/IMG; needs `chdman.exe` beside it | 2026-04-04 (v2.0.0) | maintained, slow. Retro Game Corps notes batch timeouts and advises turning off parallel jobs |
| [tochd](https://github.com/thingsiplay/tochd) (183★) | Linux, Python ≥3.10 | ISO, cue, GDI and 7z/zip/rar in; `-m cd/dvd/auto` (auto = 750 MB threshold); `-p` parallel; AUR | 2024-06-08 | quiet |
| [BatchConvertToCHD](https://github.com/purelogiccode/BatchConvertToCHD) (40★) | Windows x64/ARM64, .NET 10 | the most complete input coverage (§3.6); content sniffing; safe staging so it never destroys an existing CHD; disk-space preflight; bundled chdman with a CHDSharp fallback; verification | 2026-09-26 | very active |
| [CHDlite](https://github.com/DesertDoggy/CHDlite) (33★) | C++ on MAME code, AGPL | GUI plus CLI, drag and drop, auto media and system detection, "SIMD-optimized codecs", content-aware codec choice (zstd for data, FLAC for audio), many hash types | 2026-05-07 | alpha |
| [CHDroid](https://github.com/Ottavio97/CHDroid) (118★) | Android app | on-device CHD creation, GDI support, recursive search; ad-supported | 2026-05-26 (v1.1.0, "first non-beta") | active |
| [Pipetto-crypto/Chdman](https://github.com/Pipetto-crypto/Chdman) (24★) | Android port | work in progress | 2025-01-10 | stalled |
| Swift-CHD, CHDForge, CHD-Boy, XtoCHD, GUI2CHD, UltraCHD, chd-maid, CHDMAN-Batch-Tools, game-converter (zenity), Docker-chd-converter, ps-chd-toggle (chdman + binmerge), chdtool, EmuDeck "compression tool" | various | GUIs and batch scripts, often adding auto-system detection or m3u generation | 2024–2026 | many new in 2025–26 |
| [chdman-js](https://github.com/emmercm/chdman-js) / npm `chdman` | Node | wrapper plus prebuilt chdman for 9 platforms (`@emmercm/chdman-*`), version 0.289.0 | 2026-09-01 | maintained |
| [MAMERedump](https://github.com/MetalSlug/MAMERedump) | DATs | Redump sets as CHD DATs; "Most CHDs were built with chdman 0.233"; "PSP ISOs need a hunksize of 2048"; "re-compress any Mame CHDs that don't match since 0.263" | 2026-09-08 | active (author also rewrote GD-ROM in chdman) |
| [verifydump](https://github.com/j68k/verifydump) | Python | verify CHD/RVZ against Redump DATs by converting back; tolerant cue comparison; `--extra-cue-source` | 2026-07-26 | active |
| [Simple Launcher](https://reddit.com/r/emulation/comments/1s5vpfc/), [CHDMounter](https://github.com/purelogiccode/CHDMounter) | Windows | mount a CHD as a virtual drive (Dokan/WinFsp) so emulators without CHD (xemu, Xenia, RPCS3, Cxbx) can use them | 2026 | new trend |

**ROM managers and CHD:**
- **ClrMamePro:** compares the CHD header SHA1 (MAME DATs carry only SHA1s). Since v4.03 deep validation just calls chdman ([docs](https://mamedev.emulab.it/clrmamepro/docs/htm/scanner.htm)) [S].
- **RomVault 3.6:** built-in reader for all CHD versions and codecs; "a regular scan will now fully decompress and hash"; 3–4× faster than chdman [S]. Matching CHD *contents* against Redump track DATs is still a feature request [S].
- **igir:** now reads CHDs through `packages/chdman`, a Node-API addon compiled from **MAME at the 0.289 tag f34f02505e** ("A recreation of MAME's chdman tool") [V repo]. Its docs say native CHD v1–5 reading and extraction without temp files, with SHA1 checksums [S].
- **RomM:** hash matching for CHD is an open request ([#2241](https://github.com/rommapp/romm/issues/2241)); it uses Hasheous [S].

### 4.2 Forks and ports of chdman

- **Standalone builds:**
  - [charlesthobe/chdman](https://github.com/charlesthobe/chdman) (51★, CMake build of MAME's chdman sources for Termux; archived; last 2025-06-16);
  - ddCeka/chdman;
  - Termux installers;
  - [chdman-container](https://github.com/queeup-containers/chdman-container) (2026).
- **Performance fork [chdman-simd](https://github.com/grouik1er-coder/chdman-simd)** (2026-03, based on 0.286):
  - pipelined reader, SIMD SHA1 and CRC16, LZMA asm decoder, zlib-ng, persistent LZMA encoder handles, and FLAC without the third encode;
  - claims −71 % on a 131 MB LZMA-heavy CHD;
  - **no byte-identity claim**; zlib-ng deflate output differs from zlib [V].
- **Browser and WebAssembly ports** (direct Discpress competitors):

| Port | Details |
|---|---|
| [chdman-web](https://github.com/Thysbelon/chdman-web) (Thysbelon, 2026-05) | MAME **0.287**, "did not modify any of chdman's code"; hosted at thysbelon.github.io/chdman-web |
| romtools.io / chdman.com "CHD Compressor" (2025-07/09) | WASM chdman plus an optional lossy "FSLAC" audio mode; r/emulation post had 252 points ([1n8fznl](https://reddit.com/r/emulation/comments/1n8fznl/)); **romtools.io no longer resolves (2026-09-27)** [V] |
| [chd.emulationonline.com](https://chd.emulationonline.com) "CHD Creator" (2026-01) | cue/bin only; "uses a lot of memory"; built for PicoStation ([1qdyn1v](https://reddit.com/r/emulation/comments/1qdyn1v/)) |
| RetroShrink (Kelvao, 2026) | emscripten pipeline; mentioned in [discussion #290](https://github.com/orgs/mamedev/discussions/290) |
| [psp-toolkit](https://github.com/jamescook/psp-toolkit) | single-file browser tool for CSO/ZSO/ISO/PBP |

  - One user complains that the web chdman they used on Mac was slow ([1q7hgvz](https://reddit.com/r/SBCGaming/comments/1q7hgvz/)).
  - Discpress's multi-core helper-worker design is a clear differentiator.
- **"chdman-mt":** no project by that name found [V search]; parallelism is upstream since V5.
- **"CHD v6":** none (§1.3).

---

## 5. Alternative CHD implementations

| Implementation | Language / licence | Read | Write | Versions | Codecs | Notes |
|---|---|---|---|---|---|---|
| **MAME lib/util** (chd, chdcodec, cdrom, dvdrom, harddisk, avhuff, flac, huffman) | C++, BSD-3-Clause (all these files [V]) | ✔ | ✔ | V3–V5 read, V5 write | all 10 | the reference; cuavas: "isolated pretty well … relatively easy to integrate" |
| **[libchdr](https://github.com/rtissera/libchdr)** (Romain Tisserand, since 2017-07) | C, BSD-3 | ✔ | ✗ | V1–V5 | zlib (miniz since 2026-02), LZMA (26.02), Huffman, FLAC (dr_flac; optional "micro-flac" 2026-09), **zstd since 2024-01-31** (PR #106, Zakk), cdzl/cdlz/cdfl/cdzs, **AVHuff (2026-08)** | parent/clone since 2020-12 (SleepyMan); precache (2020); v3/v4 hunk CRC checks, sparse V5, LOWRAM and **MCU targets** (2026); 198 commits in 2026 [V git]. Embedded by most emulators (DuckStation, PCSX2, PPSSPP, Flycast, libretro cores, MiSTer Main) [S] |
| **[chd-rs](https://github.com/SnowflakePowered/chd-rs)** (chyyran) | Rust, BSD-3 | ✔ | ✗ ("no plans to implement write-operations into rchdman") | V1–V5 (V5 best tested) | all incl. zstd/cdzs and AVHuff | libchdr-compatible C API (`chd-rs-capi`); within 1 % of libchdr with `max_perf`; last commit 2026-06-29 [V] |
| chdr-rs, chdr_cs, allyourcodebase/libchdr (Zig), play-switch-libchdr | Rust / C# / Zig bindings or forks | ✔ | ✗ | via libchdr | via libchdr | wrappers |
| **[CHDSharp](https://github.com/purelogiccode/CHDSharp)** (2026-07) | C#, MIT (vendored FLAC, LZMA, zstd) | ✔ | **✔** | V1–V5 | all 10 incl. AVHuff | claims **byte parity with chdman 0.289** ("the last chdman byte-parity gaps are closed"; 7.8 GB corpus; "3174/3174 battle tests against MAME 0.289"); deterministic multithreaded encoder; parent chains [S, unverified]. Used by BatchConvertToCHD and CHDMounter |
| **igir `packages/chdman`** | TypeScript and C++ Node-API | ✔ | ✔ (it is MAME code) | as MAME 0.289 | as MAME 0.289 | pinned to the **official 0.289 tag** [V] |
| **RomVault** built-in reader | C# | ✔ | ✗ | "all CHD versions and compression" | all | parallel [S] |
| pychd | Python binding to chdman | via chdman | via chdman | — | — | 0★ |
| Others | — | — | — | — | — | Redream (closed source) reads CHD [S]; triforce-iso-extract (FIX94) reads Triforce CHDs [S]. No maintained pure-Go or pure-JavaScript reader or writer found (npm and GitHub search) [V]; go-chd is only a wrapper |

**Takeaway:**
- Reading CHD is commoditised: libchdr and chd-rs.
- Writers other than chdman are rare. Only CHDSharp is a true independent writer, and it chases byte parity with a *specific* chdman version. That shows exactly the drift problem of §1.6.
- For a Discpress fork, the CHDSharp claims are a useful cross-check oracle once verified.

---

## 6. Competing compressed disc-image formats

### 6.1 Comparison table

| Format | Scope | Compression | Random-access unit | Parallel decode | Dedup | Parent/child | Metadata | Integrity | Lossless vs dump | Main support |
|---|---|---|---|---|---|---|---|---|---|---|
| **CHD V5** | CD, GD-ROM, DVD, HD, LD | up to 4 codecs chosen **per hunk** (zlib, LZMA, Huffman, FLAC, zstd; CD variants strip sync/ECC and code subcode separately; AVHuff) | hunk (CD 19,584 B = 8 sectors; DVD/HD 4 KiB default) | yes (independent hunks) | identical hunks → self-references; zero hunks | **yes** (delta CHDs per unit) | tagged, extensible (TOC, GD, DVD, HD geometry, A/V) | data SHA1 plus overall SHA1 (data+metadata), CRC16 per hunk in the map | data yes; cue text (CATALOG, INDEX 02+, CD-TEXT) no | MAME, libchdr users (most modern emulators), MiSTer |
| **RVZ** (Dolphin, 2020) | GC, Wii | zstd (default level 5), LZMA/LZMA2, bzip2, none; **"RVZ packing" of pseudo-random junk**; Wii partitions stored **decrypted**, with hash "exceptions" | chunk ≥32 KiB, power of two (Dolphin prefers 128 KiB) | yes | **identical groups reused** (`TryReuse`) | no | disc/partition structs | SHA-1 of header structs; Wii hashes recomputed and patched with exceptions | yes (bit-perfect ISO back) | Dolphin, DolphinTool ([spec](https://github.com/dolphin-emu/dolphin/blob/master/docs/WiaAndRvz.md)) [V source] |
| WIA (wit) | GC, Wii | bzip2, LZMA, LZMA2, purge | chunk = multiple of 2 MiB | yes | — | no | as RVZ | as RVZ | yes | wit, Dolphin |
| GCZ | GC, Wii | zlib per block | 16 KiB fallback, 128 KiB preferred | yes | no | no | minimal | per-block hash of decompressed data | yes, but junk and encrypted Wii data barely compress | Dolphin (legacy) [V source] |
| NKit | GC, Wii | junk/update removal (+ zip/7z) | — | — | — | — | — | restore checked against Redump | *restorable*, not standalone lossless [S] | NKit tool |
| CSO v1 (CISO) | PSP (and PS2) ISO | raw deflate per block | block (usually 2048) | yes | **no** ("reordering or deduplication … not supported") | no | none | **none** | yes | PSP CFW, PPSSPP, PCSX2 [S]; `maxcso` ([format](https://github.com/unknownbrackets/maxcso/blob/master/README_CSO.md)) |
| CSO v2 / **ZSO** | PSP, PS2 ISO | deflate or LZ4 per block (ZSO = LZ4) | block | yes | no | no | none | none | yes | maxcso; PS2 loaders and emulators [U exact list] |
| DAX / JSO | PSP ISO (legacy) | zlib 8 KiB blocks plus "NC areas" / LZO [U] | block | yes | no | no | none | none | yes | legacy; maxcso reads DAX, and its README says "Avoid DAX" |
| **PBP** (PS1 "EBOOT") | PS1 on PSP, Vita, PS3 | deflate per **0x9300-byte (16 raw sectors) block**, with index | 37,632 B | yes | no | no | PARAM.SFO, icons, **multi-disc (up to 5 [U]) in one file** | none [U] | data yes; subchannel / LibCrypt and audio handling vary by tool [U] | POPS, DuckStation, PCSX-ReARMed, Beetle PSX [S] |
| **ECM** (+7z / RAR; APE/FLAC/TTA audio with a cue) | CD | removes regenerable sync/EDC/ECC, then general-purpose (often solid) compression | none (stream) unless playable wrappers | no | via the archiver | no | cue only | archive CRCs | **yes** (exact bins) | archival; some emulators read `.ecm` or FLAC-in-cue [U] |
| CUE/BIN in 7z/zip | CD | solid LZMA or deflate | none (extract first) | no | solid | no | cue | CRC32 per file | exact Redump files | storage only; some frontends auto-extract |
| CDI (DiscJuggler) | Dreamcast CD-R rips | none | sector | — | — | — | track table | none | often **not a full dump** ("content cut to fit a gdrom into a cd" [S r/emulation kveusa]) | Flycast, Redream |
| NRG (Nero) | CD | none | sector | — | — | — | track table | none | yes | chdman experimental import |
| MDS/MDF (Alcohol), MDX (Daemon) | CD/DVD (PC) | none / MDX compressed [U] | sector | — | — | — | **subchannel, DPM (copy protection)** | none | the most complete for protected PC discs | PC tools, some emulators |
| CCD/IMG/SUB (CloneCD) | CD | none | sector | — | — | — | full TOC plus **96-byte subchannel** | none | yes incl. subchannel | Mednafen, DuckStation [U] |
| zisofs ("ZF") | ISO 9660 filesystems | per-file zlib inside the filesystem | per file block | — | — | — | — | — | changes the image, **not a dump container** | Linux kernel |
| xiso | Xbox | none (strips the video partition) | sector | — | — | — | — | — | not a full Redump image | xemu |
| **CCI** (Cerbios) | Xbox | per-sector **LZ4** plus index, self-contained split parts | sector | yes | no | no | — | — | converts back to Redump ISO (Repackinator) | Cerbios BIOS only; xemu request [#1809](https://github.com/xemu-project/xemu/issues/1809) [S] |

### 6.2 Why CHD won the retro scene

1. **One file for any disc, including CD-DA and multi-track.**
   - Formats that cover only data do not compete (CSO, WBFS, xiso).
   - PBP is PS1-only.
   - ECM archives are not playable in place.
2. **Free, cross-platform, "official" tooling.** chdman ships with every MAME build, and the format is MAME's own.
   - The BSD relicensing of lib/util (2009) let emulators embed the code.
   - libchdr (2017) made adoption a drop-in job; DuckStation, PCSX2, PPSSPP, Flycast, libretro cores and MiSTer all use it.
3. **Good ratios without losing random access.**
   - Per-hunk best-of-4 codec choice.
   - CD-specific ECC stripping (an ECM-like transform built in) and FLAC for audio.
   - LZMA for data.
   - Zero and duplicate hunk elimination.
4. **Integrity built in.**
   - SHA1 over the data and over data+metadata; CRC16 per hunk.
   - MAME software lists identify CHDs by SHA1.
5. **Network effects.**
   - Pre-converted CHD sets are distributed widely: users "just download sets already in CHD" ([1q7hgvz](https://reddit.com/r/SBCGaming/comments/1q7hgvz/)).
   - EmuDeck ships a CHD "compression tool" ([1owlzgc](https://reddit.com/r/Roms/comments/1owlzgc/)).
   - RetroAchievements hashes CHDs.
   - A 2021 r/emulation thread summed it up: "Always use CHD if supported" ([kveusa](https://reddit.com/r/emulation/comments/kveusa/)).

### 6.3 Where the other formats beat CHD

- **Console-specific modelling (RVZ).** RVZ strips Wii encryption and regenerates hashes, and it packs the pseudo-random junk that GC/Wii discs are full of.
  - These are *semantic* transforms; generic LZMA cannot find that redundancy.
  - It also offers zstd levels, large chunks (128 KiB), reuse of identical groups, and a multithreaded converter.
  - CHD's closest analogue is CD ECC stripping; it has nothing for DVD-era discs.
- **Simplicity and hardware support (CSO, ZSO, CCI).** Trivial decoders (LZ4) run on real PSPs, PS2 loaders and modded Xbox BIOSes; CHD runs on none of these consoles (MiSTer being FPGA).
  - maxcso shows a format-preserving trick CHD could copy: **try several encoders for the same bitstream** (zlib, 7-Zip deflate, Zopfli, libdeflate) and keep the smallest. The output stays fully compatible, but its bytes change.
- **Multi-disc containers (PBP).** One PBP holds up to five discs; CHD needs `.m3u` files.
- **Exact dump fidelity:**
  - cue/bin (+ECM/7z) keeps Redump's exact files and cue;
  - MDS/MDF and CCD/SUB keep subchannel and protection data;
  - CHD loses cue-level metadata (CATALOG, INDEX 02+, CD-TEXT, ISRC) and has contested GD-ROM layouts.
- **Pure archival ratio.** Solid 7z of ECM'd bins beats per-hunk compression, because the dictionary is not reset every 19 KB [U, not measured here].

### 6.4 What CHD, or a Discpress fork, could learn

**Without breaking V5 readers:**
- **Better encoders:** LZMA parameters, Zopfli or libdeflate for zlib hunks, better FLAC settings, maxcso-style multi-encoder trials. These change the output bytes, but every V5 reader still decodes them.
- **Decode-speed-aware codec choice**, for example the #163 threshold idea, or a preference for zstd when it is within x % of LZMA.
- **Hunk-size presets per platform:** PSP 2048; fast-seek profiles for weak devices.
- **New metadata tags** (old readers ignore unknown tags [V: libchdr looks up tags by name]):
  - the verbatim original cue or GDI and the Redump descriptor;
  - CD-TEXT, CATALOG, ISRC, extra INDEXes, sessions;
  - per-track CRC32, MD5 and SHA1, for DAT matching without decompression;
  - dump or tool provenance.

  Caution: any metadata changes the overall SHA1 (as #2517 showed), so this must be opt-in.

**Needing format or reader changes** (think hard before doing any of these, because each fragments the ecosystem):
- console-specific transforms such as RVZ's (DVD-era junk, Mode-2 Form-2 EDC);
- multi-disc containers;
- larger dictionaries shared across hunks, such as zstd dictionaries;
- stronger hashes than SHA1.

---

## 7. Implications for a Discpress fork

### 7.1 Fix the byte-identity story first (highest priority)

**Where things stand:** Discpress markets "chdman 0.289" and "byte for byte … as desktop chdman 0.289". Its committed pin and the released v1.2.0 are built from 76c7d19.

**Update at the end of this session (about 22:00):** the Discpress working tree showed *uncommitted* changes re-pinning to `f34f02505e` (the mame0289 tag):
- `scripts/fetch-mame.sh`, `wasm/*` and `third_party/mame` now at the mame0289 tag;
- a new `tests/ui/gdrom.spec.js`.

This is option (a) below. A native build of that tree matched my 0.289 build on all 9 fixtures [V].

I checked the committed claim against 0.289 (§1.7):
- The claim **fails for every LZMA-bearing CHD**, which means every default CD, DVD and HD CHD. Only the file bytes differ; the SHA1s match.
- The claim **fails for GD-ROM content hashes**.

**Options (choose explicitly and document):**

| | Option | What to do | Trade-off |
|---|---|---|---|
| a | **Match released 0.289** | Pin to `mame0289` (f34f02505e) plus Discpress's patch, or keep the snapshot and revert three things:<br>• `props.level = 8` in `chd_lzma_compressor::configure_properties` (one line; this alone makes the pin byte-identical to 0.289 for all non-GD fixtures [V end-to-end])<br>• the post-0.289 GD-ROM changes (1cf0f9e986, ac47a71ce1), or make them opt-in<br>• zstd 1.5.5 for `-c zstd/cdzs`, or accept the drift (non-default codecs) | matches what users compare against: MAME softlists, igir, CHDSharp, chdman-js 0.289.0 binaries |
| b | **Track master and relabel** | Call it "chdman 0.290-dev (76c7d19)" and update the README, help text and release notes | exposes users to upstream churn; e.g. level 6 has no benefit for CHDs [V], and GD-ROM hashes change |
| c | **Own the output** | Define "Discpress CHD output v1" as a documented, frozen profile with golden hashes. Offer a "chdman-0.289-compatible" mode for verification | the fork's real long-term answer |

**Report upstream:**
- The LZMA level change is almost certainly unintended. Its commit message says "to keep the same dictionary size", but `reduceSize` already clamps the dictionary to the hunk size at levels 6–9, so the only effect is fb and mc [V].
- An issue with the §1.7 numbers would be well received. It is a precise, non-AI bug report.

### 7.2 Build a drift-proof test net

- **Golden-hash corpus** covering:
  - every codec path: cdlz, cdzl, cdfl and cdzs forced individually; lzma, zlib, huff, flac, zstd;
  - CD audio, including INDEX 00 pregaps; GD-ROM from GDI and from Redump cue;
  - DVD with **odd sector counts** (stale-tail trap);
  - multi-session, CD+G, HD templates, parent/child.
- **Cross-oracles:**
  - native builds at `mame0289` and at the pin;
  - chdman-js 0.289.0 binaries;
  - igir's addon at the 0.289 tag;
  - CHDSharp (claims parity).
- **Canary tests for library bumps** (the §1.7 harnesses are ready to reuse):
  - LZMA and FLAC bumps have changed bytes (0.255, 0.262), so any bump needs a re-baseline;
  - zlib bumps have been safe so far.
- Pin the **build flags**: no system zlib or FLAC, no zlib-ng; FLAC intrinsics are fine per the tests.

### 7.3 Features users want most (ranked by evidence volume)

1. **Batch and folder conversion with safe defaults**, plus progress and parallel jobs. This is Discpress's core; keep leaning in.
   - Add "never overwrite a good CHD" staging (chdman truncates first).
   - Add disk-space preflight.
2. **Automatic CD vs DVD choice and PSP hunk 2048.**
   - Discpress already does PSP → 2048 [V `app/ui.js`] and has the Redump DB.
   - Extend it to PS2: the Redump media type decides createcd vs createdvd. This is the "SKU lookup" upstream said is the only reliable way.
3. **Broader input:**
   - CDI (with a warning: often not a full dump), MDS/MDF/MDX, CCD/IMG/SUB, PBP (multi-disc → several CHDs plus `.m3u`), CSO/ZSO, ISZ, ECM;
   - archives (zip/7z/rar), split volumes;
   - MP3/FLAC/APE audio in cues (decode to PCM, warning that the result is not Redump-exact);
   - BOM and codepage-tolerant cue parsing; auto-generated cues for bare bins.
4. **Redump-faithful round trip and verification:**
   - per-track split output by default when the source was split;
   - keep and re-emit the original cue (as an opt-in metadata tag, or a sidecar);
   - verify CHD contents against the built-in Redump DB per track, without extraction, the way DuckStation's "Verify" does.
5. **Compatibility presets:**
   - "Max compatibility": no zstd; CD mode for AetherSX2-class targets; warn about DVD CHDs on old cores.
   - "Fast decode": zstd, or LZMA only when much better.
   - "Smallest".
6. **Multi-disc `.m3u` generation** and consistent naming (Discpress already names from Redump).
7. **CHD → ISO/cue for places without CHD**: PS3 webMAN, OPL, ODEs, AetherSX2.
8. **Speed:** keep the multi-core lead.
   - Remove chdman's serial bottlenecks (reader, SHA1).
   - Drop the third FLAC encode (chdman-simd's idea), which keeps the output unchanged.
   - Beware of anything that changes the bytes, e.g. zlib-ng for *compression*.
9. **Nice to have:** CD-TEXT, CATALOG and INDEX preservation (upstream #10308/#15905); multi-session; MSU-style uses.

   Lossy audio (FSLAC) is demanded by some users, but it conflicts with the preservation brand; keep it out or clearly separate it.

### 7.4 Lessons from history

- **Upstream changes output casually and without tests.**
  - The regression tests date from 2015.
  - Output-changing PRs were merged without review discussion (#15870).
  - Library bumps are made for build reasons (#15801, BSD aarch64) and carry output changes along with them (LZMA level).
- **Small default changes hurt the ecosystem for years:**
  - default 4-thread cap (Windows from 0.155, every platform 0.173–0.238);
  - DVD hunk 4096 (0.263) vs PPSSPP;
  - `PGSUB` (0.176) vs softlists, still open;
  - createdvd vs AetherSX2;
  - zstd vs pre-2024 libchdr.
- **The GD-ROM layout has flip-flopped about six times.** Treat GD-ROM as a policy decision (TOSEC vs Redump layout) exposed to users, not as an implementation detail.
- **Readers lag writers by years:** zstd was requested in 2020, written in 2024, and in 2026 still breaks some cores.
  - Any new codec, metadata or hunk-size default in a fork must ship with a compatibility matrix and a conservative default.
- **Maintainer culture:** upstream welcomes precise fixes but reverts speculative or AI-generated hardening. A hard fork gives freedom, but still report the upstream bugs found (level 6, stale tail, #2517).

### 7.5 Risks

- **Version drift** (§1.6):
  - *which* chdman do users compare with? Official Windows, distro (system FLAC or zlib), npm, igir, MAME softlists;
  - the post-0.289 snapshot already diverges;
  - the next MAME release (0.290) may or may not keep level 6 and the GD-ROM rework [U].
- **Hidden non-determinism:**
  - the stale last-hunk tail depends on `WORK_BUFFER_HUNKS` and the read chunking. Any pipeline rewrite, such as a streaming reader in the browser, will change the bytes unless it is replicated deliberately (Discpress reuses chdman's loop today, so it matches);
  - Huffman tie-breaking and allocator contents were issues before 0.147/0.148 and are fixed; keep the tests.
- **Reader compatibility:** zstd/cdzs, DVD metadata and new tags such as `CHSE` can be unreadable or ignored by old libchdr builds.
- **Legal:** the chd, chdcodec, cdrom, dvdrom, flac, huffman, avhuff and chdman sources are all BSD-3-Clause (Aaron Giles, R. Belmont) [V]. MAME as a whole is GPL-2.0+. Keep attributions, and avoid using the "MAME" name for the fork.
- **Hash-database churn:** Redump moved to **redump.info** (2026-06-20) ([announcement](https://forum.redump.info/viewtopic.php?t=66358); MAME bulk-updated its softlist links in 1f9afd8937). Discpress's DB pipeline, via libretro-database, may need a new source [U].
- **Competition:** several browser chdman ports appeared in 2025–26 (chdman-web, romtools/chdman.com, chd.emulationonline.com, RetroShrink), plus Android (CHDroid) and desktop GUIs. They are mostly thin wrappers; Discpress's differentiators are multi-core compression, Redump identification and phone UX.

---

## 8. Open questions

1. Will MAME 0.290 ship with LZMA level 6 and the GD-ROM pregap rework, or will they be revised? This decides what "chdman 0.290 compatible" means.
2. Do the official 0.289 Windows and macOS binaries match my Makefile-based native 0.289 build byte-for-byte? I expect yes: LZMA and zlib are integer code, and FLAC intrinsics showed no effect. But it has not been run on real binaries or real game audio.
3. Are the post-0.289 GD-ROM CHDs "more correct" for emulators (Flycast, Redream, MAME dc)? Does MAME's dc.xml plan to re-hash? Real-game tests with the Redump and TOSEC layouts are needed (lane C).
4. Are CHDSharp's byte-parity claims real, including the stale last-hunk tail and GD-ROM? It could become a second oracle.
5. How common is the stale-tail case in real sets (DVD ISOs with odd sector counts; CD logical sizes not a multiple of 8 frames)? Should a fork keep this quirk forever, or offer a "clean" mode that zero-fills?
6. What exactly broke createdvd CHDs in AetherSX2 and NetherSX2 (the `DVD ` tag vs hunk size)? This matters for a compatibility preset.
7. Is FLAC output stable across CPUs for real music? Rounding boundaries in the LPC/autocorrelation paths (SSE, NEON, FMA) were not hit by my synthetic audio.
8. Which distros link system zlib-ng into chdman (e.g. Fedora's zlib-ng-compat) and so emit different zlib hunks? The Debian rules use system zlib and FLAC [S]; the others were not checked.
9. Should Discpress propose an upstream metadata tag for the original cue or Redump descriptor, so round trips become exact? Or keep this as a sidecar to avoid SHA1 changes?
10. Before 0.121: in which version did CD-ROM CHDs first appear? (Whatsnew archives start at 0.100.)

---

## Appendix: artefacts (scratchpad `$SP`)

| Path | Contents |
|---|---|
| `research/E/core-log.txt`, `research/E/libs-log.txt` | per-release git logs of the CHD code and codec libraries |
| `research/E/reddit/*.json`, `fetch_thread*.py` | Reddit archive queries |
| `research/E/whatsnew/`, `research/E/docs/` | MAME whatsnew 0.100–0.120; RVZ spec, Dolphin and maxcso sources, Debian rules |
| `src/mame-E/` | blobless MAME clone (currently checked out at `76c7d19`, sparse) |
| `src/pinL8-E/build/chdman-pin-L6`, `chdman-pin-L8` | pin rebuilt as-is, and with LZMA level 8 |
| `src/codecs-E/v0xxx/`, `src/codecs-E/pin/` | codec library sources exported per release |
| `src/drift-E/` | harnesses `zt.c` (zlib), `lt.c` (LZMA), `ft.c` (FLAC), `zst.c` (zstd), `lasthunk.c` (libchdr last-hunk dump), and corpus generator `gen.py` |
| `src/build289-E/chdman-289`, `chdman-289-L6` | native chdman from the `mame0289` tag, and the same with LZMA level 6 |
| `src/fixtures-E/` | Discpress synthetic fixtures plus the Redump-style GD-ROM `aw.cue`; outputs in `src/e2e-E/` |
| `src/libchdr-E/`, `src/flac15-E/`, `src/zlibng-E/`, `src/tools-E/` | third-party clones used for the checks |
