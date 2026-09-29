#!/usr/bin/env bash
# Checks that dist/discpress.html is exactly what app/ and db/ assemble to (with the WebAssembly taken
# from the page itself), so a release never ships a page that misses a change to app/ or db/.
# Usage: scripts/check-dist.sh [page]   (default dist/discpress.html)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PAGE=${1:-$ROOT/dist/discpress.html}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
out=$(python3 "$ROOT/scripts/extract-build.py" "$PAGE" "$tmp/build")
if ! grep -qx 'round trip: identical' <<<"$out"; then
  echo "$PAGE is not what app/ and db/ assemble to: run python3 scripts/assemble.py and commit it" >&2
  exit 1
fi
echo "$PAGE matches app/ and db/"
