import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import crypto from 'crypto'
import { auth } from '@/lib/auth'
import pool from '@/db/client'

const execAsync = promisify(exec)
const SCRIPTS_DIR = path.resolve(process.cwd(), '../../infra/scripts')

export const runtime = 'nodejs'

type Env = { Variables: { userId: string; userEmail: string } }

const app = new Hono<Env>().basePath('/api/platform')
const REF_RE = /^[a-z0-9]{6,32}$/

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
// GoTrue admin is exposed via Kong at https://{ref}.db.hconsulting.app/auth/v1/admin/*
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: get project's service_role_key and endpoint for GoTrue admin proxying
async function getProjectAuthCreds(ref: string, userId: string) {
  const { rows } = await pool.query(
    `SELECT p.service_role_key, p.site_url, p.auth_config, p.status
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
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')
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
  return c.json(data, status as any)
})

// ─── DELETE /platform/auth/{ref}/templates/{template}/reset ───────────────────
app.delete('/auth/:ref/templates/:template/reset', async (c) => {
  return c.json({ message: 'Template reset to default.' })
})

// ─── GET /platform/auth/{ref}/validate/spam ───────────────────────────────────
app.get('/auth/:ref/validate/spam', (c) => c.json({ is_spam: false }))

// ═══════════════════════════════════════════════════════════════════════════════
// PG-META PROXY — forward /platform/pg-meta/{ref}/* to project's Kong /pg/* route
// Studio passes x-connection-encrypted; we ignore it and auth via service_role_key
// ═══════════════════════════════════════════════════════════════════════════════

async function getProjectKongCreds(ref: string, userId: string) {
  if (!REF_RE.test(ref)) return null
  const { rows } = await pool.query(
    `SELECT p.id, p.ref, p.name, p.org_id, p.db_password, p.service_role_key, p.site_url, p.status
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
    `SELECT id, status, backup_key, size_bytes, restore_of_backup_id, error, created_at, completed_at
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
      const match = stdout.match(new RegExp('backed up .*? [^/]+/(.+?\\\\.sql\\\\.gz)'))
      await pool.query(
        `UPDATE project_backups
         SET status='completed', backup_key=$1, completed_at=NOW()
         WHERE id=$2`,
        [match?.[1] ?? null, backupId]
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
        await execAsync(
          `docker exec -e PGPASSWORD="${project.db_password}" "spn-${ref}-db-1" pg_dump -U postgres -h 127.0.0.1 postgres ` +
          `| docker exec -i "spn-${branchRef}-db-1" psql -U postgres -h 127.0.0.1 postgres`
        )
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
  const { rows } = await pool.query(
    `SELECT p.service_role_key, p.site_url, p.storage_s3_access_key, p.storage_s3_secret_key, p.status
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
  return storageProxy(creds.site_url, creds.service_role_key, 'bucket', 'POST', body)
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
  return storageProxy(creds.site_url, creds.service_role_key, `bucket/${id}`, 'PUT', body)
})

app.delete('/storage/:ref/buckets/:id', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  return storageProxy(creds.site_url, creds.service_role_key, `bucket/${id}`, 'DELETE')
})

app.post('/storage/:ref/buckets/:id/empty', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  return storageProxy(creds.site_url, creds.service_role_key, `bucket/${id}/empty`, 'POST', '{}')
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

app.delete('/storage/:ref/buckets/:id/objects', async (c) => {
  const userId = c.get('userId')
  const { ref, id } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  return storageProxy(creds.site_url, creds.service_role_key, `object/${id}`, 'DELETE', body)
})

app.post('/storage/:ref/buckets/:id/objects/move', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const creds = await getProjectStorageCreds(ref, userId)
  if (!creds) return c.json({ message: 'Not found' }, 404)
  const body = await bodyText(c)
  return storageProxy(creds.site_url, creds.service_role_key, 'object/move', 'POST', body)
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

// ─── Archive (export) ─────────────────────────────────────────────────────────
app.post('/storage/:ref/archive', async (c) => {
  return c.json({ message: 'Storage archive export not yet supported.' }, 501)
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
  const siteUrl = p.site_url ?? `https://${p.ref}.db.hconsulting.app`
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
