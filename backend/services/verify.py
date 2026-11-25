"""Batched Arabic verification: corpus gate -> pure-algorithm span matching.

No generative LLM is involved.  Each line is either an exact Qur'an verse,
an auto-tier span match, a phonetic-rescue match, or reported as needing review.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any

from services import quran
from services.cancel import raise_if_cancelled

logger = logging.getLogger("tafseer.verify")

TRIAGE_BATCH_SIZE = 64

NEEDS_MODEL_NOTE = (
    "A text model is required to proofread lines that are not exact Qur'an "
    "verses. Exact verses are still verified offline against the corpus."
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


def corpus_gate(text: str) -> VerifyOutcome | None:
    stripped = text.strip()
    match = quran.match_text(stripped)
    if match is None:
        return None
    if quran.normalize_arabic(match.arabic) != quran.normalize_arabic(stripped):
        return None
    return VerifyOutcome(
        verified_text=match.arabic,
        correction_applied=match.arabic.strip() != stripped,
        notes=f"Matches the Qur'an corpus ({match.reference}).",
        source="quran",
        reference=match.reference,
        confidence=match.score,
    )


def needs_model_outcome(line: VerifyLine) -> VerifyOutcome:
    return VerifyOutcome(
        verified_text=line.arabic_text,
        correction_applied=False,
        notes=NEEDS_MODEL_NOTE,
        source="needs_model",
        cue_id=line.cue_id,
    )


async def verify_lines(
    lines: list[VerifyLine],
    *,
    provider: Any = None,
    decision_provider: Any = None,
    cancel_event: threading.Event | None = None,
) -> VerifyBatchResult:
    outcomes: list[VerifyOutcome | None] = [None] * len(lines)
    corpus_count = 0
    auto_count = 0

    for index, line in enumerate(lines):
        raise_if_cancelled(cancel_event)
        gated = corpus_gate(line.arabic_text)
        if gated is not None:
            gated.cue_id = line.cue_id
            outcomes[index] = gated
            corpus_count += 1
            continue

        span = quran.match_span(line.arabic_text)
        if span is None or span.tier == "reject":
            outcomes[index] = needs_model_outcome(line)
            continue

        if span.tier == "auto":
            verified = span.matched_canonical.strip() or line.arabic_text
            outcomes[index] = VerifyOutcome(
                verified_text=verified,
                correction_applied=verified != line.arabic_text.strip(),
                notes=f"Matches the Qur'an corpus ({span.reference}).",
                source="quran",
                reference=span.reference,
                confidence=span.score_orthographic,
                cue_id=line.cue_id,
            )
            auto_count += 1
            continue

        if span.tier == "rescue":
            span_len = span.end_word - span.start_word + 1
            if span_len >= 6:
                verified = span.matched_canonical.strip() or line.arabic_text
                outcomes[index] = VerifyOutcome(
                    verified_text=verified,
                    correction_applied=verified != line.arabic_text.strip(),
                    notes=f"Phonetic match ({span.reference}); review recommended.",
                    source="quran",
                    reference=span.reference,
                    confidence=span.score_phonetic,
                    cue_id=line.cue_id,
                )
                auto_count += 1
                continue
            outcomes[index] = VerifyOutcome(
                verified_text=line.arabic_text,
                correction_applied=False,
                notes="Possible Qur'an verse (phonetic match) - review manually.",
                source="needs_model",
                reference=span.reference,
                confidence=span.score_phonetic,
                cue_id=line.cue_id,
            )
            continue

        outcomes[index] = needs_model_outcome(line)

    final: list[VerifyOutcome] = []
    for index, item in enumerate(outcomes):
        if item is None:
            continue
        if item.cue_id is None:
            item.cue_id = lines[index].cue_id
        final.append(item)

    return VerifyBatchResult(
        lines=final,
        model="",
        decision_model=None,
        triage_lines=0,
        proofread_lines=auto_count,
        corpus_lines=corpus_count,
    )


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