from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from .models import ClassificationResult
from .status_engine import CANONICAL_STATUSES


DEFAULT_VOCABULARY: dict[str, str] = {
    "shipment requested": "Shipment Requested",
    "pickup scheduled": "Pickup Scheduled",
    "picked up": "Pickup Completed",
    "pickup completed": "Pickup Completed",
    "docs missing": "Docs Missing",
    "missing documents": "Docs Missing",
    "docs sent": "Docs Sent",
    "documents sent": "Docs Sent",
    "export cleared": "Export Cleared",
    "import cleared": "Import Cleared",
    "filed": "Filed",
    "released": "Released",
    "crossed": "Crossed",
    "dispatch pending": "Dispatch Pending",
    "dispatched": "Dispatched",
    "delivered": "Delivered",
}

BLOCKER_PHRASES = [
    "blocked",
    "hold",
    "missing appointment",
    "appointment changed",
    "delay",
]

WORD_BOUNDARY = r"(?<![a-z]){phrase}(?![a-z])"

SCHEDULED_CONTEXT_PATTERNS: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\bready to be picked up\b", re.I), "Pickup Scheduled", 0.9),
    (re.compile(r"\bavailable for pickup\b", re.I), "Pickup Scheduled", 0.88),
    (re.compile(r"\bpick(?:\s|-)?up (?:this week|tomorrow|next week)\b", re.I), "Pickup Scheduled", 0.84),
]

REQUEST_CONTEXT_PATTERNS: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\bplease schedule (?:a\s+)?pick(?:\s|-)?up\b", re.I), "Shipment Requested", 0.94),
    (re.compile(r"\bkindly schedule (?:a\s+)?pick(?:\s|-)?up\b", re.I), "Shipment Requested", 0.93),
    (re.compile(r"\brequest(?:ing)? (?:a\s+)?pick(?:\s|-)?up\b", re.I), "Shipment Requested", 0.92),
    (re.compile(r"\bnext load\b", re.I), "Shipment Requested", 0.87),
]

COMPLETED_CONTEXT_PATTERNS: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\bhas been picked up\b", re.I), "Pickup Completed", 0.93),
    (re.compile(r"\bwas picked up\b", re.I), "Pickup Completed", 0.93),
    (re.compile(r"\bpicked up now\b", re.I), "Pickup Completed", 0.93),
    (re.compile(r"\bpicked up already\b", re.I), "Pickup Completed", 0.93),
    (re.compile(r"\bpicked up by carrier\b", re.I), "Pickup Completed", 0.94),
    (re.compile(r"\bpickup (?:is )?confirmed\b", re.I), "Pickup Completed", 0.94),
    (re.compile(r"\bpickup done\b", re.I), "Pickup Completed", 0.94),
    (re.compile(r"\bpickup completed\b", re.I), "Pickup Completed", 0.95),
    (re.compile(r"\bhas been delivered\b", re.I), "Delivered", 0.95),
    (re.compile(r"\bwas delivered\b", re.I), "Delivered", 0.95),
    (re.compile(r"\bload delivered\b", re.I), "Delivered", 0.93),
    (re.compile(r"\bdelivered today\b", re.I), "Delivered", 0.92),
]

SUPPRESSED_STATUS_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bready to be delivered\b", re.I), "Delivered"),
    (re.compile(r"\bto be delivered\b", re.I), "Delivered"),
    (re.compile(r"\bdelivery date\b", re.I), "Delivered"),
    (re.compile(r"\bready to be picked up\b", re.I), "Pickup Completed"),
    (re.compile(r"\bavailable for pickup\b", re.I), "Pickup Completed"),
    (re.compile(r"\bschedule pick(?:\s|-)?up\b", re.I), "Pickup Completed"),
    (re.compile(r"\bpick(?:\s|-)?up (?:this week|tomorrow|next week)\b", re.I), "Pickup Completed"),
    (re.compile(r"\blet me know when (?:it(?:'s| is)|the load is|load is)?\s*picked up\b", re.I), "Pickup Completed"),
    (re.compile(r"\bconfirm once (?:it(?:'s| is)|the load is|load is)?\s*picked up\b", re.I), "Pickup Completed"),
    (re.compile(r"\b(?:if|when|once)\s+(?:it(?:'s| is)|the load is|load is)?\s*picked up\b", re.I), "Pickup Completed"),
    (re.compile(r"\bto be picked up\b", re.I), "Pickup Completed"),
]


@dataclass(slots=True)
class StatusCandidate:
    status: str
    confidence: float
    source_phrase: str


def _normalize_text(text: str) -> str:
    normalized = text.lower().replace("\r", "\n")
    normalized = re.sub(r"[ \t]+", " ", normalized)
    normalized = re.sub(r"\n{2,}", "\n", normalized)
    return normalized.strip()


def _collect_semantic_candidates(text: str) -> list[StatusCandidate]:
    candidates: list[StatusCandidate] = []
    for pattern, status, confidence in [*REQUEST_CONTEXT_PATTERNS, *SCHEDULED_CONTEXT_PATTERNS, *COMPLETED_CONTEXT_PATTERNS]:
        match = pattern.search(text)
        if not match:
            continue
        candidates.append(
            StatusCandidate(
                status=status,
                confidence=confidence,
                source_phrase=match.group(0),
            )
        )
    return candidates


def _is_suppressed(text: str, status: str) -> bool:
    for pattern, suppressed_status in SUPPRESSED_STATUS_PATTERNS:
        if suppressed_status == status and pattern.search(text):
            return True
    return False


