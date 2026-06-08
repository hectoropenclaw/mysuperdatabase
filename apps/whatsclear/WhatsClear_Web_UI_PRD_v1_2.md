# WhatsClear - Web UI Product Requirements Document (PRD)
## Version: v1.2 (Engine-Frozen, UI-Only Evolution)
## Date: February 26, 2026

---

## 1. Purpose

This document defines WhatsClear web interface requirements while keeping the engine defined in `WhatsClear_MVP_PRD_v1_1.md` unchanged.

Scope rule for this version:
- Engine behavior remains fixed (ingestion, parsing, lifecycle, handoff, verification logic).
- Changes are limited to UI experience, workflow, and API surface needed by the UI.

---

## 2. Engine Baseline (Locked)

The following are explicitly inherited and must not be changed by this PRD:

- Email + digital PDF ingestion model
- Digital PDF-only extraction rule
- Manual shipment number requirement (never system-generated)
- Status lifecycle engine and illegal transition flagging
- Export/import handoff logic
- Manual verification rules and yellow highlighting intent
- Google Sheet synchronization intent
- Core data model from MVP PRD

Reference source: `WhatsClear_MVP_PRD_v1_1.md`.

---

## 3. User Roles

### 3.1 Operations User
- View shipment list and shipment details.
- Update allowed fields (status, carrier, dates, comments).
- Resolve manual verification items.
- Use search/filters to find shipments quickly.
- Download shipment list results.

### 3.2 Admin
- Includes all Operations permissions.
- Manage users and role assignment.
- Manage vocabulary mappings for status classification.
- Review audit logs and KPI dashboard.
- Configure and monitor email intake connections.

---

## 4. MVP Scope (UI)

### Included
- Login
- Operations dashboard
- Shipment list (table view)
- Shipment list download (CSV)
- Shipment detail
- Manual verification queue
- Admin dashboard
- Vocabulary mapping
- Audit log viewer
- Settings page
- Email intake configuration page (multi-provider, multi-domain)
- Real-time sync status and controls (with fallback)

### Excluded
- Mobile app
- OCR workflow UI
- Advanced forecasting
- Billing UI

---

## 5. Navigation

Menu:
1. Dashboard
2. Shipments
3. Verification Queue
4. Admin (admin-only)
5. Settings (admin-only)
6. Email Intake (admin-only)

---

## 6. Screen Requirements

### 6.1 Login
- Email + password
- Forgot password
- Error state on failed login

### 6.2 Operations Dashboard
- KPI cards:
  - Active shipments
  - Blocked shipments
  - Manual verification required
  - Delivered today
  - Average transit time (days)
- My shipments list
- Recent updates feed

KPI definition:
- Average transit time (days) = average of (`delivery_date - pickup_date`) for shipments with both dates present.
- Default calculation window: last 30 days by `delivery_date`.
- Show value to 1 decimal place.

### 6.3 Shipments List
Columns:
- Shipment #
- Customer
- Lane
- Invoice #
- BOL #
- MX Carrier
- US Carrier
- Status
- Blocked Reason
- Owner
- Last Update
- Manual Verification

Behavior:
- Global search by Shipment #, invoice, BOL, shipper, consignee.
- Filters by status, lane, owner, blocked, manual verification.
- Default sort by Last Update descending.
- Pagination.
- Click row to open details.
- Yellow highlight (`#FFF2CC`) for fields requiring verification.
- Download button to export shipment list as CSV.
- Export must respect current filters, search, and sort order.

### 6.4 Shipment Detail
Sections:
- Header: Shipment #, status, lane, owner
- Parties: customer, shipper, consignee
- Docs: invoice/BOL/PO and attachment list
- Timeline: status history
- Dates: pickup/cross/delivery and appointments
- Comments and activity

Actions:
- Edit allowed fields
- Manual override with required reason
- Resolve verification item
- Save

Rules:
- Shipment # is manual only (never system-generated).
- Illegal status transition must show warning and require reason.

### 6.5 Verification Queue
Columns:
- Shipment #
- Flag type
- Field
- Current value
- Suggested value
- Detected at
- Owner

Actions:
- Accept suggested value
- Keep current value
- Add note
- Mark resolved

### 6.6 Admin Dashboard
KPIs:
- Auto-created shipment ratio
- Classification confidence ratio
- Manual verification ratio
- Messages processed
- Non-digital PDF detections

Charts:
- Status distribution
- Lane split (MX->US / US->MX)
- Daily volume

### 6.7 Vocabulary Mapping (Admin)
- Table: phrase, language, mapped status, active
- Add/edit/deactivate
- Validation: mapped status must be canonical status list

### 6.8 Audit Log (Admin)
Columns:
- Timestamp
- Shipment #
- Field
- Old value
- New value
- Actor

Features:
- Filter by shipment, actor, date range, field
- Export CSV

### 6.9 Settings (Admin)
- Google Sheets config
- Default owner rules
- Classification confidence thresholds
- Sync mode and fallback settings
- General system settings

### 6.10 Email Intake (Admin)
- Create/edit intake channels
- Test connection button
- Enable/disable channel
- View sync mode (real-time or polling fallback)
- View last successful sync time
- View intake errors and retry

---

## 7. Email Intake Specifications (Required, Preserved)

This section is mandatory and unchanged in intent from v1.0.

### 7.1 Objective
- Receive shipment emails from external customers regardless of domain (`@gmail.com`, `@outlook.com`, corporate domains, etc.).
- Do not require customers to be on Google Workspace.
- Process inbound updates in real time where provider capabilities allow.

### 7.2 Supported Intake Methods (MVP)
Admin can configure one or more methods:
1. Shared mailbox via IMAP (polling and/or IMAP IDLE when supported)
2. Gmail API connection (watch/push notifications)
3. Microsoft Graph mailbox connection (subscription/webhook notifications)

