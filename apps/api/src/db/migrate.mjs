// Run all pending SQL migrations in order
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function migrate() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id        serial PRIMARY KEY,
        filename  text NOT NULL UNIQUE,
        ran_at    timestamptz NOT NULL DEFAULT now()
      )
    `)

    const done = await client.query('SELECT filename FROM _migrations ORDER BY id')
    const ran = new Set(done.rows.map((r) => r.filename))

    const dir = path.join(__dirname, 'migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

    for (const file of files) {
      if (ran.has(file)) { console.log(`  skip  ${file}`); continue }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      console.log(`  run   ${file}`)
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO _migrations(filename) VALUES($1)', [file])
      await client.query('COMMIT')
    }
    console.log('Migrations complete.')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate()
