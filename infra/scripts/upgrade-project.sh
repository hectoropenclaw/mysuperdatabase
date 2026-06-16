#!/usr/bin/env bash
# supanow — upgrade-project.sh
# Safely upgrades one tenant stack with optional backup and health verification.
#
# Usage:
#   ./upgrade-project.sh <project_ref> [service1 service2 ...]
#
# Env:
#   SKIP_BACKUP=1              Skip pre-upgrade backup (not recommended)
#   HEALTH_URL=https://...     Override tenant health URL
#   HEALTH_RETRIES=24          Number of health attempts
#   HEALTH_SLEEP=5             Seconds between health attempts
#   ROLLBACK_ON_FAIL=1         Restart previous running containers on failure

set -euo pipefail

PROJECT_REF="${1:?Usage: upgrade-project.sh <project_ref> [services...]}"
shift
SERVICES=("$@")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECTS_DIR="$REPO_ROOT/infra/projects"
COMPOSE_FILE="$PROJECTS_DIR/$PROJECT_REF/docker-compose.yml"

HEALTH_URL="${HEALTH_URL:-https://${PROJECT_REF}.db.hconsulting.app/rest/v1/}"
HEALTH_RETRIES="${HEALTH_RETRIES:-24}"
HEALTH_SLEEP="${HEALTH_SLEEP:-5}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
ROLLBACK_ON_FAIL="${ROLLBACK_ON_FAIL:-1}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[ERROR] docker-compose.yml not found for project: $PROJECT_REF" >&2
  exit 1
fi

echo "== SupaNow tenant upgrade =="
echo "project_ref=$PROJECT_REF"
if [[ ${#SERVICES[@]} -eq 0 ]]; then
  echo "components=all"
else
  echo "components=${SERVICES[*]}"
fi

if [[ "$SKIP_BACKUP" != "1" ]]; then
  echo "phase=backup"
  "$SCRIPT_DIR/backup.sh" "$PROJECT_REF"
else
  echo "phase=backup skipped"
fi

echo "phase=pull"
if [[ ${#SERVICES[@]} -eq 0 ]]; then
  docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" pull
else
  docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" pull "${SERVICES[@]}"
fi

echo "phase=up"
if [[ ${#SERVICES[@]} -eq 0 ]]; then
  docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" up -d --remove-orphans
else
  docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" up -d --no-deps "${SERVICES[@]}"
fi

echo "phase=health"
for attempt in $(seq 1 "$HEALTH_RETRIES"); do
  status="$(curl -sS --max-time 8 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || printf '000')"
  if [[ "$status" =~ ^[234][0-9][0-9]$ || "$status" == "401" || "$status" == "403" ]]; then
    echo "health=ok attempt=$attempt status=$status url=$HEALTH_URL"
    echo "phase=complete"
    exit 0
  fi
  echo "health=pending attempt=$attempt/$HEALTH_RETRIES status=$status"
  sleep "$HEALTH_SLEEP"
done

echo "[ERROR] Health check failed after upgrade: $HEALTH_URL" >&2
if [[ "$ROLLBACK_ON_FAIL" == "1" ]]; then
  echo "phase=rollback-restart"
  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" restart || true
  else
    docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" restart "${SERVICES[@]}" || true
  fi
fi
exit 1
