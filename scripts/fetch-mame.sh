#!/usr/bin/env bash
# Fetch the MAME release the engine (engine/mame) was forked from, unmodified: the upstream
# side of engine/mame-0.289.diff (scripts/engine-diff.sh) and the source of the reference
# chdman the tests prefer (scripts/build-upstream.sh). Building Discpress doesn't need it.
# Usage: scripts/fetch-mame.sh [destination]   (default: third_party/mame)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/third_party/mame}"
COMMIT=f34f02505e32c1993c6a782b6814232cbfc74e36   # MAME 0.289 (release tag mame0289)

fresh=
if [ ! -d "$DEST/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/mamedev/mame.git "$DEST"
  fresh=1
fi
cd "$DEST"
# (a fresh --no-checkout clone has nothing checked out, which git status shows as every file deleted)
if [ -z "$fresh" ] && [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  echo "$DEST has local changes (from an older Discpress, the browser patch?)." >&2
  echo "It must stay unmodified; discard them with: git -C \"$DEST\" checkout -- ." >&2
  exit 1
fi
git sparse-checkout set 3rdparty/flac 3rdparty/lzma 3rdparty/utf8proc 3rdparty/zlib 3rdparty/zstd \
  src/lib/util src/osd src/tools
git checkout -q "$COMMIT"
echo "MAME $COMMIT (0.289) ready: $DEST"
