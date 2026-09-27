# Discpress tests and benchmarks

End-to-end UI tests and conversion benchmarks that drive the real single-file app
(`dist/discpress.html`, or a page freshly assembled from `app/`) in headless Chromium
with [Playwright](https://playwright.dev). Nothing here is part of the app.

## Setup

```sh
cd tests
npm install                      # Playwright Test + axe-core
pip install numpy                # for the synthetic disc generator
../scripts/build-native.sh       # optional but recommended: native chdman 0.289 (the reference)
```

Chromium must be available to Playwright (`npx playwright install chromium` on a new machine;
Claude Code on the web already has it). In Claude Code on the web, `.claude/hooks/session-start.sh`
does all of this when a session starts.

## Running

| Command | What it does |
|---|---|
| `npm test` | all UI tests against `dist/discpress.html` (about 4 minutes on 4 cores) |
| `npm run test:dev` | the same against a page assembled from the current `app/` and `db/` |
| `npx playwright test ui/convert.spec.js` | one file; add `-g "ps2"` to filter by test name |
| `npx playwright test --project=iphone` | one project: `desktop`, `file-url`, `iphone`, `android`, `layout` |
| `npm run report` | open the HTML report of the last run (traces and screenshots of failures) |
| `npm run bench -- --quick` | quick benchmark on the small fixtures (about 1.5 minutes) |
| `npm run bench` | full benchmark on large generated images (300 MB CD, 1 GB DVD) |
| `npm run bench:dev -- --compare latest` | benchmark the current `app/` and compare with the last run |

Environment: `DISCPRESS_HTML` picks the page (relative to the repo root), `WORKERS` the number of
parallel test workers (default 2), `CHDMAN` a native chdman binary, `REGEN_FIXTURES=1` rebuilds fixtures.

## How correctness is checked

- **Native chdman is the oracle.** Every CHD the app creates is compared with what native chdman
  makes from the same files. With `build/chdman-native` (same MAME revision and patch as the app)
  the outputs must be **byte-identical**, for every compression preset, thread count, SIMD and
  non-SIMD build, and storage mode. With another chdman version only the data checksums are compared.
- **Extraction** is compared file by file with native `extractcd`/`extractdvd`/`extracthd`, and DVD
  and hard disk images must come back identical to the original input.
- **Every test** also fails if the page logs a console error or uncaught exception, or makes any
  network request (the app promises to work offline and upload nothing).

## Fixtures

`fixtures/make_fixtures.py` generates synthetic discs into `.cache/fixtures/` (deterministic,
about a second): ISO 9660 file systems, raw CD sectors with valid EDC/ECC (Mode 1 and Mode 2),
CD audio, and console boot headers for PlayStation, PS2, PSP, Saturn, Sega CD and Dreamcast (GDI).
They carry serial numbers of real games, so identification can be tested against the built-in
Redump database, but contain no game data. `manifest.json` lists each fixture with the job and
identification the app should produce. `--bench` adds large, realistic images for benchmarks.

Synthetic discs can't match real Redump checksums, so `make_fixtures.py` also writes `testdb.json`:
database rows matching some fixtures' size and CRC-32. The test server merges them into the page's
game database when it is requested as `/discpress.html?testdb=1` (`app.open({ testdb: true })`).

## What the tests cover (`ui/`)

| Spec | Covers |
|---|---|
| `smoke` | loading, tabs, help, settings persistence, one conversion (also from `file://` and on phones) |
| `convert` | every input type and console, identification, output naming, version choice, presets, thread counts, Start all / Download all |
| `chd` | CHD inputs: identification from inside the CHD, extract (cue, split bins, toc, gdi, iso, img), verify (good and damaged), info, rename, parent CHDs |
| `identify` | checksum-verified identification (via extra database rows, below), conversions that start before the checksum finishes and are renamed after it, starting while identification is still running |
| `advanced` | the Advanced tab: form, text commands, validation, listtemplates |
| `edge-cases` | missing tracks, lone tracks, duplicates, unsupported files, truncated images, DVD/CD switch, cancel, remove |
| `fallbacks` | no SIMD, no OPFS, memory-only, input staging and page streaming (iOS web views), single core |
| `mobile` | phone layout, thread defaults, the fixed-header scrolling used inside iOS app web views |
| `layout` | 7 screen sizes × light/dark × 5 screens: no horizontal overflow; screenshots in `.cache/screens/` |
| `a11y` | axe-core audit of every screen in both themes; serious problems fail |

A bug found but not fixed yet can be pinned in the relevant spec with `test.fail(true, 'why')`: the
test passes while the bug exists and Playwright reports it when a fix lands, so the marker can be removed.

Emulated phones use Chromium with phone viewports, touch and user agents; they catch layout and
logic problems but not WebKit-specific rendering.

## Benchmarks (`bench/bench.js`)

Times real conversions through the UI (from pressing the button to the finished state, measured
with the page's own clock) and the same work with native chdman. Options:
`--fixtures`, `--quick`, `--ops create,extract`, `--threads 1,2,4`, `--simd on,off`,
`--presets default,fast,zstd,none`, `--repeat N`, `--html PATH`, `--label NAME`,
`--compare FILE|latest`, `--cd-mb`, `--dvd-mb`, `--no-native`, `--no-verify`.

Each run writes `.cache/bench/<time>-<label>.json` and `.md`: seconds (median), throughput,
compression ratio, peak memory of the browser, time relative to native chdman, change against a
previous run, and whether the output was byte-identical to native chdman.
