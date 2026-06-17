#!/usr/bin/env node
// SupaNow P1 ops runner: executes due per-project operational jobs.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'

const execFileAsync = promisify(execFile)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const cwdRoot = path.resolve(process.cwd())
const parentRoot = path.resolve(process.cwd(), '../..')
const root = process.env.SUPANOW_REPO_ROOT
  ?? (fs.existsSync(path.join(cwdRoot, 'infra/scripts')) ? cwdRoot : parentRoot)
const scriptsDir = path.join(root, 'infra/scripts')
const maxJobs = Number.parseInt(process.env.SUPANOW_OPS_MAX_JOBS ?? '25', 10)

function json(value) {
  return JSON.stringify(value ?? {})
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) })
  const data = await res.json().catch(() => null)
  if (!res.ok && res.status !== 401 && res.status !== 403) {
    throw new Error(`${url} failed with ${res.status}: ${JSON.stringify(data)}`)
  }
  return { status: res.status, data }
}

async function pgMetaQuery(project, query) {
  const { data } = await fetchJson(`${project.site_url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: project.service_role_key,
      Authorization: `Bearer ${project.service_role_key}`,
      'Content-Type': 'application/json',
      'x-pg-application-name': 'supanow-ops-runner',
    },
    body: JSON.stringify({ query, disable_statement_timeout: true }),
  })
  return data
}

async function recordRun(schedule, status, summary, log = '', error = null) {
  await pool.query(
    `INSERT INTO project_operation_runs(project_id, job_type, status, summary, log, error, completed_at)
     VALUES($1, $2, $3, $4, $5, $6, NOW())`,
    [schedule.project_id, schedule.job_type, status, json(summary), log.slice(-50000), error]
  )
}

async function sendAlert(project, severity, eventType, title, message, payload = {}) {
  const deliveryTarget = process.env.ALERT_WEBHOOK_URL ? 'webhook' : null
  let delivery = { status: process.env.ALERT_WEBHOOK_URL ? 'queued' : 'suppressed' }
  if (process.env.ALERT_WEBHOOK_URL) {
    try {
      const { stdout } = await execFileAsync(path.join(scriptsDir, 'send-alert.sh'), [], {
        env: {
          ...process.env,
          SEVERITY: severity,
          EVENT_TYPE: eventType,
          TITLE: title,
          MESSAGE: message,
          PROJECT_REF: project?.ref ?? '',
          PAYLOAD: json(payload),
        },
        maxBuffer: 1024 * 1024,
      })
      delivery = JSON.parse(stdout)
    } catch (err) {
      delivery = err.stdout ? JSON.parse(err.stdout) : { status: 'failed', error: err.message }
    }
  }
  await pool.query(
    `INSERT INTO project_alert_events
       (project_id, severity, event_type, title, message, delivery_status, delivery_target, error, metadata, delivered_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $6='sent' THEN NOW() ELSE NULL END)`,
    [
      project?.id ?? null,
      severity,
      eventType,
      title,
      message,
      delivery.status ?? 'failed',
      deliveryTarget,
      delivery.error ?? null,
      json({ payload, delivery }),
    ]
  )
  return delivery
}

async function runServiceHealth(project) {
  const headers = { apikey: project.service_role_key, Authorization: `Bearer ${project.service_role_key}` }
  const probes = [
    ['postgrest', `${project.site_url}/rest/v1/`, { apikey: project.service_role_key }],
    ['auth', `${project.site_url}/auth/v1/health`, {}],
    ['storage', `${project.site_url}/storage/v1/status`, headers],
    ['realtime', `${project.site_url}/realtime/v1/`, headers],
    ['pg-meta', `${project.site_url}/pg/health`, headers],
    ['functions', `${project.site_url}/functions/v1/`, headers],
  ]
  const results = []
  for (const [service, url, probeHeaders] of probes) {
    const started = Date.now()
    try {
      const res = await fetch(url, { headers: probeHeaders, signal: AbortSignal.timeout(5000) })
      results.push({
        service,
        status: res.ok || res.status === 401 || res.status === 403 ? 'healthy' : 'unhealthy',
        latency_ms: Date.now() - started,
        detail: { http_status: res.status },
      })
    } catch (err) {
      results.push({
        service,
        status: 'unhealthy',
        latency_ms: Date.now() - started,
        detail: { error: err.message },
      })
    }
  }
  for (const result of results) {
    await pool.query(
      `INSERT INTO project_service_health(project_id, service, status, latency_ms, detail)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT(project_id, service) DO UPDATE SET
         status=EXCLUDED.status,
         latency_ms=EXCLUDED.latency_ms,
         detail=EXCLUDED.detail,
         checked_at=NOW()`,
      [project.id, result.service, result.status, result.latency_ms, json(result.detail)]
    )
  }
  return { services: results }
}

async function runUsageCollect(project) {
  const rows = await pgMetaQuery(project, `
    select
      pg_database_size(current_database()) / 1024.0 / 1024.0 as db_size_mb,
      coalesce((select count(*) from auth.users where created_at > now() - interval '30 days'), 0) as auth_mau,
      coalesce((select sum((metadata->>'size')::numeric) / 1024.0 / 1024.0 from storage.objects), 0) as storage_mb`)
  const metrics = rows?.[0] ?? {}
  const saved = await pool.query(
    `INSERT INTO usage_metrics(project_id, metric_date, db_size_mb, auth_mau, storage_mb)
     VALUES($1, CURRENT_DATE, $2, $3, $4)
     ON CONFLICT(project_id, metric_date) DO UPDATE SET
       db_size_mb=EXCLUDED.db_size_mb,
       auth_mau=EXCLUDED.auth_mau,
       storage_mb=EXCLUDED.storage_mb,
       created_at=NOW()
     RETURNING metric_date, db_size_mb, auth_mau, storage_mb`,
    [project.id, metrics.db_size_mb ?? 0, metrics.auth_mau ?? 0, metrics.storage_mb ?? 0]
  )
  return saved.rows[0]
}

async function runAdvisor(project) {
  const { data } = await fetchJson(`${project.site_url}/pg/advisors`, {
    headers: {
      apikey: project.service_role_key,
      Authorization: `Bearer ${project.service_role_key}`,
    },
  })
  const findings = Array.isArray(data) ? data : []
  const summary = findings.reduce((acc, item) => {
    const level = item.level ?? item.severity ?? item.type ?? 'info'
    acc.count_by_level[level] = (acc.count_by_level[level] ?? 0) + 1
    acc.total += 1
    return acc
  }, { total: 0, count_by_level: {} })
  await pool.query(
    `INSERT INTO advisor_runs(project_id, status, findings, summary, source)
     VALUES($1, 'completed', $2, $3, 'ops-runner')`,
    [project.id, json(findings), json(summary)]
  )
  return summary
}

async function runLogCollect(project, config) {
  const sinceMinutes = String(config?.since_minutes ?? 20)
  const { stdout } = await execFileAsync(
    path.join(scriptsDir, 'collect-logs.sh'),
    [project.ref, sinceMinutes],
    { maxBuffer: 1024 * 1024 * 8 }
  )
  const entries = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO project_log_entries(project_id, service, level, message, metadata, fingerprint, occurred_at)
       VALUES($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(project_id, fingerprint) DO NOTHING`,
      [
        project.id,
        entry.service,
        entry.level,
        entry.message,
        json(entry.metadata),
        entry.fingerprint,
        entry.occurred_at,
      ]
    )
  }
  return { collected: entries.length }
}

