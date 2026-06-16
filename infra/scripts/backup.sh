#!/usr/bin/env bash
# supanow — backup.sh
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
BACKUP_BUCKET="${BACKUP_BUCKET:-spn-backups}"
MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/supanow-mc}"
mkdir -p "$MC_CONFIG_DIR"

mc_cmd() {
  if command -v mc >/dev/null 2>&1; then
    mc "$@"
  else
    docker run --rm --network host \
      -v /tmp:/tmp \
      -v "$MC_CONFIG_DIR:/root/.mc" \
      minio/mc "$@"
  fi
}

mc_cmd alias set backup-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet >/dev/null 2>&1 || true
mc_cmd mb "backup-root/${BACKUP_BUCKET}" --quiet 2>/dev/null || true

backup_project() {
  local ref="$1"
  local keys_file="$PROJECTS_DIR/$ref/keys.json"
  local compose_file="$PROJECTS_DIR/$ref/docker-compose.yml"

  local db_password
  if [[ -f "$keys_file" ]]; then
    db_password=$(python3 -c "import json,sys; d=json.load(open('$keys_file')); print(d['db_password'])")
  elif [[ -f "$compose_file" ]]; then
    db_password=$(python3 - "$compose_file" <<'PY'
import re
import sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"POSTGRES_PASSWORD:\s*['\"]?([^'\"\n ]+)", text)
if not match:
    raise SystemExit("POSTGRES_PASSWORD not found in docker-compose.yml")
print(match.group(1))
PY
)
  else
    echo "[ERROR] No keys.json or docker-compose.yml for $ref" >&2
    return 1
  fi

  local timestamp
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)

  local dump_file="/tmp/backup-${ref}-${timestamp}.sql.gz"

  echo "→ Backing up $ref..."

  # pg_dump via Docker exec into the project DB container
  local container="spn-${ref}-db-1"
  if ! docker inspect "$container" --format "{{.State.Running}}" 2>/dev/null | grep -q true; then
    echo "  [WARN] DB container $container not running — skipping"
    return
  fi

  docker exec -e PGPASSWORD="$db_password" "$container" \
    pg_dump -U postgres -h 127.0.0.1 postgres \
    | gzip > "$dump_file"

  # Upload to MinIO
  mc_cmd cp "$dump_file" "backup-root/${BACKUP_BUCKET}/${ref}/${timestamp}.sql.gz" --quiet
  rm -f "$dump_file"

  # Apply retention — delete backups older than BACKUP_RETENTION_DAYS
  local cutoff
  cutoff=$(date -u -d "-${BACKUP_RETENTION_DAYS} days" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
    || date -u -v"-${BACKUP_RETENTION_DAYS}d" +%Y-%m-%dT%H:%M:%S)  # macOS fallback

  mc_cmd find "backup-root/${BACKUP_BUCKET}/${ref}/" \
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
