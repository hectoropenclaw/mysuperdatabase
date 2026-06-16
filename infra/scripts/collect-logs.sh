#!/usr/bin/env bash
# supanow — collect-logs.sh
# Emits JSON lines for recent Docker Compose logs from one tenant project.
#
# Usage:
#   ./collect-logs.sh <project_ref> [since_minutes]

set -euo pipefail

PROJECT_REF="${1:?Usage: collect-logs.sh <project_ref> [since_minutes]}"
SINCE_MINUTES="${2:-20}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/projects/$PROJECT_REF/docker-compose.yml"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[ERROR] docker-compose.yml not found for project: $PROJECT_REF" >&2
  exit 1
fi

TMP_LOGS="$(mktemp)"
trap 'rm -f "$TMP_LOGS"' EXIT

docker compose -f "$COMPOSE_FILE" --project-name "spn-${PROJECT_REF}" logs \
  --no-color \
  --no-log-prefix=false \
  --since "${SINCE_MINUTES}m" > "$TMP_LOGS"

python3 - "$PROJECT_REF" "$TMP_LOGS" <<'PY'
import datetime as dt
import hashlib
import json
import re
import sys

project_ref = sys.argv[1]
logs_path = sys.argv[2]
now = dt.datetime.now(dt.timezone.utc).isoformat()
level_re = re.compile(r"\b(error|err|fatal|panic|warn|warning|info|debug|trace)\b", re.I)

for raw in open(logs_path, encoding="utf-8", errors="replace"):
    line = raw.rstrip("\n")
    if not line.strip():
        continue
    service = "unknown"
    message = line
    if "|" in line:
        left, right = line.split("|", 1)
        service = left.strip().split()[0] or "unknown"
        message = right.strip()
    match = level_re.search(message)
    level = (match.group(1).lower() if match else "info").replace("warning", "warn").replace("err", "error")
    fingerprint = hashlib.sha256(f"{project_ref}:{service}:{message}".encode()).hexdigest()
    print(json.dumps({
        "service": service,
        "level": level,
        "message": message[-4000:],
        "metadata": {"project_ref": project_ref},
        "fingerprint": fingerprint,
        "occurred_at": now,
    }, separators=(",", ":")))
PY
