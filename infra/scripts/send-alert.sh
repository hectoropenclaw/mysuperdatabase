#!/usr/bin/env bash
# supanow - send-alert.sh
# Sends operational alerts to a generic webhook. If ALERT_WEBHOOK_URL is unset,
# exits successfully with a suppressed result.

set -euo pipefail

SEVERITY="${SEVERITY:-warning}"
EVENT_TYPE="${EVENT_TYPE:-supanow.alert}"
TITLE="${TITLE:-SupaNow alert}"
MESSAGE="${MESSAGE:-}"
PROJECT_REF="${PROJECT_REF:-}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
PAYLOAD="${PAYLOAD:-{}}"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
  printf '{"status":"suppressed","reason":"ALERT_WEBHOOK_URL is not configured"}\n'
  exit 0
fi

body="$(cat <<JSON
{
  "severity": "$(printf "%s" "$SEVERITY" | json_escape)",
  "event_type": "$(printf "%s" "$EVENT_TYPE" | json_escape)",
  "title": "$(printf "%s" "$TITLE" | json_escape)",
  "message": "$(printf "%s" "$MESSAGE" | json_escape)",
  "project_ref": "$(printf "%s" "$PROJECT_REF" | json_escape)",
  "payload": $PAYLOAD
}
JSON
)"

status="$(curl -sS --max-time 10 -o /tmp/supanow-alert-response.txt -w "%{http_code}" \
  -H "Content-Type: application/json" \
  --data "$body" \
  "$ALERT_WEBHOOK_URL" || printf '000')"

if [[ "$status" =~ ^2 ]]; then
  printf '{"status":"sent","http_status":%s}\n' "$status"
else
  error="$(cat /tmp/supanow-alert-response.txt 2>/dev/null || true)"
  printf '{"status":"failed","http_status":%s,"error":"%s"}\n' "$status" "$(printf "%s" "$error" | json_escape)"
  exit 1
fi
