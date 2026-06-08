# WhatsClear MVP

WhatsClear MVP ingests email text and digital PDF attachments, classifies shipment status updates, and writes structured shipment tracking output for a shared spreadsheet workflow.

## What this implementation covers

- Email payload ingestion from JSON (Gmail-ready shape).
- Digital PDF processing (text-based PDFs only) with mandatory field extraction.
- Shipment match/create logic without auto-generating Shipment #.
- Status lifecycle validation with illegal transition flagging.
- Export/import cross-border handoff logic.
- Manual verification flags for required PRD scenarios.
- SQLite storage with:
  - `shipments`
  - `messages`
  - `attachments`
  - `vocabulary_mapping`
  - `audit_log`
- Master sheet output sync to local TSV (`master_sheet.tsv`) and optional Google Sheets adapter.

## Quick start

```bash
python -m venv .venv
. .venv/Scripts/activate
pip install -e .[dev]
```

## Collaborator setup

Give the collaborator access to this GitHub repository:

```text
https://github.com/mascorro53-svg/Whastclear.git
```

Then they can clone and prepare the project:

```bash
git clone https://github.com/mascorro53-svg/Whastclear.git
cd Whastclear
python -m venv .venv
. .venv/Scripts/activate
pip install -e .[dev]
python -m pytest -q
```

Run the web UI locally:

```bash
whatsclear-web --host 127.0.0.1 --port 8000 --db-path whatsclear.db
```

Open `http://127.0.0.1:8000`.

Local files such as `.env`, `*.db`, Google credential files, generated sheets, attachments, and temporary smoke-test outputs are intentionally ignored by Git. Share any real credentials separately and only with people who should have access.

## Supabase / shared database setup

WhatsClear uses SQLite by default, but it can use a shared Supabase Postgres database when `WHATSCLEAR_DATABASE_URL` is configured.

Install with Postgres support:

```bash
pip install -e .[dev,postgres]
```

In Supabase, create a project, open the SQL Editor, and run:

```text
docs/supabase_schema.sql
```

Then set the database URL in PowerShell before starting the app:

```powershell
$env:WHATSCLEAR_DATABASE_URL = "postgresql://postgres:<password>@<supabase-host>:5432/postgres"
python -m whatsclear.web_cli --host 127.0.0.1 --port 8000
```

For another developer, they should use the same Supabase database URL in their own environment. Do not commit the real URL/password to Git.

Create `sample_email.json`:

```json
[
  {
    "message_id": "msg-1001",
    "thread_id": "thr-2001",
    "subject": "Pickup scheduled MX to US",
    "body": "Shipment requested. Pickup scheduled. MX to US lane.",
    "timestamp": "2026-02-20T09:00:00",
    "attachments": []
  }
]
```

Run ingestion:

```bash
whatsclear ingest --email-json sample_email.json
```

Poll Gmail directly (optional):

```bash
whatsclear ingest-gmail --max-results 20 --query "newer_than:2d has:attachment"
```

Inspect shipments:

```bash
whatsclear list-shipments
```

Manual override:

```bash
whatsclear override --shipment-id 1 --field status --value "Pickup Completed"
```

Generate customer view:

```bash
whatsclear customer-view --output customer_view.tsv
```

KPI snapshot:

```bash
whatsclear kpi
```

Add custom vocabulary:

```bash
whatsclear vocab-add --phrase "en aduana" --mapped-status "Export Cleared"
```

## Google Sheets adapter (optional)

Install:

```bash
pip install -e .[google]
```

Then create a `GoogleSheetSync` instance in code with spreadsheet ID and provide `service_account.json`.
For Gmail polling, install the same optional dependencies and use local/default Google credentials.

## Web UI quick start (MVP scaffold)

Install dependencies (includes FastAPI + Uvicorn):

```bash
pip install -e .[dev]
```

Run the web server:

```bash
whatsclear-web --host 127.0.0.1 --port 8000 --db-path whatsclear.db
```

Open:

```text
http://127.0.0.1:8000
```

Demo logins:

- Operations: `ops@whatsclear.local` / `ops123`
- Admin: `admin@whatsclear.local` / `admin123`

The web scaffold implements PRD-aligned MVP endpoints and UI flows for:

- login
- KPI dashboard cards
- shipments list + search/manual filter
- shipment detail edit + manual override (reason required)
- verification queue + resolve
- CSV export (respects current filters)
- admin vocabulary + intake channel setup
- active channel sync via API and background polling

For Gmail mailbox ingestion in the UI, two paths are now available:

- `provider_type=gmail`: uses local Google credentials and Gmail API polling
- `provider_type=imap`: works with mailbox credentials such as `whatsclear.ops@gmail.com` plus a Gmail app password, typically against `imap.gmail.com` and folder `INBOX`

Manual sync endpoint examples:

```bash
curl -X POST http://127.0.0.1:8000/intake/sync -H "Authorization: Bearer <admin-token>"
curl -X POST http://127.0.0.1:8000/intake/channels/1/sync -H "Authorization: Bearer <admin-token>"
```

## PRD alignment notes

- Shipment # is never auto-generated; missing values trigger manual verification.
- Non-digital PDFs are flagged.
- Low-confidence classification (`0.5`-`0.8`) is flagged.
- Illegal lifecycle transitions are flagged.
- Extracted-field conflicts are flagged.
- Manual verification is represented by `manual_verification_required` and sheet column `Manual Verification` (`TRUE/FALSE`), which can be used for yellow formatting (`#FFF2CC`).
