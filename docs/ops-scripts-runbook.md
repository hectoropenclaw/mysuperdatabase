# SupaNow Ops Scripts Runbook

Last reviewed: 2026-06-17

## Where to run scripts

Run these scripts on the host that has access to:

- Docker tenant containers such as `spn-<project_ref>-db-1`.
- The control-plane database container `spn-cp-db`.
- MinIO/S3 used by `BACKUP_BUCKET`.
- The SupaNow repository checkout.

On the current H Consulting machine, run from:

```bash
cd /home/hector.openclaw/supanow
```

## Core commands

Enable PITR/WAL archiving for one tenant:

```bash
infra/scripts/enable-pitr.sh whatsclear
```

Collect PITR status:

```bash
infra/scripts/pitr-status.sh whatsclear
```

Sync archived WAL segments offsite to MinIO/S3:

```bash
infra/scripts/sync-wal-archive.sh whatsclear
```

Create, verify, and restore-drill a backup:

```bash
infra/scripts/backup.sh whatsclear
infra/scripts/verify-backup.sh whatsclear
infra/scripts/restore-drill.sh whatsclear
```

Run due operational jobs:

```bash
DATABASE_URL='postgresql://postgres:<password>@localhost:5433/supanow_cp' \
  node apps/api/src/jobs/ops-runner.mjs
```

Audit for accidental secrets before commits/deploys:

```bash
infra/scripts/audit-secrets.sh
```

## Cloudflare Tunnel

The active tunnel on this machine is `launchpad-local`.

Route a hostname in the authenticated Cloudflare zone:

```bash
cloudflared tunnel route dns --overwrite-dns launchpad-local supanow.hconsulting.app
```

Check public routing:

```bash
curl -I https://supanow.hconsulting.app
```

Note: this `cloudflared` login is scoped to `hconsulting.app`. It cannot correctly create `hconsulting.mx` records unless the Cloudflare certificate/token also has access to that zone.
