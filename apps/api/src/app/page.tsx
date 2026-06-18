import Link from 'next/link'
import type React from 'react'
import { auth } from '@/lib/auth'
import pool from '@/db/client'

type ProjectCard = {
  id: string
  ref: string
  name: string
  status: string
  site_url: string | null
  unhealthy_services: number
  last_backup_status: string | null
  last_backup_at: string | null
  last_pitr_status: string | null
  last_restore_drill_status: string | null
  critical_alerts: number
}

async function getProjects(userId: string): Promise<ProjectCard[]> {
  try {
    const { rows } = await pool.query(
      `WITH latest_backup AS (
         SELECT DISTINCT ON (project_id) project_id, status, completed_at
         FROM project_backups
         ORDER BY project_id, created_at DESC
       ),
       latest_pitr AS (
         SELECT DISTINCT ON (project_id) project_id, status
         FROM project_pitr_status
         ORDER BY project_id, checked_at DESC
       ),
       latest_drill AS (
         SELECT DISTINCT ON (project_id) project_id, status
         FROM project_restore_drills
         ORDER BY project_id, checked_at DESC
       ),
       service_health AS (
         SELECT project_id, count(*) FILTER (WHERE status != 'healthy')::int AS unhealthy_services
         FROM project_service_health
         GROUP BY project_id
       ),
       alerts AS (
         SELECT project_id, count(*)::int AS critical_alerts
         FROM project_alert_events
         WHERE severity='critical'
           AND created_at > now() - interval '7 days'
         GROUP BY project_id
       )
       SELECT p.id, p.ref, p.name, p.status, p.site_url,
              coalesce(sh.unhealthy_services, 0) AS unhealthy_services,
              lb.status AS last_backup_status,
              lb.completed_at AS last_backup_at,
              lp.status AS last_pitr_status,
              ld.status AS last_restore_drill_status,
              coalesce(a.critical_alerts, 0) AS critical_alerts
       FROM projects p
       JOIN org_members om ON om.org_id=p.org_id
       LEFT JOIN latest_backup lb ON lb.project_id=p.id
       LEFT JOIN latest_pitr lp ON lp.project_id=p.id
       LEFT JOIN latest_drill ld ON ld.project_id=p.id
       LEFT JOIN service_health sh ON sh.project_id=p.id
       LEFT JOIN alerts a ON a.project_id=p.id
       WHERE om.user_id=$1 AND p.status != 'deleted'
       ORDER BY p.created_at DESC
       LIMIT 24`,
      [userId]
    )
    return rows
  } catch {
    return []
  }
}

function badgeTone(value: string | null | undefined) {
  if (!value) return '#6b7280'
  if (['active', 'healthy', 'completed', 'verified', 'enabled', 'ready'].includes(value)) return '#047857'
  if (['running', 'creating', 'provisioning', 'queued'].includes(value)) return '#b45309'
  return '#b91c1c'
}

