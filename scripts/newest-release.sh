#!/usr/bin/env bash
# Prints true if TAG is the newest release version, false if a newer one exists: a vX.Y.Z tag on
# GitHub or a release, drafts included (a draft's tag is only made when it is published). The Release
# workflow asks right before it deploys the site or makes a release the latest, so a re-run of an older
# release's jobs never puts it over a newer one. The reason goes to stderr.
# Usage: scripts/newest-release.sh TAG   (needs gh, GH_TOKEN with contents: write to see drafts, and
# GITHUB_REPOSITORY)
set -euo pipefail
TAG=${1:?Usage: newest-release.sh TAG}
REPO=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}
version='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ $TAG =~ $version ]] || { echo "$TAG is not a vX.Y.Z version" >&2; exit 2; }
tags=$(gh api --paginate "repos/$REPO/git/matching-refs/tags/v" --jq '.[].ref | sub("^refs/tags/"; "")')
rel_json=$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq '.[] | "\(.draft)\t\(.tag_name)"')
drafts=$(awk -F'\t' '$1 == "true" {print $2}' <<<"$rel_json")
releases=$(awk -F'\t' '$1 != "true" {print $2}' <<<"$rel_json")
# only final versions count (sort -V would put v1.4.0 before v1.4.0-rc1)
top=$(printf '%s\n' "$tags" "$drafts" "$releases" "$TAG" | grep -E "$version" | LC_ALL=C sort -V | tail -1)
if [ "$top" = "$TAG" ]; then
  echo "$TAG is the newest version" >&2
  echo true
else
  if grep -qxF "$top" <<<"$tags"; then where="its tag exists"
  elif grep -qxF "$top" <<<"$drafts"; then where="a draft release, not published yet: delete it if it was abandoned"
  else where="a release"; fi
  echo "$TAG is not the newest version: $top is ($where)" >&2
  echo false
fi
