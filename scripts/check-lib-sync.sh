#!/usr/bin/env bash
# Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
#
# check-lib-sync.sh: Verify that the shared dependency-free library files in src/lib remain byte-identical to the sibling plugin repository.
#
# The homebridge-unifi-access and homebridge-unifi-protect plugins deliberately duplicate a small dependency-free library (src/lib) rather than sharing an npm
# package, to preserve their zero-dependency posture. This script keeps that duplication honest: it fetches the sibling repository's copy of each shared file
# and fails if any of them have drifted. Files that exist in only one repository (e.g. the FFmpeg subtree, index.ts barrels) are intentionally not compared.
#
# Usage: scripts/check-lib-sync.sh [sibling-repo] [branch]
set -euo pipefail

SIBLING="${1:-mp-consulting/homebridge-unifi-access}"
BRANCH="${2:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-main}}}"

# The shared library files that must stay in sync across both repositories.
FILES=(featureoptions.ts mqtt-connection.ts mqttclient.ts request.ts service.ts ui-server.ts util.ts websocket.ts)

status=0
tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT

# Fetch one shared library file from the sibling repository. Returns 0 when the file was retrieved, 1 when it doesn't exist on that branch, and 2 on any
# transport or server error, so callers can tell a legitimately absent file apart from an outage or rate limit.
fetch() {

  local http_code

  # Bust the raw.githubusercontent.com CDN cache - it holds responses, 404s included, for several minutes, which would otherwise defeat the grace-period
  # recheck below by serving it the same stale answer.
  http_code="$(curl -sSL --retry 3 --retry-delay 1 -H 'Cache-Control: no-cache' -w '%{http_code}' -o "$tmpfile" \
    "https://raw.githubusercontent.com/${SIBLING}/${1}/src/lib/${2}?nocache=$(date +%s)${RANDOM}" 2>/dev/null)" || http_code="000"

  case "$http_code" in
    200) return 0 ;;
    404) return 1 ;;
    *)   return 2 ;;
  esac
}

check_files() {

  status=0

  local rc ref

  for file in "${FILES[@]}"; do

    # Prefer the same-named branch on the sibling so in-flight changes on both sides compare against each other, falling back to the default branch.
    fetch "$BRANCH" "$file" && rc=0 || rc=$?
    ref="$BRANCH"

    if [ "$rc" -eq 1 ]; then
      fetch "main" "$file" && rc=0 || rc=$?
      ref="main"
    fi

    # Fetch failures must fail the run - treating an outage or rate limit as an absent file would silently skip the comparison.
    if [ "$rc" -eq 2 ]; then
      echo "ERROR src/lib/${file} could not be fetched from ${SIBLING}@${ref} - unable to verify sync"
      status=1
      continue
    fi

    if [ "$rc" -eq 1 ]; then
      echo "SKIP  src/lib/${file} (not present in ${SIBLING} on ${BRANCH} or main)"
      continue
    fi

    if cmp -s "$tmpfile" "src/lib/${file}"; then
      echo "OK    src/lib/${file} (matches ${SIBLING}@${ref})"
    else
      echo "DRIFT src/lib/${file} differs from ${SIBLING}@${ref} - sync the copies before merging"
      status=1
    fi
  done

  return $status
}

# Shared library changes land as paired pushes to both repositories, so this check can race the sibling's push: our CI may run before the matching commit
# arrives on the other side. On drift, give the sibling one grace period to catch up before failing.
if ! check_files; then

  echo "Drift or fetch errors detected - re-checking in 60 seconds in case the sibling repository's matching push is still in flight."
  sleep 60

  check_files || exit 1
fi

exit 0
