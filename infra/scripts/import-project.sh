#!/usr/bin/env bash
# supanow - import-project.sh
# Imports an existing tenant stack into the control-plane DB without printing
# project secrets.
#
# Usage:
#   ORG_ID=<uuid> ./infra/scripts/import-project.sh <project_ref>
#
# Optional env:
#   CP_DATABASE_URL, ORG_ID, USER_ID, PROJECT_NAME, SITE_URL

set -euo pipefail

PROJECT_REF="${1:?Usage: import-project.sh <project_ref>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_DIR="$REPO_ROOT/infra/projects/$PROJECT_REF"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
KEYS_FILE="$PROJECT_DIR/keys.json"
CP_DATABASE_URL="${CP_DATABASE_URL:-postgresql://postgres:6ebdc748fa747997d018a225eb5114a58695fcd8@localhost:5433/supanow_cp}"
PROJECT_NAME="${PROJECT_NAME:-$PROJECT_REF}"

if [[ ! "$PROJECT_REF" =~ ^[a-z0-9]{6,32}$ ]]; then
  echo "[FAIL] Invalid project ref: $PROJECT_REF" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" && ! -f "$KEYS_FILE" ]]; then
  echo "[FAIL] Missing tenant files under $PROJECT_DIR" >&2
  exit 1
fi

json_get() {
  local key="$1"
  [[ -f "$KEYS_FILE" ]] || return 0
  node -e "const fs=require('fs'); const p='$KEYS_FILE'; const d=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(d['$key'] || '')"
}

compose_get() {
  local key="$1"
  [[ -f "$COMPOSE_FILE" ]] || return 0
  awk -v key="$key" '
    $1 == key ":" {
      sub("^[[:space:]]*" key ":[[:space:]]*", "")
      gsub(/^["'\'']|["'\'']$/, "")
      print
      exit
    }
  ' "$COMPOSE_FILE"
}

compose_regex() {
  local pattern="$1"
  [[ -f "$COMPOSE_FILE" ]] || return 0
  grep -Eom1 "$pattern" "$COMPOSE_FILE" | sed -E "s/$pattern/\\1/" || true
}

resolve_env_default() {
  local value="$1"
  if [[ "$value" =~ ^\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}$ ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$ ]]; then
    printf "%s" "${!BASH_REMATCH[1]:-}"
  else
    printf "%s" "$value"
  fi
}

SITE_URL="${SITE_URL:-$(json_get site_url)}"
SITE_URL="${SITE_URL:-$(compose_get SUPABASE_PUBLIC_URL)}"
SITE_URL="${SITE_URL:-https://${PROJECT_REF}-db.hconsulting.app}"

ANON_KEY="$(json_get anon_key)"
ANON_KEY="${ANON_KEY:-$(compose_get SUPABASE_ANON_KEY)}"
ANON_KEY="${ANON_KEY:-$(compose_get ANON_KEY)}"

SERVICE_KEY="$(json_get service_key)"
SERVICE_KEY="${SERVICE_KEY:-$(compose_get SUPABASE_SERVICE_ROLE_KEY)}"
SERVICE_KEY="${SERVICE_KEY:-$(compose_get SUPABASE_SERVICE_KEY)}"
SERVICE_KEY="${SERVICE_KEY:-$(compose_get SERVICE_KEY)}"

DB_PASSWORD="$(json_get db_password)"
DB_PASSWORD="${DB_PASSWORD:-$(compose_get POSTGRES_PASSWORD)}"
DB_PASSWORD="${DB_PASSWORD:-$(compose_regex 'postgres://[^:]+:([^@]+)@db:5432/postgres')}"

JWT_SECRET="$(json_get jwt_secret)"
JWT_SECRET="${JWT_SECRET:-$(compose_get JWT_SECRET)}"
JWT_SECRET="${JWT_SECRET:-$(compose_get PGRST_JWT_SECRET)}"

S3_ACCESS_KEY="$(json_get s3_access_key)"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-$(compose_get AWS_ACCESS_KEY_ID)}"
S3_ACCESS_KEY="$(resolve_env_default "$S3_ACCESS_KEY")"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"

