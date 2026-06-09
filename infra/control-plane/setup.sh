#!/usr/bin/env bash
# supanow — setup.sh
# Starts the control plane PostgreSQL and applies all migrations.
# Run once on a fresh server, or after wiping the DB volume.
#
# Usage:
#   CP_DB_PASSWORD=<secure-password> ./setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CP_DB_PASSWORD="${CP_DB_PASSWORD:?Usage: CP_DB_PASSWORD=<password> ./setup.sh}"

echo "→ Starting control plane PostgreSQL..."
CP_DB_PASSWORD="$CP_DB_PASSWORD" docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d

echo "→ Waiting for DB to be ready..."
until docker exec spn-cp-db pg_isready -U postgres -d supanow_cp -q 2>/dev/null; do
  sleep 2
done

echo "✓ Control plane DB is up"
echo ""
echo "  Host:     localhost:5433  (127.0.0.1 only — not exposed publicly)"
echo "  User:     postgres"
echo "  Database: supanow_cp"
echo ""
echo "  DATABASE_URL for apps/api/.env.production:"
echo "  postgresql://postgres:${CP_DB_PASSWORD}@localhost:5433/supanow_cp"
echo ""
echo "  Set this in apps/api/.env.production and restart the API."
