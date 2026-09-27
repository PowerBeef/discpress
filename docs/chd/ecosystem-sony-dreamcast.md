# D1: CHD support in PlayStation 1/2/Portable and Dreamcast/NAOMI emulators, and in the frontend/tooling layer

> Part of the [Discpress chdman research dossier](README.md), 2026-09-27. Written by a research agent from source reading and experiments. `$SP/...` paths name artefacts in the temporary research workspace, which is not part of the repository (reproducible lab tooling is in [lab/](lab/)). Lane letters (A, B, C, D1, D2, E, G) refer to the reports listed in the README.

Research lane D1 of the Discpress chdman-fork dossier. Date of research: 2026-09-27.

**Scope.** For each emulator, frontend or tool that Discpress users are likely to feed CHDs into (PS1, PS2, PSP, Dreamcast/NAOMI, RetroArch's scanner, RetroAchievements hashing, MiSTer, ES-DE/Batocera conventions), this report records:

- how it reads CHD, and since when;
- which libchdr it uses, with the commit, the date, and whether zstd/cdzs is compiled in;
- which metadata it understands and how it places tracks (pregaps, padding);
- DVD, parent and subcode handling;
- known bugs and the chdman commands each project recommends.

The goal is a compatibility contract for CHDs produced by a Discpress fork of chdman.

**Method.**

- I read the source at the commits listed in Appendix B: sparse, blobless clones in `$SP/src/*-D1`.
- I dated vendored libchdr copies by blob-matching against `rtissera/libchdr` history (`$SP/research/libchdr_blobmap.txt`) or by closest diff.
- I ran experiments with two chdman builds:
  - the system chdman 0.264;
  - Discpress's own native chdman at MAME `76c7d19`, which is 1,167 commits after the `mame0289` tag.
- I built a small tool linked against MAME's own `cdrom_file` (`$SP/research/D1test/tool/toc.cpp`) to see where MAME itself places tracks.
- I used web sources for closed-source projects and for issue trackers.

**Citation style.** `owner/repo@shortsha:path:line`, or a URL. **(unverified)** marks anything I could not confirm from source or a primary document.

---

## 0. Key findings

1. **CRITICAL: Dreamcast CHDs from Discpress's current chdman are not loadable in any released Flycast, and GDI-sourced ones are mis-mastered for every reader, MAME included.**
   - Discpress pins MAME master `76c7d19`, which is after 0.289 and not a release. That tree contains two new GD-ROM changes, made between 2026-07-31 and 2026-08-10:
     - `1cf0f9e986` (mamedev/mame#15808) keeps the Redump INDEX 00 pregaps as `PREGAP:n PGTYPE:V…` in the `CHGD` metadata.
     - `ac47a71ce1` (mamedev/mame#15870) turns the gaps in a `.gdi` into *virtual* pregaps.
   - Every Flycast release up to and including **v2.7 (2026-08-14)** rejects any CHD track with `PREGAP≠0`, `POSTGAP≠0` or `SUBTYPE≠NONE`, with the error "Unsupported subtype or pre/postgap" (`flyinghead/flycast@5aa091f:core/imgread/chd.cpp:184`). Only Flycast master after `0abac34` (2026-09-10) reads pregaps.
   - For `.gdi` input, the new writer double-counts the virtual pregap in the `PAD` before the high-density area. MAME's own `cdrom_file` at the same commit therefore places track 3 at LBA 45150 instead of 45000, and a real-geometry sample at 45428. Flycast master's arithmetic places it identically (§1.5).
   - Release chdman 0.264–0.289 produced a TOSEC-compatible layout (`PREGAP:0` everywhere) that every reader accepts.
   - **Recommendation:** the fork must restore the 0.289 GD-ROM layout, and should report the bug upstream.
2. **Codec floor.**
   - The chdman defaults are readable by everything examined, except AetherSX2/NetherSX2 for DVD CHDs:
     - CD: `cdlz,cdzl,cdfl`;
     - DVD/HD: `lzma,zlib,huff,flac`.
   - zstd/cdzs needs, at minimum:
     - MAME 0.262;
     - DuckStation builds from 2024-02 on;
     - PCSX2 2.0;
     - PPSSPP 1.17.1;
     - Flycast v2.3;
     - RetroArch **1.22.0** for its own scanner and achievement hashing (all cores);
     - a libretro core built with its zstd flag.
   - It is **not** supported by AetherSX2/NetherSX2, by RetroArch ≤1.21, or, probably, by Redream and Demul (unverified).
   - libchdr refuses to open a CHD whose *header* lists an unsupported codec, even if no hunk uses it. Adding zstd to the codec list at all is a compatibility cliff.
3. **createdvd.**
   - PS2 DVD CHDs made with `createdvd` (MAME ≥0.255) work in:
     - PCSX2 (nightlies from April 2023; the 1.7.4610 report of Aug 2023 was still failing);
     - LRPS2;
     - Play! (since 2023-06-30);
     - RetroArch ≥1.22.
   - They do not work in AetherSX2/NetherSX2, which need `createcd`.
   - PSP should use `createdvd -hs 2048`, as PPSSPP's docs say.
   - The `'DVD '` tag is load-bearing for Play! and RetroArch. PPSSPP ignores metadata and uses `unitbytes`/`unitcount`. PCSX2 infers DVD from the absence of CD metadata.
4. **Parent/child CHDs are supported by only five readers:**
   - DuckStation;
   - Beetle PSX (from its 2026 C rewrite);
   - PCSX2;
   - LRPS2;
   - MAME.

   They are not supported by SwanStation, PCSX ReARMed, Play!, PPSSPP, Flycast, MiSTer, or RetroArch's scanner and achievement hashing.
5. **Hunk sizes.**
   - A CD CHD's hunk must be a multiple of 2448 bytes. chdman enforces this; DuckStation, SwanStation, Flycast and MAME check it; the other readers assume it.
   - Non-default sizes work functionally, but there are reports of regressions with extreme sizes: the DuckStation unofficial tracker #183 covers `-hs 1040400`.
6. **Metadata.**
   - Every reader looks tags up by name:
     - `CHT2`, then `CHTR`;
     - `CHGT`/`CHGD` (Flycast only);
     - `'DVD '`.
   - The new `CHSE` session tags are therefore ignored everywhere outside MAME.
   - CD+G, which MAME stores as `TYPE:AUDIO SUBTYPE:RW_RAW`, is tolerated, except by Flycast ≤2.7, which rejects any subtype.
   - Changing type strings or the `CHT2` field list would break `sscanf`-based parsers: DuckStation and PCSX2 require exactly 8 fields, and Beetle PSX accepts only `MODE2_RAW` and `AUDIO`.
7. **RetroArch's scanner identifies CHDs by serial, read from the first data track.**
   - The filename only matters for the `(Disc N)` suffix.
   - The CRC32 fallback covers the stream of the "primary" (largest) data track, which reproduces a Redump track `.bin` byte for byte.
   - For DVD CHDs, the libchdr-based stream includes hunk padding at the end, so its CRC can differ from the ISO's.
8. **Achievement hashing runs in RetroArch itself,** independent of the core's CHD reader.
   - It needs RetroArch ≥1.22 for DVD CHDs and for zstd.
   - Standalone emulators hash through their own readers, so a CHD they refuse cannot be hashed either.
9. **The ecosystem is changing fast in 2026.**
   - RetroArch master now defaults to a clean-room CHD reader (`rchd`, `HAVE_RCHD=yes`) and its own zstd decoder.
   - LRPS2 uses `rchd`.
   - Beetle PSX moved to libretro-common's libchdr with clean-room DEFLATE, FLAC and LZMA decoders.
   - Flycast just gained pregap support.
   - Upstream libchdr had dozens of commits in Sept 2026.

   Discpress's test matrix needs to include these readers, not just upstream libchdr.

---

## 1. Ground truth: what chdman writes, and what changed after 0.289

### 1.1 Metadata tags

Source: `mamedev/mame@76c7d197ed:src/lib/util/chd.h:225-237` and `chd.cpp:47-52`.

| Tag | Meaning | Value (text unless noted) | Written by chdman at 76c7d19 |
|---|---|---|---|
| `CHCD` | legacy CD TOC (v3/v4 era) | binary `METADATA_WORDS` table | never (read only) |
| `CHTR` | CD track, v1 | `TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d` | never (read only) |
| `CHT2` | CD track, v2 | `TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d PREGAP:%d PGTYPE:%s PGSUB:%s POSTGAP:%d` | every CD |
| `CHSE` | **new** session marker | `SESSION:%d` | only if the disc has more than one session (`cdrom.cpp:1115-1124`), placed before the first track of each session |
| `CHGT` | legacy GD-ROM track | same fields as `CHGD` | never (read only; sets the `GDROMLE` flag) |
| `CHGD` | GD-ROM track | `TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d PAD:%d PREGAP:%d PGTYPE:%s PGSUB:%s POSTGAP:%d` | every GD-ROM |
| `'DVD '` | DVD marker | 1 byte (a NUL; measured with `chdman info`) | every `createdvd` (`chdman.cpp:2317`) |

Semantics that readers must know:

- **`PGTYPE` 'V' prefix.** `V<type>` means the pregap frames are stored in the CHD as part of the track and counted in `FRAMES`. A bare type means the pregap is virtual: on the disc, not in the file. The reference is `cdrom.cpp:1100-1110` (writer, `submode[0]='V'` at `:1106`), `:1003-1008` (parser, `if (pgtype[0]=='V')` at `:1005`) and `:274-288` (MAME's placement: `if (pgdatasize == 0) logofs += pregap; else logframeofs = pregap`).
- **Type strings.** chdman maps cue types as follows (`cdrom.cpp` `get_info_from_type_string` at `:644-726` / `get_type_string` at `:841-855`):
  - `MODE1/2048` → `MODE1`;
  - `MODE1/2352` → `MODE1_RAW`;
  - `MODE2/2336` → `MODE2`;
  - `MODE2/2048` → `MODE2_FORM1`;
  - `MODE2/2324` → `MODE2_FORM2`;
  - `MODE2/2352` and `CDI/2352` → `MODE2_RAW`;
  - `AUDIO` and `CDG` → `AUDIO`.

  `MODE2_FORM_MIX` only arises from a literal `MODE2_FORM_MIX` type.
- **Track padding.** Each track is padded to a multiple of 4 frames in storage (`TRACK_PADDING`). The padding is not listed in the metadata.
- **Storage.**
  - Each CD frame is 2448 bytes: 2352 of sector data followed by 96 of subcode.
  - `unitbytes` is 2448.
  - CD audio is stored **big-endian**.
- **Subcode subtypes.**
  - `RW` means cooked, i.e. de-interleaved P–W.
  - `RW_RAW` means raw interleaved.
  - `NONE` means no subcode.
- **CD+G.** New in `c9e87a6b7e` (#15910, 2026-09-22). A cue `CDG` track is stored as `TYPE:AUDIO SUBTYPE:RW_RAW` (`cdrom.cpp:721-725`, `:2611-2631`, and the second cue parser at `:3163-3183`).
- **Session tags.** Written at `cdrom.cpp:1115-1124`; the `write_metadata` call is at `:1118`.

### 1.2 Defaults and limits

Source: `mamedev/mame@76c7d197ed:src/tools/chdman.cpp`.

- **CD codecs:** `cdlz,cdzl,cdfl` (`:673`).
- **DVD/HD/raw codecs:** `lzma,zlib,huff,flac` (`:671-672`, `:2291`).
- **CD hunk:** 8 frames = 19,584 bytes. It must be a multiple of 2448 (`:2208`, `:1360-1361`).
- **DVD hunk:** 4,096 bytes = 2 sectors. It must be a multiple of 2048, and `unitbytes` is 2048 (`:2280`).
- **Hunk bounds:** 16 B to 1 MiB (`:67-68`).
- **`createdvd` and DVD metadata:** added by `28104cdbdf` (2023-04-09), first in `mame0255` according to `git tag --contains`. (A community guide claims 0.262; that is wrong for the command itself.)
- **zstd/cdzs codecs:** `05e69b43e9` (#11827, 2023-12-11), first in **`mame0262`**.

### 1.3 GD-ROM layout history

This matters most for the Dreamcast readers. The history comes from `git log` of `src/lib/util/cdrom.cpp` in the Discpress MAME checkout.

| chdman | Redump `.cue` (INDEX 00 pregaps inside the next track's `.bin`) | TOSEC `.gdi` (gaps not in any file) |
|---|---|---|
| ≤0.261 | Pregaps stripped (MAME issue #6466, 2020: "not bootable in any DC emulator" at the time) | `PAD` frames appended to the previous track |
| 0.262–0.263 | `b75b8d80e87`: "Don't strip pregaps from Redump GD-ROM files" (#11913). Metadata with `PREGAP≠0` (unverified what exactly) | as above |
| **0.264–0.289** | `853db181d2c` (#12087): pregap data **moved into the previous track** (`splitframes`), giving `PREGAP:0` and a TOSEC-identical track layout, with no data lost | `PAD` on the previous track |
| **post-0.289 master (Discpress's pin)** | `1cf0f9e986` (#15808): pregaps kept as `PREGAP:n PGTYPE:V…` | `ac47a71ce1` (#15870): gap becomes `PREGAP:n PGTYPE:MODE1` (virtual) on the next track, **but** the `PAD` before the high-density area is computed from the reduced `physframeofs`, so it also contains those frames (`cdrom.cpp:2297-2316`) |

The `-rp`/`-ap` options existed only between 2026-07-31 and 2026-08-10 and were never in a release.

### 1.4 CD (PS1) path: unchanged

A PS1-style Redump cue with one data track (1001 frames) and two audio tracks with INDEX 00 produces byte-identical metadata from 0.264 and 76c7d19:

```text
TRACK:1 TYPE:MODE2_RAW SUBTYPE:NONE FRAMES:1001 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0
TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:650 PREGAP:150 PGTYPE:VAUDIO PGSUB:NONE POSTGAP:0
TRACK:3 TYPE:AUDIO SUBTYPE:NONE FRAMES:483 PREGAP:150 PGTYPE:VAUDIO PGSUB:NONE POSTGAP:0
```

- MAME places INDEX 01 at LBAs 0, 1151 and 1801.
- In storage, track 2 starts at frame 1004 because of the 4-frame padding.
- The files are in `$SP/research/D1test/ps1`.

A multi-session cue (`REM SESSION 02`, MIL-CD style; files in `$SP/research/D1test/milcd`):

- 76c7d19 adds `CHSE` `SESSION:1` before track 1 and `CHSE` `SESSION:2` before track 3.
- 0.264 writes the same `CHT2` entries without `CHSE`.
- MAME's CHD reader does **not** add a lead-out/lead-in gap; it puts track 3 at LBA 850. The cue's `REM LEAD-OUT/LEAD-IN/PREGAP` values are not stored anywhere.

### 1.5 GD-ROM experiment: where each reader puts the tracks

Synthetic 5-track GD-ROM (files in `$SP/research/D1test/gdi` and `cue`):

- `.gdi`: tracks at LBA 0, 450, 45000, 47150 and 48375.
- The equivalent Redump-style `.cue`: `REM SINGLE-DENSITY/HIGH-DENSITY AREA`, INDEX 00 pregaps of 150, 150 and 225.

Metadata written:

| Source → chdman | Track 1 | Track 2 | Track 3 | Track 4 | Track 5 |
|---|---|---|---|---|---|
| gdi → 0.264 | F450 PAD150 PG0 | F44550 PAD43550 PG0 | F2150 PAD150 PG0 | F1225 PAD225 PG0 | F500 PG0 |
| gdi → 76c7d19 | F300 PAD0 PG0 | F44700 **PAD43700** PG150 `MODE1` | F2000 PG0 | F1000 PG150 `MODE1` | F500 **PG375** `MODE1` |
| cue → 0.264 | F450 PG0 | F44550 PAD43550 PG0 | F2150 PG0 | F1225 PG0 | F500 PG0 |
| cue → 76c7d19 | F300 PG0 | F44700 PAD43550 PG150 `VAUDIO` | F2000 PG0 | F1150 PG150 `VAUDIO` | F725 PG225 `VMODE1_RAW` |

INDEX 01 LBAs as computed by the readers:

- The "MAME" row is from `toc.cpp`, i.e. MAME's own `cdrom_file` at 76c7d19.
- The Flycast rows reproduce `core/imgread/chd.cpp`'s arithmetic.
- "Σ FRAMES" is what RetroArch's `chdstream_get_first_track_sector()` returns, and what a reader that ignores `PREGAP` would compute.

| CHD | Truth | MAME `cdrom_file` | Flycast master (`0abac34`+) | Flycast ≤ v2.7 | Σ FRAMES |
|---|---|---|---|---|---|
| gdi → 0.264 | 0/450/45000/47150/48375 | same ✓ | same ✓ | same ✓ | same ✓ |
| gdi → 76c7d19 | 0/450/45000/47150/48375 | 0/450/**45150/47300/48675** ✗ | 0/450/**45150/47300/48675** ✗ | **REJECT** | 0/**300**/45000/**47000/48000** |
| cue → 0.264 | same | ✓ | ✓ | ✓ | ✓ |
| cue → 76c7d19 | same | ✓ | ✓ | **REJECT** | 0/300/45000/47000/48150 (+ stored pregap = ✓ INDEX 01) |
| `$SP/ref/aerowings.chd` (a CHD in the shared scratchpad written by the same 76c7d19 chdman, most likely from a GDI) | track 3 at 45000 | track 3 at **45428** ✗ | track 3 at **45428** ✗ | **REJECT** | 45000 |

Interpretation:

- The 76c7d19 GDI writer and its own `extractcd` agree with each other; `extractcd` re-emits a correct `.gdi` because `chdman.cpp:1548-1549` adds the pregap non-cumulatively.
- MAME's reader disagrees with both. This is an upstream bug.
- The cue path is self-consistent, but it breaks every Flycast release.

---

## 2. PlayStation (PS1)

### 2.1 DuckStation (`stenzek/duckstation@a2edf2d0f0`, 2026-09-27)

**Reader.** `src/util/cd_image_chd.cpp` (`CDImageCHD`), since 2020-01-30 (`c1c82eb`, "Common/CDImage: Support CHD format").

Other dates, from the GitHub history pages:

- 4-frame alignment: 2020-10-03.
- Precache: 2022-04-03.
- Parent API (`chd_is_matching_parent`): 2023-08-12.

**libchdr.** `dep/libchdr` is DuckStation's own fork.

- `libchdr_chd.c` is closest to upstream `09fa975` (2024-11-02), with 147 lines different.
- `libchdr_huffman.c` is identical to upstream `bc0690b` (2024-10-25).
- DuckStation-only API: `chd_open_file(..., CHD_OPEN_TRANSFER_FILE, ...)`, `chd_is_matching_parent`, `chd_precache_progress`, `chd_get_compressed_size`.
- The subtype enum is renumbered: `dep/libchdr/include/libchdr/cdrom.h:53-55`.
- `CHD_MAX_FILE_SIZE` is 10 GiB.
- **zstd/cdzs is compiled in.** The copy was rebased to upstream `2a1119c` (2024-02-14, which includes zstd) on 2024-02-18, according to the GitHub history.
- `WANT_SUBCODE` is 1 (`dep/libchdr/include/libchdr/chdconfig.h:5-6`).

**Open, hunk and DVD.**

- If the hunk size is not a multiple of 2448, the open fails with "Hunk size (…) is not a multiple of 2448" (`cd_image_chd.cpp:253-259`).
- So DVD CHDs (4096-byte hunks) are rejected. This is irrelevant for PS1.

**Tags and types.**

- It reads `CHT2`, falling back to `CHTR` (`:280-309`). There is no `CHCD`, GD or `CHSE` support.
- Track numbers must be sequential (`:318-324`).
- Unknown `TYPE` strings are a hard error (`:326-332`).
- Supported types: `MODE1`, `MODE1_RAW`, `MODE2`, `MODE2_FORM1`, `MODE2_FORM2`, `MODE2_FORM_MIX`, `MODE2_RAW`, `AUDIO` (`:35-55`).

**Pregaps.**

- `V` with pregap > 0 means the pregap is stored. Otherwise it is virtual.
- A data track with no pregap gets an implicit 150-frame virtual pregap (`:338-375`).
- The file offset is aligned to 4 frames after each track (`:402-403`).

**Audio.** Byte-swapped on little-endian hosts (`:504-506`).

**Subcode and LibCrypt.**

- `RW` maps to Raw and `RW_RAW` maps to RawInterleaved, which is de-interleaved on read (`dep/libchdr/src/libchdr_cdrom.c:33-50`; `cd_image_chd.cpp:419-440`).
- Only the *first* track's subtype decides `HasSubchannelData()` (`:442-446`).
- If there is no in-CHD subcode, `.sbi` or `.lsd` files are loaded (`src/core/cdrom.cpp:966-971`), looked up in this order (`src/core/cdrom_subq_replacement.cpp:122-200`):
  - `<image title>.sbi|lsd` next to the image;
  - `<title>_<n>.sbi` for sub-images;
  - the subchannels folder, by file title, then serial, then title.

**Parent CHDs.** Supported: it scans the same directory for a CHD whose SHA1 matches, recursing up to 32 levels (`:105-233`).

**Precache.** Optional, via `chd_precache_progress` (`:448-472`). Otherwise there is a single-hunk cache.

**Multi-disc.** `.m3u` (`src/util/cd_image_m3u.cpp`).

**Redump verification.**

- `CDImageHasher` computes an MD5 per track over INDEX 00 plus INDEX 01, skipping INDEX 00 for track 1 (`src/util/cd_image_hasher.cpp:60-83`).
- It matches these against Redump data (`src/core/game_database.cpp:1934`).
- This reproduces Redump `.bin` files only when pregaps are stored (`V`), which is what chdman writes for cue input.

**Known issues.**

- unofficial-issue-tracker/duckstation#183 (2024-11-07): "0.1-7851 broke support for CHD created with `createcd -hs 1040400 -c cdlz,cdzs`". It is open and the cause is unknown; it coincides with DuckStation's libchdr security update of 2024-10-25 and the duplicate-codec fix of 2024-11-07.

**Recommended command.** None published. DuckStation's README says it supports CHD, including CHDs with subchannel data.

### 2.2 SwanStation (`libretro/swanstation@b6c30a7b27`, 2026-09-17)

This is a libretro fork of DuckStation from 2021.

**libchdr.** `dep/libchdr`.

- `libchdr_cdrom.c`/`.h` are identical to upstream `2203b5a` (2026-02-07).
- `libchdr_chd.c` is within 47 lines of upstream `ff1365d` (2026-02-11).
- It bundles zstd 1.5.7, lzma 25.01 and miniz 3.1.1, so **all codecs including zstd** are available.
- It is routed through libretro VFS (2026-06).
- When zstd first arrived is not verified; an "Update libchdr" commit dated 2024-03-12 probably brought it.

**Reader.** `src/common/cd_image_chd.cpp`.

- `chd_open_file(..., nullptr)` (`:191`): **no parent support.**
- Optional `chd_precache` (`:201-209`).
- The hunk size must be a multiple of 2448 (`:214`).
- `CHT2`/`CHTR` are parsed with its own tokenizer.
- Pregap handling is the same as DuckStation's (`:307-310`).
- Audio is byte-swapped (`CopyAndSwap`).

**Subcode.** It **does not read CHD subcode** (`// TODO: Read subchannel data from CHD`, `:396`). It uses `<image>.sbi` only, found via `ReplaceExtension` (`:386`; `src/common/cd_subchannel_replacement.cpp:92-95`).

### 2.3 Beetle PSX / Beetle PSX HW (`libretro/beetle-psx-libretro@d50a9d0da3`, 2026-09-27)

Both cores are built from the same code.

**Reader history.**

- CHD support dates from 2017-08-31 (`052a22c`). Beetle PSX is the core libchdr was originally extracted for.
- "CHD Improvements (#950)" landed 2026-03-28.
- The reader was converted to C on 2026-05-06 (`e68da97`, `mednafen/cdrom/CDAccess_CHD.c`).

**libchdr.** Since 2026-07-23 (`1c6d1bf`), Beetle uses libretro-common's libchdr fork (`libretro-common/formats/libchdr`), not upstream.

- zlib hunks go through libretro-common's clean-room DEFLATE (`CHD_USE_BUILTIN_DEFLATE`).
- FLAC goes through `rflac`, and LZMA through `r7z_lzma`.
- zstd goes through `zstddeclib` 1.5.7 (`-DHAVE_ZSTD`).
- References: `Makefile.common:10-25`, `:129-146`.
- **All codecs are available in this build.**

**Parent CHDs.** Supported: same-directory search by SHA1, depth 8 (`CDAccess_CHD.c:358-420`).

**Precache.** The "CD Access Method: precache" option calls `chd_precache` (`:453-457`). The file is otherwise memory-mapped through VFS where available.

**Tags and types.**

- It reads `CHT2`, falling back to `CHTR` (`:474-492`).
- **Only `MODE2_RAW` and `AUDIO` tracks are accepted.** Anything else aborts the load (`:495-503`).
- Accepted subtypes: `NONE`, `RW`, `RW_RAW` (`:505-515`).

**Pregaps.**

- Track 1's pregap is forced to 150 frames, virtual.
- Other tracks: `V` means stored (`pregap_dv`); otherwise the pregap is virtual (`:547-553`).
- Padding is aligned to 4 frames (`:569`).
- **Quirk:** `POSTGAP` is added to the file offset (`:568`), although chdman never stores postgap frames. Redump cues do not produce postgaps, so this is harmless in practice.

**Subcode.**

- If any track has `RW` or `RW_RAW`, the recorded subchannel is used, which covers LibCrypt.
- Otherwise it uses `<base>.sbi`, with the extension's case matched to the image's (`:587+`).

**Multi-disc.** M3U (`libretro.c:5637`).

### 2.4 PCSX ReARMed (`libretro/pcsx_rearmed@ff81ed17a1`, 2026-09-24)

**libchdr.** `deps/libchdr`.

- `libchdr_chd.c` is identical to upstream `9ccd3a7` (2026-08-22).
- `Makefile:316-346` builds the `cdfl/cdlz/cdzl/cdzs/flac/huff/lzma/zlib/zstd` codecs, `zstddeclib` 1.5.7, lzma 26.02 and miniz, so **zstd is available**.
- CHD support has existed since at least 2019–2020 in the libretro fork (exact commit unverified).
- Subchannel support: "cdriso: handle chd subchannels, when available" (`75d5614`, notaz, 2022).

**Reader.** `libpcsxcore/cdriso.c:1022-1105`.

- `chd_open_file(..., NULL)`: **no parent support** (`:1036`).
- Optional `Config.CHD_Precache` (`:1043`).
- `sectors_per_hunk = hunkbytes/2448` (`:1052`); the multiple is not checked. There is a 2-hunk cache.
- It reads `CHT2`, falling back to `CHTR` (`:1076-1079`).
- Track 1 `RW`/`RW_RAW` enables in-CHD subchannel data (`:1085-1090`).

**Pregap and padding bug** (found by reading the code; not run).

- `ti[].start_offset = Σframes + pregap` (`:1094-1102`).
- It does **not** check `PGTYPE`: every pregap is assumed to be stored.
- It does **not** add CHD's 4-frame padding.
- CD-DA of track N is therefore read Σpad frames early, i.e. 0–3 frames for each preceding track (`:1799-1805`).
  - In the §1.4 sample, track 2's data is at storage frame 1004+150 = 1154, but ReARMed reads from 1151.
  - The early frames usually fall inside the silent pregap, but the end of each track is truncated by the same amount.
- Data reads use the LBA directly as the CHD frame (`:1693-1712`), which is only valid for track 1.
- A CHD with virtual (non-`V`) pregaps would be misread.

### 2.5 Other PS1 emulators

- **PCSX-Redux** (`grumpycoders/pcsx-redux@264f2a6865`):
  - **no CHD support.** `src/cdrom/` handles bin/cue, ccd, ecm, mds, pbp, sbi and toc.
  - Request grumpycoders/pcsx-redux#546 (2021-07-30) was "Closed as not planned".
- **Mednafen standalone:**
  - no CHD. The docs list only CUE, CCD/IMG/SUB and TOC.
  - An unofficial fork, "mednafen-chd", adds it.
- **Rustation-ng:** BIN/CUE only.
- **RustStation** (Prodigy75000): claims pure-Rust CHD support with all CD codecs, zstd included (unverified; see the web search results).
- **ePSXe:** no CHD (unverified, old closed software).
- **MiSTer PSX:** see §6.3.

---

## 3. PlayStation 2

### 3.1 PCSX2 (`PCSX2/pcsx2@36907f4b70`, 2026-09-27)

**History** (from the GitHub history pages):

- CHD support: 2021-03-23 (`0599e67`), in 1.7 nightlies. PCSX2 1.6 has no CHD support.
- Threaded reader: 2021-07.
- libchdr bumped for DVD CHDs: 2023-04-12.
- Rebased to upstream `2a1119c`, bringing **zstd**: 2024-02-20, so zstd is in PCSX2 2.0 (July 2024).
- Precache via `core_file`: 2024-12-18.
- libchdr updated to `7891cbe` (2026-02-05): 2026-03-11. `libchdr_chd.c` is blob-identical to upstream `a200d77`, dated 2026-02-02.

**Reader.** `pcsx2/CDVD/ChdFileReader.cpp`.

- **Parent CHDs are supported**: same-directory search matching MD5 or SHA1, 32 levels (`:234-365`).
- It is a threaded chunk reader in which one chunk is one hunk (`:412-441`).
- The block size is `unitbytes` (`:385`): 2448 for CD CHDs, 2048 for DVD CHDs.
- ISO detection tries 2048, 2336, 2352 and 2448-byte blocks (`pcsx2/CDVD/InputIsoFile.cpp:272-309`).
- The file size comes from `CHT2`/`CHTR` of **track 1 only** (`:457-522`; the code says "PCSX2 doesn't currently support multiple tracks for CDs", `:504`).
- DVD CHDs have no track metadata, so the size falls back to `unitbytes*unitcount`, with a "Failed to parse CHD TOC" warning (`:390-398`).
- The `'DVD '` tag is not consulted.
- Legacy `createcd` CHDs of PS2 DVD ISOs work: MODE1 data sits at the start of each 2448-byte unit. This is common community practice.

**Known issues.**

- PCSX2/pcsx2#9771 (2023-08-11, 1.7.4610): `createdvd` CHDs gave "chd_open return error: unsupported format". This is libchdr refusing a header codec, probably `huff`. Later libchdr updates fixed it, but the exact fix is unverified.
- PCSX2/pcsx2#4318: "CHD images not working" (2021).

**Recommended commands.** The community and Batocera say `createcd` for PS2 CD games and `createdvd` for DVD games; `createdvd` gives "7–10% gain" (Batocera wiki). There is no official PCSX2 docs page with a command (unverified).

### 3.2 LRPS2: the libretro PS2 core (`libretro/ps2@d8b86efdf6`, 2026-09-27)

This is ES-DE's default PS2 emulator (ES-DE `USERGUIDE.md:5008`).

- It has **replaced libchdr** with libretro-common's clean-room `rchd` (`pcsx2/CDVD/ChdFileReader.cpp`).
- The build enables `HAVE_RCHD_DEFLATE`, `HAVE_RCHD_LZMA`, `HAVE_RCHD_FLAC` and `HAVE_RCHD_ZSTD` (`Makefile.common:628-653`).
- The build comment documents an earlier bug: before those flags were set, images opened, reported a correct TOC, and then "refused every 'cdfl' and 'cdzs' hunk".
- **Parent CHDs are supported** through `rchd_parent_sha1_matches`, same directory (`ChdFileReader.cpp:207-257`).
- It reads DVD CHDs; rchd synthesizes a single track for them.

### 3.3 Play! (`jpd002/Play-@83700b2c31`, 2026-09-03)

**libchdr.** The `deps/libchdr` submodule points at `jpd002/libchdr@284e38b` (2025-06-24): upstream `8bba774` (2025-06-08) plus one commit, "Remove file size check". **zstd is included.**

**History.** CHD support appears in late 2022 or early 2023; the earliest visible commit is from 2023-01. DVD CHDs arrived on 2023-06-30 (`40e49e5`).

**Reader.** `Source/discimages/ChdImageStream.cpp`, `ChdCdImageStream.cpp`.

- `chd_open_core_file(..., nullptr)`: **no parent support** (`ChdImageStream.cpp:14`).
- Reads must not cross a hunk boundary (`assert`, `:65`).

**CD.**

- Only **`CHT2`** is read (`ChdCdImageStream.cpp:58`). Old `CHTR` CHDs fall through to "assuming MODE1 CD" (`:129`).
- Types: `AUDIO`, `MODE1_RAW`, `MODE2_RAW`, otherwise MODE1.
- Pregaps are **ignored**: a track starts at its first stored frame.
- 4-frame alignment is handled (`:112`).
- Audio ranges are byte-swapped.

**DVD.** It requires the **`'DVD '` tag** (`:122`) and `unitbytes` of 2048 (asserted). Without the tag it assumes a 2448-byte CD.

### 3.4 AetherSX2 / NetherSX2 (closed source)

- AetherSX2 is a discontinued PCSX2-derived Android emulator.
- NetherSX2 is a binary patch of AetherSX2 builds 4248 and 3668 ("Classic") (`Trixarian/NetherSX2-patch` README).
- **`createdvd` CHDs are not recognized.** Reports:
  - Trixarian/NetherSX2-patch#37 (2024-01-03);
  - dragoonDorise/EmuDeck#1128 (2024-03-14);
  - Trixarian/NetherSX2-patch#104 (2024-07-14).
- The workaround is **`createcd`**.
- NetherSX2-patch#104 blames a "zstd default". That is incorrect: `createdvd` defaults to `lzma,zlib,huff,flac` (`chdman.cpp:2291`).
- The likely cause is an old libchdr without `huff` (upstream 2022-12-29) and/or without generic LZMA/FLAC for non-CD hunks (2022-03-26). **Unverified.**
- zstd: certainly not supported.
- Parent CHDs: unknown.

---

## 4. PSP: PPSSPP (`hrydgard/ppsspp@9fc4eb3e4d`, 2026-09-27)

**Versions.** CHD since **1.17** (2024-01); zstd since **1.17.1**.

**libchdr.** The `ext/libchdr` submodule is upstream `8bba774` (2025-06-08), built by `ext/libchdr-build/CMakeLists.txt` against `ext/zstd`, so **zstd is available**.

**Reader.** `Core/FileSystems/BlockDevices.cpp`.

- A CHD is detected by the `MComprHD` magic (`:255-256`).
- `CHDFileBlockDevice` (`:1054-1220`):
  - `chd_open_core_file(..., NULL)` (`:1162`). **Parent support is a commented-out TODO** (`:1111-1157`).
  - Metadata is **ignored**. `blocksPerHunk = hunkbytes/unitbytes`, `numBlocks = unitcount` (`:1173-1174`).
  - Each 2048-byte block is copied from `unit*index` (`:1186-1208`).
  - A `createcd` CHD of an ISO therefore "works": the MODE1 user data is at the start of each 2448-byte unit. It is slow.
  - Single-hunk cache.

**Docs** (<https://www.ppsspp.org/docs/getting-started/dumping-games/>):

- Recommended command: `chdman createdvd -hs 2048 -i game.iso -o game.chd`.
- "In 1.17, a 2048-byte 'hunk' (sector) size was the only option that performed decently (`-hs 2048`), but this was later fixed so it's no longer so critical how you create the CHD."
- Add `-c zstd` optionally: "might perform slightly better".
- "Preferably, don't use the `createcd` or `createraw` commands."

The 1.17 release post says "You MUST use the createdvd command… createcd will work but there will be severe performance problems", with an editor's note that this was fixed in 1.18.1.

**Issues.**

- hrydgard/ppsspp#18798 (2024-01-31): CHD performance.
- hrydgard/ppsspp#18925 (2024-03-13): a performance-warning heuristic flagged zstd CHDs; fixed for 1.18.0 by #18931.
- hrydgard/ppsspp#18679 and libretro/RetroArch#18005 (2025-06-10): RetroArch 1.21 could not hash `createdvd` CHDs for achievements. RetroArch 1.22 fixed it by adding DVD support to `chd_stream`.

---

## 5. Dreamcast / NAOMI

### 5.1 Flycast (`flyinghead/flycast@ea087b9140`, 2026-09-26; releases v2.2–v2.7)

The standalone emulator, the libretro core (which uses the same `core/imgread/chd.cpp`) and Flycast Dojo (which uses older code; unverified) share this reader.

**libchdr.** The `core/deps/libchdr` submodule points at `flyinghead/libchdr`.

| Flycast | libchdr gitlink | zstd |
|---|---|---|
| v2.2 (2023-10-27) | `925400c` | no |
| v2.3 (2024-03-15) | `7239eab` | **yes** |
| v2.4 (2024-10-21) | `9b6ff6c` (upstream 2024-07-12) | yes |
| v2.5 (2025-05-06), v2.6 (2026-01-07), v2.7 (2026-08-14), master | `5f82799` (2025-04-02; upstream `cb07733` 2024-12-11 plus a patch) | yes, zstd 1.5.6 |

**Reader.** `core/imgread/chd.cpp`.

- `chd_open_file(fp, CHD_OPEN_READ, nullptr, ...)` (`:118`): **no CHD parent support.**
  - For NAOMI, "parent" means the parent romset folder: it looks for `<romset>/<gdrom>.chd` and then the parent romset's folder (`core/hw/naomi/gdcartridge.cpp:511-526`).
- The hunk size must be a multiple of 2448 (`:132-135`).
- Tag lookup order: `CHT2`, then `CHTR`, then **`CHGT`** (legacy, no audio swap), then `CHGD` (`:156-186`).
- Types (`:93-107`): `AUDIO`, `MODE1` or `MODE1/2048`, `MODE1_RAW` or `/2352`, `MODE2` or `/2336`, `MODE2_RAW`, `/2352`, `CDI/2352`.
  - **`MODE2_FORM1/FORM2/FORM_MIX` throw** "track type … is not supported". chdman writes `MODE2_FORM1` for `MODE2/2048` cue tracks and `MODE2_FORM2` for `MODE2/2324`. `MODE2/2336` becomes `MODE2`, which Flycast accepts.
- A GD-ROM needs at least 3 tracks. It warns if the total is not 549,300 frames (`:225-231`).

**Releases up to and including v2.7.**

- The check `if (strcmp(subtype,"NONE") != 0 || pregap != 0 || postgap != 0) throw "Unsupported subtype or pre/postgap"` (`flyinghead/flycast@e698b8a:core/imgread/chd.cpp:184`; same line in the `v2.7` tag) **rejects any CHD with a pregap, a postgap or subcode.** This includes:
  - every chdman ≥0.262 CHD of a Redump MIL-CD (`CHT2 PGTYPE:V…`);
  - CD+G;
  - **all post-0.289 GD-ROM CHDs** (§1.5).
- Reports:
  - flyinghead/flycast#906 (2023-02-03): Redump unlicensed MIL-CDs converted with chdman 0.251.
  - pwnedbygary/DiscCompressor-Pro#9 (2026): "Flycast versions 2.4–2.7 reject CHD files containing track pregaps". That tool now absorbs the next track's pregap into the previous track and tests against the Flycast 2.7 AppImage with chdman 0.289/0.264.

**master since `0abac34` (2026-09-10, "chd: MIL-CD support for images with pregaps").**

- `V` pregaps: `StartFAD = total + pregap`, and the storage offset is advanced by the stored pregap.
- Virtual pregaps take up disc space only.
- Subcode and postgap produce warnings, not errors (`:191-220`).
- CD-ROM (`CHT2`) audio is now byte-swapped, which fixes the MIL-CD audio distortion.
- The MIL-CD heuristic: a multi-track disc that ends with a data track gets a second session at `SESSION_GAP = 11400 - min(lastPregap,150)` (`:244-262`). CHSE tags are not read.
- With this code, cue→76c7d19 GD CHDs are placed correctly, but gdi→76c7d19 GD CHDs are not (§1.5).

**Recommended command.** Community practice is `chdman createcd -i game.gdi -o game.chd`. Flycast's docs were not checked (unverified).

### 5.2 Redream (closed source)

- Its help page (<https://redream.io/help>) says it accepts "GDI, BIN/CUE, CHD or CDI". It recommends converting **GDI** images to CHD, and discourages CDI.
- Its CHD reader, codec set and handling of `CHGD PREGAP≠0` are **unknown**.
- Its last release is old (1.5.0, 2020; unverified), so zstd is very probably unsupported.
- Background: in 2020, mamedev/mame#6466 reported that Redump-cue CHDs were "not bootable in any DC emulator". The community's workaround tool is RedumpCUE2GDI, which converts cue to GDI to CHD.
- **Treat the post-0.289 layouts as at risk until tested.**

### 5.3 Demul (closed source)

- It reads MAME NAOMI, NAOMI2 and Atomiswave GD-ROM CHD sets from the `roms` folder.
- It reads Dreamcast GD-ROM CHDs through the `gdrCHD` plugin (EmuTalk thread 55675: developer MetalliC, 2015-07-29).
- Its last release is from 2018 (unverified), so there is surely no zstd.
- Its pregap handling is unknown.

### 5.4 MAME itself (reference reader, `mamedev/mame@76c7d197ed`)

- It reads every tag listed in §1.1.
- Parents come through the romset. All codecs are supported, zstd since 0.262.
- DVD CHDs are read through `dvdrom_file`.
- **At 76c7d19, MAME's own `cdrom_file(chd_file*)`** (`cdrom.cpp:248-310`) **places tracks from GDI-sourced post-0.289 CHDs 150 frames or more too late** (§1.5). This is an upstream regression from `ac47a71ce1`, and it is in no MAME release yet. The emulation-level impact is inferred, not run.

---

## 6. Frontend and tooling layer

### 6.1 RetroArch database scanner (`libretro/RetroArch@520097d511`, 2026-09-27)

**Flow.** `tasks/task_database.c:951-961`:

1. `task_database_chd_get_serial` (`tasks/task_database_cue.c:2116-2140`) opens `CHDSTREAM_TRACK_FIRST_DATA`, the first non-`AUDIO` track. For CD-i it opens track 1 (`is_chd_file_cdi`, `:2092-2114`).
2. `detect_system` matches a magic table (`:58-75`) against the **track stream**:
   - PS1: `"Sony Computer "` at 0x24F8, a raw 2352-byte sector offset.
   - PS2 CD: `"PLAYSTATION"` at 0x9320 (raw).
   - PS2 DVD: `"PLAYSTATION"` at 0x8008, 2048-byte sectors.
   - PSP: `"PSP GAME"` at 0x8008.
   - Dreamcast: `"SEGA SEGAKATANA"` at 0x10, raw.
3. `detect_ps1_game` (`:288-377`), `detect_ps2_game`, `detect_psp_game` or `detect_dc_game` (`:1047+`) extracts the serial.
4. **`cue_append_multi_disc_suffix`** (`:128-150`) appends `-N` (N = disc − 1) when the *filename* contains `(Disc N)`, `(disc N)`, `(Disk N)` or `(disk N)`. Redump-style names are therefore the expected input.
5. If there is no serial, `task_database_chd_get_crc_and_size` (`:2288-2310`) computes a **CRC32 over the whole stream of `CHDSTREAM_TRACK_PRIMARY`**:
   - the largest non-audio track, by `FRAMES`;
   - for DVD, the synthesized single track.

**Stream semantics.** `libretro-common/streams/chd_stream.c`:

- Frame sizes:
  - `MODE1_RAW` and `MODE2_RAW`: 2352.
  - `MODE1`: 2048.
  - `AUDIO`: 2352, byte-swapped.
  - `MODE2_FORM1`, `MODE2_FORM2` and `MODE2_FORM_MIX`: `unitbytes`, i.e. 2448 including subcode.
  - Plain `MODE2` (2336): 2048, because it falls into the MODE1 branch.

  Both are latent bugs. chdman writes these types only for `MODE2/2048`, `/2324` and `/2336` cue tracks, which do not occur in PS1, PS2 or PSP Redump sets.
  - DVD: `unitbytes`.
- A **stored (`V`) pregap is included in the stream**, so a track stream equals the Redump `.bin` for that track. A virtual pregap is synthesized as zeros (`:629-632`).
- Consequence: the CRC fallback equals the Redump per-track CRC for data tracks.
- DVD in the libchdr build: `frames = totalhunks × sectors-per-hunk` (`:623`), so the stream includes the zero padding of the last hunk.
  - A PS2 ISO with an odd sector count and 4096-byte hunks gives a CRC that is **not** the ISO CRC.
  - Measured: a 21-sector ISO becomes 11 hunks, i.e. 22 sectors.
  - rchd uses `logical_bytes/unit_bytes`, which is exact (`rchd.c:2507`).
- Tags: `CHT2`, `CHTR`, `CHGD`, `'DVD '` (`:100-300`). No `CHGT`, no `CHCD`, no `CHSE`.
- `chd_open(path, READ, NULL, …)` (`:580`): **no parent support.** The rchd path does not bind a parent either.

**Versions.**

| RetroArch | Its own CHD reading (scanner and cheevos) |
|---|---|
| ≤1.21.0 (2025-05-01) | libretro-common libchdr **without zstd**; **no DVD CHD** (`chd_stream.c` has no `DVD` handling; libretro/RetroArch#18005) |
| 1.22.0–1.22.2 (2025-11) | zstd added to libretro-common on 2025-06-21 (`b3b8b1e`), with `HAVE_ZSTD=yes` in `qb/config.params.sh`; DVD CHDs supported |
| master (2026-09) | `HAVE_RCHD=yes`: a clean-room `libretro-common/formats/chd/rchd.c`, with no libchdr compiled; `HAVE_RZSTD=yes` (its own zstd decoder); `qb/config.params.sh:145-152` and `Makefile.common:2197-2345`; the reference zstd was removed on 2026-09-09 (`9516f45`) |

**rchd notes** (`rchd.c:23-120`, `:2463-2580`):

- It reads CHD versions 1–5 and all codecs, each behind its own `HAVE_RCHD_*` flag. It verifies the map CRC-16 and the v3/v4 hunk CRCs, but never the SHA-1.
- Tracks come from `CHTR`, `CHT2` and `CHGD`. `CHGT` and `CHCD` are not used for tracks.
- `PAD` is ignored.
- It rejects metadata whose padded frame total exceeds `logical_bytes`.
- **The `PGTYPE` 'V' meaning is inverted in its variable and comment:** `pregap_stored = (pg[0] != 'V')` (`:2558`). `chdstream_open` also inverts its use (`chd_stream.c:540-549`), so the stream behaves the same as the libchdr path. Any future user of `rchd_track_t.pregap_stored` will get the wrong answer.

### 6.2 RetroAchievements hashing (`RetroAchievements/rcheevos@f87c0de911`)

rcheevos has **no CHD reader**. It calls host `cdreader` callbacks.

**Consoles tried for a `.chd`** (`src/rhash/hash.c:1078-1092`): PS1, PS2, Dreamcast, Sega CD/Saturn, PSP, PS3, PC Engine CD, 3DO, Neo Geo CD, PC-FX.

**Algorithms** (`src/rhash/hash_disc.c`):

- PS1 (`:928-979`): executable name plus the primary executable, from track 1 via `SYSTEM.CNF` `BOOT` or `PSX.EXE`.
- PS2 (`:981-1019`): name plus `BOOT2` ELF, from track 1.
- PSP (`:1021-1069`): `PARAM.SFO` plus `EBOOT.BIN`, from track 1.
- Dreamcast (`:326+`):
  - **track 3's** IP.BIN plus the boot file;
  - otherwise, for MIL-CD, the first data track.

  All file lookups go through ISO9660 using absolute LBAs, translated by the host's "first track sector".

**The RetroArch host** (`cheevos/cheevos.c:1290-1395`):

- It maps `FIRST_DATA`, `LAST` and `LARGEST` to `cdfs` over `chd_stream`.
- `FIRST_OF_SECOND_SESSION`, used for Jaguar CD, is not mapped.
- The first-track-sector is Σ `FRAMES` of the earlier tracks. For track 3 of a GD-ROM that is 45000 in every layout tested (§1.5), so Dreamcast hashing survives even the broken GDI layout.
- **This is independent of the core.** A zstd or DVD CHD that the core can load still gets "hash generation failed" on RetroArch ≤1.21 (libretro/RetroArch#18005).
- libretro/RetroArch#18883 (2026-04-01, UWP/Xbox, 1.22.2): "Could not open track" for all CHDs. Fixed by #18892.

**Standalone emulators** hash through their own disc layers: DuckStation, PCSX2, PPSSPP and Flycast. A CHD the emulator rejects cannot be hashed. The details of each implementation were not verified.

### 6.3 MiSTer FPGA (`MiSTer-devel/Main_MiSTer@5fb9bd1020`, 2026-09-26)

**Shared loader.** `support/chd/mister_chd.cpp`. It is used by:

- PSX, Saturn, MegaCD, PCE-CD, CD-i, 3DO, Minimig CD32/CDTV, Mac and NeXT;
- **Neo Geo CD**, which reuses the MegaCD `cdd_t` (`support/neogeo/neogeocd.cpp:13`).

**libchdr.** `lib/libchdr` is upstream `5fd5165` (2024-02-11) with zlib replaced by miniz, plus warning fixes. The zstd library is compiled in (`Makefile:23-38`), so **cdzs and zstd are available**.

**Behaviour.**

- `chd_open(..., NULL)` (`:35`): **no parent support.**
- It reads `CHT2`, falling back to `CHTR` (`:65-68`). There is no GD or DVD support; MiSTer has no Dreamcast, PS2 or PSP cores.
- Types: `MODE1_RAW`, `MODE2_RAW`, `MODE1`, `MODE2`, `AUDIO`.
- Pregaps (`:79-101`): `V` means stored. A virtual pregap extends the *previous* track's end, which gives correct LBAs.
- 4-frame padding (`:156`).
- Sector addressing assumes `hunkbytes/unitbytes` frames of 2448 bytes (`:12-19`, `:169-186`).

**Subcode.**

- MegaCD and CD-i use in-CHD subcode: `RW_RAW` is passed through raw, and `RW` is re-interleaved (`support/megacd/megacdd.cpp:1000-1020`). The new CD+G CHDs (`AUDIO` + `RW_RAW`) should therefore play as CD+G on MiSTer MegaCD (unverified at runtime).
- **PSX uses SBI**, from `PSX/sbi.zip/<serial>.sbi` or `<image>.sbi` (`support/psx/psx.cpp:763-783`).

**Read-ahead.** PSX and CD-i read ahead by one hunk only if the hunk is ≤16 KiB (`user_io.cpp:3540-3551`; `UIO_BUFFER_SIZE` 16384). The default CD hunk of 19,584 bytes already exceeds this, so the read-ahead does not apply.

**Performance.** The HPS is a dual-core Cortex-A9 at 800 MHz, so decode speed matters. LZMA hunks are the slowest; the cost was not measured here.

### 6.4 ES-DE, Batocera, LaunchBox conventions

**ES-DE** (`USERGUIDE.md` on gitlab `es-de/emulationstation-de` master, fetched 2026-09-27):

- "It's highly recommended to create `.m3u` playlist files for multi-disc images" (`:1305`).
- "Directories interpreted as files", with the example `~/ROMs/psx/Final Fantasy VII.m3u/Final Fantasy VII (Disc 1).chd` … `Final Fantasy VII.m3u` (`:1318-1348`).
- The system table:
  - psx and saturn: ".chd file for single-disc games, .m3u playlist for multi-disc games" (`:5013`, `:5018`);
  - dreamcast: "In separate folder interpreted as a file, with .m3u playlist if multi-disc game" (`:4927`);
  - psp: "Single disc image file" (`:5011`);
  - naomi and naomigd: "Single archive file + .chd file in subdirectory if GD-ROM game" (`:4982-4984`);
  - ps2: LRPS2 by default, with alternatives PCSX2, Play! and AetherSX2 (`:5008`).
- It recommends CHD for disc-based systems in general (`:4851`).

**Batocera** (<https://wiki.batocera.org/disk_image_compression>):

- `chdman createcd -i <game.cue> -o <game.chd>`.
- For DVD systems, use `createdvd`, with a "7–10% gain".
- "If your PAL PS1 game includes a `.sbi` file, keep it alongside the `.chd` file". The conversion does not carry the `.sbi` across.
- CHD is recommended for 3DO, DC, Mega CD, NGCD, PCE-CD, PS1, PS2 (v31+) and Saturn.
- The PS1 page describes `.m3u` files listing the `.chd` discs.

**LaunchBox.** Not researched beyond forum threads; see the open questions.

**Naming consequences.**

- Sidecar lookups are by basename:
  - `.sbi` in DuckStation, SwanStation, Beetle, ReARMed and MiSTer;
  - `.lsd` in DuckStation.
- RetroArch's disc suffix comes from `(Disc N)` in the filename.
- Redump-named CHDs next to Redump-named `.sbi` files work out of the box.

---

## 7. Compatibility matrix

Legend:

- ✓ supported;
- ✗ not supported;
- — not applicable;
- ? unknown;
- "CD" means the reader only handles CD-layout CHDs.

Codec columns list what is compiled into the current source (HEAD), with the first version that had zstd where known. Every libchdr-based reader has `cdzl`, `cdlz`, `cdfl`, `zlib` and `lzma`. The generic `flac` and `huff` codecs matter only for DVD and HD CHDs.

| Target (HEAD date) | CHD since | Reader: libchdr commit/date | zlib/lzma/huff/flac/zstd | cdzl/cdlz/cdfl/cdzs | Metadata understood | DVD CHD | Parent | Subcode | Notes |
|---|---|---|---|---|---|---|---|---|---|
| DuckStation (2026-09-27) | 2020-01-30 | own fork ≈ upstream 2024-11-02 (+DS API) | ✓/✓/✓/✓/✓ (zstd since ~2024-02-18) | ✓/✓/✓/✓ | CHT2, CHTR | ✗ (CD only) | ✓ same dir, SHA1, 32 deep | ✓ in-CHD SubQ (1st track decides), else `.sbi`/`.lsd` | hunk % 2448; implicit 150 pregap on data tracks; Redump track-MD5 verify needs stored pregaps |
| SwanStation (2026-09-17) | 2021 (fork of DS) | ≈ upstream 2026-02-11, zstd 1.5.7 | ✓ all | ✓ all | CHT2, CHTR | ✗ | ✗ | `.sbi` only | hunk % 2448; libretro VFS |
| Beetle PSX / HW (2026-09-27) | 2017-08-31 | libretro-common libchdr fork (2026-07+) + clean-room DEFLATE/rflac/r7z + zstddeclib 1.5.7 | ✓ all (HAVE_ZSTD) | ✓ all | CHT2, CHTR; **types MODE2_RAW/AUDIO only** | ✗ | ✓ (2026) same dir, SHA1, 8 deep | ✓ in-CHD RW/RW_RAW, else `.sbi` | track-1 pregap forced 150; POSTGAP wrongly counted in storage |
| PCSX ReARMed (2026-09-24) | ≈2019–20 (unverified) | upstream 2026-08-22, zstd 1.5.7 | ✓ all | ✓ all | CHT2, CHTR | ✗ | ✗ | ✓ if track 1 RW*, else `.sbi` | ignores PGTYPE and 4-frame padding → CDDA offset by 0–3 frames per preceding track |
| PCSX-Redux | — | — | — | — | — | — | — | — | no CHD (#546 "not planned") |
| PCSX2 (2026-09-27) | 2021-03-23 (1.7) | upstream a200d77 / 7891cbe (2026-02) | ✓ all (zstd since 2024-02-20 → 2.0) | ✓ all | CHT2, CHTR (track 1 only); DVD inferred | ✓ (since 2023-04; #9771 still failing Aug 2023) | ✓ same dir, MD5/SHA1 | — | chunk = hunk; `createcd` of DVD works |
| LRPS2 (2026-09-27) | ? | **rchd** (clean-room, 2026) | ✓ all (after the 2026 flag fix) | ✓ all | CHTR, CHT2, CHGD, 'DVD ' | ✓ | ✓ | — | ES-DE default PS2 core |
| Play! (2026-09-03) | ~2022–23 | jpd002/libchdr 2025-06-24 (upstream 2025-06-08) | ✓ all | ✓ all | **CHT2 only**; 'DVD ' required | ✓ (2023-06-30) | ✗ | — | pregaps ignored |
| AetherSX2/NetherSX2 | ~2022 (unverified) | old closed PCSX2 libchdr (unverified) | ✗ zstd; probably ✗ huff (unverified) | ✓/✓/✓/✗ | CD | ✗ (reports) | ? | — | use `createcd`, default CD codecs |
| PPSSPP (2026-09-27) | 1.17 (2024-01) | upstream 2025-06-08 + ext/zstd | ✓ all (zstd since 1.17.1) | ✓ all | none (uses unitbytes/unitcount) | ✓ recommended | ✗ (TODO) | — | `createdvd -hs 2048`; createcd slow in 1.17 |
| Flycast ≤ v2.7 (2026-08-14) | 2018 | flyinghead/libchdr (2024–25) | ✓ all (zstd since v2.3) | ✓ all | CHT2, CHTR, CHGT, CHGD | — | ✗ | **✗ rejects any SUBTYPE≠NONE** | **rejects PREGAP≠0 or POSTGAP≠0**; no MODE2_FORM* |
| Flycast master (≥2026-09-10) | — | same | same | same | same | — | ✗ | warns and ignores | handles V pregaps; misplaces 76c7d19 GDI layout |
| Redream | ≤1.5.0 (unverified) | closed | ? (zstd very unlikely) | ? | ? | — | ? | ? | recommends GDI→CHD; pregap behaviour unknown |
| Demul | 2015 (gdrCHD plugin) | closed | ? (no zstd, unverified) | ? | ? | — | ? | ? | NAOMI GD-ROM MAME sets |
| MAME | 0.1xx | native | ✓ all (zstd ≥0.262) | ✓ all | all incl. CHSE, CHCD | ✓ (≥0.255) | ✓ | ✓ | at 76c7d19 its own reader misplaces GDI-sourced GD CHDs |
| RetroArch scanner + cheevos | ? | ≤1.21: lr-common libchdr (no zstd); 1.22: +zstd; master: rchd + rzstd | 1.22+: ✓ all | 1.22+: ✓ all | CHT2, CHTR, CHGD, 'DVD ' | ≥1.22 | ✗ | reads stream only | identifies by serial from the first data track; CRC over the primary track |
| rcheevos | — | no reader (host callbacks) | host | host | host | host | host | — | PS1/PS2/PSP use track 1; DC uses track 3 |
| MiSTer (2026-09-26) | ~2022 (unverified) | upstream 2024-02-11 + miniz + zstd | ✓ all | ✓ all | CHT2, CHTR | — | ✗ | MegaCD and CD-i use it; PSX uses `.sbi` | hunk read-ahead only ≤16 KiB |

---

## 8. What would break if the fork changed…

### 8.1 Defaulting to zstd / cdzs

**What stops loading.** Any reader whose libchdr lacks zstd fails at `chd_open()` with `CHDERR_UNSUPPORTED_FORMAT`, because every listed header codec is initialized at open. This happens even with a mixed list such as `cdlz,cdzl,cdfl,cdzs`. Affected:

- RetroArch ≤1.21: scanning and achievements fail for *every* core;
- AetherSX2/NetherSX2;
- Flycast ≤ v2.2;
- PCSX2 before 2024-02;
- DuckStation before 2024-02;
- PPSSPP ≤1.17.0;
- MAME ≤0.261;
- Redream and Demul (almost certainly);
- any libretro core built without zstd.

**Flag-sensitive builds.** libretro builds are sensitive to their compile flags:

- Beetle needs `HAVE_ZSTD`.
- RetroArch master needs `HAVE_RZSTD`.
- LRPS2 needs `HAVE_RCHD_ZSTD`. LRPS2 shipped a build that opened images and then failed on cdfl and cdzs hunks.
- Cores packaged on stale platforms may lag behind.

**Where the benefit lies.** The gain is decode speed on weak devices: MiSTer, Android and handheld Linux. Keep zstd opt-in, and show a precise minimum-version list, like the one above, in the UI.

### 8.2 Non-default hunk sizes

**CD.**

- A CD hunk must be a multiple of 2448 bytes. chdman enforces it, and DuckStation, SwanStation, Flycast and MAME refuse other sizes.
- ReARMed, MiSTer, Play!, RetroArch and Beetle simply compute `hunk/2448`.
- Larger CD hunks mean more memory and more latency per random seek. ReARMed allocates 2× the hunk. MiSTer on its Cortex-A9 is sensitive. DuckStation has an open regression report for `-hs 1040400` (#183).
- Smaller CD hunks mean a worse ratio and a bigger map.
- Every reader examined handles any legal size functionally, but only the default (8 frames) is battle-tested.

**DVD.**

- A DVD hunk must be a multiple of 2048 bytes.
- PPSSPP 1.17 needed `-hs 2048` for performance; fixed later.
- Larger DVD hunks shrink PS2 files but put more work on each random 2 KiB read: PCSX2 reads one chunk per hunk, and Play! and PPSSPP keep a single-hunk cache.
- **RetroArch ≤1.22's CRC fallback** includes last-hunk padding, so it depends on the hunk size.

**Memory.** libchdr's LZMA decoder over-allocated its dictionary before upstream `fa36420` (2026-08-22; the commit message says ~256 MB). This is independent of hunk size, but matters for RAM-poor readers.

### 8.3 New or changed metadata (sessions, CD+G)

**Additional tags** (`CHSE`, or anything new): ignored by every reader here, because all of them look tags up by name. Readers still place second-session tracks contiguously. Flycast keeps using its MIL-CD heuristic. There is a benefit: RetroArch could someday implement `FIRST_OF_SECOND_SESSION`.

**CD+G** (`AUDIO` + `SUBTYPE:RW_RAW`):

- Flycast ≤2.7 rejects any subtype.
- Beetle switches to in-CHD subchannel mode.
- DuckStation uses in-CHD SubQ if track 1 carries subcode.
- MiSTer MegaCD and CD-i consume it.
- For PS1, PS2, PSP and DC Redump sets it never occurs.

**Changing `CHT2` itself** — new fields, reordered fields, or new `TYPE`/`PGTYPE` spellings — breaks:

- DuckStation (`sscanf != 8` is an error; unknown type is an error);
- PCSX2 (`!= 8` is an error);
- Play! (`== 8` required, otherwise the entry is skipped);
- Beetle (only `MODE2_RAW`/`AUDIO`);
- Flycast (unknown type throws);
- MiSTer and RetroArch (string compares).

The `sscanf("%s")` parsers also have fixed buffers: 16 bytes in Flycast and 32–64 in the others.

**Removing the `'DVD '` tag** breaks Play! (which assumes a 2448-byte CD) and RetroArch (which finds no track).

**Changing DVD `unitbytes`** away from 2048 breaks PPSSPP, PCSX2 and Play!.

### 8.4 createdvd versus createcd for PS2/PSP

**createdvd for PS2 DVD games:**

- ✓ in PCSX2 (2023+), LRPS2, Play! (2023-06+) and RetroArch ≥1.22;
- ✗ in AetherSX2/NetherSX2, and in RetroArch ≤1.21 achievements.

**createcd of a PS2 DVD ISO** (the legacy route):

- ✓ in PCSX2, AetherSX2/NetherSX2, Play! (MODE1 path), LRPS2 and RetroArch;
- about 7–10% larger;
- CD codecs only.

**PSP:**

- `createdvd -hs 2048` is PPSSPP's documented choice.
- `createcd` works through the unit-stride path but is slow (1.17).
- RetroArch ≤1.21 cannot hash either.

### 8.5 Storing pregaps differently

**PS1.**

- Stored `V` pregaps, which is what chdman does today for cues, are required for Redump byte-exactness: DuckStation's track-MD5 verification and RetroArch's per-track CRC both depend on them.
- Switching to virtual pregaps would:
  - break ReARMed's CD-DA offsets, since it treats every pregap as stored;
  - change Play! (which ignores pregaps).
- Absorbing pregaps into the previous track (TOSEC style) keeps playback correct in every reader, but changes the per-track hashes.

**Dreamcast.**

- Any `PREGAP≠0` is **fatal in every Flycast release** up to v2.7.
- The post-0.289 GDI virtual-pregap layout is **mis-placed by MAME and Flycast master** (§1.5).
- The 0.264–0.289 layout (`PREGAP:0`, pregap data absorbed, `PAD` only before LBA 45000) is the only layout that every reader examined accepts.
- MIL-CD CHDs with `V` pregaps need Flycast master, or the DiscCompressor-Pro style absorption.

### 8.6 Writing parent/child CHDs

Parent/child CHDs load only in:

- DuckStation;
- Beetle PSX (2026+);
- PCSX2;
- LRPS2;
- MAME.

All of them require the parent in the *same directory*, matched by SHA1 (PCSX2 also matches MD5).

Everything else fails with `CHDERR_REQUIRES_PARENT`: SwanStation, ReARMed, Play!, PPSSPP, Flycast, MiSTer, RetroArch scanning and achievements, and presumably Redream and Demul.

Frontends would list parents as separate games. Parent/child output should never be a default.

---

## 9. Implications for a Discpress fork

1. **Fix the GD-ROM regression before anything else.** It is in the currently shipped `dist/discpress.html` (MAME `76c7d19`).
   - Revert or patch `1cf0f9e986` and `ac47a71ce1` in `wasm/mame.patch` to restore the 0.289 behaviour for both `.gdi` and Redump `.cue`: `PREGAP:0`, pregap frames absorbed into the previous track, `PAD` only before the high-density area.
   - Add synthetic fixtures (the `$SP/research/D1test/{gdi,cue}` generators are ready to copy) with golden `CHGD` strings.
   - Add a `cdrom_file` TOC check (`toc.cpp`) that asserts track 3 is at 45000.
   - Consider reporting the `cdrom_file` versus writer inconsistency upstream.
2. **Default output must be "works everywhere".**
   - Keep the chdman default codecs: CD `cdlz,cdzl,cdfl`; DVD `lzma,zlib,huff,flac`.
   - Keep the default CD hunk (19,584 bytes).
   - Never add zstd to a default codec list, even as the 4th codec.
3. **Label the zstd presets precisely.** Suggested UI text: "needs DuckStation (2024+), SwanStation, Beetle PSX, PCSX ReARMed (current), PCSX2 2.0+, Play!, PPSSPP 1.17.1+, Flycast 2.3+, RetroArch 1.22+ (for scanning and achievements), MiSTer (2024+) or MAME 0.262+; not AetherSX2/NetherSX2, and probably not Redream or Demul."
4. **PS2.** Keep `createdvd` for DVD titles and `createcd` for CD titles, as the current `applyIdent` logic does. Offer an "AetherSX2/NetherSX2 compatible" option that uses `createcd` with CD codecs for DVD titles.
5. **PSP.** Keep `createdvd -hs 2048`, which Discpress already sets.
6. **Keep metadata strictly MAME-canonical.**
   - Keep the exact `CHT2`/`CHGD` format strings and type strings.
   - Write `CHSE` only for real multi-session discs, as MAME does.
   - Keep the 1-byte `'DVD '` tag and `unitbytes` of 2048.
   - Do not invent tags that readers must understand. Additional tags are safe only as optional hints.
7. **No parent/child** output except as an expert option, with a warning about the few readers that support it.
8. **Naming and sidecars.**
   - Keep Redump names, including `(Disc N)`: RetroArch derives its disc suffix from it.
   - Generate `.m3u` files for multi-disc sets, following the ES-DE and Batocera conventions.
   - Tell users to keep a Redump-named `.sbi` next to LibCrypt PS1 CHDs. chdman cannot embed SBI data, and most readers look for `<basename>.sbi`.
9. **Test against more than upstream libchdr.** Discpress's native test harness could build small decoders, or equivalent read-back tests, from:
   - upstream libchdr (`rtissera`, HEAD);
   - libretro-common libchdr, as used by Beetle;
   - `rchd`, as used by RetroArch master and LRPS2;
   - DuckStation's libchdr fork;
   - Flycast's `chd.cpp` arithmetic, including the v2.7 rejection rule;
   - MAME's `cdrom_file`.

   The checks should compare TOC/LBA and per-track bytes against the source cue/bin.
10. **Future session metadata.** If the fork ever wants session metadata (MIL-CD), it must stay additive. No reader outside MAME uses `CHSE`. Flycast derives sessions heuristically.

---

## 10. Open questions

- **Redream and Demul:**
  - How do they place `CHGD` tracks when `PREGAP≠0`, whether stored (`V`) or virtual?
  - Which codecs do they support: `cdfl`, `huff`, zstd?
  - This needs a runtime test with a synthetic GD image that boots homebrew, e.g. a KallistiOS test IP.BIN.
- **Flycast releases:**
  - When will Flycast 2.8 ship pregap support?
  - Does Flycast Dojo carry the same rejection? (Presumably yes; unverified.)
- **MAME upstream:**
  - Will the #15870 GDI layout be fixed, or `cdrom_file` changed to match?
  - Which layout will the MAME 0.290 release actually ship, and do the NAOMI and DC drivers boot such images?
- **AetherSX2/NetherSX2:** what is the exact root cause of the `createdvd` failure — `huff`, generic LZMA/FLAC, or DVD detection? A `createdvd -c lzma,zlib` test would tell.
- **PCSX ReARMed:** confirm at runtime that CD-DA starts 0–3 frames early per preceding track, and whether any user-visible desync results.
- **Exact zstd arrival** in SwanStation, Beetle PSX (before its 2026-07 switch), PCSX ReARMed and MiSTer releases.
- **Standalone achievement hashing:** how do DuckStation, PCSX2, PPSSPP and Flycast implement hashing for CHD, and do their outputs match RetroArch's for the same CHD? This especially concerns Dreamcast with the broken GDI layout.
- **LaunchBox:** CHD and multi-disc conventions were not researched beyond forum threads.
- **RetroArch rdb:** do the libretro-database serials use the `-N` disc suffix consistently for Redump multi-disc sets? This affects how much Discpress's `(Disc N)` naming matters.
- **PS2 DVD hunk size:** would `-hs 8192` or larger cause measurable read stalls in PCSX2, LRPS2, Play! or AetherSX2-class devices? No benchmark exists.

---

## Appendix A: chdman commands recommended by each project

| Project | Command | Source |
|---|---|---|
| PPSSPP | `chdman createdvd -hs 2048 -i game.iso -o game.chd` (optional `-c zstd`); avoid `createcd`/`createraw` | ppsspp.org dumping-games docs; 1.17 release post |
| Batocera | `chdman createcd -i game.cue -o game.chd`; `createdvd` for DVD systems; keep the `.sbi` | wiki.batocera.org/disk_image_compression |
| PCSX2 community | `createdvd` for DVD ISOs, `createcd` for CD bin/cue | forums.pcsx2.net thread "CHD format: createcd or createdvd?" (not an official docs page) |
| AetherSX2/NetherSX2 users | `createcd` only | EmuDeck#1128, NetherSX2-patch#37 |
| Redream | convert GDI to CHD | redream.io/help |
| Dreamcast community (Redump cue) | historically cue → GDI → CHD (RedumpCUE2GDI) because of mamedev/mame#6466; since 0.264 cue → CHD directly | GitHub AwfulBear/RedumpCUE2GDI; MAME history |

## Appendix B: Sources examined

All clones are in `$SP/src/*-D1`, read-only.

- `stenzek/duckstation@a2edf2d0f0` (2026-09-27)
- `libretro/swanstation@b6c30a7b27` (2026-09-17)
- `libretro/beetle-psx-libretro@d50a9d0da3` (2026-09-27)
- `libretro/pcsx_rearmed@ff81ed17a1` (2026-09-24)
- `grumpycoders/pcsx-redux@264f2a6865` (2026-09-27)
- `PCSX2/pcsx2@36907f4b70` (2026-09-27)
- `libretro/ps2@d8b86efdf6` (LRPS2, 2026-09-27)
- `jpd002/Play-@83700b2c31` (2026-09-03), with `jpd002/libchdr@284e38b` (2025-06-24)
- `hrydgard/ppsspp@9fc4eb3e4d` (2026-09-27), with `ext/libchdr` → `rtissera/libchdr@8bba774` (2025-06-08)
- `flyinghead/flycast@ea087b9140` (2026-09-26)
  - tags: v2.2 `925400c`, v2.3/v2.3.2 `7239eab`, v2.4 `8108e63`, v2.5 `5f4eefa`, v2.6 `392a429`, v2.7 `5aa091f`
  - pre-fix `e698b8a`; fix `0abac34`
  - libchdr fork `flyinghead/libchdr@5f82799` (2025-04-02)
- `libretro/RetroArch@520097d511` (2026-09-27); tags v1.21.0 `baee906` (2025-05-01), v1.22.0 `703321e` (2025-11-14), v1.22.2 `69a4f0e`
- `RetroAchievements/rcheevos@f87c0de911` (2026-09-26)
- `MiSTer-devel/Main_MiSTer@5fb9bd1020` (2026-09-26)
- `rtissera/libchdr@607694ca08` (2026-09-27; full history). Key milestones:
  - parent support `513aebf` (2020-12-25);
  - dr_flac (2021-03);
  - generic LZMA/FLAC `e23f32f` (2022-03-26);
  - huff `5715077` (2022-12-29), with fixes `de74053` (2023-02-19) and `1fb0c62` (2023-09-17);
  - zstd `d6f59e7` (2024-01-10, merged 2024-01-31);
  - DVD identifier `ba5656f` (2026-02-03);
  - `WANT_SUBCODE` options `2203b5a` (2026-02-07);
  - LZMA dictionary fix `fa36420` (2026-08-22);
  - "Stop rejecting sparse CHDv5 images" `d31d8b9` (2026-09-10).
- `mamedev/mame@76c7d197ed` (the Discpress `third_party/mame` checkout; `mame0289` tagged 2026-07-30).
- Web sources:
  - mamedev/mame #6466 and #11913;
  - flyinghead/flycast #906;
  - pwnedbygary/DiscCompressor-Pro #9;
  - PCSX2/pcsx2 #9771;
  - hrydgard/ppsspp #18798 and #18925;
  - libretro/RetroArch #18005 and #18883;
  - Trixarian/NetherSX2-patch #37 and #104;
  - dragoonDorise/EmuDeck #1128;
  - unofficial-issue-tracker/duckstation #183;
  - grumpycoders/pcsx-redux #546;
  - redream.io/help;
  - wiki.batocera.org;
  - the ES-DE `USERGUIDE.md` (saved at `$SP/research/esde_userguide.md`);
  - PPSSPP docs and the 1.17 post;
  - the EmuTalk Demul thread 55675;
  - the Mednafen documentation and forum.

## Appendix C: Reproducing the experiments

```sh
SP=$SP
cd $SP/research/D1test
# synthetic inputs already generated: gdi/t5.gdi (+track0N), cue/Game.cue, ps1/Game.cue, milcd/Game.cue, dvd/t.iso
/usr/bin/chdman createcd -f -i gdi/t5.gdi -o gdi/t5_0264.chd                         # 0.264 reference
/home/user/discpress/build/chdman-native createcd -f -i gdi/t5.gdi -o gdi/t5_76c7.chd # Discpress's pin
/usr/bin/chdman info -v -i gdi/t5_76c7.chd | grep TRACK                               # metadata
tool/toc gdi/t5_76c7.chd       # track LBAs as MAME's own cdrom_file computes them
# tool/toc.cpp links against /home/user/discpress/build/obj-native/*.o (all but chdman.o)
```