export default async function Home() {
  const session = await auth()
  if (!session?.user?.id) {
    return (
      <main style={styles.shell}>
        <section style={styles.hero}>
          <p style={styles.kicker}>SupaNow Studio</p>
          <h1 style={styles.title}>Tu control plane estilo Supabase, listo para operar.</h1>
          <p style={styles.copy}>Inicia sesión para ver proyectos, salud de servicios, backups, PITR, restore drills y alertas.</p>
          <Link href="/api/auth/signin" style={styles.button}>Entrar</Link>
        </section>
      </main>
    )
  }

  const projects = await getProjects(session.user.id)
  const active = projects.filter((project) => project.status === 'active').length
  const alerts = projects.reduce((sum, project) => sum + Number(project.critical_alerts ?? 0), 0)
  const unhealthy = projects.reduce((sum, project) => sum + Number(project.unhealthy_services ?? 0), 0)

  return (
    <main style={styles.shell}>
      <section style={styles.hero}>
        <p style={styles.kicker}>SupaNow Studio</p>
        <h1 style={styles.title}>Operaciones por proyecto, sin adivinar.</h1>
        <p style={styles.copy}>Backups, PITR, restore drills, health checks y alertas quedan en una sola vista para cerrar incidentes con evidencia.</p>
        <Link href="/sql" style={styles.button}>Open SQL Editor</Link>
      </section>

      <section style={styles.metrics}>
        <Metric label="Projects" value={projects.length} />
        <Metric label="Active" value={active} />
        <Metric label="Unhealthy services" value={unhealthy} />
        <Metric label="Critical alerts" value={alerts} />
      </section>

      <section style={styles.grid}>
        {projects.map((project) => (
          <article key={project.id} style={styles.card}>
            <div style={styles.cardHeader}>
              <div>
                <h2 style={styles.cardTitle}>{project.name}</h2>
                <p style={styles.ref}>{project.ref}</p>
              </div>
              <span style={{ ...styles.badge, background: badgeTone(project.status) }}>{project.status}</span>
            </div>
            <div style={styles.rows}>
              <StatusRow label="Services" value={project.unhealthy_services ? `${project.unhealthy_services} unhealthy` : 'healthy'} />
              <StatusRow label="Backup" value={project.last_backup_status ?? 'not collected'} />
              <StatusRow label="PITR" value={project.last_pitr_status ?? 'unknown'} />
              <StatusRow label="Restore drill" value={project.last_restore_drill_status ?? 'not run'} />
              <StatusRow label="Critical alerts" value={String(project.critical_alerts ?? 0)} />
            </div>
            <div style={styles.actions}>
              <a href={`/projects/${project.ref}`} style={styles.link}>Studio</a>
              <a href={`/api/platform/projects/${project.ref}`} style={styles.link}>API</a>
              <a href={`/sql?project=${project.ref}`} style={styles.link}>SQL</a>
              <a href={`/api/platform/projects/${project.ref}/logs`} style={styles.link}>Logs</a>
              <a href={`/api/platform/projects/${project.ref}/backups`} style={styles.link}>Backups</a>
              {project.site_url ? <a href={project.site_url} style={styles.link}>Open</a> : null}
            </div>
          </article>
        ))}
        {!projects.length ? <p style={styles.empty}>No hay proyectos visibles todavía o la migración operacional no está aplicada.</p> : null}
      </section>
    </main>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricValue}>{value}</span>
      <span style={styles.metricLabel}>{label}</span>
    </div>
  )
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.statusRow}>
      <span>{label}</span>
      <strong style={{ color: badgeTone(value) }}>{value}</strong>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: '100vh',
    padding: 32,
    color: '#172033',
    background: 'radial-gradient(circle at top left, #d8f3ff 0, transparent 32%), linear-gradient(135deg, #f7f3ea 0%, #eef7f0 52%, #edf2ff 100%)',
    fontFamily: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  },
  hero: {
    maxWidth: 920,
    margin: '0 auto 28px',
    padding: 28,
    border: '1px solid rgba(23, 32, 51, 0.12)',
    borderRadius: 28,
    background: 'rgba(255,255,255,0.72)',
    boxShadow: '0 20px 80px rgba(23,32,51,0.08)',
  },
  kicker: {
    margin: 0,
    color: '#047857',
    fontSize: 13,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
  },
  title: {
    margin: '8px 0',
    fontSize: 'clamp(34px, 7vw, 72px)',
    lineHeight: 0.95,
    letterSpacing: '-0.06em',
  },
  copy: {
    maxWidth: 680,
    color: '#475569',
    fontSize: 18,
    lineHeight: 1.55,
  },
  button: {
    display: 'inline-block',
    marginTop: 14,
    padding: '12px 18px',
    borderRadius: 999,
    color: 'white',
    background: '#172033',
    textDecoration: 'none',
  },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 14,
    maxWidth: 920,
    margin: '0 auto 18px',
  },
  metric: {
    padding: 18,
    borderRadius: 22,
    background: 'rgba(255,255,255,0.74)',
    border: '1px solid rgba(23, 32, 51, 0.1)',
  },
  metricValue: {
    display: 'block',
    fontSize: 38,
    fontWeight: 800,
  },
  metricLabel: {
    color: '#64748b',
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 16,
    maxWidth: 1180,
    margin: '0 auto',
  },
  card: {
    padding: 20,
    borderRadius: 24,
    background: 'rgba(255,255,255,0.82)',
    border: '1px solid rgba(23, 32, 51, 0.1)',
    boxShadow: '0 14px 54px rgba(23,32,51,0.08)',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'flex-start',
  },
  cardTitle: {
    margin: 0,
    fontSize: 24,
    letterSpacing: '-0.04em',
  },
  ref: {
    margin: '4px 0 0',
    color: '#64748b',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  badge: {
    borderRadius: 999,
    color: 'white',
    fontSize: 12,
    padding: '5px 9px',
    whiteSpace: 'nowrap',
  },
  rows: {
    display: 'grid',
    gap: 10,
    marginTop: 18,
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 8,
    borderBottom: '1px solid rgba(23,32,51,0.08)',
    color: '#475569',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 18,
  },
  link: {
    borderRadius: 999,
    border: '1px solid rgba(23,32,51,0.16)',
    padding: '8px 11px',
    color: '#172033',
    textDecoration: 'none',
    fontSize: 13,
  },
  empty: {
    padding: 24,
    borderRadius: 20,
    background: 'rgba(255,255,255,0.78)',
    color: '#64748b',
  },
}
