from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .models import SemanticExtractionResult

SUPPORTED_FIELDS = {
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


class SemanticExtractionError(RuntimeError):
    pass


def _coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_payload(payload: dict[str, Any], settings: dict[str, Any]) -> SemanticExtractionResult:
    body = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    extracted_data = body.get("extracted_data") or body.get("fields") or {}
    if not isinstance(extracted_data, dict):
        raise SemanticExtractionError("semantic payload fields must be an object")
    normalized_fields = {
        key: str(value).strip()
        for key, value in extracted_data.items()
        if key in SUPPORTED_FIELDS and value not in (None, "")
    }
    source_evidence = body.get("source_evidence") or []
    if not isinstance(source_evidence, list):
        source_evidence = [str(source_evidence)]
    return SemanticExtractionResult(
        provider_name=str(settings.get("provider") or "openai"),
        model_name=str(settings.get("model") or "gpt-4.1-mini"),
        schema_name=str(settings.get("schema_name") or "shipment_event_v1"),
        confidence=max(0.0, min(1.0, _coerce_float(body.get("confidence"), default=0.0))),
        extracted_data=normalized_fields,
        status=str(body.get("status")).strip() if body.get("status") else None,
        blocked_reason=str(body.get("blocked_reason")).strip() if body.get("blocked_reason") else None,
        source_evidence=[str(item).strip() for item in source_evidence if str(item).strip()],
        review_notes=str(body.get("review_notes")).strip() if body.get("review_notes") else None,
        raw_payload=payload,
    )


def extract_email_semantics(subject: str, body: str, settings: dict[str, Any]) -> SemanticExtractionResult | None:
    endpoint = str(settings.get("endpoint") or "").strip()
    if not endpoint:
        return None

    timeout = max(1, int(settings.get("timeout_seconds") or 20))
    schema_name = str(settings.get("schema_name") or "shipment_event_v1")
    request_payload = {
        "provider": settings.get("provider") or "openai",
        "model": settings.get("model") or "gpt-4.1-mini",
        "schema_name": schema_name,
        "input": {
            "subject": subject,
            "body": body,
        },
        "expected_output": {
            "status": "optional string",
            "confidence": "required float 0..1",
            "blocked_reason": "optional string",
            "source_evidence": "list of short phrases from the email body",
            "review_notes": "optional string",
            "fields": sorted(SUPPORTED_FIELDS),
        },
    }
    request = Request(
        endpoint,
        data=json.dumps(request_payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise SemanticExtractionError(f"semantic endpoint returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise SemanticExtractionError(f"semantic endpoint connection failed: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise SemanticExtractionError("semantic endpoint returned invalid JSON") from exc

    return _normalize_payload(payload, {**settings, "schema_name": schema_name})
