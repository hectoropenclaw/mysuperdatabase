#!/usr/bin/env bash
# supanow - pitr-status.sh
# Prints PITR/WAL archiving status as JSON.
#
# Usage:
#   ./infra/scripts/pitr-status.sh <project_ref>

set -euo pipefail

PROJECT_REF="${1:?Usage: pitr-status.sh <project_ref>}"
CONTAINER="spn-${PROJECT_REF}-db-1"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

if [[ ! "$PROJECT_REF" =~ ^[a-z0-9]{6,32}$ ]]; then
  printf '{"project_ref":"%s","status":"failed","error":"invalid project ref"}\n' "$PROJECT_REF"
  exit 1
fi

if ! docker inspect "$CONTAINER" --format "{{.State.Running}}" 2>/dev/null | grep -q true; then
  printf '{"project_ref":"%s","status":"failed","error":"db container not running"}\n' "$PROJECT_REF"
  exit 1
fi

settings="$(docker exec "$CONTAINER" psql -U postgres -h 127.0.0.1 -d postgres -At -F $'\t' -c "select current_setting('wal_level'), current_setting('archive_mode'), current_setting('archive_command', true)")"
IFS=$'\t' read -r WAL_LEVEL ARCHIVE_MODE ARCHIVE_COMMAND <<<"$settings"
WAL_COUNT="$(docker exec "$CONTAINER" sh -lc "find /var/lib/postgresql/data/wal_archive -type f 2>/dev/null | wc -l" | tr -d ' ')"
LATEST_WAL="$(docker exec "$CONTAINER" sh -lc "find /var/lib/postgresql/data/wal_archive -type f -printf '%f\n' 2>/dev/null | sort | tail -1" | tr -d '\r')"
STATUS="disabled"
if [[ "$ARCHIVE_MODE" == "on" && "$ARCHIVE_COMMAND" == *wal_archive* ]]; then
  STATUS="enabled"
fi

printf '{"project_ref":"%s","status":"%s","wal_level":"%s","archive_mode":"%s","archive_command":"%s","archived_wal_count":%s,"latest_wal":"%s","checked_at":"%s"}\n' \
  "$PROJECT_REF" \
  "$STATUS" \
  "$(printf "%s" "$WAL_LEVEL" | json_escape)" \
  "$(printf "%s" "$ARCHIVE_MODE" | json_escape)" \
  "$(printf "%s" "$ARCHIVE_COMMAND" | json_escape)" \
  "${WAL_COUNT:-0}" \
  "$(printf "%s" "$LATEST_WAL" | json_escape)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
