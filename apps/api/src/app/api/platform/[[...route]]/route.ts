import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import crypto from 'crypto'
import { existsSync } from 'fs'
import { auth } from '@/lib/auth'
import pool from '@/db/client'

const execAsync = promisify(exec)
const cwdScriptsDir = path.resolve(process.cwd(), 'infra/scripts')
const SCRIPTS_DIR = process.env.SUPANOW_SCRIPTS_DIR
  ?? (existsSync(cwdScriptsDir) ? cwdScriptsDir : path.resolve(process.cwd(), '../../infra/scripts'))

export const runtime = 'nodejs'

type Env = { Variables: { userId: string; userEmail: string } }

const app = new Hono<Env>().basePath('/api/platform')
const REF_RE = /^[a-z0-9]{6,32}$/
const COMPONENT_VERSIONS = {
  postgres: 'supabase/postgres:15.8.1.085',
  postgrest: 'postgrest/postgrest:v14.12',
  gotrue: 'supabase/gotrue:v2.189.0',
  realtime: 'supabase/realtime:v2.102.3',
  storage: 'supabase/storage-api:v1.60.4',
  pgMeta: 'supabase/postgres-meta:v0.96.6',
  edgeRuntime: 'supabase/edge-runtime:v1.74.0',
  kong: 'kong/kong:3.9.1',
}
const COMPONENT_SERVICES: Record<string, string> = {
  postgres: 'db',
  postgrest: 'rest',
  gotrue: 'auth',
  realtime: 'realtime',
  storage: 'storage',
  pgMeta: 'meta',
  edgeRuntime: 'edge-runtime',
  kong: 'kong',
}

function parseBackupKey(stdout: string) {
  const match = stdout.match(new RegExp('backed up .*? [^/]+/(.+?\\.sql\\.gz)'))
  return match?.[1] ?? null
}
const AUTH_PROVIDER_KEYS: Record<string, { enabled: string; clientId: string; secret: string; extra?: string[] }> = {
  github: { enabled: 'EXTERNAL_GITHUB_ENABLED', clientId: 'EXTERNAL_GITHUB_CLIENT_ID', secret: 'EXTERNAL_GITHUB_SECRET' },
  google: { enabled: 'EXTERNAL_GOOGLE_ENABLED', clientId: 'EXTERNAL_GOOGLE_CLIENT_ID', secret: 'EXTERNAL_GOOGLE_SECRET' },
  discord: { enabled: 'EXTERNAL_DISCORD_ENABLED', clientId: 'EXTERNAL_DISCORD_CLIENT_ID', secret: 'EXTERNAL_DISCORD_SECRET' },
  twitter: { enabled: 'EXTERNAL_TWITTER_ENABLED', clientId: 'EXTERNAL_TWITTER_CLIENT_ID', secret: 'EXTERNAL_TWITTER_SECRET' },
  facebook: { enabled: 'EXTERNAL_FACEBOOK_ENABLED', clientId: 'EXTERNAL_FACEBOOK_CLIENT_ID', secret: 'EXTERNAL_FACEBOOK_SECRET' },
  apple: { enabled: 'EXTERNAL_APPLE_ENABLED', clientId: 'EXTERNAL_APPLE_CLIENT_ID', secret: 'EXTERNAL_APPLE_SECRET' },
  linkedin_oidc: { enabled: 'EXTERNAL_LINKEDIN_OIDC_ENABLED', clientId: 'EXTERNAL_LINKEDIN_OIDC_CLIENT_ID', secret: 'EXTERNAL_LINKEDIN_OIDC_SECRET' },
  slack_oidc: { enabled: 'EXTERNAL_SLACK_OIDC_ENABLED', clientId: 'EXTERNAL_SLACK_OIDC_CLIENT_ID', secret: 'EXTERNAL_SLACK_OIDC_SECRET' },
  twitch: { enabled: 'EXTERNAL_TWITCH_ENABLED', clientId: 'EXTERNAL_TWITCH_CLIENT_ID', secret: 'EXTERNAL_TWITCH_SECRET' },
  spotify: { enabled: 'EXTERNAL_SPOTIFY_ENABLED', clientId: 'EXTERNAL_SPOTIFY_CLIENT_ID', secret: 'EXTERNAL_SPOTIFY_SECRET' },
  gitlab: { enabled: 'EXTERNAL_GITLAB_ENABLED', clientId: 'EXTERNAL_GITLAB_CLIENT_ID', secret: 'EXTERNAL_GITLAB_SECRET', extra: ['EXTERNAL_GITLAB_URL'] },
  bitbucket: { enabled: 'EXTERNAL_BITBUCKET_ENABLED', clientId: 'EXTERNAL_BITBUCKET_CLIENT_ID', secret: 'EXTERNAL_BITBUCKET_SECRET' },
}

async function auditEvent(
  projectId: string | null,
  actorUserId: string | null,
  eventType: string,
  metadata: Record<string, unknown> = {},
  targetType?: string,
  targetId?: string
) {
  await pool.query(
    `INSERT INTO project_audit_events
       (project_id, actor_user_id, event_type, target_type, target_id, metadata)
     VALUES($1, $2, $3, $4, $5, $6)`,
    [projectId, actorUserId, eventType, targetType ?? null, targetId ?? null, JSON.stringify(metadata)]
  ).catch((err) => console.error(`[audit] ${eventType}:`, err.message))
}

async function timedProbe(name: string, url: string, headers: Record<string, string> = {}) {
  const started = Date.now()
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) })
    return {
      service: name,
      status: res.ok || res.status === 401 ? 'healthy' : 'unhealthy',
      latency_ms: Date.now() - started,
      detail: { http_status: res.status },
    }
  } catch (err: any) {
    return {
      service: name,
      status: 'unhealthy',
      latency_ms: Date.now() - started,
      detail: { error: err.message },
    }
  }
}

// ─── Auth middleware ─────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const session = await auth()
  if (!session?.user?.id) {
    return c.json({ message: 'Unauthorized' }, 401)
  }
  c.set('userId', session.user.id)
  c.set('userEmail', session.user.email ?? '')
  await next()
})

// ─── GET /platform/profile ───────────────────────────────────────────────────
app.get('/profile', async (c) => {
  const userId = c.get('userId')
  const email = c.get('userEmail')
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [userId])
  const user = rows[0]
  if (!user) return c.json({ message: 'User not found' }, 404)

  return c.json({
    auth0_id: userId,
    gotrue_id: userId,
    id: user.id,
    primary_email: email,
    username: user.name ?? email.split('@')[0],
    first_name: null,
    last_name: null,
    mobile: null,
    is_alpha_user: false,
    is_sso_user: false,
    free_project_limit: 2,
    disabled_features: [],
    opt_in_tags: [],
  })
})

// ─── GET /platform/organizations ─────────────────────────────────────────────
app.get('/organizations', async (c) => {
  const userId = c.get('userId')
  const { rows } = await pool.query(
    `SELECT o.*, om.role, om.user_id = $1 AS is_owner
     FROM organizations o
     JOIN org_members om ON om.org_id = o.id
     WHERE om.user_id=$1 ORDER BY o.created_at DESC`,
    [userId]
  )

  const orgs = rows.map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    billing_email: o.billing_email ?? null,
    billing_partner: null,
    integration_source: null,
    is_owner: o.role === 'owner',
    opt_in_tags: [],
    organization_missing_address: false,
    organization_missing_tax_id: false,
    organization_requires_mfa: false,
    plan: {
      id: o.plan ?? 'free',
      name: o.plan === 'pro' ? 'Pro' : o.plan === 'team' ? 'Team' : 'Free',
    },
    restriction_data: null,
    restriction_status: null,
  }))

  return c.json(orgs)
})

// ─── GET /platform/organizations/:slug ───────────────────────────────────────
app.get('/organizations/:slug', async (c) => {
  const userId = c.get('userId')
  const { slug } = c.req.param()
  const { rows } = await pool.query(
    `SELECT o.*, om.role FROM organizations o
     JOIN org_members om ON om.org_id = o.id
     WHERE o.slug=$1 AND om.user_id=$2`,
    [slug, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)
  const o = rows[0]
  return c.json({
    id: o.id,
    name: o.name,
    slug: o.slug,
    billing_email: o.billing_email ?? null,
    billing_partner: null,
    integration_source: null,
    is_owner: o.role === 'owner',
    opt_in_tags: [],
    organization_missing_address: false,
    organization_missing_tax_id: false,
    organization_requires_mfa: false,
    plan: { id: o.plan ?? 'free', name: o.plan === 'pro' ? 'Pro' : 'Free' },
    restriction_data: null,
    restriction_status: null,
  })
})

// ─── POST /platform/organizations ────────────────────────────────────────────
app.post('/organizations', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json()
  const { name } = body
  if (!name) return c.json({ message: 'name is required' }, 400)

  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'INSERT INTO organizations(name, slug) VALUES($1, $2) RETURNING *',
      [name, slug]
    )
    await client.query(
      "INSERT INTO org_members(org_id, user_id, role) VALUES($1, $2, 'owner')",
      [rows[0].id, userId]
    )
    await client.query('COMMIT')
    const o = rows[0]
    return c.json({ id: o.id, name: o.name, slug: o.slug, plan: { id: 'free', name: 'Free' } }, 201)
  } catch (err: any) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})

// ─── GET /platform/projects ───────────────────────────────────────────────────
app.get('/projects', async (c) => {
  const userId = c.get('userId')
  const limit = parseInt(c.req.query('limit') ?? '100')
  const offset = parseInt(c.req.query('offset') ?? '0')

  const { rows } = await pool.query(
    `SELECT p.*, o.slug as org_slug FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     JOIN organizations o ON o.id = p.org_id
     WHERE om.user_id=$1 AND p.status != 'deleted'
     ORDER BY p.name ASC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  )
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE om.user_id=$1 AND p.status != 'deleted'`,
    [userId]
  )

  const projects = rows.map((p) => projectToStudioShape(p))
  return c.json({
    projects,
    pagination: { count: parseInt(countRows[0].count), limit, offset },
  })
})

// ─── POST /platform/projects/import ──────────────────────────────────────────
app.post('/projects/import', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))
  const ref = String(body.ref ?? '').trim()
  const organizationId = body.organization_id ?? body.org_id
  if (!REF_RE.test(ref) || !organizationId) {
    return c.json({ message: 'ref and organization_id are required' }, 400)
  }

  const { rows: membership } = await pool.query(
    'SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2',
    [organizationId, userId]
  )
  if (!membership.length || !['owner', 'admin'].includes(membership[0].role)) {
    return c.json({ message: 'Forbidden' }, 403)
  }

  const { importExistingProject } = await import('@/lib/provision')
  await importExistingProject(ref, organizationId)
  const { rows } = await pool.query(
    `SELECT p.*, o.slug as org_slug FROM projects p
     JOIN organizations o ON o.id=p.org_id
     WHERE p.ref=$1 AND p.org_id=$2 AND p.status != 'deleted'`,
    [ref, organizationId]
  )
  if (!rows.length) return c.json({ message: 'Import did not create project metadata' }, 500)
  await auditEvent(rows[0].id, userId, 'project.imported', { ref }, 'project', ref)
  return c.json(projectToStudioShape(rows[0]), 201)
})

// ─── GET /platform/projects/:ref ──────────────────────────────────────────────
app.get('/projects/:ref', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.*, o.slug as org_slug FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     JOIN organizations o ON o.id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status != 'deleted'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)
  return c.json(projectToStudioShape(rows[0]))
})

// ─── POST /platform/projects ──────────────────────────────────────────────────
app.post('/projects', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json()
  const { name, organization_id, db_pass, region } = body
  if (!name || !organization_id) {
    return c.json({ message: 'name and organization_id are required' }, 400)
  }

  const { rows: membership } = await pool.query(
    'SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2',
    [organization_id, userId]
  )
  if (!membership.length) return c.json({ message: 'Forbidden' }, 403)

  const { rows: org } = await pool.query('SELECT plan FROM organizations WHERE id=$1', [organization_id])
  if (org[0]?.plan === 'free' || !org[0]?.plan) {
    const { rows: count } = await pool.query(
      "SELECT COUNT(*) FROM projects WHERE org_id=$1 AND status != 'deleted'",
      [organization_id]
    )
    if (parseInt(count[0].count) >= 2) {
      return c.json({ message: 'Free plan limited to 2 projects. Upgrade to Pro.' }, 402)
    }
  }

  const ref = generateRef()
  const { rows } = await pool.query(
    `INSERT INTO projects(ref, name, org_id, status) VALUES($1,$2,$3,'provisioning') RETURNING *`,
    [ref, name, organization_id]
  )
  const project = rows[0]

  const { provisionProject } = await import('@/lib/provision')
  provisionProject(ref)
    .then(async (keys) => {
      await pool.query(
        `UPDATE projects SET status='active', site_url=$1, anon_key=$2,
         service_role_key=$3, db_password=$4, jwt_secret=$5,
         storage_s3_access_key=$6, storage_s3_secret_key=$7 WHERE ref=$8`,
        [keys.siteUrl, keys.anonKey, keys.serviceKey, keys.dbPassword, keys.jwtSecret,
         keys.s3AccessKey, keys.s3SecretKey, ref]
      )
    })
    .catch(async (err) => {
      console.error(`[provision] project ${ref} failed:`, err.message)
      await pool.query("UPDATE projects SET status='error' WHERE ref=$1", [ref])
    })

  return c.json(projectToStudioShape(project), 201)
})

// ─── GET /platform/projects/:ref/api-keys ────────────────────────────────────
app.get('/projects/:ref/api-keys', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.anon_key, p.service_role_key, p.site_url FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)
  return c.json([
    { name: 'anon', api_key: rows[0].anon_key },
    { name: 'service_role', api_key: rows[0].service_role_key },
  ])
})

// ─── GET /platform/projects/:ref/settings ────────────────────────────────────
app.get('/projects/:ref/settings', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.*, o.slug as org_slug FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     JOIN organizations o ON o.id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status != 'deleted'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)
  const p = rows[0]
  return c.json({
    project: projectToStudioShape(p),
    app: { id: p.ref, name: p.name },
    db: { host: `db.${p.ref}.db.hconsulting.app`, version: '15', port: 5432 },
  })
})

