#!/usr/bin/env bash
# Refresh the built-in game database from the latest libretro-database Redump DATs.
# Usage: scripts/update-db.sh   then rebuild (./build.sh, or scripts/assemble.py if the wasm is already built)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/third_party/libretro-database"
if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none --depth 1 --sparse https://github.com/libretro/libretro-database.git "$SRC"
  git -C "$SRC" sparse-checkout set metadat/redump
else
  git -C "$SRC" pull --ff-only
fi
python3 "$ROOT/db/mkdb.py" "$SRC" "$ROOT/db/db.json.gz"
