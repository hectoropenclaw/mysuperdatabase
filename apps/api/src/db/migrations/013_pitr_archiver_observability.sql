-- 013_pitr_archiver_observability.sql
-- Capture pg_stat_archiver evidence so PITR status reflects actual WAL archive
-- activity, not only static PostgreSQL settings.

ALTER TABLE project_pitr_status
  ADD COLUMN IF NOT EXISTS archiver_failed_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_archived_wal TEXT,
  ADD COLUMN IF NOT EXISTS last_archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failed_wal TEXT,
  ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;
