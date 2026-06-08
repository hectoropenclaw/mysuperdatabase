#!/usr/bin/env bash
# mysuperdatabase — provision.sh
# Provisions a new project stack on this server.
#
# Usage:
#   ./provision.sh <project_ref> [db_password] [jwt_secret]
#
# Environment vars (override defaults):
#   COOLIFY_URL      — Coolify API base URL (default: http://localhost:8000)
#   COOLIFY_TOKEN    — Coolify API bearer token
#   MINIO_ACCESS_KEY — MinIO access key (default: minioadmin)
#   MINIO_SECRET_KEY — MinIO secret key (default: minioadmin)
#   MINIO_ENDPOINT   — MinIO endpoint (default: http://minio:9000)
#   SMTP_HOST/PORT/USER/PASS/SENDER_NAME

set -euo pipefail

# ─── Args ────────────────────────────────────────────────────────────────────
PROJECT_REF="${1:?Usage: provision.sh <project_ref>}"
DB_PASSWORD="${2:-$(openssl rand -hex 16)}"
JWT_SECRET="${3:-$(openssl rand -hex 32)}"

# ─── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
TEMPLATES_DIR="$INFRA_DIR/templates"
PROJECTS_DIR="$INFRA_DIR/projects"
KONG_DIR="$INFRA_DIR/templates/kong"

mkdir -p "$PROJECTS_DIR/$PROJECT_REF/kong"

# ─── Generate JWT keys (pure bash, HS256) ───────────────────────────────────
# RFC 7519 — HS256 = HMAC-SHA256(base64url(header).base64url(payload), secret)
b64url() {
  # base64url-encode stdin
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}
hmac_sha256_b64url() {
  local msg="$1" key_hex="$2"
  printf '%s' "$msg" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key_hex" -binary | b64url
}
make_jwt() {
  local role="$1" secret="$2"
  local iat now_ts exp_ts
  now_ts=$(date +%s)
  exp_ts=$(( now_ts + 315360000 ))   # 10 years
  local header payload
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$role" "$now_ts" "$exp_ts" | b64url)
  local sig
  sig=$(hmac_sha256_b64url "${header}.${payload}" "$(printf '%s' "$secret" | xxd -p -c 256)")
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

JWT_SECRET_HEX=$(printf '%s' "$JWT_SECRET" | xxd -p -c 256)
ANON_KEY=$(make_jwt "anon" "$JWT_SECRET")
SERVICE_KEY=$(make_jwt "service_role" "$JWT_SECRET")
REALTIME_SECRET_KEY_BASE=$(openssl rand -hex 64)

SITE_URL="https://${PROJECT_REF}.mysuperdatabase.co"

echo "→ Provisioning project: $PROJECT_REF"
echo "  site_url:     $SITE_URL"
echo "  anon_key:     ${ANON_KEY:0:20}..."
echo "  service_key:  ${SERVICE_KEY:0:20}..."

# ─── Generate Kong config ────────────────────────────────────────────────────
export PROJECT_REF JWT_SECRET ANON_KEY SERVICE_KEY DB_PASSWORD SITE_URL REALTIME_SECRET_KEY_BASE
export SMTP_HOST="${SMTP_HOST:-smtp.mysuperdatabase.com}"
export SMTP_PORT="${SMTP_PORT:-587}"
export SMTP_USER="${SMTP_USER:-}"
export SMTP_PASS="${SMTP_PASS:-}"
export SMTP_SENDER_NAME="${SMTP_SENDER_NAME:-mysuperdatabase}"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"

envsubst < "$KONG_DIR/kong.yml.tpl" > "$PROJECTS_DIR/$PROJECT_REF/kong/${PROJECT_REF}.yml"
echo "→ Kong config generated at $PROJECTS_DIR/$PROJECT_REF/kong/${PROJECT_REF}.yml"

# ─── Generate DB init SQL ─────────────────────────────────────────────────────
mkdir -p "$PROJECTS_DIR/$PROJECT_REF/db"
envsubst < "$TEMPLATES_DIR/db/roles.sql.tpl" > "$PROJECTS_DIR/$PROJECT_REF/db/roles.sql"
echo "→ DB roles.sql generated at $PROJECTS_DIR/$PROJECT_REF/db/roles.sql"

# ─── Generate docker-compose ─────────────────────────────────────────────────
envsubst < "$TEMPLATES_DIR/docker-compose.project.yml" > "$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml"
echo "→ docker-compose.yml generated at $PROJECTS_DIR/$PROJECT_REF/docker-compose.yml"

# ─── Create MinIO bucket ─────────────────────────────────────────────────────
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
if command -v mc &>/dev/null; then
  mc alias set msd "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --quiet 2>/dev/null || true
  mc mb "msd/msd-${PROJECT_REF}" --quiet 2>/dev/null || echo "  bucket msd-${PROJECT_REF} may already exist"
  echo "→ MinIO bucket msd-${PROJECT_REF} ready"
else
  echo "  [WARN] mc not found — create bucket msd-${PROJECT_REF} manually in MinIO"
fi

# ─── Start DB only first, set passwords, then start everything ───────────────
echo "→ Starting DB for $PROJECT_REF..."
docker compose -f "$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml" \
  --project-name "msd-${PROJECT_REF}" \
  up -d db 2>&1

# Wait for DB to be healthy
echo "→ Waiting for DB to be ready..."
until docker compose -f "$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml" \
  --project-name "msd-${PROJECT_REF}" \
  exec -T db pg_isready -U postgres -h 127.0.0.1 > /dev/null 2>&1; do
  sleep 2
done

# Run init SQL: set passwords, fix ownership, create _realtime schema, set JWT settings
echo "→ Running DB init SQL..."
docker compose -f "$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml" \
  --project-name "msd-${PROJECT_REF}" \
  exec -T db psql -U supabase_admin -h 127.0.0.1 \
  -f /docker-entrypoint-initdb.d/init-scripts/99-roles.sql 2>&1

# Seed default edge function (main entrypoint) into the functions volume
echo "→ Seeding default edge function..."
FUNCTIONS_VOLUME="msd-${PROJECT_REF}-functions"
docker run --rm \
  -v "${FUNCTIONS_VOLUME}:/home/deno/functions" \
  -v "${TEMPLATES_DIR}/functions:/templates:ro" \
  busybox sh -c "cp -r /templates/. /home/deno/functions/" 2>&1 || true

# Start remaining services
echo "→ Starting all services for $PROJECT_REF..."
docker compose -f "$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml" \
  --project-name "msd-${PROJECT_REF}" \
  up -d 2>&1

echo ""
echo "✓ Project $PROJECT_REF provisioned successfully"
echo ""
echo "  API URL:      $SITE_URL"
echo "  anon key:     $ANON_KEY"
echo "  service key:  $SERVICE_KEY"
echo "  db password:  $DB_PASSWORD"
echo "  jwt secret:   $JWT_SECRET"
echo ""
echo "  Store these keys in the control plane DB."

# ─── Output JSON for control plane ──────────────────────────────────────────
cat > "$PROJECTS_DIR/$PROJECT_REF/keys.json" <<KEYS
{
  "project_ref": "$PROJECT_REF",
  "site_url": "$SITE_URL",
  "anon_key": "$ANON_KEY",
  "service_key": "$SERVICE_KEY",
  "db_password": "$DB_PASSWORD",
  "jwt_secret": "$JWT_SECRET"
}
KEYS
echo "→ Keys saved to $PROJECTS_DIR/$PROJECT_REF/keys.json"
