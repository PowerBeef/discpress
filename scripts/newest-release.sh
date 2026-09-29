#!/usr/bin/env bash
# Prints true if TAG is the newest release version, false if a newer one exists: a vX.Y.Z tag on
# GitHub or a release, drafts included (a draft's tag is only made when it is published). The Release
# workflow asks right before it deploys the site or makes a release the latest, so a re-run of an older
# release's jobs never puts it over a newer one. The reason goes to stderr.
# Usage: scripts/newest-release.sh TAG   (needs gh, GH_TOKEN with contents: write to see drafts, and
# GITHUB_REPOSITORY)
set -euo pipefail
TAG=$1
REPO=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}
version='^v[0-9]+\.[0-9]+\.[0-9]+$'
[[ $TAG =~ $version ]] || { echo "$TAG is not a vX.Y.Z version" >&2; exit 2; }
tags=$(gh api --paginate "repos/$REPO/git/matching-refs/tags/v" --jq '.[].ref | sub("^refs/tags/"; "")')
drafts=$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq '.[] | select(.draft) | .tag_name')
releases=$(gh api --paginate "repos/$REPO/releases?per_page=100" --jq '.[] | select(.draft | not) | .tag_name')
# only final versions count (sort -V would put v1.4.0 before v1.4.0-rc1)
top=$(printf '%s\n' "$tags" "$drafts" "$releases" "$TAG" | grep -E "$version" | sort -V | tail -1)
if [ "$top" = "$TAG" ]; then
  echo "$TAG is the newest version" >&2
  echo true
else
  if grep -qx "$top" <<<"$tags"; then where="its tag exists"
  elif grep -qx "$top" <<<"$drafts"; then where="a draft release, not published yet: delete it if it was abandoned"
  else where="a release"; fi
  echo "$TAG is not the newest version: $top is ($where)" >&2
  echo false
fi
