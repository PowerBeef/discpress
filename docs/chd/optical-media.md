# (C) The optical-media model in CHD: CD, GD-ROM and DVD

> Part of the [Discpress chdman research dossier](README.md), 2026-09-27. Written by a research agent from source reading and experiments. `$SP/...` paths name artefacts in the temporary research workspace, which is not part of the repository (reproducible lab tooling is in [lab/](lab/)). Lane letters (A, B, C, D1, D2, E, G) refer to the reports listed in the README.

Research dossier for the Discpress chdman fork. Lane C covers the disc-level semantics: input parsing, metadata, pregaps and padding, sessions, subcode and CD+G, extraction, fidelity against Redump, and which discs and image formats can or cannot be represented.

- Author: research agent C. Date: 2026-09-27.
- Source studied: MAME `76c7d197ed` (`mame0289-1167`, in `/home/user/discpress/third_party/mame`). The Discpress patch only touches `chd.cpp`, `chd.h` and `chdman.cpp`, and only under `__EMSCRIPTEN__`. `cdrom.*`, `dvdrom.*` and `chdcodec.cpp` in the tree are identical to 76c7d19. Line numbers for `chdman.cpp`, `chd.cpp` and `chd.h` are cited from the pristine blob (`git show HEAD:…`), not from the patched working tree.
- Reference build of the official release: MAME tag `mame0289` (`f34f02505e`, 2026-07-30), built natively from source with the Discpress Makefile. It is called **0.289** throughout; **HEAD** means 76c7d19, the code Discpress ships.
- All claims marked **[exp]** were reproduced in `$SP/exp/...`, where `$SP=$SP`. The tools are listed in the appendix. Anything not verified is marked **[unverified]**.

---

## 0. Executive summary (the findings that matter most)

1. **HEAD, and so today's Discpress, produces broken Dreamcast/Naomi CHDs from `.gdi` input.** Post-0.289 commit `ac47a71ce1` (#15870, 2026-08-10) turns the SD-area gap before track 2 into a *virtual* pregap. Every high-density track then sits **150 sectors late** in MAME's reader (`logframeofs` 45150 instead of 45000) and in Flycast's layout rules (track 3 at FAD 45300 instead of 45150) **[exp]**. MAME's GD-ROM consumers use logical LBAs: `gdrom.cpp` reports `get_track_start()+150`, and `naomigd.cpp:913` hard-codes `read_data(45000+16)`. GDI→CHD→GDI still round-trips byte-exactly **[exp]**, which is why the upstream PR (tested only by round-tripping) and Discpress's own tests (which compare against a native build of the same code) do not notice. The official 0.289 places track 3 at 45000 for both `.gdi` and Redump `.cue` **[exp]**.
2. **HEAD is not "0.289".** Discpress prints `0.289 (mame0289-76c7d19 wasm)`. Its release notes (`.github/release-notes/v1.1.0.md:41`, `v1.1.1.md:31`, `v1.2.0.md:28`) promise CHDs "exactly the same, byte for byte, as desktop chdman 0.289", and `app/help.html:49` claims the "same chdman code … with identical data checksums". Compared with the real 0.289 release:
   - (a) every CD/DVD CHD differs in compressed bytes, because `c23567b509` changed the LZMA level from 8 to 6. The logical SHA-1 is unchanged. This is the *only* cause: HEAD, including its LZMA 26.02 SDK, rebuilt with the level set back to 8 produces files **byte-identical to official 0.289** on the PS1, Sega CD, ISO-as-CD and DVD fixtures, and both versions verify each other's output **[exp `$SP/src/buildlvl8`]**.
   - (b) GD-ROM CHDs have a different layout and SHA-1 for both `.cue` and `.gdi` input.
   - (c) multi-session CDs get a new `CHSE` tag, which changes the overall SHA-1.
   - (d) `TRACK nn CDG` cues are accepted (0.289 rejects them).
