# WhatsClear: Non-Technical Workflow Summary
Date: March 4, 2026

## What WhatsClear does today
WhatsClear is an operations assistant for cross-border shipments. It reads inbound shipment emails (and PDF docs), updates shipment tracking records, flags uncertain cases for human review, and keeps a shared master tracking sheet current.

In practice, it helps teams avoid manual copy/paste from email by converting updates into structured shipment records.

## End-to-end business flow (today)
1. Customer/vendor emails arrive in the configured inbox channel(s).
2. WhatsClear ingests each message (plus PDF attachments when present).
3. It tries to match the email to an existing shipment using shipment number, email thread/reference, or invoice/BOL/PO references.
4. If no reliable match exists, it creates a new shipment row.
5. It classifies the shipment status from message text (for example Pickup Scheduled, Crossed, Delivered).
6. It applies lifecycle and cross-border handoff checks.
7. If anything is uncertain or inconsistent, it marks the shipment for manual verification.
8. Ops users review, edit, and resolve flagged items in the web UI.
9. WhatsClear writes updated output to the master sheet used by the team.

## What is automated vs human
Automated:
- Message deduplication (same message will not be processed twice)
- Shipment matching (best effort)
- Basic status classification from known phrases and vocabulary
- PDF field extraction for digital PDFs
- KPI and audit data capture

Human-required:
- Enter shipment number when missing
- Resolve manual verification flags
- Correct conflicts/ambiguities
- Perform manual overrides (with reason)

## Current functional limits (important)
- Shipment numbers are never auto-generated.
- Scanned/image PDFs are not OCR-processed (digital-text PDFs only).
- Verification is shipment-level today (manual flag), not a full itemized review workflow.
- Microsoft 365 appears in UI/API options but is not implemented in ingestion service.
- “Realtime” is effectively polling-based at this stage.
- User management is minimal (demo users only).
- Credential storage is not yet hardened to production security standards.

## Roles in simple terms
Operations:
- Work shipment records
- Resolve verification flags
- Export filtered shipment lists

Admin:
- Everything operations can do, plus system setup
- Configure and monitor inbox intake channels
- Manage vocabulary mappings
- Review logs/errors/settings

## What success looks like for daily operations
- New inbound updates appear in shipments without manual retyping.
- Flagged records are quickly resolved by ops.
- The master sheet stays aligned with current shipment state.
- Admin can see channel health and fix intake issues quickly.
