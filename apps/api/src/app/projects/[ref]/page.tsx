import Link from 'next/link'
import { notFound } from 'next/navigation'
import { auth } from '@/lib/auth'
import pool from '@/db/client'
import ProjectStudioClient from './project-studio-client'

type Project = {
  id: string
  ref: string
  name: string
  status: string
  site_url: string | null
}

async function getProject(ref: string, userId: string): Promise<Project | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.ref, p.name, p.status, p.site_url
     FROM projects p
     JOIN org_members om ON om.org_id=p.org_id
     WHERE p.ref=$1 AND om.user_id=$2 AND p.status != 'deleted'
     LIMIT 1`,
    [ref, userId]
  )
  return rows[0] ?? null
}

export default async function ProjectStudioPage({
  params,
}: {
  params: Promise<{ ref: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) {
    return (
      <main style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        color: '#e5e7eb',
        background: '#050505',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
      }}>
        <section style={{ maxWidth: 560, padding: 28, borderRadius: 18, background: '#09090b', border: '1px solid #27272a' }}>
          <p style={{ color: '#3ecf8e', letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 11, fontWeight: 800 }}>SupaNow Studio</p>
          <h1 style={{ margin: '8px 0', fontSize: 42, letterSpacing: '-0.05em' }}>Sign in to manage this project.</h1>
          <Link href="/api/auth/signin" style={{ display: 'inline-block', marginTop: 12, color: '#052e16', background: '#3ecf8e', borderRadius: 8, padding: '11px 14px', textDecoration: 'none', fontWeight: 900 }}>Sign in</Link>
        </section>
      </main>
    )
  }

  const { ref } = await params
  const project = await getProject(ref, session.user.id)
  if (!project) notFound()

  return <ProjectStudioClient project={project} />
}
