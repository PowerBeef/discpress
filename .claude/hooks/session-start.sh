#!/bin/bash
# Prepares a Claude Code on the web session for UI tests and benchmarks
# (see tests/README.md). Safe to run repeatedly; each step skips work already done.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

# Playwright Test + axe-core. Chromium is preinstalled in the image, in the build of one Playwright
# version: tests/package.json pins that version (tests/README.md), so say so if the two ever part
(cd tests && npm install --no-audit --no-fund)
(cd tests && node -e "import('@playwright/test').then(async ({ chromium }) => { await (await chromium.launch()).close(); })" 2>/dev/null) \
  || echo "warning: Playwright can't launch the image's Chromium, so the UI tests won't run: pin @playwright/test in tests/package.json to the version that ships the build in ${PLAYWRIGHT_BROWSERS_PATH:-~/.cache/ms-playwright} (tests/README.md)" >&2

# numpy for the synthetic disc generator
python3 -c 'import numpy' 2>/dev/null || pip install -q numpy

# WebAssembly build outputs recovered from dist/, so app/ changes can be re-assembled
python3 scripts/extract-build.py --if-stale

# unmodified chdman 0.289 built from the MAME release (needs to fetch MAME): the reference for
# byte-for-byte checks
[ -x build/chdman-0.289 ] || scripts/build-upstream.sh || echo "warning: could not build upstream chdman 0.289" >&2
# the engine built natively (no download): the fallback reference, and tests/ui/engine.spec.js, which
# skips when it is older than engine/ (make rebuilds only what changed)
scripts/build-native.sh || echo "warning: could not build the engine natively" >&2
# neither: the distro's (older) chdman
if [ ! -x build/chdman-0.289 ] && [ ! -x build/chdman-native ]; then
  command -v chdman >/dev/null || { sudo -n apt-get install -y -q mame-tools || apt-get install -y -q mame-tools; } >/dev/null 2>&1 || true
fi

# small test fixtures (a few MB, about a second)
python3 tests/fixtures/make_fixtures.py
