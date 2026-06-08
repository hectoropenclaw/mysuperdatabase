# WhatsClear Admin SOP (Current Build)
Date: March 4, 2026

## Purpose
This SOP explains what the admin must do so WhatsClear runs reliably in daily operations.

## 1. Initial setup
1. Start the web server with the correct database path.
2. Log in as admin.
3. Open Admin panel.
4. Create at least one intake channel:
   - Provider: `imap` (recommended currently) or `gmail`
   - Mailbox credentials/query
   - Folder/label (usually `INBOX`)
   - Polling interval
   - Set channel `active = true`
5. Run channel test/sync.
6. Confirm:
   - `last_successful_sync` is populated
   - no blocking `last_error`
   - shipments/messages counts increase after new emails arrive

## 2. Daily admin checklist
1. Check intake channel status:
   - Active channels are still active
   - Last sync is recent
   - No unresolved intake errors
2. Trigger manual sync if needed.
3. Review verification queue volume with operations.
4. Review KPI trend:
   - Manual verification required
   - Blocked shipments
   - Messages processed
5. Review audit log for unusual manual overrides.

## 3. Intake channel configuration guidance
- Prefer one dedicated ops mailbox first, then add channels as needed.
- Use IMAP with app passwords where required by provider.
- Keep polling interval practical for load and responsiveness.
- Validate credentials after password rotations.

## 4. Vocabulary management
When recurring email wording is not mapping correctly:
1. Add phrase -> canonical status mapping in admin vocabulary.
2. Re-test by syncing new messages.
3. Verify improved classification confidence/consistency.

Use only canonical statuses:
- Shipment Requested
- Pickup Scheduled
- Pickup Completed
- Docs Missing
- Docs Sent
- Export Cleared
- Import Cleared
- Filed
- Released
- Crossed
- Dispatch Pending
- Dispatched
- Delivered

## 5. Exception handling runbook
### A. Channel sync error
1. Open intake channels and identify `last_error`.
2. Verify mailbox credentials, host, folder, and connectivity.
3. Re-run channel sync.
4. If successful, verify `last_successful_sync` updates.

### B. High verification backlog
1. Coordinate with ops to clear highest-impact shipments first.
2. Add missing vocabulary to reduce repeat ambiguity.
3. Confirm common missing fields in incoming docs/emails.

### C. Bad status jumps or conflicts
1. Validate if source email is valid update.
2. Use manual override with reason when needed.
3. Ensure audit trail is complete.

## 6. Security and governance (current-state caveats)
- Current auth users are demo-style and limited.
- Tokens are in-memory and not enterprise session management.
- Credentials are not yet encrypted-at-rest in a production-grade secret store.
- Treat this as pilot/MVP posture until hardening is implemented.

## 7. Known current limits admin must account for
- No OCR pipeline for scanned PDFs.
- Microsoft 365 ingestion not implemented despite UI/API placeholder.
- Retry/ignore intake error actions update error status but do not replay full raw message recovery pipeline.
- “Realtime auto fallback” in PRD is currently simplified to polling worker behavior.

## 8. Minimum operating model for reliability
1. Keep at least one active, healthy intake channel.
2. Monitor sync health daily.
3. Keep vocabulary current for common customer phrasing.
4. Require override reasons and periodically review audit entries.
5. Maintain a clear ownership process for manual verification resolution.
