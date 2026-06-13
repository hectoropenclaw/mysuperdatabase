import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import pool from '@/db/client'
import { generateRef, provisionProject, teardownProject } from '@/lib/provision'

export const runtime = 'nodejs'

type Env = { Variables: { userId: string } }

const app = new Hono<Env>().basePath('/api/v1')

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

// ─── Helper: resolve project by ref + auth ───────────────────────────────────
async function resolveProject(ref: string, userId: string) {
  const { rows } = await pool.query(
    `SELECT p.* FROM projects p
     JOIN org_members om ON om.org_id = p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status='active'`,
    [ref, userId]
  )
  return rows[0] ?? null
}

// ─── Edge Functions: list ─────────────────────────────────────────────────────
app.get('/projects/:ref/functions', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const { rows } = await pool.query(
    `SELECT id, slug, name, status, verify_jwt, entrypoint_path, import_map_path, created_at, updated_at
     FROM edge_functions WHERE project_id=$1 ORDER BY created_at DESC`,
    [project.id]
  )
  return c.json(rows)
})

// ─── Edge Functions: deploy (multipart form upload) ──────────────────────────
app.post('/projects/:ref/functions', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const formData = await c.req.formData()
  const slug = formData.get('slug') as string | null
  const name = (formData.get('name') as string | null) ?? slug
  const verifyJwt = formData.get('verify_jwt') !== 'false'
  const entrypointPath = (formData.get('entrypoint_path') as string | null) ?? 'index.ts'
  const importMapPath = formData.get('import_map_path') as string | null

  if (!slug) return c.json({ error: 'slug is required' }, 400)

  // Build file list from form: files field is JSON metadata, actual blobs follow
  const filesJson = formData.get('files') as string | null
  let files: { name: string; content: string }[] = []

  if (filesJson) {
    const fileMeta: { name: string }[] = JSON.parse(filesJson)
    files = await Promise.all(
      fileMeta.map(async (f) => {
        const blob = formData.get(f.name) as File | null
        return { name: f.name, content: blob ? await blob.text() : '' }
      })
    )
  }

  // Upsert function record
  const { rows } = await pool.query(
    `INSERT INTO edge_functions(project_id, slug, name, status, verify_jwt, entrypoint_path, import_map_path)
     VALUES($1, $2, $3, 'ACTIVE', $4, $5, $6)
     ON CONFLICT (project_id, slug) DO UPDATE
       SET name=$3, verify_jwt=$4, entrypoint_path=$5, import_map_path=$6, updated_at=NOW()
     RETURNING *`,
    [project.id, slug, name, verifyJwt, entrypointPath, importMapPath]
  )

  // Deploy files to container via deploy-function.sh
  if (files.length > 0) {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
    const payload = JSON.stringify({ files })
    const scriptPath = process.env.INFRA_SCRIPTS_PATH ?? '/root/supanow/infra/scripts'
    await execAsync(
      `echo '${payload.replace(/'/g, "'\\''")}' | bash ${scriptPath}/deploy-function.sh ${ref} ${slug}`
    )
  }

  return c.json(rows[0], 201)
})

// ─── Edge Functions: get one ──────────────────────────────────────────────────
app.get('/projects/:ref/functions/:slug', async (c) => {
  const userId = c.get('userId')
  const { ref, slug } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const { rows } = await pool.query(
    `SELECT * FROM edge_functions WHERE project_id=$1 AND slug=$2`,
    [project.id, slug]
  )
  if (!rows.length) return c.json({ error: 'Function not found' }, 404)
  return c.json(rows[0])
})

// ─── Edge Functions: get body (source code) ───────────────────────────────────
app.get('/projects/:ref/functions/:slug/body', async (c) => {
  const userId = c.get('userId')
  const { ref, slug } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const { rows } = await pool.query(
    `SELECT entrypoint_path FROM edge_functions WHERE project_id=$1 AND slug=$2`,
    [project.id, slug]
  )
  if (!rows.length) return c.json({ error: 'Function not found' }, 404)

  // Read source from container
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)
  const container = `spn-${ref}-edge-runtime-1`
  const entrypoint = rows[0].entrypoint_path ?? 'index.ts'
  try {
    const { stdout } = await execAsync(
      `docker exec ${container} cat /home/deno/functions/${slug}/${entrypoint}`
    )
    return new Response(stdout, { headers: { 'Content-Type': 'application/octet-stream' } })
  } catch {
    return c.json({ error: 'Could not read function body' }, 500)
  }
})