// ─── GET /platform/feature-flags ─────────────────────────────────────────────
app.get('/feature-flags', (c) => {
  return c.json({})
})

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS — proxied to per-project GoTrue admin API
// GoTrue admin is exposed via Kong at https://{ref}-db.hconsulting.app/auth/v1/admin/*
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: get project's service_role_key and endpoint for GoTrue admin proxying
async function getProjectAuthCreds(ref: string, userId: string) {
  if (!REF_RE.test(ref)) return null
  const { rows } = await pool.query(
    `SELECT p.id, p.ref, p.service_role_key, p.site_url, p.auth_config, p.status
     FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  return rows[0] ?? null
}

async function gotrueFetch(
  siteUrl: string,
  serviceKey: string,
  path: string,
  method = 'GET',
  body?: unknown
) {
  const url = `${siteUrl}/auth/v1/admin/${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

// ─── GET /platform/auth/{ref}/config ─────────────────────────────────────────
app.get('/auth/:ref/config', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  // Merge stored config with GoTrue live config (GoTrue is source of truth for live values)
  const stored = creds.auth_config ?? {}

  // Build config shape matching Studio expectations (matches GoTrue admin config response)
  const config = {
    SITE_URL: creds.site_url,
    DISABLE_SIGNUP: stored.DISABLE_SIGNUP ?? false,
    EXTERNAL_EMAIL_ENABLED: stored.EXTERNAL_EMAIL_ENABLED ?? true,
    EXTERNAL_PHONE_ENABLED: stored.EXTERNAL_PHONE_ENABLED ?? false,
    MAILER_AUTOCONFIRM: stored.MAILER_AUTOCONFIRM ?? false,
    MAILER_SECURE_EMAIL_CHANGE_ENABLED: stored.MAILER_SECURE_EMAIL_CHANGE_ENABLED ?? true,
    MAILER_OTP_EXP: stored.MAILER_OTP_EXP ?? 86400,
    JWT_EXP: stored.JWT_EXP ?? 3600,
    SMTP_ADMIN_EMAIL: stored.SMTP_ADMIN_EMAIL ?? 'noreply@hconsulting.app',
    SMTP_HOST: stored.SMTP_HOST ?? '',
    SMTP_PORT: stored.SMTP_PORT ?? 587,
    SMTP_USER: stored.SMTP_USER ?? '',
    SMTP_PASS: stored.SMTP_PASS ?? '',
    SMTP_SENDER_NAME: stored.SMTP_SENDER_NAME ?? 'supanow',
    SMTP_MAX_FREQUENCY: stored.SMTP_MAX_FREQUENCY ?? 1,
    SMS_AUTOCONFIRM: stored.SMS_AUTOCONFIRM ?? false,
    SMS_PROVIDER: stored.SMS_PROVIDER ?? 'twilio',
    SMS_TWILIO_ACCOUNT_SID: stored.SMS_TWILIO_ACCOUNT_SID ?? '',
    SMS_TWILIO_AUTH_TOKEN: stored.SMS_TWILIO_AUTH_TOKEN ?? '',
    SMS_TWILIO_MESSAGE_SERVICE_SID: stored.SMS_TWILIO_MESSAGE_SERVICE_SID ?? '',
    SMS_VONAGE_API_KEY: stored.SMS_VONAGE_API_KEY ?? '',
    SMS_VONAGE_API_SECRET: stored.SMS_VONAGE_API_SECRET ?? '',
    SMS_VONAGE_FROM: stored.SMS_VONAGE_FROM ?? '',
    SMS_OTP_EXP: stored.SMS_OTP_EXP ?? 60,
    SMS_OTP_LENGTH: stored.SMS_OTP_LENGTH ?? 6,
    SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: stored.SECURITY_REFRESH_TOKEN_ROTATION_ENABLED ?? true,
    SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: stored.SECURITY_REFRESH_TOKEN_REUSE_INTERVAL ?? 10,
    SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: stored.SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION ?? false,
    MFA_TOTP_ENROLLMENT_MAX_FREQUENCY: stored.MFA_TOTP_ENROLLMENT_MAX_FREQUENCY ?? 0,
    MFA_TOTP_ISSUER: stored.MFA_TOTP_ISSUER ?? 'supanow',
    PASSWORD_HIBP_ENABLED: stored.PASSWORD_HIBP_ENABLED ?? false,
    PASSWORD_MIN_LENGTH: stored.PASSWORD_MIN_LENGTH ?? 6,
    PASSWORD_REQUIRED_CHARACTERS: stored.PASSWORD_REQUIRED_CHARACTERS ?? '',
    EXTERNAL_GITHUB_ENABLED: stored.EXTERNAL_GITHUB_ENABLED ?? false,
    EXTERNAL_GITHUB_CLIENT_ID: stored.EXTERNAL_GITHUB_CLIENT_ID ?? '',
    EXTERNAL_GITHUB_SECRET: stored.EXTERNAL_GITHUB_SECRET ?? '',
    EXTERNAL_GOOGLE_ENABLED: stored.EXTERNAL_GOOGLE_ENABLED ?? false,
    EXTERNAL_GOOGLE_CLIENT_ID: stored.EXTERNAL_GOOGLE_CLIENT_ID ?? '',
    EXTERNAL_GOOGLE_SECRET: stored.EXTERNAL_GOOGLE_SECRET ?? '',
    EXTERNAL_DISCORD_ENABLED: stored.EXTERNAL_DISCORD_ENABLED ?? false,
    EXTERNAL_DISCORD_CLIENT_ID: stored.EXTERNAL_DISCORD_CLIENT_ID ?? '',
    EXTERNAL_DISCORD_SECRET: stored.EXTERNAL_DISCORD_SECRET ?? '',
    EXTERNAL_TWITTER_ENABLED: stored.EXTERNAL_TWITTER_ENABLED ?? false,
    EXTERNAL_TWITTER_CLIENT_ID: stored.EXTERNAL_TWITTER_CLIENT_ID ?? '',
    EXTERNAL_TWITTER_SECRET: stored.EXTERNAL_TWITTER_SECRET ?? '',
    EXTERNAL_FACEBOOK_ENABLED: stored.EXTERNAL_FACEBOOK_ENABLED ?? false,
    EXTERNAL_FACEBOOK_CLIENT_ID: stored.EXTERNAL_FACEBOOK_CLIENT_ID ?? '',
    EXTERNAL_FACEBOOK_SECRET: stored.EXTERNAL_FACEBOOK_SECRET ?? '',
    EXTERNAL_APPLE_ENABLED: stored.EXTERNAL_APPLE_ENABLED ?? false,
    EXTERNAL_APPLE_CLIENT_ID: stored.EXTERNAL_APPLE_CLIENT_ID ?? '',
    EXTERNAL_APPLE_SECRET: stored.EXTERNAL_APPLE_SECRET ?? '',
    EXTERNAL_LINKEDIN_OIDC_ENABLED: stored.EXTERNAL_LINKEDIN_OIDC_ENABLED ?? false,
    EXTERNAL_LINKEDIN_OIDC_CLIENT_ID: stored.EXTERNAL_LINKEDIN_OIDC_CLIENT_ID ?? '',
    EXTERNAL_LINKEDIN_OIDC_SECRET: stored.EXTERNAL_LINKEDIN_OIDC_SECRET ?? '',
    EXTERNAL_SLACK_OIDC_ENABLED: stored.EXTERNAL_SLACK_OIDC_ENABLED ?? false,
    EXTERNAL_SLACK_OIDC_CLIENT_ID: stored.EXTERNAL_SLACK_OIDC_CLIENT_ID ?? '',
    EXTERNAL_SLACK_OIDC_SECRET: stored.EXTERNAL_SLACK_OIDC_SECRET ?? '',
    EXTERNAL_TWITCH_ENABLED: stored.EXTERNAL_TWITCH_ENABLED ?? false,
    EXTERNAL_TWITCH_CLIENT_ID: stored.EXTERNAL_TWITCH_CLIENT_ID ?? '',
    EXTERNAL_TWITCH_SECRET: stored.EXTERNAL_TWITCH_SECRET ?? '',
    EXTERNAL_SPOTIFY_ENABLED: stored.EXTERNAL_SPOTIFY_ENABLED ?? false,
    EXTERNAL_SPOTIFY_CLIENT_ID: stored.EXTERNAL_SPOTIFY_CLIENT_ID ?? '',
    EXTERNAL_SPOTIFY_SECRET: stored.EXTERNAL_SPOTIFY_SECRET ?? '',
    EXTERNAL_GITLAB_ENABLED: stored.EXTERNAL_GITLAB_ENABLED ?? false,
    EXTERNAL_GITLAB_CLIENT_ID: stored.EXTERNAL_GITLAB_CLIENT_ID ?? '',
    EXTERNAL_GITLAB_SECRET: stored.EXTERNAL_GITLAB_SECRET ?? '',
    EXTERNAL_GITLAB_URL: stored.EXTERNAL_GITLAB_URL ?? 'https://gitlab.com',
    EXTERNAL_BITBUCKET_ENABLED: stored.EXTERNAL_BITBUCKET_ENABLED ?? false,
    EXTERNAL_BITBUCKET_CLIENT_ID: stored.EXTERNAL_BITBUCKET_CLIENT_ID ?? '',
    EXTERNAL_BITBUCKET_SECRET: stored.EXTERNAL_BITBUCKET_SECRET ?? '',
  }
  return c.json(config)
})

// ─── PATCH /platform/auth/{ref}/config ────────────────────────────────────────
app.patch('/auth/:ref/config', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const updates = await c.req.json()

  // Merge new values into stored config
  const current = creds.auth_config ?? {}
  const merged = { ...current, ...updates }

  // Persist to DB
  await pool.query(
    'UPDATE projects SET auth_config=$1, updated_at=NOW() WHERE ref=$2',
    [JSON.stringify(merged), ref]
  )
  await auditEvent(creds.id, userId, 'auth.config.updated', { keys: Object.keys(updates) }, 'auth_config', ref)

  // Map config keys → GOTRUE env vars for the shell script
  const env: Record<string, string> = {
    GOTRUE_SMTP_HOST: merged.SMTP_HOST ?? '',
    GOTRUE_SMTP_PORT: String(merged.SMTP_PORT ?? 587),
    GOTRUE_SMTP_USER: merged.SMTP_USER ?? '',
    GOTRUE_SMTP_PASS: merged.SMTP_PASS ?? '',
    GOTRUE_SMTP_ADMIN_EMAIL: merged.SMTP_ADMIN_EMAIL ?? 'noreply@hconsulting.app',
    GOTRUE_SMTP_SENDER_NAME: merged.SMTP_SENDER_NAME ?? 'supanow',
    GOTRUE_SMTP_MAX_FREQUENCY: `${merged.SMTP_MAX_FREQUENCY ?? 1}s`,
    GOTRUE_DISABLE_SIGNUP: String(merged.DISABLE_SIGNUP ?? false),
    GOTRUE_MAILER_AUTOCONFIRM: String(merged.MAILER_AUTOCONFIRM ?? false),
    GOTRUE_EXTERNAL_EMAIL_ENABLED: String(merged.EXTERNAL_EMAIL_ENABLED ?? true),
    GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: String(merged.MAILER_SECURE_EMAIL_CHANGE_ENABLED ?? true),
    GOTRUE_MAILER_OTP_EXP: String(merged.MAILER_OTP_EXP ?? 86400),
    GOTRUE_JWT_EXP: String(merged.JWT_EXP ?? 3600),
    GOTRUE_EXTERNAL_PHONE_ENABLED: String(merged.EXTERNAL_PHONE_ENABLED ?? false),
    GOTRUE_SMS_AUTOCONFIRM: String(merged.SMS_AUTOCONFIRM ?? false),
    GOTRUE_SMS_PROVIDER: merged.SMS_PROVIDER ?? 'twilio',
    GOTRUE_SMS_TWILIO_ACCOUNT_SID: merged.SMS_TWILIO_ACCOUNT_SID ?? '',
    GOTRUE_SMS_TWILIO_AUTH_TOKEN: merged.SMS_TWILIO_AUTH_TOKEN ?? '',
    GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID: merged.SMS_TWILIO_MESSAGE_SERVICE_SID ?? '',
    GOTRUE_SMS_VONAGE_API_KEY: merged.SMS_VONAGE_API_KEY ?? '',
    GOTRUE_SMS_VONAGE_API_SECRET: merged.SMS_VONAGE_API_SECRET ?? '',
    GOTRUE_SMS_VONAGE_FROM: merged.SMS_VONAGE_FROM ?? '',
    GOTRUE_SMS_OTP_EXP: String(merged.SMS_OTP_EXP ?? 60),
    GOTRUE_SMS_OTP_LENGTH: String(merged.SMS_OTP_LENGTH ?? 6),
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: String(merged.SECURITY_REFRESH_TOKEN_ROTATION_ENABLED ?? true),
    GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: String(merged.SECURITY_REFRESH_TOKEN_REUSE_INTERVAL ?? 10),
    GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: String(merged.SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION ?? false),
    GOTRUE_MFA_TOTP_ENROLLMENT_MAX_FREQUENCY: String(merged.MFA_TOTP_ENROLLMENT_MAX_FREQUENCY ?? 0),
    GOTRUE_MFA_TOTP_ISSUER: merged.MFA_TOTP_ISSUER ?? 'supanow',
    GOTRUE_PASSWORD_HIBP_ENABLED: String(merged.PASSWORD_HIBP_ENABLED ?? false),
    GOTRUE_PASSWORD_MIN_LENGTH: String(merged.PASSWORD_MIN_LENGTH ?? 6),
    GOTRUE_PASSWORD_REQUIRED_CHARACTERS: merged.PASSWORD_REQUIRED_CHARACTERS ?? '',
    GOTRUE_EXTERNAL_GITHUB_ENABLED: String(merged.EXTERNAL_GITHUB_ENABLED ?? false),
    GOTRUE_EXTERNAL_GITHUB_CLIENT_ID: merged.EXTERNAL_GITHUB_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_GITHUB_SECRET: merged.EXTERNAL_GITHUB_SECRET ?? '',
    GOTRUE_EXTERNAL_GOOGLE_ENABLED: String(merged.EXTERNAL_GOOGLE_ENABLED ?? false),
    GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: merged.EXTERNAL_GOOGLE_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_GOOGLE_SECRET: merged.EXTERNAL_GOOGLE_SECRET ?? '',
    GOTRUE_EXTERNAL_DISCORD_ENABLED: String(merged.EXTERNAL_DISCORD_ENABLED ?? false),
    GOTRUE_EXTERNAL_DISCORD_CLIENT_ID: merged.EXTERNAL_DISCORD_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_DISCORD_SECRET: merged.EXTERNAL_DISCORD_SECRET ?? '',
    GOTRUE_EXTERNAL_TWITTER_ENABLED: String(merged.EXTERNAL_TWITTER_ENABLED ?? false),
    GOTRUE_EXTERNAL_TWITTER_CLIENT_ID: merged.EXTERNAL_TWITTER_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_TWITTER_SECRET: merged.EXTERNAL_TWITTER_SECRET ?? '',
    GOTRUE_EXTERNAL_FACEBOOK_ENABLED: String(merged.EXTERNAL_FACEBOOK_ENABLED ?? false),
    GOTRUE_EXTERNAL_FACEBOOK_CLIENT_ID: merged.EXTERNAL_FACEBOOK_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_FACEBOOK_SECRET: merged.EXTERNAL_FACEBOOK_SECRET ?? '',
    GOTRUE_EXTERNAL_APPLE_ENABLED: String(merged.EXTERNAL_APPLE_ENABLED ?? false),
    GOTRUE_EXTERNAL_APPLE_CLIENT_ID: merged.EXTERNAL_APPLE_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_APPLE_SECRET: merged.EXTERNAL_APPLE_SECRET ?? '',
    GOTRUE_EXTERNAL_LINKEDIN_OIDC_ENABLED: String(merged.EXTERNAL_LINKEDIN_OIDC_ENABLED ?? false),
    GOTRUE_EXTERNAL_LINKEDIN_OIDC_CLIENT_ID: merged.EXTERNAL_LINKEDIN_OIDC_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_LINKEDIN_OIDC_SECRET: merged.EXTERNAL_LINKEDIN_OIDC_SECRET ?? '',
    GOTRUE_EXTERNAL_SLACK_OIDC_ENABLED: String(merged.EXTERNAL_SLACK_OIDC_ENABLED ?? false),
    GOTRUE_EXTERNAL_SLACK_OIDC_CLIENT_ID: merged.EXTERNAL_SLACK_OIDC_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_SLACK_OIDC_SECRET: merged.EXTERNAL_SLACK_OIDC_SECRET ?? '',
    GOTRUE_EXTERNAL_TWITCH_ENABLED: String(merged.EXTERNAL_TWITCH_ENABLED ?? false),
    GOTRUE_EXTERNAL_TWITCH_CLIENT_ID: merged.EXTERNAL_TWITCH_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_TWITCH_SECRET: merged.EXTERNAL_TWITCH_SECRET ?? '',
    GOTRUE_EXTERNAL_SPOTIFY_ENABLED: String(merged.EXTERNAL_SPOTIFY_ENABLED ?? false),
    GOTRUE_EXTERNAL_SPOTIFY_CLIENT_ID: merged.EXTERNAL_SPOTIFY_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_SPOTIFY_SECRET: merged.EXTERNAL_SPOTIFY_SECRET ?? '',
    GOTRUE_EXTERNAL_GITLAB_ENABLED: String(merged.EXTERNAL_GITLAB_ENABLED ?? false),
    GOTRUE_EXTERNAL_GITLAB_CLIENT_ID: merged.EXTERNAL_GITLAB_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_GITLAB_SECRET: merged.EXTERNAL_GITLAB_SECRET ?? '',
    GOTRUE_EXTERNAL_GITLAB_URL: merged.EXTERNAL_GITLAB_URL ?? 'https://gitlab.com',
    GOTRUE_EXTERNAL_BITBUCKET_ENABLED: String(merged.EXTERNAL_BITBUCKET_ENABLED ?? false),
    GOTRUE_EXTERNAL_BITBUCKET_CLIENT_ID: merged.EXTERNAL_BITBUCKET_CLIENT_ID ?? '',
    GOTRUE_EXTERNAL_BITBUCKET_SECRET: merged.EXTERNAL_BITBUCKET_SECRET ?? '',
  }

  // Run update-auth-config.sh in background (don't block HTTP response)
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')
  const scriptPath = `${SCRIPTS_DIR}/update-auth-config.sh`
  execAsync(`env ${envPairs} bash "${scriptPath}" "${ref}"`).catch((err) =>
    console.error(`[auth-config] update failed for ${ref}:`, err.message)
  )

  return c.json({ ...merged, message: 'Config update queued — GoTrue will reload shortly.' })
})

// ─── GET /platform/auth/{ref}/users ───────────────────────────────────────────
app.get('/auth/:ref/users', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const page = parseInt(c.req.query('page') ?? '1')
  const perPage = parseInt(c.req.query('per_page') ?? '50')

  const { status, data } = await gotrueFetch(
    creds.site_url,
    creds.service_role_key,
    `users?page=${page}&per_page=${perPage}`
  )
  return c.json(data, status as any)
})

// ─── POST /platform/auth/{ref}/users (admin create user) ─────────────────────
app.post('/auth/:ref/users', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const body = await c.req.json()
  const { status, data } = await gotrueFetch(creds.site_url, creds.service_role_key, 'users', 'POST', body)
  await auditEvent(creds.id, userId, 'auth.user.created', { status, email: body.email }, 'auth_user', data?.id)
  return c.json(data, status as any)
})

// ─── GET /platform/auth/{ref}/users/{id} ──────────────────────────────────────
app.get('/auth/:ref/users/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const { status, data } = await gotrueFetch(creds.site_url, creds.service_role_key, `users/${id}`)
  return c.json(data, status as any)
})

// ─── DELETE /platform/auth/{ref}/users/{id} ────────────────────────────────
app.delete('/auth/:ref/users/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, `users/${id}`, 'DELETE'
  )
  await auditEvent(creds.id, userId, 'auth.user.deleted', { status }, 'auth_user', id)
  return c.json(data, status as any)
})

// ─── PUT /platform/auth/{ref}/users/{id} (update user) ────────────────────
app.put('/auth/:ref/users/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const body = await c.req.json()
  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, `users/${id}`, 'PUT', body
  )
  await auditEvent(creds.id, userId, 'auth.user.updated', { status, keys: Object.keys(body) }, 'auth_user', id)
  return c.json(data, status as any)
})

// ─── DELETE /platform/auth/{ref}/users/{id}/factors ───────────────────────
app.delete('/auth/:ref/users/:id/factors', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, `users/${id}/factors`, 'DELETE'
  )
  await auditEvent(creds.id, userId, 'auth.user.factors.deleted', { status }, 'auth_user', id)
  return c.json(data, status as any)
})

// ─── POST /platform/auth/{ref}/invite ─────────────────────────────────────────
app.post('/auth/:ref/invite', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const body = await c.req.json()
  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, 'invite', 'POST', body
  )
  await auditEvent(creds.id, userId, 'auth.invite.sent', { status, email: body.email }, 'auth_invite')
  return c.json(data, status as any)
})

// ─── POST /platform/auth/{ref}/magiclink ──────────────────────────────────────
app.post('/auth/:ref/magiclink', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const body = await c.req.json()
  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, 'magiclink', 'POST', body
  )
  await auditEvent(creds.id, userId, 'auth.magiclink.sent', { status, email: body.email }, 'auth_magiclink')
  return c.json(data, status as any)
})

// ─── POST /platform/auth/{ref}/otp ────────────────────────────────────────────
app.post('/auth/:ref/otp', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const body = await c.req.json()
  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, 'otp', 'POST', body
  )
  await auditEvent(creds.id, userId, 'auth.otp.sent', { status, email: body.email, phone: body.phone }, 'auth_otp')
  return c.json(data, status as any)
})

