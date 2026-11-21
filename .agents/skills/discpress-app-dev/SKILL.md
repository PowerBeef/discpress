---
name: discpress-app-dev
description: >-
  Guides editing, previewing, testing, benchmarking, and assembling changes to app/ or db/ in Discpress without
  requiring Emscripten. Use when modifying the UI, CSS, game identification, quirks, worker storage backends,
  help text, or game facts, and before committing dist/discpress.html.
---

# Discpress App & UI Development Workflow

Use this workflow whenever changes are confined to `app/` or `db/` (no `engine/`, `wasm/`, or `build.sh` edits).

## Step 1: Check constraints before editing

Review `app/AGENTS.md` for critical constraints:
- Plain ES5-style browser JS (`var`/functions, no modules/imports).
- Never include `</script`, `<!--`, or `<script` in inlined JS, or `</style` in `app/style.css`.
- Preserve `app/worker.js`'s `/* chdman web worker:` header comment.
- Keep CSP `connect-src 'none'` intact (zero network requests).
- Preserve `mode-shell` sticky solid header (no `backdrop-filter`) for iOS 26 compatibility.

## Step 2: Assemble a fast dev page (< 1 s)

Recover the committed WebAssembly outputs if needed and assemble `build/discpress-dev.html`:

```sh
python3 scripts/extract-build.py --if-stale
python3 scripts/assemble.py build/discpress-dev.html
```

(`npm run dev-page` inside `tests/` runs the exact same two commands.)

## Step 3: Verify interactively or via Playwright

### Option A: Interactive preview with Antigravity's embedded browser

1. Start the local test server as a background daemon pointing at the dev page:
   ```sh
   DISCPRESS_HTML=build/discpress-dev.html node tests/support/server.js 4173
   ```
2. Delegate opening `http://127.0.0.1:4173` (or `http://127.0.0.1:4173/discpress.html?testdb=1` to merge `testdb.json` synthetic CRC rows) to the `browser` subagent.
3. Verify no console errors, no network requests, both light and dark themes, and mobile/desktop layouts. Useful `localStorage['chdman-web-debug']` flags (see `app/AGENTS.md`): `stage`, `failHelpers`, `failStorage`, `hosted`, `shareMax`, `sinkMax`.
4. Stop the background server when done (`manage_task` `kill`).

### Option B: Automated Playwright suite & benchmarks (when installed in `tests/`)

Run from `tests/`:
```sh
npm run test:dev                                                    # full suite on build/discpress-dev.html
npx playwright test ui/convert.spec.js -g ps2 --project=desktop     # targeted spec
npx playwright test ui/layout.spec.js --project=layout              # writes screenshots to tests/.cache/screens/
npx playwright test ui/a11y.spec.js --project=desktop               # axe-core audit
npm run bench:dev -- --quick --compare latest                       # performance check
```

If reviewing visual changes from `layout.spec.js`, inspect `tests/.cache/screens/<size>/<theme>-<screen>.png`.

## Step 4: Regenerate and verify `dist/discpress.html`

Once satisfied, update the committed release artifact and verify round-trip integrity:

```sh
python3 scripts/assemble.py
./scripts/check-dist.sh
```

`dist/discpress.html` must always be committed alongside the `app/` or `db/` changes.
