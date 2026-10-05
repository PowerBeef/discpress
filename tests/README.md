# Discpress tests and benchmarks

End-to-end UI tests and conversion benchmarks that drive the real single-file app
(`dist/discpress.html`, or a page freshly assembled from `app/`) in headless Chromium
with [Playwright](https://playwright.dev). Nothing here is part of the app.

## Setup

```sh
cd tests
npm install                      # Playwright Test + axe-core
pip install numpy                # for the synthetic disc generator
../scripts/build-upstream.sh     # optional but recommended: unmodified chdman 0.289, the reference
```

Chromium must be available to Playwright (`npx playwright install chromium` on a new machine;
Claude Code on the web already has it). In Claude Code on the web, `.claude/hooks/session-start.sh`
does all of this when a session starts.

## Running

| Command | What it does |
|---|---|
| `npm test` | all UI tests against `dist/discpress.html` (about 4 minutes on 4 cores) |
| `npm run test:dev` | the same against a page assembled from the current `app/` and `db/` (with `build/`'s wasm, taken first from `dist/discpress.html` when that is newer and differs) |
| `npx playwright test ui/convert.spec.js` | one file; add `-g "ps2"` to filter by test name |
| `npx playwright test --project=iphone` | one project: `desktop`, `file-url`, `iphone`, `android`, `layout` |
| `EXTRA_BROWSERS=1 npx playwright test --project=webkit` | real WebKit and Firefox too (`webkit`, `iphone-webkit`, `firefox`), once installed: `PLAYWRIGHT_BROWSERS_PATH=<dir> npx playwright install webkit firefox` and `npx playwright install-deps webkit firefox`, with Chromium linked into `<dir>`. Playwright's Linux WebKit has no `navigator.storage` and fails navigations while offline, so the private-storage tests and the offline reload skip there; `engine.spec` and `facts.spec` run in the Chromium projects only |
| `npm run report` | open the HTML report of the last run (traces and screenshots of failures) |
| `npm run bench -- --quick` | quick benchmark on the small fixtures (about 1.5 minutes) |
| `npm run bench` | full benchmark on large generated images (300 MB CD, 1 GB DVD) |
| `npm run bench:dev -- --compare latest` | benchmark the current `app/` and compare with the last run |

Environment: `DISCPRESS_HTML` picks the page (relative to the repo root), `WORKERS` the number of
parallel test workers (default 2), `CHDMAN` a native chdman binary, `DISCPRESS_FIXTURES` the fixtures folder (default `.cache/fixtures/`), `REGEN_FIXTURES=1` makes every fixture again (`make_fixtures.py --force`; the run does it by itself when the generator changed), `REQUIRE_NATIVE=1` fails the run without both native references (see In CI).
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
LeakSanitizer and UndefinedBehaviorSanitizer (`scripts/build-sanitized.sh`, `build/chdman-san`), named
by `CHDMAN_ENGINE`: a sanitizer report in chdman's output fails the test, whatever its exit code; a
`CHDMAN_ENGINE` build that is missing or older than `engine/` or `wasm/` fails the run rather than skip
every test (so does `REQUIRE_NATIVE` without a current `build/chdman-native`). It runs
when `engine/` or `wasm/` change, and weekly. Leaks unmodified chdman 0.289 has too are suppressed
(`support/lsan.supp`, each with how that was checked). Locally:
`CHDMAN_ENGINE=../build/chdman-san LSAN_OPTIONS=suppressions=$PWD/support/lsan.supp npx playwright test ui/engine.spec.js`.

## How correctness is checked

- **Native chdman is the oracle.** Every CHD the app creates is compared with what native chdman
  makes from the same files: preferably `build/chdman-0.289`, unmodified chdman from the MAME 0.289
  release (`scripts/build-upstream.sh`), otherwise the engine's own `build/chdman-native`. With
  either, the outputs must be **byte-identical**, for every compression preset, thread count, SIMD and
  non-SIMD build, and storage mode. With another chdman version only the data checksums are compared.
  The engine's opt-in options that change a CHD's bytes but not its checksums (`--codecplan`, the
  "Nearly as small, faster" preset, and `--keepcue`) are checked against 0.289's checksums, and
  against `build/chdman-native`'s bytes when it is current.
- **Extraction** is compared file by file with native `extractcd`/`extractdvd`/`extracthd`, and DVD
  and hard disk images must come back identical to the original input.
- **Every test** also fails if the page logs a console error or uncaught exception, or makes any
  network request (the app promises to work offline and upload nothing).

## Fixtures

`fixtures/make_fixtures.py` generates synthetic discs into `.cache/fixtures/` (deterministic,
about a second): ISO 9660 file systems, raw CD sectors with valid EDC/ECC (Mode 1 and Mode 2),
CD audio, a CloneCD image, a cdrdao TOC and a Nero image (compared with the engine's native build, `engine: true`, or a cue twin, since chdman 0.289 reads their pregaps wrongly), a PlayStation disc booting `PSX.EXE`, a NAOMI 2 GD-ROM, compressed ISOs (CSO v1 and v2, ZSO; the generator has its own LZ4 encoder), ECM images (the generator's encoder writes the same bytes as the ecm tools' `bin2ecm`, including Mode 2 Form 2 sectors and silence stored as sectors), cue sheets chdman 0.289 misreads (each with a plain twin), cue sheets with more than a CHD's tracks hold (CATALOG, FLAGS, ISRC, INDEX 02, `CDI/2352`), console boot headers for every console the page recognizes (PlayStation, PS2 on CD and DVD, PSP and UMD Video, Saturn, Sega CD, Dreamcast, NAOMI, PC Engine CD, PC-FX, Neo Geo CD, 3DO, CD-i and CD-i Bridge, CD32 and CDTV, Jaguar CD, Xbox 360, PS3, GameCube, Wii, Video CD, DVD-Video; PC-98, which has no marker, by a test database row), Sega first-party serials, discs of a set and releases told apart by size and region, PlayStation EBOOT.PBP files, LibCrypt discs (with an `.sbi`, a CloneCD `.sub`, or neither), multi-session discs, the layouts the rules in `app/quirks.js` look at, a music CD and a hard disk image.
They carry serial numbers of real games, so identification can be tested against the built-in
Redump database, but contain no game data. `manifest.json` lists each fixture with the job and
identification the app should produce, the name a result keeps (`out`), the rule ids its card must show (`quirks`; none when there are none) and the console's own note (`note`; none without one). `--bench` adds large, realistic images for benchmarks.
`generator.sha256` records which version of `make_fixtures.py` and `discgen.py` made the fixtures: when
either changes, the next run makes every fixture again (existing files are otherwise kept), and drops
what was made from the old ones (native chdman's references, which are cached by file name, and the
CHDs and files tests derived from them). Each run also removes the folders earlier runs extracted
native CHDs into.
The two `codec mix` images change content every hunk (data, noise, and audio in both byte orders),
so that each codec wins, loses and stops early in turn.

The driver stores a per-device speed test result before each page opens (`Math.min(4, cores)` threads),
so tests don't each spend seconds measuring; `app.open({ tuned: false })` leaves it out.

Synthetic discs can't match real Redump checksums, so `make_fixtures.py` also writes `testdb.json`:
database rows matching some fixtures' size and CRC-32. The test server merges them into the page's
game database when it is requested as `/discpress.html?testdb=1` (`app.open({ testdb: true })`).

## What the tests cover (`ui/`)

| Spec | Covers |
|---|---|
| `smoke` | loading, tabs, help, settings persistence, one conversion (also from `file://` and on phones) |
| `convert` | every input type and console, identification, output naming, version choice, presets, thread counts, Start all / Download all |
| `chd` | CHD inputs: identification from inside the CHD, extract (Redump's layout, which gives back the fixtures' own files; cue, split bins, toc, gdi, iso, img), verify (good and damaged, and compared with Redump), both with and without helper workers, info, rename, parent CHDs |
| `identify` | checksum-verified identification (via extra database rows, below), also of the ISO inside a compressed ISO, conversions that start before the checksum finishes and are renamed after it, a version picked meanwhile is kept, starting while identification is still running, audio CDs not named after a game, CHDs matched by size or with Mode 2 data tracks, a reader worker that dies |
| `tuning` | the automatic thread count: one-off speed test on the first conversion, reuse, not capped by the reported core count, manual override, Measure again |
| `gdrom` | Dreamcast GD-ROM layout from a `.gdi` and a Redump cue: no pregaps, track 3 at LBA 45000 |
| `engine` | the engine's own command line against unmodified chdman 0.289: the 0.289 defects it fixes, identical CHDs when codec trials stop early, and the checksums and codecs of the codec plan |
| `profiles` | settings picked from the console (`PROFILES`): type and hunk size (PSP 2,048), Zstd warnings, the PS2 DVD-as-CD setting, Xbox 360 and PS3 notes, `.sbi` files (also made from a CloneCD `.sub`), `.m3u` playlists (lettered discs too), the PCSX2 and Flycast notes, the MiSTer preset |
| `quirks` | the rules in `app/quirks.js`: Saturn and Sega CD leave out `--keepcue`, NAOMI keeps its name, Zstd and MiSTer warnings for PS2, Dreamcast, NAOMI and PC-FX, `data-quirk` ids, more than two notes grouped, the LibCrypt warning until an `.sbi` or `.lsd` is added, an `.sbi` of another console left out, a set's "Disc 1 of 3" note |
| `facts` | `scripts/assemble.py` refuses a `db/facts` line with an unknown system, serial or fact, or without a source |
| `zip` | `.zip` input: stored and deflated entries, zip64, entries it refuses, no private storage |
| `pbp` | PS1 `EBOOT.PBP` files: one card per disc, files it refuses |
| `dat` | DAT files: every track matched before converting and after Verify, verified discs named after them, kept for later visits |
| `verify` | Verify on a finished card, the verify-after setting, verify by itself after a helper failed (or lied), the question before results too large for memory |
| `advanced` | the Advanced tab: form, text commands, validation, listtemplates |
| `edge-cases` | missing tracks, lone tracks, duplicates, unsupported files, descriptors and CloneCD images chdman can't convert, truncated images, compressed ISOs (as a CD, not one at all, damaged), DVD/CD switch, cancel, remove |
| `fallbacks` | no SIMD, no OPFS, memory-only, input staging and page streaming (iOS web views, also of a compressed ISO), single core |
| `mobile` | phone layout, thread defaults (the iPhone speed test tries up to 4, and one stored at 1.3.1's limit of 2 is measured again), the fixed-header scrolling used inside iOS app web views, saving through the share sheet (its failure falls back to a download, results too large for it download), the Safari tip in iOS app web views, the Safari fallback for big results in a Home Screen web app |
| `recovery` | results kept from an earlier visit (listed after a reload, saved, deleted) and a conversion stopped by a reload; where results live in memory (also from `file://`, where Chrome gives no private storage), which results a reload lost |
| `folder` | writing results into a folder (a fake File System Access folder): a file already there is replaced only if the user agrees, and never deleted by a cancel; a cancel leaves no new file |
| `hosted` | the online version (`web/`), on desktop and emulated phones: manifest, icons, service worker, working offline, opening from its saved copy on a slow network or when the site answers with an error, a copy without `web/`'s files; the Content Security Policy blocks network requests |
| `layout` | 9 screen sizes (from a 320-pixel phone to a 1920-pixel desktop, phones and tablets in both orientations) × light/dark × 5 screens: no horizontal overflow, tap targets under 32 pixels noted; screenshots in `.cache/screens/` |
| `a11y` | axe-core audit of every screen in both themes; serious problems fail |

A bug found but not fixed yet can be pinned in the relevant spec with `test.fail(true, 'why')`: the
test passes while the bug exists and Playwright reports it when a fix lands, so the marker can be removed.

Emulated phones use Chromium with phone viewports, touch and user agents; they catch layout and
logic problems but not WebKit-specific rendering.

## Benchmarks (`bench/bench.js`)

Times real conversions through the UI (from pressing the button to the finished state, measured
with the page's own clock) and the same work with native chdman. Options:
`--fixtures`, `--quick`, `--ops create,extract`, `--threads 1,2,4`, `--simd on,off`,
`--presets default,plan,fast,zstd,none` (`plan` and `fast` use the engine's own options and are checked against `build/chdman-native`), `--repeat N`, `--html PATH`, `--label NAME`,
`--compare FILE|latest`, `--cd-mb`, `--dvd-mb`, `--no-native`, `--no-verify`.

Each run writes `.cache/bench/<time>-<label>.json` and `.md`: seconds (median), throughput,
compression ratio, peak memory of the browser, time relative to native chdman, change against a
previous run, and whether the output was byte-identical to native chdman.
