# App Layer Rules (`app/AGENTS.md`)

Applies to `app/` (`index.html`, `ui.js`, `ident.js`, `quirks.js`, `worker.js`, `style.css`, `help.html`) and how they assemble into `dist/discpress.html`.

## Single-File Assembly (`scripts/assemble.py`)

`scripts/assemble.py` substitutes exact placeholders (each must appear **exactly once** via `replace_once`):

- `/*STYLE*/` ← `app/style.css`
- `<!--HELP-->` ← `app/help.html`, with `/*DBVER*/` (database version) and `/*VERSION*/` (root `VERSION`) substituted (contains `#patchBox` / `#patchPre`, lazily populated by `loadPatch()`)
- `/*UI*/` ← `app/ui.js`, with `/*IDENT*/` (`app/ident.js`), `/*QUIRKS*/` (`app/quirks.js`), `/*VERSION*/` (root `VERSION`), and `/*ENGINE_SHA*/` (first 12 hex chars of `engine-sources.sha256`, or `'dev'`) substituted; `/*GAMEFACTS*/{}` inside `ident.js` ← validated JSON built from `db/facts/*.tsv` (`game_facts`; schema and licensing rules live in `db/facts/README.md` and `discpress-db-and-brand`)
- `/*WORKER*/` + `/*WORKER_CRC*/` ← Emscripten glue `build/chdman.js` + `app/worker.js`, embedded as `text/plain` with its CRC-32 in `data-crc` (verified at runtime by `Engine.workerUrl()` before creating the Blob URL)
- `/*WASM_SIMD*/`, `/*WASM_BASE*/`, `/*PATCH*/`, `/*GAMEDB*/` ← gzip (`mtime=0`, OS byte `3`) + base64 payloads (plus `/*SIMD_SIZE*/`, `/*BASE_SIZE*/`, `/*PATCH_SIZE*/`, `/*DB_SIZE*/`):
  - `/*GAMEDB*/` packs `db/db.json.gz` compiled into the compact columnar binary format `DPDB\x02` (`encode_gamedb_bin`), then gzipped and base64-encoded
  - `/*PATCH*/` embeds `engine/mame-0.289.diff` + the 10 new files (`wasm_helper.cpp`, `ecm.cpp`, `audio.cpp`, `7z_stream.c`, `lz4_block.c`, `par_lib.js`, `version.cpp`, `shim/SDL2/SDL.h`, `engine/libm/flac_libm.h`, `engine/libm/flac_libm.c`) in `#patch-src`, lazily inflated by `loadPatch()`
- After `</html>`, `assemble.py` appends `<!-- engine sources sha256 … -->` from `build/engine-sources.sha256` (without it, `assemble.py` warns and `scripts/check-dist.sh` refuses the page).

**Hard syntax rules:**
- Plain ES5-style browser JS (`var`/functions, no modules/imports).
- No inlined JS (`ui.js`, `ident.js`, `quirks.js`, `worker.js`) may contain `</script`, `<!--`, or `<script` (case-insensitive).
- `app/style.css` may not contain `</style`.
- `app/worker.js` must retain its header comment (`/* chdman web worker:`) because `scripts/extract-build.py` uses it as a fallback boundary when `worker.js` has been edited since `dist/discpress.html` was last built.
- `ui.js` selects the SIMD or baseline wasm at runtime via `WebAssembly.validate`.

## Main Thread Architecture (`app/ui.js` & `app/quirks.js`)

`app/ui.js` is one IIFE owning the job model, CLI builder, OPFS bookkeeping (`Store`), persistent handles (`HandleStore`), settings, recovery, and worker orchestration (`Engine`):

