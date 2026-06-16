-- 008_project_upgrade_runs.sql
-- Safe, auditable upgrade executions for per-project data plane stacks.

CREATE TABLE IF NOT EXISTS project_upgrade_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'rolled_back')),
  components TEXT[] NOT NULL DEFAULT '{}'::text[],
  from_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  to_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  backup_id UUID REFERENCES project_backups(id) ON DELETE SET NULL,
  backup_key TEXT,
  log TEXT,
  error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_upgrade_runs_project_created
  ON project_upgrade_runs(project_id, created_at DESC);
