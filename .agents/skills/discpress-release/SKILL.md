---
name: discpress-release
description: >-
  Guides preparing, executing, and verifying a Discpress release so the offline GitHub Release download and online
  GitHub Pages site ship byte-identically together via .github/workflows/release.yml. Use when preparing release
  notes, running pre-release checks, triggering a release, or verifying a published release.
---

# Discpress Release & Verification Workflow

Every Discpress release ships `dist/discpress.html` twice, **byte for byte**:
1. **Offline build:** `discpress.html` (plus `discpress.html.sha256`) attached to the GitHub Release (`releases/latest/download/discpress.html`).
2. **Online build:** `index.html` (plus `discpress.html.sha256` and `web/sw.js`, `web/manifest.webmanifest`, `web/*.png` copied flat into `_site/`) deployed to GitHub Pages (`https://powerbeef.github.io/discpress/`).

**Hard rules:**
- **Never** upload release assets by hand or deploy Pages outside `.github/workflows/release.yml`.
- **Always** get explicit user approval before merging to `main`, tagging, or triggering the release workflow.
- Tags must strictly match `vX.Y.Z` (no prereleases such as `v1.4.0-rc1`; `prepare` refuses them because every release becomes latest and goes online).

## Step 1: Pre-flight checks on `main`

1. Verify root `VERSION` matches `X.Y.Z` (without leading `v`). If bumping `VERSION`, re-assemble `dist/discpress.html` (`python3 scripts/extract-build.py --if-stale && python3 scripts/assemble.py`) and commit both `VERSION` and `dist/discpress.html` on `main` before releasing.
2. Verify local artifacts and repo hygiene:
   ```sh
   ./scripts/check-dist.sh
   ./scripts/check-licenses.sh
   ./scripts/engine-diff.sh --check
   ```
3. Optional release notes: if `.github/release-notes/<tag>.md` exists on `main`, `release.yml` uses it (and overwrites existing notes on re-run); otherwise GitHub auto-generates notes. Remind offline users to download `discpress.html` again (the offline file's CSP forbids update checks, while the online build's network-first service worker updates automatically on the next visit).
4. Confirm `.github/workflows/ci.yml` has **passed** on the exact commit on `main` to be released (`prepare` refuses commits without a passing CI run on `main`).

## Step 2: Confirm & trigger `.github/workflows/release.yml`

After explicit user go-ahead, trigger the workflow on `main` (either via GitHub UI **Actions → Release → Run workflow** on `main` with tag `vX.Y.Z`, or via `gh` outside the sandbox):

```sh
gh workflow run release.yml --ref main -f tag=vX.Y.Z
```

*(Note: a pushed `v*` tag or manually published release forwards itself to `workflow_dispatch` on `main`, the only branch allowed to deploy to `github-pages`.)*

### How the 5-job atomic pipeline works

1. **`prepare`:** Validates `vX.Y.Z` format, picks the tag's commit (or existing draft's commit, or `main` HEAD), verifies it is an ancestor of `main` with a green `ci.yml` run, runs `scripts/check-dist.sh`, and packs `download` (`discpress.html` + `.sha256`) and `_site` (`index.html` + `.sha256` + flat `web/sw.js`, `web/manifest.webmanifest`, `web/*.png`).
2. **`release`:** Creates a **draft** release (or updates an existing release's notes/asset, clobbering the download only if its SHA-256 differs).
3. **`pages`:** Deploys to GitHub Pages **only** if `scripts/newest-release.sh` confirms this tag is still the newest version (checking tags, releases, and drafts right before deploy—so re-running an older release fixes its download without downgrading the site; delete abandoned newer drafts first).
4. **`publish`:** Makes the draft public **only** after `pages` succeeds (or is skipped for an older tag), and marks it `latest` only if `pages` deployed it and it is still newest. Re-running recovers a draft at its original commit even if `main` moved on.
5. **`verify`:** Runs `scripts/check-release.sh latest --expect <sha256> --wait 900` when `latest=true` (waiting out Pages' 10-minute cache), or `scripts/check-release.sh <tag> --expect <sha256> --wait 900 --no-site` for an older tag.

## Step 3: Post-release verification

Run locally (outside the sandbox) after the workflow finishes:

```sh
./scripts/check-release.sh latest
```

`.github/workflows/release-check.yml` also runs this check daily.