// ─── POST /platform/auth/{ref}/recover ────────────────────────────────────────
app.post('/auth/:ref/recover', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const body = await c.req.json()
  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, 'recover', 'POST', body
  )
  await auditEvent(creds.id, userId, 'auth.recovery.sent', { status, email: body.email }, 'auth_recovery')
  return c.json(data, status as any)
})

// ─── POST /platform/auth/{ref}/generate_link ──────────────────────────────────
app.post('/auth/:ref/generate_link', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)

  const body = await c.req.json()
  const { status, data } = await gotrueFetch(
    creds.site_url, creds.service_role_key, 'generate_link', 'POST', body
  )
  await auditEvent(creds.id, userId, 'auth.link.generated', { status, type: body.type, email: body.email }, 'auth_link')
  return c.json(data, status as any)
})

app.get('/auth/:ref/templates', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const { rows } = await pool.query(
    `SELECT template, subject, body_html, body_text, redirect_to, updated_at
     FROM auth_email_templates WHERE project_id=$1 ORDER BY template`,
    [creds.id]
  )
  return c.json(rows)
})

app.patch('/auth/:ref/templates/:template', async (c) => {
  const userId = c.get('userId')
  const { ref, template } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO auth_email_templates
       (project_id, template, subject, body_html, body_text, redirect_to, created_by)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, template) DO UPDATE SET
       subject=EXCLUDED.subject,
       body_html=EXCLUDED.body_html,
       body_text=EXCLUDED.body_text,
       redirect_to=EXCLUDED.redirect_to,
       updated_at=NOW()
     RETURNING template, subject, body_html, body_text, redirect_to, updated_at`,
    [
      creds.id,
      template,
      body.subject ?? null,
      body.body_html ?? null,
      body.body_text ?? null,
      body.redirect_to ?? null,
      userId,
    ]
  )
  await auditEvent(creds.id, userId, 'auth.template.updated', { template }, 'auth_template', template)
  return c.json(rows[0])
})

app.post('/auth/:ref/templates/:template/preview', async (c) => {
  const userId = c.get('userId')
  const { ref, template } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const { rows } = await pool.query(
    `SELECT template, subject, body_html, body_text, redirect_to
     FROM auth_email_templates WHERE project_id=$1 AND template=$2`,
    [creds.id, template]
  )
  const source = rows[0] ?? defaultEmailTemplate(template)
  const variables = {
    ConfirmationURL: body.confirmation_url ?? `${creds.site_url}/auth/v1/verify?token=preview&type=${template}`,
    SiteURL: creds.site_url,
    Email: body.email ?? 'preview@example.com',
    Token: body.token ?? '123456',
    TokenHash: body.token_hash ?? 'preview-token-hash',
    RedirectTo: body.redirect_to ?? source.redirect_to ?? creds.site_url,
    ...body.variables,
  }
  const preview = {
    template,
    subject: renderTemplate(source.subject, variables),
    body_html: renderTemplate(source.body_html, variables),
    body_text: renderTemplate(source.body_text, variables),
    variables,
  }
  await pool.query(
    `INSERT INTO auth_email_test_events
       (project_id, template, recipient, subject, body_preview, status, metadata, created_by)
     VALUES($1, $2, $3, $4, $5, 'previewed', $6, $7)`,
    [
      creds.id,
      template,
      body.email ?? null,
      preview.subject,
      preview.body_text || preview.body_html,
      JSON.stringify({ mode: 'preview', variables }),
      userId,
    ]
  )
  await auditEvent(creds.id, userId, 'auth.template.previewed', { template }, 'auth_template', template)
  return c.json(preview)
})

app.post('/auth/:ref/templates/:template/test', async (c) => {
  const userId = c.get('userId')
  const { ref, template } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const recipient = String(body.email ?? '').trim()
  if (!recipient) return c.json({ message: 'email is required' }, 400)
  const { rows } = await pool.query(
    `SELECT template, subject, body_html, body_text, redirect_to
     FROM auth_email_templates WHERE project_id=$1 AND template=$2`,
    [creds.id, template]
  )
  const source = rows[0] ?? defaultEmailTemplate(template)
  const variables = {
    ConfirmationURL: body.confirmation_url ?? `${creds.site_url}/auth/v1/verify?token=preview&type=${template}`,
    SiteURL: creds.site_url,
    Email: recipient,
    Token: body.token ?? '123456',
    TokenHash: body.token_hash ?? 'preview-token-hash',
    RedirectTo: body.redirect_to ?? source.redirect_to ?? creds.site_url,
    ...body.variables,
  }
  const subject = renderTemplate(source.subject, variables)
  const bodyPreview = renderTemplate(source.body_text || source.body_html, variables)
  const { rows: eventRows } = await pool.query(
    `INSERT INTO auth_email_test_events
       (project_id, template, recipient, subject, body_preview, status, metadata, created_by)
     VALUES($1, $2, $3, $4, $5, 'queued', $6, $7)
     RETURNING id, template, recipient, subject, status, metadata, created_at`,
    [
      creds.id,
      template,
      recipient,
      subject,
      bodyPreview,
      JSON.stringify({ mode: 'test', provider: 'configured-gotrue-smtp', variables }),
      userId,
    ]
  )
  await auditEvent(creds.id, userId, 'auth.template.test_queued', { template, recipient }, 'auth_template', template)
  return c.json({
    ...eventRows[0],
    message: 'Test email event recorded. Delivery is handled by the project GoTrue SMTP configuration.',
    preview: { subject, body: bodyPreview },
  }, 202)
})

app.get('/auth/:ref/templates/:template/tests', async (c) => {
  const userId = c.get('userId')
  const { ref, template } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 50, 100)
  const { rows } = await pool.query(
    `SELECT id, template, recipient, subject, body_preview, status, metadata, created_at
     FROM auth_email_test_events
     WHERE project_id=$1 AND template=$2
     ORDER BY created_at DESC
     LIMIT $3`,
    [creds.id, template, limit]
  )
  return c.json(rows)
})

// ─── DELETE /platform/auth/{ref}/templates/{template}/reset ───────────────────
app.delete('/auth/:ref/templates/:template/reset', async (c) => {
  const userId = c.get('userId')
  const { ref, template } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  await pool.query('DELETE FROM auth_email_templates WHERE project_id=$1 AND template=$2', [creds.id, template])
  await auditEvent(creds.id, userId, 'auth.template.reset', { template }, 'auth_template', template)
  return c.json({ message: 'Template reset to default.' })
})

// ─── GET /platform/auth/{ref}/validate/spam ───────────────────────────────────
app.get('/auth/:ref/validate/spam', (c) => c.json({ is_spam: false }))

app.get('/auth/:ref/audit', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const { rows } = await pool.query(
    `SELECT id, event_type, target_type, target_id, metadata, created_at
     FROM project_audit_events
     WHERE project_id=$1 AND event_type LIKE 'auth.%'
     ORDER BY created_at DESC LIMIT 100`,
    [creds.id]
  )
  return c.json(rows)
})

app.get('/auth/:ref/providers', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const stored = creds.auth_config ?? {}
  const { rows } = await pool.query(
    `SELECT provider, enabled, client_id, scopes, redirect_uri, metadata, updated_at
     FROM auth_provider_configs WHERE project_id=$1 ORDER BY provider`,
    [creds.id]
  )
  const persisted = new Map(rows.map((row: any) => [row.provider, row]))
  const providers = Object.entries(AUTH_PROVIDER_KEYS).map(([provider, keys]) => {
    const row: any = persisted.get(provider)
    return {
      provider,
      enabled: row?.enabled ?? Boolean(stored[keys.enabled]),
      client_id: row?.client_id ?? stored[keys.clientId] ?? '',
      has_secret: Boolean(stored[keys.secret]),
      scopes: row?.scopes ?? [],
      redirect_uri: row?.redirect_uri ?? `${creds.site_url}/auth/v1/callback`,
      metadata: row?.metadata ?? {},
      updated_at: row?.updated_at ?? null,
    }
  })
  return c.json(providers)
})

app.patch('/auth/:ref/providers/:provider', async (c) => {
  const userId = c.get('userId')
  const { ref, provider } = c.req.param()
  const providerKey = provider.toLowerCase()
  const keys = AUTH_PROVIDER_KEYS[providerKey]
  if (!keys) return c.json({ message: `Unsupported provider: ${provider}` }, 400)
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const body = await c.req.json()
  const current = creds.auth_config ?? {}
  const merged = {
    ...current,
    [keys.enabled]: body.enabled ?? current[keys.enabled] ?? false,
    [keys.clientId]: body.client_id ?? current[keys.clientId] ?? '',
    ...(body.secret !== undefined ? { [keys.secret]: body.secret } : {}),
    ...(providerKey === 'gitlab' && body.gitlab_url ? { EXTERNAL_GITLAB_URL: body.gitlab_url } : {}),
  }
  await pool.query('UPDATE projects SET auth_config=$1, updated_at=NOW() WHERE ref=$2', [JSON.stringify(merged), ref])
  const { rows } = await pool.query(
    `INSERT INTO auth_provider_configs
       (project_id, provider, enabled, client_id, secret_ref, scopes, redirect_uri, metadata, updated_by)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(project_id, provider) DO UPDATE SET
       enabled=EXCLUDED.enabled,
       client_id=EXCLUDED.client_id,
       secret_ref=EXCLUDED.secret_ref,
       scopes=EXCLUDED.scopes,
       redirect_uri=EXCLUDED.redirect_uri,
       metadata=EXCLUDED.metadata,
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING provider, enabled, client_id, scopes, redirect_uri, metadata, updated_at`,
    [
      creds.id,
      providerKey,
      Boolean(merged[keys.enabled]),
      merged[keys.clientId] || null,
      body.secret !== undefined ? `${providerKey}.oauth.secret` : null,
      body.scopes ?? [],
      body.redirect_uri ?? `${creds.site_url}/auth/v1/callback`,
      JSON.stringify(body.metadata ?? {}),
      userId,
    ]
  )
  const env: Record<string, string> = {
    [`GOTRUE_${keys.enabled}`]: String(merged[keys.enabled] ?? false),
    [`GOTRUE_${keys.clientId}`]: merged[keys.clientId] ?? '',
    [`GOTRUE_${keys.secret}`]: merged[keys.secret] ?? '',
  }
  if (providerKey === 'gitlab') env.GOTRUE_EXTERNAL_GITLAB_URL = merged.EXTERNAL_GITLAB_URL ?? 'https://gitlab.com'
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')
  execAsync(`env ${envPairs} bash "${SCRIPTS_DIR}/update-auth-config.sh" "${ref}"`).catch((err) =>
    console.error(`[auth-provider] update failed for ${ref}/${providerKey}:`, err.message)
  )
  await auditEvent(creds.id, userId, 'auth.provider.updated', { provider: providerKey, enabled: Boolean(merged[keys.enabled]) }, 'auth_provider', providerKey)
  return c.json({ ...rows[0], has_secret: Boolean(merged[keys.secret]), message: 'Provider update queued.' })
})

app.get('/auth/:ref/rate-limits', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const { rows } = await pool.query(
    `SELECT email_per_hour, sms_per_hour, token_refresh_per_minute,
            anonymous_signins_per_hour, updated_at
     FROM auth_rate_limits WHERE project_id=$1`,
    [creds.id]
  )
  return c.json(rows[0] ?? {
    email_per_hour: 30,
    sms_per_hour: 10,
    token_refresh_per_minute: 60,
    anonymous_signins_per_hour: 60,
    updated_at: null,
  })
})

app.patch('/auth/:ref/rate-limits', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO auth_rate_limits
       (project_id, email_per_hour, sms_per_hour, token_refresh_per_minute, anonymous_signins_per_hour, updated_by)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT(project_id) DO UPDATE SET
       email_per_hour=COALESCE(EXCLUDED.email_per_hour, auth_rate_limits.email_per_hour),
       sms_per_hour=COALESCE(EXCLUDED.sms_per_hour, auth_rate_limits.sms_per_hour),
       token_refresh_per_minute=COALESCE(EXCLUDED.token_refresh_per_minute, auth_rate_limits.token_refresh_per_minute),
       anonymous_signins_per_hour=COALESCE(EXCLUDED.anonymous_signins_per_hour, auth_rate_limits.anonymous_signins_per_hour),
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING email_per_hour, sms_per_hour, token_refresh_per_minute, anonymous_signins_per_hour, updated_at`,
    [
      creds.id,
      body.email_per_hour ?? null,
      body.sms_per_hour ?? null,
      body.token_refresh_per_minute ?? null,
      body.anonymous_signins_per_hour ?? null,
      userId,
    ]
  )
  await auditEvent(creds.id, userId, 'auth.rate_limits.updated', { keys: Object.keys(body) }, 'auth_rate_limits', ref)
  return c.json(rows[0])
})

app.get('/auth/:ref/mfa-policy', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const { rows } = await pool.query(
    `SELECT totp_enabled, phone_enabled, issuer, max_enrollment_frequency_seconds,
            require_for_admins, require_for_all_users, recovery_codes_enabled, updated_at
     FROM auth_mfa_policies WHERE project_id=$1`,
    [creds.id]
  )
  return c.json(rows[0] ?? {
    totp_enabled: true,
    phone_enabled: false,
    issuer: 'supanow',
    max_enrollment_frequency_seconds: 0,
    require_for_admins: false,
    require_for_all_users: false,
    recovery_codes_enabled: true,
    updated_at: null,
  })
})

app.patch('/auth/:ref/mfa-policy', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectAuthCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found or project not active' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO auth_mfa_policies
       (project_id, totp_enabled, phone_enabled, issuer, max_enrollment_frequency_seconds,
        require_for_admins, require_for_all_users, recovery_codes_enabled, updated_by)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(project_id) DO UPDATE SET
       totp_enabled=COALESCE(EXCLUDED.totp_enabled, auth_mfa_policies.totp_enabled),
       phone_enabled=COALESCE(EXCLUDED.phone_enabled, auth_mfa_policies.phone_enabled),
       issuer=COALESCE(EXCLUDED.issuer, auth_mfa_policies.issuer),
       max_enrollment_frequency_seconds=COALESCE(EXCLUDED.max_enrollment_frequency_seconds, auth_mfa_policies.max_enrollment_frequency_seconds),
       require_for_admins=COALESCE(EXCLUDED.require_for_admins, auth_mfa_policies.require_for_admins),
       require_for_all_users=COALESCE(EXCLUDED.require_for_all_users, auth_mfa_policies.require_for_all_users),
       recovery_codes_enabled=COALESCE(EXCLUDED.recovery_codes_enabled, auth_mfa_policies.recovery_codes_enabled),
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING totp_enabled, phone_enabled, issuer, max_enrollment_frequency_seconds,
       require_for_admins, require_for_all_users, recovery_codes_enabled, updated_at`,
    [
      creds.id,
      body.totp_enabled ?? null,
      body.phone_enabled ?? null,
      body.issuer ?? null,
      body.max_enrollment_frequency_seconds ?? null,
      body.require_for_admins ?? null,
      body.require_for_all_users ?? null,
      body.recovery_codes_enabled ?? null,
      userId,
    ]
  )
  const current = creds.auth_config ?? {}
  const merged = {
    ...current,
    MFA_TOTP_ISSUER: rows[0].issuer,
    MFA_TOTP_ENROLLMENT_MAX_FREQUENCY: rows[0].max_enrollment_frequency_seconds,
  }
  await pool.query('UPDATE projects SET auth_config=$1, updated_at=NOW() WHERE ref=$2', [JSON.stringify(merged), ref])
  execAsync(
    `env GOTRUE_MFA_TOTP_ISSUER=${shellQuote(rows[0].issuer)} GOTRUE_MFA_TOTP_ENROLLMENT_MAX_FREQUENCY=${shellQuote(rows[0].max_enrollment_frequency_seconds)} bash "${SCRIPTS_DIR}/update-auth-config.sh" "${ref}"`
  ).catch((err) => console.error(`[mfa-policy] update failed for ${ref}:`, err.message))
  await auditEvent(creds.id, userId, 'auth.mfa_policy.updated', { keys: Object.keys(body) }, 'auth_mfa_policy', ref)
  return c.json({ ...rows[0], message: 'MFA policy update queued.' })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PG-META PROXY — forward /platform/pg-meta/{ref}/* to project's Kong /pg/* route
// Studio passes x-connection-encrypted; we ignore it and auth via service_role_key
// ═══════════════════════════════════════════════════════════════════════════════

async function getProjectKongCreds(ref: string, userId: string) {
  if (!REF_RE.test(ref)) return null
  const { rows } = await pool.query(
    `SELECT p.id, p.ref, p.name, p.org_id, p.db_password, p.anon_key, p.service_role_key, p.site_url, p.status
     FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  return rows[0] ?? null
}

// Handles all HTTP methods for /platform/pg-meta/:ref/*
const pgMetaProxy = async (c: any) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectKongCreds(ref, userId)
  if (!creds) return c.json({ message: 'Project not found or not active' }, 404)

  // Strip /api/platform/pg-meta/{ref} prefix to get the pg-meta path
  const rawPath = c.req.path.replace(`/api/platform/pg-meta/${ref}`, '') || '/'
  const rawQuery = new URL(c.req.url).search

  const targetUrl = `${creds.site_url}/pg${rawPath}${rawQuery}`

  const upstreamHeaders: Record<string, string> = {
    apikey: creds.service_role_key,
    Authorization: `Bearer ${creds.service_role_key}`,
    'Content-Type': 'application/json',
    'x-pg-application-name': 'supanow-studio',
  }

  const method = c.req.method
  let body: string | undefined
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    body = await c.req.text()
  }

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body,
    })

    const responseBody = await upstream.text()
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      },
    })
  } catch (err: any) {
    console.error(`[pg-meta proxy] ${ref} → ${targetUrl}:`, err.message)
    return c.json({ message: 'pg-meta upstream unreachable', error: err.message }, 503)
  }
}

