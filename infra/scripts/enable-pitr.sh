#!/usr/bin/env bash
# supanow - enable-pitr.sh
# Enables PostgreSQL WAL archiving for a tenant DB container.
#
# Usage:
#   ./infra/scripts/enable-pitr.sh <project_ref>

set -euo pipefail

PROJECT_REF="${1:?Usage: enable-pitr.sh <project_ref>}"
CONTAINER="spn-${PROJECT_REF}-db-1"

if [[ ! "$PROJECT_REF" =~ ^[a-z0-9]{6,32}$ ]]; then
  echo "[FAIL] Invalid project ref: $PROJECT_REF" >&2
  exit 1
fi

if ! docker inspect "$CONTAINER" --format "{{.State.Running}}" 2>/dev/null | grep -q true; then
  echo "[FAIL] DB container $CONTAINER is not running" >&2
  exit 1
fi

docker exec "$CONTAINER" sh -lc "mkdir -p /var/lib/postgresql/data/wal_archive && chown -R postgres:postgres /var/lib/postgresql/data/wal_archive"
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 <<'SQL'
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_timeout = '60s';
ALTER SYSTEM SET archive_command = 'test ! -f /var/lib/postgresql/data/wal_archive/%f && cp %p /var/lib/postgresql/data/wal_archive/%f';
SELECT pg_reload_conf();
SQL

CONFIG_FILE="$(docker exec "$CONTAINER" psql -U postgres -h 127.0.0.1 -d postgres -Atc "show config_file")"
docker exec "$CONTAINER" sh -lc "python3 - <<'PY'
from pathlib import Path
path = Path('$CONFIG_FILE')
start = '# BEGIN supanow pitr'
end = '# END supanow pitr'
block = '''# BEGIN supanow pitr
wal_level = replica
archive_mode = on
archive_timeout = '60s'
archive_command = 'test ! -f /var/lib/postgresql/data/wal_archive/%f && cp %p /var/lib/postgresql/data/wal_archive/%f'
# END supanow pitr
'''
text = path.read_text()
if start in text and end in text:
    before = text.split(start, 1)[0]
    after = text.split(end, 1)[1]
    text = before + block + after
else:
    text = text.rstrip() + '\\n\\n' + block
path.write_text(text)
PY"
docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
STATUS="$(docker exec "$CONTAINER" psql -U postgres -h 127.0.0.1 -d postgres -Atc "select current_setting('archive_mode')")"
if [[ "$STATUS" != "on" ]]; then
  echo "[FAIL] PITR/WAL archiving did not enable; archive_mode=$STATUS" >&2
  exit 1
fi

echo "[PASS] PITR/WAL archiving configured for $PROJECT_REF. DB restarted."
