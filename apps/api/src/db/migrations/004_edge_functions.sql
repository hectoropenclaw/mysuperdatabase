-- 004_edge_functions.sql

CREATE TABLE IF NOT EXISTS edge_functions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  verify_jwt  BOOLEAN NOT NULL DEFAULT true,
  entrypoint_path TEXT NOT NULL DEFAULT 'index.ts',
  import_map_path TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS secrets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, name)
);

CREATE OR REPLACE FUNCTION update_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'edge_functions_updated_at') THEN
    CREATE TRIGGER edge_functions_updated_at
      BEFORE UPDATE ON edge_functions FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'secrets_updated_at') THEN
    CREATE TRIGGER secrets_updated_at
      BEFORE UPDATE ON secrets FOR EACH ROW EXECUTE FUNCTION update_updated_at_fn();
  END IF;
END $$;