app.get('/pg-meta/:ref/*', pgMetaProxy)
app.post('/pg-meta/:ref/*', pgMetaProxy)
app.put('/pg-meta/:ref/*', pgMetaProxy)
app.patch('/pg-meta/:ref/*', pgMetaProxy)
app.delete('/pg-meta/:ref/*', pgMetaProxy)

// ═══════════════════════════════════════════════════════════════════════════════
// STUDIO OPERATIONS: schema snapshots, advisors, backups/restores, branches
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchPgMetaQuery(siteUrl: string, serviceKey: string, query: string) {
  const res = await fetch(`${siteUrl}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'x-pg-application-name': 'supanow-studio-ops',
    },
    body: JSON.stringify({ query, disable_statement_timeout: true }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.message ?? data?.error ?? `pg-meta query failed (${res.status})`)
  }
  return data
}

async function fetchProjectSchema(project: any) {
  const sql = `
    select jsonb_build_object(
      'schemas', coalesce(jsonb_agg(schema_doc order by schema_doc->>'name'), '[]'::jsonb)
    ) as schema
    from (
      select jsonb_build_object(
        'name', n.nspname,
        'tables', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', c.relname,
            'type', c.relkind,
            'columns', coalesce((
              select jsonb_agg(jsonb_build_object(
                'name', a.attname,
                'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                'nullable', not a.attnotnull,
                'default', pg_get_expr(ad.adbin, ad.adrelid)
              ) order by a.attnum)
              from pg_attribute a
              left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            ), '[]'::jsonb)
          ) order by c.relname)
          from pg_class c
          where c.relnamespace = n.oid and c.relkind in ('r','p','v','m','f')
        ), '[]'::jsonb)
      ) as schema_doc
      from pg_namespace n
      where n.nspname not like 'pg_%'
        and n.nspname not in ('information_schema', 'pg_toast')
    ) s`
  const rows = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  return rows?.[0]?.schema ?? { schemas: [] }
}

function hashJson(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function schemaDiff(previous: any, next: any) {
  const prevSchemas = new Map<string, any>((previous?.schemas ?? []).map((s: any) => [s.name, s]))
  const nextSchemas = new Map<string, any>((next?.schemas ?? []).map((s: any) => [s.name, s]))
  const addedSchemas = [...nextSchemas.keys()].filter((name) => !prevSchemas.has(name))
  const removedSchemas = [...prevSchemas.keys()].filter((name) => !nextSchemas.has(name))
  const changedTables: any[] = []

  for (const [schemaName, schema] of nextSchemas) {
    const prevSchema: any = prevSchemas.get(schemaName)
    if (!prevSchema) continue
    const prevTables = new Map<string, any>((prevSchema.tables ?? []).map((t: any) => [t.name, t]))
    const nextTables = new Map<string, any>((schema.tables ?? []).map((t: any) => [t.name, t]))
    for (const tableName of nextTables.keys()) {
      if (!prevTables.has(tableName)) changedTables.push({ schema: schemaName, table: tableName, change: 'added' })
    }
    for (const tableName of prevTables.keys()) {
      if (!nextTables.has(tableName)) changedTables.push({ schema: schemaName, table: tableName, change: 'removed' })
    }
    for (const [tableName, table] of nextTables) {
      const prevTable = prevTables.get(tableName)
      if (prevTable && hashJson(prevTable) !== hashJson(table)) {
        changedTables.push({ schema: schemaName, table: tableName, change: 'changed' })
      }
    }
  }

  return { added_schemas: addedSchemas, removed_schemas: removedSchemas, changed_tables: changedTables }
}

function advisorSummary(findings: any[]) {
  const countByLevel = findings.reduce((acc: Record<string, number>, item: any) => {
    const level = item.level ?? item.severity ?? item.type ?? 'info'
    acc[level] = (acc[level] ?? 0) + 1
    return acc
  }, {})
  return { total: findings.length, count_by_level: countByLevel }
}

function normalizeSql(sql: unknown) {
  return String(sql ?? '').trim().replace(/;+\s*$/, '')
}

function isWriteSql(sql: string) {
  return /^\s*(alter|call|comment|create|delete|do|drop|grant|insert|reindex|revoke|truncate|update|vacuum)\b/i.test(sql)
}

async function recordSqlQuery(
  projectId: string,
  userId: string,
  query: string,
  status: 'completed' | 'failed' | 'blocked',
  isWrite: boolean,
  durationMs?: number,
  rowCount?: number,
  error?: string
) {
  const queryHash = crypto.createHash('sha256').update(query).digest('hex')
  await pool.query(
    `INSERT INTO sql_query_history
       (project_id, query, query_hash, status, is_write, duration_ms, row_count, error, created_by)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [projectId, query, queryHash, status, isWrite, durationMs ?? null, rowCount ?? null, error ?? null, userId]
  ).catch((err) => console.error('[sql history]', err.message))
}

function renderTemplate(input: string | null | undefined, variables: Record<string, string>) {
  let output = input ?? ''
  for (const [key, value] of Object.entries(variables)) {
    output = output
      .replaceAll(`{{${key}}}`, value)
      .replaceAll(`{{ ${key} }}`, value)
      .replaceAll(`{{.${key}}}`, value)
      .replaceAll(`{{ .${key} }}`, value)
  }
  return output
}

function defaultEmailTemplate(template: string) {
  const labels: Record<string, string> = {
    confirmation: 'Confirm your email',
    invite: 'You have been invited',
    magic_link: 'Your magic link',
    recovery: 'Reset your password',
    email_change: 'Confirm your new email',
  }
  const subject = labels[template] ?? `SupaNow ${template}`
  return {
    template,
    subject,
    body_html: `<p>Hello,</p><p>Use this link to continue:</p><p><a href="{{ConfirmationURL}}">{{ConfirmationURL}}</a></p>`,
    body_text: `Hello,\n\nUse this link to continue:\n{{ConfirmationURL}}\n`,
    redirect_to: null,
  }
}

// ─── SQL Editor: safe query runner, history, snippets ────────────────────────
app.get('/sql/:ref/schema', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)

  try {
    const schema = await fetchProjectSchema(project)
    return c.json(schema)
  } catch (err: any) {
    return c.json({ message: 'Failed to inspect project schema', error: err.message }, 400)
  }
})

// ─── Table Editor: row browsing and simple mutations ─────────────────────────
app.get('/table-editor/:ref/:schema/:table/rows', async (c) => {
  const userId = c.get('userId')
  const { ref, schema, table } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  if (!isSafeSqlIdentifier(schema) || !isSafeSqlIdentifier(table)) return c.json({ message: 'Invalid table identifier' }, 400)

  const limit = parsePositiveInt(c.req.query('limit'), 100, 500)
  const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0)
  const sql = `select * from ${sqlIdent(schema)}.${sqlIdent(table)} limit ${limit} offset ${offset}`
  const data = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  return c.json({ schema, table, limit, offset, rows: Array.isArray(data) ? data : [] })
})

app.post('/table-editor/:ref/:schema/:table/rows', async (c) => {
  const userId = c.get('userId')
  const { ref, schema, table } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  if (!isSafeSqlIdentifier(schema) || !isSafeSqlIdentifier(table)) return c.json({ message: 'Invalid table identifier' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const values = body.row && typeof body.row === 'object' && !Array.isArray(body.row) ? body.row : body
  const columns = Object.keys(values).filter(isSafeSqlIdentifier)
  if (!columns.length) return c.json({ message: 'row must include at least one safe column' }, 400)
  const sql = `insert into ${sqlIdent(schema)}.${sqlIdent(table)} (${columns.map(sqlIdent).join(', ')})
values (${columns.map((column) => sqlValue(values[column])).join(', ')})
returning *`
  const data = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  await auditEvent(project.id, userId, 'table_editor.row.inserted', { schema, table, columns }, 'table_row', `${schema}.${table}`)
  return c.json({ row: Array.isArray(data) ? data[0] : data }, 201)
})

app.patch('/table-editor/:ref/:schema/:table/rows', async (c) => {
  const userId = c.get('userId')
  const { ref, schema, table } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  if (!isSafeSqlIdentifier(schema) || !isSafeSqlIdentifier(table)) return c.json({ message: 'Invalid table identifier' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const pk = body.pk && typeof body.pk === 'object' && !Array.isArray(body.pk) ? body.pk : null
  const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : null
  if (!pk || !Object.keys(pk).length) return c.json({ message: 'pk object is required' }, 400)
  if (!values || !Object.keys(values).length) return c.json({ message: 'values object is required' }, 400)
  const setColumns = Object.keys(values).filter(isSafeSqlIdentifier)
  const pkColumns = Object.keys(pk).filter(isSafeSqlIdentifier)
  if (!setColumns.length || !pkColumns.length) return c.json({ message: 'Only safe column identifiers are allowed' }, 400)
  const sql = `update ${sqlIdent(schema)}.${sqlIdent(table)}
set ${setColumns.map((column) => `${sqlIdent(column)} = ${sqlValue(values[column])}`).join(', ')}
where ${pkColumns.map((column) => `${sqlIdent(column)} is not distinct from ${sqlValue(pk[column])}`).join(' and ')}
returning *`
  const data = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  await auditEvent(project.id, userId, 'table_editor.row.updated', { schema, table, set_columns: setColumns, pk_columns: pkColumns }, 'table_row', `${schema}.${table}`)
  return c.json({ rows: Array.isArray(data) ? data : [] })
})

app.delete('/table-editor/:ref/:schema/:table/rows', async (c) => {
  const userId = c.get('userId')
  const { ref, schema, table } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  if (!isSafeSqlIdentifier(schema) || !isSafeSqlIdentifier(table)) return c.json({ message: 'Invalid table identifier' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const pk = body.pk && typeof body.pk === 'object' && !Array.isArray(body.pk) ? body.pk : null
  if (!pk || !Object.keys(pk).length) return c.json({ message: 'pk object is required' }, 400)
  const pkColumns = Object.keys(pk).filter(isSafeSqlIdentifier)
  if (!pkColumns.length) return c.json({ message: 'Only safe column identifiers are allowed' }, 400)
  const sql = `delete from ${sqlIdent(schema)}.${sqlIdent(table)}
where ${pkColumns.map((column) => `${sqlIdent(column)} is not distinct from ${sqlValue(pk[column])}`).join(' and ')}
returning *`
  const data = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  await auditEvent(project.id, userId, 'table_editor.row.deleted', { schema, table, pk_columns: pkColumns }, 'table_row', `${schema}.${table}`)
  return c.json({ rows: Array.isArray(data) ? data : [] })
})

app.post('/sql/:ref/query', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const sql = normalizeSql(body.sql)
  if (!sql) return c.json({ message: 'sql is required' }, 400)

  const isWrite = isWriteSql(sql)
  const wantsExplain = body.explain === true
  const wantsDryRun = body.dry_run === true
  const confirmedWrite = body.confirm_write === true

  if (isWrite && !confirmedWrite && !wantsDryRun) {
    await recordSqlQuery(project.id, userId, sql, 'blocked', true)
    return c.json({
      message: 'Write query requires confirm_write=true or dry_run=true.',
      requires_confirmation: true,
      is_write: true,
    }, 409)
  }

  if (wantsExplain && isWrite) {
    await recordSqlQuery(project.id, userId, sql, 'blocked', true)
    return c.json({ message: 'EXPLAIN is only enabled for read queries in Studio safe mode.' }, 400)
  }

  const runnableSql = wantsExplain
    ? `EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE FALSE) ${sql}`
    : wantsDryRun && isWrite
      ? `BEGIN; ${sql}; ROLLBACK;`
      : sql
  const started = Date.now()
  try {
    const data = await fetchPgMetaQuery(project.site_url, project.service_role_key, runnableSql)
    const durationMs = Date.now() - started
    const rowCount = Array.isArray(data) ? data.length : null
    await recordSqlQuery(project.id, userId, sql, 'completed', isWrite, durationMs, rowCount ?? undefined)
    await auditEvent(project.id, userId, 'sql.query.completed', {
      is_write: isWrite,
      explain: wantsExplain,
      dry_run: wantsDryRun,
      duration_ms: durationMs,
      row_count: rowCount,
    }, 'sql_query')
    return c.json({ data, is_write: isWrite, explain: wantsExplain, dry_run: wantsDryRun, duration_ms: durationMs, row_count: rowCount })
  } catch (err: any) {
    const durationMs = Date.now() - started
    await recordSqlQuery(project.id, userId, sql, 'failed', isWrite, durationMs, undefined, err.message)
    await auditEvent(project.id, userId, 'sql.query.failed', { is_write: isWrite, error: err.message }, 'sql_query')
    return c.json({ message: 'SQL query failed', error: err.message, is_write: isWrite }, 400)
  }
})

app.get('/sql/:ref/history', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 50, 200)
  const { rows } = await pool.query(
    `SELECT id, query, query_hash, status, is_write, duration_ms, row_count, error, created_at
     FROM sql_query_history
     WHERE project_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [project.id, limit]
  )
  return c.json(rows)
})

app.get('/sql/:ref/snippets', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, name, description, sql, tags, created_at, updated_at
     FROM sql_snippets
     WHERE project_id=$1
     ORDER BY name`,
    [project.id]
  )
  return c.json(rows)
})

app.post('/sql/:ref/snippets', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const name = String(body.name ?? '').trim()
  const sql = normalizeSql(body.sql)
  if (!name || !sql) return c.json({ message: 'name and sql are required' }, 400)
  const { rows } = await pool.query(
    `INSERT INTO sql_snippets(project_id, name, description, sql, tags, created_by)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT(project_id, name) DO UPDATE SET
       description=EXCLUDED.description,
       sql=EXCLUDED.sql,
       tags=EXCLUDED.tags,
       updated_at=NOW()
     RETURNING id, name, description, sql, tags, created_at, updated_at`,
    [project.id, name, body.description ?? null, sql, body.tags ?? [], userId]
  )
  await auditEvent(project.id, userId, 'sql.snippet.saved', { name }, 'sql_snippet', rows[0].id)
  return c.json(rows[0], 201)
})

app.patch('/sql/:ref/snippets/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `UPDATE sql_snippets SET
       name=COALESCE($3, name),
       description=COALESCE($4, description),
       sql=COALESCE($5, sql),
       tags=COALESCE($6, tags),
       updated_at=NOW()
     WHERE project_id=$1 AND id=$2
     RETURNING id, name, description, sql, tags, created_at, updated_at`,
    [
      project.id,
      id,
      body.name ? String(body.name).trim() : null,
      body.description ?? null,
      body.sql ? normalizeSql(body.sql) : null,
      body.tags ?? null,
    ]
  )
  if (!rows.length) return c.json({ message: 'Snippet not found' }, 404)
  await auditEvent(project.id, userId, 'sql.snippet.updated', { id }, 'sql_snippet', id)
  return c.json(rows[0])
})

app.delete('/sql/:ref/snippets/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  await pool.query('DELETE FROM sql_snippets WHERE project_id=$1 AND id=$2', [project.id, id])
  await auditEvent(project.id, userId, 'sql.snippet.deleted', { id }, 'sql_snippet', id)
  return c.json({ id, status: 'deleted' })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /platform/projects/:ref/restart ─────────────────────────────────────
app.post('/projects/:ref/restart', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.ref FROM projects p JOIN org_members om ON om.org_id=p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)

  execAsync(`bash "${SCRIPTS_DIR}/restart-project.sh" "${ref}"`).catch((err) =>
    console.error(`[restart] ${ref}:`, err.message)
  )
  return c.json({ message: 'Restart initiated' })
})

// ─── POST /platform/projects/:ref/restart-services ────────────────────────────
app.post('/projects/:ref/restart-services', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.ref FROM projects p JOIN org_members om ON om.org_id=p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const services: string[] = body.services ?? []
  const serviceArgs = services.join(' ')

  execAsync(`bash "${SCRIPTS_DIR}/restart-project.sh" "${ref}" ${serviceArgs}`).catch((err) =>
    console.error(`[restart-services] ${ref}:`, err.message)
  )
  return c.json({ message: 'Service restart initiated', services })
})

// ─── GET /platform/projects/:ref/run-lints ────────────────────────────────────
// Proxied to pg-meta's /advisors endpoint if active, otherwise stub
app.get('/projects/:ref/run-lints', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectKongCreds(ref, userId)
  if (!creds) return c.json([])

  try {
    const res = await fetch(`${creds.site_url}/pg/advisors`, {
      headers: {
        apikey: creds.service_role_key,
        Authorization: `Bearer ${creds.service_role_key}`,
      },
    })
    const data = await res.json().catch(() => [])
    const findings = Array.isArray(data) ? data : []
    await pool.query(
      `INSERT INTO advisor_runs(project_id, status, findings, summary, created_by)
       VALUES($1, 'completed', $2, $3, $4)`,
      [creds.id, JSON.stringify(findings), JSON.stringify(advisorSummary(findings)), userId]
    )
    return c.json(findings)
  } catch (err: any) {
    await pool.query(
      `INSERT INTO advisor_runs(project_id, status, findings, summary, error, created_by)
       VALUES($1, 'failed', '[]'::jsonb, '{}'::jsonb, $2, $3)`,
      [creds.id, err.message, userId]
    ).catch(() => {})
    return c.json([])
  }
})

app.get('/projects/:ref/advisor-runs', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, status, source, summary, error, created_at
     FROM advisor_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [project.id]
  )
  return c.json(rows)
})

app.post('/projects/:ref/schema-snapshots', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const schema = await fetchProjectSchema(project)
  const schemaHash = hashJson(schema)
  const { rows: previousRows } = await pool.query(
    `SELECT id, schema_json FROM schema_snapshots
     WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [project.id]
  )
  const previous = previousRows[0]
  const diff = previous ? schemaDiff(previous.schema_json, schema) : {}
  const { rows } = await pool.query(
    `INSERT INTO schema_snapshots
       (project_id, name, schema_hash, schema_json, diff_from_snapshot_id, diff_json, created_by)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, schema_hash, diff_from_snapshot_id, diff_json, created_at`,
    [
      project.id,
      body.name ?? 'manual',
      schemaHash,
      JSON.stringify(schema),
      previous?.id ?? null,
      JSON.stringify(diff),
      userId,
    ]
  )
  return c.json(rows[0], 201)
})

