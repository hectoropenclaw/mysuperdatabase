# WhatsClear - Web UI Product Requirements Document (PRD)
## Version: v1.3 (Operational Reliability + Lean Follow-Up Board)
## Date: March 4, 2026

---

## 1. Purpose

This version upgrades WhatsClear from MVP scaffold to an operations-ready workflow for logistics coordinators.

Primary outcomes:
- Live and reliable email-driven shipment follow-up.
- One row per shipment in a lean operational board.
- Accurate chain/reply updates to the same shipment.
- Separate analytics/timeline section for deeper analysis (not in main board).

---

## 2. Product Positioning

Target users:
- Logistics coordinators in manufacturers and 3PLs who track fast-paced shipment updates from email.

Core value:
- Reduce manual tracking effort.
- Improve follow-up speed and accuracy.
- Keep shipment status board continuously current from inbound email updates.

---

## 3. Non-Negotiable UX Rule (v1.3)

Main follow-up dashboard must remain lean:
- One row per shipment.
- No timeline table in the main board.
- No heavy KPI widgets in the main board.

Timeline/events and advanced KPIs must live in a separate section.

---

## 4. Roles

### 4.1 Operations User
- Work the Follow-Up Board.
- Search/filter/assign/update shipment rows.
- Resolve verification items.
- Use shipment detail to inspect context and make corrections.

### 4.2 Admin
- All Operations permissions.
- Configure intake channels and monitor health.
- Manage vocabulary mappings and extraction-related settings.
- Review audit logs, intake errors, and intelligence metrics.

---

## 5. Information Architecture

### 5.1 Follow-Up Board (Default Landing)
Purpose: daily execution at speed.

Includes:
- Lean table (one row per shipment).
- Fast filters and search.
- Live updates.
- Quick actions (assign owner, edit status, resolve verification, open detail).

Excludes:
- Event timeline table.
- Deep trend analytics.

### 5.2 Shipment Detail
Purpose: investigate and fix with context.

Includes:
- Current shipment state.
- Message context and extraction evidence.
- Field-level conflicts and verification actions.
- Manual override with required reason.

### 5.3 Operations Intelligence (Separate Section)
Purpose: management, diagnostics, and improvement.

Includes:
- KPI cards and trends.
- Event timeline/table.
- Channel health and ingestion latency.
- Error analysis and audit drill-down.

---

## 6. Functional Scope (v1.3)

### 6.1 Intake and Linking Reliability
- Inbound messages from configured channels are normalized to a canonical envelope.
- Reply-chain identity must be deterministic using:
  - provider message ID
  - provider thread/conversation ID
  - in-reply-to
  - references
- Each message processing run is idempotent.
- Replies on same chain must update the same shipment unless confidence drops below threshold (then route to verification).

### 6.2 Shipment Matching Outcome States
Every inbound message must end in one of:
- `auto_linked`
- `needs_review`
- `new_shipment`

### 6.3 Current-State Row Model (Board)
- `shipments` remains current-state table for fast board reads.
- Main board always reflects latest accepted state.
- Field-level conflict policy: no silent destructive overwrite.

### 6.4 Historical/Event Model (Separate Section)
- Append-only `shipment_events` for full history/auditability.
- Event timeline not shown on main board, only in intelligence/detail surfaces.

### 6.5 Verification Workflow
- Move from shipment-level-only flag to field-level verification items.
- Keep shipment-level visual indicator on board.
- Verification actions:
  - accept suggested
  - keep current
  - edit manually
  - add note

### 6.6 PDF and Customer Extraction
- Digital PDF extraction remains active and required.
- Non-digital/scanned PDFs remain flagged for manual verification until OCR phase is introduced.
- Customer column enrichment must include:
  - PDF labeled field extraction when present.
  - Proper-noun company name inference from email text when labeled field is absent.

### 6.7 Live Update Delivery
- Main board receives near-real-time update pushes (SSE/WebSocket).
- Polling fallback remains available.

---

