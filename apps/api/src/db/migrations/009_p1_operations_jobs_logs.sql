-- 009_p1_operations_jobs_logs.sql
-- P1 production operations: scheduled jobs, tenant logs, and operation runs.

CREATE TABLE IF NOT EXISTS project_operation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  log TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_operation_runs_project_started
  ON project_operation_runs(project_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_operation_runs_type_started
  ON project_operation_runs(job_type, started_at DESC);

CREATE TABLE IF NOT EXISTS project_job_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, job_type)
);

CREATE INDEX IF NOT EXISTS idx_project_job_schedules_due
  ON project_job_schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS project_log_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_project_log_entries_project_occurred
  ON project_log_entries(project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_log_entries_project_service
  ON project_log_entries(project_id, service, occurred_at DESC);

INSERT INTO project_job_schedules(project_id, job_type, interval_minutes, config)
SELECT id, job_type, interval_minutes, config
FROM projects
CROSS JOIN (
  VALUES
    ('service_health', 5, '{}'::jsonb),
    ('usage_collect', 60, '{}'::jsonb),
    ('advisor_run', 1440, '{}'::jsonb),
    ('log_collect', 15, jsonb_build_object('since_minutes', 20)),
    ('realtime_metrics', 60, '{}'::jsonb)
) defaults(job_type, interval_minutes, config)
WHERE status='active'
ON CONFLICT(project_id, job_type) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'project_job_schedules_updated_at') THEN
    CREATE TRIGGER project_job_schedules_updated_at
      BEFORE UPDATE ON project_job_schedules FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
END $$;
