-- 005_studio_operations.sql
-- Operational records used by SupaNow Studio: schema snapshots, advisor runs,
-- backups/restores, and project branches.

CREATE TABLE IF NOT EXISTS schema_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'manual',
  schema_hash TEXT NOT NULL,
  schema_json JSONB NOT NULL,
  diff_from_snapshot_id UUID REFERENCES schema_snapshots(id) ON DELETE SET NULL,
  diff_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schema_snapshots_project_created
  ON schema_snapshots(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS advisor_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  source TEXT NOT NULL DEFAULT 'pg-meta',
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advisor_runs_project_created
  ON advisor_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  backup_key TEXT,
  size_bytes BIGINT,
  restore_of_backup_id UUID REFERENCES project_backups(id) ON DELETE SET NULL,
  error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_project_backups_project_created
  ON project_backups(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'ready', 'failed', 'deleted')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_branches_source_created
  ON project_branches(source_project_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'project_branches_updated_at') THEN
    CREATE TRIGGER project_branches_updated_at
      BEFORE UPDATE ON project_branches FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
END $$;
