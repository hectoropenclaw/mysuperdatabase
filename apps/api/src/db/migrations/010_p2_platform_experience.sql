-- 010_p2_platform_experience.sql
-- P2 Studio/UX substrate: SQL editor history/snippets, auth template previews,
-- storage browser helpers, and realtime debug sessions.

CREATE TABLE IF NOT EXISTS sql_query_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'blocked')),
  is_write BOOLEAN NOT NULL DEFAULT FALSE,
  duration_ms INTEGER,
  row_count INTEGER,
  error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sql_query_history_project_created
  ON sql_query_history(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sql_snippets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sql TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_sql_snippets_project_created
  ON sql_snippets(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_email_test_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  body_preview TEXT,
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'queued', 'sent', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_email_test_events_project_created
  ON auth_email_test_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS realtime_debug_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'broadcast',
  client_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'tested', 'failed')),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_realtime_debug_sessions_project_created
  ON realtime_debug_sessions(project_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sql_snippets_updated_at') THEN
    CREATE TRIGGER sql_snippets_updated_at
      BEFORE UPDATE ON sql_snippets FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'realtime_debug_sessions_updated_at') THEN
    CREATE TRIGGER realtime_debug_sessions_updated_at
      BEFORE UPDATE ON realtime_debug_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
END $$;
