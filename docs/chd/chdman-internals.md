# Lane B: chdman internals, the CHD writer/extractor pipeline, and the Discpress wasm patch

> Part of the [Discpress chdman research dossier](README.md), 2026-09-27. Written by a research agent from source reading and experiments. `$SP/...` paths name artefacts in the temporary research workspace, which is not part of the repository (reproducible lab tooling is in [lab/](lab/)). Lane letters (A, B, C, D1, D2, E, G) refer to the reports listed in the README.

Research dossier for a hard fork of MAME's `chdman`. The subject is Discpress's pinned MAME source, commit `76c7d197ed` (`mame0289-1167`, post-0.289 master dated 2026-09-27).

## 0. Scope, method and caveats

- **What I read.** All of `src/tools/chdman.cpp`, `src/lib/util/chd.{h,cpp}`, `chdcodec.{h,cpp}`, `hashing.cpp`, the CD ECC helpers in `cdrom.cpp`, `osdsync.cpp`, `ioprocs.cpp` and `corefile.cpp` (read/write paths). On the project side: `wasm/*`, `app/worker.js` (parallel and helper roles) and `app/ui.js` (`Engine`, `Tuning`).
- **Line numbers.** `path:line` citations refer to the pristine upstream files at 76c7d19. The working tree has `wasm/mame.patch` applied, which shifts lines in `chd.cpp`, `chd.h` and `chdman.cpp`, so I exported the unpatched files with `git show HEAD:<path>` into `$SP/src/upstream-B/`. Every other file is unmodified, so its working-tree lines are the upstream lines.
- **What I ran.** Native chdman was built from this source (`build/chdman-native`, `-O2`, `FLAC__NO_ASM`, `Z7_ST`). I also wrote:
  - a micro-benchmark harness linked against `build/obj-native`: `$SP/bench-B/harness.cpp`, which measures per-thread CPU time;
  - a per-thread CPU sampler: `$SP/bench-B/threads.py`;
  - a hunk dumper: `$SP/bench-B/hunkdump.cpp`;
  - an object-level dependency-closure script: `$SP/bench-B/closure.py`;
  - four comparison builds:
    - chdman from the **`mame0289` release tag** (`$SP/build0289-B/chdman-native`);
    - HEAD with LZMA level 8 (`$SP/bench-B/lzma8/`);
    - HEAD with MAME's official FLAC SSE-intrinsics configuration (`$SP/bench-B/flacasm/`);
    - HEAD with FLAC compiled with FMA contraction (`$SP/bench-B/flacfma/`);
  - a Node runner for the shipped wasm (`$SP/bench-B/wasm/run.cjs`).
- **Caveat on timings.** The host is a 4 vCPU Xeon at 2.1 GHz (with AVX2, AVX-512 and SHA-NI) shared with other research agents, and its load average was 6 to 15 during my runs. **Wall-clock thread-scaling numbers from my runs are unreliable.** I report per-thread **CPU time** wherever possible. I also quote the project's own benchmark files, `tests/.cache/bench/*.md`, which were recorded earlier on the same machine type while it was presumably quieter.
- **Caveat on fixtures.** The fixtures are synthetic (`tests/fixtures/discgen.py`):
  - the DVD filler is 30 % zeros, 30 % random "words", 15 % gradients and 25 % random bytes;
  - the audio is sine tones plus noise.

  Compression ratios, and which codec "wins", are therefore indicative only.

### Executive summary (most important findings)

1. **Discpress's output is not byte-identical to the chdman 0.289 release.** It is only identical to chdman built from 76c7d19. Commit `c23567b509` (2026-08-04, four days after the `mame0289` tag) changed the CHD LZMA level from 8 to 6 when it updated the LZMA SDK to 26.02. I verified the effect:
   - HEAD with the level set back to 8 reproduces the 0.289-release bytes exactly;
   - HEAD at level 6 differs in every CHD that has an LZMA hunk (`twine`, `mgs`, a 32 MB DVD slice and `arcade.img`);
   - data and overall SHA-1 are unchanged in all of these.

   zstd 1.5.5→1.5.7 (`f9050e8508`) also changes `zstd`/`cdzs` bytes. For GD-ROM input (`aerowings.gdi`), the pinned build even produces a **different Data SHA-1 and different metadata** than 0.289, because of the pregap commits #15808 and #15870. The release notes' claim "exactly the same, byte for byte, as … desktop chdman 0.289" is therefore inaccurate. The README's "identical data checksums" is accurate except for GD-ROM.
2. **The last hunk carries stale bytes, compressed into the file.** A final partial hunk contains stale data from 256 hunks earlier, left over in the work ring buffer. I verified this on the bench CD (9,792 bytes) and on an odd-sector DVD (2,048 bytes).
   - The bytes are invisible to readers and SHA-1s, but they are part of the file bytes.
   - Any reimplementation must emulate this to stay byte-identical.
   - In `createhd`, when the geometry (`-chs`, a template, or `guess_chs` rounding) exceeds the input size, the same bug puts **visible garbage** into the image. In my test, 2 MB of padding became two copies of the input's second MB. The Data SHA-1 covers the garbage.
3. **Serial bottlenecks.**
   - A single reader thread does read + CD frame assembly + whole-stream SHA-1. MAME's portable SHA-1 runs at about 150 MB/s here, against about 1.47 GB/s for OpenSSL with SHA-NI.
   - Compression is capped at **16 worker threads** (`WORK_MAX_THREADS`).
   - `-np N` gives **N−1 compression workers**: `-np 2` is about `-np 1` (project bench: 59.4 s vs 62.9 s).
   - With `-np 1`, or on a single-CPU host, the main thread **busy-spins** on `clock()`: 586,588 `clock_gettime` syscalls for an 8 MB input, burning about as much CPU as the real work.
4. **Redundant work in the default trial.** Every codec compresses every hunk.
   - On CD data hunks, `cdfl` costs 35 % of the trial and never won in my data.
   - On audio hunks, `cdlz` and `cdzl` cost about 60–63 % and never won.
   - `cdlz` and `cdzl` each redo the frame split and the ECC verify/clear.
   - The generic `flac` codec encodes 2 to 3 times per hunk (BE, LE, then BE again).
   - Duplicate hunks inside the 256-hunk in-flight window are compressed anyway.
   - Per-hunk SHA-1 and CRC-16 cost about 10.5 ms/MB, about 5–7 % of trial CPU.
5. **Decompression is single-threaded.** `verify`, `extract*` and the input side of `copy` run at about 45 MB/s (verify) and 49 MB/s (extractcd). Hashing alone is about 45 % of verify's CPU.
6. **CLI and error-handling defects I verified.**
   - `verify` exits **0 on a SHA-1 mismatch**.
   - `verify` exits 0 on an **interrupted/partial CHD** ("No verification to be done … no checksum").
   - `extractcd` on a non-CD CHD aborts with an uncaught `throw nullptr` (exit 134).
   - `-us 0` / `-ss 0` crash with SIGFPE (exit 136).
   - `copy -i x.chd -o x.chd -f` **destroys the input**.
   - `extractcd -o game.bin -f` overwrites the binary with the TOC text.
   - `dumpmeta` to stdout is polluted by the banner line.
   - `addmeta`/`delmeta` refuse compressed CHDs.
   - A cue given by absolute path breaks absolute `FILE` entries.
   - `createhd`/`createraw` silently pad with stale data.
   - The map-size computation overflows `int` for images of 200 GiB or more (4 KiB hunks).
7. **The wasm patch is small and sound.** Byte identity rests on three things:
   - codecs are pure functions of (type, hunk size, bytes);
   - the writer (main instance) makes every dedupe decision, in order;
   - the same wasm module and library build is used on both sides.

   Asyncify is needed only because chdman's `main()` owns the loop. `chd_file_compressor` is already a resumable state machine (`compress_begin`/`compress_continue`), so a fork can drive it from JS and drop Asyncify.
8. **A BSD-3-Clause fork is possible.** chdman's real object closure is 78 of the 144 compiled objects, and every file in it is BSD-3, zlib, MIT, Xiph-BSD, public domain or (for zstd) BSD/GPLv2 dual. Two compiled-but-unneeded files have no license header: `disasmintf.cpp` and the `nanosvg.cpp` wrapper. MAME's `COPYING` makes header-less files GPL "as part of the whole", so drop them.

---

## 1. The CLI surface

### 1.1 Commands (dispatch table `src/tools/chdman.cpp:709-916`)

| Command | Handler | Required options | Optional options |
|---|---|---|---|
| `info` | `do_info` :1641 | `-i` | `-v` |
| `verify` | `do_verify` :1790 | `-i` | `-ip`, `--fix/-f` |
| `createraw` | `do_create_raw` :1888 | `-o`, `-i` | `-op -f -isb -ish -ib -ih -hs -us -c -np` |
| `createhd` | `do_create_hd` :1968 | `-o` | `-op -f -i -isb -ish -ib -ih -hs -c -tp -id -chs -s -ss -np` |
| `createcd` | `do_create_cd` :2172 | `-o`, `-i` | `-op -f -hs -c -np` |
| `createdvd` | `do_create_dvd` :2261 | `-o`, `-i` | `-op -f -isb -ish -ib -ih -hs -c -np` |
| `createld` | `do_create_ld` :2329 | `-o`, `-i` | `-op -f -isf -if -hs -c -np` |
| `extractraw` | `do_extract_raw` :2584 | `-o`, `-i` | `-f -ip -isb -ish -ib -ih` |
| `extracthd` | `do_extract_raw` (same handler) | `-o`, `-i` | same as `extractraw` |
| `extractdvd` | `do_extract_raw` (same handler) | `-o`, `-i` | same as `extractraw` |
| `extractcd` | `do_extract_cd` :2660 | `-o`, `-i` | `-ob -sb -f -ip` |
| `extractld` | `do_extract_ld` :3017 | `-o`, `-i` | `-f -ip -isf -if` |
| `copy` | `do_copy` :2477 | `-o`, `-i` | `-op -f -ip -isb -ish -ib -ih -hs -c -np` |
| `addmeta` | `do_add_metadata` :3170 | `-i`, `-t` | `-ix -vt -vf -nocs` |
| `delmeta` | `do_del_metadata` :3249 | `-i`, `-t` | `-ix` |
| `dumpmeta` | `do_dump_metadata` :3289 | `-i`, `-t` | `-o -f -ix` |
| `listtemplates` | `do_list_templates` :3371 | – | – |
| `help [command]` | `main` :3399 | – | – |

- **No new commands at HEAD.** The 2026 additions `--removepregap/-rp` (createcd) and `--addpregap/-ap` (extractcd), from #15808 on 2026-07-31, were removed again ten days later by #15870 (2026-08-10), which moved the logic into `cdrom.cpp`.
- **`extractraw`, `extracthd` and `extractdvd` are the same function** with no media-type check. `extractdvd` on a CD CHD happily dumps raw 2448-byte frames.
- **`copy` is missing from the official docs** (`docs/source/tools/chdman.rst`), even though it is the only "re-encode/upgrade" path.

### 1.2 Options (`s_options`, `chdman.cpp:674-705`)

