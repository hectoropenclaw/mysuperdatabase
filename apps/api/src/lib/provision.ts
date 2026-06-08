import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)

const INFRA_SCRIPTS = path.join(process.cwd(), '../../infra/scripts')

export function generateRef(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

export interface ProvisionResult {
  ref: string
  siteUrl: string
  anonKey: string
  serviceKey: string
  dbPassword: string
  jwtSecret: string
  s3AccessKey: string
  s3SecretKey: string
}

export async function provisionProject(ref: string): Promise<ProvisionResult> {
  const { stdout, stderr } = await execFileAsync(
    path.join(INFRA_SCRIPTS, 'provision.sh'),
    [ref],
    {
      env: {
        ...process.env,
        PATH: process.env.PATH,
      },
      timeout: 5 * 60 * 1000, // 5 min max
    }
  )

  if (stderr) console.warn('[provision]', stderr)

  // Read generated keys.json
  const keysPath = path.join(process.cwd(), '../../infra/projects', ref, 'keys.json')
  const keys = JSON.parse(await fs.readFile(keysPath, 'utf8'))

  return {
    ref: keys.project_ref,
    siteUrl: keys.site_url,
    anonKey: keys.anon_key,
    serviceKey: keys.service_key,
    dbPassword: keys.db_password,
    jwtSecret: keys.jwt_secret,
    s3AccessKey: keys.s3_access_key ?? '',
    s3SecretKey: keys.s3_secret_key ?? '',
  }
}

export async function teardownProject(ref: string, deleteData = false): Promise<void> {
  const args = deleteData ? [ref, '--delete-data'] : [ref]
  await execFileAsync(path.join(INFRA_SCRIPTS, 'teardown.sh'), args, {
    env: { ...process.env, PATH: process.env.PATH },
    timeout: 2 * 60 * 1000,
  })
}
