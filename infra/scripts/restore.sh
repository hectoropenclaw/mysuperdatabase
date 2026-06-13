#!/usr/bin/env bash
# supanow — restore.sh
# Restores a project Postgres database from a MinIO backup object created by backup.sh.
#
# Usage:
#   ./restore.sh <project_ref> <backup_key>

set -euo pipefail

PROJECT_REF="${1:?Usage: restore.sh <project_ref> <backup_key>}"
BACKUP_KEY="${2:?Usage: restore.sh <project_ref> <backup_key>}"

MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
BACKUP_BUCKET="${BACKUP_BUCKET:-spn-backups}"

CONTAINER="spn-${PROJECT_REF}-db-1"
TMP_FILE="/tmp/restore-${PROJECT_REF}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

if ! docker inspect "$CONTAINER" --format "{{.State.Running}}" 2>/dev/null | grep -q true; then
  echo "DB container $CONTAINER is not running" >&2
  exit 1
fi

mc alias set backup-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet 2>/dev/null || true
mc cp "backup-root/${BACKUP_BUCKET}/${BACKUP_KEY}" "$TMP_FILE" --quiet

gunzip -c "$TMP_FILE" | docker exec -i "$CONTAINER" psql -U postgres -h 127.0.0.1 postgres
rm -f "$TMP_FILE"

echo "Restored ${PROJECT_REF} from ${BACKUP_KEY}"