def _collect_vocabulary_candidates(text: str, vocabulary: dict[str, str]) -> list[StatusCandidate]:
    candidates: list[StatusCandidate] = []
    for phrase, mapped_status in vocabulary.items():
        if mapped_status not in CANONICAL_STATUSES:
            continue
        pattern = re.compile(WORD_BOUNDARY.format(phrase=re.escape(phrase)), re.I)
        match = pattern.search(text)
        if not match or _is_suppressed(text, mapped_status):
            continue
        confidence = min(0.9, 0.55 + (len(phrase) / 50))
        candidates.append(
            StatusCandidate(
                status=mapped_status,
                confidence=round(confidence, 2),
                source_phrase=match.group(0),
            )
        )
    return candidates


def _best_candidate(candidates: list[StatusCandidate]) -> StatusCandidate | None:
    if not candidates:
        return None
    return max(candidates, key=lambda c: (c.confidence, len(c.source_phrase)))


def _has_request_intent(text: str) -> bool:
    return any(pattern.search(text) for pattern, _status, _confidence in REQUEST_CONTEXT_PATTERNS)


def _has_completion_evidence(text: str) -> bool:
    return any(pattern.search(text) for pattern, _status, _confidence in COMPLETED_CONTEXT_PATTERNS)


def _has_conditional_pickup_context(text: str) -> bool:
    patterns = [
        re.compile(r"\blet me know when .*picked up\b", re.I),
        re.compile(r"\bconfirm once .*picked up\b", re.I),
        re.compile(r"\bnotify me when .*picked up\b", re.I),
        re.compile(r"\badvise when .*picked up\b", re.I),
        re.compile(r"\b(?:if|when|once)\s+.*picked up\b", re.I),
        re.compile(r"\bto be picked up\b", re.I),
    ]
    return any(pattern.search(text) for pattern in patterns)


LifecycleIntent = Literal["request", "future", "conditional", "question", "correction", "confirmation", "neutral"]


def detect_lifecycle_intent(text: str) -> LifecycleIntent:
    normalized = _normalize_text(text)

    correction_patterns = [
        re.compile(r"\bcorrection\b", re.I),
        re.compile(r"\bignore previous\b", re.I),
        re.compile(r"\bnot picked up\b", re.I),
        re.compile(r"\bnot delivered\b", re.I),
        re.compile(r"\bactually\b", re.I),
    ]
    if any(p.search(normalized) for p in correction_patterns):
        return "correction"

    conditional_patterns = [
        re.compile(r"\blet me know when\b", re.I),
        re.compile(r"\bnotify me when\b", re.I),
        re.compile(r"\bconfirm once\b", re.I),
        re.compile(r"\bif\b.+\bpicked up\b", re.I),
        re.compile(r"\bwhen\b.+\bpicked up\b", re.I),
    ]
    if any(p.search(normalized) for p in conditional_patterns):
        return "conditional"

    question_patterns = [
        re.compile(r"\?$"),
        re.compile(r"\bcan you confirm\b", re.I),
        re.compile(r"\bis it picked up\b", re.I),
        re.compile(r"\bhas it been picked up\b", re.I),
    ]
    if any(p.search(normalized) for p in question_patterns):
        return "question"

    future_patterns = [
        re.compile(r"\bto be picked up\b", re.I),
        re.compile(r"\bready to be picked up\b", re.I),
        re.compile(r"\bpick(?:\s|-)?up (?:tomorrow|next week|this week)\b", re.I),
        re.compile(r"\bwill be picked up\b", re.I),
        re.compile(r"\bdeliver(?:ed|y)? (?:tomorrow|next week|on)\b", re.I),
    ]
    if any(p.search(normalized) for p in future_patterns):
        return "future"

    if _has_request_intent(normalized):
        return "request"

    confirmation_patterns = [
        re.compile(r"\bhas been picked up\b", re.I),
        re.compile(r"\bpicked up now\b", re.I),
        re.compile(r"\bpickup (?:is )?confirmed\b", re.I),
        re.compile(r"\bhas been delivered\b", re.I),
        re.compile(r"\bload delivered\b", re.I),
    ]
    if any(p.search(normalized) for p in confirmation_patterns):
        return "confirmation"

    return "neutral"


def classify_status(
    text: str,
    vocabulary: dict[str, str] | None = None,
    conservative_status_mode: bool = False,
) -> ClassificationResult:
    normalized = _normalize_text(text)
    vocab = vocabulary or DEFAULT_VOCABULARY

    semantic_candidates = _collect_semantic_candidates(normalized)
    vocabulary_candidates = _collect_vocabulary_candidates(normalized, vocab)
    best = _best_candidate([*semantic_candidates, *vocabulary_candidates])

    if best and best.status == "Pickup Completed" and _has_conditional_pickup_context(normalized) and not _has_completion_evidence(normalized):
        best = None

    if conservative_status_mode and _has_request_intent(normalized) and not _has_completion_evidence(normalized):
        if best is None or best.status in {"Pickup Scheduled", "Pickup Completed", "Dispatched", "Delivered"}:
            best = StatusCandidate(status="Shipment Requested", confidence=0.94, source_phrase="request-intent")

    blocked_reason = None
    for blocker in BLOCKER_PHRASES:
        if blocker in normalized:
            blocked_reason = blocker
            break

    return ClassificationResult(
        status=best.status if best else None,
        confidence=best.confidence if best else 0.0,
        blocked_reason=blocked_reason,
        source_phrase=best.source_phrase if best else None,
    )