| Long / short | Arg | Semantics and validation (code) | Notes and gotchas |
|---|---|---|---|
| `--input/-i` | file | Opened read-only. For createcd it goes to `cdrom_file::parse_toc` (cue/toc/nrg/gdi/iso); for createld to `avi_file::open`; for create* to `core_file`; for others to `chd_file::open`. | – |
| `--inputparent/-ip` | chd | Opened first (`parse_input_parent_chd` :1166); passed as parent. | No automatic parent lookup by SHA-1: without `-ip`, delta CHDs fail with "Requires parent". |
| `--output/-o` | file | `check_existing_output_file` (:1288) opens the file for **read** to test existence, unless `--force`. | No same-path check against the inputs (see §5). |
| `--outputbin/-ob` | file | extractcd only; extension split off; `"` rejected (:2733). | Default is `<output base>.bin`. |
| `--splitbin/-sb` | – | One bin per track; filename needs `%t` (regex :2769); forced for `.gdi` and for GD-ROM `.cue`. | `%02t` is used for ≥10 tracks or GDI. |
| `--force/-f` | – | Skips the existence check. | Output opened with `OPEN_FLAG_CREATE` (truncates). Short name `f` is shared with `--fix`; no command accepts both. |
| `--outputparent/-op` | chd | Creates a delta CHD. Hunk and unit size must match the parent; the parent's SHA-1 goes into the header. | createhd and createraw take unit/sector size and geometry from the parent. |
| `--inputstartbyte/-isb`, `--inputstarthunk/-ish`, `--inputstartframe/-isf` | num | Mutually exclusive (:1205-1279). "start ≥ size" and "start+length > size" are errors. | Hunks are counted in the *output* hunk size for create*, the *input* hunk size for copy/extract, and in frames for LD. |
| `--inputbytes/-ib`, `--inputhunks/-ih`, `--inputframes/-if` | num | Mutually exclusive; length from start. | createraw/createdvd then require the length to be a multiple of the unit (2048 for DVD). |
| `--hunksize/-hs` | num | 16 ≤ hs ≤ 1 MiB (`HUNK_SIZE_MIN/MAX` :63-64); must be a multiple of the unit; must equal the parent's if `-op` (`parse_hunk_size` :1333). | chd.h:157 comments "512k maximum" for V5 but the CLI allows 1 MiB. For copy it must be a multiple or factor of the input hunk (:2494). |
| `--unitsize/-us` | num | createraw only; required unless `-op`; must match the parent. | **`-us 0` → SIGFPE** at :1912 (`4096 / unit_size`), verified: exit 136. |
| `--compression/-c` | `none` or up to 4 tags | `parse_compression` :1367. See the rules below this table. | 4-char, case-sensitive tags. `none,x` and `x,none` are invalid. |
| `--ident/-id` | file | createhd: ATA IDENTIFY; CHS read from words 1/3/6 (bytes 2/6/12); ignored if C·H·S ≥ 16,514,064; stored as `IDNT` metadata. | Fewer than 14 bytes is an error. |
| `--chs/-chs` | `c,h,s` | `sscanf("%u,%u,%u")`; not allowed with a template or parent. | No check against the input size: a larger geometry means stale padding (see §2.12). |
| `--sectorsize/-ss` | num | Default 512 (or the parent's unit size); not allowed with `-tp`. | **`-ss 0` → SIGFPE** (:2022), verified. |
| `--size/-s` | num | createhd only, **without** an input: blank-disk size; `sscanf("%llu")` with no k/m/g suffix. | Blank disks must be `-c none` (:2053). |
| `--template/-tp` | id | 0–16 index into `s_hd_templates` (:920-939). | Conflicts with `-chs`, `-ss` and `-op`. |
| `--tag/-t` | 4 chars | Padded with spaces (`append("    ")`), first 4 chars used. | – |
| `--index/-ix` | num | `atoi`. | – |
| `--valuetext/-vt`, `--valuefile/-vf` | text/file | Exactly one of the two; one layer of surrounding quotes stripped. | Text metadata is written **with a trailing NUL** (`chd.h:357`: `input.length() + 1`). |
| `--nochecksum/-nocs` | – | Clears `CHD_MDFLAGS_CHECKSUM`, so the item is excluded from the overall SHA-1. | – |
| `--numprocessors/-np` | num | `atoi`; ≤0 is ignored (auto); sets the global `osd_num_processors` (:1411-1423). | Real worker count is `min(np, 4×hw) − 1`, capped at 16 (see §2.3). |
| `--fix/-f` | – | verify: rewrites the raw SHA-1 (and the overall one via the metadata hash). | Needs write access; since #14019 (2025) the file is opened read/write. |
| `--verbose/-v` | – | info only: full metadata text and per-codec hunk statistics. | – |

`-c` rules in detail (`parse_compression` :1367):

- The exact string `none` sets all four slots to 0.
- Otherwise each name must be a known 4-char tag (`codec_exists`).
- More than 4 names are **silently truncated**.
- Duplicates are allowed. `-c zlib,zlib,zlib,zlib` compresses every hunk four times, verified.
- A TODO at :1369 asks whether the default should follow the output parent's codecs.

**Parser rules** (`main`, :3399-3519):

- Each argument must start with `-`; bare parameters are an error.
- A long option is `--name`, a short one `-shortname`, and only the options valid for the command are matched.
- An option **value that starts with `-` is rejected** ("Option is missing parameter"), so negative numbers and file names beginning with `-` are impossible.
- Duplicate options are an error.
- `parse_number` (:1089) accepts decimal digits plus an optional `k/m/g` suffix (×1024ⁿ). It has **no overflow check** and **ignores trailing junk**: `-isb 1x` = 1, `-hs abc` = 0.
- Values are leaked `new std::string`s (harmless).

### 1.3 Defaults per command

| Command | Default codecs (slot 0..3) | Default hunk size | Unit size | Logical size |
|---|---|---|---|---|
| createraw | `lzma,zlib,huff,flac` | parent's, else `max(⌊4096/us⌋·us, us)` | `-us` (required) or parent's | input range |
| createhd (with input) | `lzma,zlib,huff,flac` | parent's, else `max(⌊4096/ss⌋·ss, ss)` = **4096** | sector size (512) | **C·H·S·ss** (not the input size!) |
| createhd (blank) | `none` (compression forbidden) | same | same | `-s` or CHS |
| createcd | `cdlz,cdzl,cdfl` (slot 3 empty) | parent's, else **8 frames = 19,584** | **2448** (2352 + 96 subcode) | Σ tracks padded to multiples of 4 frames × 2448 |
| createdvd | `lzma,zlib,huff,flac` (":2282 No reason to be different than HD") | parent's, else **4096** (2 sectors) | 2048 | input range (must be a multiple of 2048) |
| createld | `avhu` (`none` rejected) | `bytes_per_frame` (1 frame per hunk) | `bytes_per_frame` | frames × hunk |
| copy | by metadata (`get_compression_defaults` :2444): HD/DVD → `lzma,zlib,huff,flac`; AV → `avhu`; CD/GD → `cdlz,cdzl,cdfl`; else raw default | input's hunk size (or parent's) | **input's unit size** | input range |

`s_default_*` are defined at `chdman.cpp:666-670`.

`createld -hs ≠ frame` passes `parse_hunk_size`, but `extractld` requires `frame_bytes == hunk_bytes` (:3055-3056 area) and avhuff encodes one frame per hunk. The option is effectively unusable. This is from static reading; I had no AVI fixture.

### 1.4 Output channels, progress and exit codes

- **stdout:**
  - the banner `chdman - MAME Compressed Hunks of Data (CHD) manager <version>`, **always printed first** (:3406);
  - the parameter summary;
  - `info` output;
  - `dumpmeta` data when no `-o` is given, so **the dumped blob is preceded by the banner**. Verified with `od -c`.
- **stderr:** progress lines and errors.
  - Progress uses `\r` without a newline: `Compressing, 12.5% complete... (ratio=38.1%)`, `Examining parent, …`, `Verifying, …`, `Extracting, …`.
  - Progress is throttled in `progress()` (:969-980) to one print per 0.5 s of **`clock()`**, which is process CPU time summed over all threads. With N busy threads it prints roughly every 0.5/N s of wall time, and a stalled process prints nothing. Each call is a `clock_gettime(CLOCK_PROCESS_CPUTIME_ID)` syscall (not vDSO).
  - Compression progress is `m_write_hunk / m_hunkcount`.
  - "ratio" is the compressed payload divided by input bytes, excluding the header, map and metadata. `info`'s "Ratio" is file size ÷ logical size, so the two differ (46.1 % vs 47.9 % for `twine`).
- **Discpress scrapes this text.** `app/ui.js:1521-1522` parses the progress lines with a regex. There is no machine-readable progress channel.

Exit codes (all verified unless noted):

| Situation | Exit |
|---|---|
| Success | 0 |
| `verify`: raw or overall **SHA-1 mismatch** (prints `Error: Raw SHA1 in header = …` to stderr, no `report_error`) :1842-1878 | **0** |
| `verify` on an uncompressed CHD, or on a CHD with a null raw SHA-1 (e.g. an **interrupted `create*`**): `report_error(0, …)` → "Fatal error occurred: 0" | **0** |
| `help`, no arguments, unknown command, bad option (`print_help` returns 1) | 1 |
| `report_error(1, …)` (`fatal_error`), `std::error_condition` escaping ("CHD error occurred (main)"), `std::exception` ("Unhandled exception") | 1 |
| Decompression error during verify/extract (hunk CRC-16 mismatch) | 1 |
| `extractcd`/`copy` of a non-CD CHD: the `cdrom_file` constructor does `throw nullptr` (`cdrom.cpp:253-261`), which main does not catch → `std::terminate` | **134 (SIGABRT)** |
| `createraw -us 0`, `createhd -ss 0` | **136 (SIGFPE)** |
| Killed by signal (SIGTERM, or Ctrl-C in a terminal): partial file left behind, no cleanup | 128+n |

Error-output style: `report_error` prints the message and then `Fatal error occurred: N` (:952-961, :3504-3507). Messages carry no error codes, and none name the hunk or offset except in extractld.

### 1.5 Documentation drift (`docs/source/tools/chdman.rst` at HEAD)

- `--hunksize` is marked "(required)" for createhd/cd/dvd/ld; in code it is optional.
- `extractld` is described as "Extract data from a CHD format DVD-ROM image" (copy-paste slip).
- `copy` is undocumented.
- The docs do not say that:
  - `extractcd`'s output format is chosen by extension (`.cue` → CUE/BIN, `.gdi` → GDI, anything else → cdrdao TOC);
  - `addmeta` and `delmeta` only work on uncompressed CHDs;
  - `-np` is capped at 16 workers and gives N−1 workers.
- MAME's golden regression tests (`regtests/chdman/chdtest.py` plus 31 input/output pairs) were last touched in 2015 (`583a1f81f2`). Run against today's chdman, **20 of 31 fail the output-file SHA-1 comparison**: every CD case, from metadata changes such as `PGSUB`, and every LZMA/FLAC HD case. The 11 that pass are the HD cases with huff/zlib/none, `createhd_1..5`, `copy_hd_1` and the two `createld` cases. Upstream does not maintain byte stability across versions.

---

## 2. The compression pipeline, step by step

### 2.1 Object model

- `chd_file` handles the container: header, metadata, map, `read_hunk` and `write_hunk`.
- `chd_file_compressor : chd_file` adds the create pipeline. Its only extension point is the pure virtual `read_data(dest, offset, length)` (`chd.h:465`). chdman subclasses it five times:

| Subclass (chdman.cpp) | Used by | `read_data` behaviour |
|---|---|---|
| `chd_zero_compressor` :279 | createhd blank (not actually compressed; `compress_common` is skipped) | memset 0 up to max |
| `chd_rawfile_compressor` :310 | createraw, createhd, createdvd | `seek` + `util::read`. **Errors ignored** (`// FIXME: check for error return` :336); returns 0 past `m_maxoffset`; no zero-fill. |
| `chd_chdfile_compressor` :350 | copy | `input.read_bytes` (serial decompression); `throw err` on error; optional CDDA byte-swap when upgrading old `CHGT` GD-ROM CHDs (:376-406) |
| `chd_cd_compressor` :423 | createcd | memsets the requested length, walks the TOC, opens each track file lazily, reads **one frame per `read()` call** (a `pread` of 2352 or 2448 bytes, because `core_osd_file` only buffers reads under 256 bytes: `corefile.cpp:611-660`), zero-fills pad frames, byte-swaps if `swap`, and handles GD-ROM split-bin |
| `chd_avi_compressor` :552 | createld | decodes AVI frames, assembles the avhuff raw frame, collects VBI data into `m_ldframedata` (written as `AVLD` metadata after compression) |

