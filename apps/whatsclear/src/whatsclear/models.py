from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class EmailMessage:
    message_id: str
    thread_id: str | None
    subject: str
    body: str
    timestamp: datetime
    attachments: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ClassificationResult:
    status: str | None
    confidence: float
    blocked_reason: str | None = None
    source_phrase: str | None = None


@dataclass(slots=True)
class AttachmentExtraction:
    attachment_id: str
    filename: str
    storage_url: str | None
    is_digital_pdf: bool
    extracted_data: dict[str, Any]


@dataclass(slots=True)
class SemanticExtractionResult:
    provider_name: str
    model_name: str
    schema_name: str
    confidence: float
    extracted_data: dict[str, Any]
    status: str | None = None
    blocked_reason: str | None = None
    source_evidence: list[str] = field(default_factory=list)
    review_notes: str | None = None
    raw_payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ShipmentRecord:
    id: int
    shipment_number: str | None
    customer: str | None
    shipper: str | None
    consignee: str | None
    lane: str | None
    invoice_number: str | None
    bol_number: str | None
    po_number: str | None
    mx_carrier: str | None
    us_carrier: str | None
    status: str | None
    blocked_reason: str | None
    pickup_date: str | None
    eta: str | None
    pickup_appt: str | None
    cross_date: str | None
    delivery_date: str | None
    delivery_appt: str | None
    created_date: str
    last_update: str
    owner: str | None
    source: str | None
    comments: str | None
    manual_verification_required: bool
    lifecycle_state: str = "active"
    closed_at: str | None = None
    closed_reason: str | None = None
    auto_closed: bool = False


@dataclass(slots=True)
class VerificationFlag:
    field: str
    reason: str
