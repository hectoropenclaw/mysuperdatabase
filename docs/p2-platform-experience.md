# SupaNow P2 Platform Experience

P2 turns the platform from "services are running" into "operators can inspect and debug projects safely".

## Control-plane tables

- `sql_query_history`: audited SQL editor executions, including blocked writes.
- `sql_snippets`: reusable project SQL snippets.
- `auth_email_test_events`: email template previews and test-send events.
- `realtime_debug_sessions`: persistent realtime troubleshooting sessions.

## API surface

SQL editor:

- `POST /api/platform/sql/:ref/query`
- `GET /api/platform/sql/:ref/history`
- `GET /api/platform/sql/:ref/snippets`
- `POST /api/platform/sql/:ref/snippets`
- `PATCH /api/platform/sql/:ref/snippets/:id`
- `DELETE /api/platform/sql/:ref/snippets/:id`

Auth template UX:

- `POST /api/platform/auth/:ref/templates/:template/preview`
- `POST /api/platform/auth/:ref/templates/:template/test`
- `GET /api/platform/auth/:ref/templates/:template/tests`

Storage browser UX:

- `GET /api/platform/storage/:ref/buckets/:id/objects/search`
- `GET /api/platform/storage/:ref/buckets/:id/objects/info?path=...`
- `POST /api/platform/storage/:ref/buckets/:id/objects/copy`

Realtime debugging:

- `GET /api/platform/realtime/:ref/client-config`
- `GET /api/platform/realtime/:ref/debug-sessions`
- `POST /api/platform/realtime/:ref/debug-sessions`

## Safety rules

- SQL write statements are blocked unless the caller sends `confirm_write=true` or `dry_run=true`.
- `EXPLAIN` is limited to read queries.
- Auth test emails are recorded as events; actual delivery still depends on the tenant GoTrue SMTP configuration.
- Realtime client config exposes the project `anon_key`, never the `service_role_key`.

## Verification

Run the standard tenant smoke:

```sh
infra/scripts/e2e-tenant-smoke.sh whatsclear
```

Run the P2-specific smoke:

```sh
infra/scripts/e2e-p2-platform.sh whatsclear
```

If the tenant Docker stack exists but the control-plane DB has no `projects` row for it, the P2 smoke validates the schema and reports the missing metadata prerequisite. Provision or import the tenant into the control plane, then re-run the smoke to exercise the full P2 path.
