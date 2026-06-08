from __future__ import annotations

import re
from pathlib import Path

from pypdf import PdfReader

from .models import AttachmentExtraction

FIELD_PATTERNS: dict[str, re.Pattern[str]] = {
    "customer": re.compile(r"(?im)^\s*(?:customer name|customer|client|account)\s*[:#]\s*([^\n\r:]{2,120})\s*$"),
    "invoice_number": re.compile(r"(?:invoice\s*#|invoice\s*number|reference\s*#|reference\s*number)\s*[:#]\s*([A-Z0-9-]+)", re.I),
    "bol_number": re.compile(r"(?:\bbol\b\s*#|\bbol\b\s*number|bill of lading\s*#)\s*[:#]?\s*([A-Z0-9-]+)", re.I),
    "po_number": re.compile(r"(?:\bpo\b(?:\s*#|\s*number)?|purchase order)[:\s]+([A-Z0-9-]+)", re.I),
    "origin": re.compile(r"(?:origin[:\s]+)([A-Za-z .'-]+,\s*[A-Za-z]{2})", re.I),
    "destination": re.compile(r"(?:destination[:\s]+)([A-Za-z .'-]+,\s*[A-Za-z]{2})", re.I),
    "total_weight": re.compile(r"(?:total weight[:\s]+)([0-9,]+(?:\.\d+)?)", re.I),
    "total_units": re.compile(r"(?:total units[:\s]+)([0-9,]+)", re.I),
    "invoice_total": re.compile(r"(?:invoice total[:\s]+)\$?([0-9,]+(?:\.\d{2})?)", re.I),
}

SHIPPER_LOCATION_PATTERN = re.compile(r"(?is)\bShipper\b.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Z]{2})")
CONSIGNEE_LOCATION_PATTERN = re.compile(r"(?is)\bConsignee(?:\s*-\s*Inspect.*?|)\b.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Z]{2})")
CITY_STATE_ZIP_PATTERN = re.compile(r"\b([A-Za-z .'-]+),\s*([A-Za-z .'-]+)\s*(\d{5})\b")
GENERIC_LABEL_TOKENS = {"pick up", "pickup", "customer pick up", "picking address", "delivery address", "customer name", "address"}
COMPANY_SUFFIX_PATTERN = re.compile(
    r"\b([A-Z][A-Za-z0-9&'().-]*(?:\s+[A-Z][A-Za-z0-9&'().-]*){0,5}\s+(?:LLC|INC|LTD|CORP|COMPANY|CO))\b"
)


def _clean_token(value: str) -> str:
    return re.sub(r"\s{2,}", " ", value.strip(" \t:,.;"))


def _is_generic_customer_value(value: str) -> bool:
    return _clean_token(value).lower() in GENERIC_LABEL_TOKENS


def _normalize_state(value: str) -> str:
    raw = value.strip().upper().replace(".", "")
    mapping = {
        "CALIFORNIA": "CA",
        "TEXAS": "TX",
        "NUEVO LEON": "NL",
        "ALBERTA": "AB",
        "ILLINOIS": "IL",
        "MINNESOTA": "MN",
        "MICHIGAN": "MI",
        "QUERETARO": "QA",
    }
    return mapping.get(raw, raw)


def _normalize_city(value: str) -> str:
    token = re.sub(r"\s{2,}", " ", value.strip(" \t,.;:"))
    return token.title()


def _city_state(city: str, state: str) -> str:
    return f"{_normalize_city(city)}, {_normalize_state(state)}"


def _extract_stops_lane(text: str) -> str | None:
    pickup = re.search(r"(?is)Stop\s*#1\s*Pickup.*?City\s*ST\s*Zip\s+([A-Za-z .'-]+),\s*([A-Za-z]{2,20})\s+\d{5}", text)
    drop = re.search(r"(?is)Stop\s*#2\s*Drop.*?City\s*ST\s*Zip\s+([A-Za-z .'-]+),\s*([A-Za-z]{2,20})\s+\d{5}", text)
    if pickup and drop:
        return f"{_city_state(pickup.group(1), pickup.group(2))} -> {_city_state(drop.group(1), drop.group(2))}"
    return None


