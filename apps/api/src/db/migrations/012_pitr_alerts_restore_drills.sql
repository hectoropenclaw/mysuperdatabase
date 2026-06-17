-- 012_pitr_alerts_restore_drills.sql
-- Production readiness: PITR status, restore drills, and operational alerts.

CREATE TABLE IF NOT EXISTS project_pitr_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'unknown', 'failed')),
  wal_level TEXT,
  archive_mode TEXT,
  archive_command TEXT,
  archived_wal_count INTEGER NOT NULL DEFAULT 0,
  latest_wal TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_project_pitr_status_project_checked
  ON project_pitr_status(project_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS project_restore_drills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backup_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'verified', 'failed')),
  duration_ms INTEGER,
  temp_database TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_project_restore_drills_project_checked
  ON project_restore_drills(project_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS project_alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued', 'sent', 'failed', 'suppressed')),
  delivery_target TEXT,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_alert_events_project_created
  ON project_alert_events(project_id, created_at DESC);

INSERT INTO project_job_schedules(project_id, job_type, interval_minutes, config)
SELECT id, job_type, interval_minutes, config
FROM projects
CROSS JOIN (
  VALUES
    ('pitr_status', 1440, '{}'::jsonb),
    ('restore_drill', 10080, '{}'::jsonb)
) defaults(job_type, interval_minutes, config)
WHERE status='active'
ON CONFLICT(project_id, job_type) DO NOTHING;
