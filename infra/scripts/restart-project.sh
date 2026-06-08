#!/usr/bin/env bash
# mysuperdatabase — restart-project.sh
# Restarts one or all services in a project stack.
#
# Usage:
#   ./restart-project.sh <project_ref> [service1 service2 ...]
#
# If no services are specified, restarts all services.

set -euo pipefail

PROJECT_REF="${1:?Usage: restart-project.sh <project_ref> [services...]}"
shift
SERVICES=("$@")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECTS_DIR="$REPO_ROOT/infra/projects"
COMPOSE_FILE="$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[ERROR] docker-compose.yml not found for project: $PROJECT_REF" >&2
  exit 1
fi

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  echo "→ Restarting all services for $PROJECT_REF..."
  docker compose -f "$COMPOSE_FILE" --project-name "msd-${PROJECT_REF}" restart
else
  echo "→ Restarting services [${SERVICES[*]}] for $PROJECT_REF..."
  docker compose -f "$COMPOSE_FILE" --project-name "msd-${PROJECT_REF}" restart "${SERVICES[@]}"
fi

echo "✓ Restart complete for $PROJECT_REF"
