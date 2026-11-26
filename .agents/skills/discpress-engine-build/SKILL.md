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

Before editing, review `engine/AGENTS.md` (fork placement in `engine/mame/` vs. `wasm/`, permissive licensing, Tier R/C/X rules, `wasm/link.sh` `EXPORTED_FUNCTIONS`, and banned compiler flags `-flto`/`-ffast-math`) and check `docs/chd/fork-plan.md` §3 if the change can alter CHD output.

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
2. Spot-check CLI output directly against `build/chdman-0.289` on synthetic fixtures in `tests/.cache/fixtures/` (see root `AGENTS.md` for macOS Apple `libm` notes on `music-cd`).
3. If `tests/node_modules` is installed, run the engine spec:
   ```sh
   (cd tests && REQUIRE_NATIVE=1 npx playwright test ui/engine.spec.js --project=desktop)
   ```
4. Build and test with sanitizers (`ASan` + `UBSan`), which produces both `build/chdman-san` and `build/cdprobe-san`:
   ```sh
   ./scripts/build-sanitized.sh
   ```
   - On Linux (matches `.github/workflows/sanitizers.yml`):
     ```sh
     (cd tests && CHDMAN_ENGINE=../build/chdman-san CDPROBE_ENGINE=../build/cdprobe-san \
       ASAN_OPTIONS=detect_leaks=1:strict_string_checks=1:detect_stack_use_after_return=1 \
       LSAN_OPTIONS=suppressions=$PWD/support/lsan.supp \
       UBSAN_OPTIONS=print_stacktrace=1 \
       npx playwright test ui/engine.spec.js --project=desktop)
     ```
   - On macOS `arm64` (see root `AGENTS.md` for Apple Clang LSan note):
     ```sh
     (cd tests && CHDMAN_ENGINE=../build/chdman-san CDPROBE_ENGINE=../build/cdprobe-san \
       ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=print_stacktrace=1 \
       npx playwright test ui/engine.spec.js --project=desktop)
     ```

## Step 4: Reproducible WebAssembly rebuild (`dist/discpress.html`)

Any edit inside the `scripts/engine-sources.py` hash boundary (see `engine/AGENTS.md`) requires rebuilding with pinned Emscripten `6.0.10` and committing `dist/discpress.html`:

```sh
source ~/emsdk/emsdk_env.sh
./build.sh
```

> Never ship a build made with `EMSCRIPTEN_ANY=1`: it omits `engine-sources.sha256` and fails `scripts/check-dist.sh`.

## Step 5: Final verification

```sh
./scripts/check-dist.sh
./scripts/check-licenses.sh
./scripts/engine-diff.sh --check
```

When pushed in a PR or to `main`, `.github/workflows/rebuild.yml` independently rebuilds with Emscripten `6.0.10` on Ubuntu and requires byte-identical `dist/discpress.html`.
