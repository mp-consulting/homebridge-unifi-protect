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

fetch() {

  curl -fsSL --retry 3 --retry-delay 1 -o "$tmpfile" "https://raw.githubusercontent.com/${SIBLING}/${1}/src/lib/${2}" 2>/dev/null
}

for file in "${FILES[@]}"; do

  # Prefer the same-named branch on the sibling so in-flight changes on both sides compare against each other, falling back to the default branch.
  if fetch "$BRANCH" "$file"; then
    ref="$BRANCH"
  elif fetch "main" "$file"; then
    ref="main"
  else
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

exit $status
