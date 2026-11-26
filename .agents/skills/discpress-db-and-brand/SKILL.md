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
   - `db/mkdb.py` outputs `{version, systems: {key: tsv_rows}}` with 6 core tab-separated fields (`name\tserial\tsize\tcrc\ttrack\text`), plus 2 optional multi-track fields (`ntrk\tdigest`, for full-disc `discDigest` matching) when invoked with `--redump-xml <dir>`, compressed with deterministic gzip (`mtime=0`, OS byte `3`).
   - `scripts/assemble.py` (`encode_gamedb_bin`) compiles `db/db.json.gz` into the compact columnar binary format `DPDB\x02` before gzip+base64 embedding into `dist/discpress.html`.
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
- `fact` is registered in `FACTS` in `scripts/assemble.py` (currently `{'libcrypt', 'sat_rom_cart', 'sat_mpeg_card', 'sat_ram_4m', 'sat_ram_1m'}` across `db/facts/libcrypt.tsv` and `db/facts/saturn-cart.tsv`)
- `value` is `1`
- `source` is non-empty

**Licensing rule:** Only cite primary sources (the disc, packaging/manual, Redump disc page) or permissively usable lists built from them. **Never** copy from DuckStation's game database (CC BY-NC-ND); use GPL / CC BY-SA lists only as checklists to verify against primary sources.

## Part C: Regenerating README Screenshots & Brand Graphics

Both scripts in `scripts/brand/` use **Python Playwright** (`playwright.sync_api`) with Chromium (separate from `tests/package.json`), and `render.py` fetches Nunito / JetBrains Mono web fonts from Google Fonts (requires network access). Use whichever Python environment has `playwright` installed (`.venv/bin/python3` on macOS where Homebrew Python is externally managed, or system `python3`).

1. Ensure `dist/discpress.html` is freshly assembled and synthetic fixtures exist:
   ```sh
   .venv/bin/python3 tests/fixtures/make_fixtures.py
   ```
2. If the app UI changed, recapture `docs/screenshots/*.png` first:
   ```sh
   .venv/bin/python3 scripts/brand/screenshots.py
   ```
3. Render all 33 `docs/brand/*.png` graphics (9 scenes in light/dark + 6 mobile light/dark + `divider.png`, `logo.png`, `social-preview.png`) from `scripts/brand/brand.html`:
   ```sh
   .venv/bin/python3 scripts/brand/render.py
   ```
4. Visually inspect the updated PNGs before committing.
