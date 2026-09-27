#!/bin/bash
# Prepares a Claude Code on the web session for UI tests and benchmarks
# (see tests/README.md). Safe to run repeatedly; each step skips work already done.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

# Playwright Test + axe-core (Chromium itself is preinstalled in the image)
(cd tests && npm install --no-audit --no-fund)

# numpy for the synthetic disc generator
python3 -c 'import numpy' 2>/dev/null || pip install -q numpy

# WebAssembly build outputs recovered from dist/, so app/ changes can be re-assembled
[ -f build/chdman.wasm ] || python3 scripts/extract-build.py

# native chdman of the same version as the app, the reference for byte-for-byte checks;
# falls back to the distro's (older) chdman if MAME cannot be fetched or built
if [ ! -x build/chdman-native ]; then
  if ! scripts/build-native.sh; then
    echo "warning: could not build native chdman 0.289; installing mame-tools instead" >&2
    command -v chdman >/dev/null || { sudo -n apt-get install -y -q mame-tools || apt-get install -y -q mame-tools; } >/dev/null 2>&1 || true
  fi
fi

# small test fixtures (a few MB, about a second)
python3 tests/fixtures/make_fixtures.py
