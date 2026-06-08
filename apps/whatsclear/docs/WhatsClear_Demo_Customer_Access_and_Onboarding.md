# WhatsClear Demo: Customer Access and Onboarding

## Demo UI changes

- Customer-facing demo view uses a blue-and-white theme.
- Shipment rows alternate blue and white for a cleaner presentation.
- `Manual Verification` is hidden in customer view.
- Admin and operations users still retain the internal workflow controls.

## Demo users

- `admin@whatsclear.local / admin123`
- `ops@whatsclear.local / ops123`
- `customer@whatsclear.local / customer123`

## What is true today

- A customer-style portal view can be shown in the demo.
- Internal-only fields can be hidden from customer users in the UI.
- Email ingestion can technically come through one shared mailbox such as `whatsclear.ops@gmail.com`.

## What is required before real multi-customer launch

Hiding fields in the UI is not enough for real customer isolation. A production rollout needs tenant isolation in the backend.

Required implementation items:

1. Add `tenant_id` to users, shipments, messages, attachments, vocabulary, and channel routing rules.
2. Force backend filtering so each logged-in customer sees only rows for their own tenant.
3. Route each ingested email into the correct tenant before shipment creation or update.
4. Separate audit trails and export data by tenant.
5. Add customer-specific admin controls only for internal staff, not customer users.

## Can all customers use the same ingestion email?

Yes, technically they can use the same email address for ingestion, but only if routing is deterministic.

Safe shared-inbox requirements:

1. Each customer must have a routing rule.
2. Routing must happen before data is written into the shipment tables.
3. Ambiguous routing must stop auto-apply and go to manual review.

Recommended routing options:

1. One alias per customer under the same mailbox.
2. One intake channel per customer with known sender/domain rules.
3. Customer code in subject/body as a fallback matcher.

Best recommendation for launch:

- Use separate aliases or separate intake channels per customer, even if they all point to the same mailbox infrastructure underneath.
- Do not rely on one fully shared inbox without tenant routing rules.

## Customer-specific PDF handling

Different customers will often send different document layouts. This should be presented as a normal onboarding step, not as a system weakness.

Recommended onboarding flow per customer:

1. Collect 10 to 20 sample PDFs and common email bodies.
2. Identify required fields and shipment lifecycle phrases.
3. Tune extraction rules and body parsing for that customer.
4. Run a customer-specific test pack.
5. Approve production launch after pass criteria are met.
6. Monitor first live shipments and add new templates as needed.

## Demo message to potential customers

Use this positioning in the demo:

- WhatsClear is configurable per customer workflow.
- Email-body lifecycle rules can be tuned to how that customer communicates updates.
- PDF extraction is customized during onboarding against the customer's actual document set.
- A customer portal can expose only that customer's shipments once tenant isolation is enabled for production.
