# D2: CHD in the other disc-based systems, in multi-system emulators, and the libchdr landscape

> Part of the [Discpress chdman research dossier](README.md), 2026-09-27. Written by a research agent from source reading and experiments. `$SP/...` paths name artefacts in the temporary research workspace, which is not part of the repository (reproducible lab tooling is in [lab/](lab/)). Lane letters (A, B, C, D1, D2, E, G) refer to the reports listed in the README.

Research lane D2 of the Discpress chdman-fork dossier. Written 2026-09-27.

**Scope.** This report covers:

- Emulators for the non-Sony, non-Dreamcast disc systems that Discpress identifies (`SYSTEMS` in `app/ident.js`): Sega CD, Saturn, PC Engine CD, PC-FX, Neo Geo CD, 3DO, CD-i, CD32/CDTV, Jaguar CD, PC-98 and generic PC data discs. It also covers GameCube/Wii, but only as non-support.
- Multi-system emulators.
- Every copy of libchdr and every other CHD reader I could find.

D1 covers PS1/PS2/PSP/Dreamcast, RetroArch's scanner, rcheevos and MiSTer. For those targets I only fill in the libchdr/zstd column.

**Method.**

- Almost every claim about behaviour comes from reading source at the commits listed in Appendix A. The repositories were cloned into `$SP/src/*-D2`: blobless and shallow for code, full-history blobless for dating.
- To identify each vendored libchdr, I compared the git blob of its `libchdr_chd.c` / `chd.c` against all 146 historical versions of that file in upstream `rtissera/libchdr`. The result is either an exact match or the nearest version by diff size (§14.3).
- Web sources are used only for closed-source programs and project documentation.
- Nothing was built or run. Behaviour inferred from code is described as such. Anything not checked in source is marked **(unverified)**.

**Citation format.** `owner/repo@shortsha:path:line`. The MAME reference is `mamedev/mame@76c7d197ed`, the tree Discpress pins (post-0.289).

---

## 0. Key findings

1. **Only one CD layout is safe everywhere: the one chdman writes today by default.** It has these properties:
   - codecs `cdlz,cdzl,cdfl`;
   - 19 584-byte hunks (8 frames × 2448), unit 2448;
   - one `CHT2` entry per track, written by chdman from the CUE;
   - pregap stored in the image and marked `PGTYPE:V<type>` when the CUE has INDEX 00 inside the file;
   - `POSTGAP:0`, `SUBTYPE:NONE`, no parent, and no `CHSE` for single-session discs.

   Every CHD-capable reader in this lane opens that layout, with one exception: DOSBox Pure opens only *uncompressed* CHDs. There are also two partial caveats:
   - libretro BlastEm and libretro Virtual Jaguar open it but misplace tracks whose pregap is stored (finding 3).
   - For multi-session sources, the post-0.289 `CHSE` tag is required by Virtual Jaguar (Jaguar CD). It is fatal to Kronos, Yabause and jgenesis on any multi-session Saturn or Sega CD source (finding 4).

   Moving away from this layout on any of the axes below breaks at least one real emulator.
2. **zstd/cdzs is not safe as a default.** The following cannot decode it at HEAD:
   - **Opera** (libretro 3DO): it builds its rchd reader without `HAVE_RCHD_ZSTD`.
   - **Beetle SuperGrafx**: libchdr from 2021.
   - **Kronos**, in both its standalone and libretro builds: libchdr from 2018.
   - **libretro Yabause** and the **libretro YabaSanshiro** branch: libchdr from 2020.
   - **WinUAE**: MAME CHD code from about 2013, no zstd codec.
   - **libretro BlastEm**: zstd is deliberately stubbed out; the core prints "Recompress it with `chdman createcd -c cdlz,cdzl,cdfl`".
   - **DOSBox Pure**: no compressed CHDs at all.
   - Amiberry built with `USE_ZSTD=OFF`, which is forced on iOS.
   - MAME before 0.262.
   - Every core older than its zstd sync date (§13, §14.3).

   libchdr and MAME refuse to *open* a CHD whose header merely **lists** an unknown codec, even if no hunk uses it (`rtissera/libchdr@8baec6e:src/libchdr_chd.c:1473`; `mamedev/mame@76c7d197ed:src/lib/util/chd.cpp:2782-2787` throws `UNKNOWN_COMPRESSION`). rchd fails only on the hunks that use the codec.
3. **The meaning of PGTYPE's `V` prefix is mixed up across the ecosystem.**
   - In MAME, `V` means *valid pregap data stored in the file*: `mamedev/mame@76c7d197ed:src/lib/util/cdrom.cpp:1103-1107` and `:2656-2660`.
   - These readers follow that meaning: GPGX, PicoDrive, the Beetle PCE family, Geargrafx, 86Box, BizHawk, the UAE family (MAME-derived code; PUAE not fully traced), SAME_CDI and ares.
   - These readers ignore PGTYPE and **always assume the pregap is stored**: Beetle Saturn, Kronos, Yabause/YabaSanshiro, Ymir (for audio tracks), jgenesis, DOSBox-X and DOSBox Pure. NeoCD uses a partial heuristic.
   - **libretro BlastEm and libretro Virtual Jaguar read `V` as *virtual* (not stored)**, the opposite of MAME. By code reading, they misplace INDEX 01 of any track whose pregap is stored.
   - rchd (libretro-common) also names the flag the opposite way, but its consumers invert it back, so they behave correctly.
   - Conclusion: storing pregaps exactly as chdman does now is the only option that works in the majority. Switching to virtual pregaps would break seven or more readers.