def _extract_bol_lane(text: str) -> str | None:
    shipper = re.search(r"(?is)Shipper.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Za-z]{2,20})\b", text)
    consignee = re.search(r"(?is)Consignee.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Za-z]{2,20})\b", text)
    if shipper and consignee:
        return f"{_city_state(shipper.group(1), shipper.group(2))} -> {_city_state(consignee.group(1), consignee.group(2))}"
    return None


def _extract_release_shipto_supply_lane(text: str) -> str | None:
    ship_to = re.search(r"(?is)\bSHIP TO\s*:\s*\d*\s*\n.*?\n.*?\n([A-Za-z .'-]+)\s+([A-Za-z]{2,20})\s+\d{5}", text)
    supply = re.search(r"(?is)\bSUPPLYING PLANT\b.*?\n.*?\n([A-Za-z .'-]+)\s+([A-Za-z]{2,20})\s+\d{5}", text)
    if ship_to and supply:
        return f"{_city_state(supply.group(1), supply.group(2))} -> {_city_state(ship_to.group(1), ship_to.group(2))}"
    return None


def _extract_release_shipto_customer(text: str) -> str | None:
    match = re.search(r"(?is)\bSHIP TO\s*:\s*\d*\s*\n([^\n]{3,120})", text)
    if not match:
        return None
    candidate = _clean_token(match.group(1)).title()
    if not candidate or _is_generic_customer_value(candidate):
        return None
    return candidate


def _extract_invoice_lane(text: str) -> str | None:
    ship_from = re.search(r"(?is)\bShip from\b.*?\n(?:[^\n]*\n){0,4}([A-Za-z .'-]+),\s*([A-Za-z]{2,20})\s+\d{5}", text)
    ship_to = re.search(r"(?is)\bShip To\b.*?\n(?:[^\n]*\n){0,4}([A-Za-z .'-]+)\s+([A-Za-z]{2,20})\s+[A-Z0-9]{3,10}", text)
    if ship_from and ship_to:
        return f"{_city_state(ship_from.group(1), ship_from.group(2))} -> {_city_state(ship_to.group(1), ship_to.group(2))}"
    return None


def _extract_fields_from_filename(filename: str) -> dict[str, str]:
    extracted: dict[str, str] = {}
    invoice_hint = re.search(r"(?i)\binvoice[_\-\s]*([0-9][0-9A-Za-z_-]{3,})", filename)
    if invoice_hint:
        extracted["invoice_number"] = invoice_hint.group(1).strip().replace("_", "-").upper()
    po_hint = re.search(r"(?i)\bPO[_\-\s#]*([0-9][0-9A-Za-z-]{2,})", filename)
    if po_hint:
        extracted["po_number"] = po_hint.group(1).strip().upper()
    return extracted


def _extract_release_lane(text: str) -> str | None:
    """
    Heuristic for release-instruction style PDFs where pickup and delivery are tabular.
    Expects rows containing city/state/zip values.
    """
    matches = CITY_STATE_ZIP_PATTERN.findall(text)
    if not matches:
        return None

    places = [(city.strip(), _normalize_state(state)) for city, state, _zip in matches]
    # Keep order while removing duplicates.
    deduped: list[tuple[str, str]] = []
    for item in places:
        if item not in deduped:
            deduped.append(item)
    if len(deduped) < 2:
        return None

    # When release docs include Customer/Picking/Delivery columns, pickup is often the
    # second city/state entry and delivery the third.
    if "picking address" in text.lower() and "delivery address" in text.lower() and len(places) >= 3:
        pickup = places[1]
        delivery = places[2]
        return f"{pickup[0]}, {pickup[1]} -> {delivery[0]}, {delivery[1]}"

    origin = deduped[0]
    destination = deduped[1]
    return f"{origin[0]}, {origin[1]} -> {destination[0]}, {destination[1]}"


def _clean_party_value(value: str) -> str:
    candidate = re.split(r"(?i)\b(?:Address|City|St:|Zip|Loc Type|Phone|Driver|Date)\b", value, maxsplit=1)[0]
    return _clean_token(candidate)


def _extract_bol_block(text: str, label: str, end_label: str | None = None) -> str | None:
    if end_label:
        match = re.search(rf"(?is)\b{label}\b(.*?)\b{end_label}\b", text)
    else:
        match = re.search(rf"(?is)\b{label}\b(.*)$", text)
    if not match:
        return None
    return match.group(1)


