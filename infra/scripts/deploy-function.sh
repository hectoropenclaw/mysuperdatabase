#!/usr/bin/env bash
# supanow — deploy-function.sh
# Writes edge function files into the project's edge-runtime container.
#
# Usage (called by management API):
#   echo '{"files":[{"name":"index.ts","content":"..."}]}' \
#     | ./deploy-function.sh <project_ref> <slug>
#
# Reads JSON from stdin: { "files": [{ "name": string, "content": string }] }
# Exits 0 on success, non-zero on failure.

set -euo pipefail

PROJECT_REF="${1:?Usage: deploy-function.sh <project_ref> <slug>}"
SLUG="${2:?Usage: deploy-function.sh <project_ref> <slug>}"

CONTAINER="spn-${PROJECT_REF}-edge-runtime-1"

# Read JSON from stdin
PAYLOAD="$(cat)"

# Check container is running
if ! docker inspect "$CONTAINER" --format "{{.State.Running}}" 2>/dev/null | grep -q true; then
  echo "[ERROR] Container $CONTAINER is not running" >&2
  exit 1
fi

# Create function directory inside container
docker exec "$CONTAINER" mkdir -p "/home/deno/functions/${SLUG}"

# Write each file using Python-parsed JSON (busybox sh doesn't have JSON tools)
echo "$PAYLOAD" | python3 - "$CONTAINER" "$SLUG" <<'PYEOF'
import sys, json, subprocess, base64

container = sys.argv[1]
slug = sys.argv[2]
payload = json.load(sys.stdin)

for f in payload.get('files', []):
    name = f['name']
    content = f['content']
    path = f"/home/deno/functions/{slug}/{name}"
    # Create parent dir for nested files
    parent = path.rsplit('/', 1)[0]
    subprocess.run(['docker', 'exec', container, 'mkdir', '-p', parent], check=True)
    # Write via stdin pipe
    proc = subprocess.run(
        ['docker', 'exec', '-i', container, 'sh', '-c', f'cat > {path}'],
        input=content.encode(),
        check=True
    )

print(f"[deploy-function] {len(payload.get('files', []))} file(s) written for {slug}")
PYEOF

echo "✓ Function '${SLUG}' deployed to $CONTAINER"