- **Input grouping & container formats:**
  - Files group into jobs by descriptor (`.cue`, `.gdi`, `.toc`, `.nrg`, GOG `.ins`, Alcohol 120% `.mds`/`.mdf`, etc.).
  - CloneCD `.ccd` (v2 `[Entry N]` and v3 `[TRACK n]`) translates into a cue sheet for its `.img` by `ccdToCue`, with an opt-in Tier-X `"Include subchannel data (CD+G / RW_RAW)"` toggle when `.sub` is present (transposing planar 8×12 `.sub` → interleaved `RW_RAW`).
  - Alcohol 120% v1.x (`.mds` + `.mdf`) reads DVDs directly and CDs via `StrideSliceStore` + synthetic `.cue` (auto-extracting PS1 LibCrypt `.sbi` from `+96B` interleaved Q subchannels via `sbiFromMdf`); v2 `.mdx` is refused; ImgBurn DVD-9 `.mds` sidecars next to `.iso` are skipped cleanly.
  - DiscJuggler `.cdi` (v2/v3/v3.5) parses trailer/sessions/tracks via `parseCdi`: 1-session `.cdi` converts to CHD; multi-session `.cdi` identifies the disc (`IP.BIN`), recommends keeping `.cdi`, defaults to 1-click `.cue + .bin` extraction (`cdi-extract`), and offers guarded Tier-X Flycast 2.8+ CHD mode on compatible 2-session Audio+Data MIL-CDs.
  - Audio track cues (`.flac`, extended/RF64/24-bit/float `.wav`, `.aiff`/`.aifc`, `.ogg`, `.mp3`, plus GOG `.ins`) decode on demand via WASM `AudioStore` (`wasm/audio.cpp`) into Red Book 44.1 kHz 16-bit LE stereo PCM (matching Redump/DAT checksums for lossless tracks, warning with `lossy-audio`/`resampled-audio` otherwise).
  - `.cso` / `.zso` becomes an input flagged `ciso`, passed to chdman as `<name>.iso`. PSP/PS2 DVD cards and DVD CHD `Extract` can also write `--block=2048` CSO v1, CSO v2, or ZSO (`ciso-write`) across helper workers.
  - Original Xbox `.iso` (XGD1 `0x18300000` or un-scrubbed XISO `0`) defaults to creating a scrubbed `.xiso.iso` for `xemu` via pure-JS `xiso-repack` (preserving exact XDVDFS AVL trees and `FILETIME`).
  - ECM `<name>.ecm` stands for `<name>` (referenced by a descriptor or a lone `.bin` via `trackFile`), flagged `ecm`.
  - PS1 `EBOOT.PBP` creates one job per disc; `sniffPbp` reads each disc's TOC into a cue sheet and flags the image `pbp`.
  - `.zip` and `.7z` archives join the picked file list (`zipEntries`, `un7zEntries`): worker-side streaming into OPFS `chdman-unzip/` (else memory up to `UNZIP_MEM_MAX`) verifies CRC-32s and pre-seeds `crcCache`.
  - Unsupported formats (`UNSUPPORTED`: `.mdx`, `.isz`, `.hdi`, `.nhd`, `.vhd`, `.rar`) produce an explanatory card instead of being ignored.
- **Target Environments, CHD Auditor & Reversible Repairs:**
  - `#targetSelect` in `#chips` (mirrored by `#setTarget` in `#settings`) selects one of 6 `TARGETS` (`universal`, `fast-universal`, `esde-modern`, `handheld-linux`, `mister`, `legacy`), coordinating default preset, PS2 CD/DVD mode, reversible layout repairs, `--keepcue`, and `.m3u` folder layouts (`flat`, `esde`, `discs`, `minui`); `settings.folderLayout` (`flat`, `tree`, `console` via `CONSOLE_DIRS`) controls folder organization.
  - `buildRepairedCueJob` (`app/quirks.js`) implements reversible Tier-X cue/disc layout repairs (`gaps`, `sessions`, `mode2`, `dcgaps`, `pcsession`) using `ZeroStore`/`ConcatStore`, `--sessions` (`CHSE`), and `--trailer` (`DPRC0001` reversed on `extractcd --redump`).
  - `auditChd` (`app/quirks.js`) runs 12 health checks on loaded `.chd` files, rendered in `#chdAudit` with 1-click `copy` (`--stripmeta`, `-hs 2048`, codec re-encode) and 2-step rebuild repairs.