3. **Sessions are still structurally lost.** The new `CHSE` tag (#15886/#15931) records only session *numbers*. The ~11 400-sector lead-out/lead-in/pregap gap is not stored anywhere, so session-2 data is served ~11 400 LBAs too early. That breaks ISO9660 on Enhanced CDs, MIL-CDs and Jaguar CDs in MAME **[exp]**. Flycast works around this with a heuristic; other readers do nothing. The `CHSE` parser also depends on metadata *order*: two foreign tags before it, or one tag between sessions, silently collapses everything into session 1 **[exp]**.
4. **Track data round-trips bit-exactly.** A Redump split-bin cue sent through createcd and then `extractcd --splitbin` returns identical bins, and without `--splitbin` it returns their exact concatenation. Bad or odd sectors are preserved: the CD codec only strips ECC it can regenerate **[exp]**. The loss is in the *cue*. Across **72 022 real Redump cue sheets** (21 systems), chdman can reproduce 77 % of them structurally. It fails on CATALOG (PCE 77 %, SS 70 %, MCD 73 %, 3DO 63 %), FLAGS, ISRC, INDEX ≥ 02, the `CDI/2352` type string and the single-track file naming, and it always writes LF instead of Redump's CRLF.
5. **The cue parser has long-standing bugs that silently corrupt data** (all present in 0.289 too) **[exp]**:
   - MOTOROLA files are byte-swapped twice;
   - a file shared by tracks after the first file gets wrong offsets;
   - several tracks in one WAV are mis-sized;
   - EAC "gaps appended to previous track" cues produce `PREGAP:-300`;
   - NRG pregaps shift later tracks;
   - `.iso` files holding raw 2352-byte sectors whose count is a multiple of 128 or 146 are mis-typed;
   - the cdrdao TOC parser ignores PREGAP, SILENCE, ZERO and multiple FILEs, treats START as a virtual pregap, and gives 0 frames when no length is given.

   Robustness bugs **[exp]**:
   - any input that yields 0 tracks makes createcd spin forever at `-nan%`: an empty or lowercase cue, `TRACK 00`, a CloneCD `.ccd`, a lone `.bin`, a cdrdao TOC without explicit lengths, and by inference a binary redumper `.toc`;
   - a cue with 100 tracks segfaults, and a GDI with 100 tracks aborts;
   - `extractcd` on a DVD CHD aborts;
   - `extractdvd` on a CD CHD silently writes 2448-byte frames as an ".iso".
6. **MAME's own DVD reader cannot open default `createdvd` output.** `dvdrom_file` requires 2048-byte hunks (`dvdrom.cpp:55`), but chdman has defaulted to 4096 since 0.263 **[exp]**. libchdr readers are unaffected.
7. **There is a compatible way to add fidelity metadata.** New tags written *without* `CHD_MDFLAGS_CHECKSUM` and appended after the CD tags do not change the CHD's SHA-1 **[exp]**, and every existing reader ignores them. A fork can therefore carry CATALOG, ISRC, FLAGS, index points, session gaps, CD-TEXT and the original cue text while staying SHA-1-identical to plain chdman.

---

## 1. The CD data model in CHD

### 1.1 Frames, units, hunks

| Constant | Value | Source |
|---|---|---|
| `MAX_SECTOR_DATA` | 2352 | `cdrom.h:31` |
| `MAX_SUBCODE_DATA` | 96 | `cdrom.h:32` |
| `FRAME_SIZE` (= CHD unit size) | 2448 | `cdrom.h:35` |
| `FRAMES_PER_HUNK` (default) | 8, so the hunk is 19 584 bytes | `cdrom.h:36`, `chdman.cpp:2199` |
| `TRACK_PADDING` | 4 frames | `cdrom.h:28` |
| `MAX_TRACKS` / `MAX_INDEX` | 99 / 99 | `cdrom.h:30,33` |
| `GDI_HIGH_DENSITY_AREA` | 45000 (post-0.289 constant; 0.289 used the literal) | `cdrom.h:40` |

- Every CD CHD stores **2448-byte frames**: `datasize` bytes of sector data, zero-filled up to 2352, then `subsize` bytes of subcode (zeros when the track has none).
  - A `MODE1/2048` track stores 2048 data bytes plus 400 zero bytes per frame.
  - An `AUDIO RW_RAW` track stores 2352 + 96 bytes.
  - Framing happens in `chd_cd_compressor::read_data` (`chdman.cpp:439-539`), which `memset`s each frame and reads `datasize+subsize` bytes.
- The hunk size may be any multiple of 2448 (`-hs`). MAME's reader only checks `hunk_bytes % 2448 == 0` and `unit_bytes == 2448` (`cdrom.cpp:253-256`).
- Logical size is Σ(frames + extraframes) × 2448 (`chdman.cpp:2213-2220`).

### 1.2 Track types and subcode types

`get_info_from_type_string` (`cdrom.cpp:644-726`) accepts the same strings for cue and TOC input. `get_type_string` (`cdrom.cpp:841-855`) is what goes into metadata. `output_track_metadata` (`chdman.cpp:1531-1633`) is what extraction writes.

| Input token(s) (cue/toc) | Enum | datasize | CHD `TYPE:` | cue written by extractcd | GDI type code |
|---|---|---|---|---|---|
| `MODE1`, `MODE1/2048` | `CD_TRACK_MODE1` | 2048 | `MODE1` | `MODE1/2048` | 4 |
| `MODE1_RAW`, `MODE1/2352` | `CD_TRACK_MODE1_RAW` | 2352 | `MODE1_RAW` | `MODE1/2352` | 4 |
| `MODE2`, `MODE2/2336` | `CD_TRACK_MODE2` | 2336 | `MODE2` | `MODE2/2336` | 4 |
| `MODE2_FORM1`, `MODE2/2048` | `CD_TRACK_MODE2_FORM1` | 2048 | `MODE2_FORM1` | `MODE2/2048` | 4 |
| `MODE2_FORM2`, `MODE2/2324` | `CD_TRACK_MODE2_FORM2` | 2324 | `MODE2_FORM2` | `MODE2/2324` | 4 |
| `MODE2_FORM_MIX` | `CD_TRACK_MODE2_FORM_MIX` | 2336 | `MODE2_FORM_MIX` | `MODE2/2336`, which re-imports as `MODE2`: the TYPE changes on a round trip | 4 |
| `MODE2_RAW`, `MODE2/2352`, **`CDI/2352`** | `CD_TRACK_MODE2_RAW` | 2352 | `MODE2_RAW` | `MODE2/2352` (the `CDI/2352` string is lost) | 4 |
| `AUDIO` | `CD_TRACK_AUDIO` | 2352 | `AUDIO` | `AUDIO` | 0 (`.raw` file) |
| **`CDG`** (HEAD only, `c9e87a6b7e`) | `CD_TRACK_AUDIO` + `CD_SUB_RAW` | 2352 (+96) | `AUDIO`, `SUBTYPE:RW_RAW` | `AUDIO`, subcode dropped with a warning | 0 |
| not accepted: `CDI/2336`, anything lowercase | | | | | |

- Subcode (`cdrom.h:56-61`, `cdrom.cpp:783-795`):
  - `RW` becomes `CD_SUB_NORMAL`, "cooked"; in cdrdao terms this is *packed R-W, L-EC generated*.
  - `RW_RAW` becomes `CD_SUB_RAW`, the raw interleaved P-W form. MAME's comment calls it "uninterleaved", but cdrdao's definition is "interleaved and L-EC data already calculated" ([cdrdao man](https://github.com/cdrdao/cdrdao/blob/master/dao/cdrdao.man)).
  - `NONE`.
  - The subcode token is an *optional second token after the track type* in both TOC and cue (`cdrom.cpp:2621-2624`, `3173-3176`). `TRACK 01 AUDIO RW_RAW` in a cue is a MAME-only extension.
- The `PGTYPE` and `PGSUB` metadata fields exist, but chdman never sets `pgsub` (it is always `NONE`), and for stored pregaps it always sets `pgtype = trktype` (`cdrom.cpp:2658`). A pregap whose sector type differs from its track therefore cannot be described. Examples: data sectors in an audio track's pregap, and CD-i Ready software in track 1's pregap.

### 1.3 Padding to 4 frames

- createcd pads every track to a multiple of 4 frames with zero frames (`extraframes`, `chdman.cpp:2213-2220`).
- `extraframes` is **not stored** in CHT2 or CHGD. Every reader must recompute `extraframes = ceil(frames/4)*4 - frames` (MAME at `cdrom.cpp:994-995`; Flycast `chd.cpp` "CHD files are padded"). Only the legacy binary CHCD stored it.
- Extraction strips the padding. A 301-frame track came back as exactly 707 952 bytes **[exp `$SP/exp/cd/x-rm-split`]**.

### 1.4 Physical, CHD and logical offsets

These are computed in `cdrom_file(chd_file*)` (`cdrom.cpp:268-332`), and in `cdrom_file(inputfile)` for direct image mounting (`cdrom.cpp:170-230`):

| Field | Meaning | Formula |
|---|---|---|
| `physframeofs` | first frame of the track in the unpadded stream (stored pregap and GD `PAD` included) | Σ frames of previous tracks |
| `chdframeofs` | first frame of the track in the CHD | Σ (frames + extraframes) of previous tracks |
| `logframeofs` | **LBA of INDEX 01** | Σ previous (frames + postgap + virtual pregap) + this track's pregap (virtual or stored) |
| `logframes` | `frames - pregap` | wrong for virtual pregaps: 203 - 150 = 53 **[exp]** |

- **Stored pregap** ("V" prefix, `pgdatasize > 0`): the pregap frames are counted in `frames`. `logframeofs` points past them, and `read_partial_sector` adds `pregap` when `phys=false` (`cdrom.cpp:393-398`). Extraction reads with `phys=true`.
- **Virtual pregap and postgap**: they occupy logical LBAs but have no frames.

**Reader quirks (reference behaviour, verified with `cdprobe`) [exp `$SP/exp/cd`]:**

- `logical_to_chd_lba` (`cdrom.cpp:103-119`) assigns an LBA to track *n* while `lba < logframeofs(n+1)`, that is, up to the next track's **INDEX 01**. The INDEX 00 (pregap) sectors of track *n+1* are therefore served *as track n*.
  - For stored pregaps the result is shifted by `extraframes(n)`. On the mixed-mode test disc, LBA 301-303 returned zeros (track 1's padding), LBA 304 returned true sector 301, and the last 3 pregap sectors were unreachable (`$SP/exp/cd/x-rm-dump-orig.raw`). The previous track's type is used, so `read_data(…, AUDIO)` on an audio pregap after a data track fails.
  - For **virtual pregaps and postgaps** the zero-fill guard (`cdrom.cpp:379-388`) never fires, because it tests the looked-up track. The gap LBAs return **the next track's audio frames** and then read failures: LBA 304-506 held track 2's frames 0-202, LBA 507 held its padding, and LBA 508-600 failed **[exp `virtual-gaps`]**. Only LBA ≥ INDEX 01 is right.
- `get_track_index()` (`cdrom.cpp:602-621`) compares a track-relative offset with *file-relative* INDEX values. In cue-direct mode it reports index 0 at INDEX 01. From a CHD it always returns 1, because there is no index metadata.
- The MODE1-from-MODE2_FORM1 conversion uses offset 24 (`cdrom.cpp:508-511`). That is only correct for raw sectors: for a cooked `MODE2/2048` track it returns data shifted by 24 bytes. There is no MODE1 conversion from `MODE2` (2336). The MODE1_RAW "promotion" writes a header MSF without the +150 offset and without EDC/ECC (`cdrom.cpp:494-505`).

### 1.5 How cue and TOC constructs map to the model

| Input construct | Parsed into | Metadata | MAME reader | extractcd `.cue` | extractcd `.toc` |
|---|---|---|---|---|---|
| `INDEX 00` + `INDEX 01` in the same FILE | `pregap = idx1 - idx0`, `pgtype = trktype`, `pgdatasize = datasize` (`cdrom.cpp:2653-2665`) | `PREGAP:n PGTYPE:V<type>`, frames include the pregap | stored; see §1.4 quirk | `INDEX 00` / `INDEX 01` | `ZERO …` + `DATAFILE` (with pregap) + `START` (**wrong**, see B12 in §12) |
| `PREGAP mm:ss:ff` (cue) | `pregap = n`, `pgdatasize = 0` (`cdrom.cpp:2667-2676`) | `PREGAP:n PGTYPE:MODE1` (the type is meaningless) | virtual; see quirk | `PREGAP` + `INDEX 01` | `ZERO` + `START` |
| `POSTGAP mm:ss:ff` | `postgap = n` (`cdrom.cpp:2677-2686`) | `POSTGAP:n` | adds logical LBAs; Flycast ignores it | `POSTGAP` | dropped |
| `INDEX 02`–`99` | `outinfo.idx[]` only | **not stored** | cue-direct only | **lost** | lost |
| TOC `START mm:ss:ff` | 0.289: `pregap = n`, virtual (`cdrom.cpp:3185-3194`), although cdrdao defines the data before START as the pregap *in the file*. **Engine (B11):** stored, as `INDEX 00`, when the track holds those frames; virtual, as `PREGAP`, when they are `ZERO`/`SILENCE`/`PREGAP` zeros | 0.289: `PREGAP:n` without V, frames include the data; engine: as the equivalent cue | 0.289 shifts the data by `n` **[exp `startL.toc`]** | | |
| TOC `PREGAP`, `SILENCE`, `ZERO`, `INDEX`, `CD_TEXT`, `ISRC`, `CATALOG`, `FIFO` | 0.289: ignored (`cdrom.cpp:3036-3047`). **Engine (B11):** `PREGAP` is a virtual pregap; `ZERO`/`SILENCE` are zeros that no file holds (a virtual pregap before `START`, stored zero frames after it); the others are still ignored | | 0.289: pregap lost **[exp]** | | |
| `FLAGS DCP 4CH PRE` (SCMS ignored) | `control_flags` (`cdrom.cpp:2687-2708`) | **not stored**; reader reports 0 | `get_adr_control()` gives DCP=PRE=4CH=0 from a CHD **[exp]** | lost | writes `NO COPY` / `NO PRE_EMPHASIS` / `TWO_CHANNEL_AUDIO` unconditionally |
| TOC `COPY`, `PRE_EMPHASIS`, `FOUR_CHANNEL_AUDIO` | `control_flags` (`cdrom.cpp:3048-3071`) | not stored | | | |
| `CATALOG`, `ISRC`, `CDTEXTFILE`, `TITLE`, `PERFORMER`, `SONGWRITER`, other `REM` | silently ignored | | | lost | lost |

### 1.6 FILE handling: several tracks per FILE, several FILEs per track, byte order

- File types (`cdrom.cpp:2507-2551`): `BINARY`, `MOTOROLA` and `WAVE` (16-bit stereo 44.1 kHz PCM only; `WAVE_FORMAT_EXTENSIBLE` is rejected; `cdrom.cpp:1657-1810`). **`AIFF`, `MP3`, FLAC, APE and anything else give "Unhandled track type"**.
- **Several tracks in one BINARY file** works when the file is the *first* FILE, or each track is alone in its own file. Track length is `idx0(next) - idx0(this)`; the last track takes the rest of the file; the offset is `prev.offset + prev.frames*size` (`cdrom.cpp:2740-2769`). Single-bin and multi-bin forms of the same disc give identical CHDs **[exp]**.
- **Bug: a FILE shared by tracks, preceded by another FILE.** The offset keeps accumulating from the previous file, so tracks 2-4 were corrupted and track 4 was cut from 449 to 148 frames **[exp `mixed-files`, also in 0.289]**.
- **Bug: several tracks in one WAVE.** `wavlen` is consumed by the first TRACK, so track 2 and track 3 were both given 730 frames **[exp `wave/Game2.cue`, also in 0.289]**.
- **Bug: several FILEs per track** (EAC "non-compliant" cue, with INDEX 00 in the previous file; see [Wikipedia: Cue sheet](https://en.wikipedia.org/wiki/Cue_sheet_(computing))). The track's file is fixed at `TRACK` time, which produced `PREGAP:-300`, left the second file unread, and made extraction write `INDEX 01 954437:06:46` **[exp `cuequirks/eac.cue`]**. Redump never uses this layout (0 of 72 022 cues), but audio-rip tools do. *Fixed in the engine (B8):* the pregap is read from the end of the previous file, and the CHD is that of the disc as one file.
- **Bug: track 1 with INDEX 01 not at 00:00:00 and no INDEX 00.** The leading frames are counted into track 1, so every boundary moves by that amount **[exp `htoa/noidx0.cue`]**.
- Trailing bytes when a bin is not a multiple of the sector size are dropped silently (1000 bytes lost) **[exp `truncated`]**.
- **Case sensitivity, BOM and paths.**
  - Lowercase keywords give 0 tracks and a hang.
  - A UTF-8 BOM gives `couldn't find bin file []`.
  - CRLF is fine.
  - Absolute paths in FILE break (the cue directory is prepended). Lines are cut at 511 bytes (`fgets(…,511,…)`).
  - Discpress rewrites FILE references to basenames but otherwise passes the cue through unchanged (`app/ui.js:894-902`). BOM and lowercase problems therefore reach chdman.

**Audio byte order.** CHD stores Red Book audio **big-endian** (verified by comparing reader output with the source: the samples match only after swapping **[exp]**).

| Where | What happens | Code |
|---|---|---|
| cue import | every `AUDIO` track gets `swap=true` *after* parsing, whatever the FILE type (`cdrom.cpp:2730-2734`). So `BINARY` (LE) and `WAVE` (LE) are right, but **`MOTOROLA` (BE) is swapped too, so its audio is stored little-endian**; `Moto.cue` and `Bin.cue` give different data SHA-1s **[exp, also in 0.289]** | `cdrom.cpp:2531-2534`, `2731-2734` |
| gdi import | audio `swap=true` | `cdrom.cpp:2265-2270` |
| nrg import | audio `swap=true` (assumes LE, **[unverified]** against real Nero files) | `cdrom.cpp:1993-1996` |
| toc import | `swap=false` unless the `SWAP` keyword is present. This is consistent with cdrdao ("Raw files must have … big endian byte order", [cdrdao man](https://github.com/cdrdao/cdrdao/blob/master/dao/cdrdao.man)), but `.wav` files named in a TOC are **not** parsed as WAVE: the header is read as audio | `cdrom.cpp:3085-3094` |
| compressor | swaps only the first 2352 bytes of each frame (not the subcode) | `chdman.cpp:517-523` |
| extraction | swaps back to LE for `.cue` and for `.gdi` (v5 CHDs); **not** for `.toc` (BE raw, which is what cdrdao expects) | `chdman.cpp:2958-2964` |
| MAME reader | swaps only for legacy `CHGT` (little-endian GD audio, `CD_FLAG_GDROMLE`) | `cdrom.cpp:402-404`, `431-439` |
| `chdman copy` | CHGT to CHGD rewrites the metadata and swaps the audio sectors | `chdman.cpp:363-410`, `2533-2565` |

Data sectors that sit in an audio track's pregap are byte-swapped too. They are stored losslessly, but the CD codec cannot strip their ECC.

### 1.7 Sector data is lossless

`chd_cd_compressor::compress` (`chdcodec.cpp:352-392`) clears sync and ECC P/Q *only* when the sync matches **and** `ecc_verify()` passes (`chdcodec.cpp:372`), and flags that frame for regeneration. EDC, headers, subheaders and Form-2 data are never touched. A disc with deliberately broken sectors round-tripped byte-exactly **[exp `$SP/exp/ecc`]**: a flipped data byte, zeroed ECC, a wrong MSF, a broken sync, and a sector of 0x55 fill.

---

## 2. Metadata formats

Format strings are in `chd.cpp:38-41` and tags in `chd.h:225-237` (pristine 76c7d19). The `std::string` overload writes the text **plus a NUL terminator** (`chd.h:357`) with `CHD_MDFLAGS_CHECKSUM`. New entries are *appended* to the metadata chain (`chd.cpp:1672-1740`). `metadata_find` counts only entries with the requested tag (`chd.cpp:2945-2990`).

| Tag | Format / layout | Written by | Read by MAME | libchdr knows? | Notes |
|---|---|---|---|---|---|
| `CHCD` | binary, `METADATA_WORDS = 1+99*6` uint32: `numtrks`, then 99 × {trktype, subtype, datasize, subsize, frames, extraframes} (2380 bytes, host endianness) | chdman ≤ v3/v4 era | `cdrom.cpp:1029-1072`, which byte-swaps everything if `numtrks > 99`; the swap loop also swaps an unread `padframes` | yes | no pregaps; `copy` upgrades it to CHT2 (`chdman.cpp:2537-2566`) |
| `CHTR` | `TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d` | old v4 chdman | `cdrom.cpp:945-949` | yes | no pregap/postgap; `copy` upgrades it |
| `CHT2` | `TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d PREGAP:%d PGTYPE:%s PGSUB:%s POSTGAP:%d` | every CD since 0.138u2 (`842282c0fa`) | `cdrom.cpp:950-954` | yes | `PGTYPE` prefixed with **`V`** means the pregap is *in* FRAMES (added in 0.148u5, `22d69c1f2b`); without V it is virtual. PGSUB is parsed only if pregap > 0 (`cdrom.cpp:1003-1011`) |
| `CHGT` | same text as CHGD | GD-ROM before 0.154 | `cdrom.cpp:958-961`, sets `GDROMLE` (LE audio) | yes | 0.154 (`3eb1f14701`) moved GD audio to BE and the tag to CHGD, changing "the SHA1s of every GD-ROM CHD" |
| `CHGD` | `TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d PAD:%d PREGAP:%d PGTYPE:%s PGSUB:%s POSTGAP:%d` | GD-ROM since 0.154 | `cdrom.cpp:962-970` | yes | `PAD` = zero frames included in FRAMES (the gap up to LBA 45000, or TOSEC gaps). **HEAD now writes `V` pgtypes in CHGD as well** (`1cf0f9e986`); before, GD never had them |
| `CHSE` (**post-0.289**, `b93961fd52` + `20661546b2`) | `SESSION:%d` | HEAD `write_metadata`, only when `numsessions > 1`: one entry *before the first track of each session*, index = session number (`cdrom.cpp:1115-1124`) | `cdrom.cpp:933-942`: a session is taken only if its absolute metadata index is ≤ 1 after the previous track's (fragile, §3.3) | **no** (libchdr headers list CHCD/CHTR/CHT2/CHGT/CHGD/DVD) | the only session information stored; changes the overall SHA-1 |
| `DVD ` | 1-byte payload (empty string + NUL) | `createdvd` (`chdman.cpp:2308`) | `check_is_dvd()` (`chd.cpp:3630`) | yes | added in 0.255 (`28104cdbdf`) |
| `IDNT`, `GDDD`, `KEY `, `CIS ` | hard-disk tags | | | | not used for optical media |

Compatibility facts that readers must honour:

- Tracks are looked up by *per-tag* index (the n-th CHT2), not by absolute position. `check_is_cd()` tries CHCD, then CHTR, then CHT2 (`chd.cpp:3610-3620`). GD needs CHGT or CHGD.
- The overall SHA-1 (`chd.cpp:1839-1890`) hashes each **checksummed** metadata entry. The entries are sorted by (tag, SHA-1), so it does not depend on order.
- Adding a non-checksummed tag leaves the SHA-1 unchanged. With a meta-only hash, `84a6af…` stayed the same with a `--nochecksum` entry and became `b58c67…` with a checksummed one **[exp `$SP/tools/oversha`]**.
- `chdman addmeta`/`delmeta` refuse compressed CHDs ("File not writeable"), so fidelity metadata must be written at creation time.
- **A reader that looks at wildcard metadata index 0 to decide what kind of disc it has would now see `CHSE`** on multi-session CDs. That is a hypothetical but real risk for home-grown readers **[unverified]**; D1 should check the emulators.
- Both MAME and libchdr users parse with `sscanf`, which ignores trailing text. Fields appended to `CHT2`/`CHSE` strings (for example `SESSION:2 LEADIN:4500 LEADOUT:6750`) would therefore be backward-compatible with MAME's parser, but they would change the SHA-1 because those tags are checksummed.

---

## 3. Sessions and multi-session discs

### 3.1 Before and after

- **≤ 0.265:** `REM SESSION` was ignored, so multi-session discs were flattened.
- **0.266 (`df62ba1451`):** `parse_cue` understands `REM SESSION nn` (IsoBuster), `REM PREGAP` (only once a session ≥ 2 has been seen), `REM LEAD-OUT` and `REM LEAD-IN` (`cdrom.cpp:2442-2495`). For multi-bin cues without them it inserts a default lead-out of 6750 frames (1:30, first session; 2250 afterwards) and a lead-in of 4500 (`cdrom.cpp:2784-2799`). Single-bin (ImgBurn/IsoBuster) cues trim the track at `LEAD-OUT` and skip the gap bytes, except for `.img` files, where the gap is assumed absent (DiscImageCreator; `cdrom.cpp:2801-2836`). **None of this reaches the CHD:** `leadin`/`leadout` live in `track_input_info`, and `padframes` is written only to CHGD.
- **Post-0.289 (HEAD):** `CHSE` stores session numbers. Extraction writes `REM SESSION %02d` in cue mode only (`chdman.cpp:2911-2915`), and never writes REM LEAD-OUT, LEAD-IN or PREGAP. TOC and GDI output have no session syntax.

### 3.2 What LBA does session 2 get? [exp `$SP/exp/cd/multisession`, `ms-single`]

The test disc is an Enhanced CD with 2 audio tracks (700 frames) and a Mode-2 data track in session 2. Its true INDEX 01 is at 700 + 11 400 = **12 100** (lead-out 6750 + lead-in 4500 + pregap 150; the Redump forum gives "PREGAP 02:32:00" = 11 400, [thread](http://forum.redump.org/topic/20409/done-discussing-the-multisession-cue/page/6/)).

| Input cue style | MAME, cue mounted directly | MAME from CHD (HEAD) | MAME from CHD (0.289) | Flycast rules (from CHD) |
|---|---|---|---|---|
| Redump download (`REM SESSION` only; Redump strips the other REMs from downloads, [thread p.5](http://forum.redump.org/topic/20409/done-discussing-the-multisession-cue/page/5/)) | 11 950 (**150 short**: the default gap lacks the pregap) | **700** | 700 | 12 100, but only via the "last track is data, so it is a MIL-CD" heuristic, which adds `11400 - min(lastPregap,150)` |
| Redump full (`REM LEAD-OUT 01:30:00`, `REM LEAD-IN 01:00:00`, `REM PREGAP 00:02:00`) | 12 100 | 700 | 700 | 12 100 (heuristic) |
| `PREGAP 02:32:00` on track 3 (the Redump forum workaround) | 23 350 (gap counted twice) | **12 100** | 12 100 | **23 350** (virtual pregap plus the heuristic) |
| Single-bin with 11 400 gap frames, `REM LEAD-OUT` | 12 100 | 700 | not tested | 12 100 (heuristic) |
| DiscImageCreator `.img`, no gap bytes | 12 100 | 700 | not tested | 12 100 (heuristic) |

- Track bins round-trip exactly in all cases.
- The HEAD cue output matches the Redump text once line endings are normalised; 0.289 drops the `REM SESSION` lines **[exp `redumpcue/ajcd`]**.
- The data SHA-1 is the same in both versions (`ce91f7…`). Only the overall SHA-1 differs (`793012…` HEAD, `99d145…` 0.289).

### 3.3 The CHSE parser depends on metadata order [exp `$SP/tools/mkorder`]

| Metadata order | MAME result |
|---|---|
| CHSE, CHT2, CHT2, CHSE, CHT2 (as chdman writes it) | sessions 1, 1, 2 ✓ |
| one foreign tag first | ✓ |
| **two** foreign tags first | all tracks in session 1, `numsessions=1` ✗ |
| one foreign tag between the last session-1 track and the session-2 CHSE | all tracks in session 1 ✗ |

The cause is the unsigned expression `metaindex - lastmetaindex <= 1` (`cdrom.cpp:936`). `do_copy` clones entries in order, so it preserves the layout. A fork that adds tags must **append them after all CD tags**.

### 3.4 Would libchdr-based emulators misread these CHDs?

- **The LBA layout does not change compared with 0.289**, because CHSE carries no frames or pregaps. So they misread multi-session discs exactly as before: flattened, unless they guess like Flycast.
- The new tag is ignored (it is unknown to libchdr) and only changes the SHA-1. That breaks matches against DATs of 0.289-made CHDs, if any exist.
- **The real risk is in how a fork stores the gap:**
  - A virtual pregap fixes MAME and generic readers but double-counts in Flycast for MIL-CDs.
  - A new tag, or extra CHSE fields, is invisible to current readers (no worse than today) but needs reader adoption.

### 3.5 Which systems have multi-session discs (Redump cue sheets, downloaded 2026-09-27)

`REM SESSION` appears in:

| System | Multi-session discs |
|---|---|
| **Atari Jaguar CD** | 38 / 38 |
| **Dreamcast** (CD-format MIL-CD and similar) | 89 / 1516 |
| **IBM PC** (Enhanced/mixed) | 161 / 48 147 |

It appears in **0** of PS1 (10 914), PS2 CD (3168), Saturn (2457), Mega-CD (549), PCE (551), PC-FX, NGCD, 3DO, CD-i (2425), CD32, CDTV, FM Towns, PC-98 and Naomi. `$SP/tools/cuestats.py` produced these counts. The brief's guesses about Saturn, Sega CD, PCE and PS1 are therefore not borne out by Redump. CD-i Ready titles use a **huge track-1 pregap** instead of sessions: 81 CD-i cues have `INDEX 00` on track 1, for example `2 Unlimited - Beyond Limits`, where INDEX 01 is at 41:28:00.

---

## 4. CD+G (`c9e87a6b7e`, #15910, 2026-09-22)

- The cue and TOC parsers now accept `TRACK nn CDG`, which becomes an `AUDIO` track with `subtype=RW_RAW, subsize=96`, so the input must hold **2448-byte sectors** (2352 audio + 96 raw P-W). This matches CDRWIN's "CDG – Karaoke CD+G (sector size: 2448)" ([libodraw CUE spec](https://github.com/libyal/libodraw/blob/main/documentation/CUE%20sheet%20format.asciidoc)). The code is at `cdrom.cpp:721-725`, `2611-2631` and `3163-3183`.
- **Other discs are unaffected:** the path only runs for the `CDG` token, which 0.289 rejected with "Unknown track type [CDG]" **[exp]**.
- **No new metadata.** The CHT2 entry is identical to what 0.289 writes for the MAME-specific `TRACK 01 AUDIO RW_RAW` **[exp]**.
- **Where the subcode can come from:** only interleaved in the same file (cue `CDG`, cue `<type> RW|RW_RAW`, or TOC `TRACK <type> RW|RW_RAW`). Not supported: `.sub` (CloneCD), `.subcode` (redumper), `.sbi`/`.lsd` (LibCrypt patches), `.cdg` side files (MP3+G).
- **Extraction:**
  - `.cue` drops the subcode with a warning and writes `TRACK AUDIO`.
  - `.gdi` drops it too.
  - `.toc` keeps it (`TRACK AUDIO RW_RAW`, BE audio), and re-importing gives an identical data SHA-1 **[exp `$SP/exp/cd/cdg`]**.
  - There is no way back to a CDRWIN `CDG` cue/bin.
- MAME uses the subcode through `read_subcode()`; the commit's stated purpose was the CD-i audio player.

---

## 5. GD-ROM

### 5.1 Inputs

- **GDI** (`parse_gdi`, `cdrom.cpp:2156-2367`, rewritten in 0.272, `2c8de2ee29`). The line format is `track lba type(0=audio,4=data) sectorsize file offset`, with exactly 6 parameters. Types 4/2352, 4/2048 and 0 are accepted. The offset column is parsed but ignored.
  - The track-count check is off by one, so a GDI declaring 100 tracks is accepted and **aborts** **[exp]**.
  - TOSEC convention: track01 is usually 300 sectors (705 600 bytes); track 2 is listed at LBA 450, with its 150-sector pregap **absent from all files**; track 3 is at 45000; the pregaps of later HD tracks sit at the **end of the previous file**.
- **Redump multi-cue.** It is detected when a cue contains **both** `REM SINGLE-DENSITY AREA` and `REM HIGH-DENSITY AREA` (`is_gdicue`, `cdrom.cpp:2919-2962`; tokens are case-sensitive). Pregaps are stored at the start of each track's bin (INDEX 00). In the Redump DC set:
  - 1427 GD cues: track 3 never has INDEX 00, track 2 always has `INDEX 01 00:02:00`, and a final data track after audio has `INDEX 01 00:03:00` (a 225-frame pregap) in 602 of 603 discs;
  - HD layouts: `D` 821, `DAD` 261, `DA…AD` many.

  The format was agreed in the [Redump DC multi-cue thread](http://forum.redump.org/topic/19969/done-sega-dreamcast-multicue-gdi/page/2/): the HD area begins at MSF 10:02:00, which is LBA 45000.
- **45000:** `adjust_high_density_area` (`cdrom.cpp:2881-2901`, called only from `do_create_cd`, `chdman.cpp:2185-2192`) sets the first HD track to `physframeofs = 45000` and pads the previous track (`PAD`).
  - In HEAD this call is **no longer made when MAME mounts a `.cue` directly**. A Redump GD cue mounted directly in MAME now puts track 3 at LBA 650 instead of 45000, whereas 0.289 gave 45000 **[exp `cdprobe` on `dc-type1/redump/DC.cue`]**.

### 5.2 Version history of the GD layout

| Version | Commit | Behaviour | SHA-1 impact |
|---|---|---|---|
| 0.145u4 | `bb993d1174` | GDI import fixed; extract to `.gdi`; "perfect checksum round-tripping" | |
| 0.154 | `3eb1f14701` | GD audio made big-endian, tag CHGT→CHGD | all GD CHDs changed; `chdman copy` upgrades |
| 0.227 | `ccacd0f165` | Redump multi-cue import, converted to the **TOSEC layout** (patterns I/II/III), aiming for results "identical" to GDI conversions | |
| 0.262 | `b75b8d80e8` | "Don't strip pregaps from Redump GD-ROM files" | changed (inferred from the diff) |
| 0.264 | `853db181d2` | refactor: "don't discard any data … including pre-gap"; pregaps moved to the **previous** track with `splitframes` (TOSEC-like); warning when extracting GD to cue | changed (inferred from the diff) |
| 0.272 | `2c8de2ee29` | GDI parser rewrite (validation) | |
| **0.289** | | Redump cue → TOSEC layout via splitframes (track 1 FRAMES:450); GDI gaps → `PAD` of the previous track; extract-to-cue rebuilds the Redump pregaps (the "type 1/2/3/3 split" heuristics) | |
| **post-0.289** | `1cf0f9e986` (#15808, 07-31), `ac47a71ce1` (#15870, 08-10) | Redump cue: pregaps stay in-track as `PGTYPE:V…`. **GDI: the gap before track 2 becomes a virtual `PREGAP:150`**. Extract heuristics removed; `--removepregap`/`--addpregap` added and then removed again | **all GD CHDs change; GDI-sourced ones are misplaced** |

### 5.3 Experiments

Synthetic DC discs (types 1, 2, 3 and 3-split) were built from the same data both as a Redump cue and as a TOSEC GDI (`$SP/exp/gen/gen.py::dc_disc`, `$SP/exp/gd`). "Logical" is MAME `logframeofs`; "Flycast" applies the rules of [Flycast `chd.cpp`](https://github.com/flyinghead/flycast/blob/master/core/imgread/chd.cpp), `StartFAD = total+pregap; total = StartFAD+frames-pregapInFile`, in `$SP/tools/flyview.py`. The expected INDEX 01 LBAs for type 2 are t3=45000, t4=46150, t5=46600.

| Source | Version | CHGD, track 1-2 | MAME logical | Flycast LBA |
|---|---|---|---|---|
| Redump cue | 0.289 | T1 FRAMES:450 PAD:0; T2 PREGAP:0 | t3=45000 t4=46150 t5=46600 ✓ | ✓ |
| Redump cue | HEAD | T1 FRAMES:300; T2 PREGAP:150 **PGTYPE:VAUDIO** | ✓ | ✓ |
| TOSEC gdi | 0.289 | T1 FRAMES:450 **PAD:150**; T2 PREGAP:0 | ✓ | ✓ |
| TOSEC gdi | **HEAD** | T1 FRAMES:300; T2 **PREGAP:150 PGTYPE:MODE1** (virtual) | **t3=45150 t4=46300 t5=46750 ✗** | **✗ (+150)** |

- Types 1, 3 and 3-split show the same pattern: every HEAD-from-GDI layout is shifted by +150.
- The repo's own fixture `tests/.cache/fixtures/aerowings.gdi` (track01 of 22 sectors, track 2 at 450) comes out at **45 428** with HEAD, against 45 000 with 0.289 **[exp]**.
- **MAME's consumers:**
  - `src/devices/bus/ata/gdrom.cpp` builds the TOC from `get_track_start(i)+150` (lines 582, 600, 626-628) and reads `read_data(m_lba, …, MODE1)` (line 642);
  - `src/mame/sega/naomigd.cpp:909-964` reads the PVD at `45000+16` and then absolute file LBAs;
  - Flycast's `FillGDSession()` takes `tracks[2].StartFAD` as is;
  - so a CHD with a +150 shift will not boot (ISO9660 LBAs are absolute) **[inferred from code; D1 to confirm in emulators]**.

**Are gdi→chd and cue→chd identical?** Never, in any version.
- 0.289 is *data*-identical when the Redump pregaps are silent: data SHA-1 `9c6bc3…` for both, with overall SHA-1 differing only because of `PAD:150` against `PAD:0` **[exp `$SP/exp/gd-silent`]**.
- In HEAD even the data differs (`d4c930…` against `2b20e2…`), and both differ from 0.289.

**Round trips [exp `$SP/exp/gd/rt`]:**

| From → to | 0.289 | HEAD |
|---|---|---|
| cue → CHD → cue | bins identical, cue identical after line-ending normalisation (also for a real Redump DC cue text, `redumpcue/dc`) | same |
| gdi → CHD → gdi | bins and GDI text identical (LF instead of CRLF) | same |
| cue → CHD → gdi | track01 = 450 frames (includes track 2's pregap) | "Redump-layout GDI": `2 300 …`, pregaps inside later files, TOC starts 150/225 frames early |
| gdi → CHD → cue | track 2 written with a `PREGAP` command (no pregap data); does not match Redump bins | same |

Extraction details for GD:
- `.cue` output forces `--splitbin` (`chdman.cpp:2694-2699`).
- `REM SINGLE-DENSITY AREA` is written before track 1, and `REM HIGH-DENSITY AREA` before the track whose `physframeofs == 45000` (`chdman.cpp:2900-2906`).
- `.gdi` output names files `<name>NN.bin` or `.raw` for audio (`chdman.cpp:2705`, `2764`).
- The GDI LBA is `discoffs` (+ pregap if virtual, `chdman.cpp:1535-1541`).

Legacy detail **[unverified: no v4 GD CHD to test]**: for GDI output, extraction swaps audio only when `version() > 4` (`chdman.cpp:2958`), assuming v4 GD audio is "already reversed". Combined with the reader's GDROMLE swap, v4 CHGT images may therefore come out big-endian.

---

## 6. DVD

- **createdvd** (`chdman.cpp:2261-2321`):
  - input is any file whose size is a multiple of 2048; there is **no ISO9660/UDF validation**; it can slice with `-isb/-ish/-ib/-ih`;
  - unit size 2048, **default hunk 4096** (two sectors, since 0.263 `fa9d0fc32a`);
  - codecs `lzma, zlib, huff, flac` (the hard-disk defaults, `chdman.cpp:668`);
  - metadata `DVD ` with a 1-byte NUL payload, checksummed.
- **extractdvd** is `do_extract_raw`, and returns the ISO byte-exactly **[exp]**. It does **not check the media type**: on a CD CHD it wrote 30 286 656 bytes of 2448-byte frames for a 25 337 856-byte ISO **[exp]**.
- **MAME's `dvdrom_file` throws unless `hunk_bytes() == 2048`** (`dvdrom.cpp:55-58`), and reads sector *n* as hunk *n* (`dvdrom.cpp:99-105`). MAME therefore **cannot mount default createdvd output**; `-hs 2048` works **[exp `$SP/tools/dvdprobe`]**. libchdr-based readers (PCSX2, PPSSPP; see D1) are unaffected by hunk size **[unverified]**.
- **ISO through createcd rather than createdvd** (`agent.iso`, 25.3 MB **[exp]**):

  | | createcd | createdvd |
  |---|---|---|
  | Result | 1 track `MODE1` (2048 of 2448 bytes used per frame) | 2048-byte units |
  | Size | 10 828 264 bytes, 3.6 % larger | 10 449 039 bytes |
  | Codecs | CD | HD |
  | MAME reader | `cdrom_file` | `dvdrom_file` |
  | Extract back | `extractcd` to `.cue` writes `MODE1/2048` + `.bin`, identical to the ISO **[exp]** | ISO |

- `parse_iso` (`cdrom.cpp:2068-2138`) picks the sector size by *divisibility*, in the order 2048, then 2336, then 2352. A raw 2352-byte image with N ≡ 0 (mod 128) frames is typed `MODE1/2048`, and with N ≡ 0 (mod 146) it becomes `MODE2/2336` **[exp `$SP/exp/xiso`]**. Discpress sniffs the sync pattern and warns that such an `.iso` "will be converted as a CD", but it still passes the `.iso` to chdman (`app/ui.js:798-803`), so these sizes are mis-typed.
- Dual-layer PS2 (DVD9): nothing to store; the ISO has no layer-break metadata and none is needed. UMD/PSP ISOs are plain 2048-byte sectors, so createdvd suffices. PS2 games on CD (the 3168 Redump PS2 cues, all `MODE2/2352`) go through createcd.
- What emulators expect, briefly: DVD CHDs for PS2 DVDs and PSP, CD CHDs for everything else (D1 covers the details).

---

## 7. Round-trip fidelity against Redump

### 7.1 What round-trips [exp]

| Item | createcd → `extractcd --splitbin` | without `--splitbin` |
|---|---|---|
| Track bins (Redump multi-bin) | **byte-identical** (`redump-mixed`, PS1 real-cue test with 11 bins, Jaguar CD, DC, Saturn 27 bins) | one `.bin` = exact concatenation |
| 4-frame padding | stripped | stripped |
| INDEX 00 (stored pregap) | reproduced (`INDEX 00 00:00:00`, `INDEX 01 mm:ss:ff`), including odd lengths such as `00:01:74` | positions absolute in the single file (correct) |
| PREGAP / POSTGAP commands | reproduced as commands | same |
| Naming | `<cue stem> (Track N).bin`, `%02t` when ≥ 10 tracks (`chdman.cpp:2709-2710`); matches Redump for multi-track discs, **but a single-track disc gets `(Track 1)`, where Redump uses `<name>.bin`** | `<stem>.bin` |
| Line endings | **LF**, while all 72 022 Redump cues are **CRLF**; no BOM | LF |
| Sessions | `REM SESSION nn` (HEAD) | same, but a single-bin multi-session cue without `REM LEAD-OUT` is not IsoBuster-conformant |
| GD areas | `REM SINGLE-/HIGH-DENSITY AREA` | forced split |

- With the Redump cue text of `'99 Koushien (Japan)` (PS1, 11 tracks) and synthetic bins, HEAD's output cue was **identical after CRLF normalisation**, and all 11 bins were identical **[exp `$SP/exp/redumpcue`]**.
- The same holds for a DC GD cue (both versions) and a Jaguar CD cue (HEAD only).

### 7.2 What is lost or changed

| Lost/changed | Where | How common in Redump (share of cues) |
|---|---|---|
| `CATALOG` | ignored by parser | 3DO 63 %, CD32 51 %, CD-i 57 %, FM Towns 39 %, **MCD 73 %**, PC-98 42 %, PC-FX 81 %, **PCE 77 %**, **SS 70 %**, PC 19 %; PSX/PS2 0 % |
| `FLAGS DCP/PRE/4CH/SCMS` | parsed, not stored | PSX 143, NGCD 63, PC 1358, CD-i 26, AJCD 14 discs; PRE on 4 MCD, 1 CD32, 1 CD-i, 125 PC |
| `ISRC` | ignored | MCD 13, AJCD 5, DC 7, PC 97 discs |
| `INDEX 02+` | parsed, not stored | **3DO 120 (18 %)**, SS 43, NGCD 26, PC-FX 24, FM Towns 11, MCD 6 |
| `CDI/2352` | written as `MODE2/2352` | CD-i 2343 of 2425 |
| CD-TEXT (`TITLE`/`PERFORMER`/`CDTEXTFILE`) | ignored | PC 13 |
| Other `REM` | ignored | none in the Redump sets examined |
| Session gaps, lead-in/lead-out, subchannel, write offset | never stored (the offset is baked into the bins, as in Redump) | |

- **Structurally reproducible Redump cues:** 55 425 of 72 022 = **77 %** overall. By system: DC 99 %, PSX 99 %, PS2 ~100 %, Naomi 100 %, CDTV 92 %, PC 79 %, FM Towns 59 %, PC-98 56 %, AJCD 50 % (FLAGS/ISRC), CD32 49 %, NGCD 37 %, SS 29 %, 3DO 25 %, MCD 25 %, PCE 23 %, PC-FX 15 %, CD-i 2 % (`$SP/ref/cues`, 21 packs downloaded from `http://redump.org/cues/<system>/`).
- **Official Redump DATs list the `.cue` as a ROM with size, CRC, MD5 and SHA-1.** Checked in `redump.org/datfile/pce/`: 551 cue entries.

**What byte-exact Redump reconstruction needs:**
1. Keep today's bin-exact track storage.
2. Store the disc-level CATALOG, per-track ISRC, FLAGS, INDEX ≥ 2 positions, the original track type string, and the session/GD markers, *or simply the original cue text*, as non-checksummed metadata.
3. Write CRLF, and apply Redump naming (no `(Track 1)` for a single track).
4. Keep 0.289's GD handling.

With (1)-(4), all 72 022 surveyed cues would be reproducible. Verification against the DB can be done *without extraction*: hash each track range from the CHD (the frames between `chdframeofs` and `frames`, audio swapped back to LE) and compare with the DAT's per-track CRC/SHA-1.

---

## 8. Discs that are unrepresentable or poorly represented

| Case | Status in chdman CHD | Notes |
|---|---|---|
| Intentional bad sectors, non-standard EDC/ECC, 0x55 fill | **Lossless** **[exp]** | the codec regenerates ECC only if it verified |
| C2/"unreadable" maps, weak sectors, DPM (SecuROM 4+, StarForce), twin sectors | **Not representable** | no per-sector error or timing metadata in any CHD tag |
| Subchannel protections: LibCrypt (PS1 Q errors), SecuROM, SafeDisc | *Storable* (RW_RAW per track), but **chdman cannot ingest** `.sub`, `.sbi` or `.subcode` | Redump ships `.sbi` for PS1; emulator support for subcode in CHD is a D1 question |
| CD-TEXT, MCN (CATALOG), ISRC, track flags (pre-emphasis, copy, 4-channel) | **Lost** | readers report DCP=PRE=0 from a CHD **[exp]** |
| INDEX 02-99 | **Lost** | 3DO and Saturn use them |
| Multi-session gap (lead-out, lead-in, pregap) | **Lost** (CHSE has numbers only) | §3 |
| CD-i Ready (application in the track-1 pregap of an *audio* track) | bytes kept (V pregap), but the pregap is typed AUDIO | 81 CD-i cues have a track-1 INDEX 00 |
| Data sectors in an audio pregap (mixed mode) | lossless (byte-swapped in the CHD), typed as audio | readers see them as audio |
| Hidden track-one audio (HTOA) | stored (V pregap of track 1); MAME serves it at LBA 0…; other readers may not | **[exp `htoa`]** |
| > 99 tracks | **crash** (cue: segfault; GDI: abort) | the Red Book limit is 99; `4c0957d7f0` (0.262) fixed a 99-track crash |
| > 80 or 99 minutes | fine (uint32 frames; MSF text allows more than 99 minutes) | |
| DDCD | not applicable (no emulator use) | |
| Dreamcast / Saturn / Mega-CD security rings, GD "SEGA logo" area, lead-in TOC | not stored (not dumped by Redump either); emulators fake them | Redump staff describe fixed DC area boundaries in the [multisession thread, post 9](http://forum.redump.org/topic/20409/done-discussing-the-multisession-cue/) |
| `.iso` rips of PS1, Saturn or Sega CD | CHD is lossless, but the *source* has already lost Form 2, subheaders and audio | |
| PS2 DVD9 layer break, DVD BCA, CSS | not stored and not needed for PS2 | |
| Legacy GD CHDs (CHGT, little-endian audio) | read with a swap; `copy` upgrades | §5 |

---

## 9. Input formats in the wild

Dispatch is by extension only (`parse_toc`, `cdrom.cpp:2980-3005`): `gdi`, `cue`, `nrg`, `iso`/`cdr`/`toast`; **every other extension is parsed as a cdrdao TOC**, so `.ccd`, `.mds`, `.cdi`, `.bin` and binary `.toc` files yield 0 tracks and createcd hangs **[exp]**.

| Format | Supported today | What maps across | Effort to add or fix | Browser priority |
|---|---|---|---|---|
| cue/bin, single and multi-bin | yes | tracks, INDEX 00/01, PREGAP, POSTGAP, sessions (HEAD); loses CATALOG, ISRC, FLAGS, INDEX2+ and CD-TEXT | fix the bugs in §1.6 (days); add fidelity metadata (days) | **highest**: 99 % of Redump |
| cdrdao `.toc` | partial: explicit lengths only; START treated as virtual; PREGAP, SILENCE, ZERO and several FILEs ignored; `.wav` not decoded | types, subcode (RW/RW_RAW), flags (not stored) | medium (rewrite the parser to cdrdao semantics) | low (rare), but needed for lossless CD+G |
| `.gdi` | yes; **HEAD misplaces the HD area** | tracks, LBAs | revert to 0.289 (hours) | **high** (TOSEC Dreamcast) |
| `.iso` / `.cdr` / `.toast` | yes (size heuristic) | 1 data track | Discpress should build a cue from the sync sniff | high |
| Nero `.nrg` | partial: `NER5`/`DAOX` only; modes 2048, Mode-2 raw and audio; pregaps turned into virtual pregaps (data dropped); **offset bug after a track with a pregap**; no v1 `NERO`/`DAOI`, TAO `ETN2`, multi-session, Mode-2 Form 1, raw or subchannel modes (`cdrom.cpp:1885-2050`) **[exp `$SP/exp/nrg`]** | tracks | medium | medium |
| CloneCD `.ccd` + `.img` + `.sub` | **no** (Discpress ignores `.ccd`/`.sub` and converts `.img` as a single data track with a warning) | would give full TOC, sessions, sub-channel (96 bytes/sector, P-W **[layout unverified]**) and CATALOG | easy to medium (INI-style text) | **high** (DiscImageCreator also writes it) |
| Alcohol `.mds` + `.mdf` | no | sessions, pregaps, subchannel (16 or 96 bytes interleaved) | medium (binary; MDS v1; not the encrypted MDX) | medium |
| DiscJuggler `.cdi` | no | sessions, pregaps, 2048/2336/2352 sectors, subchannel variants | medium to hard (several versions) | **high for Dreamcast homebrew/MIL-CD** |
| redumper outputs (`.scram`, `.state`, `.subcode`, `.toc`/`.fulltoc` binary **[unverified]**, `.cdtext`, split `.cue`/`.bin`) | only the split cue/bin (Redump format) | via the cue; its `.toc` is reportedly **binary**, and Discpress would treat any `.toc` as a TOC descriptor, which would hang chdman with 0 tracks **[code reading, `app/ui.js:782-787`]** | ingest `.subcode` and `.cdtext` (medium); never pass the binary `.toc` | medium |
| ECM (`.bin.ecm`) | no | lossless reconstruction of EDC/ECC | easy (~200 lines) | medium (old PS1 sets) |
| Audio in cue: FLAC, APE, MP3, OGG, AIFF | no ("Unhandled track type"); only WAVE, with 1 track per file | audio | FLAC easy (libFLAC already linked); AIFF easy; MP3 medium (lossy, encoder delay); APE hard | medium (TOSEC/"iso+mp3" rips) |
| PBP (PSX eboot) | no | compressed ISO blocks and CD-DA (often lossy) | medium; official titles are DRM-encrypted | low |
| CSO / ZSO / DAX (PSP/PS2) | no | ISO → createdvd | easy | medium |
| `.img` variants | Discpress guesses (sync sniff, then an auto cue) | | | |

---

## 10. The `cdrom_file` read API (reference behaviour)

| Call | Behaviour |
|---|---|
| `cdrom_file(chd_file*)` | Validates unit/hunk sizes, `parse_metadata`, computes offsets (`cdrom.cpp:248-333`). No sessions gap, no index or flag information |
| `cdrom_file(std::string_view)` | Mounts cue/gdi/toc/nrg/iso directly. Adds the multi-session lead-in/lead-out to logical offsets (`cdrom.cpp:185-200`). HEAD no longer applies the GD 45000 placement here |
| `read_data(lba, buf, type, phys=false)` | Maps logical (or physical) LBA to a CHD frame and returns `datasize` bytes. Conversions: MODE1 from MODE1_RAW (+16), MODE1_RAW from MODE1 (synthetic header, no EDC/ECC, MSF off by 150), MODE1 from MODE2_FORM1/RAW (+24), MODE1 from FORM_MIX (+8), MODE2 from *_RAW (+16); otherwise it returns false (`cdrom.cpp:462-528`). `CD_TRACK_RAW_DONTCARE` returns the raw data |
| `read_subcode(lba, buf, phys)` | 96 bytes if the track has subcode, else false (`cdrom.cpp:548-569`) |
| `get_track(lba)` | Track by *logical* LBA (`cdrom.cpp:592-600`); pregap LBAs belong to the previous track |
| `get_track_start(t)` / `get_track_start_phys(t)` | `logframeofs` (INDEX 01) or `physframeofs`; `0xAA` means lead-out (`cdrom.h:157-158`) |
| `get_track_index(lba)` | See §1.4; always 1 from a CHD |
| `get_last_track()`, `get_last_session()`, `get_track_type(t)`, `get_toc()`, `is_gdrom()` | trivial accessors (`cdrom.h:169-192`) |
| `get_adr_control(t)` | ADR=1, control from flags (always 0 from a CHD), plus the data bit (`cdrom.h:171-179`) |
| `msf_to_lba` (binary MSF) and `lba_to_msf` (BCD) | not symmetric; `lba_to_msf_alt` gives a binary MSF (`cdrom.h:201-232`) |
| `ecc_verify` / `ecc_generate` / `ecc_clear` | Mode 1 and Mode 2 (header zeroed for Mode 2) (`cdrom.cpp:1363-1466`) |

- Audio from `read_data` is big-endian, except for legacy CHGT (swapped to BE on read).
- Discpress's identification probe (`wasm/wasm_helper.cpp:142-160`) reads with `get_track_start(track)+lba` and MODE1 conversion. Because it is track-relative, identification works even on the HEAD GD layout.

---

## 11. Output differences between post-0.289 HEAD and official 0.289

| Change | Commit | Effect on output | Readers |
|---|---|---|---|
| LZMA SDK 26.02, CHD LZMA level 8 → 6 (to keep the same dictionary size) | `c23567b509` (08-04) | **Every CD and DVD file differs in bytes**; sizes differ by about ±0.01 % (for example PS1 fixture +130 bytes, DVD fixture −1264 bytes); raw and overall SHA-1 unchanged **[exp]**. HEAD (new SDK) at level 8 is byte-identical to 0.289 **[exp `$SP/src/buildlvl8`]**; so is HEAD with the old SDK at level 8 (`$SP/src/buildmix`) | decoders unaffected: 0.289 verifies HEAD files and HEAD verifies 0.289 files **[exp]** |
| GD pregap/layout rework | `1cf0f9e986`, `ac47a71ce1` | GD SHA-1 changes for both cue and gdi; **GDI HD area +150** | MAME, Flycast |
| Session tag CHSE | `b93961fd52`, `20661546b2` | multi-session CD overall SHA-1 changes; data identical | ignored by libchdr |
| CD+G cue type | `c9e87a6b7e` | new *accepted* input; no new metadata | |
| Extraction read errors are fatal | `14d07e35c1` | extraction aborts instead of writing stale data | |
| TOC/cue text written via `owritestream` (UTF-8, no BOM) | `4bb0fa2bbc` era | same text; LF endings | |

---

## 12. Bug and robustness list with repros

The repros live under `$SP/exp`.

| # | Bug | Repro | Also in 0.289? |
|---|---|---|---|
| B1 | GDI → CHD misplaces the HD area by the SD gap (+150 typical) | `gd/type*.tosec.head.chd`, `cmp0289/aerowings` | no (regression) |
| B2 | A GD cue mounted directly in MAME is not placed at 45000 | `cdprobe-head gd/dc-type1/redump/DC.cue` | no |
| B3 | 0 tracks → createcd loops forever (`-nan%`) | `cuequirks/empty.cue`, `lower.cue`, `limits/t0.cue`, `limits/lone.bin`, `x.ccd`, `toc/*.toc` without lengths | yes |
| B4 | A 100-track cue segfaults; a 100-track GDI aborts | `cd/limits` | yes |
| B5 | MOTOROLA audio is double-swapped (and a data track that opens a MOTOROLA file is swapped). *Fixed in the engine.* | `cd/motorola` | yes |
| B6 | A shared FILE after a different first FILE gets wrong offsets and lengths; the last track of a shared FILE that another FILE follows gets the whole file. *Fixed in the engine.* | `cd/mixed-files` | yes |
| B7 | Several tracks in one WAVE. *Fixed in the engine.* | `cd/wave/Game2.cue` | yes |
| B8 | Several FILEs per track (EAC "gaps appended to the previous track": INDEX 00 at the end of one FILE, INDEX 01 in the next). *Fixed in the engine:* the pregap is read from the end of the first file, which the previous track no longer takes (the track is read in two pieces), so the CHD is that of the disc as one file with INDEX 00/INDEX 01. EAC's other layouts (gaps left out as PREGAP, gaps appended to the next track) are 0.289's. This layout on a GD-ROM sheet, or with a PREGAP in the same track, is refused | `cuequirks/eac.cue` | yes |
| B9 | NRG: offset wrong after a track with a pregap; NRG pregap data dropped. *Fixed in the engine:* each track starts at its INDEX 00, and the pregap the image holds is stored (`PGTYPE:V…`) as a single-file cue sheet's INDEX 00 is, so the CHD is that sheet's. Images without pregaps give 0.289's CHD; images with pregaps (most real ones, and the `ps1-nrg` fixture's audio track) do not. The engine also refuses a first track of 0, a sector size of 0, a chunk chain without `END!` and a track outside the file, which crashed or hung 0.289 | `nrg/t1pg.nrg` | yes |
| B10 | `parse_iso` mis-types raw images (N%128, N%146). *Fixed in the engine:* the first two sectors' sync pattern and mode byte count as well as the size; such images are `MODE2_RAW`, as 0.289 types raw images of every other size | `xiso/raw128.iso`, `raw146.iso` | yes |
| B11 | TOC: START treated as virtual, PREGAP/SILENCE/multi-FILE ignored, no length gives 0 frames. *Fixed in the engine:* read as cdrdao reads them. START after frames the track holds: a stored pregap (cue INDEX 00); after ZERO/SILENCE/PREGAP zeros: a virtual pregap (cue PREGAP); START alone: where the statements so far end; several file statements in order; no length: the rest of the file; a lone DATAFILE length on any track; plain numbers as bytes (DATAFILE, ZERO) or samples (AUDIOFILE, SILENCE). Each gives the equivalent cue sheet's CHD, and the TOCs `extractcd` writes read as with 0.289. The `ps1-toc` fixture's CHD changes: its START (the file holds the pregap) is now a stored pregap, as in `mgs disc1.cue` | `toc/*.toc` | yes |
| B12 | CHD → toc → CHD changes V to virtual, so the logical layout grows (1480 → 1855 LBAs). *Open (the writer):* the engine reads a TOC without the `ZERO` line, `DATAFILE` holding the pregap and then `START`, back to the same CHD (same SHA-1s for `cd/rm.chd`), but `extractcd` still writes `ZERO` before a stored pregap, which reads (in 0.289 and cdrdao alike) as zeros followed by the stored frames. Dropping that line changes `extractcd`'s `.toc` output for every CHD with a stored pregap, so it waits for a decision | `cd/rm-toc.chd` | yes |
| B13 | Reader: pregap LBAs are served from the previous track, shifted by its padding; virtual gaps return the next track's data. *Not changed:* it is `cdrom_file`'s logical read, MAME's emulator side. chdman writes and extracts with physical reads, so no CHD or extract depends on it, and the page's identification reads data tracks from INDEX 01 on, where it is right | `cd/x-rm-dump-orig.raw`, `virtual-gaps` | yes |
| B14 | The CHSE session parser depends on metadata order. *Not applicable:* 0.289, and so the engine, neither write nor read CHSE; the engine's own `CUES` tag (`--keepcue`) goes after all CD metadata | `tools/mkorder` | n/a (HEAD only) |
| B15 | `dvdrom_file` rejects 4096-byte hunks (the createdvd default). *Not changed:* `dvdrom_file` is MAME's reader, not part of chdman; createdvd's default stays 4096 for byte identity, and the page uses `-hs 2048` for PSP | `tools/dvdprobe` | yes |
| B16 | `extractcd` on a DVD CHD aborts (`throw nullptr`); `extractdvd` on a CD CHD writes a bogus ISO. *Fixed in the engine:* both are errors (exit 1); `extractraw` still writes a CD's frames | `exp/xmis` | yes |
| B17 | BOM or lowercase cue keywords | `cuequirks` | yes |
| B18 | *Incidental, for A/B:* compressed CHDs with 1-3 compressed hunks fail to open ("Decompression error"), for example a 1-frame CD or a 1-hunk raw of text. **Cause:** a writer bug. `compress_v5_map` sizes the map's buffer without the Huffman tree that opens the map, so for a few hunks the bitstream overflows, the map is cut short and its last bytes are whatever lay past the buffer. *Fixed in the engine* (the buffer includes the tree, and an overflow is an error); the map is unchanged wherever 0.289's fit. | `exp/tiny` | yes |

---

## 13. Implications for a Discpress fork

Ranked by value to users and risk.

1. **Fix the GD-ROM regressions first. This is a correctness emergency.** The fix is validated **[exp `$SP/src/buildgdifix`]**:
   - **Minimal fix:** in `parse_gdi`, replace the virtual-pregap branch (`cdrom.cpp:2300-2314`) with 0.289's "gap → `padframes` of the previous track". Together with LZMA level 8, **GDI→CHD then becomes byte-identical to official 0.289** for all four DC layouts and the repo's `aerowings.gdi`, with HD at 45000 and exact GDI round-trips.
   - **Full 0.289 parity:** also restore the Redump-cue pregap strip in `parse_cue` (moving pregaps into the previous track with `splitframes`, and zeroing `pgdatasize` so HEAD's `write_metadata` emits no `V`). That makes cue→CHD byte-identical to 0.289 **[exp]**. Also restore 0.289's extract-to-cue "Redump rebuild" heuristics in `do_extract_cd`: without them HEAD's extractor no longer reproduces the Redump bins from 0.289-layout CHDs, and with them they are bit-exact **[exp `gd/rtfix2`, `rtfix3`]**.
   - Parity gives SHA-1s that match existing collections and 0.289-made DATs, and MAME's Naomi/DC CHDs where they were made that way **[unverified]**.
   - Add CI tests that check the *reader layout* (MAME `cdprobe` plus the Flycast model), not just round-trips: this regression passed round-trip tests.
2. **Decide what "same as chdman" means and say it accurately.** To match the official 0.289 byte for byte, set the LZMA level back to 8. That is a one-line change, and it works with the 26.02 SDK **[exp]**. Stop writing `CHSE` by default, or accept that SHA-1 differs for the 89 DC MIL-CDs, 38 Jaguar CDs and 161 PC multi-session discs. Correct the "0.289" labelling in the UI and the release notes. Change the Discpress test oracle from "our own native build" to "official release build + our build": that is how B1 and the LZMA drift slipped through.
3. **Make input handling robust in the browser.**
   - Refuse zero-track and over-99-track inputs before calling chdman (or fix them in the fork).
   - Normalise cues: strip the BOM and uppercase the keywords.
   - Build explicit cues for raw `.iso`, CloneCD and similar inputs.
   - Never pass non-cdrdao `.toc` files (redumper's binary `.toc`).
   - Fix MOTOROLA, mixed-file offsets, multi-track WAV, EAC gaps, the NRG offset and the TOC semantics.
   - Each fix needs a synthetic fixture; the generators in `$SP/exp/gen` can seed `tests/fixtures`.
4. **Offer Redump-exact extraction and in-browser verification.**
   - Store CATALOG, ISRC, FLAGS, INDEX ≥ 2 and the original track type string, or the original cue text, as **non-checksummed tags appended after the CD tags**. The SHA-1 stays identical to plain chdman and all readers ignore the tags **[exp]**.
   - Extract with CRLF and Redump single-track naming.
   - This raises Redump cue reproducibility from 77 % to about 100 %.
   - Verify each track against Redump DATs (per-track CRC32/SHA-1, and the cue hash) straight from the CHD. The official DATs include the cue; `db/mkdb.py` keeps only the first ROM entry per game from libretro's metadat DATs, so a per-track DB would be needed.
5. **Preserve session geometry.**
   - Extend `CHSE` (for example `SESSION:2 LEADOUT:6750 LEADIN:4500 PREGAP:150`); MAME's `sscanf` ignores the tail, but this changes the SHA-1.
   - Or use a non-checksummed `CHSG` tag.
   - Avoid encoding the gap as a virtual pregap by default: it double-counts in Flycast's MIL-CD heuristic.
   - Fix CHSE ordering fragility upstream: carry the session number in each track entry, or search by track number.
6. **Subchannel and CD+G.** Ingest `.sub`, `.subcode` and `.sbi` into RW_RAW (LibCrypt and other protections), and extract CD+G to CDRWIN `CDG` 2448-byte cue/bin. Check emulator subcode support with D1 before making it the default. RW_RAW changes the frame contents, and the TYPE/SUBTYPE text changes the SHA-1.
7. **New input formats, in priority order:**
   - CloneCD `.ccd/.img/.sub`;
   - DiscJuggler `.cdi` (Dreamcast);
   - ECM;
   - FLAC/WAV/AIFF audio in cues;
   - CSO/ZSO → DVD;
   - MDS/MDF;
   - fuller NRG;
   - MP3/APE (lossy or hard) last.
8. **DVD.** Consider `-hs 2048` as an option ("MAME-compatible DVD"), or document that MAME can't mount 4 KB-hunk DVD CHDs. Add a media-type check to `extractdvd`/`extractcd`.
9. **Validation tooling.** Add a "layout lint" (`chdman verify --cd`) that prints the disc as MAME and libchdr see it (INDEX 01 LBAs, session starts, GD 45000, V semantics, pregap ≤ frames, CHSE ordering) and warns about the known ambiguous cases.

**Compatibility risks to respect:**
- Any checksummed metadata or layout change alters SHA-1s (DATs, MAME software lists, user collections).
- Libchdr readers implement their own layout rules. The V-prefix, `PAD` and `POSTGAP` semantics differ between MAME and Flycast, and Flycast ignores POSTGAP.
- The CHSE parser depends on order.
- Flycast's MIL-CD heuristic interacts with any stored session gap.
- MAME's DVD reader requires 2048-byte hunks.
- Decoders derive the LZMA dictionary size from the hunk size, so the encoder must keep the same derivation.

---

## 14. Open questions

1. Real-emulator confirmation of B1 (Flycast, MAME `dc`/`naomi`, Redream) on actual TOSEC GDIs. Also: do some TOSEC GDIs have a 450-frame track01, which would give no shift? (D1.)
2. How DuckStation, Beetle, PCSX2, PPSSPP, Flycast forks and other libchdr users treat `PGTYPE:V…` in **CHGD**, a `CHSE` at metadata index 0, RW_RAW subcode tracks (CD+G), and CHT2 `POSTGAP`. (D1/D2.)
3. Whether MAME upstream will revert or fix #15870 and #15808 before 0.290, and whether its GD/Naomi CHD SHA-1s were made with the TOSEC layout. (E.)
4. The byte order and layout of CloneCD `.sub`, redumper `.subcode` and Nero audio (MAME assumes LE). These need real samples; none are allowed in the repo.
5. *(Resolved for the tested fixtures.)* LZMA 26.02 at level 8 reproduces 0.289 byte for byte on 4 fixtures. It is still worth confirming on large and odd inputs, including non-default hunk sizes. (A/G.)
6. *(Resolved.)* The root cause of B18 (small CHDs that fail to open) is chdman's map writer, not the readers: the CHD itself is broken (its map is cut short), so libchdr has nothing valid to read either. chdman 0.289 reads the CHDs the engine makes.
7. Whether the v4 CHGT-to-GDI extraction path (`version() > 4` swap) emits big-endian audio. It is untested for lack of a v4 sample.
8. Whether any emulator relies on track FLAGS (pre-emphasis) or CATALOG/ISRC. That determines whether they belong in checksummed track metadata or only in non-checksummed fidelity tags.

---

## Appendix: tools and reproduction

All paths are relative to `$SP` (`$SP`).

- `bin/chdman-head` is a symlink to `/home/user/discpress/build/chdman-native` (HEAD). `bin/chdman-0289` is the official `mame0289` built from `src/mame0289-C` with `src/wasm-C` (the Makefile minus `-DZLIB_CONST`; files missing in 0.289 removed from `sources.mk`).
- `src/buildmix/chdman-native`: HEAD source with 0.289's LZMA SDK and level 8. `src/buildlvl8/chdman-native`: HEAD source (26.02 SDK) with level 8. Both are byte-identical to 0.289.
- `src/buildgdifix/chdman-native` (source in `src/mamehead-gdifix`): level 8, plus the 0.289 `parse_gdi` gap handling, plus the 0.289 GD cue pregap strip. Byte-identical to 0.289 for DC `.gdi` and `.cue` input.
- `tools/cdprobe-{head,0289}`: prints MAME's TOC (phys/log/chd offsets, sessions, flags) for a CHD or a directly mounted image, and optionally dumps all logical LBAs through `read_data`.
- `tools/flyview.py`: Flycast layout rules, including the MIL-CD heuristic. `tools/dvdprobe`: `dvdrom_file` check. `tools/mkorder`: CHSE ordering. `tools/oversha`: metadata contribution to the overall SHA-1. `tools/cuestats.py`: Redump cue statistics.
- Generators: `exp/gen/gen.py` (DC GD discs, types 1/2/3/3-split, Redump and TOSEC), `exp/gen/cdcases.py` (mixed-mode, single-bin, mixed files, WAVE, MOTOROLA, virtual gaps, HTOA, truncated, multi-session, CD+G), `exp/gen/nrg.py`, `exp/redumpcue/rt.py` (real Redump cue text with synthetic bins).
- Redump reference data: `ref/cues/*.zip` (21 systems), `ref/pce-dat.zip`, Redump forum threads, `ref/cdrdao.man`, `ref/libodraw-cue.asciidoc`, `ref/flycast-chd.cpp`, `ref/libchdr-*.h`.

Web sources:
- [Redump multisession cue thread](http://forum.redump.org/topic/20409/done-discussing-the-multisession-cue/)
- [Redump Dreamcast multi-cue thread](http://forum.redump.org/topic/19969/done-sega-dreamcast-multicue-gdi/)
- [cdrdao man page](https://github.com/cdrdao/cdrdao/blob/master/dao/cdrdao.man)
- [libodraw CUE sheet format](https://github.com/libyal/libodraw/blob/main/documentation/CUE%20sheet%20format.asciidoc)
- [Wikipedia: Cue sheet (computing)](https://en.wikipedia.org/wiki/Cue_sheet_(computing)); the CDRWIN manual cited there could not be re-fetched
- [Flycast CHD reader](https://github.com/flyinghead/flycast/blob/master/core/imgread/chd.cpp)
- [libchdr](https://github.com/rtissera/libchdr)
- MAME PRs [#15808](https://github.com/mamedev/mame/pull/15808) and [#15870](https://github.com/mamedev/mame/pull/15870), both merged without compatibility discussion
- [redumper](https://github.com/superg/redumper)