app.get('/projects/:ref/schema-snapshots', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const includeSchema = c.req.query('include_schema') === 'true'
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const projection = includeSchema
    ? 'id, name, schema_hash, schema_json, diff_from_snapshot_id, diff_json, created_at'
    : 'id, name, schema_hash, diff_from_snapshot_id, diff_json, created_at'
  const { rows } = await pool.query(
    `SELECT ${projection} FROM schema_snapshots
     WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [project.id]
  )
  return c.json(rows)
})

app.get('/projects/:ref/schema-diff', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const from = c.req.query('from')
  const to = c.req.query('to')
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = from && to
    ? await pool.query(
      `SELECT id, schema_json FROM schema_snapshots
       WHERE project_id=$1 AND id = ANY($2::uuid[])
       ORDER BY created_at DESC`,
      [project.id, [from, to]]
    )
    : from
      ? await pool.query(
        `(
          SELECT id, schema_json, created_at FROM schema_snapshots
          WHERE project_id=$1 AND id=$2::uuid
        )
        UNION ALL
        (
          SELECT id, schema_json, created_at FROM schema_snapshots
          WHERE project_id=$1 AND id<>$2::uuid
          ORDER BY created_at DESC LIMIT 1
        )
        ORDER BY created_at DESC`,
        [project.id, from]
      )
      : await pool.query(
      `SELECT id, schema_json FROM schema_snapshots
       WHERE project_id=$1 ORDER BY created_at DESC LIMIT 2`,
      [project.id]
      )
  if (rows.length < 2) return c.json({ message: 'Need at least two snapshots' }, 400)
  const newer = to ? rows.find((r) => r.id === to) ?? rows[0] : rows[0]
  const older = from ? rows.find((r) => r.id === from) ?? rows[1] : rows[1]
  return c.json({ from: older.id, to: newer.id, diff: schemaDiff(older.schema_json, newer.schema_json) })
})

app.get('/projects/:ref/inspectors', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const sql = `
    select jsonb_build_object(
      'tables', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and c.relkind in ('r','p')),
      'views', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg_%' and c.relkind in ('v','m')),
      'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like 'pg_%'),
      'extensions', (select count(*) from pg_extension),
      'database_size_bytes', pg_database_size(current_database())
    ) as overview`
  const rows = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  return c.json(rows?.[0]?.overview ?? {})
})

app.get('/projects/:ref/backups', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, status, backup_key, size_bytes, restore_of_backup_id, error,
            verified_at, verification_status, verification_error, metadata,
            created_at, completed_at
     FROM project_backups WHERE project_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [project.id]
  )
  return c.json(rows)
})

app.post('/projects/:ref/backups', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `INSERT INTO project_backups(project_id, status, created_by)
     VALUES($1, 'running', $2)
     RETURNING id, created_at`,
    [project.id, userId]
  )
  const backupId = rows[0].id
  execAsync(`bash "${SCRIPTS_DIR}/backup.sh" "${ref}"`)
    .then(async ({ stdout }) => {
      const backupKey = parseBackupKey(stdout)
      await pool.query(
        `UPDATE project_backups
         SET status='completed', backup_key=$1, completed_at=NOW()
         WHERE id=$2`,
        [backupKey, backupId]
      )
    })
    .catch(async (err) => {
      await pool.query(
        `UPDATE project_backups SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
        [err.message, backupId]
      ).catch(() => {})
    })
  return c.json({ id: backupId, status: 'running' }, 202)
})

app.get('/projects/:ref/backup-verifications', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 50, 100)
  const { rows } = await pool.query(
    `SELECT id, backup_key, status, size_bytes, checked_at, error, metadata
     FROM project_backup_verifications
     WHERE project_id=$1
     ORDER BY checked_at DESC
     LIMIT $2`,
    [project.id, limit]
  )
  return c.json(rows)
})

app.post('/projects/:ref/backups/verify', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const backupKey = String(body.backup_key ?? '').trim()
  const args = backupKey ? shellQuote(backupKey) : ''
  const { rows } = await pool.query(
    `INSERT INTO project_operation_runs(project_id, job_type, status, summary)
     VALUES($1, 'backup_verify', 'running', $2) RETURNING id`,
    [project.id, JSON.stringify({ backup_key: backupKey || null })]
  )
  const runId = rows[0].id
  execAsync(`bash "${SCRIPTS_DIR}/verify-backup.sh" "${ref}" ${args}`, { maxBuffer: 1024 * 1024 })
    .then(async ({ stdout }) => {
      const result = JSON.parse(stdout)
      await pool.query(
        `INSERT INTO project_backup_verifications(project_id, backup_key, status, size_bytes, error, metadata)
         VALUES($1, $2, $3, $4, $5, $6)`,
        [
          project.id,
          result.backup_key ?? (backupKey || null),
          result.status,
          result.size_bytes ?? null,
          result.error ?? null,
          JSON.stringify(result),
        ]
      )
      if (result.backup_key) {
        await pool.query(
          `UPDATE project_backups
           SET verified_at=NOW(),
               verification_status=$3,
               verification_error=$4,
               size_bytes=COALESCE(size_bytes, $5),
               metadata=metadata || $6::jsonb
           WHERE project_id=$1 AND backup_key=$2`,
          [
            project.id,
            result.backup_key,
            result.status === 'verified' ? 'verified' : 'failed',
            result.error ?? null,
            result.size_bytes ?? null,
            JSON.stringify({ last_verification: result }),
          ]
        )
      }
      await pool.query(
        `UPDATE project_operation_runs
         SET status=$1, summary=$2, completed_at=NOW()
         WHERE id=$3`,
        [result.status === 'verified' ? 'completed' : 'failed', JSON.stringify(result), runId]
      )
    })
    .catch(async (err) => {
      const result = { status: 'failed', backup_key: backupKey || null, error: err.message }
      await pool.query(
        `INSERT INTO project_backup_verifications(project_id, backup_key, status, error, metadata)
         VALUES($1, $2, 'failed', $3, $4)`,
        [project.id, backupKey || null, err.message, JSON.stringify(result)]
      ).catch(() => {})
      await pool.query(
        `UPDATE project_operation_runs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
        [err.message, runId]
      ).catch(() => {})
    })
  await auditEvent(project.id, userId, 'project.backup_verification.queued', { run_id: runId, backup_key: backupKey || null }, 'project_backup', backupKey || ref)
  return c.json({ id: runId, status: 'running', backup_key: backupKey || null }, 202)
})

app.get('/projects/:ref/pitr', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, status, wal_level, archive_mode, archive_command,
            archived_wal_count, latest_wal, archiver_failed_count,
            last_archived_wal, last_archived_at, last_failed_wal, last_failed_at,
            offsite_wal_count, latest_offsite_wal, offsite_synced_at, offsite_error,
            checked_at, error, metadata
     FROM project_pitr_status
     WHERE project_id=$1
     ORDER BY checked_at DESC
     LIMIT 20`,
    [project.id]
  )
  return c.json(rows)
})

app.post('/projects/:ref/pitr/enable', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `INSERT INTO project_operation_runs(project_id, job_type, status)
     VALUES($1, 'pitr_enable', 'running') RETURNING id`,
    [project.id]
  )
  const runId = rows[0].id
  execAsync(`bash "${SCRIPTS_DIR}/enable-pitr.sh" "${ref}"`, { maxBuffer: 1024 * 1024 })
    .then(async ({ stdout, stderr }) => {
      let offsite = {}
      try {
        const syncOut = await execAsync(`bash "${SCRIPTS_DIR}/sync-wal-archive.sh" "${ref}"`, { maxBuffer: 1024 * 1024 * 8 })
        offsite = JSON.parse(syncOut.stdout)
      } catch (err: any) {
        offsite = { offsite_error: err.stdout ? String(err.stdout).trim() : err.message }
      }
      const statusOut = await execAsync(`bash "${SCRIPTS_DIR}/pitr-status.sh" "${ref}"`, { maxBuffer: 1024 * 1024 })
      const result = { ...offsite, ...JSON.parse(statusOut.stdout) }
      await pool.query(
        `INSERT INTO project_pitr_status
           (project_id, status, wal_level, archive_mode, archive_command,
            archived_wal_count, latest_wal, archiver_failed_count,
            last_archived_wal, last_archived_at, last_failed_wal, last_failed_at,
            offsite_wal_count, latest_offsite_wal, offsite_synced_at, offsite_error,
            error, metadata)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          project.id,
          result.status,
          result.wal_level ?? null,
          result.archive_mode ?? null,
          result.archive_command ?? null,
          result.archived_wal_count ?? 0,
          result.latest_wal ?? null,
          result.archiver_failed_count ?? 0,
          result.last_archived_wal ?? null,
          result.last_archived_at ?? null,
          result.last_failed_wal ?? null,
          result.last_failed_at ?? null,
          result.offsite_wal_count ?? 0,
          result.latest_offsite_wal ?? null,
          result.offsite_synced_at ?? null,
          result.offsite_error ?? null,
          result.error ?? null,
          JSON.stringify(result),
        ]
      )
      await pool.query(
        `UPDATE project_operation_runs
         SET status=$1, summary=$2, log=$3, error=$4, completed_at=NOW()
         WHERE id=$5`,
        [
          result.status === 'enabled' ? 'completed' : 'failed',
          JSON.stringify(result),
          [stdout, stderr].filter(Boolean).join('\n').slice(-20000),
          result.status === 'enabled' ? null : (result.error ?? `PITR status is ${result.status}`),
          runId,
        ]
      )
    })
    .catch(async (err) => {
      const result = { project_ref: ref, status: 'failed', error: err.message }
      await pool.query(
        `INSERT INTO project_pitr_status(project_id, status, error, metadata)
         VALUES($1, 'failed', $2, $3)`,
        [project.id, err.message, JSON.stringify(result)]
      ).catch(() => {})
      await pool.query(
        `UPDATE project_operation_runs SET status='failed', error=$1, log=$2, completed_at=NOW() WHERE id=$3`,
        [err.message, [err.stdout, err.stderr].filter(Boolean).join('\n').slice(-20000), runId]
      ).catch(() => {})
    })
  await auditEvent(project.id, userId, 'project.pitr_enable.queued', { run_id: runId }, 'project', ref)
  return c.json({ id: runId, status: 'running' }, 202)
})

app.post('/projects/:ref/pitr/status/collect', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  let offsite = {}
  try {
    const syncOut = await execAsync(`bash "${SCRIPTS_DIR}/sync-wal-archive.sh" "${ref}"`, { maxBuffer: 1024 * 1024 * 8 })
    offsite = JSON.parse(syncOut.stdout)
  } catch (err: any) {
    offsite = { offsite_error: err.stdout ? String(err.stdout).trim() : err.message }
  }
  const { stdout } = await execAsync(`bash "${SCRIPTS_DIR}/pitr-status.sh" "${ref}"`, { maxBuffer: 1024 * 1024 })
  const result = { ...offsite, ...JSON.parse(stdout) }
  const { rows } = await pool.query(
    `INSERT INTO project_pitr_status
       (project_id, status, wal_level, archive_mode, archive_command,
        archived_wal_count, latest_wal, archiver_failed_count,
        last_archived_wal, last_archived_at, last_failed_wal, last_failed_at,
        offsite_wal_count, latest_offsite_wal, offsite_synced_at, offsite_error,
        error, metadata)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id, status, wal_level, archive_mode, archived_wal_count, latest_wal,
       archiver_failed_count, last_archived_wal, last_archived_at, last_failed_wal,
       last_failed_at, offsite_wal_count, latest_offsite_wal, offsite_synced_at,
       offsite_error, checked_at, error, metadata`,
    [
      project.id,
      result.status,
      result.wal_level ?? null,
      result.archive_mode ?? null,
      result.archive_command ?? null,
      result.archived_wal_count ?? 0,
      result.latest_wal ?? null,
      result.archiver_failed_count ?? 0,
      result.last_archived_wal ?? null,
      result.last_archived_at ?? null,
      result.last_failed_wal ?? null,
      result.last_failed_at ?? null,
      result.offsite_wal_count ?? 0,
      result.latest_offsite_wal ?? null,
      result.offsite_synced_at ?? null,
      result.offsite_error ?? null,
      result.error ?? null,
      JSON.stringify(result),
    ]
  )
  await auditEvent(project.id, userId, 'project.pitr_status.collected', result, 'project', ref)
  return c.json(rows[0])
})

app.get('/projects/:ref/restore-drills', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 50, 100)
  const { rows } = await pool.query(
    `SELECT id, backup_key, status, duration_ms, temp_database, checked_at, error, metadata
     FROM project_restore_drills
     WHERE project_id=$1
     ORDER BY checked_at DESC
     LIMIT $2`,
    [project.id, limit]
  )
  return c.json(rows)
})

app.post('/projects/:ref/restore-drills', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const backupKey = String(body.backup_key ?? '').trim()
  const args = backupKey ? shellQuote(backupKey) : ''
  const { rows } = await pool.query(
    `INSERT INTO project_operation_runs(project_id, job_type, status, summary)
     VALUES($1, 'restore_drill', 'running', $2) RETURNING id`,
    [project.id, JSON.stringify({ backup_key: backupKey || null })]
  )
  const runId = rows[0].id
  execAsync(`bash "${SCRIPTS_DIR}/restore-drill.sh" "${ref}" ${args}`, { maxBuffer: 1024 * 1024 * 8 })
    .then(async ({ stdout }) => {
      const result = JSON.parse(stdout)
      await pool.query(
        `INSERT INTO project_restore_drills(project_id, backup_key, status, duration_ms, temp_database, error, metadata)
         VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [project.id, result.backup_key ?? (backupKey || null), result.status, result.duration_ms ?? null, result.temp_database ?? null, result.error ?? null, JSON.stringify(result)]
      )
      await pool.query(
        `UPDATE project_operation_runs SET status=$1, summary=$2, completed_at=NOW() WHERE id=$3`,
        [result.status === 'verified' ? 'completed' : 'failed', JSON.stringify(result), runId]
      )
    })
    .catch(async (err) => {
      const result = { status: 'failed', backup_key: backupKey || null, error: err.message }
      await pool.query(
        `INSERT INTO project_restore_drills(project_id, backup_key, status, error, metadata)
         VALUES($1, $2, 'failed', $3, $4)`,
        [project.id, backupKey || null, err.message, JSON.stringify(result)]
      ).catch(() => {})
      await pool.query(
        `UPDATE project_operation_runs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
        [err.message, runId]
      ).catch(() => {})
    })
  await auditEvent(project.id, userId, 'project.restore_drill.queued', { run_id: runId, backup_key: backupKey || null }, 'project', ref)
  return c.json({ id: runId, status: 'running', backup_key: backupKey || null }, 202)
})

app.get('/projects/:ref/alerts', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 100, 200)
  const { rows } = await pool.query(
    `SELECT id, severity, event_type, title, message, delivery_status,
            delivery_target, error, metadata, created_at, delivered_at
     FROM project_alert_events
     WHERE project_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [project.id, limit]
  )
  return c.json(rows)
})

app.post('/projects/:ref/restores', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const body = await c.req.json().catch(() => ({}))
  const backupId = body.backup_id
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows: backups } = await pool.query(
    `SELECT id, backup_key FROM project_backups
     WHERE id=$1 AND project_id=$2 AND status='completed'`,
    [backupId, project.id]
  )
  if (!backups.length || !backups[0].backup_key) return c.json({ message: 'Backup not found' }, 404)
  const { rows } = await pool.query(
    `INSERT INTO project_backups(project_id, status, restore_of_backup_id, created_by)
     VALUES($1, 'running', $2, $3)
     RETURNING id`,
    [project.id, backups[0].id, userId]
  )
  const restoreId = rows[0].id
  execAsync(`bash "${SCRIPTS_DIR}/restore.sh" "${ref}" "${backups[0].backup_key}"`)
    .then(async () => {
      await pool.query(
        `UPDATE project_backups SET status='completed', completed_at=NOW() WHERE id=$1`,
        [restoreId]
      )
    })
    .catch(async (err) => {
      await pool.query(
        `UPDATE project_backups SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
        [err.message, restoreId]
      ).catch(() => {})
    })
  return c.json({ id: restoreId, status: 'running' }, 202)
})

app.get('/projects/:ref/branches', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.status, b.error, b.created_at, p.ref, p.site_url
     FROM project_branches b
     LEFT JOIN projects p ON p.id=b.branch_project_id
     WHERE b.source_project_id=$1
     ORDER BY b.created_at DESC`,
    [project.id]
  )
  return c.json(rows)
})

app.post('/projects/:ref/branches', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name ?? '').trim()
  if (!name) return c.json({ message: 'name is required' }, 400)
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const branchRef = generateRef()
  const { rows: branchRows } = await pool.query(
    `INSERT INTO project_branches(source_project_id, name, status, created_by)
     VALUES($1, $2, 'creating', $3)
     RETURNING id, name, status`,
    [project.id, name, userId]
  )
  const branch = branchRows[0]
  const { rows: projectRows } = await pool.query(
    `INSERT INTO projects(ref, name, org_id, status)
     VALUES($1, $2, $3, 'provisioning')
     RETURNING id`,
    [branchRef, `${project.name} / ${name}`, project.org_id]
  )
  await pool.query(
    `UPDATE project_branches SET branch_project_id=$1 WHERE id=$2`,
    [projectRows[0].id, branch.id]
  )

  import('@/lib/provision').then(({ provisionProject }) =>
    provisionProject(branchRef)
      .then(async (keys) => {
        await pool.query(
          `UPDATE projects SET status='active', site_url=$1, anon_key=$2,
           service_role_key=$3, db_password=$4, jwt_secret=$5,
           storage_s3_access_key=$6, storage_s3_secret_key=$7 WHERE ref=$8`,
          [keys.siteUrl, keys.anonKey, keys.serviceKey, keys.dbPassword, keys.jwtSecret,
           keys.s3AccessKey, keys.s3SecretKey, branchRef]
        )
        const { rows: backupRows } = await pool.query(
          `INSERT INTO project_backups(project_id, status, created_by, metadata)
           VALUES($1, 'running', $2, $3)
           RETURNING id`,
          [
            project.id,
            userId,
            JSON.stringify({ reason: 'branch_create', branch_id: branch.id, branch_ref: branchRef }),
          ]
        )
        let backupKey: string | null = null
        try {
          const { stdout } = await execAsync(`bash "${SCRIPTS_DIR}/backup.sh" "${ref}"`, { maxBuffer: 1024 * 1024 * 8 })
          backupKey = parseBackupKey(stdout)
          await pool.query(
            `UPDATE project_backups
             SET status='completed', backup_key=$1, completed_at=NOW()
             WHERE id=$2`,
            [backupKey, backupRows[0].id]
          )
        } catch (err: any) {
          await pool.query(
            `UPDATE project_backups SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
            [err.message, backupRows[0].id]
          ).catch(() => {})
          throw err
        }
        await execAsync(
          `docker exec -e PGPASSWORD="${project.db_password}" "spn-${ref}-db-1" pg_dump -U postgres -h 127.0.0.1 postgres ` +
          `| docker exec -i "spn-${branchRef}-db-1" psql -U postgres -h 127.0.0.1 postgres`
        )
        if (backupKey) {
          await execAsync(`bash "${SCRIPTS_DIR}/restore-drill.sh" "${ref}" "${backupKey}"`, { maxBuffer: 1024 * 1024 * 8 })
            .then(async ({ stdout }) => {
              const result = JSON.parse(stdout)
              await pool.query(
                `INSERT INTO project_restore_drills(project_id, backup_key, status, duration_ms, temp_database, error, metadata)
                 VALUES($1, $2, $3, $4, $5, $6, $7)`,
                [
                  project.id,
                  result.backup_key ?? backupKey,
                  result.status,
                  result.duration_ms ?? null,
                  result.temp_database ?? null,
                  result.error ?? null,
                  JSON.stringify({ ...result, reason: 'branch_create', branch_id: branch.id, branch_ref: branchRef }),
                ]
              )
            })
            .catch(async (err: any) => {
              await pool.query(
                `INSERT INTO project_restore_drills(project_id, backup_key, status, error, metadata)
                 VALUES($1, $2, 'failed', $3, $4)`,
                [
                  project.id,
                  backupKey,
                  err.message,
                  JSON.stringify({ reason: 'branch_create', branch_id: branch.id, branch_ref: branchRef }),
                ]
              ).catch(() => {})
              throw err
            })
        }
        await pool.query(`UPDATE project_branches SET status='ready' WHERE id=$1`, [branch.id])
      })
      .catch(async (err: any) => {
        await pool.query(
          `UPDATE project_branches SET status='failed', error=$1 WHERE id=$2`,
          [err.message, branch.id]
        ).catch(() => {})
      })
  )

  return c.json({ ...branch, ref: branchRef }, 202)
})

// ─── GET /platform/projects/:ref/status ───────────────────────────────────────
app.get('/projects/:ref/status', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.status, p.site_url, p.service_role_key FROM projects p
     JOIN org_members om ON om.org_id=p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status != 'deleted'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)
  const p = rows[0]

  // If active, probe PostgREST health
  if (p.status === 'active' && p.site_url) {
    try {
      const health = await fetch(`${p.site_url}/rest/v1/`, {
        headers: { apikey: p.service_role_key },
        signal: AbortSignal.timeout(3000),
      })
      return c.json({ status: health.ok ? 'ACTIVE_HEALTHY' : 'ACTIVE_UNHEALTHY' })
    } catch {
      return c.json({ status: 'ACTIVE_UNHEALTHY' })
    }
  }

  return c.json({
    status: p.status === 'provisioning' ? 'COMING_UP' : p.status?.toUpperCase() ?? 'UNKNOWN',
  })
})

app.get('/projects/:ref/services/status', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const authHeaders = { apikey: project.service_role_key, Authorization: `Bearer ${project.service_role_key}` }
  const services = await Promise.all([
    timedProbe('postgrest', `${project.site_url}/rest/v1/`, { apikey: project.service_role_key }),
    timedProbe('auth', `${project.site_url}/auth/v1/health`),
    timedProbe('storage', `${project.site_url}/storage/v1/status`, authHeaders),
    timedProbe('realtime', `${project.site_url}/realtime/v1/`, authHeaders),
    timedProbe('pg-meta', `${project.site_url}/pg/health`, authHeaders),
    timedProbe('functions', `${project.site_url}/functions/v1/`, authHeaders),
  ])

  for (const service of services) {
    await pool.query(
      `INSERT INTO project_service_health(project_id, service, status, latency_ms, detail)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, service) DO UPDATE SET
         status=EXCLUDED.status,
         latency_ms=EXCLUDED.latency_ms,
         detail=EXCLUDED.detail,
         checked_at=NOW()`,
      [project.id, service.service, service.status, service.latency_ms, JSON.stringify(service.detail)]
    )
  }
  return c.json({ services, checked_at: new Date().toISOString() })
})

app.get('/projects/:ref/components', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query('SELECT component_versions FROM projects WHERE id=$1', [project.id])
  return c.json({
    desired: COMPONENT_VERSIONS,
    current: { ...COMPONENT_VERSIONS, ...(rows[0]?.component_versions ?? {}) },
    upgrade_policy: 'manual',
  })
})

app.post('/projects/:ref/upgrade-plan', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const components = Array.isArray(body.components) && body.components.length
    ? body.components
    : Object.keys(COMPONENT_VERSIONS)
  const plan = components.map((component: string) => ({
    component,
    service: COMPONENT_SERVICES[component] ?? component,
    target_version: (COMPONENT_VERSIONS as any)[component] ?? null,
    action: component === 'postgres' ? 'backup-pull-up-health-check' : 'pull-up-health-check',
    requires_backup: ['postgres', 'storage'].includes(component),
    expected_downtime: component === 'postgres' ? 'short' : 'rolling',
  }))
  await auditEvent(project.id, userId, 'project.upgrade_plan.generated', { components }, 'project', ref)
  return c.json({ project_ref: ref, plan })
})

app.get('/projects/:ref/upgrade-runs', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, status, components, from_versions, to_versions, plan,
            backup_id, backup_key, error, created_at, started_at, completed_at
     FROM project_upgrade_runs
     WHERE project_id=$1
     ORDER BY created_at DESC LIMIT 50`,
    [project.id]
  )
  return c.json(rows)
})

app.get('/projects/:ref/upgrade-runs/:runId', async (c) => {
  const userId = c.get('userId')
  const { ref, runId } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, status, components, from_versions, to_versions, plan,
            backup_id, backup_key, log, error, created_at, started_at, completed_at
     FROM project_upgrade_runs
     WHERE id=$1 AND project_id=$2`,
    [runId, project.id]
  )
  if (!rows.length) return c.json({ message: 'Upgrade run not found' }, 404)
  return c.json(rows[0])
})

app.post('/projects/:ref/upgrades', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const requested = Array.isArray(body.components) && body.components.length
    ? body.components
    : Object.keys(COMPONENT_VERSIONS)
  const components = requested.filter((component: string) => COMPONENT_SERVICES[component] || component === 'all')
  if (!components.length) return c.json({ message: 'No valid components requested' }, 400)

  const { rows: versionRows } = await pool.query('SELECT component_versions FROM projects WHERE id=$1', [project.id])
  const fromVersions = { ...COMPONENT_VERSIONS, ...(versionRows[0]?.component_versions ?? {}) }
  const toVersions = body.to_versions ?? COMPONENT_VERSIONS
  const plan = components.map((component: string) => ({
    component,
    service: COMPONENT_SERVICES[component] ?? component,
    from_version: (fromVersions as any)[component] ?? null,
    to_version: (toVersions as any)[component] ?? null,
    requires_backup: body.skip_backup === true ? false : ['postgres', 'storage', 'all'].includes(component),
    health_check: `${project.site_url}/rest/v1/`,
  }))

  const { rows } = await pool.query(
    `INSERT INTO project_upgrade_runs
       (project_id, status, components, from_versions, to_versions, plan, created_by)
     VALUES($1, 'queued', $2, $3, $4, $5, $6)
     RETURNING id, status, components, created_at`,
    [project.id, components, JSON.stringify(fromVersions), JSON.stringify(toVersions), JSON.stringify(plan), userId]
  )
  const runId = rows[0].id
  await auditEvent(project.id, userId, 'project.upgrade.queued', { run_id: runId, components }, 'project_upgrade', runId)

  const services = components.includes('all') ? [] : components.map((component: string) => COMPONENT_SERVICES[component] ?? component)
  const serviceArgs = services.map((service: string) => shellQuote(service)).join(' ')
  const skipBackup = body.skip_backup === true ? '1' : '0'
  const rollbackOnFail = body.rollback_on_fail === false ? '0' : '1'
  const command = `SKIP_BACKUP=${skipBackup} ROLLBACK_ON_FAIL=${rollbackOnFail} HEALTH_URL=${shellQuote(`${project.site_url}/rest/v1/`)} bash "${SCRIPTS_DIR}/upgrade-project.sh" "${ref}" ${serviceArgs}`

  await pool.query('UPDATE project_upgrade_runs SET status=$1, started_at=NOW() WHERE id=$2', ['running', runId])
  execAsync(command, { maxBuffer: 1024 * 1024 * 8 })
    .then(async ({ stdout, stderr }) => {
      const log = [stdout, stderr].filter(Boolean).join('\n')
      const match = log.match(/backed up →\s+([^\s]+)/)
      const backupKey = match?.[1]?.replace(/^spn-backups\//, '') ?? null
      await pool.query(
        `UPDATE project_upgrade_runs
         SET status='completed', backup_key=$1, log=$2, completed_at=NOW()
         WHERE id=$3`,
        [backupKey, log.slice(-50000), runId]
      )
      await pool.query(
        `UPDATE projects SET component_versions=$1, updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(toVersions), project.id]
      )
      await auditEvent(project.id, userId, 'project.upgrade.completed', { run_id: runId, backup_key: backupKey }, 'project_upgrade', runId)
    })
    .catch(async (err) => {
      const log = [err.stdout, err.stderr].filter(Boolean).join('\n')
      await pool.query(
        `UPDATE project_upgrade_runs
         SET status='failed', log=$1, error=$2, completed_at=NOW()
         WHERE id=$3`,
        [log.slice(-50000), err.message, runId]
      ).catch(() => {})
      await auditEvent(project.id, userId, 'project.upgrade.failed', { run_id: runId, error: err.message }, 'project_upgrade', runId)
    })

  return c.json({ id: runId, status: 'running', components, plan }, 202)
})