- **Command building, profiles & quirks:**
  - `buildJob` builds chdman argument lists; `PROFILES` (applied via `applyIdent`) provides console-specific CHD type and hunk size (e.g., PSP `2048`), Zstd warnings (`noZstd`, for all presets using Zstd), MiSTer warnings (`noMister`), Xbox XISO defaulting (`xiso: true`), notes for systems whose emulators don't load CHDs (`keep`: does not force CHD type), and DOSBox Pure hints.
  - **Compatibility mode & target presets:** `settings.compat` (migrating stored `ps2dvd: 'cd'` from ≤ 1.8; `COMPAT_NAME`) turns PS2 DVD games into CD CHDs (for AetherSX2, NetherSX2, and PCSX2 builds before April 2023) and makes Zstd presets warn for every console (`ZSTD_OLD`). User-edited presets (`job.presetEdited`) and non-target-switching profiles (`universal`, `fast-universal`, `esde-modern`, `handheld-linux`) never auto-switch compression (except LaserDisc always uses `default`); on `mister` target, `defaultPresetFor` falls back from `mister` to `plan` for non-MiSTer consoles / Sega CD 32X / DVDs, and on `legacy` target switches `pc` discs to `none` (DOSBox Pure).
  - Per-console and per-disc rules live in `QUIRKS` (`app/quirks.js`), each with a stable `id` rendered as `data-quirk` on its note:
    - `act: 'nokeepcue'` omits `--keepcue` (Saturn, Sega CD, and PC Engine CD: Kronos, Yabause, jgenesis reject unknown metadata tags).
    - `act: 'serialname'` names NAOMI, NAOMI 2, Triforce, and Chihiro GD-ROMs `<serial>.chd` (e.g. `gds-0014.chd`) when a `GD[LSTX]-nnnn` serial is known, falling back to `act: 'norename'` (`naomi-name`); `arcade-norename` (`ks573`, `ns246`) uses `act: 'norename'` (via `renameWanted`).
    - `warn: true` renders in warning colour; more than two non-warning notes are grouped.
    - Evaluated against `quirkCtx` (identification + `discModel` from `cueModel`/`tocModel`/`nrgModel` in `ident.js`: tracks, sessions, `INDEX 00`, `PREGAP`, `POSTGAP`).
  - PAL PS1 `.sbi` or DuckStation `.lsd` sidecars pair by filename, identified title, or PS1 serial (`sbiJob`, `pairLooseSbi`), save alongside the CHD under its name, or generate from CloneCD `.sub`/`.subcode` (`scanSub`, `sbiFromSub`) or Alcohol `.mdf` subchannels (`sbiFromMdf`), detaching if identified as another console (`detachSbi`). `GameFacts` loads `db/facts/libcrypt.tsv` (`libcrypt-missing`) and `db/facts/saturn-cart.tsv` (`saturn-rom-cart`, `saturn-mpeg-card`, `saturn-ram-4m`, `saturn-ram-1m`).
  - Multi-disc sets show disc count (`GameDB.discCount`; `data-quirk="set-incomplete"` set by `renderResult`, not `QUIRKS`) until all discs convert; two or more `(Disc N)` / `(Disc A)` results generate an `.m3u` on the first disc's card (`discSet`).
- **Input guard rails (`app/ui.js`):**
  - chdman 0.289 reads descriptors byte-for-byte with case-sensitive keywords and loops forever on 0 tracks. `descriptorJob` decodes descriptors (`decodeText`: BOM, UTF-16, Windows-1252), and `fixDescriptor` supplies a normalized copy (LF line ends, upper-cased cue keywords, quoted filenames with spaces/apostrophes, and `TRACK nn CDG` rewritten to `AUDIO RW_RAW` parsed natively by chdman 0.289 with `cdg-subcode` warning) or rejects the job (`job.invalid`: no tracks, track numbers outside 1–99).
  - Engine reads cdrdao TOCs and Nero stored pregaps natively; `probePlan` in `ident.js` finds data tracks the same way.
  - Descriptor filenames split via `chdWords` (single/double quotes as chdman does); typed Advanced tab commands split via `shellWords`.
  - Binary `.toc` files are skipped; raw-sector `.iso` files get an `autoCue`; any `nan% complete` progress aborts the run (`STALLED`, including in Advanced tab).
  - Track matching (`pickTrack`) resolves from the descriptor's own folder, referenced subfolder, or individually picked files—never another game folder's same-named file (e.g., `track01.bin`) or an already-claimed file. Names compare in NFC (`nameKey`, handling macOS NFD `é`), indexed once per added batch (`nameIndex`); duplicates key by path, size, and date (`fileKey`).
