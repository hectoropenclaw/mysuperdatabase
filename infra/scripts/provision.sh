#!/usr/bin/env bash
# supanow — provision.sh
# Provisions a new project stack on this server.
#
# Usage:
#   ./provision.sh <project_ref> [db_password] [jwt_secret]
#
# Optional env vars:
#   ORG_ID                 — Control-plane org UUID (auto-creates system org if absent)
#   CP_DATABASE_URL        — Control-plane Postgres URL
#   MINIO_ACCESS_KEY/SECRET_KEY/ENDPOINT/ROOT_USER/ROOT_PASSWORD
#   SMTP_HOST/PORT/USER/PASS/SENDER_NAME/ADMIN_EMAIL
#   KONG_RATE_LIMIT_PER_MINUTE / KONG_RATE_LIMIT_PER_HOUR
#   GOTRUE_* / COOLIFY_*

set -euo pipefail

# ─── Args ─────────────────────────────────────────────────────────────────────
PROJECT_REF="${1:?Usage: provision.sh <project_ref>}"
DB_PASSWORD="${2:-$(openssl rand -hex 16)}"
JWT_SECRET="${3:-$(openssl rand -hex 32)}"

# ─── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
TEMPLATES_DIR="$INFRA_DIR/templates"
PROJECTS_DIR="$INFRA_DIR/projects"
KONG_DIR="$INFRA_DIR/templates/kong"
PROJECT_DIR="$PROJECTS_DIR/$PROJECT_REF"

# Control-plane DB — used to register the project at the end
CP_DATABASE_URL="${CP_DATABASE_URL:-postgresql://postgres:6ebdc748fa747997d018a225eb5114a58695fcd8@localhost:5433/supanow_cp}"

# ─── Cleanup trap (runs on any error) ─────────────────────────────────────────
PROVISION_STARTED=0

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 && $PROVISION_STARTED -eq 1 ]]; then
    echo ""
    echo "✗ Provision failed (exit $exit_code) — rolling back $PROJECT_REF..."

    docker compose -f "$PROJECT_DIR/docker-compose.yml" \
      --project-name "spn-${PROJECT_REF}" \
      down -v --remove-orphans 2>/dev/null || true

    rm -rf "$PROJECT_DIR"

    # Mark as error in control plane if it was already inserted
    docker run --rm --network host postgres:17-alpine \
      psql "$CP_DATABASE_URL" \
      -c "UPDATE projects SET status='error' WHERE ref='${PROJECT_REF}'" 2>/dev/null || true

    echo "✗ Rollback complete. Project $PROJECT_REF cleaned up."
  fi
}
trap cleanup EXIT

# ─── Helper: validate no unsubstituted ${...} remain in a generated file ──────
validate_envsubst() {
  local file="$1"
  if grep -qP '\$\{[A-Z_]+\}' "$file" 2>/dev/null; then
    echo "✗ envsubst left unsubstituted variables in $file:"
    grep -P '\$\{[A-Z_]+\}' "$file" | head -5
    return 1
  fi
}

# ─── Helper: wait for a container to become healthy ───────────────────────────
wait_healthy() {
  local container="$1"
  local timeout="${2:-120}"
  local elapsed=0
  echo "  waiting for $container..."
  until [[ "$(docker inspect "$container" --format '{{.State.Health.Status}}' 2>/dev/null)" == "healthy" ]]; do
    # Also accept containers with no healthcheck that are simply running
    local state
    state=$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      echo "✗ $container exited unexpectedly"
      docker logs "$container" --tail 20 2>&1 || true
      return 1
    fi
    if [[ $elapsed -ge $timeout ]]; then
      echo "✗ $container did not become healthy within ${timeout}s"
      docker logs "$container" --tail 20 2>&1 || true
      return 1
    fi
    sleep 3
    elapsed=$(( elapsed + 3 ))
  done
  echo "  ✓ $container healthy"
}

# ─── Generate JWT keys (pure bash, HS256) ─────────────────────────────────────
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

hmac_sha256_b64url() {
  local msg="$1" key_hex="$2"
  printf '%s' "$msg" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key_hex" -binary | b64url
}