### 2.2 Set-up (chdman side, e.g. `do_create_cd`)

1. Parse options, then the TOC.
2. `create_output_chd` (:1480) → `chd_file::create(filename, …)` (`chd.cpp:773`) opens the file with `READ|WRITE|CREATE` (truncating) → `create_common` (`chd.cpp:2574`).
3. `create_common` validates sizes and codec order: once an empty slot appears, all later slots must be empty.
4. It writes the 124-byte V5 header with map offset 0 (compressed) and null raw, overall and parent SHA-1s, then parses the header back.
5. For uncompressed CHDs it also writes a zeroed 4-byte-per-hunk map right after the header.
6. `create_open_common` then:
   - builds decompressors;
   - sizes `m_rawmap = hunkcount × 12` (compressed; filled with 0xff because `m_mapoffset == 0`: `chd.cpp:2440-2444`);
   - sizes `m_compressed` and `m_cache` to one hunk.
7. chdman writes metadata **before** compression (CD: `CHT2`/`CHGD` [+`CHSE`]; DVD: `DVD `; HD: `GDDD` [+`IDNT`]; LD: `AVAV`).
   - Each `write_metadata` appends a 16-byte header and the data with `file_append`, relinks the list, and recomputes the overall SHA-1 through `metadata_update_hash` (O(n) per item).
   - So metadata sits right after the header in chdman-made CHDs. createld's `AVLD` is written **after** the map.

### 2.3 Threads and queues (`src/osd/osdsync.cpp`)

- The `chd_file_compressor` constructor (`chd.cpp:3067-3083`) allocates two queues **at construction time**:
  - `m_read_queue = osd_work_queue_alloc(WORK_QUEUE_FLAG_IO)`;
  - `m_work_queue = osd_work_queue_alloc(WORK_QUEUE_FLAG_MULTI)`.

  chdman calls `parse_numprocessors` before constructing it.
- **Thread counts** (`osdsync.cpp:249-320`, `640-664`):
  - `numprocs = osd_num_processors > 0 ? min(4·hw, np) : (OSDPROCESSORS env ? min(4·hw, env) : hw)`, where `hw = std::thread::hardware_concurrency()` (heavy_mt, not capped at 4: :96).
  - MULTI queue: `numprocs − 1` threads (0 on 1 CPU). IO queue: 1 thread.
  - `OSDWORKQUEUEMAXTHREADS` env lowers the count.
  - Clamped to **`WORK_MAX_THREADS = 16`** (`osdcore.h:140`, `osdsync.cpp:284`).
  - Emscripten: 0 threads for both queues (:91, :279), so items run inline in the queuing thread.
- **Consequences:**
  - `-np N` gives N−1 compression workers plus 1 reader.
  - `-np 1` (or 1 CPU) gives **no** compression thread: compression runs inside the reader thread, serial with reading and SHA-1.
  - At most 16 compressors whatever the core count. `m_codecs[WORK_MAX_THREADS]` (`chd.h:578`) holds 16 codec groups, each allocated in `compress_begin` regardless of how many threads exist.
- Each queued item costs a mutex lock (the free list and the list append), plus a dequeue lock and a `queue_has_list_items` lock per worker loop. That is negligible at ≥4 KiB hunks with slow codecs, but measurable with `huff` or tiny hunks.

### 2.4 Ring buffer and read scheduling

`compress_begin` (`chd.cpp:3112-3151`):

- `m_work_buffer = hunk × (256+1)`, zeroed once. The extra hunk is for parent walking.
- `m_compressed_buffer = hunk × 256`.
- 256 `work_item`s, each with `m_data`/`m_compressed` pointers and `m_hash` sized to units-per-hunk.
- 16 `chd_compressor_group`s.

`compress_continue` (`chd.cpp:3166-3304`) is the single-threaded **writer/driver**, called in a loop by chdman's `compress_common` (:1503-1523):

1. Return `m_read_error` if the reader failed.
2. **Queue reads** while `logical not all queued` and fewer than 2 read items are pending (:3173):
   - a read is queued only if the next **128 work items (half the ring)** are all `WS_READY` (plus one more when walking the parent);
   - mark them `WS_READING`;
   - enqueue `async_read` (auto-release) on the IO queue;
   - advance by 128 hunks.
3. **Flush completed items strictly in hunk order** (`m_write_hunk`, :3199-3287). See §2.6.
4. Update progress (hunks written ÷ total) and ratio.
5. If the next item is queued or reading **and has an `m_osd` handle**, wait on it for up to 1 s (:3298-3301). Otherwise return immediately with `COMPRESSING` or `WALKING_PARENT`. There is a comment "sometimes code can get here with .m_status == WS_READY and .m_osd != nullptr, TODO find out why this happens".

`async_read` (IO thread, `chd.cpp:3423-3498`):

- `numbytes = 128 hunks`, or the remainder up to `logical_bytes`; `dest` is one of the two ring halves.
- In the normal path it calls `read_data(dest, offset, numbytes)` and **ignores its return value** (:3463).
- Then, for each hunk in the range, it sets the item to `WS_QUEUED` and `osd_work_item_queue(m_work_queue, async_compress_hunk)`. With zero workers, this **executes the compression inline**.
- It appends the range to the running raw SHA-1: `m_compsha1.append(dest, numbytes)`, **logical bytes only** (:3481).
- It adds to `m_total_in` and advances `m_read_done_offset`.
- `std::error_condition` and `std::exception` are caught and stored in `m_read_error` (a generic `io_error` for non-CHD exceptions). The message goes to stderr with `fprintf`.

**Pipeline depth** is 256 hunks: about 4.8 MiB for CD and 1 MiB for DVD/HD. Refill granularity is a whole half (128 hunks), so one slow hunk at the head holds back refilling (head-of-line blocking).

### 2.5 Per-hunk work (`async_compress_hunk`, `chd.cpp:3377-3396`, worker threads)

1. `item.m_codecs = m_codecs[threadid]`: one codec group per worker id.
2. **Hashes:** `crc16 = CRC-16/CCITT-FALSE` over the whole hunk (poly 0x1021, init 0xFFFF; byte-at-a-time table, `hashing.cpp:397-450`), and `sha1` over the whole hunk (portable C: `hashing.cpp:80-220`). The whole hunk *includes the stale tail of a final partial hunk* (§2.12).
3. **Dedupe pre-check:** if the (crc16, sha1) pair is found in `m_current_map` (hunks written so far) or `m_parent_map`, **skip compression**. `// TODO: data race` (:3389): `hashmap::add` on the writer thread publishes entries without barriers while workers read them.
4. Otherwise run `find_best_compressor` (`chdcodec.cpp:739-792`):
   - start with `complen = hunkbytes`, `compression = -1`;
   - for slots 0..3 in order: `compbytes = codec->compress(src, hunkbytes, test)`, all exceptions swallowed, **including `std::bad_alloc`**;
   - if `compbytes < complen` (**strictly smaller; ties go to the earlier slot**), take it and memcpy into the item's compressed buffer;
   - if nothing beats `hunkbytes`, copy the raw hunk; `-1` becomes `COMPRESSION_NONE` in the map.
   - Every codec compresses the entire hunk: there is no early exit and no size estimate.
5. `m_status = WS_COMPLETE`. `m_status` is a `std::atomic<int32_t>` with seq_cst store/load, which gives the writer a proper happens-before on the other item fields.

### 2.6 Writer decisions (`compress_continue` flush loop, `chd.cpp:3199-3287`)

For each `WS_COMPLETE` item, in order:

- **Parent walk:** add each unit-window hash to `m_parent_map` (§2.7).
- **Uncompressed CHD:** `write_hunk` (all-zero hunks are not stored; the map entry stays 0). Hash-based dedupe is not used.
- **Self-match:** `hunk_copy_from_self(hunknum, selfhunk)`. Map type `COMPRESSION_SELF`, offset = referenced hunk (only earlier hunks allowed, :2893), length 0, crc 0.
- Else, **parent match:** `hunk_copy_from_parent(hunknum, parentunit)`. Map type `COMPRESSION_PARENT`, offset = **unit** index in the parent.
- Else, `hunk_write_compressed` (`chd.cpp:2853-2869`):
  - `verify_proper_compression_append` (the hunk must be the next unwritten one);
  - `file_append` = `seek(END)` using the cached size (no syscall), then `tell`, then `util::write` (one `pwrite` per hunk; short writes are retried inside `util::write`);
  - the map entry gets type (0-3 or NONE), 24-bit length, 48-bit offset and CRC-16 **of the uncompressed hunk**;
  - `m_current_map.add(hunknum, crc16, sha1)`.
- Only hunks that were actually *stored* enter the self map. Parent-copied hunks do not, so the next identical hunk becomes a parent copy too.

**Write ordering:** data goes out strictly sequentially in hunk order. The header, metadata-link and map-offset fields are patched in place.

### 2.7 Parent (delta) walking (`-op`)

- `compress_begin` sets `m_walking_parent = bool(m_parent)`.
- The first full pass reads **parent** hunks (`m_parent->read_hunk`, i.e. **serial decompression on the IO thread**, :3444-3459). It reads one extra hunk past each half, ignoring `HUNK_OUT_OF_RANGE`: the FIXME at :3453 and the #13029 hack `65c263749e`.
- Workers run `async_walk_parent` (:3334-3346). For **every unit offset** within the hunk, they compute CRC-16 and SHA-1 over a **hunk-sized window starting at that unit**. This is why the ring has 257 slots.
  - This is `units_per_hunk` × the hashing work: 8 windows per hunk for CD, 2 for DVD, 8 for HD with 512-byte sectors, and 4096 for `createraw -us 1`.
  - Only unit 0 is hashed for the last hunk or for uncompressed output.
- The writer adds `unit → (crc, sha)` entries if they are not already present, with 64-bit unit indices since #15893.
- The loop bound is the **child's** hunk count, not the parent's. If the parent is shorter, windows over stale buffer contents get unit indices past the parent's end (FIXME territory).
- Then the state resets and the normal pass runs. A child hunk matches a parent window if it equals *any* unit-aligned window, so inserted or removed sectors still dedupe.
- **Demonstration:**
  - a 48 MiB DVD parent (20.7 MB CHD);
  - a child with one inserted sector in the middle plus one modified sector;
  - result: a **3,458-byte** child with 12,286 of 12,288 hunks as "Copy from parent". `verify -ip` passes and extraction round-trips.
  - The walk cost 0.69 s on the IO thread for 48 MB (serial parent decompression).
- The Discpress patch does **not** parallelise the walk (`!m_walking_parent`, `mame.patch:50`), so the browser walks parents single-threaded.

### 2.8 The hash map (`chd.h:469-506`, `chd.cpp:3514-3602`)