app.post('/projects/:ref/upgrade-runs/:runId/rollback', async (c) => {
  const userId = c.get('userId')
  const { ref, runId } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, components, from_versions, backup_key FROM project_upgrade_runs
     WHERE id=$1 AND project_id=$2`,
    [runId, project.id]
  )
  if (!rows.length) return c.json({ message: 'Upgrade run not found' }, 404)
  const run = rows[0]
  const services = (run.components ?? []).includes('all')
    ? []
    : (run.components ?? []).map((component: string) => COMPONENT_SERVICES[component] ?? component)
  const serviceArgs = services.map((service: string) => shellQuote(service)).join(' ')
  const restoreCommand = run.backup_key
    ? `bash "${SCRIPTS_DIR}/restore.sh" "${ref}" "${run.backup_key}" && `
    : ''
  execAsync(`${restoreCommand}bash "${SCRIPTS_DIR}/restart-project.sh" "${ref}" ${serviceArgs}`, { maxBuffer: 1024 * 1024 * 8 })
    .then(async ({ stdout, stderr }) => {
      const log = [stdout, stderr].filter(Boolean).join('\n')
      await pool.query(
        `UPDATE project_upgrade_runs
         SET status='rolled_back', log=COALESCE(log, '') || $1, completed_at=NOW()
         WHERE id=$2`,
        [`\n\n== rollback ==\n${log.slice(-20000)}`, runId]
      )
      await pool.query('UPDATE projects SET component_versions=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(run.from_versions), project.id])
      await auditEvent(project.id, userId, 'project.upgrade.rolled_back', { run_id: runId, restored_backup: Boolean(run.backup_key) }, 'project_upgrade', runId)
    })
    .catch(async (err) => {
      await pool.query(
        `UPDATE project_upgrade_runs SET error=$1, completed_at=NOW() WHERE id=$2`,
        [`rollback failed: ${err.message}`, runId]
      ).catch(() => {})
      await auditEvent(project.id, userId, 'project.upgrade.rollback_failed', { run_id: runId, error: err.message }, 'project_upgrade', runId)
    })
  return c.json({ id: runId, status: 'rollback_running', restores_backup: Boolean(run.backup_key) }, 202)
})

app.get('/projects/:ref/quotas', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query('SELECT quotas FROM projects WHERE id=$1', [project.id])
  return c.json(rows[0]?.quotas ?? {})
})

app.patch('/projects/:ref/quotas', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const updates = await c.req.json()
  const { rows } = await pool.query(
    `UPDATE projects SET quotas=quotas || $2::jsonb, updated_at=NOW()
     WHERE id=$1 RETURNING quotas`,
    [project.id, JSON.stringify(updates)]
  )
  await auditEvent(project.id, userId, 'project.quotas.updated', { keys: Object.keys(updates) }, 'project', ref)
  return c.json(rows[0].quotas)
})

app.get('/projects/:ref/usage', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT metric_date, db_size_mb, api_requests, auth_mau, storage_mb, created_at
     FROM usage_metrics WHERE project_id=$1 ORDER BY metric_date DESC LIMIT 30`,
    [project.id]
  )
  return c.json(rows)
})

app.post('/projects/:ref/usage/collect', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const sql = `
    select
      pg_database_size(current_database()) / 1024.0 / 1024.0 as db_size_mb,
      coalesce((select count(*) from auth.users where created_at > now() - interval '30 days'), 0) as auth_mau,
      coalesce((select sum(metadata->>'size')::numeric / 1024.0 / 1024.0 from storage.objects), 0) as storage_mb`
  const data = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  const metrics = data?.[0] ?? {}
  const { rows } = await pool.query(
    `INSERT INTO usage_metrics(project_id, metric_date, db_size_mb, auth_mau, storage_mb)
     VALUES($1, CURRENT_DATE, $2, $3, $4)
     ON CONFLICT (project_id, metric_date) DO UPDATE SET
       db_size_mb=EXCLUDED.db_size_mb,
       auth_mau=EXCLUDED.auth_mau,
       storage_mb=EXCLUDED.storage_mb,
       created_at=NOW()
     RETURNING metric_date, db_size_mb, api_requests, auth_mau, storage_mb, created_at`,
    [project.id, metrics.db_size_mb ?? 0, metrics.auth_mau ?? 0, metrics.storage_mb ?? 0]
  )
  await auditEvent(project.id, userId, 'project.usage.collected', rows[0], 'project', ref)
  return c.json(rows[0])
})

app.get('/projects/:ref/audit', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, event_type, target_type, target_id, metadata, created_at
     FROM project_audit_events
     WHERE project_id=$1 ORDER BY created_at DESC LIMIT 200`,
    [project.id]
  )
  return c.json(rows)
})

app.get('/projects/:ref/operations', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 100, 500)
  const { rows } = await pool.query(
    `SELECT id, job_type, status, summary, error, started_at, completed_at
     FROM project_operation_runs
     WHERE project_id=$1
     ORDER BY started_at DESC
     LIMIT $2`,
    [project.id, limit]
  )
  return c.json(rows)
})

app.get('/projects/:ref/jobs', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT job_type, enabled, interval_minutes, config, last_run_at, next_run_at, updated_at
     FROM project_job_schedules
     WHERE project_id=$1
     ORDER BY job_type`,
    [project.id]
  )
  return c.json(rows)
})

