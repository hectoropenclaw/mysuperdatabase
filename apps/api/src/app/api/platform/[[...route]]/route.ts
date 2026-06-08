import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { auth } from '@/lib/auth'
import pool from '@/db/client'

export const runtime = 'nodejs'

const app = new Hono().basePath('/api/platform')

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
         service_role_key=$3, db_password=$4, jwt_secret=$5 WHERE ref=$6`,
        [keys.siteUrl, keys.anonKey, keys.serviceKey, keys.dbPassword, keys.jwtSecret, ref]
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
    db: { host: `db.${p.ref}.mysuperdatabase.co`, version: '15', port: 5432 },
  })
})

// ─── GET /platform/feature-flags ─────────────────────────────────────────────
app.get('/feature-flags', (c) => {
  return c.json({})
})

// ─── Catch-all: 404 for unimplemented endpoints ───────────────────────────────
app.all('*', (c) => c.json({ message: 'Not implemented' }, 404))

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRef(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function projectToStudioShape(p: any) {
  return {
    id: p.id,
    ref: p.ref,
    name: p.name,
    organization_id: p.org_id,
    cloud_provider: 'SELF_HOSTED',
    region: 'us-east-1',
    status: p.status === 'active' ? 'ACTIVE_HEALTHY' : p.status === 'provisioning' ? 'COMING_UP' : p.status?.toUpperCase() ?? 'INACTIVE',
    inserted_at: p.created_at,
    updated_at: p.updated_at,
    disk_volume_size_gb: 8,
    restUrl: p.site_url ? `${p.site_url}/rest/v1` : null,
    endpoint: p.site_url ? p.site_url : `https://${p.ref}.mysuperdatabase.co`,
  }
}

export const GET = handle(app)
export const POST = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
export const PUT = handle(app)
