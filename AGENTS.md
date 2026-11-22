# Discpress Development Rules (`AGENTS.md`)

## What this project is

Discpress is MAME 0.289's `chdman` compiled to WebAssembly and shipped as **one self-contained, offline HTML file** (`dist/discpress.html`) that converts game disc images to/from CHD in the browser, on phones and desktops. It identifies the console and game and names outputs from a built-in Redump database.

Each release ships that one file twice, byte for byte: as the GitHub Release download (the **offline build**) and as `index.html` on GitHub Pages (the **online build**, for users who don't want to download it and for big games on iPhone and iPad). The app has no server, no bundler, and no runtime npm dependencies; `tests/` (Playwright, see `tests/README.md`) is the only tooling with a `package.json`. There is no linter.

## Architecture & Context Map

- **Directory-scoped rules** (loaded automatically when working in each area):
  - `app/AGENTS.md`: single-file assembly rules, `ui.js` / `ident.js` / `quirks.js` / `worker.js` runtime architecture, iOS/WebKit workarounds, and `chdman-web-debug` flags.
  - `engine/AGENTS.md`: MAME 0.289 fork rules, BSD-3-Clause licensing, C++20 coroutines & helper workers, `engine/libm`, compiler flag restrictions, and Emscripten `6.0.10` reproducibility.
  - `tests/AGENTS.md`: dev-page workflow, interactive browser preview vs. automated Playwright suite, native chdman oracles, synthetic fixtures, and macOS testing caveats.
- **On-demand project skills** (`.agents/skills/`):
  - `discpress-env-setup`: local macOS/Antigravity toolchain audit and bootstrap.
  - `discpress-app-dev`: editing `app/` or `db/`, dev-page preview, testing, benchmarks, and assembly.
  - `discpress-engine-build`: modifying `engine/` or `wasm/`, diff/license/sanitizer checks, and reproducible `./build.sh`.
  - `discpress-release`: pre-flight checks and the 5-stage atomic offline+online release workflow.
  - `discpress-db-and-brand`: refreshing `db/db.json.gz`, maintaining `db/facts/*.tsv`, and rendering README screenshots/brand graphics.
- **Research & design docs**:
  - `docs/chd/README.md` and `docs/chd/fork-plan.md`: CHD format, chdman internals, emulator compatibility contract (Tier R/C/X), measurements, and roadmap. **Check any change that alters CHD output against the compatibility contract first.**
  - `docs/ios/README.md`: iPhone/iPad limits (saving large results, memory, WebKit OMG bugs, iOS 26 edge blur, backgrounding, storage).
  - `web/README.md`: online version service worker, manifest, and icons.

## Non-Negotiable Invariants

1. **Zero network & offline guarantee.** `app/index.html`'s CSP enforces `connect-src 'none'`. Nothing in the app may make network requests, and tests fail on any console error or unexpected network request.
2. **Single-file assembly safety.** App JS is plain ES5-style browser script (`var`/functions, no ES modules/imports). No inlined script may contain `</script`, `<!--`, or `<script`, and `app/style.css` may not contain `</style` (`scripts/assemble.py` asserts this).
3. **Byte-identical default output (Tier R).** For default settings, the app's CHDs must match unmodified MAME 0.289 `chdman` (as built on Linux with MAME's bundled codecs and glibc `libm`) byte for byte, across all thread counts and SIMD/non-SIMD builds. Never pull engine code from MAME `master` (post-0.289 lowered LZMA level 8 → 6 and broke Dreamcast GD-ROM layout).
4. **Reproducible committed artifact (`dist/discpress.html`).** Always regenerate and commit `dist/discpress.html` whenever `app/`, `db/`, `engine/`, `wasm/`, or `build.sh` change:
   - After `app/` or `db/` changes only: `python3 scripts/assemble.py` (after `python3 scripts/extract-build.py --if-stale` if `build/` has no wasm yet).
   - After `engine/`, `wasm/`, or `build.sh` changes: **only `./build.sh` with pinned Emscripten `6.0.10`** (`d6c521a7f...`) updates `build/engine-sources.sha256` so `scripts/check-dist.sh` and CI pass.
   - **Watch the hash boundary:** `scripts/engine-sources.py` hashes `build.sh`, `engine/`, and `wasm/` (excluding `*.md`, `engine/FILES`, and `engine/mame-0.289.diff`). Do not edit `build.sh` or `wasm/*` casually without doing a full Emscripten `6.0.10` rebuild.
5. **Permissive licensing only in `engine/`.** Every file under `engine/mame/src` must be BSD-3-Clause (`md5.h` public domain); no GPL/LGPL code or text may enter `engine/`. Keep `engine/mame-0.289.diff` synced via `./scripts/engine-diff.sh` and verify with `./scripts/check-licenses.sh`.
6. **No real game data.** All test fixtures in `tests/fixtures/` are synthetic (`make_fixtures.py`). Never commit copyrighted game dumps, BIOS files, or restricted databases (e.g., DuckStation CC BY-NC-ND or GPL game lists).
7. **Atomic dual-build releases & explicit approval.** Never update the GitHub Release asset or GitHub Pages independently; only `.github/workflows/release.yml` publishes them together. **Merging to `main`, tagging, and triggering releases always require explicit user confirmation.**
8. **Bisectable, self-contained commits with rationale.** Every commit must include a non-empty multi-line body explaining *why* and *what* changed (never subject-only commits), keep one logical feature, format, or bugfix per commit (no omnibus commits bundling unrelated format families), and leave `dist/discpress.html` freshly assembled so `./scripts/check-dist.sh` passes on *every* commit that touches `app/`, `db/`, `engine/`, `wasm/`, or `build.sh`.

