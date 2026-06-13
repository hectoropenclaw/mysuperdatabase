-- 007_realtime_auth_storage_maturity.sql
-- Operational controls for Auth, Storage, and Realtime per tenant.

ALTER TABLE projects
  ALTER COLUMN quotas SET DEFAULT jsonb_build_object(
    'storage_mb', 1024,
    'db_size_mb', 1024,
    'api_requests_per_hour', 5000,
    'auth_mau', 10000,
    'edge_functions', 25,
    'realtime_peak_connections', 200,
    'realtime_messages_per_hour', 100000,
    'storage_transforms_per_hour', 1000
  );

UPDATE projects
SET quotas = jsonb_build_object(
    'storage_mb', 1024,
    'db_size_mb', 1024,
    'api_requests_per_hour', 5000,
    'auth_mau', 10000,
    'edge_functions', 25,
    'realtime_peak_connections', 200,
    'realtime_messages_per_hour', 100000,
    'storage_transforms_per_hour', 1000
  ) || quotas;

CREATE TABLE IF NOT EXISTS auth_provider_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  client_id TEXT,
  secret_ref TEXT,
  scopes TEXT[] NOT NULL DEFAULT '{}'::text[],
  redirect_uri TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, provider)
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email_per_hour INTEGER NOT NULL DEFAULT 30,
  sms_per_hour INTEGER NOT NULL DEFAULT 10,
  token_refresh_per_minute INTEGER NOT NULL DEFAULT 60,
  anonymous_signins_per_hour INTEGER NOT NULL DEFAULT 60,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id)
);

CREATE TABLE IF NOT EXISTS auth_mfa_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  totp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  phone_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  issuer TEXT NOT NULL DEFAULT 'supanow',
  max_enrollment_frequency_seconds INTEGER NOT NULL DEFAULT 0,
  require_for_admins BOOLEAN NOT NULL DEFAULT FALSE,
  require_for_all_users BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_codes_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id)
);

CREATE TABLE IF NOT EXISTS storage_transform_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL,
  name TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, bucket_id, name)
);

CREATE TABLE IF NOT EXISTS storage_lifecycle_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'completed', 'failed')),
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  rule JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_lifecycle_runs_project_created
  ON storage_lifecycle_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS realtime_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  presence_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  broadcast_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  postgres_changes_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  max_channels_per_client INTEGER NOT NULL DEFAULT 100,
  max_events_per_second INTEGER NOT NULL DEFAULT 100,
  max_payload_kb INTEGER NOT NULL DEFAULT 256,
  retention_hours INTEGER NOT NULL DEFAULT 24,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id)
);

CREATE TABLE IF NOT EXISTS realtime_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL DEFAULT CURRENT_DATE,
  cdc_tables INTEGER NOT NULL DEFAULT 0,
  active_channels INTEGER NOT NULL DEFAULT 0,
  presence_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  broadcast_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  postgres_changes_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  health JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, metric_date)
);

CREATE TABLE IF NOT EXISTS realtime_debug_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  channel TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_realtime_debug_events_project_created
  ON realtime_debug_events(project_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'auth_provider_configs_updated_at') THEN
    CREATE TRIGGER auth_provider_configs_updated_at
      BEFORE UPDATE ON auth_provider_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'auth_rate_limits_updated_at') THEN
    CREATE TRIGGER auth_rate_limits_updated_at
      BEFORE UPDATE ON auth_rate_limits FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'auth_mfa_policies_updated_at') THEN
    CREATE TRIGGER auth_mfa_policies_updated_at
      BEFORE UPDATE ON auth_mfa_policies FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'storage_transform_presets_updated_at') THEN
    CREATE TRIGGER storage_transform_presets_updated_at
      BEFORE UPDATE ON storage_transform_presets FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'realtime_settings_updated_at') THEN
    CREATE TRIGGER realtime_settings_updated_at
      BEFORE UPDATE ON realtime_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
END $$;
