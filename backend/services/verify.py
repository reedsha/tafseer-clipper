"""Batched Arabic verification: pure-algorithm offline Qur'an corpus matching.

No generative LLM or triage model is involved.  Each line is matched once against
the bundled Qur'an corpus (exact orthographic, auto-tier span, or phonetic
rescue) and non-Qur'anic lines are returned unchanged as ``unmatched``.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any

from starlette.concurrency import run_in_threadpool

from services import quran, recitation
from services.cancel import raise_if_cancelled

logger = logging.getLogger("tafseer.verify")

UNMATCHED_NOTE = (
    "Not matched in the Qur'an corpus; left unchanged for manual review."
)


@dataclass(slots=True)
class VerifyLine:
    arabic_text: str
    context_thai: str = ""
    cue_id: str | None = None


@dataclass(slots=True)
class VerifyOutcome:
    verified_text: str
    correction_applied: bool
    notes: str
    source: str = "quran"
    reference: str | None = None
    confidence: float | None = None
    cue_id: str | None = None


@dataclass(slots=True)
class VerifyBatchResult:
    lines: list[VerifyOutcome] = field(default_factory=list)
    model: str = ""
    decision_model: str | None = None
    triage_lines: int = 0
    proofread_lines: int = 0
    corpus_lines: int = 0


def unmatched_outcome(
    line: VerifyLine,
    *,
    notes: str = UNMATCHED_NOTE,
    reference: str | None = None,
    confidence: float | None = None,
) -> VerifyOutcome:
    return VerifyOutcome(
        verified_text=line.arabic_text,
        correction_applied=False,
        notes=notes,
        source="unmatched",
        reference=reference,
        confidence=confidence,
        cue_id=line.cue_id,
    )


def verify_line_sync(line: VerifyLine) -> tuple[VerifyOutcome, bool]:
    """Verify one Arabic line against the Qur'an corpus in a single pass.

    Returns ``(outcome, is_exact_corpus_match)``.
    """
    stripped = line.arabic_text.strip()
    if not stripped:
        return unmatched_outcome(line), False

    # Multi-line wrapped subtitles carry internal newlines; normalize spacing
    # before matching and comparing so wrapping does not trigger false edits.
    normalized_in = " ".join(stripped.split())
    span = quran.match_span(normalized_in)
    if span is None or span.tier in ("reject", "uncertain"):
        return unmatched_outcome(line), False

    if span.tier == "auto":
        verified = recitation.replace_slice(normalized_in, span)
        is_exact = (
            quran.normalize_arabic(span.matched_canonical.strip() or normalized_in)
            == quran.normalize_arabic(normalized_in)
        )
        return (
            VerifyOutcome(
                verified_text=verified,
                correction_applied=verified != normalized_in,
                notes=f"Matches the Qur'an corpus ({span.reference}).",
                source="quran",
                reference=span.reference,
                confidence=span.score_orthographic,
                cue_id=line.cue_id,
            ),
            is_exact,
        )

    if span.tier == "rescue":
        span_len = span.end_word - span.start_word + 1
        if span_len >= 6:
            verified = recitation.replace_slice(normalized_in, span)
            return (
                VerifyOutcome(
                    verified_text=verified,
                    correction_applied=verified != normalized_in,
                    notes=f"Phonetic match ({span.reference}); review recommended.",
                    source="quran",
                    reference=span.reference,
                    confidence=span.score_phonetic,
                    cue_id=line.cue_id,
                ),
                False,
            )
        return (
            unmatched_outcome(
                line,
                notes="Possible Qur'an verse (phonetic match) - review manually.",
                reference=span.reference,
                confidence=span.score_phonetic,
            ),
            False,
        )

    return unmatched_outcome(line), False


def _verify_lines_sync(
    lines: list[VerifyLine],
    cancel_event: threading.Event | None = None,
) -> VerifyBatchResult:
    outcomes: list[VerifyOutcome] = []
    corpus_count = 0
    auto_count = 0

    for line in lines:
        raise_if_cancelled(cancel_event)
        outcome, is_exact = verify_line_sync(line)
        outcomes.append(outcome)
        if outcome.source == "quran":
            if is_exact:
                corpus_count += 1
            else:
                auto_count += 1

    return VerifyBatchResult(
        lines=outcomes,
        model="",
        decision_model=None,
        triage_lines=0,
        proofread_lines=auto_count,
        corpus_lines=corpus_count,
    )


async def verify_lines(
    lines: list[VerifyLine],
    *,
    provider: Any = None,  # noqa: ARG001 - kept for older caller signature compatibility
    decision_provider: Any = None,  # noqa: ARG001
    cancel_event: threading.Event | None = None,
) -> VerifyBatchResult:
    return await run_in_threadpool(_verify_lines_sync, lines, cancel_event)


def outcome_payload(outcome: VerifyOutcome) -> dict[str, Any]:
    return {
        "cue_id": outcome.cue_id,
        "verified_text": outcome.verified_text,
        "correction_applied": outcome.correction_applied,
        "notes": outcome.notes,
        "source": outcome.source,
        "reference": outcome.reference,
        "confidence": outcome.confidence,
    }