async function runRealtimeMetrics(project) {
  const settingsRes = await pool.query('SELECT * FROM realtime_settings WHERE project_id=$1', [project.id])
  const settings = settingsRes.rows[0] ?? {
    presence_enabled: true,
    broadcast_enabled: true,
    postgres_changes_enabled: true,
  }
  const rows = await pgMetaQuery(project, "select count(*)::int as cdc_tables from pg_publication_tables where pubname='supabase_realtime'")
  const health = await runServiceHealth(project)
  const saved = await pool.query(
    `INSERT INTO realtime_metrics
       (project_id, metric_date, cdc_tables, active_channels, presence_enabled,
        broadcast_enabled, postgres_changes_enabled, health)
     VALUES($1, CURRENT_DATE, $2, 0, $3, $4, $5, $6)
     ON CONFLICT(project_id, metric_date) DO UPDATE SET
       cdc_tables=EXCLUDED.cdc_tables,
       presence_enabled=EXCLUDED.presence_enabled,
       broadcast_enabled=EXCLUDED.broadcast_enabled,
       postgres_changes_enabled=EXCLUDED.postgres_changes_enabled,
       health=EXCLUDED.health,
       created_at=NOW()
     RETURNING metric_date, cdc_tables, presence_enabled, broadcast_enabled, postgres_changes_enabled`,
    [
      project.id,
      rows?.[0]?.cdc_tables ?? 0,
      settings.presence_enabled,
      settings.broadcast_enabled,
      settings.postgres_changes_enabled,
      json(health),
    ]
  )
  return saved.rows[0]
}

