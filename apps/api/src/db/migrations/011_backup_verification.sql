-- 011_backup_verification.sql
-- Tracks backup verification probes so backups are not only created, but
-- periodically proven readable.

ALTER TABLE project_backups
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_status TEXT
    CHECK (verification_status IN ('pending', 'verified', 'failed')),
  ADD COLUMN IF NOT EXISTS verification_error TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS project_backup_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backup_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'failed')),
  size_bytes BIGINT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_project_backup_verifications_project_checked
  ON project_backup_verifications(project_id, checked_at DESC);

INSERT INTO project_job_schedules(project_id, job_type, interval_minutes, config)
SELECT id, 'backup_verify', 1440, '{}'::jsonb
FROM projects
WHERE status='active'
ON CONFLICT(project_id, job_type) DO NOTHING;
