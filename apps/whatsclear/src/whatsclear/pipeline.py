from __future__ import annotations

from datetime import datetime
import re
from typing import Any

from .classifier import DEFAULT_VOCABULARY, classify_status, detect_lifecycle_intent
from .models import AttachmentExtraction, EmailMessage, SemanticExtractionResult, ShipmentRecord, VerificationFlag
from .parsing import (
    extract_carrier,
    extract_bol_number,
    extract_customer_name,
    extract_eta,
    extract_generic_carrier,
    extract_invoice_number,
    extract_lane,
    extract_po_number,
    extract_pickup_date,
    extract_shipment_number,
    trim_reply_history,
)
from .pdf_extractor import extract_digital_pdf_fields
from .repository import Repository
from .semantic_extractor import SemanticExtractionError, extract_email_semantics
from .sheets import LocalSheetSync
from .status_engine import apply_handoff_logic, is_forward_progression, is_legal_transition


def _append_comment(current: str | None, addition: str) -> str:
    base = (current or "").strip()
    extra = addition.strip()
    if not base:
        return extra
    if extra.lower() in base.lower():
        return base
    return f"{base} | {extra}"


def _values_conflict(left: str | None, right: str | None) -> bool:
    if left is None or right is None:
        return False
    return left.strip().casefold() != right.strip().casefold()


def _has_conditional_pickup_phrase(text: str) -> bool:
    patterns = [
        re.compile(r"\blet me know when .*picked up\b", re.I),
        re.compile(r"\bconfirm once .*picked up\b", re.I),
        re.compile(r"\bnotify me when .*picked up\b", re.I),
        re.compile(r"\badvise when .*picked up\b", re.I),
        re.compile(r"\b(?:if|when|once)\s+.*picked up\b", re.I),
        re.compile(r"\bto be picked up\b", re.I),
    ]
    return any(pattern.search(text) for pattern in patterns)


SEMANTIC_FIELD_MAP = {
    "customer",
    "lane",
    "invoice_number",
    "bol_number",
    "po_number",
    "shipper",
    "consignee",
    "mx_carrier",
    "us_carrier",
    "pickup_date",
    "eta",
    "comments",
}