async function runBackupVerify(project, config) {
  const args = [project.ref]
  if (config?.backup_key) args.push(config.backup_key)
  let result
  try {
    const { stdout } = await execFileAsync(
      path.join(scriptsDir, 'verify-backup.sh'),
      args,
      { maxBuffer: 1024 * 1024 }
    )
    result = JSON.parse(stdout)
  } catch (err) {
    result = err.stdout ? JSON.parse(err.stdout) : {
      status: 'failed',
      backup_key: config?.backup_key ?? null,
      error: err.message,
    }
  }
  await pool.query(
    `INSERT INTO project_backup_verifications(project_id, backup_key, status, size_bytes, error, metadata)
     VALUES($1, $2, $3, $4, $5, $6)`,
    [
      project.id,
      result.backup_key ?? config?.backup_key ?? null,
      result.status,
      result.size_bytes ?? null,
      result.error ?? null,
      json(result),
    ]
  )
  if (result.backup_key) {
    await pool.query(
      `UPDATE project_backups
       SET verified_at=NOW(),
           verification_status=$3,
           verification_error=$4,
           size_bytes=COALESCE(size_bytes, $5),
           metadata=metadata || $6::jsonb
       WHERE project_id=$1 AND backup_key=$2`,
      [
        project.id,
        result.backup_key,
        result.status === 'verified' ? 'verified' : 'failed',
        result.error ?? null,
        result.size_bytes ?? null,
        json({ last_verification: result }),
      ]
    )
  }
  if (result.status !== 'verified') {
    throw new Error(result.error ?? 'backup verification failed')
  }
  return result
}