## 7. Data Model Evolution (v1.3)

### 7.1 Existing Core (preserved)
- `shipments`
- `messages`
- `attachments`
- `vocabulary_mapping`
- `audit_log`
- `intake_channels`
- `intake_errors`

### 7.2 New/Expanded Tables
- `message_index`
  - normalized identifiers for deterministic chain linking.
- `shipment_events`
  - immutable event records for timeline and diagnostics.
- `shipment_verification_items`
  - field-level review queue with state and resolution metadata.
- `ingestion_jobs`
  - queue/run telemetry, retries, and replay status.

---

## 8. API Contract (v1.3)

### 8.1 Follow-Up Board APIs (lean payloads)
- `GET /board/shipments`
- `PATCH /board/shipments/{id}`
- `POST /board/shipments/{id}/assign`
- `POST /board/shipments/{id}/resolve-verification`
- `GET /board/stream` (SSE/WebSocket equivalent)

### 8.2 Detail and Intelligence APIs
- `GET /shipments/{id}`
- `GET /shipments/{id}/messages`
- `GET /shipments/{id}/events`
- `GET /verification-items`
- `POST /verification-items/{id}/resolve`
- `GET /intelligence/kpis`
- `GET /intelligence/timeline`
- `GET /intelligence/channel-health`

### 8.3 Intake APIs
- `GET /intake/channels`
- `POST /intake/channels`
- `PATCH /intake/channels/{id}`
- `POST /intake/channels/{id}/test`
- `POST /intake/channels/{id}/sync`
- `POST /intake/sync`
- `GET /intake/errors`
- `POST /intake/errors/{id}/retry`
- `POST /intake/errors/{id}/ignore`

---

## 9. Performance and Reliability Targets

- Board refresh latency after valid inbound update: target under 15 seconds.
- Deterministic reply-chain linking accuracy: target >= 98% on pilot dataset.
- Duplicate inbound handling: zero duplicate state mutations for same logical message.
- Main board initial render under operational dataset: target under 2 seconds for first page.

---

## 10. Security and Commercial Readiness

- Replace demo auth with production user management and RBAC.
- Store channel credentials via secure secret handling (encrypted at rest).
- Complete provider support parity required by go-to-market plan (including Microsoft 365).
- Maintain full auditability for edits, overrides, verification resolutions, and intake config changes.

---

## 11. Acceptance Criteria (v1.3)

1. Main board remains lean and shipment-row based with no event timeline shown.
2. Timeline/event table is available only in Intelligence/Detail surfaces.
3. New inbound email updates relevant shipment row in near real time.
4. Reply-chain messages update the same shipment row with deterministic linking.
5. Customer field can be auto-filled from:
   - PDF-extracted customer label
   - proper-noun company name inference in email body/subject.
6. Non-digital PDFs are flagged for manual review; digital PDF extraction remains active.
7. Field-level verification queue is operational and resolvable by users.
8. Intake health and errors are visible to admin with actionable retry/ignore workflow.

---

## 12. Delivery Plan (Phased)

### Phase 1: Reliability Core
- Deterministic linking.
- Idempotent ingestion jobs.
- Queue/worker foundation.

### Phase 2: Lean Board + Live Updates
- Board-specific APIs and payload slimming.
- SSE/WebSocket push.
- Fast follow-up actions.

### Phase 3: Verification and Detail Hardening
- Field-level verification items.
- Conflict resolution UX in shipment detail.

### Phase 4: Intelligence Section
- KPI trends, timeline view, channel diagnostics.

### Phase 5: Enterprise Hardening
- RBAC, secrets, provider parity, production observability.

---

## 13. Out of Scope for v1.3

- WhatsApp ingestion execution (planned for later phase).
- OCR implementation for scanned PDFs.
- Customer-facing external tracking portal.

---

## Appendix A: Implementation Status Link

This PRD supersedes `WhatsClear_Web_UI_PRD_v1_2.md` for v1.3 planning and execution while preserving core MVP engine principles where still valid.
