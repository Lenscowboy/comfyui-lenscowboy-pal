#!/usr/bin/env bash
#
# sync-schema.sh — sync the pinned LCBE_LAYOUT JSON Schema from the canonical
# lcbe-layout-schema repository.
#
# Canonical source: https://github.com/Lenscowboy/lcbe-layout-schema
#
# Usage:
#   scripts/sync-schema.sh              # fetch upstream, update local schema + .sha256
#   scripts/sync-schema.sh --check-only # CI mode: verify local matches pinned upstream
#
# Files this script reads/writes:
#   schemas/PINNED_VERSION            (read)  — e.g. "1.0.0"
#   schemas/lcbe_layout.schema.json   (write) — synced from upstream
#   schemas/.sha256                   (write) — SHA-256 of the upstream schema at pinned version
#
# Exit codes:
#   0 — OK
#   1 — fetch / IO failure
#   2 — required file missing in check-only mode
#   3 — local schema diverges from stored .sha256 (someone edited it directly)
#   4 — upstream schema at the pinned tag diverges from stored .sha256 (tag was force-moved)

set -euo pipefail

UPSTREAM_REPO="Lenscowboy/lcbe-layout-schema"
RAW_HOST="raw.githubusercontent.com"

# Resolve repo root from script location: scripts/ lives at REPO_ROOT/scripts/
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMA_DIR="$REPO_ROOT/schemas"
PINNED_FILE="$SCHEMA_DIR/PINNED_VERSION"
LOCAL_SCHEMA="$SCHEMA_DIR/lcbe_layout.schema.json"
LOCAL_SHA_FILE="$SCHEMA_DIR/.sha256"

CHECK_ONLY=0
if [[ "${1:-}" == "--check-only" ]]; then
  CHECK_ONLY=1
elif [[ "${1:-}" != "" ]]; then
  echo "error: unknown argument: $1" >&2
  echo "usage: $0 [--check-only]" >&2
  exit 1
fi

if [[ ! -f "$PINNED_FILE" ]]; then
  echo "error: $PINNED_FILE not found. Create it with the pinned semver (e.g. '1.0.0')." >&2
  exit 2
fi

PINNED_VERSION="$(tr -d '[:space:]' < "$PINNED_FILE")"
if [[ -z "$PINNED_VERSION" ]]; then
  echo "error: $PINNED_FILE is empty" >&2
  exit 2
fi

# Derive schemas/vX.Y path from semver MAJOR.MINOR
MAJOR_MINOR="$(echo "$PINNED_VERSION" | cut -d. -f1,2)"
UPSTREAM_URL="https://${RAW_HOST}/${UPSTREAM_REPO}/v${PINNED_VERSION}/schemas/v${MAJOR_MINOR}/lcbe_layout.schema.json"

echo "Pinned version: $PINNED_VERSION  (schema path: v$MAJOR_MINOR)"
echo "Upstream URL:   $UPSTREAM_URL"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! curl --fail --silent --show-error --location --output "$TMP" "$UPSTREAM_URL"; then
  echo "error: failed to fetch $UPSTREAM_URL" >&2
  exit 1
fi

UPSTREAM_SHA="$(sha256sum "$TMP" | awk '{print $1}')"
echo "Upstream SHA:   $UPSTREAM_SHA"

if [[ $CHECK_ONLY -eq 1 ]]; then
  if [[ ! -f "$LOCAL_SCHEMA" ]]; then
    echo "error: local schema missing at $LOCAL_SCHEMA. Run scripts/sync-schema.sh." >&2
    exit 2
  fi
  if [[ ! -f "$LOCAL_SHA_FILE" ]]; then
    echo "error: $LOCAL_SHA_FILE missing. Run scripts/sync-schema.sh." >&2
    exit 2
  fi

  STORED_SHA="$(tr -d '[:space:]' < "$LOCAL_SHA_FILE")"
  LOCAL_SHA="$(sha256sum "$LOCAL_SCHEMA" | awk '{print $1}')"
  echo "Stored SHA:     $STORED_SHA"
  echo "Local SHA:      $LOCAL_SHA"

  if [[ "$LOCAL_SHA" != "$STORED_SHA" ]]; then
    cat >&2 <<EOF
error: local schemas/lcbe_layout.schema.json has been edited.
       local SHA:  $LOCAL_SHA
       stored SHA: $STORED_SHA
       Run scripts/sync-schema.sh to restore from upstream v$PINNED_VERSION,
       or change the schema upstream in lcbe-layout-schema first and then re-sync here.
EOF
    exit 3
  fi

  if [[ "$UPSTREAM_SHA" != "$STORED_SHA" ]]; then
    cat >&2 <<EOF
error: upstream schema at tag v$PINNED_VERSION does not match the stored .sha256.
       upstream SHA: $UPSTREAM_SHA
       stored SHA:   $STORED_SHA
       Either the upstream tag was force-moved (which it should not be — tags are immutable
       per the canonical repo's release policy), or this repo's pinned version is stale.
       Investigate before bumping; do not blindly re-sync.
EOF
    exit 4
  fi

  echo "OK: local schema matches pinned upstream v$PINNED_VERSION."
  exit 0
fi

# SYNC mode — write upstream content to local schema and update .sha256
mv "$TMP" "$LOCAL_SCHEMA"
trap - EXIT
echo "$UPSTREAM_SHA" > "$LOCAL_SHA_FILE"

cat <<EOF

Synced schemas/lcbe_layout.schema.json to v$PINNED_VERSION (SHA $UPSTREAM_SHA)

Next steps:
  git add schemas/PINNED_VERSION schemas/lcbe_layout.schema.json schemas/.sha256
  git commit -m "Bump LCBE_LAYOUT schema to v$PINNED_VERSION"
EOF
