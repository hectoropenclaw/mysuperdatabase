'use client'

import { useEffect, useMemo, useState } from 'react'
import type React from 'react'

type Project = {
  id: string
  ref: string
  name: string
  status: string
  site_url: string | null
}

type QueryHistory = {
  id: string
  query: string
  status: string
  is_write: boolean
  duration_ms: number | null
  row_count: number | null
  error: string | null
  created_at: string
}

type SqlSnippet = {
  id: string
  name: string
  description: string | null
  sql: string
  tags: string[]
  updated_at: string
}

const starterSql = `select
  table_schema,
  table_name
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name
limit 50`

export default function SqlEditorClient({ projects, initialProjectRef }: { projects: Project[]; initialProjectRef?: string }) {
  const [projectRef, setProjectRef] = useState(initialProjectRef && projects.some((project) => project.ref === initialProjectRef) ? initialProjectRef : projects[0]?.ref ?? '')
  const [sql, setSql] = useState(starterSql)
  const [result, setResult] = useState<any[] | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [confirmWrite, setConfirmWrite] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [explain, setExplain] = useState(false)
  const [history, setHistory] = useState<QueryHistory[]>([])
  const [snippets, setSnippets] = useState<SqlSnippet[]>([])
  const [snippetName, setSnippetName] = useState('')

  const selectedProject = projects.find((project) => project.ref === projectRef)
  const isWrite = /^\s*(alter|call|comment|create|delete|do|drop|grant|insert|reindex|revoke|truncate|update|vacuum)\b/i.test(sql)
  const columns = useMemo(() => {
    const first = Array.isArray(result) ? result[0] : null
    return first && typeof first === 'object' ? Object.keys(first) : []
  }, [result])

  useEffect(() => {
    if (!projectRef) return
    void refreshSidebars(projectRef)
  }, [projectRef])

  async function refreshSidebars(ref = projectRef) {
    const [historyRes, snippetsRes] = await Promise.all([
      fetch(`/api/platform/sql/${ref}/history?limit=25`),
      fetch(`/api/platform/sql/${ref}/snippets`),
    ])
    if (historyRes.ok) setHistory(await historyRes.json())
    if (snippetsRes.ok) setSnippets(await snippetsRes.json())
  }

  async function runQuery() {
    if (!projectRef || !sql.trim()) return
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const res = await fetch(`/api/platform/sql/${projectRef}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql,
          confirm_write: confirmWrite,
          dry_run: dryRun,
          explain,
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(payload.message ?? payload.error ?? `SQL failed with ${res.status}`)
        return
      }
      setResult(Array.isArray(payload.data) ? payload.data : [payload.data])
      await refreshSidebars()
    } finally {
      setRunning(false)
    }
  }

  async function saveSnippet() {
    const name = snippetName.trim()
    if (!projectRef || !name || !sql.trim()) return
    const res = await fetch(`/api/platform/sql/${projectRef}/snippets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, sql, tags: isWrite ? ['write'] : ['read'] }),
    })
    if (res.ok) {
      setSnippetName('')
      await refreshSidebars()
    }
  }

  if (!projects.length) {
    return (
      <main style={styles.shell}>
        <section style={styles.panel}>
          <p style={styles.kicker}>SQL Editor</p>
          <h1 style={styles.title}>No hay proyectos activos todavía.</h1>
          <p style={styles.copy}>Crea o importa un proyecto para ejecutar SQL desde SupaNow Studio.</p>
        </section>
      </main>
    )
  }

  return (
    <main style={styles.shell}>
      <section style={styles.hero}>
        <div>
          <p style={styles.kicker}>SupaNow SQL Editor</p>
          <h1 style={styles.title}>Query, inspect, save, repeat.</h1>
          <p style={styles.copy}>Un editor estilo Supabase con historial, snippets, EXPLAIN y guardrails para escrituras.</p>
        </div>
        <a href="/" style={styles.backLink}>Studio Home</a>
      </section>

      <section style={styles.toolbar}>
        <label style={styles.label}>
          Project
          <select value={projectRef} onChange={(event) => setProjectRef(event.target.value)} style={styles.select}>
            {projects.map((project) => (
              <option key={project.id} value={project.ref}>{project.name} ({project.ref})</option>
            ))}
          </select>
        </label>
        <div style={styles.projectMeta}>
          <strong>{selectedProject?.status}</strong>
          <span>{selectedProject?.site_url ?? 'No public URL yet'}</span>
        </div>
      </section>

      <section style={styles.workspace}>
        <aside style={styles.sidebar}>
          <PanelTitle title="Snippets" />
          <div style={styles.saveRow}>
            <input value={snippetName} onChange={(event) => setSnippetName(event.target.value)} placeholder="Snippet name" style={styles.input} />
            <button onClick={saveSnippet} style={styles.smallButton}>Save</button>
          </div>
          <div style={styles.list}>
            {snippets.map((snippet) => (
              <button key={snippet.id} onClick={() => setSql(snippet.sql)} style={styles.listItem}>
                <strong>{snippet.name}</strong>
                <span>{snippet.description ?? snippet.tags?.join(', ') ?? 'SQL snippet'}</span>
              </button>
            ))}
            {!snippets.length ? <p style={styles.empty}>No snippets yet.</p> : null}
          </div>

          <PanelTitle title="History" />
          <div style={styles.list}>
            {history.map((item) => (
              <button key={item.id} onClick={() => setSql(item.query)} style={styles.listItem}>
                <strong>{item.status}{item.is_write ? ' · write' : ' · read'}</strong>
                <span>{item.query.slice(0, 92)}</span>
                <small>{item.duration_ms ?? 0}ms · {item.row_count ?? 0} rows</small>
              </button>
            ))}
            {!history.length ? <p style={styles.empty}>No query history yet.</p> : null}
          </div>
        </aside>

        <section style={styles.editorPanel}>
          <div style={styles.editorHeader}>
            <div>
              <strong>{isWrite ? 'Write query' : 'Read query'}</strong>
              <span style={styles.muted}>{isWrite ? 'Confirmation required unless dry-run is enabled.' : 'Safe to run or explain.'}</span>
            </div>
            <div style={styles.actions}>
              <label style={styles.check}><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} /> Dry run</label>
              <label style={styles.check}><input type="checkbox" checked={explain} onChange={(event) => setExplain(event.target.checked)} disabled={isWrite} /> Explain</label>
              <label style={styles.check}><input type="checkbox" checked={confirmWrite} onChange={(event) => setConfirmWrite(event.target.checked)} /> Confirm write</label>
              <button onClick={runQuery} disabled={running || (isWrite && !confirmWrite && !dryRun)} style={styles.runButton}>
                {running ? 'Running...' : 'Run'}
              </button>
            </div>
          </div>
          <textarea value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false} style={styles.textarea} />
          {error ? <pre style={styles.error}>{error}</pre> : null}

          <div style={styles.results}>
            <div style={styles.resultsHeader}>
              <strong>Results</strong>
              <span>{result ? `${result.length} row(s)` : 'Run a query to see output'}</span>
            </div>
            {result && columns.length ? (
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>{columns.map((column) => <th key={column} style={styles.th}>{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    {result.map((row, index) => (
                      <tr key={index}>
                        {columns.map((column) => <td key={column} style={styles.td}>{formatCell(row[column])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : result ? (
              <pre style={styles.raw}>{JSON.stringify(result, null, 2)}</pre>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  )
}

function PanelTitle({ title }: { title: string }) {
  return <h2 style={styles.panelTitle}>{title}</h2>
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: '100vh',
    padding: 24,
    color: '#e5eef7',
    background: 'radial-gradient(circle at 12% 0%, rgba(60, 179, 113, 0.22), transparent 34%), linear-gradient(135deg, #07120f 0%, #10231d 48%, #0f172a 100%)',
    fontFamily: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  },
  hero: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 20,
    alignItems: 'flex-start',
    maxWidth: 1320,
    margin: '0 auto 18px',
    padding: 24,
    borderRadius: 28,
    border: '1px solid rgba(229,238,247,0.12)',
    background: 'rgba(8, 21, 17, 0.72)',
  },
  kicker: { margin: 0, color: '#7dd3fc', letterSpacing: '0.16em', textTransform: 'uppercase', fontSize: 12 },
  title: { margin: '8px 0', fontSize: 'clamp(34px, 7vw, 72px)', lineHeight: 0.95, letterSpacing: '-0.06em' },
  copy: { color: '#9fb3c8', fontSize: 17, maxWidth: 720, lineHeight: 1.5 },
  backLink: { color: '#e5eef7', textDecoration: 'none', border: '1px solid rgba(229,238,247,0.16)', borderRadius: 999, padding: '10px 14px' },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'end',
    maxWidth: 1320,
    margin: '0 auto 18px',
    padding: 18,
    borderRadius: 22,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(229,238,247,0.12)',
  },
  label: { display: 'grid', gap: 8, color: '#9fb3c8', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.08em' },
  select: { minWidth: 300, borderRadius: 14, padding: 12, background: '#06120f', color: '#e5eef7', border: '1px solid rgba(229,238,247,0.18)' },
  projectMeta: { display: 'grid', gap: 4, textAlign: 'right', color: '#9fb3c8' },
  workspace: { display: 'grid', gridTemplateColumns: '340px minmax(0, 1fr)', gap: 18, maxWidth: 1320, margin: '0 auto' },
  sidebar: { display: 'grid', alignContent: 'start', gap: 12, borderRadius: 24, padding: 16, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(229,238,247,0.12)' },
  panel: { maxWidth: 760, margin: '80px auto', padding: 28, borderRadius: 28, background: 'rgba(255,255,255,0.06)' },
  panelTitle: { margin: '12px 0 0', fontSize: 18 },
  saveRow: { display: 'flex', gap: 8 },
  input: { minWidth: 0, flex: 1, borderRadius: 12, padding: 10, background: '#06120f', color: '#e5eef7', border: '1px solid rgba(229,238,247,0.16)' },
  smallButton: { border: 0, borderRadius: 12, padding: '10px 12px', color: '#07120f', background: '#7dd3fc', fontWeight: 800 },
  list: { display: 'grid', gap: 8, maxHeight: 300, overflow: 'auto' },
  listItem: { display: 'grid', gap: 4, textAlign: 'left', padding: 12, borderRadius: 14, border: '1px solid rgba(229,238,247,0.1)', background: 'rgba(0,0,0,0.2)', color: '#e5eef7', cursor: 'pointer' },
  empty: { color: '#9fb3c8', fontSize: 14 },
  editorPanel: { minWidth: 0, borderRadius: 24, overflow: 'hidden', background: 'rgba(3, 8, 7, 0.82)', border: '1px solid rgba(229,238,247,0.12)' },
  editorHeader: { display: 'flex', justifyContent: 'space-between', gap: 16, padding: 16, borderBottom: '1px solid rgba(229,238,247,0.1)' },
  muted: { display: 'block', color: '#9fb3c8', marginTop: 4 },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 10 },
  check: { display: 'inline-flex', gap: 6, alignItems: 'center', color: '#cbd5e1', fontSize: 14 },
  runButton: { border: 0, borderRadius: 999, padding: '11px 18px', color: '#07120f', background: '#86efac', fontWeight: 900 },
  textarea: { width: '100%', minHeight: 330, resize: 'vertical', boxSizing: 'border-box', padding: 18, border: 0, outline: 0, color: '#dbeafe', background: '#020617', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 14, lineHeight: 1.65 },
  error: { margin: 16, padding: 14, borderRadius: 14, color: '#fecaca', background: 'rgba(127, 29, 29, 0.38)', whiteSpace: 'pre-wrap' },
  results: { padding: 16 },
  resultsHeader: { display: 'flex', justifyContent: 'space-between', color: '#cbd5e1', marginBottom: 12 },
  tableWrap: { overflow: 'auto', borderRadius: 14, border: '1px solid rgba(229,238,247,0.12)' },
  table: { width: '100%', borderCollapse: 'collapse', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 13 },
  th: { position: 'sticky', top: 0, textAlign: 'left', background: '#0f172a', color: '#bae6fd', padding: 10, borderBottom: '1px solid rgba(229,238,247,0.12)' },
  td: { maxWidth: 460, padding: 10, color: '#dbeafe', borderBottom: '1px solid rgba(229,238,247,0.08)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  raw: { padding: 14, borderRadius: 14, overflow: 'auto', color: '#dbeafe', background: '#020617' },
}
