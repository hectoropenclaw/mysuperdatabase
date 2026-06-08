-- 002_auth_config.sql
-- Adds per-project auth configuration storage

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS auth_config JSONB DEFAULT '{}';

COMMENT ON COLUMN projects.auth_config IS
  'Stores GoTrue configuration overrides for this project. '
  'Applied by update-auth-config.sh when changed via platform API.';
