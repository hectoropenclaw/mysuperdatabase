#!/usr/bin/env bash
# supanow - audit-secrets.sh
# Scans tracked files and local git config for high-risk secret patterns without
# printing the secret value.

set -euo pipefail

ROOT_DIR="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT_DIR"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

scan_stream() {
  local source="$1"
  local pattern="$2"
  local label="$3"
  awk -v source="$source" -v label="$label" -v pattern="$pattern" '
    $0 ~ pattern {
      printf "%s\t%s\tline %s\n", label, source, NR
    }
  '
}

git ls-files -z \
  | xargs -0 grep -InE \
    'github_pat_|ghp_[A-Za-z0-9_]{20,}|glpat-|xox[baprs]-|sk-[A-Za-z0-9]{20,}|SUPABASE_SERVICE_ROLE(_KEY)?=|VERCEL_TOKEN=|CLOUDFLARE_API_TOKEN=' \
    2>/dev/null \
  | grep -v '^apps/studio/evals/dataset.ts:' \
  | grep -v '^infra/scripts/audit-secrets.sh:' \
  | awk -F: '{printf "%s\t%s\tline %s\n", "tracked-file", $1, $2}' \
  > "$TMP_FILE" || true

if [[ -f .git/config ]]; then
  scan_stream ".git/config" 'github_pat_|ghp_[A-Za-z0-9_]{20,}|glpat-|VERCEL_TOKEN|CLOUDFLARE_API_TOKEN' "git-config" \
    < .git/config >> "$TMP_FILE" || true
fi

if [[ -s "$TMP_FILE" ]]; then
  sort -u "$TMP_FILE"
  echo "secret_audit_status=failed"
  exit 1
fi

echo "secret_audit_status=passed"
