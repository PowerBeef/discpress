#!/usr/bin/env bash
# Checks that the offline and online builds are the same file: a release's discpress.html download,
# the SHA-256 listed beside it and, for the latest release, the online version (index.html on GitHub
# Pages) and the SHA-256 listed there. The Release workflow runs it after publishing, and a daily
# workflow runs it for the latest release.
# Usage: scripts/check-release.sh [tag|latest] [--expect SHA256] [--no-site] [--wait SECONDS]
#   --expect   the SHA-256 the files must have (the release's dist/discpress.html); without it, the
#              download as it is at each try
#   --no-site  check only the download (an older release: the site shows the latest)
#   --wait     keep retrying this long while the files don't match yet (the site's cache)
set -euo pipefail
REPO=${GITHUB_REPOSITORY:-PowerBeef/discpress}
SITE=${DISCPRESS_SITE:-https://powerbeef.github.io/discpress/}
tag=latest expect='' site=1 wait=0
while [ $# -gt 0 ]; do
  case "$1" in
    --expect) expect=$2; shift 2 ;;
    --no-site) site=0; shift ;;
    --wait) wait=$2; shift 2 ;;
    *) tag=$1; shift ;;
  esac
done
if [ "$tag" = latest ]; then dl="https://github.com/$REPO/releases/latest/download"
else dl="https://github.com/$REPO/releases/download/$tag"; fi

# Each prints nothing and fails when the file can't be fetched.
hash_url() { local h; h=$(curl -fsSL -H 'Cache-Control: no-cache' "$1" | sha256sum) || return 1; echo "${h%% *}"; }
listed() { local l; l=$(curl -fsSL -H 'Cache-Control: no-cache' "$1") || return 1; awk '{print $1; exit}' <<<"$l"; }

deadline=$((SECONDS + wait))
while :; do
  problems=()
  file=$(hash_url "$dl/discpress.html" || echo unavailable)
  list=$(listed "$dl/discpress.html.sha256" || echo unavailable)
  want=${expect:-$file} # without --expect: the download as it is now, which may still change
  [ "$file" = "$want" ] || problems+=("download $file")
  [ "$list" = "$want" ] || problems+=("download's .sha256 $list")
  if [ "$site" = 1 ]; then
    page=$(hash_url "$SITE?check=$RANDOM$RANDOM" || echo unavailable)
    slist=$(listed "${SITE}discpress.html.sha256?check=$RANDOM$RANDOM" || echo unavailable)
    [ "$page" = "$want" ] || problems+=("online version $page")
    [ "$slist" = "$want" ] || problems+=("online .sha256 $slist")
  fi
  if [ "$want" = unavailable ]; then problems+=("the download is unavailable"); fi
  if [ ${#problems[@]} -eq 0 ]; then
    if [ "$site" = 1 ]; then echo "$tag: the download and the online version are the same file ($want)"
    else echo "$tag: the download matches its .sha256 ($want)"; fi
    exit 0
  fi
  if [ $SECONDS -ge $deadline ]; then
    echo "$tag: expected $want, but:" >&2
    printf '  %s\n' "${problems[@]}" >&2
    exit 1
  fi
  sleep 20
done