S3_SECRET_KEY="$(json_get s3_secret_key)"
S3_SECRET_KEY="${S3_SECRET_KEY:-$(compose_get AWS_SECRET_ACCESS_KEY)}"
S3_SECRET_KEY="$(resolve_env_default "$S3_SECRET_KEY")"
S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"

for required in SITE_URL ANON_KEY SERVICE_KEY DB_PASSWORD JWT_SECRET; do
  if [[ -z "${!required:-}" ]]; then
    echo "[FAIL] Could not infer $required for $PROJECT_REF" >&2
    exit 1
  fi
done

psql_cp() {
  docker run --rm --network host postgres:17-alpine psql "$CP_DATABASE_URL" "$@"
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

SYSTEM_ORG_ID="$(psql_cp -tAc "
  INSERT INTO organizations(name, slug, plan)
  VALUES('system', 'system', 'free')
  ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name
  RETURNING id;
" 2>/dev/null | grep -Eom1 '[0-9a-f-]{36}' || true)"

if [[ -z "$SYSTEM_ORG_ID" ]]; then
  SYSTEM_ORG_ID="$(psql_cp -tAc "SELECT id FROM organizations WHERE slug='system' LIMIT 1" 2>/dev/null | grep -Eom1 '[0-9a-f-]{36}' || true)"
fi

ORG_ID="${ORG_ID:-$SYSTEM_ORG_ID}"
if [[ -z "$ORG_ID" ]]; then
  echo "[FAIL] Could not determine ORG_ID" >&2
  exit 1
fi

COMPONENT_VERSIONS_JSON='{"postgres":"supabase/postgres:15.8.1.085","postgrest":"postgrest/postgrest:v14.12","gotrue":"supabase/gotrue:v2.189.0","realtime":"supabase/realtime:v2.102.3","storage":"supabase/storage-api:v1.60.4","pgMeta":"supabase/postgres-meta:v0.96.6","edgeRuntime":"supabase/edge-runtime:v1.74.0","kong":"kong/kong:3.9.1"}'

psql_cp -v ON_ERROR_STOP=1 -q -c "
  INSERT INTO projects
    (ref, name, org_id, status, site_url, db_host, db_port,
     jwt_secret, anon_key, service_role_key, db_password,
     storage_s3_access_key, storage_s3_secret_key, component_versions)
  VALUES
    ('$(sql_escape "$PROJECT_REF")', '$(sql_escape "$PROJECT_NAME")', '$ORG_ID', 'active',
     '$(sql_escape "$SITE_URL")', 'spn-${PROJECT_REF}-db-1', 5432,
     '$(sql_escape "$JWT_SECRET")', '$(sql_escape "$ANON_KEY")', '$(sql_escape "$SERVICE_KEY")', '$(sql_escape "$DB_PASSWORD")',
     '$(sql_escape "$S3_ACCESS_KEY")', '$(sql_escape "$S3_SECRET_KEY")', '$COMPONENT_VERSIONS_JSON'::jsonb)
  ON CONFLICT(ref) DO UPDATE SET
    name=EXCLUDED.name,
    org_id=EXCLUDED.org_id,
    status='active',
    site_url=EXCLUDED.site_url,
    db_host=EXCLUDED.db_host,
    db_port=EXCLUDED.db_port,
    jwt_secret=EXCLUDED.jwt_secret,
    anon_key=EXCLUDED.anon_key,
    service_role_key=EXCLUDED.service_role_key,
    db_password=EXCLUDED.db_password,
    storage_s3_access_key=EXCLUDED.storage_s3_access_key,
    storage_s3_secret_key=EXCLUDED.storage_s3_secret_key,
    component_versions=EXCLUDED.component_versions,
    updated_at=NOW();
"

if [[ -n "${USER_ID:-}" ]]; then
  psql_cp -v ON_ERROR_STOP=1 -q -c "
    INSERT INTO org_members(org_id, user_id, role)
    VALUES('$ORG_ID', '$(sql_escape "$USER_ID")', 'owner')
    ON CONFLICT(org_id, user_id) DO UPDATE SET role=EXCLUDED.role;
  "
fi

echo "[PASS] Imported project $PROJECT_REF into control plane"
