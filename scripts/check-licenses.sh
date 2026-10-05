#!/usr/bin/env bash
# Checks that only permissively licensed MAME code is in engine/ (THIRD_PARTY_NOTICES.md): MAME as a
# whole is GPL-2.0-or-later, but each of its files says its own license in its first lines, and every
# file under engine/mame/src must say BSD-3-Clause, except the public-domain md5.h. No file anywhere in
# engine/ may carry MAME's GPL header or the GPL's or LGPL's text. The other libraries there keep their
# MIT license files (engine/libdeflate/COPYING, engine/libm/LICENSE). CI runs it on every push and pull
# request.
set -euo pipefail
cd "$(dirname "$0")/.."
# files that may carry another permissive license than BSD-3-Clause, with the license they must say
declare -A EXCEPT=(["engine/mame/src/lib/util/md5.h"]="license:Public Domain")

bad=0
while IFS= read -r f; do
  want="license:BSD-3-Clause"
  [ -n "${EXCEPT[$f]:-}" ] && want="${EXCEPT[$f]}"
  if ! head -n 3 "$f" | grep -qF "$want"; then
    echo "$f: its first lines don't say \"$want\"" >&2
    bad=1
  fi
done < <(git ls-files engine/mame/src)

if git grep -nI -e 'license:GPL' -e 'license:LGPL' -- engine >&2; then
  echo "GPL-licensed MAME files are in engine/ (above)" >&2
  bad=1
fi
if git grep -nI -e 'GNU General Public' -e 'GNU Lesser General' -e 'SPDX-License-Identifier: *L\?GPL' -- engine >&2; then
  echo "GPL- or LGPL-licensed code is in engine/ (above)" >&2
  bad=1
fi
for f in engine/libdeflate/COPYING engine/libm/LICENSE; do
  if ! grep -qF 'Permission is hereby granted, free of charge' "$f"; then
    echo "$f: not the MIT license" >&2
    bad=1
  fi
done

[ "$bad" = 0 ] || exit 1
echo "engine/: $(git ls-files engine/mame/src | wc -l) MAME files, all BSD-3-Clause (md5.h public domain); libdeflate and libm MIT"
