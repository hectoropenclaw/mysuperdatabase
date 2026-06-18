-- 014_pitr_offsite_wal.sql
-- Track WAL segments synced out of the tenant DB container.

ALTER TABLE project_pitr_status
  ADD COLUMN IF NOT EXISTS offsite_wal_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latest_offsite_wal TEXT,
  ADD COLUMN IF NOT EXISTS offsite_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS offsite_error TEXT;