def _extract_bol_party_name(text: str, label: str, end_label: str | None = None) -> str | None:
    block = _extract_bol_block(text, label, end_label)
    if not block:
        return None
    name_match = re.search(r"(?is)\bName:\s*([^\n]{3,200})", block)
    if not name_match:
        return None
    candidate = _clean_party_value(name_match.group(1))
    return candidate or None


def _extract_bol_structured_fields(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    shipper_name = re.search(r"(?is)ShipperShipper\s*#:\s*Name:\s*([A-Za-z0-9 .,&'()/:-]{3,140}?)\s*Address:", text)
    if not shipper_name:
        shipper_name = re.search(r"(?is)\bShipper(?:Shipper\s*#:\s*)?\s*Name:\s*([A-Za-z0-9 .,&'()/:-]{3,140}?)\s*Address:", text)
    consignee_name = re.search(r"(?is)ConsigneeName:\s*([A-Za-z0-9 .,&'()/:-]{3,140}?)\s*Address:", text)
    if not consignee_name:
        consignee_name = re.search(r"(?is)\bConsignee(?:\s*-\s*Inspect.*?|)\s*Name:\s*([A-Za-z0-9 .,&'()/:-]{3,140}?)\s*Address:", text)
    shipper_city = re.search(
        r"(?is)ShipperShipper\s*#:\s*Name:.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Za-z]{2,20})\s*Zip:",
        text,
    )
    if not shipper_city:
        shipper_city = re.search(
        r"(?is)\bShipper(?:Shipper\s*#:\s*)?\s*Name:.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Za-z]{2,20})\s*Zip:",
        text,
    )
    consignee_city = re.search(
        r"(?is)ConsigneeName:.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Za-z]{2,20})\s*Zip:",
        text,
    )
    if not consignee_city:
        consignee_city = re.search(
            r"(?is)\bConsignee(?:\s*-\s*Inspect.*?|)\s*Name:.*?City:\s*([A-Za-z .'-]+)\s*St:\s*([A-Za-z]{2,20})\s*Zip:",
            text,
        )
    carrier = re.search(r"(?is)\bCarrier:\s*([A-Za-z0-9 .,&'()-]{3,80}?)(?=Driver)", text)

    if shipper_name:
        result["shipper"] = _clean_party_value(shipper_name.group(1))
    if consignee_name:
        result["consignee"] = _clean_party_value(consignee_name.group(1))
    if shipper_city:
        result["shipper_location"] = _city_state(shipper_city.group(1), shipper_city.group(2))
    if consignee_city:
        result["consignee_location"] = _city_state(consignee_city.group(1), consignee_city.group(2))
    if result.get("shipper_location") and result.get("consignee_location"):
        result["lane"] = f"{result['shipper_location']} -> {result['consignee_location']}"
    if carrier:
        result["us_carrier"] = _clean_party_value(carrier.group(1)).title()
    return result


def _extract_fields_from_text(text: str) -> dict[str, str]:
    extracted: dict[str, str] = {}
    for field_name, pattern in FIELD_PATTERNS.items():
        match = pattern.search(text)
        if not match:
            continue
        value = _clean_token(match.group(1))
        if field_name == "customer" and _is_generic_customer_value(value):
            continue
        extracted[field_name] = value

    bol_structured = _extract_bol_structured_fields(text)
    extracted.update({k: v for k, v in bol_structured.items() if v})

    if not extracted.get("customer"):
        crc_customer = re.search(r"(?im)^\s*Customer\s+(.+?)\s+Quote Number\b", text)
        if crc_customer:
            candidate = _clean_token(crc_customer.group(1)).title()
            if candidate and not _is_generic_customer_value(candidate):
                extracted["customer"] = candidate

    if not extracted.get("customer"):
        candidates = [m.group(1).strip() for m in COMPANY_SUFFIX_PATTERN.finditer(text)]
        if candidates:
            # Prefer the most frequent company-like token in the document text.
            counts: dict[str, int] = {}
            for candidate in candidates:
                counts[candidate] = counts.get(candidate, 0) + 1
            extracted["customer"] = sorted(counts.items(), key=lambda item: (-item[1], len(item[0])))[0][0]
    if not extracted.get("customer"):
        ship_to_customer = _extract_release_shipto_customer(text)
        if ship_to_customer:
            extracted["customer"] = ship_to_customer

    shipper_name = _extract_bol_party_name(text, "Shipper", "Consignee")
    if shipper_name and not extracted.get("shipper"):
        extracted["shipper"] = shipper_name
    consignee_name = _extract_bol_party_name(text, "Consignee", "Service Options")
    if not consignee_name:
        consignee_name = _extract_bol_party_name(text, "Consignee")
    if consignee_name and not extracted.get("consignee"):
        extracted["consignee"] = consignee_name

    # Reference number in release instructions can wrap with hyphen line breaks (e.g. TNSO-\n240288).
    if "invoice_number" in extracted and extracted["invoice_number"].endswith("-"):
        continuation = re.search(rf"{re.escape(extracted['invoice_number'])}\s*([0-9]{{3,}})", text, re.I)
        if continuation:
            extracted["invoice_number"] = f"{extracted['invoice_number']}{continuation.group(1)}"
    ref_wrapped = re.search(r"(?is)reference\s*number\s*[:#]?\s*([A-Z]{2,}-?)\s*([0-9]{3,})", text)
    if ref_wrapped:
        extracted["invoice_number"] = f"{ref_wrapped.group(1).strip()}{ref_wrapped.group(2).strip()}"
    invoice_no = re.search(r"(?is)\binvoice\s*(?:no|number|#)\.?\s*[:#]?\s*([A-Z0-9-]{4,})", text)
    if invoice_no:
        extracted["invoice_number"] = invoice_no.group(1).strip().upper()

    shipper_location = SHIPPER_LOCATION_PATTERN.search(text)
    if shipper_location and not extracted.get("shipper_location"):
        extracted["shipper_location"] = f"{shipper_location.group(1).strip()}, {shipper_location.group(2).strip()}"

    consignee_location = CONSIGNEE_LOCATION_PATTERN.search(text)
    if consignee_location and not extracted.get("consignee_location"):
        extracted["consignee_location"] = f"{consignee_location.group(1).strip()}, {consignee_location.group(2).strip()}"

    lane = None
    if extracted.get("origin") and extracted.get("destination"):
        lane = f"{extracted['origin']} -> {extracted['destination']}"
    elif extracted.get("shipper_location") and extracted.get("consignee_location"):
        lane = f"{extracted['shipper_location']} -> {extracted['consignee_location']}"
    elif _extract_stops_lane(text):
        lane = _extract_stops_lane(text)
    elif _extract_bol_lane(text):
        lane = _extract_bol_lane(text)
    elif _extract_release_shipto_supply_lane(text):
        lane = _extract_release_shipto_supply_lane(text)
    elif _extract_invoice_lane(text):
        lane = _extract_invoice_lane(text)
    else:
        lane = _extract_release_lane(text)
    if lane:
        extracted["lane"] = lane

    if not extracted.get("us_carrier"):
        carrier = re.search(r"(?im)^\s*Carrier\s*:\s*([^\r\n]{3,120})\s*$", text)
        if not carrier:
            carrier = re.search(r"(?is)\bCarrier\s*:\s*([A-Za-z0-9 .,'&()-]{3,80}?)(?=\b(?:Driver|Consignee|Shipper|Date|$))", text)
        if carrier:
            candidate = _clean_party_value(carrier.group(1)).title()
            if candidate and "terms of payment" not in candidate.lower():
                extracted["us_carrier"] = candidate

    return extracted


def extract_digital_pdf_fields(pdf_path: str | Path, attachment_id: str) -> AttachmentExtraction:
    path = Path(pdf_path)
    reader = PdfReader(str(path))
    text_chunks: list[str] = []
    for page in reader.pages:
        text_chunks.append(page.extract_text() or "")
    text = "\n".join(text_chunks).strip()

    is_digital_pdf = len(text) > 0
    extracted: dict[str, str] = {}
    if is_digital_pdf:
        extracted = _extract_fields_from_text(text)
    else:
        extracted = _extract_fields_from_filename(path.name)

    extracted["raw_text_length"] = str(len(text))

    return AttachmentExtraction(
        attachment_id=attachment_id,
        filename=path.name,
        storage_url=str(path.resolve()),
        is_digital_pdf=is_digital_pdf,
        extracted_data=extracted,
    )
