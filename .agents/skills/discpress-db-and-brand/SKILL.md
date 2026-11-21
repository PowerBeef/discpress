---
name: discpress-db-and-brand
description: >-
  Guides refreshing the built-in Redump game database (db/db.json.gz), editing hand-curated game facts
  (db/facts/*.tsv), and regenerating README app screenshots and brand graphics (docs/screenshots/, docs/brand/).
  Use when updating game recognition data, adding per-game facts, or refreshing README visuals after UI changes.
---

# Discpress Game Database, Facts & Brand Graphics

## Part A: Refreshing the Redump Database (`db/db.json.gz`)

1. Fetch latest `libretro-database` Redump DATs and rebuild `db/db.json.gz` (network step — run outside the sandbox):
   ```sh
   ./scripts/update-db.sh
   ```
   - `db/mkdb.py` outputs `{version, systems: {key: "name\tserial\tsize\tcrc\ttrack\text"}}` compressed with deterministic gzip (`mtime=0`, OS byte `3`).
   - Every system key in `db/mkdb.py` must match a key of `SYSTEMS` in `app/ident.js`.
2. Re-assemble `dist/discpress.html` and validate `db/facts/*.tsv` against the updated database:
   ```sh
   python3 scripts/extract-build.py --if-stale
   python3 scripts/assemble.py
   ./scripts/check-dist.sh
   ```
   If any serial listed in `db/facts/*.tsv` left the database, `scripts/assemble.py` fails immediately—fix or remove that line before committing.

## Part B: Editing Game Facts (`db/facts/*.tsv`)

See `db/facts/README.md`. Every non-comment line must have **5 tab-separated fields**:
`sys<TAB>serial<TAB>fact<TAB>value<TAB>source`

Validation rules enforced by `scripts/assemble.py`:
- `sys` exists in `db/db.json.gz`
- `canonKey(sys, serial)` exists in that system's database rows
- `fact` is registered in `FACTS` in `scripts/assemble.py` (currently `{'libcrypt'}`)
- `value` is `1`
- `source` is non-empty

**Licensing rule:** Only cite primary sources (the disc, packaging/manual, Redump disc page) or permissively usable lists built from them. **Never** copy from DuckStation's game database (CC BY-NC-ND); use GPL / CC BY-SA lists only as checklists to verify against primary sources.

## Part C: Regenerating README Screenshots & Brand Graphics

Both scripts in `scripts/brand/` use **Python Playwright** (`playwright.sync_api`) with Chromium (separate from `tests/package.json`), and `render.py` fetches Nunito / JetBrains Mono web fonts from Google Fonts (requires network access).

1. Ensure `dist/discpress.html` is freshly assembled and synthetic fixtures exist:
   ```sh
   .venv/bin/python3 tests/fixtures/make_fixtures.py
   ```
2. If the app UI changed, recapture `docs/screenshots/*.png` first:
   ```sh
   python3 scripts/brand/screenshots.py
   ```
3. Render `docs/brand/*.png` (light/dark desktop, mobile, divider, logo, `social-preview.png`) from `scripts/brand/brand.html`:
   ```sh
   python3 scripts/brand/render.py
   ```
4. Visually inspect the updated PNGs before committing.