- 65,536 bucket heads indexed by **CRC-16**, with chains of entries `{next*, itemnum (u64), sha1[20]}` (40 bytes, allocated in blocks of 16,384 = 640 KB).
- `find` walks the bucket and compares the **full SHA-1** only. The CRC-16 is implied by the bucket, so the key is effectively (crc16, sha1).
- **Collision handling:** a (crc16, sha1) collision would silently dedupe different data. That is astronomically unlikely, but there is no byte-compare.
- `add` does not check for duplicates. The writer only adds after `find` fails; the parent walk also checks first.
- **Cost:** average chain length is n/65,536.
  - 1.15 M unique hunks (a 4.7 GB DVD) gives about 17 SHA-1 compares per lookup.
  - 25 M unique hunks (a 100 GB HD at 4 KiB) gives about 380 compares per lookup, done serially on the writer, plus about 1 GB of entries.

### 2.9 Finalisation

When `m_write_hunk == m_hunkcount` (:3264-3286):

1. `osd_work_queue_wait(m_read_queue, 30 s)`.
2. `set_raw_sha1(m_compsha1.finish())` (`chd.cpp:531`):
   - writes the raw SHA-1 at header offset 64;
   - `metadata_update_hash` then recomputes the **overall SHA-1** = SHA-1(raw_sha1 ‖ sorted list of {BE tag, SHA-1(data)} for metadata with `CHD_MDFLAGS_CHECKSUM`) (`compute_overall_sha1` :1839-1887) and writes it at offset 84.
3. `compress_v5_map` (`chd.cpp:2212-2424`):
   - CRC-16 over the raw 12-byte-per-hunk map;
   - RLE of the per-hunk compression types with SELF_0/SELF_1/PARENT_SELF/PARENT_0/PARENT_1 promotions;
   - `huffman_encoder<16,8>` tree plus codes, then a bit-packed stream per entry (length+crc for codecs, crc for NONE, self/parent offsets);
   - a 16-byte map header (length, first data offset, CRC, bit widths);
   - `file_append` of the map;
   - `file_write` of the map offset at header offset 40.

   Detailed format belongs to lane A.
4. For uncompressed CHDs neither SHA-1 is ever computed. `verify` then refuses the file with exit 0.

**On-disk order** for a chdman-created compressed CHD: header, metadata, hunk payloads in order, map (, AVLD for LD). No fsync, no temp file.

### 2.10 Memory model (native)

| Item | Size |
|---|---|
| Ring + compressed buffers | 513 × hunk (≈10 MB for CD, ≈2 MB for DVD) |
| Codec groups | 16 groups × (codec states + 1 hunk test buffer). zlib level 9 and zstd contexts per group; LZMA state **allocated per hunk** via a caching allocator (`LzmaEnc_Create`/`Destroy` in every `compress`: `chdcodec.cpp:1277-1305`) |
| `m_rawmap` | 12 B × hunks |
| Self map | 40 B × unique hunks, plus a 512 KB bucket array |
| Parent map | 40 B × parent hunks × units-per-hunk (e.g. a 100 GB HD parent: 200 M × 40 B ≈ **8 GB**) |
| `compress_v5_map` temporaries | ~1 B/hunk RLE plus ~6 B/hunk bitstream |

Measured max RSS was 20–27 MB for the 346 MB CD. Hunk-count-proportional structures dominate for HD-sized images: about 52 B/hunk, which is about 1.3 GB for a 100 GiB HD.

### 2.11 Codec parameters (what the trial actually runs)

| Tag | Implementation (chdcodec.cpp) | Parameters |
|---|---|---|
| `zlib` | raw deflate `deflateInit2(9, -15, memLevel 8)`, `deflateReset` per hunk :905-956 | Output ≥ input is treated as a failure |
| `zstd` | `ZSTD_initCStream(ZSTD_maxCLevel())` = **level 22 every hunk** :1061-1088 | Parameters are adapted to the hunk size because `ZSTD_e_end` on the first call pledges srcSize |
| `lzma` | `LzmaEnc_Create`/`MemEncode`/`Destroy` per hunk :1270-1318 | **level 6** (8 until `c23567b509`), `reduceSize = hunkbytes` → dictionary = hunk size, lc3/lp0/pb2, bt4, fb32, mc32, single-threaded (`Z7_ST`). The decoder rebuilds its properties from the same function (FIXME :1336) |
| `huff` | `huffman_8bit_encoder` per hunk :1420-1426 | static 8-bit Huffman |
| `flac` | MAME `flac_encoder` (libFLAC level 8, `flac.cpp:79`), block = hunk/4 halved until ≤2048 | **Encodes BE, then LE, then BE again if BE won** :1483-1515 |
| `cdlz`, `cdzl`, `cdzs` | `chd_cd_compressor<Base, Sub>` :337-400: split each 2448-byte frame into 2352 data + 96 subcode; if the sync header matches and `ecc_verify` passes, clear sync and P/Q ECC and set a per-frame bit; base codec on the data, zlib (or zstd for cdzs) on the subcode; header = ECC bitmap + 2/3-byte length | cdlz = LZMA+zlib, cdzl = zlib+zlib, cdzs = zstd+zstd |
| `cdfl` | :1588-1662 | FLAC on 8×2352 bytes (block 2352 samples, always byte-swapped on LE hosts, no dual trial) + zlib on the subcode |
| `avhu` | avhuff; `postinit` reads `AVAV` metadata from the CHD | Only codec that depends on CHD state |

### 2.12 The "stale tail" quirk (verified)

`async_read` passes `numbytes` clamped to `logical_bytes` and ignores `read_data`'s short return. `chd_cd_compressor` only clears `length` bytes, and `chd_rawfile_compressor` clears nothing. So:

1. **Final partial hunk.** Bytes past the logical end in the last hunk are whatever the ring slot last held: hunk `last−256` if at least 256 hunks exist (else zeros from the initial memset; with `-op`, possibly data left from the parent walk). They are CRC-16'd, SHA-1'd (per-hunk dedupe), compressed and **stored in the file**. The stream SHA-1 excludes them, so data and overall SHA-1 are unaffected. Verified with `hunkdump`:
   - bench CD: logical size 362,822,976, last hunk uses 9,792 of 19,584 bytes, and the tail equals the same bytes of hunk 18,270;
   - DVD of 1,537 sectors: 2,048-byte tail equals hunk 512.

   Every CD CHD whose padded frame count is ≡4 (mod 8) and larger than 2,048 frames carries 4 frames (9,792 bytes) of old data.
2. **createhd with geometry larger than the input** (`-chs`, `-tp`, or `guess_chs` rounding up for awkward, e.g. prime, sector counts).
   - `read_data` returns 0 bytes past EOF and the ring keeps old data.
   - Verified: a 2 MiB random image with `-chs 32,16,16` (4 MiB logical) extracts as input + input[1..2 MiB) + input[1..2 MiB), not zeros.
   - The Data SHA-1 covers this garbage.
   - `#16043` (zero-fill plus error checks) addressed exactly this and was reverted (§5.6).

**Implication for any rewrite:** to be byte-identical with chdman you must reproduce the 256-slot ring semantics, and in particular which bytes sit in the tail of the last hunk.

---

## 3. Performance

### 3.1 Component costs (single thread, CPU time, harness linked against `obj-native`)

CD figures are measured on hunks decoded from the bench-CD CHD, so the layout and ECC state are exact; the DVD figure is on the raw ISO.

| Work item | Throughput | Notes |
|---|---|---|
| SHA-1 (MAME, portable C) | **146–170 MB/s** | OpenSSL with SHA-NI on the same host: 1,472 MB/s at 19,584-byte blocks (`openssl speed`) |
| CRC-16 (byte table) | **235–245 MB/s** | zlib crc32 in the same build: 1,640–1,840 MB/s |
| CD `ecc_verify` | 257–350 MB/s | table-driven P/Q; done by **each** CD frontend codec |

| Codec (compress / decompress, MB/s) | CD data hunks | CD audio hunks | DVD 4 KiB hunks (bench ISO) |
|---|---|---|---|
| `cdlz` / `lzma` | 14.2 / 32.6 | 11.9 / 16.5 | 12.7 / 62–66 |
| `cdzl` / `zlib` | 37.4 / 129 | 41.4 / 152 | 61–63 / 285–289 |
| `cdfl` / `flac` | 18.0 / 221 | 14.1 / 172 | 9.4–9.5 / 325–337 |
| `huff` | – | – | 130–133 / 133–145 |
| `cdzs` / `zstd` (level 22) | **3.5** / 229 | – | 11.9 / **1,320** |
| **Default trial** (`find_best_compressor`) | **6.37** (cdlz 76 %, cdzl 24 % wins; cdfl 0) | **5.81** (cdfl 100 %) | **4.73** (none 24 %, lzma 17 %, zlib 1 %, huff 30 %, flac 28 %) |

Per-MB CPU of the default trial:

- **CD data:** cdlz 70 + cdzl 27 + cdfl 56 ≈ **153 ms**. cdfl is 35 % of the cost and never won.
- **CD audio:** cdlz 84 + cdzl 24 + cdfl 71 ≈ **179 ms**. cdlz+cdzl are about 60–63 % of the cost and never won.
- **DVD:** lzma 79 + zlib 16 + huff 8 + flac 106 ≈ **209 ms**. FLAC is 50 % of the cost.
- Per-hunk hashing adds about 10.5 ms/MB on workers (≈5–7 %), plus about 6.5 ms/MB of stream SHA-1 on the reader.
- The trial is exactly additive: the measured group time equals the sum of the single-codec times ±3 %.

LZMA level 6 vs 8 (HEAD code, `harness` vs `harness-l8`):

- DVD: 14.9 vs 10.4 MB/s, ratio 44.40 % vs 44.40 %.
- CD: 16.2 vs 12.2 MB/s, 35.05 % vs 35.04 %.

The upstream level change bought about 1.35× LZMA speed at essentially no ratio cost, at the price of byte identity with ≤0.289.

### 3.2 Where wall time goes

| Thread | Work | Parallel? |
|---|---|---|
| Reader (IO queue, 1 thread) | `read_data` (CD: one pread per frame), whole-stream SHA-1; with `-np 1` also all compression; in `copy`, input decompression; with `-op`, parent decompression | **Serial** |
| Workers (N−1, ≤16) | CRC-16 + SHA-1 per hunk (or per unit window when walking) + full codec trial | yes |
| Main/writer | ordered flush, hash-map lookups/adds, one `pwrite` per stored hunk, map compression at the end, progress; **spins** when the head item has no `m_osd` | **Serial** |

Measured per-thread CPU (`threads.py`):

- **createdvd `-c huff`, 256 MB, 3 workers:** reader 1.49 s (≈SHA-1 of 256 MB); workers 1.2–1.4 s each; main 1.0 s. With a fast codec the reader's SHA-1 is already the largest single-thread cost.
- **Same with `-np 1`:** reader 5.5 s (everything); **main 5.6 s of pure spin** (2.15 user + 3.47 sys).
- **createdvd default, 32 MB:**
  - `-np 2`: worker 6.29 s, reader 0.19 s, main 0.11 s;
  - `-np 1`: reader 7.0 s plus **7.7 s of main-thread spin**.
- **strace, 8 MB `-np 1`:** 586,588 `clock_gettime` calls. `-np 4`: 421.

Serial ceilings on this host:

- **Reader:** about 150 MB/s (SHA-1 bound). A fork with SHA-NI SHA-1 raises it roughly tenfold.
- **Compression:** 16 workers × per-thread trial throughput, about 100 MB/s for CD and 75 MB/s for DVD at default codecs.

With default codecs you hit the 16-thread cap before the reader ceiling. With fast codecs (huff, zlib, low-level zstd) the SHA-1 reader is the bottleneck.

**`-np` semantics trap.** The project's bench (`tests/.cache/bench/2026-09-27T17-46-36-v1.0.0-baseline.md`, recorded earlier on the same machine type) shows native:

