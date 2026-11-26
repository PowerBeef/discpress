# Discpress tests and benchmarks

End-to-end UI tests and conversion benchmarks that drive the real single-file app
(`dist/discpress.html`, or a page freshly assembled from `app/`) in headless Chromium
with [Playwright](https://playwright.dev). Nothing here is part of the app.

## Setup

```sh
cd tests
npm install                      # Playwright Test + axe-core
pip install numpy                # for the synthetic disc generator (a repo-local .venv/ is auto-detected)
../scripts/build-upstream.sh     # optional but recommended: unmodified chdman 0.289, the reference
```

Chromium must be available to Playwright, in the build its version wants (`npx playwright install chromium`
on a new machine). `package.json` pins `@playwright/test` 1.65.1 so CI and local runs
share the same browser build (`browsers.json` in `playwright-core` names each release's build).
For local Antigravity sessions, see `.agents/skills/discpress-env-setup/SKILL.md` (and note that interactive
UI previews can also run directly against `node support/server.js 4173` in Antigravity's embedded browser).

## Running

| Command | What it does |
|---|---|
| `npm run fixtures` | generate synthetic test discs into `.cache/fixtures/` (uses repo-local `.venv/` when present; pass `-- --bench` or `-- --force` as needed) |
| `npm run native` | build the engine's native `chdman` reference (`build/chdman-native`) |
| `npm run dev-page` | extract wasm from `dist/discpress.html` if stale and assemble `build/discpress-dev.html` |
| `npm test` | all UI tests against `dist/discpress.html` (about 10 minutes on 4 cores) |
| `npm run test:dev` | the same against a page assembled from the current `app/` and `db/` (with `build/`'s wasm, taken first from `dist/discpress.html` when that is newer and differs) |
| `npx playwright test ui/convert.spec.js` | one file; add `-g "ps2"` to filter by test name |
| `npx playwright test --project=iphone` | one project: `desktop`, `file-url`, `iphone`, `android`, `layout` |
| `EXTRA_BROWSERS=1 npx playwright test --project=webkit` | real WebKit and Firefox too (`webkit`, `iphone-webkit`, `firefox`), once installed: `PLAYWRIGHT_BROWSERS_PATH=<dir> npx playwright install webkit firefox` and `npx playwright install-deps webkit firefox`, with Chromium linked into `<dir>`. Playwright's Linux WebKit has no `navigator.storage` and fails navigations while offline, so the private-storage tests and the offline reload skip there; `engine.spec` and `facts.spec` run in the Chromium projects only |
| `npm run report` | open the HTML report of the last run (traces and screenshots of failures) |
| `npm run bench -- --quick` | quick benchmark on the small fixtures (under a minute) |
| `npm run bench` | full benchmark on large generated images (300 MB CD, 1 GB DVD) |
| `npm run bench:dev -- --compare latest` | benchmark the current `app/` and compare with the last run |

Environment: `DISCPRESS_HTML` picks the page (relative to the repo root), `WORKERS` the number of
parallel test workers (default 2), `CHDMAN` a native chdman binary, `CHDMAN_ENGINE` and `CDPROBE_ENGINE` the engine binaries used by `ui/engine.spec.js` (e.g. sanitizer builds; see In CI), `DISCPRESS_FIXTURES` the fixtures folder (default `.cache/fixtures/`), `REGEN_FIXTURES=1` makes every fixture again (`make_fixtures.py --force`; the run does it by itself when the generator changed), `REQUIRE_NATIVE=1` fails the run without both native references (see In CI).
Outside CI a test server already running on `PORT` (default 4173) is reused; its `/healthz` names the page
it serves, and the run stops if that isn't the page `DISCPRESS_HTML` picks (stop it, or use another `PORT`).

## In CI

`.github/workflows/ci.yml` runs the whole suite on every push to `main` and every pull request, on
`dist/discpress.html`, after building both references (`scripts/build-upstream.sh`, cached, and
`scripts/build-native.sh`). It sets `REQUIRE_NATIVE=1`, which makes the run fail before any test if
`build/chdman-0.289` or a current `build/chdman-native` is missing: without them the byte-for-byte
checks skip. Set it locally too to be sure a run compared everything. The same workflow runs
`scripts/check-dist.sh`, `scripts/engine-diff.sh --check` and `scripts/check-licenses.sh`.

`.github/workflows/sanitizers.yml` runs `ui/engine.spec.js` on the engine built with AddressSanitizer,
LeakSanitizer and UndefinedBehaviorSanitizer (`scripts/build-sanitized.sh`, producing `build/chdman-san`
and `build/cdprobe-san`), named by `CHDMAN_ENGINE` and `CDPROBE_ENGINE`: a sanitizer report in chdman's or
cdprobe's output fails the test, whatever its exit code; a `CHDMAN_ENGINE` build that is missing or older
than `engine/` or `wasm/` fails the run rather than skip every test (so does `REQUIRE_NATIVE` without a
current `build/chdman-native`). It runs when `engine/`, `wasm/`, the build/sanitized scripts, `cdprobe.cpp`,
`native.js`, `paths.js`, the spec, the fixtures or the suppressions change, and weekly. Leaks unmodified
chdman 0.289 has too are suppressed (`support/lsan.supp`, each with how that was checked). Locally on Linux (matching `.github/workflows/sanitizers.yml`):
`CHDMAN_ENGINE=../build/chdman-san CDPROBE_ENGINE=../build/cdprobe-san ASAN_OPTIONS=detect_leaks=1:strict_string_checks=1:detect_stack_use_after_return=1 LSAN_OPTIONS=suppressions=$PWD/support/lsan.supp UBSAN_OPTIONS=print_stacktrace=1 npx playwright test ui/engine.spec.js --project=desktop`
(on macOS Apple Silicon, Apple Clang does not support LeakSanitizer, so use `ASAN_OPTIONS=detect_leaks=0`).

## How correctness is checked

- **Native chdman is the oracle.** Every CHD the app creates is compared with what native chdman
  makes from the same files: preferably `build/chdman-0.289`, unmodified chdman from the MAME 0.289
  release (`scripts/build-upstream.sh`), otherwise the engine's own `build/chdman-native`. With
  either, the outputs must be **byte-identical**, for every compression preset made of chdman's own
  options, thread count, SIMD and non-SIMD build, and storage mode. With another chdman version only
  the data checksums are compared.
  The engine's opt-in options that change a CHD's bytes but not its checksums (`--codecplan` and
  `--libdeflate` in "Nearly as small, faster" and "Faster to create", `--ultra` and `--libdeflate` in
  "Smaller still", `--zstd-level 19` in "Faster to load (Zstd)" and "For MiSTer FPGA", and `--keepcue`)
  are checked against 0.289's checksums, and against `build/chdman-native`'s bytes when it is current.
- **Extraction** is compared file by file with native `extractcd`/`extractdvd`/`extracthd`, and DVD
  and hard disk images must come back identical to the original input.
- **Every test** also fails if the page logs a console error or uncaught exception, or makes any
  network request (the app promises to work offline and upload nothing).

## Fixtures

`fixtures/make_fixtures.py` generates synthetic discs into `.cache/fixtures/` (deterministic,
about a second, 95 manifest entries including benchmark images): ISO 9660 file systems, raw CD sectors with valid EDC/ECC (Mode 1 and Mode 2),
CD audio, a CloneCD image, a cdrdao TOC and a Nero image (compared with the engine's native build, `engine: true`, or a cue twin, since chdman 0.289 reads their pregaps wrongly), a PlayStation disc booting `PSX.EXE`, a NAOMI 2 GD-ROM, compressed ISOs (CSO v1 and v2, ZSO; the generator has its own LZ4 encoder), ECM images (the generator's encoder writes the same bytes as the ecm tools' `bin2ecm`, including Mode 2 Form 2 sectors and silence stored as sectors), cue sheets chdman 0.289 misreads (each with a plain twin), cue sheets with more than a CHD's tracks hold (CATALOG, FLAGS, ISRC, INDEX 02, `CDI/2352`), console boot headers for the consoles the page recognizes (PlayStation, PS2 on CD and DVD, PSP and UMD Video, Saturn, Sega CD, Dreamcast, NAOMI, PC Engine CD, PC-FX, Neo Geo CD, 3DO, CD-i and CD-i Bridge, CD32 and CDTV, Jaguar CD, Xbox 360, PS3, GameCube, Wii, Video CD, DVD-Video; plus a PC-98 disc matched via `testdb.json` alongside header-marker tests for PC-98 `IPL1`, FM Towns, and Nuon), Sega first-party serials, discs of a set and releases told apart by size and region, PlayStation EBOOT.PBP files, LibCrypt discs (with an `.sbi`, a CloneCD `.sub`, or neither), multi-session discs, the layouts the rules in `app/quirks.js` look at, a music CD and a hard disk image.
Additional v2.0.x synthetic inputs (Original Xbox XISO, streaming `.7z`, Alcohol 120% `.mds`/`.mdf`, DiscJuggler `.cdi`, FLAC/24-bit WAV/AIFF/MP3 audio cues, FM Towns, PC-98 `IPL1`, and Nuon) are generated inline by `ui/overhaul6.spec.js` and `ui/identify.spec.js`.
They carry serial numbers of real games, so identification can be tested against the built-in
Redump database, but contain no game data. `manifest.json` lists each fixture with the job and
identification the app should produce, the name a result keeps (`out`), the rule ids its card must show (`quirks`; none when there are none) and the console's own note (`note`; none without one). `--bench` adds large, realistic images for benchmarks.
`generator.sha256` records which version of `make_fixtures.py` and `discgen.py` made the fixtures: when
either changes, the next run makes every fixture again (existing files are otherwise kept), and drops
what was made from the old ones (native chdman's references, cached in `.cache/native/` keyed by binary content, fixtures dir, input size/mtime, command and flags, and the
CHDs and files tests derived from them). Each run also removes the folders earlier runs extracted
native CHDs into.
The two `codec mix` images change content every hunk (data, noise, and audio in both byte orders),
so that each codec wins, loses and stops early in turn.

The driver stores a per-device speed test result before each page opens (`Math.min(4, cores)` threads),
so tests don't each spend seconds measuring; `app.open({ tuned: false })` leaves it out.

Synthetic discs can't match real Redump checksums, so `make_fixtures.py` also writes `testdb.json`:
database rows matching some fixtures' size and CRC-32. The test server merges them into the page's
game database when it is requested as `/discpress.html?testdb=1` (`app.open({ testdb: true })`).

## What the tests cover (`ui/`, 25 specs / 494 tests)

| Spec | Covers |
|---|---|
| `smoke` | loading, tabs, help, settings persistence, one conversion (also from `file://` and on phones) |
| `convert` | every input type and console, identification, output naming, version choice, presets (including `Smaller still` `--ultra`, `Zstd` L19), thread counts, Start all / Download all |
| `chd` | CHD inputs: identification from inside the CHD, extract (Redump's layout, which gives back the fixtures' own files; cue, split bins, toc, gdi, iso, img), verify (good and damaged, and compared with Redump), both with and without helper workers, info, rename, parent CHDs |
| `identify` | checksum-verified identification (via extra database rows, above), also of the ISO inside a compressed ISO, conversions that start before the checksum finishes and are renamed after it, a version picked meanwhile is kept, starting while identification is still running, audio CDs not named after a game, CHDs matched by size or with Mode 2 data tracks, a reader worker that dies, Phase 2 detection (FM Towns, PC-98 `IPL1`, Nuon over `VIDEO_TS`, Dreamcast WinCE, Saturn 4 MB RAM cart, single-bin CUE track slicing) |
| `tuning` | the automatic thread count: one-off speed test on the first conversion, reuse, not capped by the reported core count, manual override, Measure again |
| `gdrom` | Dreamcast GD-ROM layout from a `.gdi` and a Redump cue: no pregaps, track 3 at LBA 45000 |
| `engine` | the engine's own command line against unmodified chdman 0.289: the 0.289 defects it fixes, identical CHDs when codec trials stop early, checksums and codecs of the codec plan / libdeflate, single-pass `verify --redump`, TOSEC mixed-track GD-ROM `--redump`, and hostile CHD/metadata/Huffman/AVHUFF hardening |
| `profiles` | settings picked from the console (`PROFILES`): type and hunk size (PSP 2,048), Zstd warnings, the compatibility mode for older emulators (PS2 DVD games as CD CHDs, and the setting it replaced), Xbox 360 and PS3 notes, `.sbi` files (also made from a CloneCD `.sub`), `.m3u` playlists (lettered discs too), the PCSX2 and Flycast notes, the MiSTer preset |
| `quirks` | the rules in `app/quirks.js` (Saturn, Sega CD and PC Engine CD leave out `--keepcue`, NAOMI keeps its name) and the `PROFILES` warnings next to them: Zstd and MiSTer for PS2, Dreamcast, NAOMI and PC-FX (and Zstd for every console in the compatibility mode), `data-quirk` ids, more than two notes grouped, the LibCrypt warning until an `.sbi` or `.lsd` is added (including post-ident `.sbi` pairing by Redump name/PS1 serial and redumper `.subcode`), an `.sbi` of another console left out, a set's "Disc 1 of 3" note, CloneCD v2 `[Entry N]`, ImgBurn `.mds` sidecar skip, `.hdi` header refusal, and PS2/PSP emulator disc-swap guidance instead of `.m3u` |
| `facts` | `scripts/assemble.py` refuses a `db/facts` line with an unknown system, serial or fact, or without a source |
| `zip` | `.zip` input: stored and deflated entries, zip64, entries it refuses, no private storage |
| `pbp` | PS1 `EBOOT.PBP` files: one card per disc, files it refuses |
| `dat` | DAT files: every track matched before converting and after Verify, verified discs named after them, kept for later visits |
| `verify` | Verify on a finished card, the verify-after setting, verify by itself after a helper failed (or lied), the question before results too large for memory |
| `advanced` | the Advanced tab: form, text commands, validation, listtemplates |
| `edge-cases` | missing tracks, lone tracks, duplicates, unsupported files, descriptors and CloneCD images chdman can't convert, truncated images, compressed ISOs (as a CD, not one at all, damaged), ECM images (finding their cue sheet, not one at all, damaged), tracks of the same name in several game folders, cue sheets with unquoted, single-quoted or macOS-style names, DVD/CD switch, cancel, remove, the questions before unsaved results are thrown away |
| `fallbacks` | no SIMD, no OPFS, memory-only, input staging and page streaming (iOS web views, also of a compressed ISO and an ECM image), single core, helper workers that fail to start or trap (the others, or a second run, finish the job; extract and verify go on), the message when the browser's engine fails again, SIMD vs non-SIMD CD-audio FLAC parity, and warm worker pool reuse, idle-reap, and memory-cap eviction |
| `mobile` | phone layout, thread defaults (the iPhone speed test tries up to 4, and one stored at 1.3.1's limit of 2 is measured again), the fixed-header scrolling used inside iOS app web views, saving through the share sheet (its failure falls back to a download, results too large for it download), the Safari tip in iOS app web views, the Safari fallback for big results in a Home Screen web app |
| `recovery` | results kept from an earlier visit (listed after a reload, saved, deleted), a conversion stopped by a reload, OPFS checkpoint resume after reload (1 and 4 threads, byte-for-byte match with native chdman), where results live in memory (also from `file://`, where Chrome gives no private storage), and which results a reload lost |
| `folder` | writing results into a folder (a fake File System Access folder): a file already there is replaced only if the user agrees, and never deleted by a cancel; a cancel leaves no new file |
| `hosted` | the online version (`web/`), on desktop and emulated phones: manifest, icons, service worker, working offline, opening from its saved copy on a slow network or when the site answers with an error, a copy without `web/`'s files; the Content Security Policy blocks network requests |
| `layout` | 9 screen sizes (from a 320-pixel phone to a 1920-pixel desktop, phones and tablets in both orientations) × light/dark × 5 screens: no horizontal overflow, tap targets under 32 pixels noted; screenshots in `.cache/screens/` |
| `a11y` | axe-core audit of every screen in both themes; serious problems fail |
| `overhaul5` | Target Environment selector across PS2/Saturn/Dreamcast/PC, reversible `DPRC0001` gap/dcgaps layout repairs, 12-check CHD Health Auditor + 1-click `copy --stripmeta` and `-hs 2048` fixes, console folder grouping, ES-DE `<Game>.m3u/` layout, and pre-flight `#collisionDlg` overwrite dialog |
| `overhaul6` | lossless FLAC / extended 24-bit WAV / AIFF and lossy GOG `.ins` + MP3 audio cues, streaming `.7z` archives, Alcohol 120% `.mds`/`.mdf` v1.5 (+PS1 interleaved Q `.sbi`, v2 refusal), DiscJuggler `.cdi` v3.5 (1-session CHD, multi-session DC MIL-CD extract & Flycast 2.8+ CHD), CD+G `TRACK nn CDG` & CloneCD `.sub` `RW_RAW`, CSO v1/v2 & ZSO `--block=2048` from ISO/DVD CHD, and scrubbed Original Xbox `.xiso.iso` |

A bug found but not fixed yet can be pinned in the relevant spec with `test.fail(true, 'why')`: the
test passes while the bug exists and Playwright reports it when a fix lands, so the marker can be removed.

Emulated phones use Chromium with phone viewports, touch and user agents; they catch layout and
logic problems but not WebKit-specific rendering.

## Benchmarks (`bench/bench.js`)

Times real conversions through the UI (from pressing the button to the finished state, measured
with the page's own clock) and the same work with native chdman. Options:
`--fixtures`, `--quick`, `--ops create,extract`, `--threads 1,2,4`, `--simd on,off`,
`--presets default,plan,fast,zstd,none` (`plan` and `fast` use the engine's own options and are checked against `build/chdman-native`), `--repeat N`, `--html PATH`, `--label NAME`,
`--compare FILE|latest`, `--cd-mb`, `--dvd-mb`, `--no-native`, `--no-native-timing`, `--no-verify`.

Each run writes `.cache/bench/<time>-<label>.json` and `.md`: seconds (median), throughput,
compression ratio, peak memory of the browser, time relative to native chdman, change against a
previous run, and whether the output was byte-identical to native chdman.