- **Execution, warm worker pool, threading & saving:**
  - `Engine.run` borrows one **job worker** (`coordPool`, max 2) plus `N` **helper workers** (`helperPool`, max `Tuning.cap`) connected via `MessageChannel` (`borrowCoord`/`returnCoord`, `borrowHelpers`/`releaseHelpers`, reattached via `attach`/`detach`), with idle-reap timers (`poolIdleMs`: 60 s desktop / 20 s mobile) and WASM memory-cap eviction (`poolMemCap`: 96 MiB coordinator / 64 MiB helper).
  - `threadCount()` resolves `settings.threads`: `'auto'` uses `Tuning` (one-off benchmark compressing synthetic DVD hunks at 1, 2, 3, 4, 6, 8… threads until a step adds < 8%, twice below reported cores or once above; cached in `localStorage['chdman-web-tuning']` keyed by cores + UA; capped at 8 on touch devices, 4 on iPhones via `iosThreadCap`, 16 elsewhere; donates winning helpers to `helperPool` via `adoptHelpers`).
  - Extract and verify jobs allocate `readHelpers()`: thread setting capped at `cores - 1` so the job worker stays fed.
  - `verifyResult` runs single-pass `verify --redump` (for CD/GD-ROM/DVD; plain `verify` otherwise) on finished CHDs (button, `verifyAfter` setting, or automatically after a helper failure/retry).
  - Memory-only jobs (no OPFS) prompt before running when results may exceed 2 GB (1 GB on touch devices; `memoryNeed`/`confirmMemory`, also in Advanced tab).
  - When `showSaveFilePicker` exists (Chrome/Edge), results ≥ 1 GB (`SAVE_PICKER_MIN`) prompt for destination (`savePicked`) so cancelling keeps them unsaved; plain downloads count as saved once started. Batch folder starts (`startAll` with 2+ folder jobs) show `<dialog id="collisionDlg">` (`showCollisionDialog`: Cancel / Skip existing / Replace all); single-job overwrites use `confirmReplace`.
  - Jobs can be cancelled/removed before chdman starts (`abortStart`); a helper failing to start fails the job immediately instead of hanging.

## Worker & Storage Architecture (`app/worker.js`)

Appended to Emscripten glue (`build/chdman.js`). Handles **9 roles**: `run` (`chdman_begin`/`chdman_resume`/`chdman_abort`), `helper` (CHD hunk compress/decompress + `ciso-batch`), `reader` (CHD/CSO/ECM/audio sector reads + `wasm_chd_inspect`/`wasm_chd_metadata_list`/`wasm_chd_sha1`), `crc`, `unzip`, `un7z`, `ciso-write`, `xiso-repack`, and `cdi-extract`, plus pool/lifecycle messages (`attach`, `detach`, `visibility`, `throttle`).

