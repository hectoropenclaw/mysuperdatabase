#!/usr/bin/env bash
# supanow — run-ops-jobs.sh
# Runs due P1 operational jobs: health, usage, advisors, logs, realtime metrics.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -f "$REPO_ROOT/apps/api/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/apps/api/.env.local"
  set +a
elif [[ -f "$REPO_ROOT/apps/api/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/apps/api/.env.production"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[ERROR] DATABASE_URL is required" >&2
  exit 1
fi

cd "$REPO_ROOT/apps/api"
node src/jobs/ops-runner.mjs
