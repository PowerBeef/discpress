---
name: discpress-engine-build
description: >-
  Guides modifying the forked MAME 0.289 chdman engine (engine/) or WebAssembly bridge (wasm/), checking output
  compatibility and licenses, refreshing engine/mame-0.289.diff, running native and sanitizer tests, and performing
  a reproducible Emscripten 6.0.10 rebuild of dist/discpress.html. Use whenever touching engine/, wasm/, or build.sh.
---

# Discpress Engine & WebAssembly Build Workflow

Use this workflow whenever modifying `engine/`, `wasm/`, or `build.sh`.

## Step 1: Pre-change contract & placement checks

1. Read `engine/AGENTS.md` and check `docs/chd/fork-plan.md` §3 if the change can alter CHD bytes or metadata:
   - **Tier R (default):** must remain byte-identical to unmodified MAME 0.289 (Linux glibc `libm`, MAME bundled codecs), across all thread counts and SIMD/non-SIMD builds.
   - **Tier C / Tier X:** must remain opt-in (with emulator warnings for Tier X).
2. Keep MAME files inside `engine/mame/` at their original paths (listed in `engine/FILES`). Put all new code outside `engine/mame/`.
3. Never add GPL/LGPL files or text to `engine/`; every `engine/mame/src/` file must carry `license:BSD-3-Clause` (`md5.h`: `license:Public Domain`).
4. Any new exported C function must be added to `EXPORTED_FUNCTIONS` in `wasm/link.sh`.
5. Never use `-flto` (breaks C++ exceptions under `-fwasm-exceptions`) or output-changing flags like `-ffast-math`.

## Step 2: Refresh diff & verify licenses

After editing files in `engine/mame/`:

```sh
./scripts/engine-diff.sh
./scripts/check-licenses.sh
```

## Step 3: Build & test natively (fast feedback)

1. Build native engine and verify upstream oracle exists:
   ```sh
   ./scripts/build-native.sh
   [ -x build/chdman-0.289 ] || ./scripts/build-upstream.sh
   ```
2. Spot-check CLI output directly against `build/chdman-0.289` on synthetic fixtures in `tests/.cache/fixtures/` (remembering that on macOS, `build/chdman-0.289` uses Apple's `libm`, which can differ from `engine/libm` on `music-cd`).
3. If `tests/node_modules` is installed, run the engine spec:
   ```sh
   (cd tests && REQUIRE_NATIVE=1 npx playwright test ui/engine.spec.js --project=desktop)
   ```
4. Build and test with sanitizers (`ASan` + `UBSan`), which produces both `build/chdman-san` and `build/cdprobe-san`:
   ```sh
   ./scripts/build-sanitized.sh
   ```
   - On Linux: run `ui/engine.spec.js --project=desktop` with `CHDMAN_ENGINE=../build/chdman-san CDPROBE_ENGINE=../build/cdprobe-san LSAN_OPTIONS=suppressions=$PWD/support/lsan.supp`.
   - On macOS `arm64`: run with `CHDMAN_ENGINE=../build/chdman-san CDPROBE_ENGINE=../build/cdprobe-san ASAN_OPTIONS=detect_leaks=0` (Apple Clang lacks LeakSanitizer; full LSan parity runs in `.github/workflows/sanitizers.yml`).

## Step 4: Reproducible WebAssembly rebuild (`dist/discpress.html`)

Because `scripts/engine-sources.py` hashes `build.sh`, `engine/`, and `wasm/` (excluding `*.md`, `engine/FILES`, `engine/mame-0.289.diff`), you **must** rebuild with pinned Emscripten `6.0.10` (`d6c521a7f05449857c76bd99e396895583cf2083`) and commit `dist/discpress.html`:

```sh
source ~/emsdk/emsdk_env.sh
./build.sh
```

(`build.sh` and `wasm/sources.mk` use relative Make paths, so checkouts with spaces in their path work natively, and `.build-stamp` cleans stale object directories automatically when compiler version or `EXTRA` changes.)

> Never ship a build made with `EMSCRIPTEN_ANY=1`: it omits `engine-sources.sha256` and fails `scripts/check-dist.sh`.

## Step 5: Final verification

```sh
./scripts/check-dist.sh
./scripts/check-licenses.sh
./scripts/engine-diff.sh --check
```

When pushed in a PR or to `main`, `.github/workflows/rebuild.yml` independently rebuilds with Emscripten `6.0.10` on Ubuntu and requires byte-identical `dist/discpress.html`.
