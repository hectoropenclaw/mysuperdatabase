#!/usr/bin/env bash
# supanow — e2e-tenant-smoke.sh
# End-to-end smoke for a tenant data plane.
#
# Usage:
#   ./e2e-tenant-smoke.sh <project_ref>

set -euo pipefail

PROJECT_REF="${1:?Usage: e2e-tenant-smoke.sh <project_ref>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/projects/$PROJECT_REF/docker-compose.yml"
SITE_URL="${SITE_URL:-https://localhost}"
HOST_HEADER="${HOST_HEADER:-${PROJECT_REF}-db.hconsulting.app}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[FAIL] Missing tenant compose: $COMPOSE_FILE" >&2
  exit 1
fi

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" ps >/tmp/supanow-e2e-ps.txt
grep -q "db" /tmp/supanow-e2e-ps.txt && pass "compose has db service" || fail "db service missing"
grep -q "kong" /tmp/supanow-e2e-ps.txt && pass "compose has kong service" || fail "kong service missing"

for service in db kong auth storage realtime meta edge-runtime; do
  if docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" ps "$service" 2>/dev/null | grep -Eq "running|Up"; then
    pass "$service running"
  else
    fail "$service is not running"
  fi
done

curl_status() {
  curl -k -sS --max-time 12 -H "Host: ${HOST_HEADER}" -o /dev/null -w "%{http_code}" "$1" || printf '000'
}

status="$(curl_status "$SITE_URL/rest/v1/")"
if [[ "$status" =~ ^(200|401|403)$ ]]; then
  pass "PostgREST reachable status=$status"
else
  fail "PostgREST unreachable status=$status"
fi

status="$(curl_status "$SITE_URL/auth/v1/health")"
[[ "$status" =~ ^(200|401|403)$ ]] && pass "Auth reachable status=$status" || fail "Auth status=$status"

status="$(curl_status "$SITE_URL/storage/v1/status")"
[[ "$status" =~ ^(200|401|403)$ ]] && pass "Storage reachable status=$status" || fail "Storage status=$status"

status="$(curl_status "$SITE_URL/realtime/v1/")"
[[ "$status" =~ ^(200|401|403|404)$ ]] && pass "Realtime gateway reachable status=$status" || fail "Realtime status=$status"

"$SCRIPT_DIR/backup.sh" "$PROJECT_REF" >/tmp/supanow-e2e-backup.txt
grep -q "backed up" /tmp/supanow-e2e-backup.txt && pass "backup created" || fail "backup did not complete"

logs_count="$("$SCRIPT_DIR/collect-logs.sh" "$PROJECT_REF" 10 | wc -l | tr -d ' ')"
if [[ "$logs_count" =~ ^[0-9]+$ ]]; then
  pass "log collector emitted $logs_count entries"
else
  fail "log collector failed"
fi

pass "tenant smoke complete: $PROJECT_REF"
