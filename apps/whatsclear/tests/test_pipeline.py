from __future__ import annotations

from datetime import datetime, timedelta, timezone

from whatsclear.intake_service import IntakeService
from whatsclear.classifier import classify_status, detect_lifecycle_intent
import whatsclear.pipeline as pipeline_module
from whatsclear.pdf_extractor import FIELD_PATTERNS, _extract_fields_from_text
from whatsclear.models import EmailMessage, SemanticExtractionResult
from whatsclear.parsing import extract_customer_name, extract_eta, extract_generic_carrier, extract_lane, extract_pickup_date
from whatsclear.pipeline import WhatsClearPipeline
from whatsclear.repository import Repository
from whatsclear.sheets import LocalSheetSync
from whatsclear.status_engine import is_legal_transition


def build_pipeline(tmp_path):
    repo = Repository(tmp_path / "test.db")
    sync = LocalSheetSync(tmp_path / "sheet.tsv")
    return WhatsClearPipeline(repository=repo, sheet_sync=sync)


def test_shipment_auto_create_requires_manual_number(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg = EmailMessage(
        message_id="m1",
        thread_id="t1",
        subject="Pickup scheduled for MX to US lane",
        body="Please proceed. Pickup scheduled for tomorrow.",
        timestamp=datetime.utcnow(),
    )
    shipment, flags = pipeline.process_message(msg)
    assert shipment.shipment_number is None
    assert shipment.manual_verification_required is True
    assert any("Shipment number missing" in f.reason for f in flags)
    pipeline.close()


def test_duplicate_message_does_not_create_duplicate_shipment(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg = EmailMessage(
        message_id="dup-1",
        thread_id="t1",
        subject="Shipment ready",
        body="Shipment ready. MX to US lane.",
        timestamp=datetime.utcnow(),
    )
    shipment1, _ = pipeline.process_message(msg)
    shipment2, _ = pipeline.process_message(msg)
    shipments = pipeline.repository.list_shipments()
    assert shipment1.id == shipment2.id
    assert len(shipments) == 1
    pipeline.close()


def test_forward_progression_updates_status_and_flags_review(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg1 = EmailMessage(
        message_id="m1",
        thread_id="t1",
        subject="Shipment requested",
        body="Shipment requested.",
        timestamp=datetime.utcnow(),
    )
    shipment, _ = pipeline.process_message(msg1)

    msg2 = EmailMessage(
        message_id="m2",
        thread_id="t1",
        subject="Delivered",
        body="Load delivered",
        timestamp=datetime.utcnow(),
    )
    shipment2, flags = pipeline.process_message(msg2)
    assert shipment.id == shipment2.id
    assert shipment2.status == "Delivered"
    assert any("Skipped lifecycle steps" in f.reason for f in flags)
    pipeline.close()


def test_handoff_logic_forces_dispatch_pending(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg = EmailMessage(
        message_id="m1",
        thread_id="t1",
        subject="Crossed Monterrey to Laredo",
        body="Crossed at border from Monterrey, NL to Laredo, TX. crossed",
        timestamp=datetime.utcnow(),
    )
    shipment, _ = pipeline.process_message(msg)
    assert shipment.status == "Dispatch Pending"
    pipeline.close()


def test_customer_is_auto_populated_from_pdf_fields(tmp_path, monkeypatch):
    pipeline = build_pipeline(tmp_path)

    def fake_extract_digital_pdf_fields(pdf_path, attachment_id):
        del pdf_path
        return pipeline_module.AttachmentExtraction(
            attachment_id=attachment_id,
            filename="load.pdf",
            storage_url="C:/tmp/load.pdf",
            is_digital_pdf=True,
            extracted_data={
                "customer": "Acme Imports",
                "invoice_number": "INV-123",
            },
        )

    monkeypatch.setattr(pipeline_module, "extract_digital_pdf_fields", fake_extract_digital_pdf_fields)
    msg = EmailMessage(
        message_id="pdf-1",
        thread_id="t-pdf",
        subject="Shipment requested",
        body="Please review attached docs.",
        timestamp=datetime.utcnow(),
        attachments=["load.pdf"],
    )

    shipment, _ = pipeline.process_message(msg)

    assert shipment.customer == "Acme Imports"
    assert shipment.invoice_number == "INV-123"
    pipeline.close()


def test_reply_reference_reuses_existing_shipment_and_progresses_status(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg1 = EmailMessage(
        message_id="<m1@example.com>",
        thread_id=None,
        subject="shipment ready",
        body="Shipment ready, please schedule pick up",
        timestamp=datetime.utcnow(),
    )
    shipment1, _ = pipeline.process_message(msg1)

    msg2 = EmailMessage(
        message_id="<m2@example.com>",
        thread_id="<m1@example.com>",
        subject="Re: shipment ready",
        body="shipment has been picked up by carrier\n\nOn earlier thread wrote:\nShipment ready",
        timestamp=datetime.utcnow(),
    )
    shipment2, flags2 = pipeline.process_message(msg2)

    msg3 = EmailMessage(
        message_id="<m3@example.com>",
        thread_id="<m2@example.com>",
        subject="Re: shipment ready",
        body="load is delivered\n\nOn earlier thread wrote:\nshipment has been picked up by carrier",
        timestamp=datetime.utcnow(),
    )
    shipment3, flags3 = pipeline.process_message(msg3)

    assert shipment1.id == shipment2.id == shipment3.id
    assert len(pipeline.repository.list_shipments()) == 1
    assert pipeline.repository.list_shipments()[0].status == "Delivered"
    assert shipment1.status == "Shipment Requested"
    assert any("Skipped lifecycle steps" in f.reason for f in flags2)
    assert any("Skipped lifecycle steps" in f.reason for f in flags3)
    pipeline.close()


def test_lane_is_backfilled_from_pdf_fields(tmp_path, monkeypatch):
    pipeline = build_pipeline(tmp_path)

    def fake_extract_digital_pdf_fields(pdf_path, attachment_id):
        del pdf_path
        return pipeline_module.AttachmentExtraction(
            attachment_id=attachment_id,
            filename="load.pdf",
            storage_url="C:/tmp/load.pdf",
            is_digital_pdf=True,
            extracted_data={
                "lane": "Oakland, CA -> Austin, TX",
                "invoice_number": "INV-123",
            },
        )

    monkeypatch.setattr(pipeline_module, "extract_digital_pdf_fields", fake_extract_digital_pdf_fields)
    msg = EmailMessage(
        message_id="pdf-lane-1",
        thread_id="t-pdf-lane",
        subject="Shipment requested",
        body="Please review attached docs.",
        timestamp=datetime.utcnow(),
        attachments=["load.pdf"],
    )

    shipment, _ = pipeline.process_message(msg)

    assert shipment.lane == "Oakland, CA -> Austin, TX"
    pipeline.close()


def test_classifier_treats_ready_to_be_picked_up_as_scheduled():
    result = classify_status("Attached is the load info, ready to be picked up this week. Please confirm.")

    assert result.status == "Pickup Scheduled"
    assert result.source_phrase == "ready to be picked up"


def test_classifier_keeps_completed_pickup_for_past_tense_update():
    result = classify_status("shipment has been picked up by carrier")

    assert result.status == "Pickup Completed"
    assert result.source_phrase == "picked up by carrier"


def test_classifier_keeps_delivered_for_completed_delivery_update():
    result = classify_status("load is delivered")

    assert result.status == "Delivered"


def test_classifier_does_not_mark_delivery_complete_for_future_intent():
    result = classify_status("Load is ready to be delivered tomorrow")

    assert result.status is None


def test_classifier_treats_schedule_pickup_request_as_shipment_requested():
    result = classify_status("Good afternoon. Attached is the info for the next load, please schedule a pickup.")

    assert result.status == "Shipment Requested"


def test_classifier_does_not_mark_pickup_completed_for_conditional_phrase():
    result = classify_status("Please let me know when it's picked up.")
    assert result.status is None


def test_classifier_marks_pickup_completed_for_confirmed_pickup_phrase():
    result = classify_status("Pickup is confirmed. Load picked up now.")
    assert result.status == "Pickup Completed"


def test_detect_lifecycle_intent_variants():
    assert detect_lifecycle_intent("Please schedule pickup for next load.") == "request"
    assert detect_lifecycle_intent("Let me know when it's picked up.") == "conditional"
    assert detect_lifecycle_intent("To be picked up tomorrow.") == "future"
    assert detect_lifecycle_intent("Has it been picked up?") == "question"
    assert detect_lifecycle_intent("Correction: not picked up yet.") == "correction"
    assert detect_lifecycle_intent("Load has been picked up now.") == "confirmation"


def test_classifier_conservative_mode_forces_request_status():
    text = "Please schedule a pickup for next load. Pickup this week if possible."
    loose = classify_status(text, conservative_status_mode=False)
    conservative = classify_status(text, conservative_status_mode=True)

    assert loose.status in {"Pickup Scheduled", "Shipment Requested"}
    assert conservative.status == "Shipment Requested"


def test_customer_pdf_extractor_supports_alternate_labels():
    pattern = FIELD_PATTERNS["customer"]

    assert pattern.search("Customer: Acme Imports").group(1) == "Acme Imports"
    assert pattern.search("Customer Name: Northwind Retail").group(1) == "Northwind Retail"
    assert pattern.search("Client: Fabrikam Logistics").group(1) == "Fabrikam Logistics"
    assert pattern.search("Account: Contoso Foods").group(1) == "Contoso Foods"


def test_customer_name_extractor_supports_proper_nouns():
    assert extract_customer_name("Please prioritize this load for Acme Logistics LLC today.") == "Acme Logistics LLC"
    assert extract_customer_name("Customer: Northwind Manufacturing Inc") == "Northwind Manufacturing Inc"


def test_customer_name_extractor_rejects_generic_labels():
    assert extract_customer_name("Attached is shipment info for the next load, please schedule pickup.") is None


def test_pipeline_backfills_customer_from_email_proper_noun(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg = EmailMessage(
        message_id="cust-1",
        thread_id="cust-thread-1",
        subject="Pickup scheduled",
        body="Please coordinate for Globex Transport Ltd on this shipment, from Monterrey, NL to Laredo, TX.",
        timestamp=datetime.utcnow(),
    )
    shipment, _ = pipeline.process_message(msg)

    assert shipment.customer == "Globex Transport Ltd"
    pipeline.close()


def test_extract_lane_uses_city_state_format_only():
    assert extract_lane("Load moving from Monterrey, NL to Laredo, TX tomorrow.") == "Monterrey, NL -> Laredo, TX"
    assert extract_lane("MX to US lane update.") is None


def test_extract_lane_from_pickup_delivery_body_labels():
    text = "Pickup: Oakland, CA\nDelivery: Austin, TX"
    assert extract_lane(text) == "Oakland, CA -> Austin, TX"


def test_extract_generic_carrier_from_freeform_text():
    assert extract_generic_carrier("load has been picked up now, carrier is sunview") == "Sunview"


def test_extract_pickup_and_eta_dates_from_body():
    base = datetime(2026, 3, 5, 12, 0, tzinfo=timezone.utc)
    assert extract_pickup_date("Pickup date: 03/07/2026", base) == "2026-03-07"
    assert extract_eta("ETA 2026-03-10", base) == "2026-03-10"
    assert extract_eta("ETA is 03/15", base) == "2026-03-15"
    assert extract_eta("update: ETA is friday 13th", datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)) == "2026-03-13"
    assert extract_eta("eta pending", base) == "Pending"


def test_release_instructions_pdf_extraction_avoids_generic_customer_and_extracts_lane_po():
    text = (
        "Releasing details\n"
        "Customer Name:\n"
        "Picking Address:\n"
        "Delivery Address:\n"
        "Arte Sano LLC\n"
        "Dreisbach Oakland\n"
        "Arte Sano LLC\n"
        "6110 Trade Center Dr\n"
        "2530 E 11th Street\n"
        "6110 Trade Center Dr\n"
        "Austin,Texas78744\n"
        "Oakland,California 94601\n"
        "Austin,Texas 78744\n"
        "Reference Number : TNSO-\n"
        "240288\n"
        "PO 7531\n"
    )
    extracted = _extract_fields_from_text(text)
    assert extracted.get("customer") == "Arte Sano LLC"
    assert extracted.get("po_number") == "7531"
    assert extracted.get("invoice_number") == "TNSO-240288"
    assert extracted.get("lane") == "Oakland, CA -> Austin, TX"


def test_pdf_extractor_z2l_layout_extracts_lane_and_customer():
    text = (
        "DELIVERY TYPE ZTLE SHIPPED LTL/Ground Parcel TERMS FOB Shipping Pt -Pickup/Arangd\n"
        "DELIVERY TIME 00:00 - 00:00 CARRIER 309347284 CUSTOMER PICK UP\n"
        "Customer PO: 202902\n"
        "SHIP TO : 5948679\n"
        "BEYONDGREEN BIOTECH INC\n"
        "1202 E WAKEHAM AVE\n"
        "SANTA ANA CA 92705-4145\n"
        "SUPPLYING PLANT: UXKC\n"
        "BASF CORPORATION\n"
        "C/O PALMER LOGISTICS\n"
        "13001 BAY AREA BLVD.\n"
        "PASADENA TX 77507-1332\n"
    )
    extracted = _extract_fields_from_text(text)
    assert extracted.get("customer") == "BEYONDGREEN BIOTECH INC"
    assert extracted.get("po_number") == "202902"
    assert extracted.get("lane") == "Pasadena, TX -> Santa Ana, CA"


def test_pdf_extractor_bol_layout_extracts_lane_and_carrier():
    text = (
        "Ship Date: 5/22/2025 BOL #: OFS1845318\n"
        "Carrier: D D M Logistics Inc\n"
        "Shipper\n"
        "Name: Tree House California Almonds, LLC\n"
        "City: Earlimart St: CA Zip: 93219\n"
        "PO/Ref #: 24-0001-27 / 0061237\n"
        "Consignee\n"
        "Name: Pure Food Specialties\n"
        "City: Northlake St: IL Zip: 60164\n"
    )
    extracted = _extract_fields_from_text(text)
    assert extracted.get("bol_number") == "OFS1845318"
    assert extracted.get("lane") == "Earlimart, CA -> Northlake, IL"
    assert extracted.get("us_carrier") == "D D M Logistics Inc"
    assert extracted.get("shipper") == "Tree House California Almonds, LLC"
    assert extracted.get("consignee") == "Pure Food Specialties"


def test_pdf_extractor_rate_confirmation_extracts_customer_and_stops_lane():
    text = (
        "Customer Chem Trend Comercial Sa De Cv Quote Number    CL4522524\n"
        "Stop #1 Pickup - Date 12/19/2024 08:00 - 12/19/2024 09:00\n"
        "City ST Zip  Howell, MI  48843-8552\n"
        "Stop #2 Drop - Date 12/23/2024 08:00 - 12/23/2024 17:00\n"
        "City ST Zip  BROWNSVILLE, TX  78521\n"
        "Cust Ref Number    PO# 4500609943 - Order# 3271124\n"
    )
    extracted = _extract_fields_from_text(text)
    assert extracted.get("customer") == "Chem Trend Comercial Sa De Cv"
    assert extracted.get("lane") == "Howell, MI -> Brownsville, TX"
    assert extracted.get("po_number") == "4500609943"


def test_settings_include_semantic_extraction_defaults(tmp_path):
    repo = Repository(tmp_path / "settings.db")

    settings = repo.get_settings()

    assert settings["semantic_extraction"]["enabled"] is False
    assert settings["semantic_extraction"]["provider"] == "openai"
    assert settings["schema_validation"]["schema_name"] == "shipment_event_v1"
    assert settings["schema_validation"]["conservative_status_mode"] is True
    assert settings["source_trust_policy"]["prefer_pdf_over_email_body"] is True
    repo.close()


def test_extraction_audit_log_round_trip(tmp_path):
    repo = Repository(tmp_path / "audits.db")

    audit = repo.add_extraction_audit(
        {
            "shipment_id": None,
            "message_id": "msg-1",
            "provider_name": "openai",
            "model_name": "gpt-4.1-mini",
            "schema_name": "shipment_event_v1",
            "decision": "rejected",
            "confidence_score": 0.41,
            "action_taken": "manual_review",
            "payload": {"status": "Delivered"},
            "validation_errors": ["missing shipment_number"],
            "source_evidence": ["load delivered"],
            "review_notes": "awaiting ops review",
        }
    )
    audits = repo.list_extraction_audits(limit=5)

    assert audit["decision"] == "rejected"
    assert audits[0]["provider_name"] == "openai"
    assert audits[0]["validation_errors"] == ["missing shipment_number"]
    repo.close()


def test_semantic_extraction_fills_missing_fields_and_writes_audit(tmp_path, monkeypatch):
    pipeline = build_pipeline(tmp_path)
    pipeline.repository.patch_settings(
        {
            "semantic_extraction": {
                "enabled": True,
                "provider": "openai",
                "model": "gpt-4.1-mini",
                "endpoint": "http://semantic.local/extract",
            }
        }
    )

    def fake_extract_email_semantics(subject: str, body: str, settings: dict):
        assert "next load" in body.lower()
        assert settings["endpoint"] == "http://semantic.local/extract"
        return SemanticExtractionResult(
            provider_name="openai",
            model_name="gpt-4.1-mini",
            schema_name="shipment_event_v1",
            confidence=0.96,
            extracted_data={
                "customer": "Northwind Logistics LLC",
                "lane": "Monterrey, NL -> Laredo, TX",
            },
            source_evidence=["next load", "Monterrey, NL", "Laredo, TX"],
            raw_payload={"confidence": 0.96, "fields": {"customer": "Northwind Logistics LLC"}},
        )

    monkeypatch.setattr(pipeline_module, "extract_email_semantics", fake_extract_email_semantics)
    shipment, _ = pipeline.process_message(
        EmailMessage(
            message_id="sem-1",
            thread_id="sem-thread-1",
            subject="Next load",
            body="Please help with the next load.",
            timestamp=datetime.utcnow(),
        )
    )

    assert shipment.customer == "Northwind Logistics LLC"
    assert shipment.lane == "Monterrey, NL -> Laredo, TX"
    audits = pipeline.repository.list_extraction_audits(limit=5)
    assert audits[0]["decision"] == "accepted"
    assert audits[0]["action_taken"] == "applied"
    pipeline.close()


def test_semantic_extraction_can_match_existing_shipment_by_ai_doc_ref(tmp_path, monkeypatch):
    pipeline = build_pipeline(tmp_path)
    pipeline.repository.patch_settings(
        {
            "semantic_extraction": {
                "enabled": True,
                "provider": "openai",
                "model": "gpt-4.1-mini",
                "endpoint": "http://semantic.local/extract",
            }
        }
    )
    existing = pipeline.repository.create_shipment(
        {
            "shipment_number": None,
            "customer": "Acme Foods",
            "lane": "El Paso, TX -> Phoenix, AZ",
            "invoice_number": "INV-7788",
            "status": "Shipment Requested",
            "manual_verification_required": True,
            "source": "email",
        }
    )

    def fake_extract_email_semantics(subject: str, body: str, settings: dict):
        del subject, settings
        assert "carrier is jb hunt" in body.lower()
        return SemanticExtractionResult(
            provider_name="openai",
            model_name="gpt-4.1-mini",
            schema_name="shipment_event_v1",
            confidence=0.91,
            extracted_data={"invoice_number": "INV-7788", "us_carrier": "JB Hunt"},
            status="Pickup Completed",
            source_evidence=["INV-7788", "carrier is JB Hunt", "picked up now"],
            raw_payload={"confidence": 0.91},
        )

    monkeypatch.setattr(pipeline_module, "extract_email_semantics", fake_extract_email_semantics)
    shipment, _ = pipeline.process_message(
        EmailMessage(
            message_id="sem-2",
            thread_id="unknown-thread",
            subject="Re: update",
            body="load has been picked up now, carrier is JB Hunt",
            timestamp=datetime.utcnow(),
        )
    )

    assert shipment.id == existing.id
    assert len(pipeline.repository.list_shipments()) == 1
    assert shipment.us_carrier == "Jb Hunt"
    pipeline.close()


def test_semantic_extraction_status_still_respects_lifecycle_guard(tmp_path, monkeypatch):
    pipeline = build_pipeline(tmp_path)
    pipeline.repository.patch_settings(
        {
            "semantic_extraction": {
                "enabled": True,
                "provider": "openai",
                "model": "gpt-4.1-mini",
                "endpoint": "http://semantic.local/extract",
            }
        }
    )

    def fake_extract_email_semantics(subject: str, body: str, settings: dict):
        del subject, settings
        assert "let me know" in body.lower()
        return SemanticExtractionResult(
            provider_name="openai",
            model_name="gpt-4.1-mini",
            schema_name="shipment_event_v1",
            confidence=0.89,
            extracted_data={"comments": "Awaiting pickup confirmation"},
            status="Pickup Completed",
            source_evidence=["let me know when it's picked up"],
            raw_payload={"confidence": 0.89},
        )

    monkeypatch.setattr(pipeline_module, "extract_email_semantics", fake_extract_email_semantics)
    shipment, _ = pipeline.process_message(
        EmailMessage(
            message_id="sem-3",
            thread_id="sem-thread-3",
            subject="Pickup follow up",
            body="Please let me know when it's picked up.",
            timestamp=datetime.utcnow(),
        )
    )

    assert shipment.status == "Shipment Requested"
    audits = pipeline.repository.list_extraction_audits(limit=5)
    assert audits[0]["decision"] == "rejected"
    assert "Status suppressed by intent=conditional" in audits[0]["validation_errors"]
    pipeline.close()


def test_intake_service_syncs_active_channel(tmp_path):
    db_path = tmp_path / "sync.db"
    repo = Repository(db_path)
    channel = repo.create_intake_channel(
        {
            "channel_name": "ops-gmail",
            "provider_type": "gmail",
            "auth_data": {"query": "newer_than:2d", "max_results": 10, "start_from_now": False},
            "sync_mode": "polling",
            "polling_interval": 60,
            "folder_label": "INBOX",
            "active": True,
        }
    )
    repo.upsert_vocabulary("shipment ready", "Shipment Requested")
    repo.close()

    class FakeGmailAdapter:
        def list_recent_messages(self, max_results: int = 20, query: str = ""):
            assert max_results == 10
            assert query == "newer_than:2d"
            return [
                EmailMessage(
                    message_id="gmail-1",
                    thread_id="thread-1",
                    subject="Shipment ready",
                    body="Shipment ready, please schedule pickup. MX to US lane.",
                    timestamp=datetime.utcnow(),
                )
            ]

    service = IntakeService(
        db_path=str(db_path),
        sheet_path=str(tmp_path / "sheet.tsv"),
        gmail_adapter_factory=FakeGmailAdapter,
    )
    result = service.sync_channel(channel["id"])
    assert result["processed_messages"] == 1
    assert result["created_shipments"] == 1

    repo = Repository(db_path)
    shipments = repo.list_shipments()
    assert len(shipments) == 1
    assert shipments[0].status == "Shipment Requested"
    assert shipments[0].manual_verification_required is True
    repo.close()


def test_intake_service_skips_non_operational_noise_message(tmp_path):
    db_path = tmp_path / "noise.db"
    repo = Repository(db_path)
    channel = repo.create_intake_channel(
        {
            "channel_name": "ops-gmail",
            "provider_type": "gmail",
            "auth_data": {"query": "newer_than:2d", "max_results": 10, "start_from_now": False},
            "sync_mode": "polling",
            "polling_interval": 60,
            "folder_label": "INBOX",
            "active": True,
        }
    )
    repo.close()

    class FakeGmailAdapter:
        def list_recent_messages(self, max_results: int = 20, query: str = ""):
            del max_results, query
            return [
                EmailMessage(
                    message_id="noise-1",
                    thread_id="noise-thread-1",
                    subject="Security alert",
                    body="notifications.google.com sign-in detected",
                    timestamp=datetime.utcnow(),
                )
            ]

    service = IntakeService(
        db_path=str(db_path),
        sheet_path=str(tmp_path / "sheet.tsv"),
        gmail_adapter_factory=FakeGmailAdapter,
    )
    result = service.sync_channel(channel["id"])
    assert result["processed_messages"] == 0
    assert result["created_shipments"] == 0

    repo = Repository(db_path)
    assert repo.list_shipments() == []
    repo.close()


def test_intake_service_accepts_follow_up_without_attachment_with_picked_up_text(tmp_path):
    db_path = tmp_path / "followup.db"
    repo = Repository(db_path)
    channel = repo.create_intake_channel(
        {
            "channel_name": "ops-gmail",
            "provider_type": "gmail",
            "auth_data": {"query": "newer_than:2d", "max_results": 10, "start_from_now": False},
            "sync_mode": "polling",
            "polling_interval": 60,
            "folder_label": "INBOX",
            "active": True,
        }
    )
    repo.close()

    class FakeGmailAdapter:
        def list_recent_messages(self, max_results: int = 20, query: str = ""):
            del max_results, query
            return [
                EmailMessage(
                    message_id="follow-1",
                    thread_id="thread-1",
                    subject="Re: next loads",
                    body="load has been picked up now, carrier is sunview",
                    timestamp=datetime.utcnow(),
                    attachments=[],
                )
            ]

    service = IntakeService(
        db_path=str(db_path),
        sheet_path=str(tmp_path / "sheet.tsv"),
        gmail_adapter_factory=FakeGmailAdapter,
    )
    result = service.sync_channel(channel["id"])
    assert result["processed_messages"] == 1
    assert result["created_shipments"] == 1


def test_filter_imap_messages_respects_newer_than_and_has_attachment():
    now = datetime.now(timezone.utc)
    recent_with_attachment = EmailMessage(
        message_id="m1",
        thread_id="t1",
        subject="Shipment update",
        body="Attached BOL",
        timestamp=now - timedelta(hours=4),
        attachments=["a.pdf"],
    )
    old_with_attachment = EmailMessage(
        message_id="m2",
        thread_id="t2",
        subject="Shipment update old",
        body="Attached BOL",
        timestamp=now - timedelta(days=5),
        attachments=["b.pdf"],
    )
    recent_without_attachment = EmailMessage(
        message_id="m3",
        thread_id="t3",
        subject="Shipment update no file",
        body="No attachment",
        timestamp=now - timedelta(hours=2),
        attachments=[],
    )

    filtered = IntakeService._filter_imap_messages(
        [recent_with_attachment, old_with_attachment, recent_without_attachment],
        "newer_than:2d has:attachment",
    )
    assert [m.message_id for m in filtered] == ["m1"]


def test_intake_start_from_now_skips_messages_older_than_channel_creation():
    created_at = datetime.now(timezone.utc)
    older = EmailMessage(
        message_id="old-1",
        thread_id="t-old",
        subject="Old shipment",
        body="Please schedule pickup",
        timestamp=created_at - timedelta(minutes=5),
    )
    newer = EmailMessage(
        message_id="new-1",
        thread_id="t-new",
        subject="New shipment",
        body="Please schedule pickup",
        timestamp=created_at + timedelta(seconds=5),
    )
    channel = {
        "auth_data": {"query": "newer_than:2d"},
        "last_successful_sync": None,
        "created_at": created_at.isoformat(),
    }
    filtered = IntakeService._apply_start_from_now(channel, [older, newer])
    assert [m.message_id for m in filtered] == ["new-1"]


def test_ambiguous_doc_ref_match_reuses_latest_shipment(tmp_path, monkeypatch):
    pipeline = build_pipeline(tmp_path)
    older = pipeline.repository.create_shipment(
        {
            "shipment_number": None,
            "po_number": "7531",
            "status": "Shipment Requested",
            "manual_verification_required": True,
            "source": "email+pdf",
        }
    )
    # Insert a second conflicting row directly to simulate legacy duplicate data.
    pipeline.repository.conn.execute(
        """
        INSERT INTO shipments(
            shipment_number, customer, shipper, consignee, lane, invoice_number, bol_number, po_number,
            mx_carrier, us_carrier, status, blocked_reason, pickup_date, eta, pickup_appt, cross_date,
            delivery_date, delivery_appt, created_date, last_update, owner, source, comments, manual_verification_required
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            None, None, None, None, None, None, None, "7531",
            None, None, "Shipment Requested", None, None, None, None, None,
            None, None, datetime.utcnow().isoformat(), datetime.utcnow().isoformat(), None, "email+pdf", None, 1,
        ),
    )
    pipeline.repository.conn.commit()
    latest = pipeline.repository.list_shipments()[-1]

    def fake_extract_digital_pdf_fields(pdf_path, attachment_id):
        del pdf_path
        return pipeline_module.AttachmentExtraction(
            attachment_id=attachment_id,
            filename="load.pdf",
            storage_url="C:/tmp/load.pdf",
            is_digital_pdf=True,
            extracted_data={"po_number": "7531", "customer": "Arte Sano LLC"},
        )

    monkeypatch.setattr(pipeline_module, "extract_digital_pdf_fields", fake_extract_digital_pdf_fields)
    msg = EmailMessage(
        message_id="amb-1",
        thread_id="amb-thread-1",
        subject="Attached docs",
        body="Please update",
        timestamp=datetime.utcnow(),
        attachments=["load.pdf"],
    )
    shipment, _flags = pipeline.process_message(msg)

    assert shipment.id in {latest.id, older.id}
    assert shipment.customer == "Arte Sano LLC"
    assert len(pipeline.repository.list_shipments()) == 2
    pipeline.close()


def test_repository_create_shipment_reuses_existing_doc_ref_row(tmp_path):
    repo = Repository(tmp_path / "repo-dedupe.db")
    first = repo.create_shipment(
        {
            "shipment_number": None,
            "invoice_number": "TNSO-240288",
            "po_number": "7531",
            "status": "Shipment Requested",
            "manual_verification_required": True,
            "source": "email+pdf",
        }
    )
    second = repo.create_shipment(
        {
            "shipment_number": None,
            "invoice_number": "TNSO-240288",
            "po_number": "7531",
            "status": "Shipment Requested",
            "manual_verification_required": True,
            "source": "email+pdf",
        }
    )
    assert second.id == first.id
    assert len(repo.list_shipments()) == 1
    repo.close()


def test_repository_query_dedupes_rows_with_same_invoice(tmp_path):
    repo = Repository(tmp_path / "repo-query-dedupe.db")
    repo.conn.execute(
        """
        INSERT INTO shipments(
            shipment_number, customer, shipper, consignee, lane, invoice_number, bol_number, po_number,
            mx_carrier, us_carrier, status, blocked_reason, pickup_date, eta, pickup_appt, cross_date,
            delivery_date, delivery_appt, created_date, last_update, owner, source, comments, manual_verification_required
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            None, "Arte Sano LLC", None, None, "Oakland, CA -> Austin, TX", "TNSO-240288", None, "7531",
            None, "Sunview", "Pickup Completed", None, "2026-03-09", "2026-03-11", None, None,
            None, None, "2026-03-10T10:00:00+00:00", "2026-03-10T10:00:00+00:00", None, "email+pdf", None, 1,
        ),
    )
    repo.conn.execute(
        """
        INSERT INTO shipments(
            shipment_number, customer, shipper, consignee, lane, invoice_number, bol_number, po_number,
            mx_carrier, us_carrier, status, blocked_reason, pickup_date, eta, pickup_appt, cross_date,
            delivery_date, delivery_appt, created_date, last_update, owner, source, comments, manual_verification_required
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            None, "Arte Sano LLC", None, None, "Oakland, CA -> Austin, TX", "TNSO-240288", None, "7531",
            None, "JB Hunt", "Pickup Completed", None, "2026-03-10", "Pending", None, None,
            None, None, "2026-03-10T10:05:00+00:00", "2026-03-10T10:05:00+00:00", None, "email+pdf", None, 1,
        ),
    )
    repo.conn.commit()
    rows = repo.query_shipments()
    assert len(rows) == 1
    assert rows[0].invoice_number == "TNSO-240288"
    repo.close()


def test_repository_merge_duplicate_shipments_relinks_child_records(tmp_path):
    repo = Repository(tmp_path / "repo-merge-duplicates.db")
    keep = repo.create_shipment(
        {
            "shipment_number": None,
            "invoice_number": "TNSO-240288",
            "po_number": "7531",
            "status": "Shipment Requested",
            "manual_verification_required": True,
            "source": "email+pdf",
        }
    )
    repo.conn.execute(
        """
        INSERT INTO shipments(
            shipment_number, customer, shipper, consignee, lane, invoice_number, bol_number, po_number,
            mx_carrier, us_carrier, status, blocked_reason, pickup_date, eta, pickup_appt, cross_date,
            delivery_date, delivery_appt, created_date, last_update, owner, source, comments, manual_verification_required
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            None, None, None, None, None, "TNSO-240288", None, "7531",
            None, None, "Shipment Requested", None, None, None, None, None,
            None, None, "2026-03-10T10:05:00+00:00", "2026-03-10T10:05:00+00:00", None, "email+pdf", None, 1,
        ),
    )
    dup_id = int(repo.conn.execute("SELECT MAX(id) FROM shipments").fetchone()[0])
    repo.conn.execute(
        """
        INSERT INTO messages(message_id, shipment_id, thread_id, raw_text, timestamp, classification, confidence_score)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("m-dup", dup_id, "t-dup", "body", "2026-03-10T10:05:00+00:00", "Shipment Requested", 0.9),
    )
    repo.conn.commit()
    merged = repo.merge_duplicate_shipments()
    assert merged == 1
    assert len(repo.list_shipments()) == 1
    relinked = repo.get_message_record("m-dup")
    assert relinked is not None
    assert relinked["shipment_id"] == keep.id
    repo.close()


def test_pipeline_sets_us_carrier_from_generic_carrier_phrase(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg = EmailMessage(
        message_id="carrier-1",
        thread_id="carrier-thread-1",
        subject="Follow up",
        body="load has been picked up now, carrier is sunview",
        timestamp=datetime.utcnow(),
    )
    shipment, _flags = pipeline.process_message(msg)
    assert shipment.us_carrier == "Sunview"
    pipeline.close()


def test_pipeline_matches_existing_shipment_by_body_po_reference(tmp_path):
    pipeline = build_pipeline(tmp_path)
    existing = pipeline.repository.create_shipment(
        {
            "shipment_number": None,
            "customer": "Arte Sano LLC",
            "po_number": "7531",
            "status": "Shipment Requested",
            "manual_verification_required": True,
            "source": "email+pdf",
        }
    )
    msg = EmailMessage(
        message_id="body-po-1",
        thread_id=None,
        subject="PO update",
        body="Please update PO 7531. load has been picked up now",
        timestamp=datetime.utcnow(),
    )
    shipment, _flags = pipeline.process_message(msg)
    assert shipment.id == existing.id
    assert shipment.status == "Pickup Completed"
    pipeline.close()


def test_pipeline_does_not_advance_status_for_conditional_pickup_phrase(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg1 = EmailMessage(
        message_id="cond-1",
        thread_id="cond-thread-1",
        subject="new load",
        body="Please schedule pickup",
        timestamp=datetime.utcnow(),
    )
    shipment1, _ = pipeline.process_message(msg1)
    msg2 = EmailMessage(
        message_id="cond-2",
        thread_id="cond-thread-1",
        subject="follow up",
        body="Please let me know when it's picked up",
        timestamp=datetime.utcnow(),
    )
    shipment2, _ = pipeline.process_message(msg2)
    assert shipment1.id == shipment2.id
    assert shipment2.status == "Shipment Requested"
    assert shipment2.pickup_date == "Pending"
    pipeline.close()


def test_pipeline_reply_with_quoted_old_request_still_marks_pickup_completed(tmp_path):
    pipeline = build_pipeline(tmp_path)
    first = EmailMessage(
        message_id="quoted-1",
        thread_id="quoted-thread",
        subject="new load",
        body="Please schedule pickup",
        timestamp=datetime.utcnow(),
    )
    created, _ = pipeline.process_message(first)
    assert created.status == "Shipment Requested"

    follow_up = EmailMessage(
        message_id="quoted-2",
        thread_id="quoted-thread",
        subject="Re: new load",
        body=(
            "Load has been picked up now, carrier is JB Hunt.\n\n"
            "> Please schedule pickup\n"
            "> next load"
        ),
        timestamp=datetime.utcnow(),
    )
    updated, _ = pipeline.process_message(follow_up)
    assert updated.id == created.id
    assert updated.status == "Pickup Completed"
    assert updated.pickup_date != "Pending"
    pipeline.close()


def test_pipeline_sets_pickup_pending_for_conditional_phrase_on_existing_scheduled_row(tmp_path):
    pipeline = build_pipeline(tmp_path)
    first = EmailMessage(
        message_id="cond-pending-seed-1",
        thread_id="cond-pending-thread",
        subject="new load",
        body="Pickup scheduled for tomorrow",
        timestamp=datetime.utcnow(),
    )
    created, _ = pipeline.process_message(first)
    assert created.status == "Pickup Scheduled"
    msg = EmailMessage(
        message_id="cond-pending-1",
        thread_id="cond-pending-thread",
        subject="follow up",
        body="Please let me know when it's picked up",
        timestamp=datetime.utcnow(),
    )
    shipment, _ = pipeline.process_message(msg)
    assert shipment.id == created.id
    assert shipment.status == "Pickup Scheduled"
    assert shipment.pickup_date == "Pending"
    pipeline.close()


def test_pipeline_does_not_set_completion_status_for_question_phrase(tmp_path):
    pipeline = build_pipeline(tmp_path)
    now = datetime.utcnow()
    created, _ = pipeline.process_message(
        EmailMessage(
            message_id="question-1",
            thread_id="question-thread-1",
            subject="New request",
            body="Please schedule pickup",
            timestamp=now,
        )
    )
    assert created.status == "Shipment Requested"

    updated, _ = pipeline.process_message(
        EmailMessage(
            message_id="question-2",
            thread_id="question-thread-1",
            subject="Re: New request",
            body="Has it been picked up?",
            timestamp=now + timedelta(minutes=10),
        )
    )
    assert updated.status == "Shipment Requested"
    assert updated.pickup_date == "Pending"
    pipeline.close()


def test_extract_pickup_date_handles_future_phrase_variant():
    base = datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)
    assert extract_pickup_date("to be picked up tomorrow", base) == "2026-03-11"


def test_intake_service_filter_imap_messages_supports_newer_than_minutes_and_hours():
    now = datetime.now(timezone.utc)

    class Msg:
        def __init__(self, ts, attachments=None):
            self.timestamp = ts
            self.attachments = attachments or []

    messages = [
        Msg(now - timedelta(minutes=20), attachments=["a.pdf"]),
        Msg(now - timedelta(hours=2), attachments=["b.pdf"]),
        Msg(now - timedelta(days=2), attachments=[]),
    ]

    within_60m = IntakeService._filter_imap_messages(messages, "newer_than:60m")
    assert len(within_60m) == 1

    within_3h = IntakeService._filter_imap_messages(messages, "newer_than:3h")
    assert len(within_3h) == 2

    with_attachment = IntakeService._filter_imap_messages(messages, "newer_than:3h has:attachment")
    assert len(with_attachment) == 2


def test_pipeline_sets_eta_pending_for_picked_up_without_eta(tmp_path):
    pipeline = build_pipeline(tmp_path)
    now = datetime.utcnow()
    msg = EmailMessage(
        message_id="eta-pending-1",
        thread_id="eta-thread-1",
        subject="Follow up",
        body="load has been picked up now, carrier is sunview",
        timestamp=now,
    )
    shipment, _flags = pipeline.process_message(msg)
    assert shipment.status == "Pickup Completed"
    assert shipment.pickup_date == now.date().isoformat()
    assert shipment.eta == "Pending"
    pipeline.close()


def test_pipeline_rejects_invalid_eta_before_pickup(tmp_path):
    pipeline = build_pipeline(tmp_path)
    msg = EmailMessage(
        message_id="eta-invalid-1",
        thread_id="eta-thread-2",
        subject="Follow up",
        body="Pickup date 2026-03-10. ETA 2026-03-08",
        timestamp=datetime(2026, 3, 5, 10, 0, tzinfo=timezone.utc),
    )
    shipment, flags = pipeline.process_message(msg)
    assert shipment.pickup_date == "2026-03-10"
    assert shipment.eta is None
    assert any(f.field == "eta" for f in flags)
    assert "Invalid ETA ignored" in (shipment.comments or "")
    pipeline.close()


def test_pickup_date_fallback_uses_update_received_date_for_pickup_completed(tmp_path):
    pipeline = build_pipeline(tmp_path)
    first = EmailMessage(
        message_id="pickup-fallback-1",
        thread_id="pickup-fallback-thread",
        subject="new load",
        body="Please schedule pickup",
        timestamp=datetime(2026, 3, 8, 10, 0),
    )
    shipment, _ = pipeline.process_message(first)
    assert shipment.pickup_date == "Pending"

    follow_up = EmailMessage(
        message_id="pickup-fallback-2",
        thread_id="pickup-fallback-thread",
        subject="follow up",
        body="load has been picked up now",
        timestamp=datetime(2026, 3, 9, 16, 30),
    )
    updated, _ = pipeline.process_message(follow_up)
    assert updated.status == "Pickup Completed"
    assert updated.pickup_date == "2026-03-09"
    pipeline.close()


def test_legal_transition_helper():
    assert is_legal_transition("Pickup Scheduled", "Pickup Completed")
    assert not is_legal_transition("Shipment Requested", "Delivered")