class WhatsClearPipeline:
    def __init__(
        self,
        repository: Repository | None = None,
        sheet_sync: LocalSheetSync | None = None,
    ) -> None:
        self.repository = repository or Repository()
        self.sheet_sync = sheet_sync or LocalSheetSync()

    def close(self) -> None:
        self.repository.close()

    def _match_or_create_shipment(
        self,
        message: EmailMessage,
        attachment_extractions: list[AttachmentExtraction],
        semantic_result: SemanticExtractionResult | None = None,
    ) -> tuple[ShipmentRecord, list[VerificationFlag], bool]:
        cleaned_body = trim_reply_history(message.body)
        text_blob = f"{message.subject}\n{cleaned_body}"
        shipment_number = extract_shipment_number(text_blob)
        semantic_fields = semantic_result.extracted_data if semantic_result else {}
        semantic_used = False
        lane = semantic_fields.get("lane") or extract_lane(text_blob)
        doc_lane = next((a.extracted_data.get("lane") for a in attachment_extractions if a.extracted_data.get("lane")), None)

        doc_invoice = next((a.extracted_data.get("invoice_number") for a in attachment_extractions if a.extracted_data.get("invoice_number")), None)
        doc_bol = next((a.extracted_data.get("bol_number") for a in attachment_extractions if a.extracted_data.get("bol_number")), None)
        doc_po = next((a.extracted_data.get("po_number") for a in attachment_extractions if a.extracted_data.get("po_number")), None)

        body_invoice = semantic_fields.get("invoice_number") or extract_invoice_number(text_blob)
        body_bol = semantic_fields.get("bol_number") or extract_bol_number(text_blob)
        body_po = semantic_fields.get("po_number") or extract_po_number(text_blob)
        match_invoice = doc_invoice or body_invoice
        match_bol = doc_bol or body_bol
        match_po = doc_po or body_po

        flags: list[VerificationFlag] = []

        if shipment_number:
            existing = self.repository.get_shipment_by_number(shipment_number)
            if existing:
                return existing, flags, semantic_used

        existing_by_thread = self.repository.get_recent_shipment_by_thread(message.thread_id)
        if existing_by_thread:
            return existing_by_thread, flags, semantic_used

        existing_by_reference = self.repository.get_recent_shipment_by_message_reference(message.thread_id)
        if existing_by_reference:
            return existing_by_reference, flags, semantic_used

        candidates = self.repository.find_shipment_by_doc_refs(match_invoice, match_bol, match_po)
        if len(candidates) == 1:
            semantic_used = bool(semantic_result and any([body_invoice, body_bol, body_po]))
            return candidates[0], flags, semantic_used
        if len(candidates) > 1:
            flags.append(VerificationFlag(field="shipment_number", reason="Ambiguous shipment match"))
            # Prefer the most recently updated candidate instead of creating a new duplicate shipment.
            selected = sorted(candidates, key=lambda s: (s.last_update, s.id), reverse=True)[0]
            semantic_used = bool(semantic_result and any([body_invoice, body_bol, body_po]))
            return selected, flags, semantic_used

        shipment = self.repository.create_shipment(
            {
                "shipment_number": None,
                "customer": next(
                    (a.extracted_data.get("customer") for a in attachment_extractions if a.extracted_data.get("customer")),
                    None,
                )
                or semantic_fields.get("customer")
                or extract_customer_name(text_blob),
                "lane": lane or doc_lane,
                "invoice_number": match_invoice,
                "bol_number": match_bol,
                "po_number": match_po,
                "shipper": next((a.extracted_data.get("shipper") for a in attachment_extractions if a.extracted_data.get("shipper")), None)
                or semantic_fields.get("shipper"),
                "consignee": next((a.extracted_data.get("consignee") for a in attachment_extractions if a.extracted_data.get("consignee")), None)
                or semantic_fields.get("consignee"),
                "us_carrier": next((a.extracted_data.get("us_carrier") for a in attachment_extractions if a.extracted_data.get("us_carrier")), None)
                or semantic_fields.get("us_carrier"),
                "status": "Shipment Requested",
                "manual_verification_required": True,
                "source": "email+pdf",
            }
        )
        flags.append(VerificationFlag(field="shipment_number", reason="Shipment number missing"))
        semantic_used = bool(
            semantic_result
            and any(
                semantic_fields.get(field_name)
                for field_name in ("customer", "lane", "invoice_number", "bol_number", "po_number", "shipper", "consignee", "us_carrier")
            )
        )
        return shipment, flags, semantic_used

    def _run_semantic_extraction(
        self,
        subject: str,
        body: str,
        settings: dict[str, Any],
    ) -> tuple[SemanticExtractionResult | None, list[str], str | None]:
        semantic_settings = settings.get("semantic_extraction", {})
        if not semantic_settings.get("enabled"):
            return None, [], None
        try:
            result = extract_email_semantics(
                subject=subject,
                body=body,
                settings={
                    **semantic_settings,
                    "schema_name": settings.get("schema_validation", {}).get("schema_name", "shipment_event_v1"),
                },
            )
            return result, [], None
        except SemanticExtractionError as exc:
            return None, [str(exc)], "Semantic extraction unavailable"

    def _audit_semantic_extraction(
        self,
        message_id: str,
        shipment_id: int | None,
        settings: dict[str, Any],
        semantic_result: SemanticExtractionResult | None,
        validation_errors: list[str],
        action_taken: str,
        review_notes: str | None = None,
    ) -> None:
        semantic_settings = settings.get("semantic_extraction", {})
        if not semantic_settings.get("enabled"):
            return
        provider_name = str(semantic_settings.get("provider") or "openai")
        model_name = str(semantic_settings.get("model") or "gpt-4.1-mini")
        schema_name = str(settings.get("schema_validation", {}).get("schema_name") or "shipment_event_v1")
        if semantic_result is None and not validation_errors:
            return
        confidence = semantic_result.confidence if semantic_result else 0.0
        decision = "accepted" if semantic_result and not validation_errors and action_taken == "applied" else "rejected"
        if semantic_result and not validation_errors and action_taken == "ignored":
            decision = "pending_review"
        self.repository.add_extraction_audit(
            {
                "shipment_id": shipment_id,
                "message_id": message_id,
                "provider_name": semantic_result.provider_name if semantic_result else provider_name,
                "model_name": semantic_result.model_name if semantic_result else model_name,
                "schema_name": semantic_result.schema_name if semantic_result else schema_name,
                "decision": decision,
                "confidence_score": confidence,
                "action_taken": action_taken,
                "payload": semantic_result.raw_payload if semantic_result else {},
                "validation_errors": validation_errors,
                "source_evidence": semantic_result.source_evidence if semantic_result else [],
                "review_notes": review_notes or (semantic_result.review_notes if semantic_result else None),
            }
        )

    def _extract_attachments(self, message_id: str, attachments: list[str]) -> tuple[list[AttachmentExtraction], list[VerificationFlag]]:
        extractions: list[AttachmentExtraction] = []
        flags: list[VerificationFlag] = []
        for idx, attachment in enumerate(attachments):
            if not attachment.lower().endswith(".pdf"):
                continue
            extraction = extract_digital_pdf_fields(attachment, f"{message_id}:att-{idx}")
            if not extraction.is_digital_pdf:
                flags.append(VerificationFlag(field="attachment", reason=f"Non-digital PDF detected: {extraction.filename}"))
            extractions.append(extraction)
        return extractions, flags

    def process_message(self, message: EmailMessage) -> tuple[ShipmentRecord, list[VerificationFlag]]:
        existing = self.repository.get_message_record(message.message_id)
        if existing:
            shipment = self.repository.get_shipment_by_id(existing["shipment_id"])
            if shipment is None:
                raise ValueError(f"Message {message.message_id} points to missing shipment")
            return shipment, []

        cleaned_body = trim_reply_history(message.body)
        settings = self.repository.get_settings()
        semantic_result, semantic_errors, semantic_review_note = self._run_semantic_extraction(
            subject=message.subject,
            body=cleaned_body,
            settings=settings,
        )
        attachment_extractions, attachment_flags = self._extract_attachments(message.message_id, message.attachments)
        shipment, match_flags, semantic_used_for_match = self._match_or_create_shipment(
            message,
            attachment_extractions,
            semantic_result=semantic_result,
        )

        vocabulary = {**DEFAULT_VOCABULARY, **self.repository.get_active_vocabulary()}
        conservative_status_mode = bool(settings.get("schema_validation", {}).get("conservative_status_mode", True))
        classification = classify_status(
            f"{message.subject}\n{cleaned_body}",
            vocabulary=vocabulary,
            conservative_status_mode=conservative_status_mode,
        )
        lifecycle_intent = detect_lifecycle_intent(f"{message.subject}\n{cleaned_body}")

        flags = [*attachment_flags, *match_flags]
        semantic_validation_errors = list(semantic_errors)
        updates: dict[str, str | bool | None] = {}
        semantic_fields = semantic_result.extracted_data if semantic_result else {}
        semantic_applied = semantic_used_for_match

        if classification.status:
            # Guardrail: request/future/conditional/question language must not force completion statuses.
            if lifecycle_intent in {"request", "future", "conditional", "question"} and classification.status in {
                "Pickup Completed",
                "Crossed",
                "Dispatched",
                "Delivered",
            }:
                flags.append(
                    VerificationFlag(
                        field="status",
                        reason=f"Status suppressed by intent={lifecycle_intent}",
                    )
                )
                classification.status = None
            if classification.status and not is_legal_transition(shipment.status, classification.status):
                if classification.status and is_forward_progression(shipment.status, classification.status):
                    updates["status"] = classification.status
                    flags.append(VerificationFlag(field="status", reason="Skipped lifecycle steps during status progression"))
                else:
                    flags.append(VerificationFlag(field="status", reason="Illegal lifecycle transition detected"))
            elif classification.status:
                updates["status"] = classification.status

        if 0.5 <= classification.confidence <= 0.8:
            flags.append(VerificationFlag(field="status", reason="Low-confidence classification"))

        if classification.blocked_reason:
            updates["blocked_reason"] = classification.blocked_reason

        if semantic_result and semantic_result.blocked_reason and not updates.get("blocked_reason"):
            updates["blocked_reason"] = semantic_result.blocked_reason
            semantic_applied = True

        if semantic_result and semantic_result.status and not classification.status:
            semantic_status = semantic_result.status
            if lifecycle_intent in {"request", "future", "conditional", "question"} and semantic_status in {
                "Pickup Completed",
                "Crossed",
                "Dispatched",
                "Delivered",
            }:
                semantic_validation_errors.append(f"Status suppressed by intent={lifecycle_intent}")
            elif not is_legal_transition(shipment.status, semantic_status):
                semantic_validation_errors.append("Illegal lifecycle transition detected")
            else:
                updates["status"] = semantic_status
                semantic_applied = True

        # Carrier hints from body.
        mx_carrier = extract_carrier(cleaned_body, "mx")
        us_carrier = extract_carrier(cleaned_body, "us")
        if mx_carrier:
            updates["mx_carrier"] = mx_carrier
        if us_carrier:
            updates["us_carrier"] = us_carrier
        if not mx_carrier and not us_carrier:
            generic_carrier = extract_generic_carrier(cleaned_body)
            if generic_carrier:
                # For mixed/unknown cases default to US carrier column for visibility in current UI workflow.
                updates["us_carrier"] = generic_carrier

        pickup_date = extract_pickup_date(cleaned_body, message.timestamp)
        if pickup_date:
            updates["pickup_date"] = pickup_date

        body_invoice = extract_invoice_number(f"{message.subject}\n{cleaned_body}")
        body_bol = extract_bol_number(f"{message.subject}\n{cleaned_body}")
        body_po = extract_po_number(f"{message.subject}\n{cleaned_body}")
        if body_invoice and not shipment.invoice_number:
            updates["invoice_number"] = body_invoice
        if body_bol and not shipment.bol_number:
            updates["bol_number"] = body_bol
        if body_po and not shipment.po_number:
            updates["po_number"] = body_po

        for field_name in SEMANTIC_FIELD_MAP:
            value = semantic_fields.get(field_name)
            if not value:
                continue
            current_value = getattr(shipment, field_name, None)
            if updates.get(field_name):
                current_value = updates[field_name]
            if current_value and _values_conflict(str(current_value), value):
                semantic_validation_errors.append(f"{field_name} conflicts with existing data")
                continue
            if not current_value:
                updates[field_name] = value
                semantic_applied = True

        eta_value = extract_eta(cleaned_body, message.timestamp)
        if eta_value:
            if eta_value == "Pending":
                updates["eta"] = "Pending"
            else:
                try:
                    eta_dt = datetime.fromisoformat(eta_value).date()
                except ValueError:
                    eta_dt = None
                pickup_ref = updates.get("pickup_date") or shipment.pickup_date
                pickup_dt = None
                if pickup_ref and pickup_ref != "Pending":
                    try:
                        pickup_dt = datetime.fromisoformat(pickup_ref).date()
                    except ValueError:
                        pickup_dt = None
                created_dt = None
                try:
                    created_dt = datetime.fromisoformat(shipment.created_date).date()
                except ValueError:
                    created_dt = None

                invalid_eta = eta_dt is None
                if not invalid_eta and pickup_dt and eta_dt < pickup_dt:
                    invalid_eta = True
                if not invalid_eta and created_dt and eta_dt < created_dt:
                    invalid_eta = True

                if invalid_eta:
                    flags.append(VerificationFlag(field="eta", reason="ETA date is invalid for shipment timeline"))
                    updates["comments"] = _append_comment(
                        shipment.comments,
                        f"Invalid ETA ignored: {eta_value}",
                    )
                else:
                    updates["eta"] = eta_value

        # Fill missing fields from digital PDFs and flag conflicts.
        for extraction in attachment_extractions:
            for src_field, value in extraction.extracted_data.items():
                if src_field not in {
                    "customer",
                    "lane",
                    "invoice_number",
                    "bol_number",
                    "po_number",
                    "shipper",
                    "consignee",
                    "us_carrier",
                }:
                    continue
                current_value = getattr(shipment, src_field)
                if current_value and value and _values_conflict(str(current_value), str(value)):
                    flags.append(VerificationFlag(field=src_field, reason="Extracted data conflicts with existing data"))
                elif value and not current_value:
                    updates[src_field] = value

        if not shipment.customer:
            inferred_customer = extract_customer_name(f"{message.subject}\n{cleaned_body}")
            if inferred_customer:
                updates["customer"] = inferred_customer

        candidate_lane = shipment.lane or updates.get("lane") or extract_lane(cleaned_body) or next(
            (a.extracted_data.get("lane") for a in attachment_extractions if a.extracted_data.get("lane")),
            None,
        )
        if candidate_lane:
            updates["lane"] = candidate_lane

        resulting_status = updates.get("status", shipment.status)
        status_after_handoff, forced_pending = apply_handoff_logic(
            lane=updates.get("lane", shipment.lane),
            status=resulting_status,
            mx_carrier=updates.get("mx_carrier", shipment.mx_carrier),
            us_carrier=updates.get("us_carrier", shipment.us_carrier),
        )
        if forced_pending:
            flags.append(VerificationFlag(field="status", reason="Crossed without post-border carrier"))
        if status_after_handoff != resulting_status:
            updates["status"] = status_after_handoff

        final_status = updates.get("status", shipment.status)
        if _has_conditional_pickup_phrase(cleaned_body):
            if not (updates.get("pickup_date") or shipment.pickup_date):
                updates["pickup_date"] = "Pending"
        if lifecycle_intent in {"future", "request"} and not (updates.get("pickup_date") or shipment.pickup_date):
            updates["pickup_date"] = "Pending"
        if not updates.get("pickup_date"):
            current_pickup = shipment.pickup_date
            if final_status == "Shipment Requested":
                if not current_pickup:
                    updates["pickup_date"] = "Pending"
            elif final_status in {"Pickup Completed", "Crossed", "Dispatch Pending", "Dispatched", "Delivered"}:
                # Fallback rule: if body has no pickup date, use the update-received date (date-only).
                if not current_pickup or current_pickup == "Pending":
                    updates["pickup_date"] = message.timestamp.date().isoformat()

        if final_status in {"Pickup Completed", "Dispatched", "Dispatch Pending", "Crossed"}:
            if not (updates.get("eta") or shipment.eta):
                updates["eta"] = "Pending"

        ambiguous_reasons = sorted(
            {
                f.reason
                for f in flags
                if "ambiguous" in f.reason.lower() or "conflicts" in f.reason.lower()
            }
        )
        if ambiguous_reasons:
            updates["comments"] = _append_comment(
                updates.get("comments") or shipment.comments,
                "; ".join(ambiguous_reasons),
            )

        if flags:
            updates["manual_verification_required"] = True

        updated = self.repository.update_shipment_fields(shipment.id, updates)
        semantic_action = "applied" if semantic_applied else "ignored"
        self._audit_semantic_extraction(
            message_id=message.message_id,
            shipment_id=updated.id,
            settings=settings,
            semantic_result=semantic_result,
            validation_errors=semantic_validation_errors,
            action_taken=semantic_action,
            review_notes=semantic_review_note,
        )
        self.repository.store_message(
            message=message,
            shipment_id=updated.id,
            classification=classification.status,
            confidence=classification.confidence,
        )
        for extraction in attachment_extractions:
            self.repository.store_attachment(extraction, shipment_id=updated.id)

        # Normalize historical duplicates so one shipment identity maps to one row.
        merged_count = self.repository.merge_duplicate_shipments()
        if merged_count:
            refreshed = self.repository.get_shipment_by_id(updated.id)
            if refreshed is not None:
                updated = refreshed

        all_shipments = self.repository.list_shipments()
        self.sheet_sync.sync_shipments(all_shipments)
        return updated, flags

    @staticmethod
    def from_payload(payload: dict) -> EmailMessage:
        ts = payload.get("timestamp")
        message_ts = datetime.fromisoformat(ts) if ts else datetime.utcnow()
        return EmailMessage(
            message_id=payload["message_id"],
            thread_id=payload.get("thread_id"),
            subject=payload.get("subject", ""),
            body=payload.get("body", ""),
            timestamp=message_ts,
            attachments=payload.get("attachments", []),
        )
