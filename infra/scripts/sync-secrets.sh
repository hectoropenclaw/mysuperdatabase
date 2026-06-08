#!/usr/bin/env bash
# mysuperdatabase — sync-secrets.sh
# Writes project secrets to the edge-runtime container as a .env file,
# then restarts edge-runtime to pick up new values.
#
# Usage:
#   echo 'KEY1=val1\nKEY2=val2' | ./sync-secrets.sh <project_ref>

set -euo pipefail

PROJECT_REF="${1:?Usage: sync-secrets.sh <project_ref>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_DIR="$REPO_ROOT/infra/projects/$PROJECT_REF"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "[ERROR] Project directory not found: $PROJECT_DIR" >&2
  exit 1
fi

# Write secrets.env from stdin
cat > "$PROJECT_DIR/secrets.env"
echo "→ secrets.env updated for $PROJECT_REF"

# Hot-reload edge-runtime (picks up new env_file on recreate)
docker compose \
  -f "$PROJECT_DIR/docker-compose.yml" \
  --project-name "msd-${PROJECT_REF}" \
  up -d --force-recreate --no-deps edge-runtime 2>&1

echo "✓ Edge-runtime reloaded with new secrets for $PROJECT_REF"
