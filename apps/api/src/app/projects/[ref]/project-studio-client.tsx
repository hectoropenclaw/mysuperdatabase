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

type Column = { name: string; type: string; nullable: boolean; default: string | null }
type Table = { name: string; columns: Column[] }
type Schema = { name: string; tables: Table[] }
type SchemaDoc = { schemas: Schema[] }
type Tab = 'tables' | 'sql' | 'auth' | 'storage' | 'ops' | 'settings'

const emptyJson = '{}'

export default function ProjectStudioClient({ project }: { project: Project }) {
  const [tab, setTab] = useState<Tab>('tables')
  const [schema, setSchema] = useState<SchemaDoc | null>(null)
  const [selectedSchema, setSelectedSchema] = useState('public')
  const [selectedTable, setSelectedTable] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [rowDraft, setRowDraft] = useState(emptyJson)
  const [insertDraft, setInsertDraft] = useState(emptyJson)
  const [pkColumns, setPkColumns] = useState('id')
  const [users, setUsers] = useState<any[]>([])
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [buckets, setBuckets] = useState<any[]>([])
  const [bucketId, setBucketId] = useState('')
  const [newBucket, setNewBucket] = useState('')
  const [objects, setObjects] = useState<any[]>([])
  const [objectSearch, setObjectSearch] = useState('')
  const [signedPath, setSignedPath] = useState('')
  const [signedUrl, setSignedUrl] = useState('')
  const [services, setServices] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [alerts, setAlerts] = useState<any[]>([])
  const [operations, setOperations] = useState<any[]>([])
  const [backups, setBackups] = useState<any[]>([])
  const [pitr, setPitr] = useState<any[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const schemas = schema?.schemas ?? []
  const tables = schemas.find((item) => item.name === selectedSchema)?.tables ?? []
  const table = tables.find((item) => item.name === selectedTable)
  const rowColumns = useMemo(() => {
    const first = rows[0]
    return first && typeof first === 'object' ? Object.keys(first) : table?.columns.map((column) => column.name) ?? []
  }, [rows, table])

  useEffect(() => {
    void loadCore()
  }, [])

  useEffect(() => {
    if (!selectedTable && tables[0]) setSelectedTable(tables[0].name)
  }, [selectedTable, tables])

  useEffect(() => {
    if (selectedSchema && selectedTable) void loadRows()
  }, [selectedSchema, selectedTable])

  useEffect(() => {
    if (!bucketId && buckets[0]?.id) setBucketId(buckets[0].id)
  }, [bucketId, buckets])

  useEffect(() => {
    if (bucketId) void loadObjects()
  }, [bucketId])

  async function api(path: string, init?: RequestInit) {
    const res = await fetch(path, init)
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload.message ?? payload.error ?? `Request failed: ${res.status}`)
    return payload
  }

  async function loadCore() {
    setLoading(true)
    setMessage('')
    try {
      const [schemaPayload, settingsPayload, userPayload, bucketPayload, servicesPayload, logsPayload, alertsPayload, operationsPayload, backupsPayload, pitrPayload] = await Promise.allSettled([
        api(`/api/platform/sql/${project.ref}/schema`),
        api(`/api/platform/projects/${project.ref}/settings`),
        api(`/api/platform/auth/${project.ref}/users?per_page=50`),
        api(`/api/platform/storage/${project.ref}/buckets`),
        api(`/api/platform/projects/${project.ref}/services/status`),
        api(`/api/platform/projects/${project.ref}/logs?limit=80`),
        api(`/api/platform/projects/${project.ref}/alerts?limit=80`),
        api(`/api/platform/projects/${project.ref}/operations?limit=80`),
        api(`/api/platform/projects/${project.ref}/backups`),
        api(`/api/platform/projects/${project.ref}/pitr`),
      ])
      if (schemaPayload.status === 'fulfilled') {
        setSchema(schemaPayload.value)
        const firstSchema = schemaPayload.value.schemas?.find((item: Schema) => item.name === 'public') ?? schemaPayload.value.schemas?.[0]
        if (firstSchema) {
          setSelectedSchema(firstSchema.name)
          setSelectedTable(firstSchema.tables?.[0]?.name ?? '')
        }
      }
      if (settingsPayload.status === 'fulfilled') setSettings(settingsPayload.value)
      if (userPayload.status === 'fulfilled') setUsers(normalizeUsers(userPayload.value))
      if (bucketPayload.status === 'fulfilled') setBuckets(normalizeBuckets(bucketPayload.value))
      if (servicesPayload.status === 'fulfilled') setServices(servicesPayload.value.services ?? [])
      if (logsPayload.status === 'fulfilled') setLogs(logsPayload.value)
      if (alertsPayload.status === 'fulfilled') setAlerts(alertsPayload.value)
      if (operationsPayload.status === 'fulfilled') setOperations(operationsPayload.value)
      if (backupsPayload.status === 'fulfilled') setBackups(backupsPayload.value)
      if (pitrPayload.status === 'fulfilled') setPitr(pitrPayload.value)
    } catch (err: any) {
      setMessage(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadRows() {
    if (!selectedSchema || !selectedTable) return
    try {
      const payload = await api(`/api/platform/table-editor/${project.ref}/${selectedSchema}/${selectedTable}/rows?limit=100`)
      setRows(payload.rows ?? [])
      setRowDraft(emptyJson)
    } catch (err: any) {
      setMessage(err.message)
    }
  }

  async function insertRow() {
    await mutate(async () => {
      await api(`/api/platform/table-editor/${project.ref}/${selectedSchema}/${selectedTable}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row: parseJson(insertDraft) }),
      })
      setInsertDraft(emptyJson)
      await loadRows()
    }, 'Row inserted.')
  }

  async function updateRow() {
    await mutate(async () => {
      const values = parseJson(rowDraft)
      const original = rows[0] ?? {}
      await api(`/api/platform/table-editor/${project.ref}/${selectedSchema}/${selectedTable}/rows`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: pickPk(original), values }),
      })
      await loadRows()
    }, 'Row updated.')
  }

  async function deleteRow(row = rows[0]) {
    await mutate(async () => {
      await api(`/api/platform/table-editor/${project.ref}/${selectedSchema}/${selectedTable}/rows`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: pickPk(row) }),
      })
      await loadRows()
    }, 'Row deleted.')
  }

  async function createUser(kind: 'create' | 'invite' | 'recover' | 'magiclink') {
    const endpoints = {
      create: `/api/platform/auth/${project.ref}/users`,
      invite: `/api/platform/auth/${project.ref}/invite`,
      recover: `/api/platform/auth/${project.ref}/recover`,
      magiclink: `/api/platform/auth/${project.ref}/magiclink`,
    }
    await mutate(async () => {
      await api(endpoints[kind], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'create' ? { email: authEmail, password: authPassword, email_confirm: true } : { email: authEmail }),
      })
      const payload = await api(`/api/platform/auth/${project.ref}/users?per_page=50`)
      setUsers(normalizeUsers(payload))
    }, kind === 'create' ? 'User created.' : 'Auth action sent.')
  }

  async function createBucket() {
    await mutate(async () => {
      await api(`/api/platform/storage/${project.ref}/buckets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newBucket, name: newBucket, public: false }),
      })
      setNewBucket('')
      const payload = await api(`/api/platform/storage/${project.ref}/buckets`)
      setBuckets(normalizeBuckets(payload))
    }, 'Bucket created.')
  }

  async function loadObjects() {
    if (!bucketId) return
    try {
      const payload = await api(`/api/platform/storage/${project.ref}/buckets/${bucketId}/objects/search?q=${encodeURIComponent(objectSearch)}&limit=80`)
      setObjects(payload.objects ?? [])
    } catch (err: any) {
      setMessage(err.message)
    }
  }

  async function signObject() {
    await mutate(async () => {
      const payload = await api(`/api/platform/storage/${project.ref}/buckets/${bucketId}/objects/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [signedPath], expiresIn: 3600 }),
      })
      setSignedUrl(JSON.stringify(payload, null, 2))
    }, 'Signed URL generated.')
  }

  async function collectLogs() {
    await mutate(async () => {
      await api(`/api/platform/projects/${project.ref}/logs/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since_minutes: 60 }),
      })
      setTimeout(() => void refreshOps(), 1500)
    }, 'Log collection queued.')
  }

  async function refreshOps() {
    const [servicesPayload, logsPayload, alertsPayload, operationsPayload, backupsPayload, pitrPayload] = await Promise.all([
      api(`/api/platform/projects/${project.ref}/services/status`),
      api(`/api/platform/projects/${project.ref}/logs?limit=100`),
      api(`/api/platform/projects/${project.ref}/alerts?limit=100`),
      api(`/api/platform/projects/${project.ref}/operations?limit=100`),
      api(`/api/platform/projects/${project.ref}/backups`),
      api(`/api/platform/projects/${project.ref}/pitr`),
    ])
    setServices(servicesPayload.services ?? [])
    setLogs(logsPayload)
    setAlerts(alertsPayload)
    setOperations(operationsPayload)
    setBackups(backupsPayload)
    setPitr(pitrPayload)
  }

  async function queueOp(path: string, ok: string) {
    await mutate(async () => {
      await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      setTimeout(() => void refreshOps(), 1500)
    }, ok)
  }

  async function mutate(fn: () => Promise<void>, ok: string) {
    setLoading(true)
    setMessage('')
    try {
      await fn()
      setMessage(ok)
    } catch (err: any) {
      setMessage(err.message)
    } finally {
      setLoading(false)
    }
  }

  function pickPk(row: any) {
    const columns = pkColumns.split(',').map((column) => column.trim()).filter(Boolean)
    return Object.fromEntries(columns.map((column) => [column, row?.[column]]))
  }

  return (
    <main style={styles.shell}>
      <aside style={styles.rail}>
        <a href="/" style={styles.logo}>S</a>
        {(['tables', 'sql', 'auth', 'storage', 'ops', 'settings'] as Tab[]).map((item) => (
          <button key={item} onClick={() => setTab(item)} style={{ ...styles.navItem, ...(tab === item ? styles.navActive : {}) }}>{label(item)}</button>
        ))}
      </aside>

      <section style={styles.main}>
        <header style={styles.header}>
          <div>
            <p style={styles.kicker}>SupaNow Studio</p>
            <h1 style={styles.title}>{project.name}</h1>
            <p style={styles.subtle}>{project.ref} · {project.status} · {project.site_url ?? 'no public API URL'}</p>
          </div>
          <div style={styles.headerActions}>
            <a href={`/sql?project=${project.ref}`} style={styles.linkButton}>SQL Editor</a>
            {project.site_url ? <a href={project.site_url} style={styles.linkButton}>Open API</a> : null}
            <button onClick={loadCore} style={styles.secondaryButton}>{loading ? 'Working...' : 'Refresh'}</button>
          </div>
        </header>

        {message ? <p style={message.toLowerCase().includes('failed') || message.toLowerCase().includes('error') ? styles.errorBanner : styles.banner}>{message}</p> : null}

        {tab === 'tables' ? (
          <section style={styles.workspace}>
            <aside style={styles.panel}>
              <h2 style={styles.panelTitle}>Tables</h2>
              <select value={selectedSchema} onChange={(event) => { setSelectedSchema(event.target.value); setSelectedTable('') }} style={styles.input}>
                {schemas.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
              </select>
              <div style={styles.list}>
                {tables.map((item) => (
                  <button key={item.name} onClick={() => setSelectedTable(item.name)} style={{ ...styles.listItem, ...(selectedTable === item.name ? styles.listActive : {}) }}>
                    <strong>{item.name}</strong>
                    <span>{item.columns.length} columns</span>
                  </button>
                ))}
              </div>
            </aside>
            <section style={styles.content}>
              <div style={styles.cardHeader}>
                <div>
                  <h2 style={styles.h2}>{selectedSchema}.{selectedTable}</h2>
                  <p style={styles.subtle}>Browse, insert, update and delete rows. Set PK columns before mutating.</p>
                </div>
                <div style={styles.inline}>
                  <input value={pkColumns} onChange={(event) => setPkColumns(event.target.value)} placeholder="PK columns, e.g. id" style={styles.input} />
                  <button onClick={loadRows} style={styles.secondaryButton}>Reload rows</button>
                </div>
              </div>
              <DataTable columns={rowColumns} rows={rows} onSelect={(row) => setRowDraft(JSON.stringify(row, null, 2))} onDelete={deleteRow} />
              <section style={styles.dual}>
                <EditorBox title="Edit selected row values" value={rowDraft} setValue={setRowDraft} action="Save update" onAction={updateRow} />
                <EditorBox title="Insert row" value={insertDraft} setValue={setInsertDraft} action="Insert" onAction={insertRow} />
              </section>
            </section>
          </section>
        ) : null}

        {tab === 'sql' ? (
          <section style={styles.contentOnly}>
            <h2 style={styles.h2}>SQL workspace</h2>
            <p style={styles.subtle}>The full SQL Editor has schema explorer, snippets, history, dry-run and write confirmation.</p>
            <a href={`/sql?project=${project.ref}`} style={styles.primaryButton}>Open full SQL Editor</a>
          </section>
        ) : null}

        {tab === 'auth' ? (
          <section style={styles.contentOnly}>
            <div style={styles.cardHeader}>
              <div>
                <h2 style={styles.h2}>Auth users</h2>
                <p style={styles.subtle}>Create users, send invites, recovery emails and magic links.</p>
              </div>
              <div style={styles.inline}>
                <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="user@example.com" style={styles.input} />
                <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="password for create" type="password" style={styles.input} />
              </div>
            </div>
            <div style={styles.actions}>
              <button onClick={() => createUser('create')} style={styles.primaryButton}>Create user</button>
              <button onClick={() => createUser('invite')} style={styles.secondaryButton}>Invite</button>
              <button onClick={() => createUser('recover')} style={styles.secondaryButton}>Recover</button>
              <button onClick={() => createUser('magiclink')} style={styles.secondaryButton}>Magic link</button>
            </div>
            <DataTable columns={['id', 'email', 'created_at', 'last_sign_in_at', 'role']} rows={users} />
          </section>
        ) : null}

        {tab === 'storage' ? (
          <section style={styles.workspace}>
            <aside style={styles.panel}>
              <h2 style={styles.panelTitle}>Buckets</h2>
              <div style={styles.inline}>
                <input value={newBucket} onChange={(event) => setNewBucket(event.target.value)} placeholder="bucket-id" style={styles.input} />
                <button onClick={createBucket} style={styles.secondaryButton}>Create</button>
              </div>
              <div style={styles.list}>
                {buckets.map((bucket) => (
                  <button key={bucket.id ?? bucket.name} onClick={() => setBucketId(bucket.id ?? bucket.name)} style={{ ...styles.listItem, ...(bucketId === (bucket.id ?? bucket.name) ? styles.listActive : {}) }}>
                    <strong>{bucket.name ?? bucket.id}</strong>
                    <span>{bucket.public ? 'public' : 'private'}</span>
                  </button>
                ))}
              </div>
            </aside>
            <section style={styles.content}>
              <div style={styles.cardHeader}>
                <div>
                  <h2 style={styles.h2}>Objects · {bucketId || 'select bucket'}</h2>
                  <p style={styles.subtle}>Search objects and generate signed URLs.</p>
                </div>
                <div style={styles.inline}>
                  <input value={objectSearch} onChange={(event) => setObjectSearch(event.target.value)} placeholder="search path" style={styles.input} />
                  <button onClick={loadObjects} style={styles.secondaryButton}>Search</button>
                </div>
              </div>
              <DataTable columns={['name', 'metadata', 'created_at', 'updated_at']} rows={objects} onSelect={(row) => setSignedPath(row.name ?? '')} />
              <div style={styles.inlineWide}>
                <input value={signedPath} onChange={(event) => setSignedPath(event.target.value)} placeholder="path/to/file.png" style={styles.inputGrow} />
                <button onClick={signObject} style={styles.primaryButton}>Generate signed URL</button>
              </div>
              {signedUrl ? <pre style={styles.pre}>{signedUrl}</pre> : null}
            </section>
          </section>
        ) : null}

        {tab === 'ops' ? (
          <section style={styles.contentOnly}>
            <div style={styles.actions}>
              <button onClick={refreshOps} style={styles.secondaryButton}>Refresh ops</button>
              <button onClick={collectLogs} style={styles.secondaryButton}>Collect logs</button>
              <button onClick={() => queueOp(`/api/platform/projects/${project.ref}/backups`, 'Backup queued.')} style={styles.secondaryButton}>Run backup</button>
              <button onClick={() => queueOp(`/api/platform/projects/${project.ref}/pitr/status/collect`, 'PITR status collected.')} style={styles.secondaryButton}>Collect PITR</button>
              <button onClick={() => queueOp(`/api/platform/projects/${project.ref}/restore-drills`, 'Restore drill queued.')} style={styles.secondaryButton}>Run restore drill</button>
            </div>
            <Grid title="Service health" rows={services} />
            <Grid title="Logs" rows={logs} />
            <Grid title="Alerts" rows={alerts} />
            <Grid title="Operations" rows={operations} />
            <Grid title="Backups" rows={backups} />
            <Grid title="PITR" rows={pitr} />
          </section>
        ) : null}

        {tab === 'settings' ? (
          <section style={styles.contentOnly}>
            <h2 style={styles.h2}>Project settings</h2>
            <pre style={styles.pre}>{JSON.stringify(settings ?? project, null, 2)}</pre>
          </section>
        ) : null}
      </section>
    </main>
  )
}