Custom Emscripten filesystem (`makeFS`) backends (12 stores):
- `BlobStore`: reads picked files in place via `FileReaderSync`.
- `OpfsStore`: writes outputs to Origin Private File System (also supports preserving `slot0` on checkpoint resume).
- `MemStore`: in-memory fallback when OPFS is unavailable.
- `ZeroStore` & `ConcatStore`: virtual zero-filled sectors and spliced multi-source segments for reversible Tier-X repairs (`buildRepairedCueJob`).
- `StrideSliceStore`: reads fixed-stride sectors from Alcohol `.mdf` / interleaved subchannel images.
- `AudioStore`: windowed WASM audio decoding (`wasm/audio.cpp`) into 44.1 kHz 16-bit LE stereo PCM.
- `CisoStore`: reads CSO v1/v2 or ZSO as an ISO (deflate via `wasm_inflate_raw`, LZ4 via WASM `wasm_lz4_block` with JS `lz4Block` fallback; also used by `reader` and `crc`).
- `PbpStore`: reads a PS1 PBP disc as its raw image (16-sector blocks, deflated via `wasm_inflate_raw` or stored).
- `EcmStore`: scans ECM chunk headers placing checkpoints every 1 MiB, rebuilds sync/headers/EDC/ECC windows via `wasm_ecm_decode` (`wasm/ecm.cpp`), verifies final EDC, emits `scan` progress messages to prevent reader timeouts; also serves `reader` and `crc`.
- `CrcStore` (`outMode: 'crc'`): checksums outputs without storing bytes—fallback used by `redumpCheck` (`extractcd --redump` / `extractdvd`) only if single-pass `verify --redump` emits no `Redump:` lines.
- `StreamStore`: streams outputs directly into a chosen folder via File System Access API (`s-*` messages handled by `makeSink` in `ui.js`; guarded by `confirmReplace` / `#collisionDlg`, never deletes an existing file on cancel/error; pins the first 8 MiB and expands dynamically up to 64 MiB via `checkPin` for uncompressed CHD v5 maps; `s-ack` flow control pauses chdman via `wasm_out_full` whenever > 64 MB is unwritten).
- **iOS web-view staging fallback:** if a worker cannot read picked files, it sends `stage-request` and the page streams chunks (`stage-chunk`/`stage-ack`/`stage-end`).

**Helper failure resilience:** the job worker tracks each batch until answered, validates each item's length ≤ hunk size, and drops any helper that traps or lies; remaining helpers take over. If all helpers fail during compression, the page retries once (`engineFailure`) before blaming the browser engine; extract/verify fall back to in-worker decompression.

## Game Identification (`app/ident.js`)

Runs on the main thread; reads boot headers via ISO 9660 from raw images or from CHDs via worker `reader` (`wasm_probe_*` in `wasm/wasm_helper.cpp`), and computes CRC-32 in a worker via wasm zlib `crc32` (with JS fallbacks).

- **`detectTrack` detection order:** Sega headers (`saturn` + `satCart`, `dc`/`naomi`/`naomi2`/`triforce`/`chihiro` + WinCE, `segacd` + 32X) → 3DO → GameCube/Wii → FM Towns (`IPL4`), PC-98 (`IPL1`), X68000 (`X68SCSI1`), Bandai Pippin (`detectPippin`) → sectors 0–15 boot scan (PC Engine CD, PC-FX, backup 3DO OperaFS) → CD-i volume descriptor → ISO 9660 volume (PSP / UMD Video / UMD Audio, PS1/PS2 with `hasUdf` & DVD-9 layer break, Konami System 573 `ks573`, `PSX.EXE`-only PS1, PS3, Video CD, CD-i Bridge, Neo Geo CD, Playdia, ISO fallbacks for FM Towns / PC-98 / X68000, CDTV / CD32 / Amiga CD `DISK.INFO`, Xbox/Xbox 360, VM Labs Nuon before `VIDEO_TS`, video discs, else weak `pc`) → without ISO 9660, Xbox/Xbox 360 XDVDFS partition (`XDVDFS_AT`). Audio-only cues check Jaguar CD (`detectJaguar`, `plan.audio`).
- **Serial lookup & ranking:** `canonKey` normalizes per system (e.g., Sega `MK-51064` → `51064`). `serialCandidates` checks exact serial, version-suffix-trimmed serial, and PS1 boot filename. `bySerial` ranks by Sega header disc number (`det.disc`) → size → match kind (`serial`, `trim`, `boot`, `base`) → region (`det.area`, `regionFits`). Trimmed/base matches without size match never auto-name on region mismatch, and if a Sega header title disagrees (`titleFits`), are only offered (`serial-related` with *Use this name*). Note attributes `data-method`, `data-how`, `data-disc`, `data-region` record what matched.
- **Two-phase identification:** `onProvisional` unblocks conversion (`job.identKnown`) as soon as console/serial/sizes are known; checksum later confirms exact release and `renameOutputs` updates finished results unless already saved, user-named, or streamed to a folder (which waits for checksum). Removing a card cancels its checksum (`abortChecksums`).
- **Database & user DATs:** `db/db.json.gz` stores `{version, systems: {key: tsv_rows}}` (6 core fields `name\tserial\tsize\tcrc\ttrack\text`, plus optional `ntrk\tdigest` from `--redump-xml` for full-disc `discDigest` verification) with multiple serials joined by `|` (`entry.serials`); `scripts/assemble.py` compiles it into columnar binary `DPDB\x02` decoded by `GameDB._load` (with JSON fallback). Every key in `db/mkdb.py` must exist in `SYSTEMS` in `ident.js` (35 keys total, including 8 non-DB keys: `gc`, `wii`, `xbox`, `xbox360`, `ps3`, `vcd`, `video`, `pc`). User Logiqx XML / clrmamepro DATs parse via `parseDat` into `Dats` and persist in OPFS `chdman-dats/` (`DatStore`); `datCheck`/`datMatch`/`datApply` match every track by size + CRC-32 (for CHDs via single-pass `verify --redump`, falling back to `redumpCheck`).

