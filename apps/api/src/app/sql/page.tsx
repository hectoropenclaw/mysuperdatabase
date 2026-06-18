import Link from 'next/link'
import { auth } from '@/lib/auth'
import pool from '@/db/client'
import SqlEditorClient from './sql-editor-client'

type Project = {
  id: string
  ref: string
  name: string
  status: string
  site_url: string | null
}

async function getProjects(userId: string): Promise<Project[]> {
  const { rows } = await pool.query(
    `SELECT p.id, p.ref, p.name, p.status, p.site_url
     FROM projects p
     JOIN org_members om ON om.org_id=p.org_id
     WHERE om.user_id=$1 AND p.status='active'
     ORDER BY p.created_at DESC`,
    [userId]
  )
  return rows
}

export default async function SqlEditorPage({
  searchParams,
}: {
  searchParams?: Promise<{ project?: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) {
    return (
      <main style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        color: '#e5eef7',
        background: 'linear-gradient(135deg, #07120f, #0f172a)',
        fontFamily: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
      }}>
        <section style={{
          maxWidth: 620,
          padding: 28,
          borderRadius: 28,
          background: 'rgba(255,255,255,0.07)',
          border: '1px solid rgba(229,238,247,0.14)',
        }}>
          <p style={{ color: '#7dd3fc', letterSpacing: '0.16em', textTransform: 'uppercase', fontSize: 12 }}>SQL Editor</p>
          <h1 style={{ fontSize: 52, lineHeight: 0.95, letterSpacing: '-0.06em', margin: '8px 0' }}>Sign in to run queries.</h1>
          <p style={{ color: '#9fb3c8', lineHeight: 1.5 }}>SupaNow SQL Editor needs your account to scope project access and audit query history.</p>
          <Link href="/api/auth/signin" style={{
            display: 'inline-block',
            marginTop: 14,
            color: '#07120f',
            background: '#86efac',
            borderRadius: 999,
            padding: '11px 16px',
            textDecoration: 'none',
            fontWeight: 900,
          }}>Sign in</Link>
        </section>
      </main>
    )
  }

  const projects = await getProjects(session.user.id)
  const params = await searchParams
  return <SqlEditorClient projects={projects} initialProjectRef={params?.project} />
}
