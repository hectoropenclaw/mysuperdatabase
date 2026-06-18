#!/usr/bin/env bash
# supanow - sync-wal-archive.sh
# Copies archived WAL segments from a tenant DB container to MinIO/S3.
#
# Usage:
#   ./infra/scripts/sync-wal-archive.sh <project_ref>

set -euo pipefail

PROJECT_REF="${1:?Usage: sync-wal-archive.sh <project_ref>}"
CONTAINER="spn-${PROJECT_REF}-db-1"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
BACKUP_BUCKET="${BACKUP_BUCKET:-spn-backups}"
MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/supanow-mc}"
TMP_DIR="/tmp/supanow-wal-${PROJECT_REF}"
mkdir -p "$MC_CONFIG_DIR" "$TMP_DIR"

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

[[ "$PROJECT_REF" =~ ^[a-z0-9]{6,32}$ ]] || fail_json "invalid project ref"
docker inspect "$CONTAINER" --format "{{.State.Running}}" 2>/dev/null | grep -q true || fail_json "db container not running"

mc_cmd alias set backup-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet >/dev/null 2>&1 || true
mc_cmd mb "backup-root/${BACKUP_BUCKET}" --quiet 2>/dev/null || true

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
docker cp "${CONTAINER}:/var/lib/postgresql/data/wal_archive/." "$TMP_DIR/" >/dev/null 2>&1 || true

local_count="$(find "$TMP_DIR" -type f | wc -l | tr -d ' ')"
if [[ "${local_count:-0}" -gt 0 ]]; then
  mc_cmd mirror --overwrite "$TMP_DIR" "backup-root/${BACKUP_BUCKET}/wal/${PROJECT_REF}/" --quiet >/dev/null
fi

offsite_list="$(mc_cmd ls "backup-root/${BACKUP_BUCKET}/wal/${PROJECT_REF}/" 2>/dev/null || true)"
offsite_count="$(printf "%s\n" "$offsite_list" | awk 'NF { count++ } END { print count + 0 }')"
latest_offsite_wal="$(printf "%s\n" "$offsite_list" | awk '{print $NF}' | grep -E '^[A-F0-9]{24}(\\.[A-Za-z0-9]+)?$' | sort | tail -1)"
rm -rf "$TMP_DIR"

printf '{"project_ref":"%s","status":"synced","local_wal_count":%s,"offsite_wal_count":%s,"latest_offsite_wal":"%s","offsite_synced_at":"%s"}\n' \
  "$PROJECT_REF" \
  "${local_count:-0}" \
  "${offsite_count:-0}" \
  "$(printf "%s" "$latest_offsite_wal" | json_escape)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
