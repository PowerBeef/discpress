#!/usr/bin/env bash
# Checks that only permissively licensed code is in engine/ and wasm/ (THIRD_PARTY_NOTICES.md):
# MAME as a whole is GPL-2.0-or-later, but each of its files says its own license in its first
# lines, and every file under engine/mame/src must say BSD-3-Clause, except the public-domain
# md5.h. No file anywhere in engine/ or wasm/ (including vendored browser decoders such as
# stb_vorbis.c and minimp3*.h) may carry GPL, LGPL, AGPL, or CC-BY-NC headers or license text.
# The libraries MAME bundles (engine/mame/3rdparty: zlib, the LZMA SDK, FLAC, Zstandard) keep
# their own permissive license files, and the other libraries in engine/ keep their MIT ones
# (engine/libdeflate/COPYING, engine/libm/LICENSE). CI runs this on every push to main and PR.
set -euo pipefail
cd "$(dirname "$0")/.."

bad=0
# Verify no unexpected top-level entries entered engine/
for entry in engine/*; do
  base="${entry#engine/}"
  case "$base" in
    mame|libdeflate|libm|FILES|mame-0.289.diff|README.md|AGENTS.md) ;;
    *) echo "unexpected entry in engine/: $entry" >&2; bad=1 ;;
  esac
done

while IFS= read -r f; do
  # files that may carry another permissive license than BSD-3-Clause, with the license they must say
  case "$f" in
    engine/mame/src/lib/util/md5.h) want="license:Public Domain" ;;
    *) want="license:BSD-3-Clause" ;;
  esac
  if ! head -n 3 "$f" | grep -qF "$want"; then
    echo "$f: its first lines don't say \"$want\"" >&2
    bad=1
  fi
done < <(git ls-files --cached --others --exclude-standard engine/mame/src)

if git grep --untracked -nIi -e 'license:A\?L\?GPL' -e 'license:CC-BY-NC' -- engine wasm >&2; then
  echo "GPL/LGPL/AGPL/CC-BY-NC-licensed MAME files are in engine/ or wasm/ (above)" >&2
  bad=1
fi
if git grep --untracked -nIi -e 'GNU General Public' -e 'GNU Lesser General' -e 'GNU Affero General' -e 'SPDX-License-Identifier: *A\?L\?GPL' -e 'SPDX-License-Identifier: *CC-BY-NC' -- engine wasm >&2; then
  echo "GPL-, LGPL-, AGPL-, or CC-BY-NC-licensed code is in engine/ or wasm/ (above)" >&2
  bad=1
fi
for f in engine/libdeflate/COPYING engine/libm/LICENSE; do
  if ! grep -qF 'Permission is hereby granted, free of charge' "$f"; then
    echo "$f: not the MIT license" >&2
    bad=1
  fi
done

# MAME's bundled libraries: each with its license file, saying the license engine/README.md names
while IFS='|' read -r f words; do
  if ! grep -qiF "$words" "$f" 2>/dev/null; then
    echo "$f: missing, or not the license engine/README.md names (\"$words\")" >&2
    bad=1
  fi
done <<'LICENSES'
engine/mame/3rdparty/zlib/LICENSE|freely, subject to the following restrictions
engine/mame/3rdparty/lzma/DOC/lzma-sdk.txt|public domain
engine/mame/3rdparty/flac/COPYING.Xiph|Redistribution and use in source and binary forms
engine/mame/3rdparty/zstd/LICENSE|Redistribution and use in source and binary forms
LICENSES

[ "$bad" = 0 ] || exit 1
echo "engine/ & wasm/: $(git ls-files engine/mame/src | wc -l) MAME files, all BSD-3-Clause (md5.h public domain); zlib, LZMA SDK, FLAC and Zstandard with their license files; libdeflate and libm MIT; wasm/ clean of GPL/LGPL/AGPL/CC-BY-NC"
