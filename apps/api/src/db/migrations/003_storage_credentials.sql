-- 003_storage_credentials.sql
-- Per-project S3 credential pairs (stored alongside service keys in projects table)

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS storage_s3_access_key TEXT,
  ADD COLUMN IF NOT EXISTS storage_s3_secret_key TEXT;

COMMENT ON COLUMN projects.storage_s3_access_key IS
  'S3-compatible access key for this project''s MinIO bucket (created by provision.sh)';
COMMENT ON COLUMN projects.storage_s3_secret_key IS
  'S3-compatible secret key for this project''s MinIO bucket';
