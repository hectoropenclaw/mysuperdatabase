CREATE TABLE IF NOT EXISTS shipments (
    id BIGSERIAL PRIMARY KEY,
    shipment_number TEXT,
    customer TEXT,
    shipper TEXT,
    consignee TEXT,
    lane TEXT,
    invoice_number TEXT,
    bol_number TEXT,
    po_number TEXT,
    mx_carrier TEXT,
    us_carrier TEXT,
    status TEXT,
    blocked_reason TEXT,
    pickup_date TEXT,
    eta TEXT,
    pickup_appt TEXT,
    cross_date TEXT,
    delivery_date TEXT,
    delivery_appt TEXT,
    created_date TEXT NOT NULL,
    last_update TEXT NOT NULL,
    owner TEXT,
    source TEXT,
    comments TEXT,
    manual_verification_required INTEGER NOT NULL DEFAULT 0,
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    closed_at TEXT,
    closed_reason TEXT,
    auto_closed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    shipment_id BIGINT REFERENCES shipments(id),
    thread_id TEXT,
    raw_text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    classification TEXT,
    confidence_score DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY,
    shipment_id BIGINT REFERENCES shipments(id),
    filename TEXT NOT NULL,
    storage_url TEXT,
    extracted_data TEXT NOT NULL,
    is_digital_pdf INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vocabulary_mapping (
    phrase TEXT PRIMARY KEY,
    language TEXT NOT NULL DEFAULT 'en',
    mapped_status TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TEXT NOT NULL,
    shipment_id BIGINT,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    actor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intake_channels (
    id BIGSERIAL PRIMARY KEY,
    channel_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    auth_data TEXT,
    sync_mode TEXT NOT NULL,
    polling_interval INTEGER NOT NULL DEFAULT 60,
    folder_label TEXT,
    active INTEGER NOT NULL DEFAULT 0,
    last_successful_sync TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intake_errors (
    id BIGSERIAL PRIMARY KEY,
    channel_id BIGINT REFERENCES intake_channels(id),
    timestamp TEXT NOT NULL,
    provider_message_id TEXT,
    error_type TEXT NOT NULL,
    error_details TEXT,
    retry_status TEXT NOT NULL DEFAULT 'pending',
    ignored_reason TEXT
);

CREATE TABLE IF NOT EXISTS extraction_audits (
    id BIGSERIAL PRIMARY KEY,
    timestamp TEXT NOT NULL,
    shipment_id BIGINT REFERENCES shipments(id),
    message_id TEXT REFERENCES messages(message_id),
    provider_name TEXT,
    model_name TEXT,
    schema_name TEXT,
    decision TEXT NOT NULL,
    confidence_score DOUBLE PRECISION,
    action_taken TEXT,
    payload_json TEXT NOT NULL,
    validation_errors_json TEXT,
    source_evidence_json TEXT,
    review_notes TEXT
);
