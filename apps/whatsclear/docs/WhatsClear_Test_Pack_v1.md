# WhatsClear Test Pack v1

## Objective
Validate readiness for operational pilot with focus on:
- PDF extraction robustness
- One-row-per-shipment lifecycle behavior
- ETA/date/status rule accuracy
- Intake performance under realistic email volume

## Test Setup
1. Start clean DB/server.
2. Keep only one intake channel active.
3. Use query window for active test window only (for example `newer_than:30m`).
4. Run tests in order shown in CSV.
5. After each test:
- Send email/PDF
- Click `Sync active channels now`
- Click `Refresh`
- Record `PASS/FAIL` + note

## Pass Criteria
- Duplicate rule: one shipment identity should appear as one row on dashboard.
- Status rule: request vs completed vs conditional language must map correctly.
- Pickup date rule:
- from body date if present
- fallback to message date for completed pickup update
- `Pending` when still requested or conditional-only message
- ETA rule:
- accepts valid future ETA
- rejects invalid ETA and writes comment
- parses natural language ETA like `ETA is Friday 13th`
- Thread rule: replies should update the existing row.

## Recommended Execution Blocks
1. PDF Coverage (15 to 20 files)
2. Lifecycle Thread Reliability (5 shipments, full thread each)
3. Language Edge Cases (10 messages)
4. Performance Sanity (20 emails in 1 hour)

## Output Template
For each scenario, store:
- `scenario_id`
- `PASS/FAIL`
- `observed_result`
- `expected_result`
- `notes`

Use [WhatsClear_Test_Pack_v1.csv](/c:/Users/rober/Documents/Roberto/WhatsClear/docs/WhatsClear_Test_Pack_v1.csv) as the execution sheet.

