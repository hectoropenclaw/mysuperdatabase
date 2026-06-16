#!/usr/bin/env bash
# supanow — install-ops-timer.sh
# Installs a user-level systemd timer for SupaNow P1 operational jobs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"

mkdir -p "$SYSTEMD_USER_DIR"

cat > "$SYSTEMD_USER_DIR/supanow-ops.service" <<EOF
[Unit]
Description=SupaNow tenant operations runner

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
ExecStart=${REPO_ROOT}/infra/scripts/run-ops-jobs.sh
Nice=5
EOF

cat > "$SYSTEMD_USER_DIR/supanow-ops.timer" <<'EOF'
[Unit]
Description=Run SupaNow tenant operations every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now supanow-ops.timer
systemctl --user list-timers --all | grep supanow-ops || true

echo "SupaNow ops timer installed."
