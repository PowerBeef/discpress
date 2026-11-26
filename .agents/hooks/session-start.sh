#!/usr/bin/env bash
# Lightweight, read-only Antigravity SessionStart hook for Discpress.
# Runs synchronously (<100ms, zero network, zero mutations) and injects a compact
# environment readiness summary into the conversation.
set -euo pipefail

# Consume stdin payload (Antigravity sends camelCase JSON on stdin)
cat >/dev/null || true

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ready=()
missing=()

if [ -f "$ROOT/build/chdman.wasm" ] && [ -f "$ROOT/build/chdman-nosimd.wasm" ] && [ -f "$ROOT/build/chdman.js" ] && [ -f "$ROOT/build/engine-sources.sha256" ]; then
  ready+=("wasm-extracted")
else
  missing+=("build/wasm (scripts/extract-build.py --if-stale)")
fi

if [ -x "$ROOT/build/chdman-native" ]; then
  ready+=("chdman-native")
else
  missing+=("build/chdman-native")
fi

if [ -x "$ROOT/build/chdman-0.289" ]; then
  ready+=("chdman-0.289")
else
  missing+=("build/chdman-0.289")
fi

if [ -f "$ROOT/tests/.cache/fixtures/manifest.json" ]; then
  ready+=("fixtures")
else
  missing+=("fixtures")
fi

if diff --version 2>/dev/null | grep -qi 'GNU diffutils' || command -v gdiff >/dev/null 2>&1; then
  ready+=("gnu-diff")
else
  missing+=("gnu-diffutils")
fi

if command -v em++ >/dev/null 2>&1 || [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
  ready+=("emsdk")
else
  missing+=("emsdk-6.0.10")
fi

if [ -d "$ROOT/tests/node_modules/@playwright/test" ]; then
  ready+=("playwright-npm")
fi

# Emit valid Antigravity SessionStart JSON (camelCase, nested systemMessage object)
python3 -c '
import json, sys
sep = sys.argv.index("--")
ready, missing = sys.argv[1:sep], sys.argv[sep+1:]
msg = "Discpress workspace ready: [" + (", ".join(ready) or "none") + "]."
if missing:
    msg += " Missing: [" + ", ".join(missing) + "]. See discpress-env-setup skill if needed."
print(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]}))
' "${ready[@]+"${ready[@]}"}" -- "${missing[@]+"${missing[@]}"}"
