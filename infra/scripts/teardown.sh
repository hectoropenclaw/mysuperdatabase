#!/usr/bin/env bash
# supanow — teardown.sh
# Stops and removes a project stack.
#
# Usage:
#   ./teardown.sh <project_ref> [--delete-data]
#
# --delete-data  also removes the Docker volume (irreversible!)

set -euo pipefail

PROJECT_REF="${1:?Usage: teardown.sh <project_ref> [--delete-data]}"
DELETE_DATA="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECTS_DIR="$REPO_ROOT/infra/projects"
COMPOSE_FILE="$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Error: no compose file found for $PROJECT_REF at $COMPOSE_FILE"
  exit 1
fi

echo "→ Stopping stack for $PROJECT_REF..."
docker compose -f "$COMPOSE_FILE" \
  --project-name "spn-${PROJECT_REF}" \
  down 2>&1

if [ "$DELETE_DATA" = "--delete-data" ]; then
  echo "→ Removing data volume spn-${PROJECT_REF}-db..."
  docker volume rm "spn-${PROJECT_REF}-db" 2>/dev/null || echo "  volume not found"

  MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
  MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
  MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
  if command -v mc &>/dev/null; then
    mc alias set msd "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --quiet 2>/dev/null || true
    mc rb --force "msd/spn-${PROJECT_REF}" 2>/dev/null || echo "  MinIO bucket not found"
    echo "→ MinIO bucket spn-${PROJECT_REF} removed"
  fi

  rm -rf "$PROJECTS_DIR/$PROJECT_REF"
  echo "→ Project directory removed"
fi

echo "✓ Project $PROJECT_REF torn down"