## iPhone, iPad & Hosted Version (`docs/ios/README.md`, `web/`)

- **Hosted registration (`initHosted`):** Over `https://`, the page registers `'sw.js'` (deployed flat from `web/sw.js`; network-first, cached fallback after 4 s or on server error) and then injects manifest and PNG icon links.
- **Saving limits:** Share sheet copies files into memory; on iOS, results over `SHARE_MAX` (**256 MB** in Home Screen web apps `iosHomeApp`, **512 MB** in Safari) download instead (routing `<a download>` through `<iframe name="dl-sink">` in `iosHomeApp`). App web views (`iosWebView`) usually cannot download, so `#iosTip` directs users to the online version in Safari.
- **iOS 26 edge blur:** Home Screen web apps get Liquid Glass top blur unless a fixed/sticky box ≥ 90% viewport wide with a solid background and no `backdrop-filter` sits at the top (`LocalFrameView::fixedContainerEdges`). Keep the header `position: sticky` with solid background and no backdrop filter in `mode-shell`. Verified by `tests/ui/mobile.spec.js`.
- **Recovery, OPFS checkpoints & persistent handles:** `Recovery` records running jobs, unsaved results, and **crash-resumable OPFS checkpoints** (`Recovery.resumable`, `rec.ckpt`, `Store.hasCkpt`, `ckpt.log`/`ckpt.0`/`ckpt.1`) in `localStorage` guarded by a per-session Web Lock; after a reload, `Store.cleanupStale` preserves unsaved OPFS results (`renderEarlier`) and resumable checkpoints, or reports lost in-memory results (`Recovery.lost`). `HandleStore` (IndexedDB `chdman-handles`) persists chosen output directory handles across visits.

## Debug Flags (`localStorage['chdman-web-debug']`)

*(Sole reference for all 15 debug flags.)* JSON object supporting:
- `"stage": 1` (async-copy inputs into storage + main-thread CRC) or `2` (fail worker reads to force page chunk streaming, iOS web-view path)
- `"identDelay"`, `"crcDelay"`, `"crcSlow"` (ms delays)
- `"sinkMax"`, `"memMax"`, `"shareMax"`, `"savePickerMin"` (override byte thresholds)
- `"ckptStride"` (override OPFS checkpoint interval in hunks for deterministic mid-conversion resume testing)
- `"poolIdleMs"`, `"poolMemCap"` (override warm worker pool idle-reap delay in ms and memory-eviction threshold in bytes)
- `"failHelpers"`: `"one"`, `"all"`, `"always"` (simulate WASM traps), or `"lie"` (wrong hunk response)
- `"failStorage"`: `"lock"` or truthy (simulate locked/missing OPFS)
- `"unzipFull"`: simulate full storage during zip extraction
- `"hosted"`: simulate `https://` online mode (service worker + manifest) locally