function DataTable({ columns, rows, onSelect, onDelete }: { columns: string[]; rows: any[]; onSelect?: (row: any) => void; onDelete?: (row: any) => void }) {
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {onSelect ? <th style={styles.th}>Action</th> : null}
            {columns.map((column) => <th key={column} style={styles.th}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id ?? index}>
              {onSelect ? (
                <td style={styles.td}>
                  <button onClick={() => onSelect(row)} style={styles.miniButton}>Select</button>
                  {onDelete ? <button onClick={() => onDelete(row)} style={styles.dangerButton}>Delete</button> : null}
                </td>
              ) : null}
              {columns.map((column) => <td key={column} style={styles.td}>{formatCell(row?.[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <div style={styles.placeholder}>No rows yet.</div> : null}
    </div>
  )
}

function EditorBox({ title, value, setValue, action, onAction }: { title: string; value: string; setValue: (value: string) => void; action: string; onAction: () => void }) {
  return (
    <div style={styles.editorBox}>
      <div style={styles.cardHeader}>
        <h3 style={styles.h3}>{title}</h3>
        <button onClick={onAction} style={styles.primaryButton}>{action}</button>
      </div>
      <textarea value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} style={styles.textarea} />
    </div>
  )
}

function Grid({ title, rows }: { title: string; rows: any[] }) {
  const columns = rows[0] ? Object.keys(rows[0]).slice(0, 6) : []
  return (
    <section style={styles.gridCard}>
      <h2 style={styles.h2}>{title}</h2>
      <DataTable columns={columns} rows={rows} />
    </section>
  )
}

function normalizeUsers(payload: any) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.users)) return payload.users
  return []
}

