import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import pool from '@/db/client'
import { generateRef, provisionProject, teardownProject } from '@/lib/provision'

export const runtime = 'nodejs'

const app = new Hono().basePath('/api/v1')

// ─── Auth middleware ─────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const session = await auth()
  if (!session?.user?.id) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('userId', session.user.id)
  await next()
})

// ─── GET /projects ───────────────────────────────────────────────────────────
app.get('/projects', async (c) => {
  const userId = c.get('userId')
  const { rows } = await pool.query(
    `SELECT p.* FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE om.user_id = $1 AND p.status != 'deleted'
     ORDER BY p.created_at DESC`,
    [userId]
  )
  return c.json({ projects: rows })
})

// ─── POST /projects ──────────────────────────────────────────────────────────
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  org_id: z.string().uuid(),
})

app.post('/projects', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json()
  const parsed = createProjectSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const { name, org_id } = parsed.data

  // Verify user is member of org
  const { rows: membership } = await pool.query(
    'SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2',
    [org_id, userId]
  )
  if (!membership.length) return c.json({ error: 'Forbidden' }, 403)

  // Check free tier project limit (max 2)
  const { rows: org } = await pool.query('SELECT plan FROM organizations WHERE id=$1', [org_id])
  if (org[0]?.plan === 'free') {
    const { rows: count } = await pool.query(
      "SELECT COUNT(*) FROM projects WHERE org_id=$1 AND status != 'deleted'",
      [org_id]
    )
    if (parseInt(count[0].count) >= 2) {
      return c.json({ error: 'Free plan limited to 2 projects. Upgrade to Pro.' }, 402)
    }
  }

  const ref = generateRef()

  // Insert project as 'provisioning'
  const { rows } = await pool.query(
    `INSERT INTO projects(ref, name, org_id, status)
     VALUES($1, $2, $3, 'provisioning') RETURNING *`,
    [ref, name, org_id]
  )
  const project = rows[0]

  // Provision asynchronously — don't block HTTP response
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

  return c.json({ project }, 201)
})

// ─── GET /projects/:ref ──────────────────────────────────────────────────────
app.get('/projects/:ref', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.* FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status != 'deleted'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ error: 'Not found' }, 404)
  // Never expose secrets in GET response
  const { db_password, jwt_secret, ...safe } = rows[0]
  return c.json({ project: safe })
})

// ─── GET /projects/:ref/keys ─────────────────────────────────────────────────
app.get('/projects/:ref/keys', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const { rows } = await pool.query(
    `SELECT p.anon_key, p.service_role_key, p.site_url FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ anon_key: rows[0].anon_key, service_role_key: rows[0].service_role_key, url: rows[0].site_url })
})

// ─── DELETE /projects/:ref ───────────────────────────────────────────────────
app.delete('/projects/:ref', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()

  const { rows } = await pool.query(
    `SELECT p.id, om.role FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2`,
    [ref, userId]
  )
  if (!rows.length) return c.json({ error: 'Not found' }, 404)
  if (!['owner', 'admin'].includes(rows[0].role)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  await pool.query("UPDATE projects SET status='deleted' WHERE ref=$1", [ref])
  teardownProject(ref).catch((err) => console.error(`[teardown] ${ref}:`, err.message))

  return c.json({ success: true })
})

// ─── GET /orgs ───────────────────────────────────────────────────────────────
app.get('/orgs', async (c) => {
  const userId = c.get('userId')
  const { rows } = await pool.query(
    `SELECT o.*, om.role FROM organizations o
     JOIN org_members om ON om.org_id = o.id
     WHERE om.user_id=$1 ORDER BY o.created_at DESC`,
    [userId]
  )
  return c.json({ orgs: rows })
})

// ─── POST /orgs ──────────────────────────────────────────────────────────────
const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
})

app.post('/orgs', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json()
  const parsed = createOrgSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'INSERT INTO organizations(name, slug) VALUES($1, $2) RETURNING *',
      [parsed.data.name, parsed.data.slug]
    )
    await client.query(
      "INSERT INTO org_members(org_id, user_id, role) VALUES($1, $2, 'owner')",
      [rows[0].id, userId]
    )
    await client.query('COMMIT')
    return c.json({ org: rows[0] }, 201)
  } catch (err: any) {
    await client.query('ROLLBACK')
    if (err.code === '23505') return c.json({ error: 'Slug already taken' }, 409)
    throw err
  } finally {
    client.release()
  }
})

export const GET = handle(app)
export const POST = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
