# WhatsClear Test Pack v2 (Email Lifecycle)

## Objective
Validate email-body shipment lifecycle behavior after rule tightening:
- one row per shipment identity
- no false status jumps from conditional/future/question language
- reliable pickup date + ETA updates
- stable thread/doc-ref matching

## Clean Start (Required)
Run from project root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_v13_real.ps1 -ResetData -Port 8000
```

Expected after login:
- dashboard starts with `0` shipments
- only one intake channel should be active
- use narrow query window during testing (for example `newer_than:30m`)

## Run Method
For each scenario in the CSV:
1. Send email (and attach PDF where required).
2. In Admin tab click `Sync active channels now`.
3. In Shipments tab click `Refresh`.
4. Record `PASS/FAIL` + notes in CSV.

## Critical Rules Being Validated
- Conditional/question/future text must not set completed statuses.
- Thread reply should update existing row, not create a new row.
- Match priority: shipment #, thread/reference, doc refs (PO/invoice/BOL), then create.
- Pickup date policy:
  - explicit pickup date in body wins
  - completed pickup without explicit date -> message date (date-only)
  - request/conditional/future-only -> `Pending` unless explicit future pickup date exists
- ETA policy:
  - accepts valid future date
  - supports formats like `ETA is 03/15` and `ETA is Friday 13th`
  - rejects invalid ETA timeline and adds comment

## Email Templates (Copy/Paste)
### Template A - New Request
Subject: `Next load request`

Body:
```text
Hello,
Please schedule pickup for next load.
Pickup: Laredo, TX
Delivery: Omaha, NE
```

### Template B - Pickup Confirmed
Subject: `Re: Next load request`

Body:
```text
Load has been picked up now, carrier is JB Hunt.
```

### Template C - Conditional (No Completion)
Subject: `Re: Next load request`

Body:
```text
Please let me know when it's picked up.
```

### Template D - ETA Numeric
Subject: `Re: Next load request`

Body:
```text
ETA is 03/15
```

### Template E - ETA Natural Language
Subject: `Re: Next load request`

Body:
```text
Update: ETA is Friday 13th
```

### Template F - Delivery
Subject: `Re: Next load request`

Body:
```text
Load delivered today.
```

## Execution Sheet
Use: [WhatsClear_Test_Pack_v2_Email_Lifecycle.csv](/c:/Users/rober/Documents/Roberto/WhatsClear/docs/WhatsClear_Test_Pack_v2_Email_Lifecycle.csv)
