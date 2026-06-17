#!/usr/bin/env bash
# supanow - restore-drill.sh
# Restores the latest dump backup into a temporary database in the tenant DB
# container, validates it with a query, and drops it.
#
# Usage:
#   ./infra/scripts/restore-drill.sh <project_ref> [backup_key]

set -euo pipefail

PROJECT_REF="${1:?Usage: restore-drill.sh <project_ref> [backup_key]}"
BACKUP_KEY="${2:-}"
CONTAINER="spn-${PROJECT_REF}-db-1"
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
  printf '{"project_ref":"%s","status":"failed","backup_key":"%s","error":"%s"}\n' "$PROJECT_REF" "$(printf "%s" "$BACKUP_KEY" | json_escape)" "$error"
  exit 1
}

[[ "$PROJECT_REF" =~ ^[a-z0-9]{6,32}$ ]] || fail_json "invalid project ref"
docker inspect "$CONTAINER" --format "{{.State.Running}}" 2>/dev/null | grep -q true || fail_json "db container not running"
mc_cmd alias set backup-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet >/dev/null 2>&1 || true

if [[ -z "$BACKUP_KEY" ]]; then
  BACKUP_KEY="$(
    mc_cmd ls "backup-root/${BACKUP_BUCKET}/${PROJECT_REF}/" 2>/dev/null \
      | awk '{print $NF}' \
      | grep -E '\.sql\.gz$' \
      | sort \
      | tail -1
  )"
  [[ -n "$BACKUP_KEY" ]] || fail_json "no backups found"
  BACKUP_KEY="${PROJECT_REF}/${BACKUP_KEY}"
fi

START_MS="$(date +%s%3N)"
TMP_FILE="/tmp/supanow-drill-${PROJECT_REF}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
TEMP_DB="restore_drill_${PROJECT_REF}_$(date -u +%Y%m%d%H%M%S)"
cleanup() {
  docker exec "$CONTAINER" dropdb -U postgres -h 127.0.0.1 --if-exists "$TEMP_DB" >/dev/null 2>&1 || true
  rm -f "$TMP_FILE" 2>/dev/null || docker run --rm -v /tmp:/tmp busybox rm -f "$TMP_FILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mc_cmd cp "backup-root/${BACKUP_BUCKET}/${BACKUP_KEY}" "$TMP_FILE" --quiet >/dev/null || fail_json "could not download backup"
gzip -t "$TMP_FILE" || fail_json "gzip validation failed"
docker exec "$CONTAINER" createdb -U postgres -h 127.0.0.1 "$TEMP_DB" || fail_json "could not create temp database"
gunzip -c "$TMP_FILE" | docker exec -i "$CONTAINER" psql -U postgres -h 127.0.0.1 "$TEMP_DB" >/tmp/supanow-restore-drill.log 2>&1 || fail_json "$(tail -20 /tmp/supanow-restore-drill.log)"
docker exec "$CONTAINER" psql -U postgres -h 127.0.0.1 "$TEMP_DB" -Atc "select 1" | grep -q '^1$' || fail_json "validation query failed"
OBJECT_COUNT="$(
  docker exec "$CONTAINER" psql -U postgres -h 127.0.0.1 "$TEMP_DB" -Atc \
    "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'"
)"
SCHEMA_COUNT="$(
  docker exec "$CONTAINER" psql -U postgres -h 127.0.0.1 "$TEMP_DB" -Atc \
    "select count(*) from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'"
)"
[[ "${OBJECT_COUNT:-0}" -gt 0 ]] || fail_json "restored database has no user objects"
END_MS="$(date +%s%3N)"
DURATION_MS="$((END_MS - START_MS))"

printf '{"project_ref":"%s","status":"verified","backup_key":"%s","temp_database":"%s","duration_ms":%s,"object_count":%s,"schema_count":%s,"checked_at":"%s"}\n' \
  "$PROJECT_REF" \
  "$(printf "%s" "$BACKUP_KEY" | json_escape)" \
  "$TEMP_DB" \
  "$DURATION_MS" \
  "${OBJECT_COUNT:-0}" \
  "${SCHEMA_COUNT:-0}" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