## Quick Commands

```sh
# 1. App/DB-only iteration (no Emscripten needed)
python3 scripts/extract-build.py --if-stale                      # recover build/chdman.{js,wasm} + hash from dist/
python3 scripts/assemble.py build/discpress-dev.html             # fast dev build (<1 s)
python3 scripts/assemble.py                                      # update committed dist/discpress.html
./scripts/check-dist.sh                                          # verify dist/ matches app/, db/ and engine sources

# 2. Native engine & upstream reference (C++20 + make)
./scripts/build-native.sh                                        # -> build/chdman-native (engine/)
./scripts/build-upstream.sh                                      # -> build/chdman-0.289 (fetches MAME 0.289)
./scripts/engine-diff.sh --check                                 # verify engine/mame-0.289.diff (omit --check to refresh)
./scripts/check-licenses.sh                                      # verify permissive licenses in engine/
./scripts/build-sanitized.sh                                     # -> build/chdman-san + build/cdprobe-san (ASan + UBSan)

# 3. Full WebAssembly rebuild (after changing engine/, wasm/, or build.sh)
source ~/emsdk/emsdk_env.sh
./build.sh                                                       # requires Emscripten 6.0.10

# 4. Synthetic test fixtures (uses repo-local .venv if numpy is not global)
.venv/bin/python3 tests/fixtures/make_fixtures.py                # or python3 if numpy is installed globally

# 5. Interactive local preview (for Antigravity embedded browser)
node tests/support/server.js 4173                                # serves dist/discpress.html (or set DISCPRESS_HTML=build/discpress-dev.html)

# 6. Automated Playwright suite & benchmarks (in tests/, when installed)
npm run test:dev                                                 # full UI suite on build/discpress-dev.html
REQUIRE_NATIVE=1 npm test                                        # CI-parity run on dist/discpress.html
npx playwright test ui/convert.spec.js -g ps2 --project=desktop  # single test
npm run bench:dev -- --compare latest                            # benchmark comparison

# 7. Database, release verification & README brand graphics
./scripts/update-db.sh                                           # refresh db/db.json.gz from libretro-database
./scripts/check-release.sh                                       # verify latest release download == GitHub Pages
python3 scripts/brand/screenshots.py && python3 scripts/brand/render.py
```

## Local macOS & Antigravity Environment Notes

- **Workspace path with spaces (`build.sh`):** GNU Make splits paths containing spaces, so `build.sh`, `wasm/sources.mk`, and `scripts/build-{native,upstream,sanitized}.sh` all pass relative paths to GNU Make (`M=../engine/mame`, `O=../build/...`). Do not reintroduce `$(abspath ...)` or absolute paths into Make variables so checkouts with spaces (e.g., `Coding projects/Discpress`) continue to build natively.
- **Python venv (`.venv/`):** macOS Homebrew Python is externally managed; `numpy` for `tests/fixtures/make_fixtures.py` lives in `.venv/` (gitignored).
- **Antigravity embedded browser vs. Playwright:** For interactive UI previews, visual inspection, and manual verification of `dist/discpress.html` or `build/discpress-dev.html`, start `node tests/support/server.js 4173` and delegate opening `http://127.0.0.1:4173` to Antigravity's `browser` subagent. The 25 automated `.spec.js` suites in `tests/ui/` and `tests/bench/bench.js` (and GitHub Actions CI) still use `@playwright/test`.
- **macOS `libm`, GNU `diffutils` & sanitizer nuances:** On macOS, `build/chdman-0.289` links Apple's `libm` (which can differ from Linux glibc / `engine/libm` on `music-cd`), whereas `build/chdman-native` uses `engine/libm` and matches WASM byte for byte. `scripts/engine-diff.sh` (and `check-dist.sh` once `third_party/mame` exists) requires GNU `diffutils` (`gdiff`, via `brew install diffutils`) because Apple's BSD `diff` emits different hunk alignment than CI's Ubuntu `diff`. On Apple Silicon, Apple Clang supports ASan and UBSan (`ASAN_OPTIONS=detect_leaks=0`), while LeakSanitizer runs in CI (`.github/workflows/sanitizers.yml`).
- **Sandbox boundary:** Local builds, assembly, fixtures, and checks run inside the sandbox. Network operations (`fetch-mame.sh`, `update-db.sh`, `check-release.sh`, `gh`, `git push/fetch`, `emsdk`, `pip`/`npm` installs, `brand/render.py` Google Fonts) require running outside the sandbox as isolated single commands.
