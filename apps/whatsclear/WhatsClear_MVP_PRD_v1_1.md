
# WhatsClear — Product Requirements Document (PRD)
## Version: MVP v1.1 (Email + Digital PDF Only)

---

# 1. Product Overview

## 1.1 Problem Statement

Cross-border logistics operations (MX–US and US–MX) rely heavily on:

- Email communication
- Digital PDF attachments (invoices, BOLs, packing lists)
- A manually maintained Google Sheet for operational control

Logistics coordinators must:

- Read emails and attachments
- Identify shipment references
- Manually update tracking spreadsheets
- Detect blockers and appointment changes

This results in:
- Human error
- Operational delays
- Manual data duplication
- Inconsistent tracking visibility

---

## 1.2 MVP Objective

WhatsClear MVP will:

1. Ingest email messages and digital PDF attachments.
2. Extract structured shipment data from digital PDFs (text-based only).
3. Classify operational status events from email text.
4. Update a shared Google Sheet automatically.
5. Require manual entry of Shipment / Load #.
6. Highlight any field requiring manual verification in yellow.
7. Support both export (MX → US) and import (US → MX) flows.

---

# 2. MVP Scope

## 2.1 Included

- Email ingestion (Gmail API preferred)
- Digital PDF parsing (text-based PDFs only)
- Shipment auto-creation (without auto-generating Shipment ID)
- Status lifecycle engine
- Carrier handoff logic (export + import)
- Manual override
- Customer view generation
- Basic KPI derivation
- Manual verification highlighting

## 2.2 Excluded (MVP)

- WhatsApp ingestion
- OCR for scanned PDFs
- Compliance validation
- Duty calculation
- TMS integrations
- Predictive ETAs

---

# 3. System Architecture

## 3.1 Input Layer

### Email
- Gmail API webhook or polling
- Parse:
  - Subject
  - Body
  - Thread ID
  - Attachments (PDF only)

---

## 3.2 Processing Layer

1. Email Parser
2. Digital PDF Extraction Engine
3. Shipment Identification Engine
4. Status Classification Engine
5. Lifecycle Validation Engine
6. Manual Verification Flagging Engine
7. Google Sheets Sync Layer

---

## 3.3 Data Storage Schema

### Shipments Table

- shipment_number (MANUAL ENTRY REQUIRED)
- customer
- shipper
- consignee
- lane
- invoice_number
- bol_number
- mx_carrier
- us_carrier
- status
- pickup_date
- pickup_appt
- cross_date
- delivery_date
- delivery_appt
- last_update
- owner
- manual_verification_required (boolean)

### Messages Table

- message_id
- shipment_number
- raw_text
- timestamp
- classification
- confidence_score

### Attachments Table

- attachment_id
- shipment_number
- filename
- storage_url
- extracted_data (JSON)
- is_digital_pdf

### Vocabulary Mapping Table

- phrase
- language
- mapped_status
- active

### Audit Log Table

- timestamp
- shipment_number
- field
- old_value
- new_value
- actor

---

# 4. Digital PDF Extraction Requirements

## 4.1 Scope

System must process only digital PDFs (text-based).

If PDF does not contain extractable text:
- Mark as non-digital
- Flag shipment for manual verification
- Highlight relevant cells in yellow

---

## 4.2 Extracted Fields (Mandatory)

From digital PDFs:

Identifiers:
- Invoice Number
- BOL Number
- PO Number

Routing:
- Origin city/state
- Destination city/state

Parties:
- Shipper
- Consignee

Totals:
- Total Weight
- Total Units
- Invoice Total (optional)

---

## 4.3 Manual Shipment Number Requirement

- System MUST NOT auto-generate Shipment / Load #.
- If no shipment number exists:
  - Create shipment row
  - Highlight Shipment # cell in yellow
  - Require manual entry

---

# 5. Status Lifecycle Engine

Canonical Status List:

Shipment Requested  
Pickup Scheduled  
Pickup Completed  
Docs Missing  
Docs Sent  
Export Cleared  
Import Cleared  
Filed  
Released  
Crossed  
Dispatch Pending  
Dispatched  
Delivered  

Illegal transitions must be flagged for manual verification.

---

# 6. Carrier & Handoff Logic

## 6.1 Export Flow (MX → US)

Flow:

Pickup → Export Cleared (MX) → Filed (US) → Released (US) → Crossed → Dispatch Pending (US Carrier) → Dispatched → Delivered

Carrier Logic:

- Before Crossed: update MX Carrier
- After Crossed: update US Carrier
- If Crossed and no US Carrier → Status = Dispatch Pending

---

## 6.2 Import Flow (US → MX)

Flow:

Pickup (US) → Filed (US) → Released (US) → Crossed → Import Cleared (MX) → Dispatch Pending (MX Carrier) → Dispatched → Delivered

Carrier Logic:

- Before Crossed: update US Carrier
- After Crossed: update MX Carrier
- If Crossed and no MX Carrier → Status = Dispatch Pending

---

# 7. Manual Verification Highlighting

System must highlight cells in yellow when:

- Shipment number missing
- Ambiguous shipment match
- Illegal lifecycle transition detected
- Non-digital PDF detected
- Low-confidence classification (0.5–0.8)
- Extracted data conflicts with existing data

Implementation:

- Add boolean flag `manual_verification_required`
- Google Sheets conditional formatting:
  - If TRUE → background color yellow (#FFF2CC)

---

# 8. Google Sheet Output Requirements

Master Sheet Columns:

Created Date  
Shipment #  
Customer  
Shipper  
Consignee  
Lane  
Invoice #  
BOL #  
MX Carrier  
US Carrier  
Status  
Blocked Reason  
Owner  
Pickup Date  
Pickup Appt  
Cross Date  
Delivery Date  
Delivery Appt  
Last Update  
Source  
Comments  

Requirements:

- Shipment # must remain empty until manually entered
- Cells requiring validation must be yellow
- System must not overwrite manual edits

---

# 9. Success Criteria (MVP)

- ≥ 60% of shipments auto-created from email/PDF
- ≥ 60% status auto-classification accuracy
- ≥ 50% reduction in manual spreadsheet updates
- Manual verification highlights used instead of silent errors

---

# Final MVP Definition

WhatsClear MVP is:

A communication and digital-PDF parsing engine that converts email-based coordination into a structured, automatically updated operational shipment tracking spreadsheet, with manual shipment number control and export/import support.