app.patch('/projects/:ref/jobs/:jobType', async (c) => {
  const userId = c.get('userId')
  const { ref, jobType } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO project_job_schedules(project_id, job_type, enabled, interval_minutes, config, next_run_at)
     VALUES($1, $2, $3, $4, $5, NOW())
     ON CONFLICT(project_id, job_type) DO UPDATE SET
       enabled=COALESCE(EXCLUDED.enabled, project_job_schedules.enabled),
       interval_minutes=COALESCE(EXCLUDED.interval_minutes, project_job_schedules.interval_minutes),
       config=project_job_schedules.config || EXCLUDED.config,
       next_run_at=CASE WHEN $6::boolean THEN NOW() ELSE project_job_schedules.next_run_at END,
       updated_at=NOW()
     RETURNING job_type, enabled, interval_minutes, config, last_run_at, next_run_at, updated_at`,
    [
      project.id,
      jobType,
      body.enabled ?? true,
      body.interval_minutes ?? 60,
      JSON.stringify(body.config ?? {}),
      Boolean(body.run_now),
    ]
  )
  await auditEvent(project.id, userId, 'project.job_schedule.updated', { job_type: jobType, keys: Object.keys(body) }, 'project_job', jobType)
  return c.json(rows[0])
})

app.post('/projects/:ref/logs/collect', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const sinceMinutes = parsePositiveInt(String(body.since_minutes ?? '20'), 20, 1440)
  const { rows } = await pool.query(
    `INSERT INTO project_operation_runs(project_id, job_type, status)
     VALUES($1, 'log_collect', 'running') RETURNING id`,
    [project.id]
  )
  const runId = rows[0].id
  execAsync(`bash "${SCRIPTS_DIR}/collect-logs.sh" "${ref}" "${sinceMinutes}"`, { maxBuffer: 1024 * 1024 * 8 })
    .then(async ({ stdout, stderr }) => {
      const entries = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
      for (const entry of entries) {
        await pool.query(
          `INSERT INTO project_log_entries(project_id, service, level, message, metadata, fingerprint, occurred_at)
           VALUES($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT(project_id, fingerprint) DO NOTHING`,
          [
            project.id,
            entry.service,
            entry.level,
            entry.message,
            JSON.stringify(entry.metadata ?? {}),
            entry.fingerprint,
            entry.occurred_at,
          ]
        )
      }
      await pool.query(
        `UPDATE project_operation_runs
         SET status='completed', summary=$1, log=$2, completed_at=NOW()
         WHERE id=$3`,
        [JSON.stringify({ inserted_or_seen: entries.length }), stderr.slice(-20000), runId]
      )
    })
    .catch(async (err) => {
      await pool.query(
        `UPDATE project_operation_runs SET status='failed', error=$1, log=$2, completed_at=NOW() WHERE id=$3`,
        [err.message, [err.stdout, err.stderr].filter(Boolean).join('\n').slice(-20000), runId]
      ).catch(() => {})
    })
  await auditEvent(project.id, userId, 'project.logs.collect_queued', { run_id: runId, since_minutes: sinceMinutes }, 'project_logs', ref)
  return c.json({ id: runId, status: 'running' }, 202)
})

app.get('/projects/:ref/logs', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 100, 500)
  const service = c.req.query('service')
  const level = c.req.query('level')
  const q = c.req.query('q')
  const values: any[] = [project.id]
  const where = ['project_id=$1']
  if (service) {
    values.push(service)
    where.push(`service=$${values.length}`)
  }
  if (level) {
    values.push(level)
    where.push(`level=$${values.length}`)
  }
  if (q) {
    values.push(`%${q}%`)
    where.push(`message ILIKE $${values.length}`)
  }
  values.push(limit)
  const { rows } = await pool.query(
    `SELECT id, service, level, message, metadata, occurred_at, collected_at
     FROM project_log_entries
     WHERE ${where.join(' AND ')}
     ORDER BY occurred_at DESC
     LIMIT $${values.length}`,
    values
  )
  return c.json(rows)
})

app.get('/realtime/:ref/settings', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT presence_enabled, broadcast_enabled, postgres_changes_enabled,
            max_channels_per_client, max_events_per_second, max_payload_kb,
            retention_hours, updated_at
     FROM realtime_settings WHERE project_id=$1`,
    [project.id]
  )
  return c.json(rows[0] ?? {
    presence_enabled: true,
    broadcast_enabled: true,
    postgres_changes_enabled: true,
    max_channels_per_client: 100,
    max_events_per_second: 100,
    max_payload_kb: 256,
    retention_hours: 24,
    updated_at: null,
  })
})

app.patch('/realtime/:ref/settings', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO realtime_settings
       (project_id, presence_enabled, broadcast_enabled, postgres_changes_enabled,
        max_channels_per_client, max_events_per_second, max_payload_kb, retention_hours, updated_by)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(project_id) DO UPDATE SET
       presence_enabled=COALESCE(EXCLUDED.presence_enabled, realtime_settings.presence_enabled),
       broadcast_enabled=COALESCE(EXCLUDED.broadcast_enabled, realtime_settings.broadcast_enabled),
       postgres_changes_enabled=COALESCE(EXCLUDED.postgres_changes_enabled, realtime_settings.postgres_changes_enabled),
       max_channels_per_client=COALESCE(EXCLUDED.max_channels_per_client, realtime_settings.max_channels_per_client),
       max_events_per_second=COALESCE(EXCLUDED.max_events_per_second, realtime_settings.max_events_per_second),
       max_payload_kb=COALESCE(EXCLUDED.max_payload_kb, realtime_settings.max_payload_kb),
       retention_hours=COALESCE(EXCLUDED.retention_hours, realtime_settings.retention_hours),
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING presence_enabled, broadcast_enabled, postgres_changes_enabled,
       max_channels_per_client, max_events_per_second, max_payload_kb, retention_hours, updated_at`,
    [
      project.id,
      body.presence_enabled ?? null,
      body.broadcast_enabled ?? null,
      body.postgres_changes_enabled ?? null,
      body.max_channels_per_client ?? null,
      body.max_events_per_second ?? null,
      body.max_payload_kb ?? null,
      body.retention_hours ?? null,
      userId,
    ]
  )
  await auditEvent(project.id, userId, 'realtime.settings.updated', { keys: Object.keys(body) }, 'realtime', ref)
  return c.json(rows[0])
})

app.get('/realtime/:ref/cdc', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const sql = `
    select coalesce(jsonb_agg(jsonb_build_object(
      'schema', schemaname,
      'table', tablename
    ) order by schemaname, tablename), '[]'::jsonb) as tables
    from pg_publication_tables
    where pubname = 'supabase_realtime'`
  const data = await fetchPgMetaQuery(project.site_url, project.service_role_key, sql)
  return c.json(data?.[0]?.tables ?? [])
})

app.post('/realtime/:ref/cdc', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const schema = body.schema ?? 'public'
  const table = body.table
  if (!table) return c.json({ message: 'table is required' }, 400)
  const publicationSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = ${sqlLiteral(schema)}
          AND tablename = ${sqlLiteral(table)}
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I.%I', ${sqlLiteral(schema)}, ${sqlLiteral(table)});
      END IF;
    END $$;
    ${body.replica_identity_full ? `ALTER TABLE ${sqlIdent(schema)}.${sqlIdent(table)} REPLICA IDENTITY FULL;` : ''}`
  await fetchPgMetaQuery(project.site_url, project.service_role_key, publicationSql)
  await auditEvent(project.id, userId, 'realtime.cdc.enabled', { schema, table, replica_identity_full: Boolean(body.replica_identity_full) }, 'realtime_cdc', `${schema}.${table}`)
  return c.json({ schema, table, postgres_changes_enabled: true, status: 'enabled' })
})

app.delete('/realtime/:ref/cdc/:schema/:table', async (c) => {
  const userId = c.get('userId')
  const { ref, schema, table } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  await fetchPgMetaQuery(
    project.site_url,
    project.service_role_key,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = ${sqlLiteral(schema)}
           AND tablename = ${sqlLiteral(table)}
       ) THEN
         EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I.%I', ${sqlLiteral(schema)}, ${sqlLiteral(table)});
       END IF;
     END $$;`
  )
  await auditEvent(project.id, userId, 'realtime.cdc.disabled', { schema, table }, 'realtime_cdc', `${schema}.${table}`)
  return c.json({ schema, table, status: 'disabled' })
})

app.get('/realtime/:ref/metrics', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT metric_date, cdc_tables, active_channels, presence_enabled,
            broadcast_enabled, postgres_changes_enabled, health, created_at
     FROM realtime_metrics WHERE project_id=$1 ORDER BY metric_date DESC LIMIT 30`,
    [project.id]
  )
  return c.json(rows)
})

app.post('/realtime/:ref/metrics/collect', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const settingsRes = await pool.query('SELECT * FROM realtime_settings WHERE project_id=$1', [project.id])
  const settings = settingsRes.rows[0] ?? {
    presence_enabled: true,
    broadcast_enabled: true,
    postgres_changes_enabled: true,
  }
  const data = await fetchPgMetaQuery(
    project.site_url,
    project.service_role_key,
    `select count(*)::int as cdc_tables from pg_publication_tables where pubname='supabase_realtime'`
  )
  const health = await timedProbe('realtime', `${project.site_url}/realtime/v1/`, {
    apikey: project.service_role_key,
    Authorization: `Bearer ${project.service_role_key}`,
  })
  const { rows } = await pool.query(
    `INSERT INTO realtime_metrics
       (project_id, metric_date, cdc_tables, active_channels, presence_enabled,
        broadcast_enabled, postgres_changes_enabled, health)
     VALUES($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(project_id, metric_date) DO UPDATE SET
       cdc_tables=EXCLUDED.cdc_tables,
       active_channels=EXCLUDED.active_channels,
       presence_enabled=EXCLUDED.presence_enabled,
       broadcast_enabled=EXCLUDED.broadcast_enabled,
       postgres_changes_enabled=EXCLUDED.postgres_changes_enabled,
       health=EXCLUDED.health,
       created_at=NOW()
     RETURNING metric_date, cdc_tables, active_channels, presence_enabled,
       broadcast_enabled, postgres_changes_enabled, health, created_at`,
    [
      project.id,
      data?.[0]?.cdc_tables ?? 0,
      0,
      settings.presence_enabled,
      settings.broadcast_enabled,
      settings.postgres_changes_enabled,
      JSON.stringify(health),
    ]
  )
  await auditEvent(project.id, userId, 'realtime.metrics.collected', rows[0], 'realtime', ref)
  return c.json(rows[0])
})

app.get('/realtime/:ref/debug-events', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, event_type, channel, payload, result, created_at
     FROM realtime_debug_events
     WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [project.id]
  )
  return c.json(rows)
})

app.get('/realtime/:ref/client-config', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const channel = c.req.query('channel') ?? 'supanow-debug'
  return c.json({
    project_ref: ref,
    realtime_url: `${project.site_url}/realtime/v1`,
    supabase_url: project.site_url,
    anon_key: project.anon_key,
    sample_channel: channel,
    javascript: {
      package: '@supabase/supabase-js',
      snippet: [
        `const supabase = createClient(${JSON.stringify(project.site_url)}, ${JSON.stringify(project.anon_key)})`,
        `const channel = supabase.channel(${JSON.stringify(channel)})`,
        "channel.on('broadcast', { event: 'supanow_debug' }, (payload) => console.log(payload)).subscribe()",
      ].join('\n'),
    },
    modes: ['presence', 'broadcast', 'postgres_changes'],
  })
})

app.get('/realtime/:ref/debug-sessions', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const limit = parsePositiveInt(c.req.query('limit'), 50, 100)
  const { rows } = await pool.query(
    `SELECT id, channel, mode, client_config, status, result, created_at, updated_at
     FROM realtime_debug_sessions
     WHERE project_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [project.id, limit]
  )
  return c.json(rows)
})

app.post('/realtime/:ref/debug-sessions', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const channel = String(body.channel ?? 'supanow-debug')
  const mode = String(body.mode ?? 'broadcast')
  const clientConfig = {
    supabase_url: project.site_url,
    realtime_url: `${project.site_url}/realtime/v1`,
    anon_key: project.anon_key,
    channel,
    modes: ['presence', 'broadcast', 'postgres_changes'],
  }
  const result: any = body.run_now
    ? await timedProbe('realtime', `${project.site_url}/realtime/v1/`, {
      apikey: project.service_role_key,
      Authorization: `Bearer ${project.service_role_key}`,
    })
    : {}
  const status = body.run_now ? (result.status === 'healthy' ? 'tested' : 'failed') : 'created'
  const { rows } = await pool.query(
    `INSERT INTO realtime_debug_sessions
       (project_id, channel, mode, client_config, status, result, created_by)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, channel, mode, client_config, status, result, created_at, updated_at`,
    [project.id, channel, mode, JSON.stringify(clientConfig), status, JSON.stringify(result), userId]
  )
  await auditEvent(project.id, userId, 'realtime.debug_session.created', { channel, mode, status }, 'realtime', channel)
  return c.json(rows[0], 201)
})

app.post('/realtime/:ref/debug', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await getProjectKongCreds(ref, userId)
  if (!project) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const channel = body.channel ?? 'supanow-debug'
  const payload = body.payload ?? { ok: true, at: new Date().toISOString() }
  const health = await timedProbe('realtime', `${project.site_url}/realtime/v1/`, {
    apikey: project.service_role_key,
    Authorization: `Bearer ${project.service_role_key}`,
  })
  let broadcast: any = { attempted: false, status: 'skipped' }
  if (body.broadcast === true) {
    try {
      const res = await fetch(`${project.site_url}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          apikey: project.service_role_key,
          Authorization: `Bearer ${project.service_role_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ topic: channel, event: body.event ?? 'supanow_debug', payload }],
        }),
      })
      broadcast = { attempted: true, http_status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
    } catch (err: any) {
      broadcast = { attempted: true, ok: false, error: err.message }
    }
  }
  const result = {
    health,
    broadcast,
    client: {
      url: `${project.site_url}/realtime/v1`,
      topic: channel,
      modes: ['presence', 'broadcast', 'postgres_changes'],
    },
  }
  await pool.query(
    `INSERT INTO realtime_debug_events(project_id, event_type, channel, payload, result, created_by)
     VALUES($1, $2, $3, $4, $5, $6)`,
    [project.id, body.event ?? 'supanow_debug', channel, JSON.stringify(payload), JSON.stringify(result), userId]
  )
  await auditEvent(project.id, userId, 'realtime.debug.ran', { channel, broadcast: broadcast.attempted }, 'realtime', channel)
  return c.json(result)
})

// ─── GET /platform/projects/:ref/connection-string ────────────────────────────
app.get('/projects/:ref/connection-string', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.db_password, p.site_url FROM projects p
     JOIN org_members om ON om.org_id=p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ message: 'Not found' }, 404)
  const { db_password, site_url } = rows[0]
  return c.json({
    uri: `postgresql://postgres:${db_password}@db.${ref}.db.hconsulting.app:5432/postgres`,
    pooler_uri: null,
    host: `db.${ref}.db.hconsulting.app`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: db_password,
    sslmode: 'require',
  })
})

// ─── GET /platform/projects/:ref/resources/:id ────────────────────────────────
// Studio calls this for compute size display; return a stub
app.get('/projects/:ref/resources/:id', (c) => {
  const { ref } = c.req.param()
  return c.json({
    identifier: 'ci_micro',
    name: 'Self-hosted container',
    type: 'compute_instance',
    price: 0,
    price_interval: 'monthly',
    project_ref: ref,
    cpu: 'shared',
    memory_mb: null,
    disk_volume_size_gb: 8,
  })
})