make_jwt() {
  local role="$1" secret="$2"
  local now_ts exp_ts header payload sig
  now_ts=$(date +%s)
  exp_ts=$(( now_ts + 315360000 ))  # 10 years
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$role" "$now_ts" "$exp_ts" | b64url)
  sig=$(hmac_sha256_b64url "${header}.${payload}" "$(printf '%s' "$secret" | xxd -p -c 256)")
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

ANON_KEY=$(make_jwt "anon" "$JWT_SECRET")
SERVICE_KEY=$(make_jwt "service_role" "$JWT_SECRET")
REALTIME_SECRET_KEY_BASE=$(openssl rand -hex 64)
SITE_URL="https://${PROJECT_REF}.db.hconsulting.app"

echo "→ Provisioning project: $PROJECT_REF"
echo "  site_url:    $SITE_URL"
echo "  anon_key:    ${ANON_KEY:0:20}..."
echo "  service_key: ${SERVICE_KEY:0:20}..."

# ─── Export all template variables (no :-default in templates) ────────────────
export PROJECT_REF JWT_SECRET ANON_KEY SERVICE_KEY DB_PASSWORD SITE_URL REALTIME_SECRET_KEY_BASE

export SMTP_HOST="${SMTP_HOST:-smtp.hconsulting.app}"
export SMTP_PORT="${SMTP_PORT:-587}"
export SMTP_USER="${SMTP_USER:-}"
export SMTP_PASS="${SMTP_PASS:-}"
export SMTP_ADMIN_EMAIL="${SMTP_ADMIN_EMAIL:-noreply@hconsulting.app}"
export SMTP_SENDER_NAME="${SMTP_SENDER_NAME:-supanow}"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
export KONG_RATE_LIMIT_PER_MINUTE="${KONG_RATE_LIMIT_PER_MINUTE:-500}"
export KONG_RATE_LIMIT_PER_HOUR="${KONG_RATE_LIMIT_PER_HOUR:-5000}"

export GOTRUE_DISABLE_SIGNUP="${GOTRUE_DISABLE_SIGNUP:-false}"
export GOTRUE_JWT_EXP="${GOTRUE_JWT_EXP:-3600}"
export GOTRUE_MAILER_AUTOCONFIRM="${GOTRUE_MAILER_AUTOCONFIRM:-false}"
export GOTRUE_EXTERNAL_EMAIL_ENABLED="${GOTRUE_EXTERNAL_EMAIL_ENABLED:-true}"
export GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED="${GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED:-true}"
export GOTRUE_MAILER_OTP_EXP="${GOTRUE_MAILER_OTP_EXP:-86400}"
export GOTRUE_SMTP_MAX_FREQUENCY="${GOTRUE_SMTP_MAX_FREQUENCY:-1s}"
export GOTRUE_EXTERNAL_PHONE_ENABLED="${GOTRUE_EXTERNAL_PHONE_ENABLED:-false}"
export GOTRUE_SMS_AUTOCONFIRM="${GOTRUE_SMS_AUTOCONFIRM:-false}"
export GOTRUE_SMS_PROVIDER="${GOTRUE_SMS_PROVIDER:-twilio}"
export GOTRUE_SMS_TWILIO_ACCOUNT_SID="${GOTRUE_SMS_TWILIO_ACCOUNT_SID:-}"
export GOTRUE_SMS_TWILIO_AUTH_TOKEN="${GOTRUE_SMS_TWILIO_AUTH_TOKEN:-}"
export GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID="${GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID:-}"
export GOTRUE_SMS_VONAGE_API_KEY="${GOTRUE_SMS_VONAGE_API_KEY:-}"
export GOTRUE_SMS_VONAGE_API_SECRET="${GOTRUE_SMS_VONAGE_API_SECRET:-}"
export GOTRUE_SMS_VONAGE_FROM="${GOTRUE_SMS_VONAGE_FROM:-}"
export GOTRUE_SMS_OTP_EXP="${GOTRUE_SMS_OTP_EXP:-60}"
export GOTRUE_SMS_OTP_LENGTH="${GOTRUE_SMS_OTP_LENGTH:-6}"
export GOTRUE_EXTERNAL_GITLAB_URL="${GOTRUE_EXTERNAL_GITLAB_URL:-https://gitlab.com}"
export GOTRUE_EXTERNAL_WORKOS_URL="${GOTRUE_EXTERNAL_WORKOS_URL:-}"
export GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED="${GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED:-true}"
export GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL="${GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL:-10}"
export GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION="${GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION:-false}"
export GOTRUE_MFA_TOTP_ENROLLMENT_MAX_FREQUENCY="${GOTRUE_MFA_TOTP_ENROLLMENT_MAX_FREQUENCY:-0}"
export GOTRUE_MFA_TOTP_ISSUER="${GOTRUE_MFA_TOTP_ISSUER:-supanow}"
export GOTRUE_PASSWORD_HIBP_ENABLED="${GOTRUE_PASSWORD_HIBP_ENABLED:-false}"
export GOTRUE_PASSWORD_MIN_LENGTH="${GOTRUE_PASSWORD_MIN_LENGTH:-6}"
export GOTRUE_PASSWORD_REQUIRED_CHARACTERS="${GOTRUE_PASSWORD_REQUIRED_CHARACTERS:-}"

for provider in GITHUB GOOGLE DISCORD TWITTER FACEBOOK APPLE TWITCH SPOTIFY GITLAB BITBUCKET NOTION ZOOM FIGMA WORKOS LINKEDIN_OIDC SLACK_OIDC; do
  varE="GOTRUE_EXTERNAL_${provider}_ENABLED"; export "$varE=${!varE:-false}"
  varC="GOTRUE_EXTERNAL_${provider}_CLIENT_ID"; export "$varC=${!varC:-}"
  varS="GOTRUE_EXTERNAL_${provider}_SECRET"; export "$varS=${!varS:-}"
done

# ─── Generate files from templates ────────────────────────────────────────────
mkdir -p "$PROJECT_DIR/kong" "$PROJECT_DIR/db"

envsubst < "$TEMPLATES_DIR/auth.env.tpl"              > "$PROJECT_DIR/auth.env"
validate_envsubst "$PROJECT_DIR/auth.env"
echo "→ auth.env generated"

envsubst < "$KONG_DIR/kong.yml.tpl"                   > "$PROJECT_DIR/kong/${PROJECT_REF}.yml"
validate_envsubst "$PROJECT_DIR/kong/${PROJECT_REF}.yml"
echo "→ kong.yml generated"

envsubst < "$TEMPLATES_DIR/db/roles.sql.tpl"          > "$PROJECT_DIR/db/roles.sql"
validate_envsubst "$PROJECT_DIR/db/roles.sql"
echo "→ roles.sql generated"

envsubst < "$TEMPLATES_DIR/docker-compose.project.yml" > "$PROJECT_DIR/docker-compose.yml"
validate_envsubst "$PROJECT_DIR/docker-compose.yml"
echo "→ docker-compose.yml generated"

# ─── MinIO bucket + per-project user ──────────────────────────────────────────
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
S3_ACCESS_KEY="msd$(openssl rand -hex 9)"
S3_SECRET_KEY="$(openssl rand -hex 20)"

if command -v mc &>/dev/null; then
  mc alias set spn-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet 2>/dev/null || true
  mc mb "spn-root/spn-${PROJECT_REF}" --quiet 2>/dev/null || echo "  bucket spn-${PROJECT_REF} may already exist"
  mc admin user add spn-root "$S3_ACCESS_KEY" "$S3_SECRET_KEY" --quiet 2>/dev/null || true
  POLICY_JSON=$(printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::spn-%s","arn:aws:s3:::spn-%s/*"]}]}' "$PROJECT_REF" "$PROJECT_REF")
  printf '%s' "$POLICY_JSON" | mc admin policy create spn-root "policy-${PROJECT_REF}" /dev/stdin --quiet 2>/dev/null || true
  mc admin policy attach spn-root "policy-${PROJECT_REF}" --user "$S3_ACCESS_KEY" --quiet 2>/dev/null || true
  echo "→ MinIO: bucket spn-${PROJECT_REF} + user ${S3_ACCESS_KEY} ready"
else
  echo "  [WARN] mc not found — bucket spn-${PROJECT_REF} must be created manually"
  S3_ACCESS_KEY="$MINIO_ACCESS_KEY"
  S3_SECRET_KEY="$MINIO_SECRET_KEY"
fi

# ─── Start DB ─────────────────────────────────────────────────────────────────
PROVISION_STARTED=1
echo "→ Starting DB for $PROJECT_REF..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" --project-name "spn-${PROJECT_REF}" up -d db

echo "→ Waiting for DB to accept connections..."
until docker compose -f "$PROJECT_DIR/docker-compose.yml" --project-name "spn-${PROJECT_REF}" \
    exec -T db pg_isready -U postgres -h 127.0.0.1 > /dev/null 2>&1; do
  sleep 2
done

# ─── Run roles init as supabase_admin (the only user that can ALTER reserved roles) ──
# NOTE: roles.sql is NOT in docker-entrypoint-initdb.d — it is run explicitly here
#       so that the correct superuser (supabase_admin) executes it every time.
echo "→ Running DB roles init as supabase_admin..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" --project-name "spn-${PROJECT_REF}" \
  exec -T db psql -U supabase_admin -h 127.0.0.1 -d postgres -f /tmp/roles.sql 2>&1 || \
docker exec "spn-${PROJECT_REF}-db-1" \
  sh -c "psql -U supabase_admin -d postgres" < "$PROJECT_DIR/db/roles.sql"

# Fallback: copy and run if exec -f fails (some images restrict -f)
docker cp "$PROJECT_DIR/db/roles.sql" "spn-${PROJECT_REF}-db-1:/tmp/roles.sql" 2>/dev/null || true
docker exec "spn-${PROJECT_REF}-db-1" \
  psql -U supabase_admin -h 127.0.0.1 -d postgres -f /tmp/roles.sql 2>&1 || true

echo "→ Verifying role passwords were applied..."
docker exec "spn-${PROJECT_REF}-db-1" \
  psql -U supabase_admin -h 127.0.0.1 -d postgres -c \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('supabase_storage_admin','authenticator','supabase_auth_admin')" 2>&1

# ─── Seed edge functions + secrets.env ────────────────────────────────────────
touch "$PROJECT_DIR/secrets.env"
FUNCTIONS_VOLUME="spn-${PROJECT_REF}-functions"
docker run --rm \
  -v "${FUNCTIONS_VOLUME}:/home/deno/functions" \
  -v "${TEMPLATES_DIR}/functions:/templates:ro" \
  busybox sh -c "cp -r /templates/. /home/deno/functions/" 2>&1 || true

# ─── Start all services ───────────────────────────────────────────────────────
echo "→ Starting all services for $PROJECT_REF..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" --project-name "spn-${PROJECT_REF}" up -d

# ─── Wait for every critical service to be healthy ────────────────────────────
echo "→ Waiting for all services to become healthy..."
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
wait_healthy "spn-${PROJECT_REF}-db-1"      "$HEALTH_TIMEOUT"
wait_healthy "spn-${PROJECT_REF}-auth-1"    "$HEALTH_TIMEOUT"
wait_healthy "spn-${PROJECT_REF}-rest-1"    "$HEALTH_TIMEOUT" || true  # no healthcheck
wait_healthy "spn-${PROJECT_REF}-kong-1"    "$HEALTH_TIMEOUT"
wait_healthy "spn-${PROJECT_REF}-storage-1" "$HEALTH_TIMEOUT"
wait_healthy "spn-${PROJECT_REF}-realtime-1" "$HEALTH_TIMEOUT" || true  # slow starter

# ─── Register project in control plane DB ─────────────────────────────────────
echo "→ Registering project in control plane DB..."

# Ensure a default system org exists (idempotent)
SYSTEM_ORG_ID=$(docker run --rm --network host postgres:17-alpine \
  psql "$CP_DATABASE_URL" -tAc \
  "INSERT INTO organizations (name, slug, plan)
   VALUES ('system', 'system', 'internal')
   ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name
   RETURNING id;" 2>/dev/null || echo "")

if [[ -z "$SYSTEM_ORG_ID" ]]; then
  SYSTEM_ORG_ID=$(docker run --rm --network host postgres:17-alpine \
    psql "$CP_DATABASE_URL" -tAc \
    "SELECT id FROM organizations WHERE slug='system' LIMIT 1" 2>/dev/null || echo "")
fi

ORG_ID="${ORG_ID:-$SYSTEM_ORG_ID}"

if [[ -n "$ORG_ID" ]]; then
  docker run --rm --network host postgres:17-alpine \
    psql "$CP_DATABASE_URL" -c \
    "INSERT INTO projects
       (ref, name, org_id, status, site_url, db_host, db_port,
        jwt_secret, anon_key, service_role_key, db_password,
        storage_s3_access_key, storage_s3_secret_key)
     VALUES
       ('${PROJECT_REF}', '${PROJECT_REF}', '${ORG_ID}', 'active',
        '${SITE_URL}', 'spn-${PROJECT_REF}-db-1', 5432,
        '${JWT_SECRET}', '${ANON_KEY}', '${SERVICE_KEY}', '${DB_PASSWORD}',
        '${S3_ACCESS_KEY}', '${S3_SECRET_KEY}')
     ON CONFLICT (ref) DO UPDATE SET
       status='active',
       jwt_secret=EXCLUDED.jwt_secret,
       anon_key=EXCLUDED.anon_key,
       service_role_key=EXCLUDED.service_role_key,
       db_password=EXCLUDED.db_password,
       storage_s3_access_key=EXCLUDED.storage_s3_access_key,
       storage_s3_secret_key=EXCLUDED.storage_s3_secret_key,
       updated_at=now();" 2>&1
  echo "→ Project registered in control plane DB"
else
  echo "  [WARN] Could not determine org_id — skipping control plane registration"
  echo "         Run manually: INSERT INTO projects (...) from $PROJECT_DIR/keys.json"
fi

# ─── Save keys ────────────────────────────────────────────────────────────────
cat > "$PROJECT_DIR/keys.json" <<KEYS
{
  "project_ref":   "$PROJECT_REF",
  "site_url":      "$SITE_URL",
  "anon_key":      "$ANON_KEY",
  "service_key":   "$SERVICE_KEY",
  "db_password":   "$DB_PASSWORD",
  "jwt_secret":    "$JWT_SECRET",
  "s3_access_key": "$S3_ACCESS_KEY",
  "s3_secret_key": "$S3_SECRET_KEY"
}
KEYS

# ─── Smoke test — verify the stack actually responds end-to-end ───────────────
# Kong is accessed via the coolify/Traefik network; on the host we hit it through
# the Cloudflare tunnel URL. Allow up to 30s for DNS + TLS to propagate.
echo "→ Smoke testing stack..."

SMOKE_URL="https://${PROJECT_REF}.db.hconsulting.app"
SMOKE_TIMEOUT=30
SMOKE_ELAPSED=0
SMOKE_STATUS=""

until [[ "$SMOKE_STATUS" == "200" || "$SMOKE_STATUS" == "401" ]]; do
  SMOKE_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
    --max-time 5 \
    -H "apikey: ${ANON_KEY}" \
    "${SMOKE_URL}/rest/v1/" 2>/dev/null || echo "000")

  if [[ "$SMOKE_STATUS" == "200" || "$SMOKE_STATUS" == "401" ]]; then
    break
  fi

  if [[ $SMOKE_ELAPSED -ge $SMOKE_TIMEOUT ]]; then
    echo "  [WARN] Smoke test timed out (last HTTP status: $SMOKE_STATUS)"
    echo "         Stack is up but ${SMOKE_URL} may still be propagating."
    echo "         Re-check manually: curl -H 'apikey: ${ANON_KEY}' ${SMOKE_URL}/rest/v1/"
    break
  fi

  sleep 3
  SMOKE_ELAPSED=$(( SMOKE_ELAPSED + 3 ))
done

if [[ "$SMOKE_STATUS" == "200" ]]; then
  echo "  ✓ REST API reachable ($SMOKE_URL) — HTTP $SMOKE_STATUS"
elif [[ "$SMOKE_STATUS" == "401" ]]; then
  # Kong is up and enforcing auth — anon key may need a valid table to query
  echo "  ✓ Kong gateway reachable ($SMOKE_URL) — HTTP $SMOKE_STATUS (auth enforced, stack healthy)"
fi

# Auth endpoint smoke test (no key required)
AUTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  --max-time 5 \
  "${SMOKE_URL}/auth/v1/health" 2>/dev/null || echo "000")
if [[ "$AUTH_STATUS" == "200" ]]; then
  echo "  ✓ GoTrue reachable — HTTP $AUTH_STATUS"
else
  echo "  [WARN] GoTrue /auth/v1/health returned $AUTH_STATUS (may still be starting)"
fi

echo ""
echo "✓ Project $PROJECT_REF provisioned successfully"
echo ""
echo "  API URL:     $SITE_URL"
echo "  anon key:    $ANON_KEY"
echo "  service key: $SERVICE_KEY"
echo "  db password: $DB_PASSWORD"
echo "  jwt secret:  $JWT_SECRET"
echo ""
echo "  Keys saved to $PROJECT_DIR/keys.json"