4. **New metadata.**
   - Session tags (`CHSE`, MAME PR #15886, 2026-08-15, not in 0.289) are written only for multi-session sources.
   - These readers walk *all* metadata entries and abort on any tag that is not a track tag: Kronos and libretro Yabause/YabaSanshiro (`default: return -1`), and jgenesis (a hard error). Multi-session CHDs from the new chdman fail in them.
   - libretro Virtual Jaguar *requires* `CHSE` for Jaguar CD and refuses CHDs without it.
   - CD+G tracks (MAME PR #15910, 2026-09-22) are written as `TYPE:AUDIO SUBTYPE:RW_RAW`. **Every Beetle core (PCE, PCE Fast, SuperGrafx, PC-FX, Saturn) refuses the whole disc when any track has `SUBTYPE≠NONE`.**
5. **Hunk size.**
   - No reader in this lane hard-codes 8 frames.
   - GPGX, PicoDrive, ares, Geargrafx, NeoCD, WinUAE and DOSBox Pure require `hunkbytes % 2448 == 0`. The Beetle cores assume it.
   - **rchd (now RetroArch's default reader, and used by NeoCD, Opera and SAME_CDI) rejects v5 hunks larger than 512 KiB**, while chdman allows up to 1 MiB.
   - The new embedded libchdr targets (RP2350, ESP32, BL616/TangCore) are budgeted for default hunk sizes.
6. **Parent CHDs work nowhere in this lane except MAME.**
   - Every emulator examined passes `NULL` for the parent, or refuses parent reads.
   - MAME resolves parents only for software-list and ROM-set CHDs, through romload (`mamedev/mame@76c7d197ed:src/emu/romload.cpp:165-223`).
7. **A `createdvd` image breaks every CD-system reader.**
   - Among readers relevant here, only 86Box and BizHawk accept `DVD ` CHDs; rchd synthesises a single MODE1 track, which is untested for these systems.
   - MAME's CD drivers refuse DVD CHDs.
   - MAME's own `dvdrom_file` requires **2048-byte hunks** (`src/lib/util/dvdrom.cpp:55-58`), yet `chdman createdvd` has defaulted to 4096 since 0.263 (`fa9d0fc32a`, 2024-02-05).
8. **libchdr now comes in several families, with different release cadences:**
   - direct upstream snapshots (2018 → 2026-08-22);
   - the libretro-common C89 fork with clean-room codecs;
   - **rchd**, a clean-room reader written against a measured format spec (libretro-common, 2026-07-27), now RetroArch's default;
   - chd-rs (Rust), used by BizHawk and jgenesis;
   - MAME-derived C++ copies (WinUAE, Amiberry, FS-UAE, CD-i Emulator);
   - custom minimal readers (DOSBox Pure).
9. **Encoder tuning is constrained by what readers reconstruct:**
   - **LZMA**: properties are not stored, so every reader rebuilds lc=3/lp=0/pb=2 from level and hunk size. Changing lc/lp/pb breaks every reader, MAME included.
   - **FLAC**: `cdfl` frames must not exceed `blocksize(hunkbytes)`. libchdr (since 2026-09-10) and rchd reject larger frames.
   - **zstd**: each hunk (and each cdzs sub-stream) must be exactly one frame with window ≤ 2^27, because rchd refuses trailing bytes.
10. **Metadata is covered by the CHD SHA-1** (`CHD_MDFLAGS_CHECKSUM` is the default for `write_metadata`). Any change to track or session text changes the image's SHA-1. That matters for MAME software lists and DAT tools. Codec and hunk-size changes leave the SHA-1 unchanged.
11. **No CHD in the GameCube/Wii/Xbox/PS3/Wii U/Vita world.**
    - Dolphin's blob types are PLAIN/GCZ/CISO/WBFS/TGC/WIA/RVZ/NFS/…, with no CHD.
    - xemu, RPCS3, Cemu, Vita3K and Xenia have no CHD code.
    - Discpress should not offer CHD as a target for `gc`/`wii`.
12. **BigPEmu refuses CHD by design.** Its FAQ says CHD is "not ideal for Jaguar CD titles … common tool paths stripping important data from pregap areas". That is the same pregap problem as finding 3, seen from the other side.

---

## 1. Ground truth: what MAME's reader does (the reference every other reader should match)

- **Tags** (`mamedev/mame@76c7d197ed:src/lib/util/chd.h:225-237`, formats in `src/lib/util/chd.cpp:48-51`):

  | Tag | Contents |
  |---|---|
  | `CHCD` | old binary |
  | `CHTR` | `TRACK TYPE SUBTYPE FRAMES` |
  | `CHT2` | adds `PREGAP PGTYPE PGSUB POSTGAP` |
  | `CHSE` | `SESSION:%d`, new |
  | `CHGT` / `CHGD` | GD-ROM |
  | `DVD ` | DVD |
  | `AVAV` / `AVLD` | LaserDisc |

- **Writer** (`src/lib/util/cdrom.cpp:1095-1147`):
  - `CHSE` is written only `if (toc.numsessions > 1)`, once before the first track of each session, with metaindex = session index.
  - `PGTYPE` is `'V'` + the pregap type when `pgdatasize > 0`, i.e. the pregap sectors are in the image.
  - All entries use `CHD_MDFLAGS_CHECKSUM` (`chd.h:356-358`).
- **CUE parser** (`src/lib/util/cdrom.cpp:2633-2666`):
  - INDEX 00 followed by INDEX 01 in the same file sets `pregap = idx1 − idx0`, `pgtype = trktype` and `pgdatasize = datasize`. The pregap is stored and written as `V…`.
  - A `PREGAP` command sets `pregap` only. The pregap is virtual and written without `V`.
  - `POSTGAP` sets `postgap`; the postgap is never stored.
  - `TRACK nn CDG` becomes AUDIO with `subtype=CD_SUB_RAW`, i.e. `SUBTYPE:RW_RAW` (`:2611-2630`; subtype strings at `:873-879`).
- **Reader offsets** (`src/lib/util/cdrom.cpp:255-330`):
  - `unit_bytes()` must equal 2448.
  - For each track:
    - if the pregap is not stored, `logofs += pregap`; otherwise `logframeofs = pregap`;
    - `chdofs += frames + extraframes`, where extraframes pads to a multiple of 4;
    - `logofs += postgap + frames`.
  - Reads of stored-pregap tracks add `pregap` to the CHD sector (`:393-398`). Reads of unstored pregap sectors return zeros (`:381-386`).
  - The CHD path does **not** add lead-in or lead-out between sessions; only the CUE path does (`:185-200` vs `:274-296`).
- **chdman defaults** (`src/tools/chdman.cpp:67-68, 671-674, 2208, 2280, 1359-1360`):
  - CD: `cdlz,cdzl,cdfl`, hunk of 8 frames.
  - DVD: `lzma,zlib,huff,flac`, hunk 4096.
  - Hunk sizes range from 16 B to 1 MiB and must be a whole multiple of the unit (2448 for CD).
- **Release status.** 0.289 was tagged 2026-07-30. `CHSE` (b93961fd52), CD+G (c9e87a6b7e) and the GD-ROM pregap changes (1cf0f9e986, ac47a71ce1) are **not** in 0.289; they will first ship in 0.290. Discpress's pinned tree contains all of them.

---

## 2. Sega CD / Mega CD

### 2.1 Genesis Plus GX: standalone (`ekeeke/Genesis-Plus-GX@939ce4f045`) and libretro (`libretro/Genesis-Plus-GX@c2838c7dc4`)

- **Since:** 2017-08-27 ("[Core/CD] added (optional) CHD image file support", `USE_LIBCHDR`). The Wii/GameCube (`Makefile.wii:12-33`), SDL2 and libretro builds all enable it.
- **Reader:** libchdr.
  - Standalone: `core/cd_hw/libchdr`, nearest upstream `22ed569` (2024-12-10), bumped 2025-07-24 (#586). zstd 1.5.6 is compiled on all platforms (`libretro/Makefile.common:26-51`, `Makefile.wii:23-33`).
  - libretro fork: `libretro/deps/libchdr` (nearest `5a39b15`, 2024-06-15) plus `libretro/deps/zstd`; zstd since **2025-06-22** (#361), `HAVE_CHD = 1`. The fork also keeps an old, **unused** copy at `core/cd_hw/libchdr/src/chd.c` (2021, no zstd).
- **Parsing** (`core/cd_hw/cdd.c:417-573` upstream):
  - Opens with `chd_open_file(fd, …, NULL, …)`, so no parent.
  - Rejects `hunkbytes % 2448 ≠ 0` (`:436`).
  - Reads `CHT2`, else `CHTR`, by index; `CHSE` is invisible to it.
  - Track 1 may be `MODE1_RAW`, `MODE1` or `MODE2_RAW`, or `AUDIO` for a music CD. **Every later track must be `AUDIO`**, otherwise the scan stops.
  - Pregap: `if (pgtype[0] != 'V') pregap = 0` for the file offset (`:525`); the TOC start still includes the pregap. This matches MAME.
  - Postgap is added to the TOC end.
  - Pads to 4 frames.
  - Rejects images longer than 100 minutes.
- **Audio** is read as big-endian 16-bit and swapped (`:1492-1551`).
- **Subcode:** the CHD subcode is skipped. Subcode (CD+G) comes only from an external `.sub` file.
- **Sessions:** none. **m3u:** yes (libretro).
- **Performance:** one hunk is cached; audio streams hunk by hunk.
- **Tracker:** #394 "CHD Support for SEGA CD MD+" (MD+ cartridge audio); no pregap bugs found.

### 2.2 PicoDrive: `irixxxx/picodrive@25c511bb41` and `libretro/picodrive@1890c29322`

- **Since:** 2021-03-04/08 ("core, chd support"). zstd since **2024-05-24** ("update libchdr for zstd support"); the libretro static-link fix landed 2024-06-15.
- **Reader:** git submodule `pico/cd/libchdr` → `irixxxx/libchdr@e62ac59`, which equals upstream `e62ac59` of 2024-06-13 (kub = irixxxx's own upstream PR). `Makefile:89,348-376` compiles zstd 1.5.6 and LZMA 24.05; `use_libchdr ?= 1`.
- **Parsing** (`pico/cd/cd_parse.c:117-208`):
  - `CHT2`/`CHTR` by index, no parent.
  - Types: MODE1_RAW and MODE2_RAW are handled as raw BIN; MODE1 and MODE2_FORM1 as ISO; AUDIO. Anything else stops the scan.
  - Pregap handling follows MAME: `if (pgtype[0] != 'V') pregap = 0` (`:188`), `sector_offset = sectors + pregap`.
  - Pads to 4 frames. Rejects images of 80 minutes or more.
- **File layer** (`pico/cart.c:251-291`):
  - Requires `hunkbytes % 2448 == 0` and uses the header's `unitbytes` (so assumes 2448).
  - Swaps big-endian audio. Skips subcode.
- **Also:** CD-audio-enhanced cartridges (MD+/MSU-MD style) can take a `.chd` (`README.md:22-24`). m3u: yes.

### 2.3 BlastEm: upstream (retrodev, Mercurial) and `libretro/blastem@1e0de94dc7` (branch `libretro`)

- **Upstream BlastEm:** Sega CD emulation since February 2022 (FAQ). No evidence of CHD support upstream **(unverified: the hg tree was not checked)**.
- **libretro fork:** CHD since **2026-08-11** (WizzardSK, #55); VFS 2026-08-13; lead-in numbering (#60).
  - libchdr copy in `libchdr/` with **zstd stubbed**: `libchdr/zstd_stub.c` makes `ZSTD_createDStream` return NULL, so `chd_open` fails for any image that lists zstd.
  - `chdimage.c:276-314` detects zstd and warns: "Recompress it with 'chdman createcd -c cdlz,cdzl,cdfl'".
  - **PGTYPE is inverted:** `track->fake_pregap = pgtype[0] == 'V' ? pregap : 0` (`chdimage.c:197-202`), with the comment "A pregap type starting with V is one MAME generated rather than stored". For a standard Redump-derived CHD (`PGTYPE:VAUDIO PREGAP:150`), the code synthesises 150 frames of silence and then reads the track's stored frame 0 at INDEX 01. Audio tracks therefore start 2 s late, and the TOC drifts by 150 frames per track (`:345-362`). Conversely, a non-`V` pregap with `PREGAP>0` (a virtual pregap in MAME) is assumed to be inside the stored frames. BlastEm is therefore correct only when `PREGAP=0`. This comes from reading the code; not tested.
  - Subcode: parses `RW`/`RW_RAW` and serves subcode from the CHD (`:160-171`, `:131`).
  - Lead-in inferred from the first data sector's MSF header (`:255-274`).
  - No parent. m3u: none found.

### 2.4 clownmdemu (Clownacy): frontend `Clownacy/clownmdemu-frontend@4c63cc3a68` → `clownmdemu-frontend-common@ab6f9cc` → `Clownacy/clowncd@c899e59`

- **Since:** 2026-01-30 ("Add support for CHD files!!!"); zstd on 2026-01-31; "Fix compatibility with CHD files that use trimmed sectors" on 2026-05-25.
- **Reader:**
  - `Clownacy/libchdr@7d039c3`, updated to v0.3.0 plus ANSI-C fixes on 2026-09-26/27. Clownacy authored the big upstream refactor of 2026-02 (#143 "clowncd").
  - Uses a copy of libretro-common's `streams/chd_stream.c` for per-track streams (`source/disc/chd.c`). That gives MAME-correct pregap semantics: the stream zero-fills pregaps that are not stored.
  - Optional system libchdr (c899e59).
- **Seeking:** `ClownCD_Disc_CHDSeekTrackIndex` supports only index 1 per track. No parent.

### 2.5 jgenesis (`jsgroth/jgenesis@d19ee94f64`, Rust)

- **Since:** 2024-02-20 ("[SCD] add support for loading & reading CHD files"). The zstd loading bug was fixed in #613 (CHANGELOG). PCE CD work in master (2026-09-12).
- **Reader:** chd-rs crate `chd = "0.3"` with `fast_zstd`, so zstd works.
- **Parsing** (`common/cdrom/src/reader/chd.rs:24-135`):
  - **Every metadata entry** is iterated. If any entry does not parse as a track (TRACK/TYPE/FRAMES), the code returns `ChdHeaderParseError` (`:77-83`). **A `CHSE` entry therefore makes the image unloadable.**
  - Types: MODE1(/2048), MODE1_RAW, MODE2_RAW, AUDIO. Anything else is an error.
  - "CHD pregaps exist as data within the image" (`:107-108`): PGTYPE is ignored and pregaps are always assumed stored.
  - Postgap ignored. Pads to 4 frames. Track 1 is given a fixed 2 s pregap.
- **Parent:** `Chd::open(f, None)`, so none.

### 2.6 ares: see §11.2

Mega CD, PC Engine CD, PlayStation, and a Saturn medium stub.

---

## 3. Saturn

### 3.1 Beetle Saturn (`libretro/beetle-saturn-libretro@65f05fa66f`)

- **Since:** 2017-07-28 ("WIP CHD support", Libretro bounty "Beetle Saturn – CHD file support"). zstd since **2025-06-22** (#40). The libchdr in `deps/libchdr` (nearest `5a39b15`, 2024-06-15, 127 diff lines) was last touched on 2026-06-29. In 2026 the reader was converted to C (`mednafen/cdrom/CDAccess_CHD.c`).
- **Parsing** (`CDAccess_CHD.c:286-490`):
  - `chd_open_core_file` with a NULL parent. Optional precache.
  - Types: MODE1, MODE1_RAW, MODE2_RAW, AUDIO. **Any `SUBTYPE≠NONE` is fatal** (`:402-406`).
  - **PGTYPE is ignored: `pregap_dv = pregap` for every track** (`:432-433`), so pregaps are always assumed stored. Track 1 additionally gets a virtual 150.
  - `plba += postgap`, but the CHD offset does not include it. The 4-frame padding is added (`:480-483`). The CHD frame is `lba + chd_offset` (`:616-619`).
  - Consequence: correct for chdman images of Redump CUEs. It **misplaces every later track if a pregap is virtual or a postgap is non-zero.**
- **Audio:** `RawAudioMSBFirst = 1`, i.e. swapped.
- **Subcode:** synthesised Q only.
- **Sessions:** none. **m3u:** yes.
- **Tracker:** Last Bronx (USA) multi-data-track CHD (#162 in the mirror repo), fixed by the padding logic.

### 3.2 Kronos (`FCare/Kronos@d451a55253`; its libretro port is built from the same tree)

- **Since:** 2019-08-21/22 ("add chd libraries").
- **Reader:** `yabause/src/tools/libchdr`, nearest upstream `96a2ce8` (2018-09-14), with FLAC 1.3.2, LZMA 16.04 and zlib 1.2.11. **No zstd.** Last touched 2024-10-23 (a zlib fix backport). Both CMake (`yabause/src/CMakeLists.txt:178-182`) and the libretro build (`yabause/src/libretro/Makefile.common:3-7,144-148`) use it.
- **Parsing** (`yabause/src/utils/src/cdbase.c:1940-2100`):
  - Iterates `chd_get_metadata(chd, 0 /*wildcard*/, n, …)` and `switch (resulttag) … default: return -1;` (`:1955-1969`). **Any `CHSE` (or any other non-track tag) aborts the load.**
  - PGTYPE ignored. `fad_start = logofs + pregap`, `logofs += frames` (`:2074-2082`), so stored pregaps are assumed.
  - Postgap ignored. Padding via `extraframes`.
- **Parent:** none. **m3u:** yes (libretro `valid_extensions` includes `chd|m3u`).

### 3.3 libretro Yabause (`libretro/yabause@8926b0c6c3`, master) and libretro YabaSanshiro (branch `yabasanshiro@09ed8e5`, 2026-08-23)

- **Master:** `yabause/src/libchdr` equals upstream `8baec6e` exactly (2020-11-02). No zstd. Last touched 2021-12-31.
- **YabaSanshiro branch:** the same `8baec6e` copy.
- Both parse in `yabause/src/cd-libretro.c:1914-1937 / 1823-1840` with the same wildcard loop and `default: return -1`. They therefore share Kronos's `CHSE` failure.
- The TOC assumes stored pregaps (`fad_start += pregap`, `fad_end = start + frame − 1 − pregap`, `:2024-2025`).
- The sector read path (`:2090-2110`) uses a different model: `logframeofs` accumulates `pregap + postgap + frames`, and a read does `loglba -= pregap` whenever `loglba > pregap`. That looks inconsistent with the TOC for stored (`V`) pregaps. I did not reconcile the two paths **(unverified; possible source of audio-offset bugs)**.
- **Standalone Yaba Sanshiro** (devmiyax, iOS/Android): supports `.chd`; at one point the iOS app accepted only CHD. Its repo `devmiyax/yabause` was not reachable (auth required), so its libchdr version is **unverified**. The branch above also carries `CMake/Packages/external_libchdr.cmake`.

### 3.4 Ymir (`StrikerX3/Ymir@3916405b6e`)

- **Since:** 2025-05-17 ("Preliminary support for MAME CHD files", #48).
- **Reader:** submodule `vendor/libchdr/libchdr` → upstream `6cde534` (2026-07-19). zstd yes.
- **Parsing** (`libs/ymir-core/src/ymir/media/loader/loader_chd.cpp`):
  - `chd_open(…, nullptr, …)` at `:189`. Optional precache.
  - Queries **`CHT2` only** (`:223`), so v3/v4 `CHTR` images find no tracks.
  - For **audio** tracks it skips `pregap` frames regardless of PGTYPE (`:345`).
  - For **data** tracks it scans forward for a sync pattern plus a matching MSF header.
  - `byteOffset += frames × unitSize` **without 4-frame padding** (`:409`).
- **Consequences:** later audio tracks can start up to 3 frames early per preceding track (inferred from code). The project's own `TROUBLESHOOTING.md:29` says "CHD has audio track issues with a handful of games". The CHANGELOG lists Last Bronx CHD fixes (#238, "Realign data offset to hunks between tracks").
- One session only. No parent.

### 3.5 Mednafen (upstream)

- **No CHD.** The official docs list CUE, CCD/IMG/SUB, TOC and M3U (mednafen.github.io/documentation).
- CHD exists only in forks: REG-Linux's `mednafen-chd` and the `stetime/mednafen-chd` Windows build of 1.32.1, and the libretro Beetle cores.
- OpenEmu's Mednafen core inherits the lack of CHD (§11.4).

### 3.6 SSF

Closed source; no CHD support is known **(unverified)**.

---

## 4. NEC: PC Engine CD, SuperGrafx, PC-FX

### 4.1 Beetle PCE, Beetle PCE Fast, Beetle SuperGrafx

Repos: `libretro/beetle-pce-libretro@b96c11e095`, `…-pce-fast-libretro@1c693c6301`, `…-supergrafx-libretro@3c6fcd3ded`.

- **Since:** 2017-08-05 (PCE Fast), 2017-08-05 (PCE, shared history) and 2017-08-11 (SGX).
- **zstd:**
  - PCE and PCE Fast since **2025-06-22**: libchdr nearest `5a39b15` plus `deps/zstd` (`Makefile.common:21-43`).
  - **SuperGrafx: none.** Its libchdr is nearest `878b5af` (2021-03-11), last touched 2022-02-05, and its `Makefile.common:33-37` compiles no zstd.
- **Parsing** (`mednafen/cdrom/CDAccess_CHD.cpp:60-212` in PCE; the same logic sits at the corresponding lines in Fast and SGX):
  - `chd_open(…, NULL, …)`, so no parent.
  - Types limited to MODE1, MODE1_RAW, MODE2_RAW and AUDIO. **`SUBTYPE` must be `NONE`, or the load fails** (`:126-130`).
  - PGTYPE handled correctly: `pregap_dv = V ? pregap : 0`, and the virtual `pregap` is used otherwise (`:138-139`).
  - **`fileOffset += postgap`** (`:155`) treats the postgap as stored, which MAME does not do. This is a latent bug that only shows if a CUE had `POSTGAP`.
  - Track 1 always gets a virtual 150. A *stored* track-1 pregap (a CUE with INDEX 00 in-file on track 1) therefore puts INDEX 01 at LBA 150, i.e. MSF 00:04:00. MAME's own `logframeofs` model and ares do the same; GPGX maps it to LBA 0.
  - `sph = hunkbytes/2448` implicitly requires the multiple.
- **Audio:** MSB-first, swapped. **Subcode:** synthesised Q. **m3u:** yes.

### 4.2 Beetle PC-FX (`libretro/beetle-pcfx-libretro@c1650bad5f`)

- **Since:** 2017-08-08. zstd only since **2026-08-23** (#99).
- The same parser as the PCE family (`CDAccess_CHD.cpp:64,128,140-163`), with the same `SUBTYPE`, postgap and track-1 behaviour.
- The only other PC-FX emulator is Mednafen, which has no CHD.

### 4.3 Geargrafx (`drhelius/Geargrafx@d9ad69222e`)

- **Since:** 2025-07-03 ("Add chd image implementation"). zstd from 2025-07-04, as a single-file `zstddeclib.c` pulled in by `#include` (`platforms/shared/dependencies/libchdr/src/libchdr_chd.c:95-97`).
- **Reader:** libchdr nearest `22ed569` (2024-12-10, 77 diff lines). Last change 2026-07-28 (large-file stdio).
- **Parsing** (`src/cdrom_chd_image.cpp:80-470`):
  - `chd_open_core_file` with NULL parent.
  - Rejects `hunkbytes % 2448 ≠ 0` and **hunk count > 500 000** (`:98-117`).
  - Beetle-style pregap: `pregap_real`/`pregap_dv` from `V` (`:380-381`).
  - **`file_offset` includes the postgap**, as in Beetle (`:430-446`).
  - Unknown track types default to AUDIO (`:617-630`).
  - Audio is byte-swapped on little-endian hosts.
- **Performance:** each hunk read is cached **forever** (`LoadHunk`), so memory grows towards the full image. Optional `PreloadDisc` via `chd_precache`.
- **m3u:** none (`valid_extensions` is `pce|sgx|hes|cue|chd|mmi`).

### 4.4 ares PC Engine CD: §11.2

### 4.5 Mesen2 (`SourMesen/Mesen2@b9fa69ddc6`)

- **No CHD.** There is no chd code in the tree; PCE CD takes CUE/BIN only.
- The repo was archived 2026-06-04; development continues in the MesenCE fork, whose CHD status is **unverified**.

---

## 5. SNK Neo Geo CD

### 5.1 NeoCD (`libretro/neocd_libretro@3118c69017`)

- **Since:** 2019-06-09.
- **Reader history:** libchdr with zstd (1.5.6) from about 2024-06-16. On **2026-07-31 it switched to rchd** ("chdfile: read CHD images through rchd"), built with `-DHAVE_RCHD_ZSTD` (`Makefile:296`), so zstd works.
- **File layer:**
  - A parent request is refused ("A differencing image would ask for its parent … refuse", `src/chdfile.cpp:29-35`).
  - Requires `hunk_bytes % 2448 == 0` (`:91-96`).
- **TOC** (`src/cdromtoc.cpp:441-600`):
  - Uses regexes over `CHT2`/`CHTR`.
  - Types MODE1(/2048) and MODE1_RAW(/2352), plus AUDIO. Anything else fails.
  - **Pregap heuristic (`:557-576`):** after a data track the pregap is treated as stored *only if PGTYPE is exactly `VAUDIO`*. After an audio track it is **always** treated as stored.
  - Postgap virtual. Pads to 4 frames. Subtype ignored.
- **Consequences:**
  - Neo Geo CD discs are one data track followed by audio, so default chdman output works.
  - Virtual pregaps on track 3 and later would be misread.
  - A stored pregap whose type is not `VAUDIO`, e.g. `VMODE1_RAW` after a data track, would also be misread.
- **m3u:** no (`cue|chd`).

### 5.2 MAME `neocd`

- The native reader, via `cdrom_image_device` → `cdrom_file` (§11.1). libretro MAME carries a NeoGeoCD hack (`libretro/mame@9069f39340`, "Put NeoGeoCD hack behind __LIBRETRO__ guard").

---

## 6. 3DO

### 6.1 Opera (`libretro/opera-libretro@a501a278d0`)

- **Since:** 2018-03-19 ("add CHD support").
- On **2026-08-20** it adopted **rchd**, replacing the old `deps/libchdr`, which had no zstd either.
- **zstd: none.** `Makefile.common:116-137` defines `HAVE_RCHD`, `HAVE_RCHD_DEFLATE`, `HAVE_RCHD_LZMA` and `HAVE_RCHD_FLAC` but not `HAVE_RCHD_ZSTD`. rchd's default codec block (`libretro-common/formats/chd/rchd.c:143-154`) applies only when *none* of those flags is defined, and `encoding_rzstd.c` is not compiled. Any hunk using `zstd`/`cdzs` is refused.
- **Track mapping** (`retro_cdimage.c:415-470`):
  - Uses rchd's `pregap_stored` flag, which is inverted by name (see §14.2). The resulting arithmetic follows MAME: `V` means skip the stored pregap.
  - Postgap virtual. Audio swapped.
  - The parent source is refused.
- **m3u:** no (`iso|bin|chd|cue`).

### 6.2 Standalone 3DO emulators

- 4DO and FreeDO (defunct), and Phoenix (closed source; also Jaguar): no evidence of CHD **(unverified)**.
- MAME's 3DO driver is not working.

---

## 7. Amiga CD32 / CDTV

### 7.1 PUAE (`libretro/libretro-uae@6536174a80`)

- **Since:** 2021-01-25 ("CHD support", `WITH_CHD`). zstd since **2024-09-23**.
- **Reader:** `deps/libchdr` equals upstream `5a39b15` exactly (2024-06-15). There is also a `libretro-common` libchdr copy, which PUAE's `Makefile.common:261-278` does not compile.
- **Parsing:** `sources/src/blkdev_cdimage.c:1432-1520` ports WinUAE's `parsechd` onto libchdr: `chd_open(img, …, NULL, …)` (so no parent), then `cdrom_open`, `cdrom_get_toc` and `cdrom_read_subcode`. These are declared in the tree's MAME-derived `sources/src/archivers/chd/chdcdrom.h`. The repo also carries that MAME C++ copy (`archivers/chd/chdcdrom.cpp`, which uses `pgdatasize`, i.e. MAME pregap semantics), but the libretro `Makefile.common` does not list it. I did not trace which implementation the libretro build links, so MAME semantics are **expected, not verified**.
- **Subcode:** read from the CHD when present (`subcode = RW_RAW?1:2`). CD+G on CD32/CDTV is therefore possible.
- **m3u:** yes (`valid_extensions` includes `cue|ccd|nrg|mds|iso|chd|…|m3u`).

### 7.2 WinUAE (`tonioni/WinUAE@d42db956c3`)

- **Since:** 2013-01-12 ("chd support added").
- **Reader:** `archivers/chd/*`, a copy of **MAME's C++ CHD code from about 2013**, with `chdcdrom.cpp` updated in part in 2022. `chdcodec.cpp` has **no zstd** (0 mentions) and was last touched 2026-05-31 (portability).
- **Parsing** (`blkdev_cdimage.cpp:1434-1520`):
  - Uses MAME's own `cdrom_file` (`chdcdrom.cpp:236-238` requires `hunk%2448==0` and `unit==2448`), so pregap and postgap follow MAME.
  - `cf->open(*f, false, NULL)`, so no parent.
  - CD subcode is read (`cdrom_read_subcode`).
  - No `CHSE`.
- **Unix/macOS port** (`README_unix.md:594,633`): CHD is built by default, but "**CHD FLAC codecs require libFLAC … otherwise CHD remains enabled without FLAC-compressed CD codecs**". Such builds cannot read `cdfl` hunks, i.e. any disc with audio tracks.

### 7.3 FS-UAE (`FrodeSolheim/fs-uae@f362278ccd`, master 5.0.7-dev, 2025-09-13)

- The tree has both an old `archivers/chd` (no zstd) and a newer `mame/src/lib/util` CHD copy **with zstd**. `Makefile.am:859-872` builds the new one; `configure.ac:324` requires `libzstd`; the CHD feature is `WITH_CHD` (`configure.ac:736`).
- CHD status in released 3.x builds is **unverified**. Issue #165 "Add/Fix MAME CHD Image Support" (2017) reported CD32 CHDs failing.

### 7.4 Amiberry (`BlitterStudio/amiberry@209103d782`)

- **Since:** 2022-01-06 (#320).
- **Reader:** `src/archivers/chd`, a newer MAME util copy with zstd (46 mentions) but **no `CHSE`/`DVD ` tags**. `USE_ZSTD` defaults ON (`CMakeLists.txt:59`) and is **forced OFF on iOS** (`:125`); zstd has been optional since 2025-06-30.
- **Open:** `cf->open(f->name, false, NULL)` (`src/blkdev_cdimage.cpp:1580-1581`), so no parent. MAME semantics otherwise.

---

## 8. Philips CD-i

### 8.1 MAME `cdimono1` / `cdi`

- The native reader (§11.1).
- The CD+G change (#15910, post-0.289) was motivated by CD-i playback ("will sound like 'crackling'" before the change).

### 8.2 SAME_CDI (`libretro/same_cdi@ff9bb99a50`, 2026-09-26)

- A trimmed MAME fork. `src/lib/util/chd.cpp` is **reimplemented over rchd**: "rchd … also handles zstd-compressed" (`chd.cpp:1-164`).
- zstd via `HAVE_RZSTD` and rchd's default codec block (`Makefile.common:383-397`).
- `cdrom.cpp` is MAME-era: `pgdatasize` semantics, `CHT2`/`CHTR`/`RW`/`RW_RAW`, **no `CHSE`**.
- The wrapper can bind a parent (`open_common(parent)`), but disc loading passes none **(unverified)**.
- Takes CHD/ISO/CUE and supports m3u (README).

### 8.3 CD-i Emulator (cdiemu, closed source)

- Beta versions read CHD using MAME/MESS source code, and `cdifile` can write CHDs (cdiemu.org).
- It is legacy code, so **no zstd** can be assumed **(unverified)**.

---

## 9. Atari Jaguar CD

### 9.1 BigPEmu (closed source)

- **No CHD, by policy.** FAQ: "No, it's not ideal for Jaguar CD titles. Be warned that … existing Jaguar CD images which have been converted to the CHD format may no longer be fully usable as a result of the common tool paths stripping important data from pregap areas."
- It offers its own **BigPImage** format instead (richwhitehouse.com/jaguar FAQ).

### 9.2 Virtual Jaguar, libretro (`libretro/virtualjaguar-libretro@f9a3c89f58`)

- **Since:** 2026-08-16 (#322, "load Jaguar CD CHDs that carry CHSE session tags"); session attribution fixed in #476 (2026-08-18).
- **Reader:** `deps/libchdr`, nearest upstream `10a3fb1` (2026-07-18, 6 diff lines), built as `unity.c`, so zstd works.
- **Rules** (`docs/jagcd-chd.md`, `src/cd/cdintf.c`):
  - **A Jaguar-shaped disc (two or more tracks, all audio) without `CHSE` is refused** (`cdintf.c:638-640`). The docs say that "chdman 0.288 … and every CHD made before PR 15886" fall in this class.
  - The ~11 400-sector inter-session gap is **synthesised** when `CHSE` shows a session change, unless the first session-2 track's `PREGAP ≥ 10000` (`:600-607`).
  - Session entries are found by walking the metadata with `CHDMETATAG_WILDCARD` (`:370-410`).
  - A pinned chdman (`tools/jagcd/CHDMAN_PIN` = MAME `420968ca7a…`) and `jagcd-to-chd`/`jagcd-chd-check` tools ship with releases.
- **PGTYPE is inverted:** "Virtual pregaps (PGTYPE starts with V) are silence, not stored" (`:587-598`). For `V` tracks the reader zero-fills before `dataLBA` and reads data from the start of the track's stored frames (`:699-712`). That is the opposite of MAME. For non-`V` tracks with `PREGAP>0` it assumes the pregap is at the start of the stored frames, so it reads `pregap` frames too far. It is therefore correct only when `PREGAP=0`, and the docs admit that only such images (Frog Feast) were measured.
- Audio frames are swapped back to Jaguar I2S order. No parent.

### 9.3 Phoenix (closed source)

- CHD support is unknown **(unverified)**. MAME's Jaguar CD is not working.

---

## 10. Computers with CD drives

| Target | CHD? | Details |
|---|---|---|
| **FM Towns: Tsugaru** (`captainys/TOWNSEMU@e27adde120`) | **No** | ISO/CUE/MDS/CCD. `gui/src/subprocess/test_chd.cpp` is an unrelated stdin echo test. A Qt-frontend fork (3d4m0t0/TOWNSEMU) claims CHD **(unverified)**. MAME `fmtowns` reads CHD natively. |
| **PC-98: NP2kai** (`AZO234/NP2kai@5939e0c6d5`) | **No** | `diskimage/cddfile.c:41-49` accepts cue/ccd/cdm/mds/nrg/iso only. The libretro build compiles an old libretro-common libchdr (2018-era copy, no zstd, FLAC commented out; `sdl/Makefile.libretro:795-829`), but no CD backend uses it. |
| PC-98: Neko Project 21/W | No | Docs list ISO/CUE/CCD/CDM/MDS/NRG. |
| PC-98: MAME `pc9821` | Native CHD | — |
| X68000 | MAME only | CD-ROM titles are rare. MAME `x68k` with SCSI CD reads CHD; no other emulator checked. |
| **DOSBox Pure** (`schellingb/dosbox-pure@73e03aa145`) | **Uncompressed V5 only** | See below. |
| **DOSBox-X** (`joncampbell123/dosbox-x@6a2afec327`) | Yes | See below. |
| DOSBox Staging (`dosbox-staging@c8ad29d897`) | No | No CHD code. |
| **86Box** (`86Box/86Box@bfcf8558a1`) | Yes | See below. |

**DOSBox Pure.** Since 2023-11-18 ("Add support for uncompressed CHD version 5 CD images", #40); padding simplified on 2024-09-07. It has its own minimal parser (`src/dos/cdrom_image.cpp:1145-1270`):

- It rejects any codec: "must be an uncompressed version 5 CD image" (`:1183`, `:1195`).
- It requires unit 2448 and a hunk that is a multiple of 2448.
- `CHT2`/`CHTR` via `sscanf`; `track.start = mt_pregap` (`:1234`), so pregaps are always assumed stored.
- One cooked-sector shift for the whole image.
- Swaps audio past the first audio offset.
- Supports m3u/m3u8. Not useful for compressed output.

**DOSBox-X.** Since 2020-11-11 ("Add support for CHD CD images", Wengier).

- libchdr nearest `5a39b15` (2024-06-15), last changed 2024-07-08. zstd sources are `#include`d into `cdrom_image.cpp:75-82`.
- `LoadChdFile` (`:1509-1610`) reads **`CHT2` only**.
- "chd has the pregap added to FRAMES" (`:1602`): PGTYPE ignored.
- **`track.start = total_frames` with no 4-frame padding** (`:1593`). Later tracks of mixed-mode discs are offset by 0–3 frames per preceding track (inferred).
- A source comment on audio endianness: "no idea about this, changing this did not fix the cd audio noise".
- Hunk prefetch thread. No parent.

**86Box.** Since 2026-07-16.

- libchdr nearest `10a3fb1` (2026-07-18), system zstd.
- `src/cdrom/cdrom_chd.c`:
  - Pregap/postgap/padding notes are MAME-correct (`:68-74`).
  - **Accepts `DVD ` CHDs** (`:717-725`, `:780-790`: hunk % 2048).
  - The comment "CHD files are not able to describe session information yet" is outdated relative to `CHSE`.
  - Reads CHD subcode when `SUBTYPE`/`PGSUB` is `RW` or `RW_RAW` (`:898-911`); otherwise it synthesises Q.
- No parent.

---

## 11. Multi-system emulators

### 11.1 MAME (`mamedev/mame@76c7d197ed`)

- **Devices:**
  - `cdrom_image_device` / `DVDROM` (`src/devices/imagedev/cdromimg.cpp:98-157`) calls `check_is_cd()`, then `check_is_gd()` if the device is GD-compatible, then `check_is_dvd()` only if `m_dvd_compat`. `DVDROM` is used only by `bus/ata/atapicdr.cpp`, so **every console CD driver refuses `DVD ` CHDs**.
  - `cdrom_file` requires unit 2448 (§1).
  - `dvdrom_file` requires **hunk = unit = 2048** (`src/lib/util/dvdrom.cpp:55-58`, since 2023-05-04). This contradicts chdman's 4096 default (since 0.263).
  - Hard disks go through `harddisk_file` (GDDD/IDNT/KEY/CIS).
  - LaserDisc uses `avhu` with AVAV/AVLD metadata.
- **Parents:**
  - Media loaded with `-cdrom file.chd` opens `m_self_chd` with no parent (`cdromimg.cpp:114-120`), so a CHD that needs a parent fails.
  - Software-list and ROM-set CHDs go through romload, which resolves parents by SHA-1 across parent sets (`src/emu/romload.cpp:165-223`) and verifies each CHD's **SHA-1, which includes the metadata**.
- **Codecs:** zstd/cdzs since **0.262** (`05e69b43e9`, 2023-12-11).
- **Sessions:** `CHSE` since `b93961fd52` (2026-08-15, post-0.289). The session number is parsed into `track.session`, but the CHD offset path does not add session lead-in/out (§1).
- **Subcode:** full support.
- **Working drivers for this lane:** segacd/megacd, saturn, pce(cd), neocd, cdi, cd32 and cdtv, fmtowns, pc98 CD models. pcfx, 3do and jaguarcd are not working. These driver statuses are from general knowledge, not checked against the `MACHINE_NOT_WORKING` flags at 76c7d19 **(unverified)**.

### 11.2 ares (`ares-emulator/ares@4cb8d92b44`)

- **Since:** **v128 (2022-05-17)**: "The few CD-ROM based systems that ares supports are now able to load CHD compressed disc images". At that time CHDs made from `.iso` did not work; MODE1/2048 was added later.
- **Reader:** `thirdparty/libchdr` equals upstream `93d8c23` exactly (= the **v0.3.0 tag**, 2026-04-24). `ARES_ENABLE_CHD` defaults ON; zstd 1.5.7 and `libchdr_codec_zstd.c` are compiled (`thirdparty/CMakeLists.txt:7-46`).
- **Systems:** every `CompactDisc` medium, i.e. Mega CD, Mega CD 32X, PC Engine CD, SuperGrafx CD and PlayStation (`mia/medium/medium.hpp:23-24`). A Saturn medium entry exists.
- **Parsing** (`nall/nall/decode/chd.hpp:55-190`):
  - `chd_open_file(…, nullptr, …)`, so no parent. Requires `hunk % 2448 == 0` (`:69`).
  - `CHT2`/`CHTR`; types `*_RAW`, `AUDIO`, `MODE1`.
  - `V` pregap means stored (`:120`). Track 1 gets a virtual 150 unless its pregap is stored.
  - **A virtual pregap on track 2 or later is dropped entirely from the TOC**: no index 0 and no LBA advance. TOC timing is then shorter than MAME's.
  - Postgap is a virtual index 2 (`:175-182`). Pads to 4 frames (`:170`). Audio byte-swapped (`:210-221`).
- **Performance:** `vfs::cdrom::loadChd` (`nall/nall/vfs/cdrom.hpp:240-300`) decodes the **whole disc into RAM** on a background thread (2448 bytes × all sectors plus lead-in/out), so hunk size does not matter at run time.
- **Subcode:** only from a sibling `.sub`; the CHD subcode is ignored.
- **Sessions:** one. m3u not applicable.

### 11.3 BizHawk (`TASEmulators/BizHawk@262fc6cfe4`)

- **Since:** 2024-04-30 ("Add CHD CD support", with libchdr). **Switched to chd-rs on 2024-05-03** via `ExternalProjects/libchd-rs-capi`, crate `chd-capi` 0.3.1 → `chd` 0.3.1 with `max_perf`, which includes zstd. "Support more discs with CHD" landed 2025-09-12.
- **Parsing** (`src/BizHawk.Emulation.DiscSystem/DiscFormats/CHD_format.cs`):
  - The most complete reader here: `CHT2`, `CHTR`, `CHCD` (both endiannesses), `CHGD`, `CHGT` and `DVD ` (synthesised).
  - `V` means `PregapInChd` (`:164-170`).
  - **Throws "Malformed CHD" if a `V` PGTYPE comes with `PREGAP:0`** (`:250-253`).
  - Audio byte-swapped except for old GD metadata.
  - `chds only support 1 session` (`:728`).
  - `chd_open(…, IntPtr.Zero, …)`, so no parent.
- **Writer (DiscoHawk)** (`:1014-1150`):
  - Writes V5 CHDs with **codec `zstd` only** (plain zstd, not cdzs; cdzs is `#if false // TODO`), zstd level lowered in 2025.
  - **75-frame hunks (183 600 bytes)** and `SUBTYPE:RW` for every frame.
  - Refuses multi-session discs.
  - So non-default CHDs already exist in the wild. They fail in every non-zstd reader, and in every Beetle core because of `SUBTYPE≠NONE`.

### 11.4 OpenEmu (`OpenEmu/OpenEmu@1d20510464`)

- **No CHD.** The wiki's "User guide: CD based games" says CHD files "must be uncompressed with `chdman` before they can be used".
- It uses Mednafen for PCE CD, PC-FX, PS1 and Saturn, and GPGX for Sega CD. The GPGX core is presumably built without `USE_LIBCHDR`: the wiki lists only CUE-based formats, and I did not check the OpenEmu core's build files **(inferred)**.

### 11.5 Mednafen

No CHD (§3.5).

---

## 12. Non-support, with rationale

| Emulator | Formats instead of CHD | Evidence |
|---|---|---|
| **Dolphin** (GC/Wii) | ISO/GCM (PLAIN), GCZ, CISO, WBFS, TGC, **WIA, RVZ**, NFS, split ISO, DOL/ELF | `dolphin-emu/dolphin@bb3558a70e:Source/Core/DiscIO/Blob.h:31-45`. No CHD code. The only Dolphin PRs mentioning "chd" are #8538 (WIA/RVZ) and #13035 (rcheevos hash). **No explicit rejection statement found (unverified).** The design rationale is in the RVZ work: Wii partitions are stored decrypted, and junk/padding data is regenerated instead of stored. A generic hunk compressor cannot exploit either. |
| **xemu** (Xbox) | XISO `.iso` | No CHD code (`xemu-project/xemu@f9b14039e5`). |
| **RPCS3** (PS3) | Folders/PKG plus a new ISO loader | `rpcs3/Loader/ISO.cpp`, `iso_cache.cpp` (`RPCS3/rpcs3@3fa07db78b`). No CHD. Relatedly, libchdr raised `CHD_MAX_FILE_SIZE` to 1 TB "for BD/PS3 ISOs" (#153, 2026-04-24), but RPCS3 does not use it. |
| **Cemu** (Wii U) | WUD/WUX, WUA (ZArchive), RPX/WUHB | `src/Cafe/Filesystem/WUD/wud.cpp`, `fscDeviceWua.cpp` (`cemu-project/Cemu@c717fcab1c`). |
| **Vita3K** | VPK/ZIP/PKG install | `vita3k/gui-qt/src/pkg_install_dialog.cpp` (`Vita3K/Vita3K@610e6970ad`). |
| **Xenia (canary)** | XISO disc images, STFS/GOD, **ZAR** (ZArchive) | `src/xenia/vfs/devices/disc_image_device.cc`, `disc_zarchive_device.cc` (`xenia-canary/xenia-canary@c332733afd`). |

For Discpress this means that `gc`/`wii` outputs should be RVZ. At the very least, a warning should say that no GameCube/Wii emulator reads CHD.

---

## 13. Compatibility matrix

**Legend.**

- ✓ yes; ✗ no; ? unknown.
- "V=stored" means it follows MAME's PGTYPE semantics.
- "assumes stored" means PGTYPE is ignored and pregaps are always assumed to be in the file.
- "V=virtual" means MAME's semantics are inverted.
- The codec column assumes cdzl/cdlz/cdfl always work unless stated. "zstd" means both `zstd` and `cdzs`.

| Target (HEAD) | CHD since | Reader and libchdr base | zstd/cdzs | Metadata understood | PGTYPE handling | Subcode from CHD | Sessions | Parent | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GPGX standalone (2026-09-23) | 2017-08-27 | libchdr ≈22ed569 (2024-12), bumped 2025-07-24 | ✓ (2025-07-24) | CHT2, CHTR | V=stored | ✗ (.sub only) | ✗ | ✗ | hunk%2448; tracks ≥2 must be AUDIO; Wii/GC builds included |
| GPGX libretro (2026-09-12) | 2017-08-27 | libchdr ≈5a39b15 (2024-06) | ✓ (2025-06-22) | CHT2, CHTR | V=stored | ✗ | ✗ | ✗ | m3u ✓ |
| PicoDrive (2026-09-25/26) | 2021-03-08 | irixxxx/libchdr = upstream e62ac59 (2024-06-13) | ✓ (2024-05-24) | CHT2, CHTR | V=stored | ✗ | ✗ | ✗ | hunk%2448; uses unitbytes |
| BlastEm libretro (2026-09-26) | 2026-08-11 | libchdr copy, **zstd stubbed** | ✗ (explicit) | CHT2, CHTR | **V=virtual (inverted)** | ✓ RW/RW_RAW | ✗ | ✗ | upstream BlastEm: no CHD (unverified) |
| clownmdemu (2026-09-27) | 2026-01-30 | Clownacy/libchdr ≈v0.3.0 + lr-common chd_stream | ✓ | CHT2/CHTR (via chd_stream) | V=stored | ✗ | ✗ | ✗ | index 1 seeks only |
| jgenesis (2026-09-12) | 2024-02-20 | chd-rs 0.3 (Rust) | ✓ | tracks only; **any other tag = error** | assumes stored | ✗ | ✗ (CHSE breaks load) | ✗ | — |
| Beetle Saturn (2026-09-26) | 2017-07-28 | libchdr ≈5a39b15 + zstd | ✓ (2025-06-22) | CHT2, CHTR | **assumes stored** | ✗ **(SUBTYPE≠NONE fatal)** | ✗ | ✗ | postgap assumed stored in LBA math |
| Kronos (2026-07-18) | 2019-08-22 | libchdr ≈96a2ce8 (2018) | **✗** | wildcard: **non-track tag = fail** | assumes stored | ✗ | ✗ (CHSE fatal) | ✗ | also libretro |
| Yabause / YabaSanshiro libretro | ≤2019-08-27 | libchdr = 8baec6e (2020-11) | **✗** | wildcard: **non-track tag = fail** | assumes stored | ✗ | ✗ (CHSE fatal) | ✗ | standalone YabaSanshiro: ? |
| Ymir (2026-09-27) | 2025-05-17 | upstream 6cde534 (2026-07-19) | ✓ | **CHT2 only** | audio: assumes stored; data: sync scan | ✗ | ✗ | ✗ | no padding in audio offsets; known "audio track issues" |
| Mednafen upstream | ✗ | — | — | — | — | — | — | — | CUE/CCD/TOC/M3U only |
| Beetle PCE / PCE Fast (2026-09) | 2017-08-05 | libchdr ≈5a39b15 + zstd | ✓ (2025-06-22) | CHT2, CHTR | V=stored | **✗ fatal** | ✗ | ✗ | postgap counted as stored; stored track-1 pregap → INDEX 01 at LBA 150 |
| Beetle SuperGrafx (2026-04-20) | 2017-08-11 | libchdr ≈878b5af (2021-03) | **✗** | CHT2, CHTR | V=stored | **✗ fatal** | ✗ | ✗ | not synced since 2022 |
| Beetle PC-FX (2026-09-04) | 2017-08-08 | libchdr ≈5a39b15 + zstd | ✓ (**2026-08-23**) | CHT2, CHTR | V=stored | **✗ fatal** | ✗ | ✗ | only PC-FX CHD reader besides MAME |
| Geargrafx (2026-09-27) | 2025-07-03 | libchdr ≈22ed569 + zstddeclib | ✓ | CHT2, CHTR | V=stored | ✗ | ✗ | ✗ | hunkcount ≤500k; unbounded hunk cache; postgap counted as stored |
| Mesen2 | ✗ | — | — | — | — | — | — | — | archived 2026-06; MesenCE ? |
| NeoCD (2026-08-30) | 2019-06-09 | **rchd** (2026-07-31) | ✓ | CHT2, CHTR | heuristic ("VAUDIO" after data; always stored after audio) | ✗ | ✗ | ✗ (refused) | hunk%2448; rchd 512 KiB cap |
| Opera 3DO (2026-08-21) | 2018-03-19 | **rchd** (2026-08-20) | **✗** (no HAVE_RCHD_ZSTD) | CHT2, CHTR, CHGD, DVD | V=stored (via inverted flag) | ✗ | ✗ | ✗ (refused) | rchd 512 KiB cap |
| PUAE (2026-09-06) | 2021-01-25 | upstream 5a39b15 exactly | ✓ (2024-09-23) | WinUAE-derived CD layer (CHT2/CHTR; not fully traced) | V=stored (expected) | ✓ | ✗ | ✗ | m3u ✓ |
| WinUAE (2026-09-27) | 2013-01-12 | MAME C++ ≈2013 | **✗** | CHT2, CHTR, CHCD, CHGD | V=stored (MAME) | ✓ | ✗ | ✗ | Unix port may lack cdfl without libFLAC |
| FS-UAE master (2025-09) | ? | MAME util copy | ✓ (libzstd) | MAME | V=stored | ✓ | ✗ | ? | release 3.x: ? (#165) |
| Amiberry (2026-09-26) | 2022-01-06 | MAME util copy (pre-DVD/CHSE) | ✓ (✗ on iOS) | MAME | V=stored | ✓ | ✗ | ✗ | — |
| MAME `cdi` / SAME_CDI (2026-09-26) | native / ? | MAME / **rchd-backed chd_file** | ✓ (≥0.262) / ✓ | all / CHT2, CHTR | V=stored | ✓ | ✓ (post-0.289) / ✗ | romload / ✗ (unverified) | CD+G change targets CD-i |
| CD-i Emulator | beta 0.5.3 | old MAME code | ✗ (unverified) | ? | ? | ? | ? | ? | closed |
| BigPEmu | ✗ (by design) | — | — | — | — | — | — | — | BigPImage instead |
| Virtual Jaguar libretro (2026-09-05) | 2026-08-16 | upstream ≈10a3fb1 (2026-07) | ✓ | CHT2, CHTR, **CHSE required** | **V=virtual (inverted)** | ✗ | ✓ (synthesises gap) | ✗ | refuses Jaguar CHDs without CHSE |
| Tsugaru / NP2kai / np21w | ✗ | — | — | — | — | — | — | — | MAME fmtowns/pc9821 native |
| DOSBox Pure (2026-09-15) | 2023-11-18 | own parser | **uncompressed only** | CHT2, CHTR | assumes stored | ✗ | ✗ | ✗ | `createcd -c none` only |
| DOSBox-X (2026-09-27) | 2020-11-11 | libchdr ≈5a39b15 (2024-06) | ✓ | **CHT2 only** | assumes stored | ✗ | ✗ | ✗ | no 4-frame padding in track starts |
| 86Box (2026-09-27) | 2026-07-16 | upstream ≈10a3fb1 + system zstd | ✓ | CHT2, CHTR, **DVD ✓** | V=stored | ✓ RW/RW_RAW (else Q synthesised) | ✗ | ✗ | DVD hunk%2048 |
| ares (2026-09-23) | v128 (2022-05-17) | upstream 93d8c23 (= v0.3.0) | ✓ | CHT2, CHTR | V=stored; virtual pregaps (tracks ≥2) dropped | ✗ (.sub only) | ✗ | ✗ | whole disc decoded to RAM |
| BizHawk (2026-09-26) | 2024-04-30 | chd-rs via capi (since 2024-05-03) | ✓ | CHT2, CHTR, CHCD, CHGD, CHGT, DVD | V=stored; **V+PREGAP:0 = error** | ✓ | ✗ | ✗ | DiscoHawk writes zstd/75-frame/RW CHDs |
| OpenEmu | ✗ | — | — | — | — | — | — | — | wiki: extract with chdman |
| Dolphin / xemu / RPCS3 / Cemu / Vita3K / Xenia | ✗ | — | — | — | — | — | — | — | see §12 |

---

## 14. The libchdr landscape

### 14.1 Upstream `rtissera/libchdr` timeline

Full history at `607694c` (2026-09-27), 484 commits. The only tag is `v0.3.0` → `93d8c23`, 2026-04-24. The CHANGELOG still says "Unreleased".

| Date | Commit | Change |
|---|---|---|
| 2017-07-28 | `ecfbb1f` | Initial import: MAME's old C chd code plus a CHDv5 backport (Anthony Pesch / Romain Tisserand). |
| 2018-07-24 → 08-29 | `2785de8`, `e1acac6`, `0fb7a86` | Plain `zlib` codec for non-CD images; uncompressed CHDs; a graceful error on unsupported codecs. |
| 2020-06-04 | `69cb148` | `chd_precache` backported from libretro Beetle PSX. |
| 2020-10/11 | `4ac9f9d` … `8baec6e` | Restructure ("ease libretro merging"); ekeeke's changes merged. |
| 2020-12-25 | `513aebf`, `a32a271` | **Parent/clone CHD support**; fix to the V5 parent-requirement check (SleepyMan). |
| 2021-03 | `878b5af`, `ff3175d` | libFLAC replaced by **dr_flac** (kub). |
| 2022-03-26 | `e23f32f` | LZMA and FLAC hunks in non-CD CHDs. |
| 2022-08-02 | `40ec221` | Virtual file I/O (`core_file` callbacks). |
| 2022-12-29 | `5715077` | `huff` codec (Jean-Philip Desjardins / Play!); needed for DVD/HD CHDs. |
| **2024-01-31** | `26d27ca` (#106, authored `d6f59e7` 2024-01-10, Zakk) | **`zstd` and `cdzs` codecs**; zstd 1.5.5 vendored. |
| 2024-05-26 | `56b08d5` → reverted `d1fe300` | "Merge libretro stuff, bump to 0.3" (reverted the same day). |
| 2024-10/11 | `96bdd36`…`09fa975` (Stenzek, #132) | Security fixes: map-size overflow, huffman overflow, precache bounds, duplicate codec init. |
| 2024-12-10 | `22ed569` | `read_header` in file and core_file variants. |
| 2026-02-02 → 02-11 | `a200d77`, `225b713`, `1cc6b0a`, `78e7fbc`, `ba5656f`, … (Clownacy, #141/#143) | LZMA encoder dependency removed; zlib → **miniz**; single-file zstd; codecs split into `libchdr_codec_*.c`; new file-I/O callback API; a **DVD identifier**; C++/C89 fixes. |
| 2026-04-24 | `279a42c`, `5cc52fd`, `71b898f`, `93d8c23` (**v0.3.0**) | Hardened header parser; `totalhunks` cap; `CHD_MAX_FILE_SIZE` = 1 TB. |
| 2026-04-24 → 08-25 | `405e581` … `78b0ef8` (#154) | **AVHuff (LaserDisc) decoder**. |
| 2026-08-22 | `fa36420` | LZMA dictionary-size fix: memory only; the old code allocated about 256 MB whatever the hunk size. RV32 CI; `LOWRAM_MAP`, later renamed `LOWRAM_TARGET`. |
| 2026-08-25 → 09-06 | many | Embedded targets (RP2350, ESP32-P4/S3, BL616 TangCore), RAM-budget CI, micro-flac option. |
| 2026-09-09 | `b1246d3` | **Verifies the v3/v4 hunk CRC32**; stricter for old images. |
| 2026-09-10 | `8778797` | **FLAC STREAMINFO now declares the exact block size.** Before, it declared ×2 for stereo, and dr_flac "rejects frames larger than it". |
| 2026-09-10 | `d31d8b9` | "Stop rejecting sparse CHDv5 images". The `5cc52fd` cap had rejected highly compressible images, fewer than one bit per 8 hunks, since v0.3.0. |
| 2026-09-11 | `524468e` | Closes the file and parent on every failed open. |
| 2026-09-27 | `607694c` | ANSI-C fixes (Clownacy, #196). |

Several 2026 commits carry AI-assistant co-author trailers.

Things upstream still does **not** know about (verified at `607694c`):

- The `CHSE` tag (no define in `include/libchdr/chd.h`).
- CD+G as such. It is just `SUBTYPE:RW_RAW`, which the CD codecs already carry.

### 14.2 Families of copies

1. **Upstream snapshots**, vendored or as submodules: ares, PCSX2, PCSX ReARMed, PPSSPP, Ymir, PUAE, Geargrafx, GPGX, PicoDrive (through `irixxxx/libchdr`), Virtual Jaguar, 86Box, DOSBox-X, the Beetle cores, Kronos and Yabause (very old). Most copies carry small local diffs of 0–150 lines.
2. **Maintained forks:**
   - `flyinghead/libchdr`, used by Flycast at `5f82799` (2025-04-02; upstream `cb07733` of 2024-12-11 plus 8 commits).
   - `irixxxx/libchdr`, used by PicoDrive at `e62ac59`, which equals upstream.
   - `Clownacy/libchdr`, used by clowncd.
   - stenzek's `dep/libchdr` in DuckStation (≈ upstream 2024-11-07 plus 139 diff lines; last changed 2026-02-25, CI only).
   - SwanStation's `dep/libchdr` (≈ upstream `ff1365d` of 2026-02-11 plus local changes; last 2026-06-25).
3. **The libretro-common libchdr fork** (`libretro/libretro-common@92d38df33c:formats/libchdr`):
   - A C89 rework with about 1 230 diff lines against its nearest upstream (`cb87905`, 2026-02).
   - It can build clean-room codecs instead of zlib/LZMA SDK/libFLAC: `CHD_USE_BUILTIN_DEFLATE`, `HAVE_RFLAC`, `r7z_lzma`.
   - zstd behind `HAVE_ZSTD`/`HAVE_RZSTD` from 2025-07-13; codec file from 2026-03-02.
   - Consumers: Beetle PSX (zstddeclib 1.5.7), RetroArch without rchd, clowncd's `chd_stream`.
   - Stale snapshots of it (2018, no zstd) survive in Kronos, Yabause and NP2kai.
4. **rchd** (`libretro/libretro-common@92d38df33c:formats/chd/rchd.c`, 3 160 lines, plus `FORMAT.md`, 1 068 lines):
   - A **clean-room reader** written "against observation of generated files". It first appeared **2026-07-27**, together with a clean-room Zstandard decoder `encoding_rzstd.c`.
   - Its I/O is request/feed ("No file I/O happens here"), so the caller supplies byte ranges.
   - Covers versions 1–5, every codec including `avhu`, and parent binding (`rchd_set_parent`). It **synthesises a MODE1 track for `DVD ` images** (`:2490-2515`).
   - **Default in RetroArch** (`qb/config.params.sh:145-149`: `HAVE_RCHD=yes`, `HAVE_RZSTD=yes`). Also used by NeoCD (2026-07-31), Opera (2026-08-20), SAME_CDI and LRPS2 (D1).
   - Limits that are stricter than MAME's:
     - `RCHD_MAX_HUNK_BYTES_V5` = **512 KiB** (`:178`, from the "512k maximum" comment in `chd.h:157`). chdman allows 1 MiB.
     - 64 MiB map, 4 096 metadata entries.
     - rzstd `RZSTD_WINDOW_LOG_MAX` 27; **one frame, no trailing bytes** (`rzstd.h:130-178`).
     - Codecs are compiled in per `HAVE_RCHD_*`. A missing codec fails the hunk, not the open.
   - **Naming inversion:** `pregap_stored = (pg[0] != 'V')` (`rchd.c:2550-2560`), with a comment saying V means virtual. Consumers (`streams/chd_stream.c:546-555`, Opera) use the flag so that the resulting behaviour matches MAME. Anyone porting rchd's comments as documentation will get it backwards.
5. **chd-rs** (`SnowflakePowered/chd-rs@f6cdb77036`, crate `chd` 0.3.4, 2026-03-03, about 75 k downloads):
   - Pure safe Rust. Codecs: flate2/zlib-rs, lzma-rs, claxon FLAC, ruzstd (or zstd-safe), huff, **avhuff**, and all CD codecs. `verify_block_crc` is optional.
   - Consumers: BizHawk (through `chd-capi`), jgenesis, and crates `rom-weaver-containers` and `rom-analyzer`.
   - claxon decodes raw FLAC frames **without** a synthesised STREAMINFO, so block size is not limited. It is more lenient than libchdr.
   - `rchdman`, a read-side CLI, is in the repo.
6. **MAME-derived C++:** WinUAE (≈2013, no zstd), Amiberry and FS-UAE (MAME-util era with zstd, no `CHSE`), SAME_CDI (MAME API over rchd), and CD-i Emulator.
7. **Custom minimal readers:** DOSBox Pure (uncompressed only).
8. **Other languages:**
   - Go: `github.com/ZaparooProject/go-gameid/chd` (codec constants for all including zstd/cdzs; parent-aware header; tags CHT2/CHTR/CHCD/GD) and `github.com/sargunv/rom-tools/lib/chd` (tags include `DVD `). **Implementation depth unverified.**
   - Python: no maintained PyPI reader was found. Projects use ctypes to libchdr (e.g. psxrecomp PR #370). "xVerter" claims native CHD read/write with every codec including zstd **(unverified)**.
   - JS/Node: `emmercm/chdman-js` wraps chdman binaries (used by igir). "RetroShrink" is a browser chdman-in-WASM, a direct Discpress analogue **(unverified)**.
   - .NET: BizHawk through chd-rs.

### 14.3 Vendored libchdr per emulator (D2 targets plus the D1 zstd column)

"= X" means the blob is identical to that upstream version. "≈ X (n)" means nearest upstream version with *n* differing lines (whitespace ignored). "Last sync" is the last commit touching the vendored directory.

| Emulator | Path | Base | Last sync | zstd compiled |
|---|---|---|---|---|
| **D1: DuckStation** | `dep/libchdr` | ≈ `09fa975` 2024-11-07 (139) | 2026-02-25 (CI); code 2024-11-07 | ✓ (system/vendored zstd, `CMakeLists.txt:18`) |
| **D1: SwanStation** | `dep/libchdr` | ≈ `ff1365d` 2026-02-11 (47) | 2026-06-25 | ✓ zstddeclib 1.5.7 |
| **D1: Beetle PSX** | `libretro-common/formats/libchdr` | lr-common fork | 2026-09-01 (resync) | ✓ `HAVE_ZSTD` + zstddeclib 1.5.7 |
| **D1: PCSX ReARMed** | `deps/libchdr` (git subrepo) | = `9ccd3a7` 2026-08-22 | 2026-08-27 | ✓ zstddeclib 1.5.7 (`Makefile:316-346`) |
| **D1: PCSX2** | `3rdparty/libchdr` | = `a200d77` 2026-02-02 (PR 7891cbe) | 2026-03-11 | ✓ (`Zstd::Zstd`) |
| **D1: PPSSPP** | `ext/libchdr` (submodule) | = `8bba774` 2025-06-08 | pointer at HEAD; a 2026-02-23 bump appears reverted by `c74e212` (inferred) | ✓ (`ext/zstd`) |
| **D1: Flycast** | `core/deps/libchdr` (submodule) | flyinghead/libchdr `5f82799` 2025-04-02 (base `cb07733`) | 2025-04-02 | ✓ zstd 1.5.6 |
| **D1: RetroArch** | `libretro-common/formats/chd` + `…/libchdr` | **rchd** default (2026-07-27) + lr-common libchdr | 2026-09-27 | ✓ rzstd (`HAVE_RZSTD=yes`) |
| ares | `thirdparty/libchdr` | = `93d8c23` (v0.3.0) 2026-04-24 | ? | ✓ 1.5.7 |
| Ymir | `vendor/libchdr/libchdr` (submodule) | = `6cde534` 2026-07-19 | 2026-07-27 | ✓ |
| Virtual Jaguar | `deps/libchdr` | ≈ `10a3fb1` 2026-07-18 (6) | 2026-08-21 | ✓ (unity) |
| 86Box | `src/cdrom/libchdr` | ≈ `10a3fb1` 2026-07-18 (13) | 2026-08-21 | ✓ (system zstd) |
| Geargrafx | `platforms/shared/dependencies/libchdr` | ≈ `22ed569` 2024-12-10 (77) | 2026-07-28 | ✓ zstddeclib |
| GPGX standalone | `core/cd_hw/libchdr` | ≈ `22ed569` 2024-12-10 (90) | 2025-10-19 | ✓ 1.5.6 |
| GPGX libretro | `libretro/deps/libchdr` | ≈ `5a39b15` 2024-06-15 (82) | 2025-06-22 | ✓ (`deps/zstd`) |
| PicoDrive (both) | `pico/cd/libchdr` → irixxxx/libchdr | = `e62ac59` 2024-06-13 | 2024-06-15 | ✓ 1.5.6 |
| PUAE | `deps/libchdr` | = `5a39b15` 2024-06-15 | 2024-09-23 | ✓ |
| DOSBox-X | `src/libs/libchdr` | ≈ `5a39b15` 2024-06-15 (114) | 2024-07-08 | ✓ |
| Beetle Saturn | `deps/libchdr` | ≈ `5a39b15` (127) | 2026-06-29 | ✓ (2025-06-22) |
| Beetle PCE | `deps/libchdr` | ≈ `5a39b15` (77) | 2025-06-22 | ✓ |
| Beetle PCE Fast | `deps/libchdr` | ≈ `5a39b15` (145) | 2026-06-26 | ✓ |
| Beetle PC-FX | `deps/libchdr` | ≈ `5a39b15` (77) | 2026-08-23 | ✓ (2026-08-23) |
| **Beetle SuperGrafx** | `deps/libchdr` | ≈ `878b5af` 2021-03-11 (33) | 2022-02-05 | **✗** |
| **Kronos** | `yabause/src/tools/libchdr` | ≈ `96a2ce8` 2018-09-14 (84) | 2024-10-23 | **✗** |
| **Yabause / YabaSanshiro (libretro)** | `yabause/src/libchdr` | = `8baec6e` 2020-11-02 | 2021-12-31 | **✗** |
| **BlastEm (libretro)** | `libchdr/` | copy with `zstd_stub.c` | 2026-08 | **✗ (stub)** |
| clowncd | submodule → Clownacy/libchdr `7d039c3` | ≈ v0.3.0 + fixes | 2026-09-26 | ✓ |
| NeoCD | lr-common **rchd** | — | 2026-07-31 | ✓ (`HAVE_RCHD_ZSTD`) |
| **Opera** | lr-common **rchd** | — | 2026-08-20 | **✗** |
| SAME_CDI | lr-common **rchd** | — | 2026 | ✓ (`HAVE_RZSTD`) |
| **WinUAE** | `archivers/chd` (MAME C++) | ≈ MAME 2013 | 2026-05-31 | **✗** |
| Amiberry | `src/archivers/chd` (MAME C++) | MAME-util era | 2025-06-30 | ✓ (optional; ✗ iOS) |
| FS-UAE master | `mame/src/lib/util` | MAME-util era | 2025 | ✓ (libzstd) |
| BizHawk / jgenesis | chd-rs | 0.3.1 / 0.3.x | 2024-05 / — | ✓ |
| DOSBox Pure | own | — | 2024-09-07 | n/a (uncompressed only) |

### 14.4 Observations on sync cadence

- The libretro cores that took the June 2025 zstd sweep (GPGX-lr, Beetle PCE/PCE Fast/Saturn, all "Update libchdr + add zstd" on 2025-06-22) have not moved the libchdr base since. They sit at 2024-06, which is **before** Stenzek's 2024-10/11 security fixes. SuperGrafx missed the sweep. PC-FX took it only in 2026-08.
- Standalone projects with an active maintainer resync within months: ares, PCSX2, PCSX ReARMed, Ymir, 86Box, Virtual Jaguar.
- Projects that forked early (Kronos 2018, Yabause 2020, WinUAE 2013) essentially never resync.
- libretro is moving its own frontend and several cores to **rchd**, a separate implementation with its own limits. Compatibility with upstream libchdr is no longer enough; rchd has to be tested as well.

---

## 15. What would break if the fork changed X

### 15.1 Making zstd/cdzs part of the default codec list

- **Hard failures at open** (the header lists an unknown codec):
  - Kronos (standalone and libretro);
  - libretro Yabause and YabaSanshiro;
  - Beetle SuperGrafx;
  - WinUAE;
  - libretro BlastEm (explicit stub);
  - MAME < 0.262;
  - CD-i Emulator (unverified);
  - FS-UAE 3.x release builds (unverified);
  - Amiberry iOS / `USE_ZSTD=OFF`;
  - DOSBox Pure (which already fails on any compressed image);
  - any core binary older than its zstd date: GPGX-lr and Beetle PCE/PCE Fast/Saturn before 2025-06-22; GPGX standalone before 2025-07-24; PicoDrive before 2024-05-24; PUAE before 2024-09-23; Beetle PC-FX before 2026-08-23; D1's list for RetroArch ≤ 1.21.
- **Failures only on hunks that actually use zstd:** Opera (rchd without zstd).
- **Consequence.** Merely listing `cdzs` as a fourth candidate, as `chdman -c cdlz,cdzl,cdfl,cdzs` does, is already fatal for every libchdr/MAME reader that lacks zstd, even if no hunk ends up using it. A zstd mode must be an explicit opt-in with a clear warning. The warning should name at least 3DO (Opera), Saturn (Kronos/Yabause), SuperGrafx CD, and Amiga (WinUAE).
- **If zstd is ever emitted:** one zstd frame per hunk (and per cdzs sub-stream), no skippable frames, no trailing bytes, `windowLog ≤ 27`. rchd enforces all of these (`rzstd.h:130-178`). MAME's writer satisfies them because it uses `ZSTD_compressStream2(…, ZSTD_e_end)` in one call (`chdcodec.cpp:1064-1080`).

### 15.2 Hunk sizes

- **Must be a multiple of 2448 for CD images.** chdman already enforces this. GPGX, PicoDrive, ares, Geargrafx, NeoCD, WinUAE and DOSBox Pure reject anything else; the Beetle cores silently mis-index.
- **Never larger than 512 KiB.** rchd (RetroArch frontend, NeoCD, Opera, SAME_CDI) rejects larger v5 hunks, and MAME's own header comment says "512k maximum". chdman's 1 MiB limit is not safe.
- **Larger hunks cost memory and seek latency** on weak devices: Wii/GC GPGX, PSP/Vita/3DS PicoDrive builds, and MCU/FPGA targets. The new embedded libchdr targets (RP2350 520 KB SRAM, ESP32, BL616 TangCore) are budgeted at default sizes; a `cd_cdzs` budget is 400 KB. Geargrafx caches every hunk it touches. The Beetle cores keep one hunk. ares decodes the whole disc anyway.
- **Smaller hunks** mostly cost ratio, since there is more per-hunk overhead and less FLAC/LZMA context. Geargrafx refuses more than 500 000 hunks, i.e. a hunk under about 1.4 KB for an 80-minute disc. That cannot happen at 2448-byte granularity.
- **Precedent:** BizHawk's DiscoHawk already writes 75-frame (183 600-byte) zstd CHDs. They load in chd-rs/libchdr readers, but not in non-zstd readers or in Beetle (because of `SUBTYPE:RW`).
- **Recommendation:** keep 19 584 for CD.

### 15.3 New metadata (sessions, CD+G)

- **`CHSE`** (only when the source has more than one session):
  - **Breaks** Kronos, libretro Yabause/YabaSanshiro (wildcard loop with `default: return -1`) and jgenesis (hard error on any non-track entry).
  - Ignored by readers that query `CHT2` by index: GPGX, PicoDrive, Beetle, Geargrafx, ares, NeoCD/Opera (rchd), PUAE, WinUAE/Amiberry (old MAME), DOSBox-X, 86Box, BizHawk, Ymir. These flatten the disc.
  - **Required** by Virtual Jaguar for Jaguar CD.
  - MAME's CHD path records the session but does not add the ~11 400-frame gap; readers must synthesise it, as Virtual Jaguar does.
  - Multi-session systems in Discpress's list:
    - Jaguar CD, always;
    - Enhanced/CD-Extra PC discs;
    - some CD-i and PC-98 titles (unverified);
    - Saturn/PCE rarely.
  - Recommendation: emit `CHSE` exactly as MAME post-0.289 does (Discpress's pinned tree already does). Document that Kronos, Yabause and jgenesis users need the flattened (pre-#15886) form. If an "old-reader compatible" option is wanted, the only way to provide it is to *omit* `CHSE`, which in turn breaks Virtual Jaguar.
- **CD+G** (`TRACK nn CDG` → `TYPE:AUDIO SUBTYPE:RW_RAW`) and any stored subcode (from CCD/SUB or CDG sources):
  - **Breaks the entire disc** in Beetle PCE, PCE Fast, SuperGrafx, PC-FX and Saturn (`SUBTYPE` must be `NONE`). D1 reports that Flycast ≤ v2.7 does the same.
  - Harmless in GPGX, PicoDrive, ares, NeoCD, Geargrafx, Ymir, jgenesis, Kronos and DOSBox-X, which skip the 96 bytes.
  - *Used* by MAME, WinUAE/PUAE/Amiberry (CD32/CDTV CD+G), libretro BlastEm, BizHawk and 86Box.
  - Recommendation: never add subcode unless the source carries it. When it does (CDG), the UI should say that Beetle cores will refuse the image.
- **New track tags or reformatted `CHT2` text:**
  - A new tag (a hypothetical `CHT3`) would be invisible to every reader.
  - Appending fields to `CHT2` is tolerated by the sscanf, regex and key:value parsers.
  - Changing the field order or spacing would break sscanf- and regex-based readers (NeoCD, Kronos, Beetle PCE family).

### 15.4 Pregap storage (and postgap/padding)

**Status quo, which should be kept.** Pregap frames present in the source file (INDEX 00 in-file) are stored and flagged `PGTYPE:V<type>`. Pregaps from `PREGAP` commands are virtual. `POSTGAP` is written but never stored.

**If the fork stored every pregap as virtual** (for instance to save space or to normalise; zero-filled pregaps compress to almost nothing anyway), it would **break**:

- Beetle Saturn;
- Kronos and Yabause/YabaSanshiro;
- Ymir (audio);
- jgenesis;
- DOSBox-X and DOSBox Pure;
- NeoCD (track 3 onwards);

because all of these assume stored pregaps. ares would also shorten the TOC. BlastEm-libretro and Virtual Jaguar would *still* be wrong, because they take a non-`V` pregap to be stored. Both are correct only when `PREGAP=0`.

**If the fork stripped pregaps altogether** (`PREGAP:0`, INDEX 00 audio dropped, later tracks moved 150 frames earlier; TOSEC style, like the GD-ROM `-rp` option of MAME #15808), every reader would compute consistent offsets. But the disc image would no longer match Redump: the TOC changes, the pregap audio and data are lost, and track hashes change. That is not acceptable as a default. It could be an explicit "legacy readers" option for BlastEm and Virtual Jaguar users.

**If the fork stored pregaps without the `V` flag**, it would break GPGX, PicoDrive, the Beetle PCE family, Geargrafx, ares, 86Box, BizHawk and the MAME-derived readers.

**If the fork wrote `V` with `PREGAP:0`**, BizHawk would throw "Malformed CHD".

**Stored track-1 pregaps** (a CUE whose track 1 has an INDEX 00 in-file) put INDEX 01 at LBA 150 (MSF 00:04:00) in the Beetle cores and Geargrafx, which always add a virtual 150 on top. MAME's own `logframeofs` model and ares (`chd.hpp:120-150`) yield the same LBA. GPGX maps it to LBA 0. Readers therefore disagree, and the fork should not *create* track-1 pregaps that the source does not have.

**Postgap:** readers that add `POSTGAP` to the CHD offset (Beetle PCE family, Geargrafx) versus MAME (not stored). Writing non-zero `POSTGAP` corrupts track offsets in those cores. Emit `POSTGAP` only when the source CUE has one.

**4-frame padding** is part of the format. Ymir (audio) and DOSBox-X ignore it and are already off by 0–3 frames per track; the fork cannot fix that.

**BigPEmu's objection** ("common tool paths stripping important data from pregap areas") refers to Jaguar CD pregap data that CUE/BIN-derived CHDs do not carry. A Discpress fork cannot recover data the source does not contain. It should warn that CUE/BIN → CHD for Jaguar CD may lose authentication-relevant pregap audio, as Virtual Jaguar's docs also say.

### 15.5 Parent CHDs

- **Nothing in this lane can load them except MAME.** MAME resolves parents only through romload (software lists and ROM sets); `-cdrom` loads cannot.
- libchdr supports parents via its API (since 2020-12-25), and rchd has `rchd_set_parent`. But every emulator examined passes `NULL`, or refuses parent reads: NeoCD (`chdfile.cpp:31-35`), Opera, SAME_CDI (unverified).
- Recommendation: do not offer parent/diff output for these systems.

### 15.6 DVD versus CD

- **A `createdvd` image (`DVD ` tag, 2048-byte units) for any system in this lane fails** in GPGX, PicoDrive, Beetle, Geargrafx, ares, NeoCD, WinUAE, DOSBox Pure/X and MAME's CD drivers:
  - some fail on `hunk % 2448`;
  - some find no `CHT2`;
  - MAME's `check_is_cd` fails with `dvd_compat` false.
- It works only in 86Box, BizHawk (synthesised track) and rchd-based readers. For rchd consumers such as Opera the synthesised MODE1 track is **untested**.
- For generic PC data discs (`pc`):
  - `createcd` is the compatible choice for DOSBox-X/Pure;
  - 86Box takes either.
- MAME's own `dvdrom_file` needs **`-hs 2048`**, while chdman's default is 4096. That is a MAME inconsistency worth reporting upstream.

### 15.7 Encoder tuning inside the existing codecs

- **cdlz/lzma:**
  - Readers rebuild the LZMA properties from `level` and `reduceSize = hunkbytes`, and they are not stored (`chdcodec.cpp:1312-1317`, `1343-1364`).
  - Encoder `lc/lp/pb` must stay 3/0/2. A different dictionary, `fb`, match finder or level is fine, as long as the dictionary covers the hunk.
  - Pre-2026-08 libchdr assumes level 9, current libchdr and MAME assume level 6; both are at least the hunk size.
- **cdfl/flac:**
  - Readers synthesise STREAMINFO from `blocksize(hunkbytes)`: the payload/4, halved until ≤ 2352.
  - dr_flac (libchdr) and rflac (rchd) reject frames larger than the declared maximum. Since `8778797` (2026-09-10) libchdr declares the exact value; older copies allowed ×2.
  - **FLAC blocks must be ≤ MAME's `blocksize()`.** Smaller or variable blocks are fine for dr_flac. chd-rs/claxon does not care.
  - The hd `flac` codec keeps its `L`/`B` endianness byte.
- **cdzl/zlib:** raw DEFLATE (no zlib header). Any compliant deflate encoder (zopfli, libdeflate) is compatible.
- **CD codec framing:** the ECC-strip bitmap, subcode-stream split and length-field width are fixed by format. Changing them needs a new codec tag, which no reader would have.

### 15.8 Identity side-effects

- The overall CHD SHA-1 covers metadata (`CHD_MDFLAGS_CHECKSUM` default, `chd.h:356-358`, `chd.cpp:1857-1873`). Adding `CHSE`, CD+G subtypes or different pregap flags changes the SHA-1 compared with 0.289-made files. MAME software lists will report wrong checksums, and DAT-based managers will see a different file.
- Codec and hunk-size choices change neither `rawsha1` nor `sha1`.

---

## 16. Implications for a Discpress fork

1. **Default output = chdman 0.289's CD layout.**
   - `cdlz,cdzl,cdfl`; 19 584-byte hunks; no zstd *listed*; stored `V` pregaps exactly as the CUE implies; `POSTGAP` only from the CUE; `SUBTYPE:NONE` unless the source has subcode; no parent.
   - Treat this as a compatibility contract. The UI's "compatibility" copy should list Opera, Kronos, Yabause, Beetle SuperGrafx, WinUAE and libretro BlastEm as zstd-incapable.
2. **zstd:**
   - Offer it only as an explicit per-job opt-in (for the PS1/PS2/Dreamcast crowd; see D1).
   - When on, list only the codecs actually wanted.
   - Guarantee one frame per hunk with window ≤ 2^27.
   - Disable it, or warn prominently, for `3do`, `saturn`, `cd32`/`cdtv` and `pcecd` (SuperGrafx core).
3. **Sessions:** keep writing `CHSE` for multi-session CUEs, since Virtual Jaguar requires it for `jagcd`. Warn for `saturn` (Kronos/Yabause) and `segacd` (jgenesis) when a multi-session source is detected. Consider an option to flatten, i.e. omit `CHSE`.
4. **CD+G/subcode:** support it (MAME post-0.289 does), but surface "Beetle cores (PCE, PC-FX, Saturn) will refuse discs with subcode". Default to not storing subcode for game systems.
5. **Hunk size:** keep 8 frames for CD. If a larger size is offered, cap it at 512 KiB and at a multiple of 2448, and warn about memory on handhelds, Wii and MCU/FPGA targets.
6. **DVD vs CD:** never use `createdvd` for CD systems. For the `pc` data-disc path use `createcd`. If a DVD mode exists, offer `-hs 2048` so that MAME's `dvdrom_file` can load it.
7. **GameCube/Wii:** don't produce CHD. Point users to RVZ, since no emulator reads GC/Wii CHDs.
8. **Jaguar CD:** warn that CHDs made from CUE/BIN can lack pregap data that BigPEmu, and real-BIOS authentication, need. BigPEmu will not load CHD at all.
9. **Test matrix for the fork's CI:** at least upstream libchdr (current and 2024-06 `5a39b15`), rchd with and without `HAVE_RCHD_ZSTD`, chd-rs, and MAME's `cdrom_file`. Add three behavioural oracles:
   - Beetle Saturn-style "assumes stored";
   - Kronos-style "wildcard metadata";
   - BlastEm/Virtual Jaguar-style "V=virtual".

   For every output shape, assert CD-DA sample offsets at INDEX 01 of each track.
10. **Upstream bug reports worth filing:**
    - BlastEm-libretro and Virtual Jaguar: inverted PGTYPE.
    - rchd: misleading `pregap_stored` naming and comment.
    - Kronos/Yabause/jgenesis: fail on unknown metadata tags.
    - Ymir/DOSBox-X: missing 4-frame padding.
    - MAME: `dvdrom_file` 2048-byte hunk requirement vs the chdman 4096 default.
    - BizHawk: throw on `V` with `PREGAP:0` (harmless unless a writer emits that).

---

## 17. Open questions

1. What do real Redump Jaguar CD CUEs contain? Do tracks in session 2 carry INDEX 00 in-file (`PGTYPE:VAUDIO PREGAP>0`)? If so, Virtual Jaguar's inverted handling breaks real dumps, not only homebrew. This needs one real CUE plus the pinned chdman.
2. Has BlastEm-libretro's inverted `V` handling actually been observed on real Sega CD CHDs? Expected: CD-DA 2 s late plus TOC drift. Check its issue tracker, or run a test.
3. What CHD support does upstream BlastEm (retrodev hg) have, if any?
4. Standalone Yaba Sanshiro (devmiyax): which libchdr, zstd, and metadata loop? The repo was not reachable.
5. What are the CHD status and zstd capability of FS-UAE 3.x releases, CD-i Emulator, Phoenix, SSF and MesenCE?
6. Does rchd's synthesised DVD track make Opera/NeoCD/SAME_CDI accept `createdvd` images? It would be harmless but surprising.
7. Is SAME_CDI's parent path reachable from its disc loader?
8. Do any Saturn, PCE CD or PC-98 titles in Redump carry more than one session, so that `CHSE` would affect Kronos/Yabause/jgenesis users?
9. Should the fork offer a "legacy" mode that omits `CHSE` and matches 0.289 SHA-1s? This interacts with MAME software lists and DATs (lanes B/E).
10. Old libchdr copies declare FLAC block size ×2. Do any readers use a FLAC decoder (other than dr_flac, rflac, claxon or libFLAC) with a different acceptance rule? The one to check is the "micro-flac" MCU backend (2026-09).

---

## Appendix A: repositories and commits examined

The short SHA is HEAD as cloned on 2026-09-27; the date is the HEAD commit date.

- ekeeke/Genesis-Plus-GX@939ce4f045 (2026-09-23)
- libretro/Genesis-Plus-GX@c2838c7dc4 (2026-09-12)
- irixxxx/picodrive@25c511bb41 (2026-09-25)
- libretro/picodrive@1890c29322 (2026-09-26)
- libretro/blastem@1e0de94dc7 (branch `libretro`, 2026-09-26)
- Clownacy/clownmdemu-frontend@4c63cc3a68 → clownmdemu-frontend-common@ab6f9cc → clowncd@c899e59 → Clownacy/libchdr@7d039c3
- jsgroth/jgenesis@d19ee94f64 (2026-09-12)
- ares-emulator/ares@4cb8d92b44 (2026-09-23)
- libretro/beetle-saturn-libretro@65f05fa66f (2026-09-26)
- FCare/Kronos@d451a55253 (2026-07-18)
- libretro/yabause@8926b0c6c3 (master, 2026-05-30); libretro/yabause@09ed8e5 (branch `yabasanshiro`, 2026-08-23)
- StrikerX3/Ymir@3916405b6e (2026-09-27)
- libretro/beetle-pce-libretro@b96c11e095; libretro/beetle-pce-fast-libretro@1c693c6301; libretro/beetle-supergrafx-libretro@3c6fcd3ded; libretro/beetle-pcfx-libretro@c1650bad5f
- drhelius/Geargrafx@d9ad69222e (2026-09-27)
- SourMesen/Mesen2@b9fa69ddc6 (2026-06-04)
- libretro/neocd_libretro@3118c69017 (2026-08-30)
- libretro/opera-libretro@a501a278d0 (2026-08-21)
- libretro/libretro-uae@6536174a80; tonioni/WinUAE@d42db956c3; FrodeSolheim/fs-uae@f362278ccd; BlitterStudio/amiberry@209103d782
- libretro/same_cdi@ff9bb99a50; libretro/mame@9069f39340
- libretro/virtualjaguar-libretro@f9a3c89f58 (2026-09-05)
- captainys/TOWNSEMU@e27adde120; AZO234/NP2kai@5939e0c6d5
- schellingb/dosbox-pure@73e03aa145; joncampbell123/dosbox-x@6a2afec327; dosbox-staging/dosbox-staging@c8ad29d897; 86Box/86Box@bfcf8558a1
- TASEmulators/BizHawk@262fc6cfe4; OpenEmu/OpenEmu@1d20510464
- dolphin-emu/dolphin@bb3558a70e; xemu-project/xemu@f9b14039e5; RPCS3/rpcs3@3fa07db78b; cemu-project/Cemu@c717fcab1c; Vita3K/Vita3K@610e6970ad; xenia-canary/xenia-canary@c332733afd
- D1 column: stenzek/duckstation@a2edf2d0f0; libretro/swanstation@b6c30a7b27; libretro/beetle-psx-libretro@d50a9d0da3; libretro/pcsx_rearmed@ff81ed17a1; PCSX2/pcsx2@36907f4b70; hrydgard/ppsspp@9fc4eb3e4d; flyinghead/flycast@ea087b9140 (+ flyinghead/libchdr@5f82799); libretro/RetroArch@520097d511
- rtissera/libchdr@607694c (full history); libretro/libretro-common@92d38df33c (full history); SnowflakePowered/chd-rs@f6cdb77036
- mamedev/mame@76c7d197ed (local `third_party/mame`, tags up to mame0289 = 2026-07-30)

**Web sources:**

- mednafen.github.io/documentation
- richwhitehouse.com/jaguar/index.php?content=faq
- ares-emu.net/news/ares-v128-released
- github.com/OpenEmu/OpenEmu/wiki/User-guide:-CD-based-games
- github.com/libretro/blastem/commits/libretro/chdimage.c
- github.com/TASEmulators/BizHawk commit list for `CHD_format.cs`
- github.com/stenzek/duckstation, PCSX2/pcsx2 and hrydgard/ppsspp commit lists for their libchdr directories
- github.com/joncampbell123/dosbox-x commit list for `src/libs/libchdr`
- cdiemu.org
- simk98.github.io/np21w
- github.com/FrodeSolheim/fs-uae/issues/165
- github.com/libretro-mirrors/beetle-saturn-libretro/issues/162
- pkg.go.dev/github.com/ZaparooProject/go-gameid/chd
- pkg.go.dev/github.com/sargunv/rom-tools/lib/chd
- crates.io API (`chd` reverse dependencies)
