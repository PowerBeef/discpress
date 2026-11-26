# Testing & Benchmark Rules (`tests/AGENTS.md`)

Applies to `tests/` (Playwright UI suite, native engine tests, synthetic disc generators, benchmarks). See `tests/README.md` for the full spec matrix and benchmark CLI flags.

## Fast Iteration Loop

- **Assemble a dev page (< 1 s, no Emscripten):** `npm run dev-page` inside `tests/` (runs `extract-build.py --if-stale` + `assemble.py build/discpress-dev.html`).
- **Interactive UI testing in Antigravity (embedded browser):**
  - Serve the dev or dist page locally with `DISCPRESS_HTML=build/discpress-dev.html node tests/support/server.js 4173` (or omit `DISCPRESS_HTML` for `dist/discpress.html`) and delegate opening `http://127.0.0.1:4173` to the `browser` subagent.
  - The server re-reads the HTML file on every request, supports `/discpress.html?testdb=1` (merges `tests/.cache/fixtures/testdb.json`), and exposes `/healthz`, `/blank.html`, `/alt/<id>/...` (and `/alt/nosw-<id>/...`), and `/__slow/<id>`, `/__fail/<id>`, `/__reset/<id>` service-worker test routes.
- **Automated Playwright suite & benchmarks (when `tests/node_modules` + Chromium are installed):**
  - `npm run test:dev` tests `build/discpress-dev.html`; `npm test` tests committed `dist/discpress.html`.
  - Target single files or tests: `npx playwright test ui/convert.spec.js -g ps2 --project=desktop`.
  - Benchmarks: `npm run bench -- --quick` or `npm run bench:dev -- --compare latest`.
  - Review visual changes via screenshots written by `ui/layout.spec.js` to `tests/.cache/screens/<size>/<theme>-<screen>.png`.
  - Real WebKit and Firefox (when installed locally on macOS/Linux): `EXTRA_BROWSERS=1 npx playwright test --project=webkit`.
- **Before committing:** run `python3 scripts/assemble.py` (for `app/`, `db/`, or `VERSION` changes) or `./build.sh` (for `engine/`, `wasm/`, or `build.sh` changes), then `./scripts/check-dist.sh`.

## Correctness & Oracle Rules

- **Strict page invariants:** Every test using the `app` fixture (`tests/support/app.js`) fails on any browser console error, uncaught exception, or network request.
- **Native chdman oracles (`tests/support/native.js`):**
  - Order of preference: `CHDMAN` env var → `build/chdman-0.289` (`scripts/build-upstream.sh`) → `build/chdman-native` (`scripts/build-native.sh`) → `chdman` on `PATH`.
  - Default-preset CHDs must be **byte-identical** to `0.289`; opt-in engine options (`--codecplan`, `--libdeflate`, `--ultra`, `--zstd-level`, `--keepcue`, `--sessions`, `--trailer`, `--stripmeta`, `verify --redump`) are checked against `0.289`'s checksums and `build/chdman-native`'s bytes.
  - **CI parity (`REQUIRE_NATIVE=1`):** Without both `build/chdman-0.289` and a `build/chdman-native` newer than `engine/` and `wasm/`, byte-for-byte checks and `ui/engine.spec.js` skip unless `REQUIRE_NATIVE=1` (or `CHDMAN_ENGINE` for `ui/engine.spec.js`) is set, which fails fast instead of silently skipping.
- **macOS Apple Silicon caveats:** See root `AGENTS.md` (`build/chdman-0.289` Apple `libm` vs. `engine/libm` on `music-cd`, and Apple Clang ASan+UBSan without LSan).

## Fixtures & Bug Markers

- **Synthetic fixtures only (`tests/fixtures/`):**
  - Generated into `tests/.cache/fixtures/` by `make_fixtures.py` (requires `numpy`; `pythonBin()` in `tests/support/paths.js` and `npm run fixtures` auto-detect `.venv/bin/python3` before falling back to `python3`).
  - Never add real game dumps or copyrighted data to the repo.
  - `tests/support/global-setup.js` hashes `make_fixtures.py` + `discgen.py` into `generator.sha256` and regenerates fixtures (clearing cached native references) automatically when either changes, or when `REGEN_FIXTURES=1`.
  - `manifest.json` defines expected jobs, identification, output names (`out`), expected `quirks` rule ids, and console `note`s; `testdb.json` supplies synthetic CRC-32 database rows for `?testdb=1`.
- **Known unfixed bugs:** Pin with `test.fail(true, 'why')` in the relevant spec, or add to `ACCEPTED` in `tests/ui/a11y.spec.js`. Remove the marker as soon as the fix lands.
- **CI workflows:**
  - `.github/workflows/ci.yml`: `check-dist.sh`, `check-licenses.sh`, `engine-diff.sh --check`, full Playwright suite with `REQUIRE_NATIVE=1` on every PR and push to `main`.
  - `.github/workflows/sanitizers.yml`: `ui/engine.spec.js` with `CHDMAN_ENGINE=../build/chdman-san` and `CDPROBE_ENGINE=../build/cdprobe-san` (ASan + LSan + UBSan).
  - `.github/workflows/rebuild.yml`: clean Emscripten `6.0.10` rebuild verifying byte-identical `dist/discpress.html`.