| Fixture | np1 | np2 | np4 |
|---|---|---|---|
| bench-cd | 62.9 s | 59.4 s | 20.7 s |
| bench-dvd | 216 s | 210 s | 71 s |

The flat np1→np2 step reflects the N−1 rule.

### 3.3 Redundant computation and copies (ranked by cost)

1. **Full multi-codec trial on every hunk:**
   - FLAC on CD data (35 % of CD-data CPU);
   - LZMA and zlib on CD audio (≈60–63 % of audio CPU);
   - FLAC on DVD/HD data (50 % of DVD CPU).

   chdman knows the track types from the TOC but ignores them.
2. **Generic `flac` double or triple encode** (BE then LE, re-encode BE if it won). Two output buffers would save about 20–33 % of FLAC time with identical bytes.
3. **Duplicate compression inside the 256-hunk window.** Workers only skip hunks that are already *written*. The wasm helper's `s_seen` shows an exact, cheap fix (§6).
4. **Hashing implementations:** SHA-1 about 10× slower than SHA-NI, CRC-16 about 7× slower than zlib's crc32. SHA-1 is computed twice over all data: once for the stream, once per hunk.
5. **CD frontend repeated per codec:** frame split, `ecc_verify` and ECC clear run once in cdlz and again in cdzl (≈3 ms/MB each), and the subcode zlib output (identical for cdlz and cdzl) is computed twice.
6. **LZMA encoder construction per hunk.** `LzmaEnc_Create`/`Destroy` plus props set every call; the caching allocator mitigates `malloc` but not initialisation.
7. **CD input read one frame per syscall** (≈148 k preads for 350 MB).
8. **Copies:** reader to ring (1); CD codecs copy each frame into their own split buffer (1 per CD codec); winning output memcpy'd to the item (≤4); written from the item. The wasm path adds six more (§6.4).
9. **Lock contention:** a mutex per work item enqueue/dequeue plus `queue_has_list_items`. Negligible at ≥4 KiB hunks; visible only with `huff` or tiny hunks.

### 3.4 End-to-end numbers (for orientation; my wall times are contended)

- **bench-cd** (346 MB, default): np1 83.4 s, np2 61.1 s, np3 41.6 s. np4 69.2 s was disturbed by other load; the project's clean np4 is 20.7 s. Output SHA-1 was **identical for np 1–4** (determinism).
- **verify, CD CHD:** 7.67 s CPU (**45 MB/s**, single thread).
- **extractcd:** 7.08 s CPU (**49 MB/s**). Bins round-trip bit-exactly.
- **Project bench extract:** native CD 40.5 MB/s, DVD 64.7 MB/s.
- **`copy` of a 48 MB DVD CHD:** 11.3 s CPU. The reader spends 0.82 s decompressing serially; output is byte-identical to the input CHD (also verified for a CD CHD).

### 3.5 wasm vs native (single thread, my Node runner; same output SHA-1 `a9b9f6e9…` in all three)

| Build | CPU for a 32 MB DVD slice | vs native |
|---|---|---|
| Native (`-np 2`, CPU total) | 6.59 s | 1× |
| wasm SIMD | 7.49 s | **1.14×** |
| wasm without SIMD | 9.60 s | 1.46× |

The project bench shows CD 1-thread wasm at 68.6 s (`…19-06-10-cmp.md`) vs native at 62.9 s (`…17-46-36-v1.0.0-baseline.md`), 1.09×, and 4 threads at 21.8 s (`…18-42-46-cd-profile.md`) vs 20.7 s.

---

## 4. Extract, verify, copy and info

- **Read path.** `read_bytes` (`chd.cpp:1407-1446`) goes to `read_hunk` (:1121-1266) for each hunk (with a single-hunk cache for partial reads).
  - V5 compressed: `file_read` the payload (from the 24-bit length and 48-bit offset), then `decompress` into the destination.
  - **CRC-16 check** of the decompressed hunk (or of the compressed bytes for "lossy" codecs; none exist, all `m_lossy=false`).
  - `SELF` recurses; `PARENT` reads the parent's bytes at `unit × unit_bytes`.
  - Everything is **synchronous and single-threaded**; there is no prefetch.
  - A self-reference cycle in a malformed file recurses until the stack overflows (lane A covers hardening).
- **extractraw / extracthd / extractdvd** (`do_extract_raw` :2584):
  - reads a 32 MiB buffer (`TEMP_BUFFER_SIZE` :70) with `read_bytes`, then `util::write`;
  - the output is deleted on error;
  - no media-type check.
- **extractcd** (:2660-3007):
  - builds a `cdrom_file` (`throw nullptr` on non-CD CHDs; the object is leaked);
  - chooses the mode by extension; formats bin names with `%t`;
  - reads **one frame at a time** through `cdrom_file::read_data(..., phys=true)` (`cdrom.cpp:373-470`), then `read_bytes` hitting the hunk cache. CD codecs regenerate the sync header and ECC (`ecc_generate`) for flagged frames;
  - byte-swaps audio for CUE (and for GDI when the CHD is ≥v5);
  - subcode is written only in TOC mode (warning otherwise).
  - #16044 (2026-09-14) added the missing error checks on `read_data`/`read_subcode`.
- **extractld** is the only user of `codec_configure` + `codec_process_hunk`, which decode straight into the caller's bitmap and audio buffers.
- **verify** (:1790-1880):
  - needs a compressed CHD with a non-null raw SHA-1;
  - reads everything through `read_bytes` (32 MiB buffer) and SHA-1s the logical bytes;
  - compares with the raw SHA-1 (v4+) or the SHA-1 (v3), then compares the overall SHA-1 (v4+).
  - `--fix` writes the recomputed raw SHA-1, and `set_raw_sha1` also rewrites the overall one. When the raw SHA-1 is correct but the overall one is wrong, `--fix` rewrites the raw SHA-1, which recomputes the overall SHA-1 from the metadata.
  - **Mismatch leaves exit 0; hunk CRC failure gives exit 1; no hunk or offset is reported.**
  - It cannot verify uncompressed CHDs (they have no SHA-1s at all).
- **copy** (:2477-2576):
  - the input is decompressed serially in the reader thread via `chd_chdfile_compressor`;
  - metadata is cloned in order, except old `CHCD`/`CHTR`/`CHGT` tags, which are rebuilt from a `cdrom_file` TOC (with a CDDA swap for old GD-ROM);
  - then normal compression. Default settings reproduce a current-chdman CHD **byte for byte** (verified for DVD and CD), so `copy` doubles as an "upgrade to current encoder/codecs" path.
  - Input and output may be the same path: **verified data loss** (§5.1).
- **info** (:1641-1783):
  - prints the header fields, SHA-1s, parent SHA-1 and metadata (60 printable characters unless `-v`);
  - with `-v`, prints the hunk count per class (`hunk_info`): Uncompressed / Copy from self / Copy from parent / Legacy mini / codec 0-3;
  - no per-codec *bytes* and no timing;
  - for v3/v4 maps, `hunk_info` leaves `codec`/`compbytes` **uninitialised** for type 6 (`2ND_COMPRESSED`) and type 0 (`chd.cpp:433-459`); do_info then reads the uninitialised value.