// ─── Edge Functions: update metadata ─────────────────────────────────────────
app.patch('/projects/:ref/functions/:slug', async (c) => {
  const userId = c.get('userId')
  const { ref, slug } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json()
  const { name, verify_jwt, status } = body

  const { rows } = await pool.query(
    `UPDATE edge_functions
     SET name=COALESCE($3,name), verify_jwt=COALESCE($4,verify_jwt), status=COALESCE($5,status), updated_at=NOW()
     WHERE project_id=$1 AND slug=$2 RETURNING *`,
    [project.id, slug, name ?? null, verify_jwt ?? null, status ?? null]
  )
  if (!rows.length) return c.json({ error: 'Function not found' }, 404)
  return c.json(rows[0])
})

// ─── Edge Functions: delete ───────────────────────────────────────────────────
app.delete('/projects/:ref/functions/:slug', async (c) => {
  const userId = c.get('userId')
  const { ref, slug } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  await pool.query(`DELETE FROM edge_functions WHERE project_id=$1 AND slug=$2`, [project.id, slug])

  // Remove files from container
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)
  const container = `spn-${ref}-edge-runtime-1`
  await execAsync(`docker exec ${container} rm -rf /home/deno/functions/${slug}`).catch(() => {})

  return c.json({ success: true })
})

// ─── Secrets: list ────────────────────────────────────────────────────────────
app.get('/projects/:ref/secrets', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const { rows } = await pool.query(
    `SELECT id, name, created_at, updated_at FROM secrets WHERE project_id=$1 ORDER BY name`,
    [project.id]
  )
  return c.json(rows)
})

// ─── Secrets: bulk upsert ─────────────────────────────────────────────────────
app.post('/projects/:ref/secrets', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const secrets: { name: string; value: string }[] = await c.req.json()
  if (!Array.isArray(secrets) || !secrets.every((s) => s.name && s.value !== undefined)) {
    return c.json({ error: 'Expected array of {name, value}' }, 400)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const { name, value } of secrets) {
      await client.query(
        `INSERT INTO secrets(project_id, name, value) VALUES($1,$2,$3)
         ON CONFLICT (project_id, name) DO UPDATE SET value=$3, updated_at=NOW()`,
        [project.id, name, value]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  // Regenerate secrets.env and restart edge-runtime
  const allSecrets = await pool.query(
    `SELECT name, value FROM secrets WHERE project_id=$1`,
    [project.id]
  )
  const envContent = allSecrets.rows.map((r: any) => `${r.name}=${r.value}`).join('\n')
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)
  const scriptPath = process.env.INFRA_SCRIPTS_PATH ?? '/root/supanow/infra/scripts'
  await execAsync(
    `printf '%s' '${envContent.replace(/'/g, "'\\''")}' | bash ${scriptPath}/sync-secrets.sh ${ref}`
  )

  return c.json({ success: true })
})

// ─── Secrets: delete by name ──────────────────────────────────────────────────
app.delete('/projects/:ref/secrets', async (c) => {
  const userId = c.get('userId')
  const { ref } = c.req.param()
  const project = await resolveProject(ref, userId)
  if (!project) return c.json({ error: 'Not found' }, 404)

  const body: { name: string }[] = await c.req.json()
  const names = body.map((s) => s.name)
  await pool.query(
    `DELETE FROM secrets WHERE project_id=$1 AND name = ANY($2::text[])`,
    [project.id, names]
  )

  // Regenerate secrets.env and restart edge-runtime
  const allSecrets = await pool.query(
    `SELECT name, value FROM secrets WHERE project_id=$1`,
    [project.id]
  )
  const envContent = allSecrets.rows.map((r: any) => `${r.name}=${r.value}`).join('\n')
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)
  const scriptPath = process.env.INFRA_SCRIPTS_PATH ?? '/root/supanow/infra/scripts'
  await execAsync(
    `printf '%s' '${envContent.replace(/'/g, "'\\''")}' | bash ${scriptPath}/sync-secrets.sh ${ref}`
  )

  return c.json({ success: true })
})

export const GET = handle(app)
export const POST = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
