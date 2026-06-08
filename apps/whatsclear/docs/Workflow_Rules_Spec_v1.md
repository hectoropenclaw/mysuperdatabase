# WhatsClear Workflow Rules Spec v1
Date: March 5, 2026
Scope: Operational rules for inbox ingestion, shipment matching/updating, and admin controls.

## 1. Purpose
Define deterministic behavior so WhatsClear can be validated consistently and tuned without ad-hoc decisions.

## 2. Intake Rules
1. Only active channels are processed.
2. Channel sync mode is polling in current build.
3. Default query window is `newer_than:2d` unless admin changes it.
4. IMAP query subset currently supported in filtering:
- `newer_than:Nd`
- `has:attachment`
5. Message dedupe key is `message_id`.
6. Non-operational/noise messages should be skipped when no shipment intent is detected.

## 3. Message Acceptance Rules
1. Accept email with attachments.
2. Accept email without attachments if operational intent is detected (shipment/pickup/delivery/carrier/reference patterns).
3. Skip clear noise/security/notification emails with no operational content.

## 4. Shipment Match/Create Priority
Use first successful match in this order:
1. Existing message record by `message_id` (idempotent return).
2. Shipment number found in subject/body.
3. Recent shipment by thread ID.
4. Recent shipment by message-reference linkage.
5. Shipment references parsed from email body (invoice/BOL/PO/reference text) across the full lifecycle.
6. Document references (`invoice`, `BOL`, `PO`) match.
7. If doc-ref candidates are multiple, reuse most recently updated candidate and flag ambiguity.
8. If no match, create new shipment with `manual_verification_required = true`.

## 5. Extraction Rules
1. PDF extraction: digital text PDFs only.
2. For release-instructions style docs, extract:
- `invoice_number`
- `po_number`
- `customer`
- `lane` from pickup/delivery city-state data
3. Ignore generic label values as customer (e.g., `Picking Address`, `Pick up`).
4. Customer value acceptance rule:
- must be a company-like proper noun (business name format),
- must not be an address label/value,
- must not be a generic operational term.
5. Email customer fallback:
- infer company proper noun if PDF customer missing.
6. Lane policy:
- UI lane target format is `City, ST -> City, ST`.
- Country-only expressions should not populate lane.

## 6. Status Classification Rules
1. Conservative status mode defaults to ON.
2. Request/future-intent phrases (e.g., `please schedule pickup`) map to `Shipment Requested`.
3. Completion phrases (e.g., `has been picked up`) map to `Pickup Completed`.
4. Delivery completion phrases map to `Delivered`.
5. If classification confidence is low (0.5 to 0.8), add verification flag.
6. In-transit business requirement:
- when a load is picked up and not delivered, board should expose `In Transit` state.

## 7. Carrier Extraction Rules
1. Explicit patterns:
- `MX carrier: ...`
- `US carrier: ...`
2. Generic follow-up patterns:
- `carrier is ...`
- `carrier: ...`
- `by carrier ...`
3. If only generic carrier is found, write to `US Carrier` by default (current operational policy).

## 8. Lifecycle and Handoff Rules
1. Validate status transitions against canonical lifecycle.
2. Forward jumps may be applied but must be flagged.
3. Illegal backward transitions are flagged.
4. Cross-border handoff:
- if status is `Crossed` but post-border carrier is missing, force `Dispatch Pending` and flag.

## 8.1 Derived Status Definition
`Derived status` means a computed board-facing status inferred from raw events/status + rules.
Example:
- Raw status = `Pickup Completed`, Delivered not reached -> board derived status can be `In Transit`.
Why use it:
- keeps operational board language simple without losing canonical engine states.

## 9. Update Precedence Rules
1. Never silently overwrite manual edits in protected contexts.
2. Fill missing shipment fields from extracted data.
3. If extracted field conflicts with existing value, keep existing and flag for verification.
4. If any shipment-critical field is ambiguous, write a human-readable note into `Comments`.

## 10. Board and Intelligence Rules
1. Main board is lean: one row per shipment.
2. Timeline/event detail is separate (detail/intelligence views).
3. CSV export must reflect current board filters.
4. Required board columns include:
- `PO #`
- `Pickup Date` (date-only, no time)
- `ETA` (future date or `Pending`)
- `Comments`
5. `Created Date` storage can remain UTC, but board display requirement is Pacific Standard Time and appears as penultimate time column.

## 11. Admin Operating Rules
1. Keep only one channel active per mailbox/folder source.
2. Delete duplicate channels to avoid duplicate ingestion windows.
3. Use query window intentionally:
- `newer_than:2d` for tight operations
- `newer_than:7d` during stabilization/catch-up
4. Use vocabulary for phrase mapping, not for ingestion/matching logic.

## 12. Change Control Rule
Every rule change must be validated against the Golden Test Matrix before being accepted.
