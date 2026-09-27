#!/usr/bin/env bash
# Fetch the exact MAME revision Discpress is built from (only the parts chdman
# needs) and apply the browser patch.
# Usage: scripts/fetch-mame.sh [destination]   (default: third_party/mame)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/third_party/mame}"
COMMIT=76c7d197ed46e844ffb1fbad5cc21c9ab3cdc9c0   # MAME 0.289
PATCH="$ROOT/wasm/mame.patch"

if [ ! -d "$DEST/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/mamedev/mame.git "$DEST"
fi
cd "$DEST"
git sparse-checkout set 3rdparty/aes256cbc 3rdparty/expat 3rdparty/flac 3rdparty/lzma \
  3rdparty/nanosvg 3rdparty/utf8proc 3rdparty/zlib 3rdparty/zstd src/lib/util src/osd src/tools
git checkout -q "$COMMIT"

if git apply --check "$PATCH" 2>/dev/null; then
  git apply "$PATCH"
  echo "MAME $COMMIT ready, patch applied: $DEST"
elif git apply -R --check "$PATCH" 2>/dev/null; then
  echo "MAME $COMMIT ready, patch already applied: $DEST"
else
  echo "Could not apply $PATCH (local changes in $DEST?)" >&2
  exit 1
fi
