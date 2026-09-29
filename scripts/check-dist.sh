#!/usr/bin/env bash
# Checks that dist/discpress.html is exactly what the sources make, so a release never ships a page
# that misses a change:
#   - its WebAssembly was built from the current engine/ and wasm/ sources (and build.sh): the page
#     records their hash (scripts/engine-sources.py) when ./build.sh assembles it;
#   - it is what app/ and db/ assemble to, with the WebAssembly taken from the page itself;
#   - engine/mame-0.289.diff, shown in Help, is up to date (scripts/engine-diff.sh --check), when
#     unmodified MAME 0.289 is at hand (scripts/fetch-mame.sh); skipped otherwise, as in the Release
#     workflow.
# Usage: scripts/check-dist.sh [page]   (default dist/discpress.html)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PAGE=${1:-$ROOT/dist/discpress.html}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
out=$(python3 "$ROOT/scripts/extract-build.py" "$PAGE" "$tmp/build")
if [ ! -f "$tmp/build/engine-sources.sha256" ]; then
  echo "$PAGE doesn't record the engine and wasm sources its wasm was built from: run ./build.sh (Emscripten) and commit dist/discpress.html" >&2
  exit 1
fi
if [ "$(cat "$tmp/build/engine-sources.sha256")" != "$(python3 "$ROOT/scripts/engine-sources.py")" ]; then
  echo "$PAGE: the engine or wasm sources changed since the page's wasm was built: run ./build.sh (Emscripten) and commit dist/discpress.html" >&2
  exit 1
fi
if ! grep -qx 'round trip: identical' <<<"$out"; then
  echo "$PAGE is not what app/ and db/ assemble to: run python3 scripts/assemble.py and commit it" >&2
  exit 1
fi
echo "$PAGE matches app/, db/ and the engine and wasm sources"
if [ -f "${MAME_DIR:-$ROOT/third_party/mame}/src/tools/chdman.cpp" ]; then
  "$ROOT/scripts/engine-diff.sh" --check
else
  echo "engine/mame-0.289.diff not checked: no unmodified MAME 0.289 here (scripts/fetch-mame.sh fetches it)"
fi
