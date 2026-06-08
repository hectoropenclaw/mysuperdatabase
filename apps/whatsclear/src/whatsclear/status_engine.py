from __future__ import annotations

CANONICAL_STATUSES = [
    "Shipment Requested",
    "Pickup Scheduled",
    "Pickup Completed",
    "Docs Missing",
    "Docs Sent",
    "Export Cleared",
    "Import Cleared",
    "Filed",
    "Released",
    "Crossed",
    "Dispatch Pending",
    "Dispatched",
    "Delivered",
]


LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "Shipment Requested": {"Pickup Scheduled", "Docs Missing", "Crossed"},
    "Pickup Scheduled": {"Pickup Completed", "Docs Missing"},
    "Pickup Completed": {"Export Cleared", "Filed", "Docs Missing"},
    "Docs Missing": {"Docs Sent"},
    "Docs Sent": {"Filed", "Export Cleared", "Import Cleared"},
    "Export Cleared": {"Filed", "Released", "Crossed"},
    "Import Cleared": {"Dispatch Pending", "Dispatched", "Delivered"},
    "Filed": {"Released", "Docs Missing"},
    "Released": {"Crossed"},
    "Crossed": {"Dispatch Pending", "Dispatched"},
    "Dispatch Pending": {"Dispatched"},
    "Dispatched": {"Delivered"},
    "Delivered": set(),
}

US_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC",
}

MX_STATE_CODES = {
    "AGS", "BC", "BCS", "CAM", "CHIS", "CHIH", "COAH", "COL", "CDMX", "DGO",
    "GTO", "GRO", "HGO", "JAL", "MEX", "MICH", "MOR", "NAY", "NL", "OAX",
    "PUE", "QRO", "QROO", "SLP", "SIN", "SON", "TAB", "TAMPS", "TLAX", "VER",
    "YUC", "ZAC", "TAM", "NLE", "JAL.", "MEX.",
}


def _parse_lane_regions(lane: str | None) -> tuple[str | None, str | None]:
    if not lane:
        return None, None
    parts = [p.strip() for p in lane.split("->", 1)]
    if len(parts) != 2:
        return None, None

    def region(segment: str) -> str | None:
        if "," not in segment:
            return None
        code = segment.rsplit(",", 1)[1].strip().upper().strip(".")
        return code or None

    return region(parts[0]), region(parts[1])


def is_legal_transition(current_status: str | None, next_status: str) -> bool:
    if next_status not in CANONICAL_STATUSES:
        return False
    if not current_status:
        return True
    if current_status == next_status:
        return True
    return next_status in LEGAL_TRANSITIONS.get(current_status, set())


def is_forward_progression(current_status: str | None, next_status: str) -> bool:
    if next_status not in CANONICAL_STATUSES:
        return False
    if not current_status:
        return True
    if current_status == next_status:
        return True
    try:
        return CANONICAL_STATUSES.index(next_status) > CANONICAL_STATUSES.index(current_status)
    except ValueError:
        return False


def apply_handoff_logic(
    lane: str | None,
    status: str | None,
    mx_carrier: str | None,
    us_carrier: str | None,
) -> tuple[str | None, bool]:
    """
    Returns the normalized status and whether Dispatch Pending was forced.
    """
    if not status or status != "Crossed":
        return status, False

    normalized_lane = (lane or "").strip().lower().replace(" ", "")
    export_lane = normalized_lane in {"mx->us", "mxtous", "mexicotous", "mx-us"}
    import_lane = normalized_lane in {"us->mx", "ustomx", "ustomexico", "us-mx"}
    if not export_lane and not import_lane:
        origin_region, destination_region = _parse_lane_regions(lane)
        if origin_region and destination_region:
            export_lane = origin_region in MX_STATE_CODES and destination_region in US_STATE_CODES
            import_lane = origin_region in US_STATE_CODES and destination_region in MX_STATE_CODES

    if export_lane and not us_carrier:
        return "Dispatch Pending", True
    if import_lane and not mx_carrier:
        return "Dispatch Pending", True
    return status, False
