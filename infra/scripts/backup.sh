#!/usr/bin/env bash
# mysuperdatabase — backup.sh
# Dumps Postgres for each active project and uploads to MinIO.
# Retention: 7 days for Free, 30 days for Pro/Team (controlled by BACKUP_RETENTION_DAYS env).
#
# Usage:
#   ./backup.sh [project_ref]       — back up a specific project
#   BACKUP_ALL=1 ./backup.sh        — back up all active projects (called by cron)
#
# Requires: pg_dump, mc (MinIO client) on PATH.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECTS_DIR="$REPO_ROOT/infra/projects"

MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
BACKUP_BUCKET="${BACKUP_BUCKET:-msd-backups}"

mc alias set backup-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet 2>/dev/null || true
mc mb "backup-root/${BACKUP_BUCKET}" --quiet 2>/dev/null || true

backup_project() {
  local ref="$1"
  local keys_file="$PROJECTS_DIR/$ref/keys.json"

  if [[ ! -f "$keys_file" ]]; then
    echo "[WARN] No keys.json for $ref — skipping"
    return
  fi

  local db_password
  db_password=$(python3 -c "import json,sys; d=json.load(open('$keys_file')); print(d['db_password'])")

  local timestamp
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)

  local dump_file="/tmp/backup-${ref}-${timestamp}.sql.gz"

  echo "→ Backing up $ref..."

  # pg_dump via Docker exec into the project DB container
  local container="msd-${ref}-db-1"
  if ! docker inspect "$container" --format "{{.State.Running}}" 2>/dev/null | grep -q true; then
    echo "  [WARN] DB container $container not running — skipping"
    return
  fi

  docker exec -e PGPASSWORD="$db_password" "$container" \
    pg_dump -U postgres -h 127.0.0.1 postgres \
    | gzip > "$dump_file"

  # Upload to MinIO
  mc cp "$dump_file" "backup-root/${BACKUP_BUCKET}/${ref}/${timestamp}.sql.gz" --quiet
  rm -f "$dump_file"

  # Apply retention — delete backups older than BACKUP_RETENTION_DAYS
  local cutoff
  cutoff=$(date -u -d "-${BACKUP_RETENTION_DAYS} days" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
    || date -u -v"-${BACKUP_RETENTION_DAYS}d" +%Y-%m-%dT%H:%M:%S)  # macOS fallback

  mc find "backup-root/${BACKUP_BUCKET}/${ref}/" \
    --older-than "${BACKUP_RETENTION_DAYS}d" \
    --exec "mc rm {}" --quiet 2>/dev/null || true

  echo "  ✓ $ref backed up → ${BACKUP_BUCKET}/${ref}/${timestamp}.sql.gz"
}

if [[ -n "${1:-}" ]]; then
  backup_project "$1"
elif [[ "${BACKUP_ALL:-}" == "1" ]]; then
  if [[ ! -d "$PROJECTS_DIR" ]]; then
    echo "No projects directory found at $PROJECTS_DIR"
    exit 0
  fi
  for dir in "$PROJECTS_DIR"/*/; do
    ref=$(basename "$dir")
    backup_project "$ref" || echo "[ERROR] Backup failed for $ref"
  done
  echo "✓ All project backups complete"
else
  echo "Usage: backup.sh <project_ref> | BACKUP_ALL=1 backup.sh"
  exit 1
fi
