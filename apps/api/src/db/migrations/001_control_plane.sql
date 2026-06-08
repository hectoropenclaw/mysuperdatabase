-- mysuperdatabase — Control Plane Schema
-- Run against the standalone control plane PostgreSQL instance.
-- This DB is NOT a project DB — it manages organizations, projects, and billing.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Organizations ────────────────────────────────────────────────────────────
CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  plan            text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  name            text,
  avatar_url      text,
  github_id       text UNIQUE,
  google_id       text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ─── Organization Members ─────────────────────────────────────────────────────
CREATE TABLE org_members (
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (org_id, user_id)
);

-- ─── Projects ────────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             varchar(20) NOT NULL UNIQUE,
  name            text NOT NULL,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'provisioning'
                  CHECK (status IN ('provisioning', 'active', 'paused', 'deleted', 'error')),
  region          text NOT NULL DEFAULT 'mx-central-1',
  db_host         text,
  db_port         integer DEFAULT 5432,
  jwt_secret      text,
  anon_key        text,
  service_role_key text,
  db_password     text,
  site_url        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ─── Usage Metrics ───────────────────────────────────────────────────────────
CREATE TABLE usage_metrics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric_date date NOT NULL DEFAULT CURRENT_DATE,
  db_size_mb  numeric DEFAULT 0,
  api_requests bigint DEFAULT 0,
  auth_mau    integer DEFAULT 0,
  storage_mb  numeric DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, metric_date)
);

-- ─── NextAuth Sessions (for control plane auth) ───────────────────────────────
CREATE TABLE nextauth_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              text NOT NULL,
  provider_account_id   text NOT NULL,
  refresh_token         text,
  access_token          text,
  expires_at            bigint,
  token_type            text,
  scope                 text,
  id_token              text,
  session_state         text,
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE nextauth_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires       timestamptz NOT NULL
);

CREATE TABLE nextauth_verification_tokens (
  identifier  text NOT NULL,
  token       text NOT NULL UNIQUE,
  expires     timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX idx_projects_org_id    ON projects(org_id);
CREATE INDEX idx_projects_ref       ON projects(ref);
CREATE INDEX idx_org_members_user   ON org_members(user_id);
CREATE INDEX idx_usage_project_date ON usage_metrics(project_id, metric_date DESC);

-- ─── Updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