The system must normalize all methods into one internal message format.

Real-time requirement:
- Prefer provider push mechanisms for near real-time processing.
- If push is unavailable or unhealthy, auto-fallback to polling without interrupting operations workflow.

### 7.3 Mailbox Strategy
- Recommended: one dedicated inbound mailbox (example: `ops@whatsclear.com`).
- Optional: multiple inboxes per customer/region.
- Each inbox channel has:
  - Channel name
  - Provider type
  - Authentication data
  - Sync mode (`realtime`, `polling`, or `auto`)
  - Polling interval (used for polling mode or fallback)
  - Folder/label to read
  - Active/inactive status

### 7.4 Sender and Domain Handling
- Accept senders from any domain by default.
- Optional allowlist mode:
  - Allowed sender emails
  - Allowed domains
- Optional blocklist mode:
  - Blocked sender emails
  - Blocked domains
- Unknown/untrusted sender behavior:
  - Process message
  - Flag shipment/message for manual review

### 7.5 Required Email Content Contract
Expected:
- Subject with shipment context when available
- Body text with operational update
- PDF attachments for invoice/BOL/packing docs (digital PDF preferred)

Allowed:
- Missing shipment number (system will create row and require manual entry)
- Missing attachments (message still ingested)

Invalid:
- Corrupt attachments
- Unsupported file types when marked as critical docs

Invalid/partial inputs must create verification flags, not silent failures.

### 7.6 Duplicate Detection
- Duplicate key should use provider message ID + thread/conversation ID.
- If same message is received twice:
  - Do not create duplicate shipment or duplicate status event.
  - Log dedupe event in audit/intake log.

### 7.7 Intake Error Handling
For each failed message, store:
- Channel
- Timestamp
- Provider message ID
- Error type
- Error details
- Retry status

UI requirements:
- Admin can see error list.
- Admin can retry failed message.
- Admin can mark error as ignored with reason.

### 7.8 Security and Compliance (MVP Level)
- Store credentials securely (encrypted at rest).
- Role-based access: only admin can view/edit intake credentials.
- Log all channel config changes in audit log.
- TLS required for provider connections.

### 7.9 Admin Setup Flow (Non-Technical)
In UI, admin should complete setup in this order:
1. Go to Email Intake.
2. Click New Channel.
3. Choose provider type (IMAP, Gmail, Microsoft 365).
4. Enter mailbox credentials/OAuth.
5. Select folder/label.
6. Choose sync mode (`auto` recommended).
7. Set polling interval (fallback).
8. Add optional sender/domain rules.
9. Click Test Connection.
10. Click Activate.
11. Verify first sync in channel status.

---

## 8. UX Rules

- `manual_verification_required = true` must appear as yellow highlight (`#FFF2CC`).
- Never overwrite manual edits silently.
- Manual override requires reason and writes audit log.
- Errors must be plain language with clear next action.
- Max 2 clicks from shipment list to detail edit/save.
- Real-time updates must not block user edits or navigation.

---

## 9. Permissions

Operations User:
- View and update shipment operations data
- Resolve verification items
- Add comments
- Export shipment list CSV

Admin:
- All Operations permissions
- Manage users/roles
- Manage vocabulary and settings
- Manage email intake channels and security rules
- Access audit exports

---

## 10. API Endpoints Required by UI (MVP)

Core:
- `POST /auth/login`
- `GET /shipments`
- `GET /shipments/export?format=csv`
- `GET /shipments/{id}`
- `PATCH /shipments/{id}`
- `POST /shipments/{id}/override`
- `GET /verification-items`
- `POST /verification-items/{id}/resolve`
- `GET /metrics`
- `GET /vocabulary`
- `POST /vocabulary`
- `PATCH /vocabulary/{id}`
- `GET /audit-log`
- `GET /settings`
- `PATCH /settings`

Email Intake:
- `GET /intake/channels`
- `POST /intake/channels`
- `PATCH /intake/channels/{id}`
- `POST /intake/channels/{id}/test`
- `POST /intake/channels/{id}/activate`
- `POST /intake/channels/{id}/deactivate`
- `GET /intake/errors`
- `POST /intake/errors/{id}/retry`
- `POST /intake/errors/{id}/ignore`

---

## 11. Acceptance Criteria

1. Operations user finds shipment in under 10 seconds using search/filter.
2. Verification item can be resolved in under 30 seconds.
3. Admin can connect at least one non-Google mailbox (IMAP or Microsoft 365) and ingest successfully.
4. System processes emails from multiple sender domains without code changes.
5. Duplicate email ingestion does not create duplicate shipment events.
6. Manual edits remain preserved after system updates.
7. Yellow verification highlight appears for all MVP flag scenarios.
8. Operations user can download the shipment list as CSV with current filters/search/sort applied.
9. Dashboard displays Average transit time (days) based on completed shipments in the last 30 days.
10. In `auto` mode, intake processes messages in near real-time via provider push when available, and falls back to polling automatically without workflow interruption.

---

## 12. Future Enhancements

- OCR queue and review UI
- WhatsApp ingestion view
- SLA alerts and escalations
- Customer-facing tracking portal

---

## Appendix A: Current Implementation Snapshot (Pilot)

This appendix documents current build status and does not modify requirements above.

- Engine remains from MVP (`WhatsClear_MVP_PRD_v1_1.md`).
- Web scaffold currently includes:
  - Login
  - KPI cards
  - Shipment list + search/manual filter
  - Shipment detail edit
  - Manual override (reason required)
  - Verification queue resolve
  - CSV export
  - Admin basics for vocabulary and intake channel creation
- Additional admin and intake hardening remains for production.

