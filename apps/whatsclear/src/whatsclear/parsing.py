from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone


REPLY_SPLIT_PATTERNS = [
    re.compile(r"(?mi)^\s*On .+wrote:\s*$"),
    re.compile(r"(?mi)^\s*El .+escribi(?:o|\u00f3):\s*$"),
]

GENERIC_CUSTOMER_TOKENS = {
    "customer",
    "customer name",
    "pick up",
    "pickup",
    "pickup address",
    "picking address",
    "delivery",
    "delivery address",
    "address",
    "the next load",
    "next load",
    "load",
}


def extract_shipment_number(text: str) -> str | None:
    patterns = [
        re.compile(r"(?:shipment|load)\s*(?:#|number)?[:\s]+([A-Z0-9-]+)", re.I),
        re.compile(r"\bSHP[- ]?([A-Z0-9-]+)\b", re.I),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(1).strip()
    return None


def extract_lane(text: str) -> str | None:
    # Preferred lane format for dashboard: City, ST -> City, ST
    direct_patterns = [
        re.compile(
            r"(?i)\b([A-Za-z .'-]+,\s*[A-Z]{2,5})\s*->\s*([A-Za-z .'-]+,\s*[A-Z]{2,5})\b"
        ),
        re.compile(
            r"(?i)\bfrom\s+([A-Za-z .'-]+,\s*[A-Z]{2,5})\s+to\s+([A-Za-z .'-]+,\s*[A-Z]{2,5})\b"
        ),
        re.compile(
            r"(?is)\bpick(?:\s|-)?up\s*(?:address|location)?\s*[:\-]\s*([A-Za-z .'-]+,\s*[A-Z]{2,5}).*?\bdeliver(?:y| to)?\s*(?:address|location)?\s*[:\-]\s*([A-Za-z .'-]+,\s*[A-Z]{2,5})"
        ),
        re.compile(
            r"(?is)\bpick(?:\s|-)?up\s*[:\-]\s*([A-Za-z .'-]+,\s*[A-Z]{2,5}).*?\bdelivery\s*[:\-]\s*([A-Za-z .'-]+,\s*[A-Z]{2,5})"
        ),
    ]
    for pattern in direct_patterns:
        match = pattern.search(text)
        if not match:
            continue
        origin = re.sub(r"\s{2,}", " ", match.group(1).strip())
        destination = re.sub(r"\s{2,}", " ", match.group(2).strip())
        return f"{origin} -> {destination}"
    return None


def trim_reply_history(text: str) -> str:
    cutoff = len(text)
    for pattern in REPLY_SPLIT_PATTERNS:
        match = pattern.search(text)
        if match:
            cutoff = min(cutoff, match.start())
    head = text[:cutoff]
    cleaned_lines: list[str] = []
    for raw_line in head.splitlines():
        line = raw_line.strip()
        if not line:
            cleaned_lines.append("")
            continue
        # Ignore quoted/thread history lines from Gmail-style replies.
        if line.startswith(">"):
            continue
        if line.lower().startswith("---------- forwarded message"):
            break
        cleaned_lines.append(raw_line)
    return "\n".join(cleaned_lines).strip()


def extract_carrier(text: str, region: str) -> str | None:
    normalized = text.lower()
    pattern = re.compile(rf"(?:{region}\s*carrier[:\s]+)([A-Za-z0-9 .,&'-]+)", re.I)
    match = pattern.search(normalized)
    if match:
        return match.group(1).strip().title()
    return None


def extract_generic_carrier(text: str) -> str | None:
    patterns = [
        re.compile(r"\bcarrier\s*(?:is|:)\s*([A-Za-z0-9 .,&'-]+)", re.I),
        re.compile(r"\bby\s+carrier\s+([A-Za-z0-9 .,&'-]+)", re.I),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        value = re.split(r"[,;\n]", match.group(1), maxsplit=1)[0].strip()
        if value:
            return value.title()
    return None


COMPANY_SUFFIXES = [
    "inc",
    "llc",
    "ltd",
    "corp",
    "corporation",
    "company",
    "co",
    "sa",
    "s.a.",
    "s.a. de c.v.",
    "logistics",
    "transport",
    "trucking",
    "freight",
    "manufacturing",
]

COMPANY_TRAILING_STOP_WORDS = {
    "today",
    "tomorrow",
    "urgent",
    "asap",
    "please",
}


def _clean_company_name(value: str) -> str:
    cleaned = re.sub(r"\s{2,}", " ", value.strip(" \t:-,.;"))
    parts = cleaned.split()
    while parts and parts[-1].lower() in COMPANY_TRAILING_STOP_WORDS:
        parts.pop()
    cleaned = " ".join(parts)
    return cleaned


def _is_generic_customer_value(value: str) -> bool:
    normalized = re.sub(r"\s{2,}", " ", value.lower().strip(" \t:,.;-"))
    if re.match(r"^po\s*#?\s*[a-z0-9-]+$", normalized):
        return True
    if re.match(r"^(invoice|bol|reference)\s*#?\s*[a-z0-9-]+$", normalized):
        return True
    return normalized in GENERIC_CUSTOMER_TOKENS


def extract_customer_name(text: str) -> str | None:
    """
    Extract likely customer company names from email text using explicit cues first
    and suffix-based proper-noun fallback second.
    """
    explicit_patterns = [
        re.compile(r"(?im)^\s*(?:customer|account|client)\s*[:\-]\s*([A-Z][A-Za-z0-9&.,'()\- ]{2,80}?)\s*$"),
        re.compile(r"(?i)\b(?:for customer|customer is|account is|client is)\s+([A-Z][A-Za-z0-9&.,'()\- ]{2,80}?)(?:[.,;\n]|$)"),
        re.compile(r"(?i)\bfor\s+([A-Z][A-Za-z0-9&.,'()\- ]{2,80}?)(?:\s+(?:on|regarding|about)\b|[.,;\n]|$)"),
    ]
    for pattern in explicit_patterns:
        match = pattern.search(text)
        if match:
            candidate = _clean_company_name(match.group(1))
            if candidate and not _is_generic_customer_value(candidate):
                return candidate

    title_phrase_pattern = re.compile(
        r"\b([A-Z][A-Za-z0-9&'().-]*(?:\s+[A-Z][A-Za-z0-9&'().-]*){1,6})\b"
    )
    for match in title_phrase_pattern.finditer(text):
        candidate = _clean_company_name(match.group(1))
        lowered = candidate.lower().strip(" .,;:-")
        if _is_generic_customer_value(candidate):
            continue
        if any(lowered == suffix or lowered.endswith(f" {suffix}") for suffix in COMPANY_SUFFIXES):
            return candidate
    return None


def extract_invoice_number(text: str) -> str | None:
    patterns = [
        re.compile(r"(?i)\b(?:invoice\s*(?:#|number)?|reference\s*(?:#|number)?)\s*[:\-]?\s*([A-Z0-9-]{4,})\b"),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(1).strip().upper()
    return None


def extract_bol_number(text: str) -> str | None:
    patterns = [
        re.compile(r"(?i)\b(?:bol|bill of lading)\s*(?:#|number)?\s*[:\-]?\s*([A-Z0-9-]{4,})\b"),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(1).strip().upper()
    return None


def extract_po_number(text: str) -> str | None:
    patterns = [
        re.compile(r"(?i)\b(?:po|purchase order)\s*(?:#|number)?\s*[:\-]?\s*([A-Z0-9-]*\d[A-Z0-9-]{1,})\b"),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match.group(1).strip().upper()
    return None


def _to_date_only(value: datetime) -> str:
    return value.date().isoformat()


def _parse_numeric_date(raw: str, reference: datetime) -> str | None:
    token = raw.strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y"):
        try:
            dt = datetime.strptime(token, fmt)
            if fmt in {"%m/%d/%y", "%m-%d-%y"} and dt.year < 2000:
                dt = dt.replace(year=dt.year + 2000)
            return _to_date_only(dt)
        except ValueError:
            continue

    # MM/DD without year fallback, assume current year and roll forward if already passed.
    short_md = re.match(r"^\s*(\d{1,2})/(\d{1,2})\s*$", token)
    if short_md:
        month = int(short_md.group(1))
        day = int(short_md.group(2))
        base = reference.astimezone(timezone.utc).date() if reference.tzinfo else reference.date()
        year = base.year
        try:
            candidate = datetime(year, month, day).date()
        except ValueError:
            return None
        if candidate < base:
            try:
                candidate = datetime(year + 1, month, day).date()
            except ValueError:
                return None
        return candidate.isoformat()

    # DD/MM/YYYY fallback when first number cannot be month.
    match = re.match(r"^\s*(\d{1,2})/(\d{1,2})/(\d{2,4})\s*$", token)
    if not match:
        return None
    first = int(match.group(1))
    second = int(match.group(2))
    year = int(match.group(3))
    if year < 100:
        year += 2000
    if first <= 12:
        return None
    try:
        dt = datetime(year, second, first)
    except ValueError:
        return None
    return _to_date_only(dt)


def _relative_date(keyword: str, reference: datetime) -> str:
    base = reference.astimezone(timezone.utc).date() if reference.tzinfo else reference.date()
    if keyword == "today":
        return base.isoformat()
    if keyword == "tomorrow":
        return (base + timedelta(days=1)).isoformat()
    if keyword == "next week":
        return (base + timedelta(days=7)).isoformat()
    return base.isoformat()


def extract_pickup_date(text: str, reference: datetime) -> str | None:
    patterns = [
        re.compile(r"(?i)\b(?:pick(?:\s|-)?up\s*date|pickup on|pick(?:\s|-)?up on)(?:\s+is)?\s*[:\-]?\s*([0-9/\-]{4,10})\b"),
        re.compile(r"(?i)\b(?:pick(?:\s|-)?up)\s*[:\-]?\s*([0-9/\-]{4,10})\b"),
        re.compile(r"(?i)\bto be picked up(?:\s+on)?\s*[:\-]?\s*([0-9/\-]{4,10})\b"),
        re.compile(r"(?i)\bpicked up(?:\s+on)?\s*[:\-]?\s*([0-9/\-]{4,10})\b"),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        parsed = _parse_numeric_date(match.group(1), reference)
        if parsed:
            return parsed
    rel = re.search(r"(?i)\b(?:pick(?:\s|-)?up|picked up|to be picked up)\s+(today|tomorrow|next week)\b", text)
    if rel:
        return _relative_date(rel.group(1).lower(), reference)
    return None


def extract_eta(text: str, reference: datetime) -> str | None:
    patterns = [
        re.compile(r"(?i)\b(?:eta|e\.t\.a\.|estimated (?:delivery|arrival))(?:\s*date)?(?:\s+is)?\s*[:\-]?\s*([0-9/\-]{4,10})\b"),
        re.compile(r"(?i)\b(?:deliver(?:y)? (?:on|by))\s*[:\-]?\s*([0-9/\-]{4,10})\b"),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        parsed = _parse_numeric_date(match.group(1), reference)
        if parsed:
            return parsed
    rel = re.search(r"(?i)\b(?:eta|deliver(?:y)?)(?:\s*[:\-])?\s*(today|tomorrow|next week|pending)\b", text)
    if rel:
        value = rel.group(1).lower()
        if value == "pending":
            return "Pending"
        return _relative_date(value, reference)

    weekday_with_day = re.search(
        r"(?i)\b(?:eta|deliver(?:y)?(?:\s+date)?)(?:\s+is|[:\-])?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?:st|nd|rd|th)?\b",
        text,
    )
    if weekday_with_day:
        weekday_name = weekday_with_day.group(1).lower()
        day = int(weekday_with_day.group(2))
        weekday_map = {
            "monday": 0,
            "tuesday": 1,
            "wednesday": 2,
            "thursday": 3,
            "friday": 4,
            "saturday": 5,
            "sunday": 6,
        }
        target_weekday = weekday_map[weekday_name]
        base = reference.astimezone(timezone.utc).date() if reference.tzinfo else reference.date()
        month = base.month
        year = base.year
        if day < base.day:
            month += 1
            if month > 12:
                month = 1
                year += 1

        for _ in range(0, 14):
            try:
                candidate = datetime(year, month, day).date()
            except ValueError:
                month += 1
                if month > 12:
                    month = 1
                    year += 1
                continue
            if candidate.weekday() == target_weekday:
                return candidate.isoformat()
            month += 1
            if month > 12:
                month = 1
                year += 1
    return None