- **Parent workflow gaps:**
  - `-ip`/`-op` must be given explicitly; chdman never searches by SHA-1 (the library's `open_parent` callback is unused);
  - verify and extract of a child without `-ip` fail with "Requires parent".

---

## 5. Bugs and weak spots

### 5.1 Verified defects

| # | Defect | Evidence | Severity |
|---|---|---|---|
| 1 | `verify` exits 0 on raw/overall SHA-1 mismatch | flipped header byte → "Error: Raw SHA1…", exit 0 | High for scripts |
| 2 | Interrupted create leaves a header-only CHD (map offset 0, null SHA-1); `info` succeeds; `verify` says "No verification to be done; CHD has no checksum" with **exit 0** | SIGTERM after 4 s → 7.2 MB file | High |
| 3 | `copy -i x -o x -f` truncates the input, fails, then deletes it | file gone | High (data loss) |
| 4 | `createhd` geometry larger than the input → stale data instead of zero padding, baked into the Data SHA-1 | §2.12 | Medium (correctness) |
| 5 | Last partial hunk stores stale bytes (invisible) | §2.12 | Low for users; **critical for byte-identical reimplementations** |
| 6 | `extractcd`/`copy` of a non-CD CHD → `throw nullptr` → SIGABRT | exit 134 | Medium |
| 7 | `-us 0`, `-ss 0` → SIGFPE (division before the #15893 checks in `create_common`) | exit 136 | Low |
| 8 | `extractcd -o game.bin -f` writes the TOC over the bin (same path); without `-f` a misleading "file already exists" | verified | Medium |
| 9 | `dumpmeta` without `-o` prefixes the banner on stdout | `od -c` | Medium for binary metadata |
| 10 | `addmeta`/`delmeta` refuse compressed CHDs ("File not writeable"; v5 compressed ⇒ `m_allow_writes = false`, `chd.cpp:2183`) | verified | UX |
| 11 | Cue given by path: the cue directory is prepended to **absolute** `FILE` paths (`cdrom.cpp:2516/2521`); the error then blames the cue ("No such file or directory") | verified | UX (lane C) |
| 12 | `-np 1` / single-CPU: main-thread busy-wait | strace | Perf/energy |
| 13 | `-c` accepts duplicates, silently drops >4 | verified | Low |
| 14 | `parse_number` ignores junk and overflows | code | Low |

### 5.2 TODO/FIXME inventory (pipeline files, upstream lines)

| Location | Comment | What it means |
|---|---|---|
| `chd.cpp:177` | "TODO: revisit this error code (happens if file is truncated)" | Truncated files map to a generic `io_error` |
| `chd.cpp:797`, `:842` | "FIXME: allow osd_file to use std::string_view" | Cosmetic |
| `chd.cpp:3234` | "TODO: report error?" | `hunk_info` failure ignored in the uncompressed stats |
| `chd.cpp:3297` | "sometimes … WS_READY and .m_osd != nullptr, TODO find out why" | The state machine is not fully understood upstream |
| `chd.cpp:3389` | "TODO: data race" | Lock-free hashmap read while the writer adds entries without barriers; theoretical torn read on weakly ordered CPUs (ARM64) |
| `chd.cpp:3453` | "FIXME: … depend on trying to read past the end of the parent" | #13029 hack |
| `chd.cpp:3496` | "TODO: revisit this error code" | Non-CHD exceptions become `io_error` |
| `chd.h:536` | Atomic status note | – |
| `chdman.cpp:318` | "TODO: what to do about error getting file size?" | Unhandled |
| `chdman.cpp:334` | "FIXME: better error reporting?" | Unhandled |
| `chdman.cpp:336` | "FIXME: check for error return" | The raw-input error path; see #16043 |
| `chdman.cpp:1369` | "TODO: should we default to the same compression as the output parent?" | Open design question |
| `chdman.cpp:2486` | "TODO: should we check that the input range is aligned to the unit size?" | Open design question |
| `chdman.cpp:2494` | "TODO: is this check still necessary…" | Open design question |
| `chdcodec.cpp:1336` | LZMA props FIXME | Decoder properties are *derived* from encoder configuration, so SDK or level changes can break decoding or compatibility |
| `flac.cpp:200`, `:272`, `:575` | Unchecked I/O errors | Only affects the file-based FLAC path |
| `osdsync.cpp:593` | Spin-time measurement TODO | Instrumentation only |

### 5.3 Integer-overflow and range risks

- **`compress_v5_map` sizing** (`chd.cpp:2316`): `int nbits_needed = 128 + (12 + max(lengthbits+16, selfbits, parentbits)) × m_hunkcount`, computed in 32-bit arithmetic and stored in an `int`. I replicated the expression exactly (`$SP/bench-B/exp/nbits.cpp`):
  - with 4 KiB hunks (≈40–41 bits per entry) it goes **negative at about 204.8 GiB** logical, so `std::vector` throws `length_error`. That is not caught by the `bad_alloc` handler, so chdman ends with "Unhandled exception" *after* compressing everything, and the output is deleted;
  - at **about 410 GiB** it wraps to a *small positive* size. The bitstream then overflows silently (the `assert` is compiled out), producing a **corrupt map**.
  - I did not run chdman end-to-end at that size.
- `m_rawmap.resize(m_hunkcount * m_mapentrybytes)` (`chd.cpp:2780`) and `crc16(m_rawmap, m_hunkcount * 12)` (`:2217`, `:2553`) use 32-bit products. They overflow at 357.9 M hunks (1.36 TiB at 4 KiB, or 5.7 GB of input with `-hs 16`), causing heap corruption through `rawmap[hunknum*12]`.
- `m_hunkcount` is `uint32_t`, computed from 64-bit logical/hunk sizes (`chd.cpp:2174`) with no range check at create time.
- `do_create_hd`: `uint32_t totalsectors = c*h*s` (:2103) and `cylinders*heads*sectors >= 16'514'064` (:2078) are 32-bit.
- `read_bytes`: `uint32_t first_hunk = offset / m_hunkbytes`; fine while hunk counts fit.
- `hunk_info` V3/V4 leaves outputs uninitialised for unhandled types (`chd.cpp:433-459`).
- `chd_cd_compressor::read_data` indexes `m_info.track[tracknum+1]` for split-bin reads. The array has 99 entries (`cdrom.h:142`), so an out-of-bounds read is possible only with a 99-track GD-ROM split (practically unreachable).

### 5.4 Error-handling gaps and platform assumptions

**Input errors:**

- Raw-input read errors and short reads are **silently ignored**: `chdman.cpp:336`, and `async_read` ignores `read_data`'s return value.
- The CD reader errors out properly (`report_error` inside the reader thread becomes `fatal_error`, caught in `async_read` as `std::exception` → `io_error`). By code reading (not run), this works but also prints a generic "exception occurred: std::exception" line.

**Exceptions:**

- `find_best_compressor` swallows **every** exception, including `std::bad_alloc`. Under memory pressure a codec silently drops out, giving worse compression and *non-deterministic bytes*.
- `cdrom_file` uses `throw nullptr` as its error protocol.

**Durability:**

- No signal handling, no temp-file-plus-rename, no `fsync`, no resume (§8).

**Platform and ABI:**

- `LSB_FIRST` and `CRLF` are build-time assumptions.
- `clock()` semantics differ: process CPU time on POSIX, wall time on Windows.
- `osd_get_num_processors` returns 1 under Emscripten.
- `-fwasm-exceptions` is required.
- FLAC: MAME's official x86-64 build compiles libFLAC's SSE2/SSSE3/SSE4.1/SSE4.2 intrinsics (no `FLAC__USE_AVX`, so no AVX2/FMA paths) and runtime-dispatches, while Discpress builds with `FLAC__NO_ASM`. I tested:
  - the official intrinsics configuration;
  - FMA contraction (`-mfma -ffp-contract=fast`, 17 `vfmadd` in `lpc.o`), a proxy for ARM64 behaviour.

  All three builds produced **identical CHDs** for 33 MB of CD audio (`cdfl`) and 64 MB of DVD data with `-c flac`. This is good evidence but not proof. ARM64 NEON builds are untested.
- Distribution builds may link system zlib, flac or zstd (`with-system-*` options in `scripts/src/3rdparty.lua`), for example zlib-ng in compat mode. Their **bytes can differ** from bundled-library builds.

### 5.5 Recent upstream fixes and reverts (2025–2026) and what they tell us

| Commit / PR | Date | What | Lesson |
|---|---|---|---|
| `e5e82312c2` #15893 "fix several size and range handling issues" | 2026-08-15 | Byte-wise zero-hunk check in `write_hunk` (the old u32 loop skipped the last 1–3 bytes, i.e. **data loss** for odd hunk sizes in uncompressed CHDs); reject zero hunk/unit sizes on open and create; zero-length `read_bytes`/`write_bytes` are no-ops; 64-bit parent unit refs in the map and walk | Real latent bugs existed in rarely exercised paths; chdman's own `-us 0` still crashes *before* reaching these checks |
| `e0b94b77a5` #15902 "Handle short writes" → reverted `ebe430d9fd` #15936 | 08-17 / 08-21 | Added checks for short writes | `util::write` already loops until done or error; the check was redundant. The maintainer called it "AI-generated rubbish" |
| `33d4dc0aff` #16043 "Handle raw input read errors and padding" → reverted `c2f6ac79c1` | 09-14 / 09-15 | `read_at` + memset + throw on short read | Revert reasons: `read_at` penalty on some streams, the memset is "unnecessary since the caller gets the length" (**false in practice: `async_read` ignores it**), EOF is not an I/O error, the length-check semantics changed, and throwing needs an audit. **The underlying bugs (stale padding, ignored I/O errors) remain.** A fork must fix them in `async_read`, zero-filling there, and decide consciously about byte identity |
| `14d07e35c1` #16044 "Handle CD extraction read failures" | 09-14 | extractcd checks `read_data`/`read_subcode` | Before this, a failing sector wrote garbage silently |
| `8a00440d2d` #16045 "Handle metadata stdout write errors" | 09-14 | `fwrite`/`fflush` checks, and no longer dereferences `end()` when there is no `-o` | The old code had UB on error |
| `1736a9595b` #16077 + `cccb680a04` | 09-17/18 | avhuff channel limit (16) enforced; chdman's 8-channel array fixed | Malformed-input memory safety |
| `65c263749e` (#13029) | 2025-02-27 | Ignore `HUNK_OUT_OF_RANGE` when walking the parent | Delta CHDs with small hunks were broken in 0.271–0.273; still a hack |
| `02fc472f18` #14019 | 2025-08-03 | `verify --fix` opens the file read/write | – |
| `c23567b509` | **2026-08-04** | LZMA SDK 23.01 → 26.02 **and CHD LZMA level 8 → 6** | **Changes every LZMA hunk.** I built 0.289, HEAD, and HEAD with level 8: HEAD+level 8 equals 0.289 byte for byte, so the level alone explains the drift |
| `f9050e8508` | 2026-08-05 | zstd 1.5.5 → 1.5.7 | `-c zstd` output differs (+1,046 bytes per 8 MB in my test) |
| `1cf0f9e986` #15808 → `ac47a71ce1` #15870, `b93961fd52` #15886, `20661546b2` #15931, `c9e87a6b7e` #15910 | 07-31 … 09-22 | GD-ROM pregap handling (option added, then removed), session metadata (`CHSE`), CD+G | **GD-ROM CHDs from 76c7d19 differ from 0.289 in metadata and Data SHA-1** (verified with `aerowings.gdi`). Lane C owns the semantics |

Overall pattern:

- Upstream actively takes small robustness fixes but rejects redundant or low-quality ones, and does not treat CHD **file bytes** (or even GD-ROM data layout) as a stable contract between versions.
- The pinned "0.289" is really **0.289 + 1,167 commits**, including output-changing ones.
- zlib, huff and flac output are unchanged between 0.289 and HEAD (verified).

---

## 6. The Discpress wasm patch

### 6.1 What it changes (`wasm/mame.patch`, 130 lines)

1. `chd.cpp`:
   - declares `wasm_par_enabled`/`wasm_par_submit` imports and a global `s_wasm_par`;
   - `compress_begin` sets `s_wasm_par = compressed() ? wasm_par_enabled(hunk, unit, m_compression) : 0` (patch lines 22-30).
2. `async_read`: when `s_wasm_par && !m_walking_parent && compressed()`, instead of queueing `async_compress_hunk` it sets `m_osd = nullptr` and `m_codecs = m_codecs[0]`, then calls `wasm_par_submit(&item, item.m_data, hunk_bytes())` (patch lines 45-59).
3. `compress_continue` flush: if `item.m_compression == -2` ("helper skipped as probable duplicate") and the self map misses, compress it locally with `find_best_compressor` (patch lines 33-44).
4. A new static `chd_file_compressor::wasm_par_complete_item` plus the exported `wasm_par_complete` fill `crc16`, `sha1`, compression, length and data, then set `WS_COMPLETE` (patch lines 61-83, `chd.h` lines 84-99).
5. `chdman.cpp` `compress_common`: calls `wasm_par_yield()` after each `compress_continue` (patch lines 100-130).

Everything is under `#ifdef __EMSCRIPTEN__`, so the native build is untouched.

### 6.2 Data flow

**Job worker** (one wasm instance; osd queues have 0 threads, so `async_read` runs inline):

1. `read_data` (BlobStore `FileReaderSync`, or the staged stream) fills a ring half, then the stream SHA-1 runs.
2. Each hunk is **copied** into a JS batch buffer (`parSubmit`, `app/worker.js:648-654`).
3. At `wasm_par_yield`, `Asyncify.handleSleep` runs and `parYield` (`worker.js:655-666`) dispatches batches: up to two in flight per helper, transferred (`worker.js:583-596`), with `batchSize = max(1, min(64, 512 KiB/hunk, 128/(2·helpers)))` (:641).
4. The job then sleeps until the FIFO head hunk is done, and wakes via a `MessageChannel` post (:575-577, :600-606).

**Helper** (a second wasm instance per worker, `wasm/wasm_helper.cpp:25-80`):

1. `wasm_helper_init` creates an **in-memory `chd_file`** (`vector_read_write_adapter`, logical = one hunk, same hunk size, unit size and codec list) and a `chd_compressor_group` on it.
2. For each hunk:
   - CRC-16 and SHA-1 of the full hunk;
   - a 64-bit `s_seen` key (first 8 SHA-1 bytes ⊕ crc16<<48; cleared at 262,144 entries); a repeat returns −2 without compressing;
   - otherwise `find_best_compressor` runs.
3. Results are sliced out, concatenated and transferred back.

**Back in the job:** for each result, the SHA-1 and payload are copied into a scratch area in the heap, then `_wasm_par_complete` is called (a memcpy into `item.m_compressed`, `worker.js:608-630`). The unmodified writer loop then makes all self/parent/store decisions in hunk order.

The avhu codec is excluded because its `postinit` reads the CHD's `AVAV` metadata (`worker.js:636`).

### 6.3 Why the bytes are identical, and the assumptions

1. **Codec purity.** Each `compress()` output is a function only of (codec tag, `hunk_bytes`, input bytes):
   - zlib and CD-FLAC's deflater are reset per hunk;
   - LZMA is created per hunk;
   - zstd is re-initialised per hunk;
   - FLAC is reset per hunk;
   - Huffman builds its tables per call;
   - the CD wrappers keep no cross-hunk state.

   Native chdman relies on the same property, since hunks land on arbitrary threads, and the project's thread-count tests confirm it.
2. **Same selection code** (`find_best_compressor`, strict `<`, slot order) and the **same wasm module** (SIMD or baseline, chosen once per page) for job and helpers.
3. **Same input bytes, including the stale tail:** the full `hunk_bytes()` is sent from the job's ring.
4. **The writer is authoritative for dedupe.** Helpers only *skip* work. `-2` falls back to local compression when the self map misses, and parent matches are decided by the writer, so a helper's own view never changes output. `s_seen` key collisions only cost time.
5. **The in-memory CHD's `hunk_bytes` matches the real one.** The codecs never read `unit_bytes` or CHD state (except avhu, which is excluded).
6. **No `bad_alloc` in helpers.** `find_best_compressor` swallows allocation failures, which would silently change the chosen codec. This is the one realistic way to lose identity (wasm memory growth failure near the 2 GB `MAXIMUM_MEMORY`).

### 6.4 Costs and limitations

- **Asyncify.**
  - Only `main`, `do_create*`, `do_copy*` and `compress_common*` are instrumented, with `ASYNCIFY_IGNORE_INDIRECT` (`wasm/link.sh:5-6`), so the instrumentation overhead in hot code is nil.
  - Each yield unwinds and rewinds four small frames (a 64 KiB Asyncify stack) plus one event-loop turn. There are about (hunks/batchSize) yields: for a 4.7 GB DVD at batch 8, about 147 k.
  - Limitations:
    - one can **only yield in `compress_common`'s loop**, so reads must be synchronous (hence `FileReaderSync` and the iOS "stage" protocol);
    - parent walking, `compress_v5_map` and all extract/verify paths run without yielding or helpers;
    - any future call path via function pointers into the yield would silently break (IGNORE_INDIRECT);
    - `-flto` breaks under `-fwasm-exceptions` (CLAUDE.md).
- **Serial job worker.** Reading, stream SHA-1 (wasm, slower than native), copies, OPFS writes, flushing, the `-2` recompressions and the parent walk all run on one thread. This is the same serial ceiling as native, but lower.
- **Copies per hunk:** input copied twice (heap → batch, batch → helper heap); output copied four times (heap slice, concatenation, heap set, memcpy into the item).
- **Memory:** each helper holds a full codec group, and the job holds 16 unused groups (`m_codecs[16]` is still allocated). The project bench shows 0.6–1.1 GB peak RSS in Chromium.
- **Thread count:** chosen by `Tuning` (`app/ui.js:363-447`), which measures helper throughput on synthetic 4 KiB DVD hunks at 1, 2, 3, 4, 6, 8… threads until the gain drops under 8 %. It is capped at 8 on mobile and 16 elsewhere, and cached per core count plus user agent.

### 6.5 What a fork could restructure

1. **A proper library API instead of `callMain` + Asyncify.** `chd_file_compressor` is already a resumable state machine. Expose a C API (`chd_create_open`/`chd_create_step`/`chd_create_finish`, plus metadata calls) and drive `step()` from JS. This removes Asyncify, the text-scraped progress, and the `main()` coupling.
2. **Push-based streaming input.** Replace `read_data` pull with "here is the next N bytes" push into the ring. This allows async `File` streams without `FileReaderSync`, true stdin in native builds, and no staging on iOS. It must keep the ring and stale-tail semantics to stay byte-identical.
3. **A pluggable executor.** Abstract the osd work queue behind an interface (native thread pool without the 16 cap; Web Workers). Move per-hunk hashing into the executor, and keep the writer and dedupe decisions single-threaded and ordered.
4. **SharedArrayBuffer is not needed.** The current transfer model is fine. Zero-copy could come from transferring ring halves rather than copying per hunk.
5. **Parallel decompression** for verify, extract, copy input and the parent walk. Hunks are independent apart from self/parent references, so use per-thread decompressors and an ordered writer, with the SHA-1 streamed in order on a dedicated thread.
6. **Faster primitives in wasm:** a SIMD-assisted SHA-1 message schedule, and slice-by-8 CRC-16.

---

## 7. Architecture and licensing

### 7.1 Real dependency closure (`$SP/bench-B/closure.py` over `build/obj-native`)

Only **78 of the 144** compiled objects are reachable from `chdman.o` and `version.o`. The Makefile links all of them.

**Needed — MAME `lib/util` (18 files):**

| File | Pulled in by |
|---|---|
| `avhuff` | chdman (createld) |
| `aviio` | chdman |
| `bitmap` (+`palette`) | chdman |
| `cdrom` | chdman |
| `chd` | chdman |
| `chdcodec` | chdman |
| `corefile` | chdman |
| `corestr` | cdrom |
| `flac` | chdcodec |
| `hashing` | chdman |
| `huffman` | chd |
| `ioprocs` | chdman |
| `ioprocsstream` | chdman |
| `path` | chdman |
| `strformat` | chdman |
| `unicode` (+utf8proc) | posixfile |
| `vbiparse` | chdman |

**Needed — `osd`:** `osdcore`, `osdsync`, `strconv`, `modules/lib/osdlib_unix`, and `modules/file/posixfile` (which drags in `posixptty` and `posixsocket` for its special-path dispatch).

**Needed — 3rdparty:**

- libFLAC: 14 files, all except `float.c`;
- LZMA: only `LzmaEnc`, `LzmaDec`, `LzFind` and `CpuArch`;
- zlib core;
- zstd compress and decompress.

**Not needed:** `aes256cbc`, `archiver`, `corealloc`, `coreutil`, `delegate`, `disasmintf`, `dvdrom`, `dynamicclass`, `harddisk`, `hash`, `ioprocsfilter`, `jedparse`, `language`, `md5`, `mfpresolve`, `msdib`, `nanosvg`, `opresolv`, `options`, `path_to_regex`, `plaparse`, `png`, `simh_tape_file`, `timeconv`, `un7z`, `unzip`, `vecstream`, `wavwrite`, `xmlfile`, `zippath`, all of expat, 26 other LZMA/7z files, `zlib` `compress`/`infback`/`uncompr`, and zstd `debug`/`threading`.

`wasm/sources.mk` is therefore about twice as broad as necessary. `wasm-ld --gc-sections` hides most of it from the binary.

**Coupling points a fork must replace or vendor:**

| MAME piece | What chdman uses it for |
|---|---|
| `osd_work_queue` | threads |
| `osd_file` / `core_file` / `util::random_read_write` | I/O abstraction; `ioprocs` is clean and reusable |
| `util::string_format` / `stream_format` | printf-style formatting on iostreams |
| `util::sha1_creator` / `crc16_creator` | hashing |
| `osd_get_command_line` | UTF-8 argv on Windows |
| `osd_get_physical_drive_geometry` | createhd from a raw device |
| `avi_file` / `bitmap` / `vbiparse` / `avhuff` | LaserDisc only |
| `cdrom_file` | TOC parsing and CD reading (lane C) |

### 7.2 Bundled 3rdparty versions at 76c7d19

| Library | Version | Note |
|---|---|---|
| zlib | 1.3.2 | – |
| zstd | 1.5.7 | 1.5.5 at the `mame0289` tag |
| LZMA SDK | 26.02 | 23.01 at `mame0289` |
| libFLAC | 1.4.3 | – |
| utf8proc | 2.11 | – |
| expat | 2.8.3 | Unused by chdman |

### 7.3 License of every compiled source file (headers checked)

**MAME `src/lib/util` — BSD-3-Clause:** `aes256cbc` (header present, copyright-holders empty), `archiver`, `avhuff`, `aviio`, `bitmap`, `cdrom`, `chd`, `chdcodec`, `corealloc`, `corefile`, `corestr`, `coreutil`, `delegate`, `dvdrom`, `dynamicclass`, `flac`, `harddisk`, `hash`, `hashing`, `huffman`, `ioprocs`, `ioprocsfilter`, `ioprocsstream`, `jedparse`, `language`, `mfpresolve`, `msdib`, `opresolv`, `options`, `palette`, `path`, `plaparse`, `png`, `simh_tape_file`, `strformat`, `timeconv`, `unicode`, `unzip`, `un7z`, `vbiparse`, `vecstream`, `wavwrite`, `xmlfile`, `zippath`, and all their `.h`/`.ipp` headers. All carry `// license:BSD-3-Clause` explicitly.

**MAME, other licenses or no header:**

| File | License |
|---|---|
| `src/lib/util/md5.cpp`/`.h` | "Public Domain" (Colin Plumb) |
| `src/lib/util/path_to_regex.cpp` | MIT |
| **`src/lib/util/disasmintf.cpp`** | **No license header** |
| **`src/lib/util/nanosvg.cpp`** | **No header** (wraps zlib-licensed nanosvg) |

**MAME `osd` and tools — BSD-3-Clause:** `osdcore.cpp`, `strconv.cpp`, `osdsync.cpp`, `modules/lib/osdlib_unix.cpp`, `modules/file/posix{dir,file,ptty,socket}.cpp`, `src/tools/chdman.cpp`.

**3rdparty:**

| Library (files) | License |
|---|---|
| libFLAC (13 files) | Xiph BSD-3 ("Redistribution and use…") |
| libFLAC `md5.c` | Public domain |
| LZMA SDK (`LzmaEnc`, `LzmaDec`, `LzFind`, `CpuArch`, …) | Public domain (Igor Pavlov) |
| zlib | zlib license |
| zstd | Dual BSD / GPLv2 ("You may select, at your option"): pick BSD |
| utf8proc | MIT + Unicode data license (`utf8proc_data.c`) |
| expat | MIT |
| aes256cbc | MIT |
| nanosvg | zlib |

**Verdict: a BSD-3-Clause-only fork is feasible.**

- Remove `disasmintf.cpp` and `nanosvg.cpp` from the build. They are unused by chdman, and MAME's `COPYING` says "MAME as a whole … GPL; individual files may be … less restrictive … as noted in their header", so a header-less file is best treated as GPL-2.0.
- Pick BSD for zstd.
- Ship the notices for zlib, Xiph (FLAC), MIT (utf8proc, expat if kept) and the Unicode data license.
- Discpress's `THIRD_PARTY_NOTICES.md` says "Only the BSD-licensed parts of MAME … are compiled", but `disasmintf.cpp` is compiled, so the statement is technically inaccurate. Likely nothing of it survives wasm GC, but trimming `sources.mk` settles it.

### 7.4 Build system

- **Upstream:** GENie/premake (`scripts/src/tools.lua` and `3rdparty.lua`).
  - libFLAC is built **with** x86 SSE intrinsics (no AVX) and without `FLAC__NO_ASM`;
  - LZMA with `Z7_ST`;
  - zstd with `ZSTD_DISABLE_ASM`;
  - `with-system-*` switches allow distro libraries, which changes output bytes.
- **Discpress:** `wasm/Makefile` + `sources.mk`.
  - Native build: `T=native`, `-O2 -g0`, `FLAC__NO_ASM`.
  - wasm build: `-O3 -fwasm-exceptions` with and without `-msimd128`.
  - `wasm/link.sh` handles Asyncify and exports; the SDL shim covers the clipboard only.
  - For the 0.289 comparison build I overrode `UTIL`, `ZSTD_SRC`, `EXPAT_SRC` and `COMMON` (0.289 predates `ZLIB_CONST` use, `archiver.cpp`, `ioprocsstream.cpp` and `zstd_preSplit.c`). The Makefile otherwise worked unchanged as a reusable harness for building any MAME revision.

---

## 8. UX gaps relative to modern expectations

| Gap | Today | Modern expectation |
|---|---|---|
| Batch processing | One file per invocation; no globbing or recursion | `chdman createcd -i *.cue` and directory recursion, a parallel job queue, skip-existing |
| stdin/stdout | Output to stdout only for `dumpmeta` (banner-polluted); `-` as a filename is impossible (values starting with `-` are rejected) | `-i -`/`-o -` for raw streams (needs push input; §6.5) |
| Machine-readable output | Human text; progress on stderr with `\r`, CPU-clock-throttled; Discpress regex-scrapes it | `--json` for info/verify, NDJSON progress events (bytes, hunks, phase, ratio, ETA) |
| Exit codes | 0 on verify mismatch and on partial files; SIGABRT/SIGFPE on some bad inputs | Distinct codes (usage, I/O, corrupt, mismatch, interrupted) |
| Error messages | No hunk/offset/track context; misleading cue errors; "Fatal error occurred: 1" noise | Precise context and remediation ("use -ip <parent>", "input is not a CD CHD") |
| Safety | `-f` truncates in place; no same-file check; no temp+rename; partial files survive a kill | Atomic writes (temp + rename), same-inode checks, cleanup on SIGINT/SIGTERM |
| Cancellation and resumability | None; a restart recomputes everything | Signal-safe cancel; resumable creation (checkpoint the map every N hunks; the format allows appending) |
| Dry-run | None | `--dry-run` printing the detected layout, hunk, unit and codec plan and the estimated size |
| Hash-DB verification | `verify` checks only internal SHA-1s | Verify extracted-track CRC/SHA against Redump/No-Intro DATs (Discpress already has a DB), print a per-track match; issue #9825 asks to store per-track SHA-1s |
| Parent handling | Parent must be passed explicitly | Search by SHA-1 in a directory (the library already has an `open_parent` hook) |
| Info | Hunk counts only | Bytes per codec, map size, fragmentation, compat warnings (e.g. zstd requires newer emulators) |
| Metadata editing | Only for uncompressed CHDs | Metadata edits on compressed CHDs (rewrite the header, metadata and map; hunks untouched) |
| Performance knobs | `-np` (N−1 workers, cap 16) only | `--threads` meaning compression threads, codec presets (fast/best/zstd), a per-track-type codec plan |

---

## Implications for a Discpress fork

Ranked by value divided by risk. **[BI]** means byte-identical-preserving: output identical to current (76c7d19) chdman for the same options. **[¬BI]** means it changes output bytes; any compatibility risk is stated.

1. **[BI] Fast hashing.** SHA-1 with SHA-NI or ARMv8-SHA, a fast portable fallback, and a SIMD message schedule in wasm; CRC-16 slice-by-8 or CLMUL.
   - Effect: removes the ~150 MB/s serial reader ceiling, and cuts about 5–7 % of worker CPU and about 45 % of verify CPU.
   - Risk: none; hash values are defined mathematically.
2. **[BI] Fix the threading model.**
   - Replace the busy-wait with a blocking wait (the `-np 1`/single-CPU spin doubles CPU).
   - Make `-np N` mean N compression workers.
   - Lift the 16-thread cap (and the `m_codecs[16]` fixed array).
   - Split the stream SHA-1 from the I/O thread.

   Output stays identical because selection is per-hunk and deterministic, and the writer is ordered.
3. **[BI] Kill redundant work that cannot change bytes.**
   - Exact in-flight dedupe (skip the trial for hunks equal to an earlier *in-flight* hunk; the writer still decides, as the wasm `-2` path already does).
   - Shared CD frontend for cdlz/cdzl (split, ECC verify and subcode zlib computed once).
   - Encode generic `flac` into two buffers (no third encode).
   - Reuse the LZMA encoder handle across hunks, only if a fresh init is proven to give identical bytes (the encoder is `Create`d per hunk today).
   - Batched CD reads.

   Expected gain: about 5–25 % depending on content.
4. **[BI] Library API and executor** (§6.5). A step-driven C API with a pluggable executor and push input:
   - removes Asyncify and text scraping;
   - enables async/streamed browser input (no staging on iOS) and native stdin;
   - enables parallel parent walking in the browser.

   **Constraint:** reproduce the 256/128 ring and stale-tail semantics exactly (§2.12). Build a test that compares against native chdman on inputs whose last hunk is partial and whose hunk count exceeds 256.
5. **[BI] Parallel decompression** for verify, extract, copy input and parent walks: 4–8× on typical hardware. Output identical (reading only).
6. **[BI for valid inputs] Robustness and UX fixes:**
   - verify exit codes;
   - banner to stderr;
   - errors instead of `throw nullptr` and SIGFPE;
   - same-file protection;
   - temp-file + rename and cleanup on signals;
   - `extractcd` name collision;
   - absolute cue paths;
   - JSON output and progress events;
   - batch mode;
   - parent search;
   - resumable create.

   These change nothing for successful default runs.
7. **[Decision] Pick the byte-identity baseline explicitly.**
   - Today Discpress equals 76c7d19, i.e. the upcoming 0.290, not 0.289.
   - Options: (a) keep HEAD (level 6, future-proof with upstream); (b) restore level 8 plus zstd 1.5.5 to match the 0.289 release; (c) make the "reference chdman version" a build parameter and test against several.
   - Also fix the release notes' claim. For GD-ROM the data itself differs from 0.289, so coordinate with lane C.
8. **[¬BI, safe for all readers] Content-aware codec planning.** Skip `cdfl` on data tracks and `cdlz`/`cdzl` on audio tracks (known from the TOC); skip `flac` on non-audio DVD/HD hunks.
   - Gain: about 35–63 % of CD trial CPU and ~50 % of DVD CPU.
   - Bytes change only on the rare hunks where a skipped codec would have won; readers are unaffected (same codec set in the header).
   - Validate on real disc corpora; synthetic fixtures are not enough.
9. **[¬BI] Fix the stale padding.**
   - Zero-fill the tails: invisible, SHA-1 unchanged, file bytes differ.
   - For `createhd` beyond-EOF padding the fix changes the **Data SHA-1**, so gate it behind a flag or warn and refuse when geometry exceeds the input.
   - Also fix the silent raw-input read-error path: fail hard.
10. **[¬BI, reader-compat risk] Encoder tuning:**
    - zstd levels below 22: level 22 costs 3.5–12 MB/s and decompresses 7–20× faster than LZMA; lower levels are much faster to compress;
    - LZMA fb/mc;
    - larger DVD hunks.

    Hard constraints (lane A): keep LZMA lc3/lp0/pb2 and dictionary ≤ hunk (decoders *derive* properties from the hunk size); zstd/cdzs need newer readers; the hunk size affects emulator random-access cost.
11. **[Licensing]**
    - Trim `sources.mk` to the 78-object closure: drop `disasmintf`, `nanosvg`, expat and so on.
    - Correct `THIRD_PARTY_NOTICES.md`.
    - Keep the notices (zlib, Xiph, MIT, Unicode, zstd-BSD).
12. **[Overflow hardening, BI for supported sizes]** 64-bit map sizing (`nbits_needed`, `m_rawmap`, CRC over the map), hunk-count range checks at create time, `parse_number` validation.

**Risks:**

- **Drift from upstream:** MAME changes CHD bytes and even GD-ROM data layout between versions, so the fork needs a golden corpus, not "matches MAME".
- **Maintainer friction:** upstream reverts redundant or AI-drafted patches, so upstreaming requires well-argued, tested changes.
- **Byte identity is fragile:** it depends on library versions, build flags, distro system libraries, and the stale-tail ring semantics.
- **Real-disc behaviour of codec pruning is unknown.**
- **Browser memory ceilings** (2 GB wasm memory, swallowed `bad_alloc` giving non-deterministic output).

## Open questions

1. Which chdman should Discpress (and the fork's tests) treat as the reference: the `mame0289` release (LZMA level 8, zstd 1.5.5, old GD-ROM layout) or 76c7d19/0.290? Should the release notes be corrected now?
2. Is the 16-thread cap (`WORK_MAX_THREADS`) intentional for chdman, or only a MAME-emulation default? Would upstream accept a larger or dynamic cap?
3. How often do "losing" codecs win on **real** discs: cdfl on data tracks, cdlz/cdzl on audio, flac on DVD/HD? This needs a real-disc corpus (not in repo; lane G/E).
4. Do ARM64 builds (NEON intrinsics, FMA contraction) produce identical FLAC and LZMA bytes? This needs real ARM hardware. My x86 FMA proxy showed no difference.
5. Can the LZMA encoder handle be reused across hunks with bit-identical output (`LzmaEnc_SetProps` + `MemEncode` without `Create`/`Destroy`)? This needs a targeted test.
6. What exact dictionary and property assumptions do third-party decoders make (libchdr and others) when a fork changes the LZMA level? This is lane A's decoder-constraints question.
7. Under `-op` (delta), the final-hunk stale tail can come from parent-walk data. Does that ever make delta CHDs differ between native and wasm? The helpers do not parallelise the walk, so it should match, but it is untested.
8. Should the fork fix the `createhd` padding bug (changing Data SHA-1s for affected images) or keep it for compatibility with existing software-list hashes?
9. What is the Asyncify plus `-fwasm-exceptions` behaviour when unwinding through `try` blocks in `do_create_*` under future Emscripten releases? It works with 6.0.10 per the project tests.
10. The parent walk iterates over the *child's* length. Can it index stale buffer windows beyond a shorter parent's end and emit out-of-range parent references? This is reachable only with mismatched-size parents; I did not test it.

## Sources

**Code at `76c7d197ed`:**

- `src/tools/chdman.cpp`
- `src/lib/util/{chd.h,chd.cpp,chdcodec.cpp,hashing.cpp,cdrom.cpp,corefile.cpp,ioprocs.cpp}`
- `src/osd/{osdsync.cpp,osdcore.h}`
- `docs/source/tools/chdman.rst`
- `regtests/chdman/`
- `scripts/src/3rdparty.lua`

**Pristine upstream copies:** `$SP/src/upstream-B/`.

**Commits** (`git show`): c23567b509, f9050e8508, e5e82312c2, e0b94b77a5, ebe430d9fd, 33d4dc0aff, c2f6ac79c1, 14d07e35c1, 8a00440d2d, 1736a9595b, cccb680a04, 65c263749e, 02fc472f18, 1cf0f9e986, ac47a71ce1, b93961fd52, 20661546b2, c9e87a6b7e, 6cdf1cf700, bcb5cacdf7, 5731492874, fa9d0fc32a, 583a1f81f2.

**Web:**

- https://github.com/mamedev/mame/issues/13029 (delta CHD "Hunk out of range", 0.271–0.273)
- https://github.com/mamedev/mame/pull/14019
- https://github.com/mamedev/mame/issues/2517 (metadata changes vs XML hashes)
- https://github.com/mamedev/mame/issues/9825 (per-track SHA-1 request)
- https://github.com/mamedev/mame/blob/master/regtests/chdman/chdtest.py
- PRs #15808, #15870, #15886, #15893, #15902/#15936, #15910, #15931, #16043, #16044, #16045 and #16077 at `https://github.com/mamedev/mame/pull/<n>`. I read these as commits; the PR pages are unverified.

**Project:**

- `wasm/{mame.patch,wasm_helper.cpp,par_lib.js,link.sh,Makefile,sources.mk}`
- `app/worker.js:571-709`
- `app/ui.js:250-453`, `:1026`
- `tests/.cache/bench/*.md`
- `THIRD_PARTY_NOTICES.md`
- `.github/release-notes/v1.1.0.md`–`v1.2.0.md`

**My artefacts** (in the research workspace `$SP`):

| Path | Contents |
|---|---|
| `bench-B/harness.cpp`, `harness-cpu.log`, `harness-audio.log`, `harness-cd.log`, `harness-dvd.log` | Micro-benchmark and results |
| `bench-B/threads.py` | Per-thread CPU sampler |
| `bench-B/hunkdump.cpp` | Stale-tail check |
| `bench-B/closure.py`, `closure.txt` | Dependency closure |
| `bench-B/cmp0289/` | 0.289 vs HEAD vs level-8 outputs |
| `bench-B/flacasm/`, `bench-B/flacfma/` | FLAC build variants |
| `bench-B/exp/` | Bug reproductions |
| `bench-B/parent/` | Delta-CHD demo |
| `bench-B/regtests.log` | MAME regtests run |
| `bench-B/wasm/run.cjs` | Node wasm runner |
| `build0289-B/chdman-native` | 0.289 release build |