function normalizeBuckets(payload: any) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.buckets)) return payload.buckets
  return []
}

function parseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Invalid JSON.')
  }
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function label(tab: Tab) {
  return ({ tables: 'Table', sql: 'SQL', auth: 'Auth', storage: 'Storage', ops: 'Ops', settings: 'Settings' })[tab]
}

const mono = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
const sans = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

const styles: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100vh', display: 'grid', gridTemplateColumns: '86px minmax(0, 1fr)', color: '#d4d4d8', background: '#050505', fontFamily: sans },
  rail: { position: 'sticky', top: 0, height: '100vh', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', padding: 16, background: '#09090b', borderRight: '1px solid #27272a' },
  logo: { display: 'grid', placeItems: 'center', width: 42, height: 42, borderRadius: 12, color: '#052e16', background: '#3ecf8e', fontWeight: 950, textDecoration: 'none' },
  navItem: { width: '100%', border: 0, borderRadius: 10, padding: '11px 0', color: '#a1a1aa', background: 'transparent', fontSize: 12, cursor: 'pointer' },
  navActive: { color: '#f4f4f5', background: '#18181b', boxShadow: 'inset 0 0 0 1px #27272a' },
  main: { minWidth: 0, padding: 20 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 14 },
  headerActions: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' },
  kicker: { margin: 0, color: '#3ecf8e', letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 11, fontWeight: 850 },
  title: { margin: '4px 0', color: '#f4f4f5', fontSize: 30, letterSpacing: '-0.04em' },
  subtle: { margin: 0, color: '#a1a1aa', fontSize: 13 },
  banner: { margin: '0 0 14px', padding: 12, borderRadius: 10, color: '#bbf7d0', background: 'rgba(22, 101, 52, 0.22)', border: '1px solid rgba(74, 222, 128, 0.22)' },
  errorBanner: { margin: '0 0 14px', padding: 12, borderRadius: 10, color: '#fecaca', background: 'rgba(127, 29, 29, 0.28)', border: '1px solid rgba(248, 113, 113, 0.24)' },
  workspace: { display: 'grid', gridTemplateColumns: '290px minmax(0, 1fr)', gap: 14, alignItems: 'start' },
  panel: { position: 'sticky', top: 20, display: 'grid', gap: 12, maxHeight: 'calc(100vh - 40px)', overflow: 'auto', padding: 14, borderRadius: 12, background: '#09090b', border: '1px solid #27272a' },
  content: { minWidth: 0, display: 'grid', gap: 14, padding: 14, borderRadius: 12, background: '#09090b', border: '1px solid #27272a' },
  contentOnly: { display: 'grid', gap: 14, padding: 16, borderRadius: 12, background: '#09090b', border: '1px solid #27272a' },
  panelTitle: { margin: 0, color: '#f4f4f5', fontSize: 18 },
  h2: { margin: 0, color: '#f4f4f5', fontSize: 22, letterSpacing: '-0.03em' },
  h3: { margin: 0, color: '#f4f4f5', fontSize: 16 },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 },
  list: { display: 'grid', gap: 8 },
  listItem: { display: 'grid', gap: 4, border: '1px solid #27272a', borderRadius: 10, padding: 11, color: '#d4d4d8', background: '#111113', textAlign: 'left', cursor: 'pointer' },
  listActive: { borderColor: '#3ecf8e', boxShadow: '0 0 0 1px rgba(62, 207, 142, 0.35)' },
  inline: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  inlineWide: { display: 'flex', gap: 8, alignItems: 'center' },
  input: { minWidth: 180, borderRadius: 8, padding: '10px 11px', color: '#e5e7eb', background: '#050505', border: '1px solid #27272a' },
  inputGrow: { flex: 1, minWidth: 220, borderRadius: 8, padding: '10px 11px', color: '#e5e7eb', background: '#050505', border: '1px solid #27272a' },
  actions: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  primaryButton: { border: 0, borderRadius: 8, padding: '10px 13px', color: '#052e16', background: '#3ecf8e', fontWeight: 900, textDecoration: 'none', cursor: 'pointer' },
  secondaryButton: { border: '1px solid #3f3f46', borderRadius: 8, padding: '10px 13px', color: '#e5e7eb', background: '#18181b', fontWeight: 800, cursor: 'pointer' },
  linkButton: { border: '1px solid #3f3f46', borderRadius: 8, padding: '10px 13px', color: '#e5e7eb', background: '#18181b', fontWeight: 800, textDecoration: 'none' },
  miniButton: { marginRight: 6, border: '1px solid #3f3f46', borderRadius: 7, padding: '6px 8px', color: '#e5e7eb', background: '#18181b', cursor: 'pointer' },
  dangerButton: { border: '1px solid rgba(248, 113, 113, 0.35)', borderRadius: 7, padding: '6px 8px', color: '#fecaca', background: 'rgba(127, 29, 29, 0.25)', cursor: 'pointer' },
  tableWrap: { overflow: 'auto', borderRadius: 10, border: '1px solid #27272a', background: '#050505' },
  table: { width: '100%', borderCollapse: 'collapse', fontFamily: mono, fontSize: 12 },
  th: { position: 'sticky', top: 0, zIndex: 1, padding: 10, color: '#3ecf8e', background: '#18181b', borderBottom: '1px solid #27272a', textAlign: 'left' },
  td: { maxWidth: 420, padding: 10, color: '#d4d4d8', borderBottom: '1px solid #18181b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  placeholder: { display: 'grid', placeItems: 'center', minHeight: 120, color: '#71717a' },
  dual: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 },
  editorBox: { display: 'grid', gap: 10, padding: 12, borderRadius: 10, background: '#111113', border: '1px solid #27272a' },
  textarea: { width: '100%', minHeight: 190, boxSizing: 'border-box', resize: 'vertical', border: '1px solid #27272a', borderRadius: 8, padding: 12, color: '#e5e7eb', background: '#050505', fontFamily: mono, fontSize: 13, lineHeight: 1.55 },
  pre: { margin: 0, padding: 14, borderRadius: 10, overflow: 'auto', color: '#d4d4d8', background: '#050505', border: '1px solid #27272a', fontFamily: mono, fontSize: 12 },
  gridCard: { display: 'grid', gap: 10, padding: 12, borderRadius: 10, background: '#111113', border: '1px solid #27272a' },
}
