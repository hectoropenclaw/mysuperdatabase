-- 006_data_plane_operations.sql
-- Per-tenant operational controls for SupaNow data plane, Auth, and Storage.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS quotas JSONB NOT NULL DEFAULT jsonb_build_object(
    'storage_mb', 1024,
    'db_size_mb', 1024,
    'api_requests_per_hour', 5000,
    'auth_mau', 10000,
    'edge_functions', 25
  ),
  ADD COLUMN IF NOT EXISTS component_versions JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS project_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_audit_events_project_created
  ON project_audit_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_service_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'unhealthy', 'unknown')),
  latency_ms INTEGER,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, service)
);

CREATE INDEX IF NOT EXISTS idx_project_service_health_project
  ON project_service_health(project_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS auth_email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  subject TEXT,
  body_html TEXT,
  body_text TEXT,
  redirect_to TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, template)
);

CREATE TABLE IF NOT EXISTS storage_bucket_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL,
  quota_mb INTEGER,
  max_file_size_bytes BIGINT,
  allowed_mime_types TEXT[],
  lifecycle JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, bucket_id)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'auth_email_templates_updated_at') THEN
    CREATE TRIGGER auth_email_templates_updated_at
      BEFORE UPDATE ON auth_email_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'storage_bucket_settings_updated_at') THEN
    CREATE TRIGGER storage_bucket_settings_updated_at
      BEFORE UPDATE ON storage_bucket_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
END $$;
