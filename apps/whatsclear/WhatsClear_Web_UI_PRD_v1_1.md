# WhatsClear - Web UI Product Requirements Document (PRD)
## Version: v1.1 (Implementation-Aligned for Operations Pilot)
## Date: February 26, 2026

---

## 1. Purpose

This document defines the WhatsClear Web UI scope for the first real operations tryout, aligned to the current codebase implementation:

- Existing backend engine (email/PDF ingestion and SQLite persistence)
- New FastAPI web API scaffold
- New browser UI scaffold for operations and admin pilot flows

This version separates:

1. What is implemented now (pilot-ready)
2. What remains to reach full target UI behavior

---

## 2. Roles

### 2.1 Operations User
- Login
- View shipment list and shipment details
- Edit allowed shipment fields
- Perform manual override with required reason
- Resolve manual verification items
- Export filtered shipment list as CSV

### 2.2 Admin
- All Operations permissions
- Manage vocabulary mappings
- View audit log
- Update settings
- Manage intake channels and intake errors

---

## 3. Current Implemented Scope (as of February 26, 2026)

### 3.1 Web API
Implemented endpoints:

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
- `PATCH /vocabulary/{phrase}`
- `GET /audit-log`
- `GET /settings`
- `PATCH /settings`
- `GET /intake/channels`
- `POST /intake/channels`
- `PATCH /intake/channels/{id}`
- `POST /intake/channels/{id}/test`
- `POST /intake/channels/{id}/activate`
- `POST /intake/channels/{id}/deactivate`
- `GET /intake/errors`
- `POST /intake/errors/{id}/retry`
- `POST /intake/errors/{id}/ignore`

### 3.2 UI Screens (Pilot Scaffold)
- Login
- KPI dashboard cards
- Shipments list with search and manual verification filter
- Shipment detail/edit modal
- Manual override action (reason required)
- Verification queue list and resolve action
- CSV export (respects current filters)
- Admin panel basics:
  - Add vocabulary mapping
  - Add intake channel

### 3.3 Security and Access (Pilot)
- Role-based access at API level (`operations`, `admin`)
- Admin-only protection for vocabulary/settings/intake/audit routes
- In-memory token auth for pilot environment

### 3.4 Data Model Support Added
- `app_settings`
- `intake_channels`
- `intake_errors`
- Enhanced querying/filtering for shipments

---

## 4. Out of Scope for This Pilot Build

- Production-grade auth (SSO/JWT refresh/password reset email flow)
- Full user management UI and persistent user directory
- Rich charts on admin dashboard
- Complete intake provider OAuth flows in UI
- Real push webhook orchestration end-to-end in UI
- OCR workflow UI
- Mobile app

---

## 5. Functional Requirements (Pilot-Required)

### 5.1 Authentication
- User can login with email/password
- API rejects unauthorized requests
- Admin-only routes reject non-admin users

### 5.2 Shipments List
- Show core columns:
  - Shipment #
  - Lane
  - Status
  - Owner
  - Last Update
  - Manual Verification
- Search supports: shipment #, invoice, BOL, shipper, consignee
- Manual verification filter supports true/false
- Rows with `manual_verification_required = true` appear highlighted (`#FFF2CC`)

### 5.3 Shipment Detail and Edit
- User can open a shipment record
- User can patch editable fields
- Save writes audit log entries
- Manual override requires reason and records actor context in audit log

### 5.4 Verification Queue
- Queue is populated from shipments with `manual_verification_required = true`
- User can resolve an item
- Resolve action clears manual verification flag

### 5.5 CSV Export
- Export endpoint returns CSV
- Export respects current filter/search/sort query parameters

### 5.6 Admin Functions
- Vocabulary mapping add/edit/deactivate with canonical status validation
- Audit log filtering by shipment/actor/field/date range
- Settings read/update
- Intake channel create/edit/test/activate/deactivate
- Intake errors list/retry/ignore

---

## 6. UX Rules (Pilot)

- Manual verification highlight color: `#FFF2CC`
- Manual override requires reason
- Errors shown in plain language in UI status areas
- Shipments list to detail edit remains low-friction (single click open)
- CSV export available directly from shipment list panel

---

## 7. API and UI Non-Functional Requirements (Pilot)

- Local startup command:
  - `whatsclear-web --host 127.0.0.1 --port 8000 --db-path whatsclear.db`
- Browser target:
  - Latest Chrome/Edge for pilot
- Persistence:
  - SQLite for pilot
- Auditability:
  - Field-level updates logged

---

## 8. Acceptance Criteria for Operations Tryout

1. Operations user can login and view shipments without API errors.
2. User can find target shipment using search/filter in under 10 seconds.
3. User can resolve a verification item in under 30 seconds.
4. User can edit shipment fields and save successfully.
5. Manual override cannot be submitted without reason.
6. CSV export downloads and reflects active filters.
7. Admin can add a vocabulary phrase mapped to canonical status.
8. Admin can create and activate an intake channel.
9. Audit log records manual and automatic field updates.
10. Rows requiring manual verification are visibly highlighted in yellow.

---

## 9. Known Gaps Before Production

- Replace demo auth with secure identity provider and persistent user store
- Add password reset and forgot-password flow
- Add pagination controls in UI (API supports paging)
- Expand verification queue from single-flag model to richer per-field items
- Add robust intake channel credential encryption and secrets management
- Add real-time push health monitoring and fallback indicators
- Add automated test execution in CI environment with Python runtime available

---

## 10. Rollout Plan

### Phase 1: Internal Pilot (Now)
- Use current scaffold with operations and admin pilot users
- Validate end-to-end ops flow and collect friction points

### Phase 2: Pilot Hardening
- Fix UX issues from pilot feedback
- Improve error states and add missing admin views
- Add production auth and secrets handling

### Phase 3: Controlled Customer Trial
- Run with selected operations team and real mailbox channels
- Track KPIs, manual verification ratio, and resolution times

---

## 11. Runbook for First Tryout

1. Start server:
   - `whatsclear-web --host 127.0.0.1 --port 8000 --db-path whatsclear.db`
2. Open:
   - `http://127.0.0.1:8000`
3. Login:
   - Operations: `ops@whatsclear.local / ops123`
   - Admin: `admin@whatsclear.local / admin123`
4. Operations checks:
   - Search shipments
   - Open and edit a shipment
   - Resolve verification item
   - Export CSV
5. Admin checks:
   - Add vocabulary mapping
   - Create intake channel
   - Review audit log

---

## 12. Final Definition for This PRD Version

WhatsClear Web UI v1.1 is a pilot-grade operations console aligned to implemented code, enabling real workflow tryout for shipment operations, verification resolution, CSV export, and core admin controls, with clear gaps documented for production readiness.

