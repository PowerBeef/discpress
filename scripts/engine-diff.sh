#!/usr/bin/env bash
# Write engine/mame-0.289.diff: every change engine/mame makes to the MAME 0.289 files it was
# forked from (listed in engine/FILES). Help > About shows it; run this after changing engine/mame.
# --check only reports whether the committed diff is up to date (exit 1 if not).
# Needs the upstream source (fetched with scripts/fetch-mame.sh if missing).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UP="$(cd "${MAME_DIR:-$ROOT/third_party/mame}" 2>/dev/null && pwd)" || UP=""
[ -n "$UP" ] && [ -f "$UP/src/tools/chdman.cpp" ] || { "$ROOT/scripts/fetch-mame.sh"; UP="$ROOT/third_party/mame"; }
OUT="$ROOT/engine/mame-0.289.diff"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cd "$ROOT/engine/mame"
while read -r f; do
  [ -f "$f" ] || { echo "engine/FILES lists $f, which is not in engine/mame" >&2; exit 1; }
  s=0; diff -u --label "a/$f" --label "b/$f" "$UP/$f" "$f" >> "$TMP" || s=$?
  [ "$s" -le 1 ] || exit "$s"
done < "$ROOT/engine/FILES"
extra="$(LC_ALL=C comm -13 "$ROOT/engine/FILES" <(find . -type f | sed 's|^\./||' | LC_ALL=C sort))"
[ -z "$extra" ] || { echo "not in engine/FILES (add upstream files there; new code goes outside engine/mame):" >&2; echo "$extra" >&2; exit 1; }

if [ "${1:-}" = "--check" ]; then
  cmp -s "$TMP" "$OUT" && { echo "engine/mame-0.289.diff is up to date"; exit 0; }
  echo "engine/mame-0.289.diff is out of date: run scripts/engine-diff.sh" >&2
  exit 1
fi
cp "$TMP" "$OUT"
echo "$OUT: $(grep -c '^+++ ' "$OUT") files changed"
