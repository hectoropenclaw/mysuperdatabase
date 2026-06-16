#!/usr/bin/env bash
# supanow - e2e-p2-platform.sh
# Smoke test for P2 platform-experience primitives.
#
# Usage:
#   ./infra/scripts/e2e-p2-platform.sh <project_ref>
#
# This validates the control-plane schema and, when the project exists in the
# control-plane DB, exercises P2 records and tenant data-plane probes.

set -euo pipefail

PROJECT_REF="${1:?Usage: e2e-p2-platform.sh <project_ref>}"
CONTROL_DB_CONTAINER="${CONTROL_DB_CONTAINER:-spn-cp-db}"
CONTROL_DB_NAME="${CONTROL_DB_NAME:-supanow_cp}"
CONTROL_DB_USER="${CONTROL_DB_USER:-postgres}"

if [[ ! "$PROJECT_REF" =~ ^[a-z0-9]{6,32}$ ]]; then
  echo "[FAIL] Invalid project ref: $PROJECT_REF" >&2
  exit 1
fi

pass() { echo "[PASS] $*"; }
warn() { echo "[WARN] $*"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

psql_cp() {
  docker exec "$CONTROL_DB_CONTAINER" psql -U "$CONTROL_DB_USER" -d "$CONTROL_DB_NAME" "$@"
}

psql_at() {
  psql_cp -At "$@"
}

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

require_table() {
  local table="$1"
  local found
  found="$(psql_at -c "select to_regclass('public.$table') is not null")"
  [[ "$found" == "t" ]] && pass "control-plane table exists: $table" || fail "missing table: $table"
}

for table in sql_query_history sql_snippets auth_email_test_events realtime_debug_sessions; do
  require_table "$table"
done

PROJECT_ROW="$(psql_cp -At -F $'\t' -c "
  select id, coalesce(site_url, ''), coalesce(service_role_key, ''), coalesce(anon_key, '')
  from projects
  where ref='$(sql_quote "$PROJECT_REF")' and status='active'
  limit 1
")"

if [[ -z "$PROJECT_ROW" ]]; then
  warn "No active control-plane project row for '$PROJECT_REF'."
  warn "P2 schema is installed, but API-level P2 smoke needs projects.ref/status/site_url/service_role_key/anon_key."
  warn "Run provisioning/import so the control plane knows this tenant, then re-run this script."
  pass "P2 schema-only smoke complete"
  exit 0
fi

IFS=$'\t' read -r PROJECT_ID SITE_URL SERVICE_ROLE_KEY ANON_KEY <<<"$PROJECT_ROW"
[[ -n "$PROJECT_ID" ]] || fail "project id is empty"
[[ -n "$SITE_URL" ]] || fail "project site_url is empty"
[[ -n "$SERVICE_ROLE_KEY" ]] || fail "project service_role_key is empty"
[[ -n "$ANON_KEY" ]] || warn "project anon_key is empty; realtime client config will be degraded"

TEST_NAME="p2-smoke-$(date +%s)"
QUERY_TEXT="select 1 as p2_smoke"
QUERY_HASH="$(printf "%s" "$QUERY_TEXT" | sha256sum | awk '{print $1}')"

cleanup() {
  psql_cp -q -v ON_ERROR_STOP=0 -c "
    delete from sql_snippets where project_id='$PROJECT_ID' and name='$TEST_NAME';
    delete from sql_query_history where project_id='$PROJECT_ID' and query_hash='$QUERY_HASH';
    delete from auth_email_test_events where project_id='$PROJECT_ID' and template='p2_smoke';
    delete from realtime_debug_sessions where project_id='$PROJECT_ID' and channel='$TEST_NAME';
  " >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_cp -v ON_ERROR_STOP=1 -q -c "
  insert into sql_query_history(project_id, query, query_hash, status, is_write, duration_ms, row_count)
  values('$PROJECT_ID', '$QUERY_TEXT', '$QUERY_HASH', 'completed', false, 1, 1);

  insert into sql_snippets(project_id, name, description, sql, tags)
  values('$PROJECT_ID', '$TEST_NAME', 'P2 smoke snippet', '$QUERY_TEXT', array['p2','smoke']);

  insert into auth_email_test_events(project_id, template, recipient, subject, body_preview, status, metadata)
  values('$PROJECT_ID', 'p2_smoke', 'preview@example.com', 'P2 smoke', 'Preview body', 'previewed', '{\"mode\":\"smoke\"}'::jsonb);

  insert into realtime_debug_sessions(project_id, channel, mode, client_config, status, result)
  values('$PROJECT_ID', '$TEST_NAME', 'broadcast', '{\"mode\":\"smoke\"}'::jsonb, 'created', '{}'::jsonb);
"
pass "control-plane P2 records insert cleanly"

record_count="$(psql_at -c "
  select
    (select count(*) from sql_query_history where project_id='$PROJECT_ID' and query_hash='$QUERY_HASH') +
    (select count(*) from sql_snippets where project_id='$PROJECT_ID' and name='$TEST_NAME') +
    (select count(*) from auth_email_test_events where project_id='$PROJECT_ID' and template='p2_smoke') +
    (select count(*) from realtime_debug_sessions where project_id='$PROJECT_ID' and channel='$TEST_NAME')
")"
[[ "$record_count" == "4" ]] && pass "control-plane P2 records are readable" || fail "expected 4 P2 records, got $record_count"

pg_meta_status="$(curl -k -sS --max-time 15 -o /tmp/supanow-p2-pgmeta.json -w "%{http_code}" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  --data '{"query":"select 1 as p2_smoke"}' \
  "$SITE_URL/pg/query" || printf '000')"
[[ "$pg_meta_status" =~ ^2 ]] && pass "pg-meta SQL query works status=$pg_meta_status" || fail "pg-meta SQL query failed status=$pg_meta_status"

storage_status="$(curl -k -sS --max-time 15 -o /dev/null -w "%{http_code}" "$SITE_URL/storage/v1/status" || printf '000')"
[[ "$storage_status" =~ ^(200|401|403)$ ]] && pass "storage reachable status=$storage_status" || fail "storage unreachable status=$storage_status"

realtime_status="$(curl -k -sS --max-time 15 -o /dev/null -w "%{http_code}" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  "$SITE_URL/realtime/v1/" || printf '000')"
[[ "$realtime_status" =~ ^(200|401|403|404)$ ]] && pass "realtime reachable status=$realtime_status" || fail "realtime unreachable status=$realtime_status"

pass "P2 platform smoke complete: $PROJECT_REF"
