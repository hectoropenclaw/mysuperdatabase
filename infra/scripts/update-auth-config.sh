#!/usr/bin/env bash
# supanow — update-auth-config.sh
# Rewrites auth.env for a project and hot-reloads the GoTrue container.
#
# Usage:
#   ./update-auth-config.sh <project_ref>
#
# The script reads GoTrue env vars from the environment.
# The control plane API sets all GOTRUE_* vars before calling this.
#
# On success exits 0. On failure exits non-zero.

set -euo pipefail

PROJECT_REF="${1:?Usage: update-auth-config.sh <project_ref>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"
TEMPLATES_DIR="$INFRA_DIR/templates"
PROJECTS_DIR="$INFRA_DIR/projects"
PROJECT_DIR="$PROJECTS_DIR/$PROJECT_REF"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "[ERROR] Project directory not found: $PROJECT_DIR" >&2
  exit 1
fi

# Read existing auth.env to get SITE_URL, JWT_SECRET, DB_PASSWORD if not provided
if [[ -f "$PROJECT_DIR/auth.env" ]]; then
  # Source only the core vars we need for template rendering
  _src=$(grep -E "^(GOTRUE_DB_DATABASE_URL|GOTRUE_SITE_URL|GOTRUE_JWT_SECRET)=" "$PROJECT_DIR/auth.env" || true)
  eval "$_src" 2>/dev/null || true
fi

# Derive template vars from already-set env
export SITE_URL="${SITE_URL:-$GOTRUE_SITE_URL}"
export JWT_SECRET="${JWT_SECRET:-$GOTRUE_JWT_SECRET}"

# Extract DB_PASSWORD from the GoTrue DB URL if not set
if [[ -z "${DB_PASSWORD:-}" ]] && [[ -n "${GOTRUE_DB_DATABASE_URL:-}" ]]; then
  DB_PASSWORD=$(echo "$GOTRUE_DB_DATABASE_URL" | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|')
  export DB_PASSWORD
fi

# Apply caller-provided overrides (all GOTRUE_* from env) — defaults already exported by caller
export GOTRUE_DISABLE_SIGNUP="${GOTRUE_DISABLE_SIGNUP:-false}"
export GOTRUE_JWT_EXP="${GOTRUE_JWT_EXP:-3600}"
export GOTRUE_MAILER_AUTOCONFIRM="${GOTRUE_MAILER_AUTOCONFIRM:-false}"
export GOTRUE_EXTERNAL_EMAIL_ENABLED="${GOTRUE_EXTERNAL_EMAIL_ENABLED:-true}"
export GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED="${GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED:-true}"
export GOTRUE_MAILER_OTP_EXP="${GOTRUE_MAILER_OTP_EXP:-86400}"
export GOTRUE_SMTP_MAX_FREQUENCY="${GOTRUE_SMTP_MAX_FREQUENCY:-1s}"
export SMTP_HOST="${GOTRUE_SMTP_HOST:-smtp.db.hconsulting.appm}"
export SMTP_PORT="${GOTRUE_SMTP_PORT:-587}"
export SMTP_USER="${GOTRUE_SMTP_USER:-}"
export SMTP_PASS="${GOTRUE_SMTP_PASS:-}"
export SMTP_ADMIN_EMAIL="${GOTRUE_SMTP_ADMIN_EMAIL:-noreply@db.hconsulting.appm}"
export SMTP_SENDER_NAME="${GOTRUE_SMTP_SENDER_NAME:-supanow}"
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
export GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED="${GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED:-true}"
export GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL="${GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL:-10}"
export GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION="${GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION:-false}"
export GOTRUE_MFA_TOTP_ENROLLMENT_MAX_FREQUENCY="${GOTRUE_MFA_TOTP_ENROLLMENT_MAX_FREQUENCY:-0}"
export GOTRUE_MFA_TOTP_ISSUER="${GOTRUE_MFA_TOTP_ISSUER:-supanow}"
export GOTRUE_PASSWORD_HIBP_ENABLED="${GOTRUE_PASSWORD_HIBP_ENABLED:-false}"
export GOTRUE_PASSWORD_MIN_LENGTH="${GOTRUE_PASSWORD_MIN_LENGTH:-6}"
export GOTRUE_PASSWORD_REQUIRED_CHARACTERS="${GOTRUE_PASSWORD_REQUIRED_CHARACTERS:-}"
export GOTRUE_EXTERNAL_GITLAB_URL="${GOTRUE_EXTERNAL_GITLAB_URL:-https://gitlab.com}"
export GOTRUE_EXTERNAL_WORKOS_URL="${GOTRUE_EXTERNAL_WORKOS_URL:-}"

# Generate new auth.env
envsubst < "$TEMPLATES_DIR/auth.env.tpl" > "$PROJECT_DIR/auth.env"
echo "→ auth.env updated for $PROJECT_REF"

# Hot-reload the auth container (recreate picks up new env_file)
docker compose \
  -f "$PROJECT_DIR/docker-compose.yml" \
  --project-name "spn-${PROJECT_REF}" \
  up -d --force-recreate --no-deps auth 2>&1

echo "✓ GoTrue reloaded for project $PROJECT_REF"
