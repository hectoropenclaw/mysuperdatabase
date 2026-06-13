#!/usr/bin/env bash
# supanow — teardown.sh
# Destroys a provisioned project stack, its volumes, and removes it from the control plane DB.
#
# Usage:
#   ./teardown.sh <project_ref> [--force]
#
# --force skips the confirmation prompt.
# Optional env:
#   CP_DATABASE_URL — control-plane Postgres URL

set -euo pipefail

PROJECT_REF="${1:?Usage: teardown.sh <project_ref> [--force]}"
FORCE="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECTS_DIR="$REPO_ROOT/infra/projects"
PROJECT_DIR="$PROJECTS_DIR/$PROJECT_REF"

CP_DATABASE_URL="${CP_DATABASE_URL:-postgresql://postgres:6ebdc748fa747997d018a225eb5114a58695fcd8@localhost:5433/supanow_cp}"

# ─── Safety confirmation ───────────────────────────────────────────────────────
if [[ "$FORCE" != "--force" ]]; then
  echo ""
  echo "WARNING: This will permanently destroy project '$PROJECT_REF':"
  echo "  • Stop all containers (spn-${PROJECT_REF}-*)"
  echo "  • Delete all Docker volumes (DB data, functions, deno cache)"
  echo "  • Delete project directory: $PROJECT_DIR"
  echo "  • Mark project as 'deleted' in control plane DB"
  echo ""
  read -r -p "Type '$PROJECT_REF' to confirm: " CONFIRM
  if [[ "$CONFIRM" != "$PROJECT_REF" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ─── Mark as deleted in control plane DB first (best-effort) ──────────────────
echo "→ Marking project deleted in control plane DB..."
docker run --rm --network host postgres:17-alpine \
  psql "$CP_DATABASE_URL" \
  -c "UPDATE projects SET status='deleted', updated_at=now() WHERE ref='${PROJECT_REF}'" \
  2>/dev/null && echo "  ✓ marked deleted" || echo "  [WARN] could not reach control plane DB"

# ─── Stop and remove containers + volumes ────────────────────────────────────
if [[ -f "$PROJECT_DIR/docker-compose.yml" ]]; then
  echo "→ Stopping containers for $PROJECT_REF..."
  docker compose -f "$PROJECT_DIR/docker-compose.yml" \
    --project-name "spn-${PROJECT_REF}" \
    down -v --remove-orphans 2>&1 || true
  echo "  ✓ containers and volumes removed"
else
  # No compose file — try to stop containers by name directly
  echo "  [WARN] $PROJECT_DIR/docker-compose.yml not found — stopping containers by name..."
  docker ps -a --format '{{.Names}}' \
    | grep "^spn-${PROJECT_REF}-" \
    | xargs -r docker rm -f 2>/dev/null || true

  for vol in db functions deno-cache; do
    docker volume rm "spn-${PROJECT_REF}-${vol}" 2>/dev/null && \
      echo "  ✓ volume spn-${PROJECT_REF}-${vol} removed" || true
  done
fi

# ─── Remove MinIO bucket (best-effort) ────────────────────────────────────────
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://localhost:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"

if command -v mc &>/dev/null; then
  echo "→ Removing MinIO bucket spn-${PROJECT_REF}..."
  mc alias set spn-root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" --quiet 2>/dev/null || true
  mc rb --force "spn-root/spn-${PROJECT_REF}" 2>/dev/null && \
    echo "  ✓ bucket removed" || echo "  [WARN] bucket not found or already deleted"
else
  echo "  [SKIP] mc not found — bucket spn-${PROJECT_REF} must be deleted manually"
fi

# ─── Remove project directory ─────────────────────────────────────────────────
if [[ -d "$PROJECT_DIR" ]]; then
  echo "→ Removing project directory $PROJECT_DIR..."
  rm -rf "$PROJECT_DIR"
  echo "  ✓ directory removed"
fi

echo ""
echo "✓ Project $PROJECT_REF torn down."
