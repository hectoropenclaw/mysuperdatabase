#!/usr/bin/env bash
# supanow - verify-backup.sh
# Verifies that the latest backup object for a project is readable.
#
# Usage:
#   ./infra/scripts/verify-backup.sh <project_ref> [backup_key]
#
# Output: one JSON object on stdout.

set -euo pipefail

PROJECT_REF="${1:?Usage: verify-backup.sh <project_ref> [backup_key]}"
BACKUP_KEY="${2:-}"

MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
BACKUP_BUCKET="${BACKUP_BUCKET:-spn-backups}"
MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/supanow-mc}"
mkdir -p "$MC_CONFIG_DIR"

mc_cmd() {
  if command -v mc >/dev/null 2>&1; then
    mc "$@"
  else
    docker run --rm --network host -v /tmp:/tmp -v "$MC_CONFIG_DIR:/root/.mc" minio/mc "$@"
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

fail_json() {
  local error
  error="$(printf "%s" "$1" | json_escape)"
  printf '{"project_ref":"%s","status":"failed","error":"%s"}\n' "$PROJECT_REF" "$error"
  exit 1
}

mc_cmd alias set backup-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet >/dev/null 2>&1 || true

if [[ -z "$BACKUP_KEY" ]]; then
  BACKUP_KEY="$(
    mc_cmd ls "backup-root/${BACKUP_BUCKET}/${PROJECT_REF}/" 2>/dev/null \
      | awk '{print $NF}' \
      | grep -E '\.sql\.gz$' \
      | sort \
      | tail -1
  )"
  [[ -n "$BACKUP_KEY" ]] || fail_json "no backups found for ${PROJECT_REF}"
  BACKUP_KEY="${PROJECT_REF}/${BACKUP_KEY}"
fi

TMP_FILE="/tmp/supanow-verify-${PROJECT_REF}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
SAMPLE_FILE="${TMP_FILE%.gz}.sample.sql"
cleanup() {
  rm -f "$TMP_FILE" "$SAMPLE_FILE" 2>/dev/null || docker run --rm -v /tmp:/tmp busybox rm -f "$TMP_FILE" "$SAMPLE_FILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mc_cmd cp "backup-root/${BACKUP_BUCKET}/${BACKUP_KEY}" "$TMP_FILE" --quiet >/dev/null \
  || fail_json "could not download backup ${BACKUP_KEY}"

if ! gzip -t "$TMP_FILE"; then
  fail_json "gzip validation failed for ${BACKUP_KEY}"
fi

if ! gunzip -c "$TMP_FILE" > "$SAMPLE_FILE"; then
  fail_json "could not read gzip content for ${BACKUP_KEY}"
fi

if ! grep -aEq 'PostgreSQL database dump|CREATE|SET ' "$SAMPLE_FILE"; then
  fail_json "backup does not look like a PostgreSQL dump"
fi

SIZE_BYTES="$(wc -c < "$TMP_FILE" | tr -d ' ')"
CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ESCAPED_KEY="$(printf "%s" "$BACKUP_KEY" | json_escape)"

printf '{"project_ref":"%s","status":"verified","backup_key":"%s","size_bytes":%s,"checked_at":"%s"}\n' \
  "$PROJECT_REF" "$ESCAPED_KEY" "$SIZE_BYTES" "$CHECKED_AT"
