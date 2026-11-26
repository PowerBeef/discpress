---
name: discpress-env-setup
description: >-
  Audits and bootstraps the local Discpress development environment on macOS or Linux for Antigravity sessions
  (extracting wasm build outputs, setting up Python venv with numpy, generating synthetic fixtures, building native
  and upstream chdman binaries, installing Emscripten 6.0.10, and configuring browser testing). Use when starting
  on a fresh clone, diagnosing missing build/test prerequisites, or verifying local toolchain readiness.
---

# Discpress Environment Setup & Diagnostics

Replaces the legacy cloud-container startup script with an explicit, local-first setup workflow. See root `AGENTS.md` for macOS environment caveats (paths with spaces, Apple `libm`, GNU `diffutils`, Apple Silicon sanitizers, sandbox boundary).

## Step 1: Audit current readiness

Run the bundled read-only diagnostic script from the repository root:

```sh
./.agents/skills/discpress-env-setup/scripts/check-env.sh
```

It checks:
- Extracted WebAssembly outputs and freshness (`build/chdman.js`, `build/chdman.wasm`, `build/chdman-nosimd.wasm`, and `build/engine-sources.sha256` matching `scripts/engine-sources.py`)
- Native engine binary (`build/chdman-native`, including staleness against `engine/` and `wasm/`)
- Upstream MAME 0.289 reference (`third_party/mame`, `build/chdman-0.289`)
- GNU `diffutils` (`diff` / `gdiff`, required by `scripts/engine-diff.sh`)
- Python `numpy` (`.venv/bin/python3` or system `python3`) and synthetic fixtures (`tests/.cache/fixtures/manifest.json` + `generator.sha256` freshness)
- Emscripten `6.0.10` (`em++` pinned commit on `PATH`, or `~/emsdk`)
- Optional Playwright Test installation (`tests/node_modules`)

## Step 2: Bootstrap missing components

Run only what is missing. Network commands require running outside the terminal sandbox; keep local build and assembly commands inside the sandbox.

1. **Recover WebAssembly outputs from `dist/discpress.html`** (no Emscripten needed):
   ```sh
   python3 scripts/extract-build.py --if-stale
   ```
2. **Python virtual environment + `numpy` + synthetic fixtures:**
   ```sh
   python3 -m venv .venv
   .venv/bin/pip install numpy
   .venv/bin/python3 tests/fixtures/make_fixtures.py
   ```
3. **Native engine build (`build/chdman-native`):**
   ```sh
   ./scripts/build-native.sh
   ```
4. **Upstream MAME 0.289 checkout, GNU `diffutils` (macOS) & oracle (`build/chdman-0.289`):**
   ```sh
   brew install diffutils   # macOS only: provides GNU diff / gdiff so engine-diff.sh matches CI's GNU diff
   ./scripts/fetch-mame.sh
   ./scripts/build-upstream.sh
   ./scripts/engine-diff.sh --check
   ```
5. **Emscripten `6.0.10`** (required only when editing `engine/`, `wasm/`, or `build.sh`; see `engine/AGENTS.md` for pin details):
   ```sh
   git clone --depth 1 https://github.com/emscripten-core/emsdk.git ~/emsdk
   ~/emsdk/emsdk install 6.0.10
   ~/emsdk/emsdk activate 6.0.10
   ```
   Verify exact pinned version (`6.0.10` / `d6c521a7f05449857c76bd99e396895583cf2083`):
   ```sh
   source ~/emsdk/emsdk_env.sh && em++ --version | head -1
   ```
6. **Browser testing choice:**
   - **Interactive Antigravity preview (default, no Playwright Chromium needed):** start `node tests/support/server.js 4173` and delegate opening `http://127.0.0.1:4173` to the `browser` subagent.
   - **Automated Playwright suite (optional, matches CI):** in `tests/`, run `npm ci --no-audit --no-fund` (sufficient on its own for non-browser `ui/engine.spec.js` and `ui/facts.spec.js`) and `npx playwright install chromium` if running the full 25-spec suite locally.

## Step 3: Validate setup

```sh
./scripts/check-dist.sh
./scripts/check-licenses.sh
./.agents/skills/discpress-env-setup/scripts/check-env.sh
```
