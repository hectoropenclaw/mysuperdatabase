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

type SchemaColumn = {
  name: string
  type: string
  nullable: boolean
  default: string | null
}

type SchemaTable = {
  name: string
  columns: SchemaColumn[]
}

type SchemaGroup = {
  name: string
  tables: SchemaTable[]
}

type SchemaDoc = {
  schemas: SchemaGroup[]
}

const starterSql = `select
  table_schema,
  table_name
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name
limit 50`

const templates = [
  {
    name: 'List tables',
    sql: starterSql,
  },
  {
    name: 'Recent auth users',
    sql: `select id, email, created_at
from auth.users
order by created_at desc
limit 20`,
  },
  {
    name: 'RLS policies',
    sql: `select schemaname, tablename, policyname, cmd, roles
from pg_policies
order by schemaname, tablename, policyname`,
  },
  {
    name: 'Indexes',
    sql: `select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname not in ('pg_catalog', 'information_schema')
order by schemaname, tablename, indexname`,
  },
]

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
  const [schema, setSchema] = useState<SchemaDoc | null>(null)
  const [schemaError, setSchemaError] = useState('')
  const [snippetName, setSnippetName] = useState('')
  const [rightTab, setRightTab] = useState<'history' | 'snippets'>('history')
  const [bottomTab, setBottomTab] = useState<'results' | 'messages'>('results')

  const selectedProject = projects.find((project) => project.ref === projectRef)
  const isWrite = /^\s*(alter|call|comment|create|delete|do|drop|grant|insert|reindex|revoke|truncate|update|vacuum)\b/i.test(sql)
  const columns = useMemo(() => {
    const first = Array.isArray(result) ? result[0] : null
    return first && typeof first === 'object' ? Object.keys(first) : []
  }, [result])

  const stats = useMemo(() => {
    const schemas = schema?.schemas ?? []
    const tableCount = schemas.reduce((total, group) => total + (group.tables?.length ?? 0), 0)
    const columnCount = schemas.reduce((total, group) => total + (group.tables ?? []).reduce((sum, table) => sum + (table.columns?.length ?? 0), 0), 0)
    return { schemas: schemas.length, tables: tableCount, columns: columnCount }
  }, [schema])

  useEffect(() => {
    if (!projectRef) return
    setResult(null)
    setError('')
    setSchema(null)
    setSchemaError('')
    void refreshStudio(projectRef)
  }, [projectRef])

  async function refreshStudio(ref = projectRef) {
    const [historyRes, snippetsRes, schemaRes] = await Promise.all([
      fetch(`/api/platform/sql/${ref}/history?limit=35`),
      fetch(`/api/platform/sql/${ref}/snippets`),
      fetch(`/api/platform/sql/${ref}/schema`),
    ])
    if (historyRes.ok) setHistory(await historyRes.json())
    if (snippetsRes.ok) setSnippets(await snippetsRes.json())
    if (schemaRes.ok) {
      setSchema(await schemaRes.json())
    } else {
      const payload = await schemaRes.json().catch(() => ({}))
      setSchemaError(payload.message ?? payload.error ?? 'Could not load schema')
    }
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
        setBottomTab('messages')
        setError(payload.message ?? payload.error ?? `SQL failed with ${res.status}`)
        return
      }
      setResult(Array.isArray(payload.data) ? payload.data : [payload.data])
      setBottomTab('results')
      await refreshStudio()
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
      setRightTab('snippets')
      await refreshStudio()
    }
  }

  function selectTable(group: string, table: SchemaTable) {
    setSql(`select *
from ${quoteIdent(group)}.${quoteIdent(table.name)}
limit 100`)
  }

  if (!projects.length) {
    return (
      <main style={styles.emptyShell}>
        <section style={styles.emptyCard}>
          <p style={styles.kicker}>SQL Editor</p>
          <h1 style={styles.emptyTitle}>No hay proyectos activos todavía.</h1>
          <p style={styles.emptyCopy}>Crea o importa un proyecto para ejecutar SQL desde SupaNow Studio.</p>
        </section>
      </main>
    )
  }

  return (
    <main style={styles.shell}>
      <nav style={styles.rail}>
        <a href="/" style={styles.logo}>S</a>
        <a href="/" style={styles.railItem}>Home</a>
        <a href="/sql" style={{ ...styles.railItem, ...styles.railActive }}>SQL</a>
        <span style={styles.railItem}>Auth</span>
        <span style={styles.railItem}>Storage</span>
      </nav>

      <section style={styles.studio}>
        <header style={styles.topbar}>
          <div>
            <p style={styles.kicker}>SupaNow Studio</p>
            <h1 style={styles.title}>SQL Editor</h1>
          </div>
          <div style={styles.topActions}>
            <select value={projectRef} onChange={(event) => setProjectRef(event.target.value)} style={styles.select}>
              {projects.map((project) => (
                <option key={project.id} value={project.ref}>{project.name} ({project.ref})</option>
              ))}
            </select>
            <button onClick={() => refreshStudio()} style={styles.secondaryButton}>Refresh</button>
            <a href="/" style={styles.secondaryLink}>Studio Home</a>
          </div>
        </header>

        <section style={styles.statusStrip}>
          <Metric label="Project" value={selectedProject?.name ?? 'Unknown'} />
          <Metric label="Status" value={selectedProject?.status ?? 'unknown'} tone="green" />
          <Metric label="Schemas" value={String(stats.schemas)} />
          <Metric label="Tables" value={String(stats.tables)} />
          <Metric label="Columns" value={String(stats.columns)} />
          <Metric label="URL" value={selectedProject?.site_url ? 'configured' : 'missing'} tone={selectedProject?.site_url ? 'green' : 'amber'} />
        </section>

        <section style={styles.workspace}>
          <aside style={styles.schemaPanel}>
            <div style={styles.panelHeader}>
              <div>
                <strong>Database</strong>
                <span style={styles.subtle}>Schema explorer</span>
              </div>
            </div>
            {schemaError ? <p style={styles.warning}>{schemaError}</p> : null}
            <div style={styles.schemaTree}>
              {(schema?.schemas ?? []).map((group) => (
                <details key={group.name} open={group.name === 'public'} style={styles.schemaGroup}>
                  <summary style={styles.schemaSummary}>{group.name}</summary>
                  {(group.tables ?? []).map((table) => (
                    <details key={`${group.name}.${table.name}`} style={styles.tableNode}>
                      <summary style={styles.tableSummary}>
                        <button onClick={(event) => { event.preventDefault(); selectTable(group.name, table) }} style={styles.tableButton}>
                          {table.name}
                        </button>
                      </summary>
                      <div style={styles.columnList}>
                        {(table.columns ?? []).map((column) => (
                          <button
                            key={column.name}
                            onClick={() => setSql(`${sql.trim()}\n-- ${group.name}.${table.name}.${column.name}: ${column.type}`)}
                            style={styles.columnItem}
                          >
                            <span>{column.name}</span>
                            <small>{column.type}{column.nullable ? '' : ' not null'}</small>
                          </button>
                        ))}
                      </div>
                    </details>
                  ))}
                </details>
              ))}
              {!schema && !schemaError ? <p style={styles.empty}>Loading schema...</p> : null}
            </div>

            <div style={styles.templatePanel}>
              <strong>Quick starts</strong>
              {templates.map((template) => (
                <button key={template.name} onClick={() => setSql(template.sql)} style={styles.templateButton}>{template.name}</button>
              ))}
            </div>
          </aside>

          <section style={styles.editorColumn}>
            <div style={styles.queryTabs}>
              <button style={{ ...styles.queryTab, ...styles.queryTabActive }}>Untitled query</button>
              <button onClick={() => setSql(starterSql)} style={styles.queryTab}>+ New query</button>
            </div>

            <div style={styles.editorCard}>
              <div style={styles.editorHeader}>
                <div>
                  <strong>{isWrite ? 'Write query' : 'Read query'}</strong>
                  <span style={styles.subtle}>{isWrite ? 'Safe mode requires confirmation or dry run.' : 'Run directly or inspect with EXPLAIN.'}</span>
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

              <div style={styles.editorFrame}>
                <div style={styles.lineNumbers}>
                  {sql.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}
                </div>
                <textarea value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false} style={styles.textarea} />
              </div>
            </div>

            <div style={styles.resultCard}>
              <div style={styles.bottomTabs}>
                <button onClick={() => setBottomTab('results')} style={{ ...styles.bottomTab, ...(bottomTab === 'results' ? styles.bottomTabActive : {}) }}>Results</button>
                <button onClick={() => setBottomTab('messages')} style={{ ...styles.bottomTab, ...(bottomTab === 'messages' ? styles.bottomTabActive : {}) }}>Messages</button>
                <span style={styles.resultMeta}>{result ? `${result.length} row(s)` : 'No query run yet'}</span>
              </div>

              {bottomTab === 'messages' ? (
                <pre style={error ? styles.error : styles.raw}>{error || 'No messages. Queries that fail or need confirmation will show details here.'}</pre>
              ) : result && columns.length ? (
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
              ) : (
                <div style={styles.placeholder}>Run a query to see rows here.</div>
              )}
            </div>
          </section>

          <aside style={styles.activityPanel}>
            <div style={styles.rightTabs}>
              <button onClick={() => setRightTab('history')} style={{ ...styles.rightTab, ...(rightTab === 'history' ? styles.rightTabActive : {}) }}>History</button>
              <button onClick={() => setRightTab('snippets')} style={{ ...styles.rightTab, ...(rightTab === 'snippets' ? styles.rightTabActive : {}) }}>Snippets</button>
            </div>

            {rightTab === 'snippets' ? (
              <>
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
              </>
            ) : (
              <div style={styles.list}>
                {history.map((item) => (
                  <button key={item.id} onClick={() => setSql(item.query)} style={styles.listItem}>
                    <strong>{item.status}{item.is_write ? ' · write' : ' · read'}</strong>
                    <span>{item.query.slice(0, 110)}</span>
                    <small>{item.duration_ms ?? 0}ms · {item.row_count ?? 0} rows · {new Date(item.created_at).toLocaleString()}</small>
                  </button>
                ))}
                {!history.length ? <p style={styles.empty}>No query history yet.</p> : null}
              </div>
            )}
          </aside>
        </section>
      </section>
    </main>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'amber' }) {
  return (
    <div style={styles.metric}>
      <span>{label}</span>
      <strong style={tone === 'green' ? styles.greenText : tone === 'amber' ? styles.amberText : undefined}>{value}</strong>
    </div>
  )
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
const sans = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: '100vh',
    display: 'grid',
    gridTemplateColumns: '76px minmax(0, 1fr)',
    color: '#d1d5db',
    background: '#050505',
    fontFamily: sans,
  },
  rail: {
    position: 'sticky',
    top: 0,
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    padding: '18px 10px',
    background: '#09090b',
    borderRight: '1px solid #27272a',
  },
  logo: {
    display: 'grid',
    placeItems: 'center',
    width: 38,
    height: 38,
    borderRadius: 12,
    color: '#052e16',
    background: '#3ecf8e',
    fontWeight: 950,
    textDecoration: 'none',
  },
  railItem: {
    width: '100%',
    padding: '10px 0',
    borderRadius: 12,
    color: '#a1a1aa',
    fontSize: 11,
    textAlign: 'center',
    textDecoration: 'none',
  },
  railActive: {
    color: '#e5e7eb',
    background: '#18181b',
    boxShadow: 'inset 0 0 0 1px #27272a',
  },
  studio: {
    minWidth: 0,
    padding: 20,
  },
  topbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 18,
    marginBottom: 14,
  },
  kicker: {
    margin: 0,
    color: '#3ecf8e',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    fontSize: 11,
    fontWeight: 800,
  },
  title: {
    margin: '4px 0 0',
    color: '#f4f4f5',
    fontSize: 28,
    letterSpacing: '-0.04em',
  },
  topActions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 10,
  },
  select: {
    minWidth: 310,
    borderRadius: 8,
    padding: '10px 12px',
    background: '#09090b',
    color: '#e5e7eb',
    border: '1px solid #3f3f46',
  },
  secondaryButton: {
    border: '1px solid #3f3f46',
    borderRadius: 8,
    padding: '10px 12px',
    color: '#e5e7eb',
    background: '#18181b',
    fontWeight: 750,
  },
  secondaryLink: {
    border: '1px solid #3f3f46',
    borderRadius: 8,
    padding: '10px 12px',
    color: '#e5e7eb',
    background: '#18181b',
    fontWeight: 750,
    textDecoration: 'none',
  },
  statusStrip: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
    gap: 10,
    marginBottom: 14,
  },
  metric: {
    display: 'grid',
    gap: 5,
    padding: 12,
    borderRadius: 10,
    background: '#09090b',
    border: '1px solid #27272a',
  },
  greenText: { color: '#3ecf8e' },
  amberText: { color: '#fbbf24' },
  workspace: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr) 330px',
    gap: 14,
    alignItems: 'start',
  },
  schemaPanel: {
    position: 'sticky',
    top: 20,
    display: 'grid',
    gap: 12,
    maxHeight: 'calc(100vh - 40px)',
    overflow: 'hidden',
    padding: 14,
    borderRadius: 12,
    background: '#09090b',
    border: '1px solid #27272a',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    color: '#f4f4f5',
  },
  subtle: {
    display: 'block',
    marginTop: 3,
    color: '#a1a1aa',
    fontSize: 12,
  },
  warning: {
    margin: 0,
    padding: 10,
    borderRadius: 8,
    color: '#fde68a',
    background: 'rgba(146, 64, 14, 0.22)',
    border: '1px solid rgba(251, 191, 36, 0.18)',
    fontSize: 13,
  },
  schemaTree: {
    display: 'grid',
    gap: 8,
    overflow: 'auto',
    paddingRight: 4,
  },
  schemaGroup: {
    borderRadius: 10,
    background: '#111113',
    border: '1px solid #27272a',
  },
  schemaSummary: {
    padding: '10px 12px',
    color: '#f4f4f5',
    cursor: 'pointer',
    fontWeight: 800,
  },
  tableNode: {
    margin: '0 8px 8px',
    borderRadius: 8,
    background: '#09090b',
  },
  tableSummary: {
    listStyle: 'none',
  },
  tableButton: {
    width: '100%',
    padding: '9px 10px',
    border: 0,
    color: '#d4d4d8',
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: mono,
    fontSize: 13,
  },
  columnList: {
    display: 'grid',
    gap: 3,
    padding: '0 8px 8px',
  },
  columnItem: {
    display: 'grid',
    gap: 2,
    padding: '7px 8px',
    border: 0,
    borderRadius: 7,
    color: '#a1a1aa',
    background: '#050505',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: mono,
    fontSize: 12,
  },
  templatePanel: {
    display: 'grid',
    gap: 8,
    paddingTop: 12,
    borderTop: '1px solid #27272a',
  },
  templateButton: {
    border: '1px solid #27272a',
    borderRadius: 8,
    padding: '9px 10px',
    color: '#d4d4d8',
    background: '#111113',
    textAlign: 'left',
    cursor: 'pointer',
  },
  editorColumn: {
    minWidth: 0,
    display: 'grid',
    gap: 12,
  },
  queryTabs: {
    display: 'flex',
    gap: 6,
  },
  queryTab: {
    border: '1px solid #27272a',
    borderRadius: '9px 9px 0 0',
    padding: '9px 12px',
    color: '#a1a1aa',
    background: '#09090b',
  },
  queryTabActive: {
    color: '#f4f4f5',
    background: '#18181b',
    borderColor: '#3f3f46',
  },
  editorCard: {
    overflow: 'hidden',
    borderRadius: 12,
    background: '#09090b',
    border: '1px solid #27272a',
  },
  editorHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    padding: 14,
    borderBottom: '1px solid #27272a',
    color: '#f4f4f5',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
  },
  check: {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
    color: '#d4d4d8',
    fontSize: 13,
  },
  runButton: {
    border: 0,
    borderRadius: 8,
    padding: '10px 18px',
    color: '#052e16',
    background: '#3ecf8e',
    fontWeight: 950,
  },
  editorFrame: {
    display: 'grid',
    gridTemplateColumns: '52px minmax(0, 1fr)',
    background: '#050505',
  },
  lineNumbers: {
    display: 'grid',
    alignContent: 'start',
    gap: 0,
    padding: '16px 10px',
    color: '#52525b',
    background: '#09090b',
    borderRight: '1px solid #27272a',
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 1.65,
    textAlign: 'right',
    userSelect: 'none',
  },
  textarea: {
    width: '100%',
    minHeight: 360,
    resize: 'vertical',
    boxSizing: 'border-box',
    padding: 16,
    border: 0,
    outline: 0,
    color: '#e5e7eb',
    background: '#050505',
    fontFamily: mono,
    fontSize: 14,
    lineHeight: 1.65,
  },
  resultCard: {
    overflow: 'hidden',
    minHeight: 220,
    borderRadius: 12,
    background: '#09090b',
    border: '1px solid #27272a',
  },
  bottomTabs: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: 10,
    borderBottom: '1px solid #27272a',
  },
  bottomTab: {
    border: 0,
    borderRadius: 7,
    padding: '8px 10px',
    color: '#a1a1aa',
    background: 'transparent',
  },
  bottomTabActive: {
    color: '#f4f4f5',
    background: '#18181b',
  },
  resultMeta: {
    marginLeft: 'auto',
    color: '#a1a1aa',
    fontSize: 13,
  },
  tableWrap: {
    maxHeight: 360,
    overflow: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: mono,
    fontSize: 13,
  },
  th: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    textAlign: 'left',
    background: '#18181b',
    color: '#3ecf8e',
    padding: 10,
    borderBottom: '1px solid #27272a',
  },
  td: {
    maxWidth: 420,
    padding: 10,
    color: '#d4d4d8',
    borderBottom: '1px solid #18181b',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  raw: {
    margin: 12,
    padding: 14,
    borderRadius: 10,
    overflow: 'auto',
    color: '#d4d4d8',
    background: '#050505',
    border: '1px solid #27272a',
    whiteSpace: 'pre-wrap',
  },
  error: {
    margin: 12,
    padding: 14,
    borderRadius: 10,
    overflow: 'auto',
    color: '#fecaca',
    background: 'rgba(127, 29, 29, 0.25)',
    border: '1px solid rgba(248, 113, 113, 0.24)',
    whiteSpace: 'pre-wrap',
  },
  placeholder: {
    display: 'grid',
    placeItems: 'center',
    minHeight: 180,
    color: '#71717a',
  },
  activityPanel: {
    position: 'sticky',
    top: 20,
    display: 'grid',
    gap: 12,
    maxHeight: 'calc(100vh - 40px)',
    overflow: 'hidden',
    padding: 14,
    borderRadius: 12,
    background: '#09090b',
    border: '1px solid #27272a',
  },
  rightTabs: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 6,
  },
  rightTab: {
    border: 0,
    borderRadius: 8,
    padding: '9px 10px',
    color: '#a1a1aa',
    background: '#111113',
  },
  rightTabActive: {
    color: '#f4f4f5',
    background: '#18181b',
    boxShadow: 'inset 0 0 0 1px #3f3f46',
  },
  saveRow: {
    display: 'flex',
    gap: 8,
  },
  input: {
    minWidth: 0,
    flex: 1,
    borderRadius: 8,
    padding: 10,
    background: '#050505',
    color: '#e5e7eb',
    border: '1px solid #27272a',
  },
  smallButton: {
    border: 0,
    borderRadius: 8,
    padding: '10px 12px',
    color: '#052e16',
    background: '#3ecf8e',
    fontWeight: 900,
  },
  list: {
    display: 'grid',
    alignContent: 'start',
    gap: 8,
    overflow: 'auto',
    paddingRight: 4,
  },
  listItem: {
    display: 'grid',
    gap: 5,
    textAlign: 'left',
    padding: 12,
    borderRadius: 10,
    border: '1px solid #27272a',
    background: '#111113',
    color: '#e5e7eb',
    cursor: 'pointer',
  },
  empty: {
    color: '#a1a1aa',
    fontSize: 14,
  },
  emptyShell: {
    minHeight: '100vh',
    display: 'grid',
    placeItems: 'center',
    color: '#e5e7eb',
    background: '#050505',
    fontFamily: sans,
  },
  emptyCard: {
    maxWidth: 640,
    padding: 28,
    borderRadius: 18,
    background: '#09090b',
    border: '1px solid #27272a',
  },
  emptyTitle: {
    margin: '8px 0',
    fontSize: 44,
    letterSpacing: '-0.05em',
  },
  emptyCopy: {
    color: '#a1a1aa',
    lineHeight: 1.6,
  },
}