// ─── POST /platform/projects/:ref/transfer ────────────────────────────────────
app.post('/projects/:ref/transfer', (c) =>
  c.json({ message: 'Project transfer not supported' }, 501)
)

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE PROXY — /platform/storage/{ref}/* → project Storage API via Kong
// Storage API is at {siteUrl}/storage/v1/
// ═══════════════════════════════════════════════════════════════════════════════

async function getProjectStorageCreds(ref: string, userId: string) {
  if (!REF_RE.test(ref)) return null
  const { rows } = await pool.query(
    `SELECT p.id, p.ref, p.quotas, p.service_role_key, p.site_url,
            p.storage_s3_access_key, p.storage_s3_secret_key, p.status
     FROM projects p JOIN org_members om ON om.org_id=p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  return rows[0] ?? null
}

async function storageProxy(
  siteUrl: string,
  serviceKey: string,
  storagePath: string,
  method: string,
  body?: string | null,
  contentType?: string | null
) {
  const url = `${siteUrl}/storage/v1/${storagePath}`
  const res = await fetch(url, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(contentType ? { 'Content-Type': contentType } : { 'Content-Type': 'application/json' }),
    },
    body: body ?? undefined,
  })
  const text = await res.text()
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  })
}

// Helper to get body as text from Hono context
async function bodyText(c: any): Promise<string | null> {
  try { return await c.req.text() } catch { return null }
}

function safeJson(text: string | null) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 500) } }
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function sqlIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function isSafeSqlIdentifier(value: string) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return `${sqlLiteral(JSON.stringify(value))}::jsonb`
  return sqlLiteral(String(value))
}

function shellQuote(value: unknown) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

function queryFromOptions(options: Record<string, unknown>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

function parsePositiveInt(value: string | undefined, fallback: number, max = 500) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

// ─── Buckets ──────────────────────────────────────────────────────────────────
app.get('/storage/:ref/buckets', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json([], 200)
  return storageProxy(creds.site_url, creds.service_role_key, 'bucket', 'GET')
})

app.post('/storage/:ref/buckets', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  const response = await storageProxy(creds.site_url, creds.service_role_key, 'bucket', 'POST', body)
  await auditEvent(creds.id, userId, 'storage.bucket.created', { body: safeJson(body) }, 'storage_bucket')
  return response
})

app.get('/storage/:ref/buckets/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  return storageProxy(creds.site_url, creds.service_role_key, `bucket/${id}`, 'GET')
})

app.patch('/storage/:ref/buckets/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  const response = await storageProxy(creds.site_url, creds.service_role_key, `bucket/${id}`, 'PUT', body)
  await auditEvent(creds.id, userId, 'storage.bucket.updated', { bucket_id: id, body: safeJson(body) }, 'storage_bucket', id)
  return response
})

app.delete('/storage/:ref/buckets/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const response = await storageProxy(creds.site_url, creds.service_role_key, `bucket/${id}`, 'DELETE')
  await auditEvent(creds.id, userId, 'storage.bucket.deleted', { bucket_id: id }, 'storage_bucket', id)
  return response
})

app.post('/storage/:ref/buckets/:id/empty', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const response = await storageProxy(creds.site_url, creds.service_role_key, `bucket/${id}/empty`, 'POST', '{}')
  await auditEvent(creds.id, userId, 'storage.bucket.emptied', { bucket_id: id }, 'storage_bucket', id)
  return response
})

// ─── Objects ──────────────────────────────────────────────────────────────────
app.post('/storage/:ref/buckets/:id/objects/list', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  return storageProxy(creds.site_url, creds.service_role_key, `object/list/${id}`, 'POST', body)
})

app.get('/storage/:ref/buckets/:id/objects/search', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const q = String(c.req.query('q') ?? '').trim()
  const prefix = String(c.req.query('prefix') ?? '').trim()
  const limit = parsePositiveInt(c.req.query('limit'), 50, 200)
  const sql = `
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'bucket_id', bucket_id,
      'name', name,
      'owner', owner,
      'metadata', metadata,
      'created_at', created_at,
      'updated_at', updated_at,
      'last_accessed_at', last_accessed_at
    ) order by name), '[]'::jsonb) as objects
    from (
      select id, bucket_id, name, owner, metadata, created_at, updated_at, last_accessed_at
      from storage.objects
      where bucket_id = ${sqlLiteral(id)}
        and (${sqlLiteral(prefix)} = '' or name like ${sqlLiteral(`${prefix}%`)})
        and (${sqlLiteral(q)} = '' or name ilike ${sqlLiteral(`%${q}%`)})
      order by name
      limit ${limit}
    ) o`
  const data = await fetchPgMetaQuery(creds.site_url, creds.service_role_key, sql)
  return c.json({ bucket_id: id, q, prefix, objects: data?.[0]?.objects ?? [] })
})

app.get('/storage/:ref/buckets/:id/objects/info', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const objectPath = String(c.req.query('path') ?? '').replace(/^\/+/, '')
  if (!objectPath) return c.json({ message: 'path is required' }, 400)
  const sql = `
    select jsonb_build_object(
      'id', id,
      'bucket_id', bucket_id,
      'name', name,
      'owner', owner,
      'metadata', metadata,
      'created_at', created_at,
      'updated_at', updated_at,
      'last_accessed_at', last_accessed_at,
      'version', version
    ) as object
    from storage.objects
    where bucket_id = ${sqlLiteral(id)}
      and name = ${sqlLiteral(objectPath)}
    limit 1`
  const data = await fetchPgMetaQuery(creds.site_url, creds.service_role_key, sql)
  const object = data?.[0]?.object
  if (!object) return c.json({ message: 'Object not found' }, 404)
  return c.json(object)
})

app.delete('/storage/:ref/buckets/:id/objects', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  const response = await storageProxy(creds.site_url, creds.service_role_key, `object/${id}`, 'DELETE', body)
  await auditEvent(creds.id, userId, 'storage.objects.deleted', { bucket_id: id }, 'storage_bucket', id)
  return response
})

app.post('/storage/:ref/buckets/:id/objects/move', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  const response = await storageProxy(creds.site_url, creds.service_role_key, 'object/move', 'POST', body)
  await auditEvent(creds.id, userId, 'storage.object.moved', { body: safeJson(body) }, 'storage_object')
  return response
})

app.post('/storage/:ref/buckets/:id/objects/copy', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  const response = await storageProxy(creds.site_url, creds.service_role_key, 'object/copy', 'POST', body)
  await auditEvent(creds.id, userId, 'storage.object.copied', { bucket_id: id, body: safeJson(body) }, 'storage_object')
  return response
})

app.post('/storage/:ref/buckets/:id/objects/sign', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  // body contains { paths: [...], expiresIn: number }
  return storageProxy(creds.site_url, creds.service_role_key, `object/sign/${id}`, 'POST', body)
})

app.post('/storage/:ref/buckets/:id/objects/sign-multi', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  return storageProxy(creds.site_url, creds.service_role_key, `object/sign/${id}`, 'POST', body)
})

app.post('/storage/:ref/buckets/:id/objects/public-url', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  return storageProxy(creds.site_url, creds.service_role_key, `object/public-url/${id}`, 'POST', body)
})

// ─── S3 Credentials ───────────────────────────────────────────────────────────
app.get('/storage/:ref/credentials', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json([], 200)
  // Proxy to storage-api S3 access keys endpoint
  return storageProxy(creds.site_url, creds.service_role_key, 's3/accesskeys', 'GET')
})

app.post('/storage/:ref/credentials', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  return storageProxy(creds.site_url, creds.service_role_key, 's3/accesskeys', 'POST', body)
})

app.delete('/storage/:ref/credentials/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  return storageProxy(creds.site_url, creds.service_role_key, `s3/accesskeys/${id}`, 'DELETE')
})

app.get('/storage/:ref/buckets/:id/settings', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT bucket_id, quota_mb, max_file_size_bytes, allowed_mime_types, lifecycle, metrics, updated_at
     FROM storage_bucket_settings WHERE project_id=$1 AND bucket_id=$2`,
    [creds.id, id]
  )
  return c.json(rows[0] ?? {
    bucket_id: id,
    quota_mb: creds.quotas?.storage_mb ?? null,
    max_file_size_bytes: null,
    allowed_mime_types: null,
    lifecycle: {},
    metrics: {},
  })
})

app.patch('/storage/:ref/buckets/:id/settings', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO storage_bucket_settings
       (project_id, bucket_id, quota_mb, max_file_size_bytes, allowed_mime_types, lifecycle, updated_by)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, bucket_id) DO UPDATE SET
       quota_mb=COALESCE(EXCLUDED.quota_mb, storage_bucket_settings.quota_mb),
       max_file_size_bytes=COALESCE(EXCLUDED.max_file_size_bytes, storage_bucket_settings.max_file_size_bytes),
       allowed_mime_types=COALESCE(EXCLUDED.allowed_mime_types, storage_bucket_settings.allowed_mime_types),
       lifecycle=storage_bucket_settings.lifecycle || EXCLUDED.lifecycle,
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING bucket_id, quota_mb, max_file_size_bytes, allowed_mime_types, lifecycle, metrics, updated_at`,
    [
      creds.id,
      id,
      body.quota_mb ?? null,
      body.max_file_size_bytes ?? null,
      body.allowed_mime_types ?? null,
      JSON.stringify(body.lifecycle ?? {}),
      userId,
    ]
  )
  await auditEvent(creds.id, userId, 'storage.bucket.settings.updated', { bucket_id: id, keys: Object.keys(body) }, 'storage_bucket', id)
  return c.json(rows[0])
})

app.get('/storage/:ref/buckets/:id/lifecycle', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT lifecycle, updated_at FROM storage_bucket_settings WHERE project_id=$1 AND bucket_id=$2`,
    [creds.id, id]
  )
  return c.json(rows[0] ?? { lifecycle: {}, updated_at: null })
})

app.patch('/storage/:ref/buckets/:id/lifecycle', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO storage_bucket_settings(project_id, bucket_id, lifecycle, updated_by)
     VALUES($1, $2, $3, $4)
     ON CONFLICT (project_id, bucket_id) DO UPDATE SET
       lifecycle=EXCLUDED.lifecycle,
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING bucket_id, lifecycle, updated_at`,
    [creds.id, id, JSON.stringify(body), userId]
  )
  await auditEvent(creds.id, userId, 'storage.bucket.lifecycle.updated', { bucket_id: id }, 'storage_bucket', id)
  return c.json(rows[0])
})

app.get('/storage/:ref/buckets/:id/metrics', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const sql = `
    select jsonb_build_object(
      'bucket_id', ${sqlLiteral(id)},
      'object_count', count(*),
      'storage_bytes', coalesce(sum((metadata->>'size')::bigint), 0),
      'latest_upload_at', max(created_at)
    ) as metrics
    from storage.objects
    where bucket_id = ${sqlLiteral(id)}`
  const data = await fetchPgMetaQuery(creds.site_url, creds.service_role_key, sql)
  const metrics = data?.[0]?.metrics ?? { bucket_id: id, object_count: 0, storage_bytes: 0 }
  await pool.query(
    `INSERT INTO storage_bucket_settings(project_id, bucket_id, metrics)
     VALUES($1, $2, $3)
     ON CONFLICT (project_id, bucket_id) DO UPDATE SET metrics=EXCLUDED.metrics, updated_at=NOW()`,
    [creds.id, id, JSON.stringify(metrics)]
  )
  return c.json(metrics)
})

app.get('/storage/:ref/buckets/:id/policies', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const sql = `
    select jsonb_agg(jsonb_build_object(
      'policy_name', policyname,
      'command', cmd,
      'roles', roles,
      'using_expression', qual,
      'check_expression', with_check,
      'bucket_id', ${sqlLiteral(id)}
    ) order by policyname) as policies
    from pg_policies
    where schemaname='storage'
      and tablename='objects'
      and (qual ilike '%' || ${sqlLiteral(id)} || '%' or with_check ilike '%' || ${sqlLiteral(id)} || '%')`
  const data = await fetchPgMetaQuery(creds.site_url, creds.service_role_key, sql)
  return c.json(data?.[0]?.policies ?? [])
})

app.post('/storage/:ref/buckets/:id/policies', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const template = body.template ?? 'authenticated-read'
  const policyName = body.name ?? `${id}_${template}`.replace(/[^a-zA-Z0-9_]/g, '_')
  const templates: Record<string, string> = {
    'authenticated-read': `DROP POLICY IF EXISTS ${sqlIdent(policyName)} ON storage.objects; CREATE POLICY ${sqlIdent(policyName)} ON storage.objects FOR SELECT TO authenticated USING (bucket_id = ${sqlLiteral(id)});`,
    'authenticated-upload': `DROP POLICY IF EXISTS ${sqlIdent(policyName)} ON storage.objects; CREATE POLICY ${sqlIdent(policyName)} ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = ${sqlLiteral(id)});`,
    'user-folder-all': `DROP POLICY IF EXISTS ${sqlIdent(policyName)} ON storage.objects; CREATE POLICY ${sqlIdent(policyName)} ON storage.objects FOR ALL TO authenticated USING (bucket_id = ${sqlLiteral(id)} AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = ${sqlLiteral(id)} AND (storage.foldername(name))[1] = auth.uid()::text);`,
  }
  const sql = body.sql ?? templates[template]
  if (!sql) return c.json({ message: `Unsupported storage policy template: ${template}` }, 400)
  await fetchPgMetaQuery(creds.site_url, creds.service_role_key, sql)
  await auditEvent(creds.id, userId, 'storage.policy.created', { bucket_id: id, template, policy_name: policyName }, 'storage_bucket', id)
  return c.json({ bucket_id: id, policy_name: policyName, template, status: 'created' }, 201)
})

app.delete('/storage/:ref/buckets/:id/policies/:policy', async (c) => {
  const userId = c.get('userId')
  const { ref, id, policy } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  await fetchPgMetaQuery(
    creds.site_url,
    creds.service_role_key,
    `DROP POLICY IF EXISTS ${sqlIdent(policy)} ON storage.objects`
  )
  await auditEvent(creds.id, userId, 'storage.policy.deleted', { bucket_id: id, policy_name: policy }, 'storage_bucket', id)
  return c.json({ bucket_id: id, policy_name: policy, status: 'deleted' })
})

app.get('/storage/:ref/buckets/:id/transforms', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT bucket_id, name, options, enabled, updated_at
     FROM storage_transform_presets
     WHERE project_id=$1 AND bucket_id=$2
     ORDER BY name`,
    [creds.id, id]
  )
  return c.json(rows)
})

app.patch('/storage/:ref/buckets/:id/transforms/:name', async (c) => {
  const userId = c.get('userId')
  const { ref, id, name } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const { rows } = await pool.query(
    `INSERT INTO storage_transform_presets(project_id, bucket_id, name, options, enabled, updated_by)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT(project_id, bucket_id, name) DO UPDATE SET
       options=EXCLUDED.options,
       enabled=EXCLUDED.enabled,
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING bucket_id, name, options, enabled, updated_at`,
    [creds.id, id, name, JSON.stringify(body.options ?? {}), body.enabled ?? true, userId]
  )
  await auditEvent(creds.id, userId, 'storage.transform.updated', { bucket_id: id, name }, 'storage_bucket', id)
  return c.json(rows[0])
})

app.delete('/storage/:ref/buckets/:id/transforms/:name', async (c) => {
  const userId = c.get('userId')
  const { ref, id, name } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  await pool.query(
    'DELETE FROM storage_transform_presets WHERE project_id=$1 AND bucket_id=$2 AND name=$3',
    [creds.id, id, name]
  )
  await auditEvent(creds.id, userId, 'storage.transform.deleted', { bucket_id: id, name }, 'storage_bucket', id)
  return c.json({ bucket_id: id, name, status: 'deleted' })
})

app.post('/storage/:ref/buckets/:id/objects/transform-url', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json()
  const path = String(body.path ?? '').replace(/^\/+/, '')
  if (!path) return c.json({ message: 'path is required' }, 400)
  let options = body.options ?? {}
  if (body.preset) {
    const { rows } = await pool.query(
      `SELECT options FROM storage_transform_presets
       WHERE project_id=$1 AND bucket_id=$2 AND name=$3 AND enabled=true`,
      [creds.id, id, body.preset]
    )
    options = { ...(rows[0]?.options ?? {}), ...options }
  }
  const authMode = body.public ? 'public' : 'authenticated'
  const url = `${creds.site_url}/storage/v1/render/image/${authMode}/${encodeURIComponent(id)}/${path}${queryFromOptions(options)}`
  await auditEvent(creds.id, userId, 'storage.transform_url.generated', { bucket_id: id, path, preset: body.preset ?? null }, 'storage_object')
  return c.json({ bucket_id: id, path, public: Boolean(body.public), url, options })
})

app.get('/storage/:ref/buckets/:id/lifecycle-runs', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const { rows } = await pool.query(
    `SELECT id, bucket_id, status, dry_run, rule, summary, error, created_at
     FROM storage_lifecycle_runs
     WHERE project_id=$1 AND bucket_id=$2
     ORDER BY created_at DESC LIMIT 50`,
    [creds.id, id]
  )
  return c.json(rows)
})

app.post('/storage/:ref/buckets/:id/lifecycle/run', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const dryRun = body.dry_run !== false
  const olderThanDays = Number(body.older_than_days ?? body.delete_after_days ?? 30)
  const prefix = String(body.prefix ?? '')
  const limit = Math.min(Number(body.limit ?? 100), 1000)
  const sql = `
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', name,
      'size', (metadata->>'size')::bigint,
      'created_at', created_at,
      'updated_at', updated_at
    ) order by updated_at asc), '[]'::jsonb) as objects
    from (
      select name, metadata, created_at, updated_at
      from storage.objects
      where bucket_id = ${sqlLiteral(id)}
        and updated_at < now() - (${sqlLiteral(String(olderThanDays))} || ' days')::interval
        and (${sqlLiteral(prefix)} = '' or name like ${sqlLiteral(`${prefix}%`)})
      order by updated_at asc
      limit ${limit}
    ) candidates`
  const data = await fetchPgMetaQuery(creds.site_url, creds.service_role_key, sql)
  const objects = data?.[0]?.objects ?? []
  let deleted = 0
  if (!dryRun && objects.length > 0) {
    const prefixes = objects.map((obj: any) => obj.name)
    const response = await storageProxy(
      creds.site_url,
      creds.service_role_key,
      `object/${id}`,
      'DELETE',
      JSON.stringify({ prefixes })
    )
    deleted = response.status >= 200 && response.status < 300 ? prefixes.length : 0
  }
  const summary = {
    candidates: objects.length,
    deleted,
    older_than_days: olderThanDays,
    prefix,
    limit,
  }
  const { rows } = await pool.query(
    `INSERT INTO storage_lifecycle_runs(project_id, bucket_id, status, dry_run, rule, summary, created_by)
     VALUES($1, $2, 'completed', $3, $4, $5, $6)
     RETURNING id, bucket_id, status, dry_run, rule, summary, created_at`,
    [creds.id, id, dryRun, JSON.stringify(body), JSON.stringify(summary), userId]
  )
  await auditEvent(creds.id, userId, 'storage.lifecycle.run', summary, 'storage_bucket', id)
  return c.json({ ...rows[0], objects: dryRun ? objects : undefined })
})

// ─── Archive (export) ─────────────────────────────────────────────────────────
app.post('/storage/:ref/archive', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  await auditEvent(creds.id, userId, 'storage.archive.requested', {}, 'storage')
  return c.json({ message: 'Storage archive export queued for external object-store tooling.' }, 202)
})

// ─── Vector / Analytics buckets — stub (advanced features) ────────────────────
app.get('/storage/:ref/vector-buckets', (c) => c.json([]))
app.post('/storage/:ref/vector-buckets', (c) => c.json({ message: 'Vector storage not supported' }, 501))
app.get('/storage/:ref/vector-buckets/:id', (c) => c.json({ message: 'Not found' }, 404))
app.delete('/storage/:ref/vector-buckets/:id', (c) => c.json({ message: 'Not found' }, 404))
app.get('/storage/:ref/vector-buckets/:id/indexes', (c) => c.json([]))
app.post('/storage/:ref/vector-buckets/:id/indexes', (c) => c.json({ message: 'Not supported' }, 501))
app.get('/storage/:ref/analytics-buckets', (c) => c.json([]))
app.post('/storage/:ref/analytics-buckets', (c) => c.json({ message: 'Analytics storage not supported' }, 501))
app.get('/storage/:ref/analytics-buckets/:id/namespaces', (c) => c.json([]))
app.post('/storage/:ref/analytics-buckets/:id/namespaces', (c) => c.json({ message: 'Not supported' }, 501))
app.get('/storage/:ref/analytics-buckets/:id/namespaces/:ns/tables', (c) => c.json([]))

// ─── Catch-all: 404 for unimplemented endpoints ───────────────────────────────
app.all('*', (c) => c.json({ message: 'Not implemented' }, 404))

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRef(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function projectToStudioShape(p: any) {
  const siteUrl = p.site_url ?? `https://${p.ref}-db.hconsulting.app`
  const isActive = p.status === 'active'
  return {
    id: p.id,
    ref: p.ref,
    name: p.name,
    organization_id: p.org_id,
    cloud_provider: 'SELF_HOSTED',
    region: 'us-east-1',
    status: isActive ? 'ACTIVE_HEALTHY' : p.status === 'provisioning' ? 'COMING_UP' : p.status?.toUpperCase() ?? 'INACTIVE',
    inserted_at: p.created_at,
    updated_at: p.updated_at ?? p.created_at,
    disk_volume_size_gb: 8,
    restUrl: isActive ? `${siteUrl}/rest/v1` : null,
    endpoint: siteUrl,
    // connectionString signals to Studio that pg-meta is ready — must be truthy when active
    connectionString: isActive
      ? `postgresql://postgres:${p.db_password ?? 'placeholder'}@db.${p.ref}.db.hconsulting.app:5432/postgres`
      : null,
    db_host: `db.${p.ref}.db.hconsulting.app`,
    dbVersion: '150001',
    high_availability: false,
    integration_source: null,
    is_branch_enabled: true,
    is_physical_backups_enabled: true,
  }
}

export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const PATCH = handle(app)
export const DELETE = handle(app)