async function runPitrStatus(project) {
  const { stdout } = await execFileAsync(
    path.join(scriptsDir, 'pitr-status.sh'),
    [project.ref],
    { maxBuffer: 1024 * 1024 }
  )
  const result = JSON.parse(stdout)
  await pool.query(
    `INSERT INTO project_pitr_status
       (project_id, status, wal_level, archive_mode, archive_command,
        archived_wal_count, latest_wal, archiver_failed_count,
        last_archived_wal, last_archived_at, last_failed_wal, last_failed_at,
        error, metadata)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      project.id,
      result.status,
      result.wal_level ?? null,
      result.archive_mode ?? null,
      result.archive_command ?? null,
      result.archived_wal_count ?? 0,
      result.latest_wal ?? null,
      result.archiver_failed_count ?? 0,
      result.last_archived_wal ?? null,
      result.last_archived_at ?? null,
      result.last_failed_wal ?? null,
      result.last_failed_at ?? null,
      result.error ?? null,
      json(result),
    ]
  )
  if (result.status !== 'enabled') {
    await sendAlert(
      project,
      'warning',
      'pitr.not_enabled',
      `PITR is not enabled for ${project.ref}`,
      result.error ?? `PITR status is ${result.status}`,
      result
    )
  }
  return result
}

async function runRestoreDrill(project, config) {
  const args = [project.ref]
  if (config?.backup_key) args.push(config.backup_key)
  let result
  try {
    const { stdout } = await execFileAsync(
      path.join(scriptsDir, 'restore-drill.sh'),
      args,
      { maxBuffer: 1024 * 1024 * 8 }
    )
    result = JSON.parse(stdout)
  } catch (err) {
    result = err.stdout ? JSON.parse(err.stdout) : {
      status: 'failed',
      backup_key: config?.backup_key ?? null,
      error: err.message,
    }
  }
  await pool.query(
    `INSERT INTO project_restore_drills
       (project_id, backup_key, status, duration_ms, temp_database, error, metadata)
     VALUES($1, $2, $3, $4, $5, $6, $7)`,
    [
      project.id,
      result.backup_key ?? config?.backup_key ?? null,
      result.status,
      result.duration_ms ?? null,
      result.temp_database ?? null,
      result.error ?? null,
      json(result),
    ]
  )
  if (result.status !== 'verified') {
    await sendAlert(
      project,
      'critical',
      'restore_drill.failed',
      `Restore drill failed for ${project.ref}`,
      result.error ?? 'Restore drill failed',
      result
    )
    throw new Error(result.error ?? 'restore drill failed')
  }
  return result
}

async function ensureSchedules() {
  await pool.query(`
    INSERT INTO project_job_schedules(project_id, job_type, interval_minutes, config)
    SELECT id, job_type, interval_minutes, config
    FROM projects
    CROSS JOIN (
      VALUES
        ('service_health', 5, '{}'::jsonb),
        ('usage_collect', 60, '{}'::jsonb),
        ('advisor_run', 1440, '{}'::jsonb),
        ('log_collect', 15, jsonb_build_object('since_minutes', 20)),
        ('realtime_metrics', 60, '{}'::jsonb),
        ('backup_verify', 1440, '{}'::jsonb),
        ('pitr_status', 1440, '{}'::jsonb),
        ('restore_drill', 10080, '{}'::jsonb)
    ) defaults(job_type, interval_minutes, config)
    WHERE status='active'
    ON CONFLICT(project_id, job_type) DO NOTHING`)
}

async function main() {
  await ensureSchedules()
  const due = await pool.query(
    `SELECT s.*, p.ref, p.site_url, p.service_role_key
     FROM project_job_schedules s
     JOIN projects p ON p.id=s.project_id
     WHERE s.enabled=true
       AND s.next_run_at <= NOW()
       AND p.status='active'
     ORDER BY s.next_run_at ASC
     LIMIT $1`,
    [maxJobs]
  )

  for (const schedule of due.rows) {
    const project = {
      id: schedule.project_id,
      ref: schedule.ref,
      site_url: schedule.site_url,
      service_role_key: schedule.service_role_key,
    }
    try {
      let summary
      if (schedule.job_type === 'service_health') summary = await runServiceHealth(project)
      else if (schedule.job_type === 'usage_collect') summary = await runUsageCollect(project)
      else if (schedule.job_type === 'advisor_run') summary = await runAdvisor(project)
      else if (schedule.job_type === 'log_collect') summary = await runLogCollect(project, schedule.config)
      else if (schedule.job_type === 'realtime_metrics') summary = await runRealtimeMetrics(project)
      else if (schedule.job_type === 'backup_verify') summary = await runBackupVerify(project, schedule.config)
      else if (schedule.job_type === 'pitr_status') summary = await runPitrStatus(project)
      else if (schedule.job_type === 'restore_drill') summary = await runRestoreDrill(project, schedule.config)
      else summary = { skipped: true, reason: 'unknown job type' }

      await recordRun(schedule, 'completed', summary)
      await pool.query(
        `UPDATE project_job_schedules
         SET last_run_at=NOW(),
             next_run_at=NOW() + (interval_minutes || ' minutes')::interval
         WHERE id=$1`,
        [schedule.id]
      )
      console.log(`ok ${schedule.ref} ${schedule.job_type}`)
    } catch (err) {
      await recordRun(schedule, 'failed', {}, '', err.message)
      await sendAlert(
        project,
        'critical',
        `job.${schedule.job_type}.failed`,
        `SupaNow job failed: ${schedule.job_type}`,
        err.message,
        { job_type: schedule.job_type, project_ref: schedule.ref }
      ).catch(() => {})
      await pool.query(
        `UPDATE project_job_schedules
         SET last_run_at=NOW(),
             next_run_at=NOW() + (least(interval_minutes, 15) || ' minutes')::interval
         WHERE id=$1`,
        [schedule.id]
      )
      console.error(`failed ${schedule.ref} ${schedule.job_type}: ${err.message}`)
    }
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
