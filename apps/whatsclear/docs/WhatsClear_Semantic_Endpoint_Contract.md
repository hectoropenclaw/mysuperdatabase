# WhatsClear Semantic Endpoint Contract

WhatsClear can call a semantic extraction endpoint for freeform email-body understanding.

## Request

`POST` the configured semantic endpoint with JSON:

```json
{
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "schema_name": "shipment_event_v1",
  "input": {
    "subject": "Re: next load update",
    "body": "Load has been picked up now, carrier is JB Hunt."
  },
  "expected_output": {
    "status": "optional string",
    "confidence": "required float 0..1",
    "blocked_reason": "optional string",
    "source_evidence": "list of short phrases from the email body",
    "review_notes": "optional string",
    "fields": [
      "bol_number",
      "comments",
      "consignee",
      "customer",
      "eta",
      "invoice_number",
      "lane",
      "mx_carrier",
      "pickup_date",
      "po_number",
      "shipper",
      "us_carrier"
    ]
  }
}
```

## Response

WhatsClear accepts either the response object directly or inside `result`.

```json
{
  "status": "Pickup Completed",
  "confidence": 0.94,
  "blocked_reason": null,
  "source_evidence": [
    "picked up now",
    "carrier is JB Hunt"
  ],
  "review_notes": null,
  "fields": {
    "us_carrier": "JB Hunt"
  }
}
```

Alternative wrapped form:

```json
{
  "result": {
    "status": "Shipment Requested",
    "confidence": 0.88,
    "source_evidence": ["please schedule pickup"],
    "fields": {
      "customer": "Acme Logistics LLC",
      "lane": "Monterrey, NL -> Laredo, TX"
    }
  }
}
```

## Notes

- WhatsClear still applies lifecycle guards after semantic extraction.
- Conditional or future language should not be returned as completed lifecycle events.
- The endpoint should return only fields it is confident about.
- Unknown keys are ignored by WhatsClear.
