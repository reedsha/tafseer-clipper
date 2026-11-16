"""Batched Arabic verification: corpus gate -> decision triage -> proofreader.

This is the internal escalation chain from the decision-model plan:

1. **Corpus** - an exact (normalized) Qur'an match passes without any model.
2. **Triage** - one batched ``noul`` request per clip.  Only lines the decision
   model flags reach the expensive proofreader.
3. **Proofread** - today's per-line ``ARABIC_SYSTEM_PROMPT`` call.

With no decision provider the function reproduces the per-line loop exactly:
every non-corpus line is proofread, one call per line.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any

from services import analyzer, decision, decision_tasks, quran
from services.cancel import raise_if_cancelled

logger = logging.getLogger("tafseer.verify")

#: Batches larger than this are split; System One requests stay small.
TRIAGE_BATCH_SIZE = 64


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
    source: str = "proofread"
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
    """Pass a line instantly when it is an exact corpus verse (normalized)."""
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


async def verify_lines(
    lines: list[VerifyLine],
    *,
    provider: analyzer.ProviderConfig | None,
    decision_provider: decision.DecisionProviderConfig | None = None,
    cancel_event: threading.Event | None = None,
) -> VerifyBatchResult:
    """Verify every line through the escalation chain.

    ``provider`` is the fast generative proofreader; it may be ``None`` when the
    caller only has a decision model and every line is gated or triaged away.
    """
    outcomes: list[VerifyOutcome | None] = [None] * len(lines)
    pending: list[int] = []
    corpus_count = 0

    for index, line in enumerate(lines):
        gated = corpus_gate(line.arabic_text)
        if gated is not None:
            gated.cue_id = line.cue_id
            outcomes[index] = gated
            corpus_count += 1
        else:
            pending.append(index)

    triage_count = 0
    proofread_count = 0

    if decision_provider is not None and pending:
        flagged, triaged_ok = await _triage(
            lines, pending, provider=decision_provider, cancel_event=cancel_event
        )
        triage_count = triaged_ok
        if flagged is None:
            # Decision failure: fall back to today's per-line loop, never to a
            # silent "everything is fine".
            flagged = list(pending)
        for index in pending:
            if index in flagged:
                continue
            outcomes[index] = VerifyOutcome(
                verified_text=lines[index].arabic_text,
                correction_applied=False,
                notes="The fast check suggests this line is already correct.",
                source="triage",
            )
        pending = [index for index in pending if index in flagged]

    for index in pending:
        raise_if_cancelled(cancel_event)
        line = lines[index]
        if provider is None:
            raise analyzer.LLMError(
                "A proofreader model is required: the fast check flagged a line "
                "and no text model is configured."
            )
        result = await analyzer.verify_arabic(
            arabic_text=line.arabic_text,
            context_thai=line.context_thai,
            provider=provider,
        )
        proofread_count += 1
        outcomes[index] = VerifyOutcome(
            verified_text=result["verified_text"],
            correction_applied=bool(result["correction_applied"]),
            notes=str(result["notes"]),
            source="proofread",
        )

    final: list[VerifyOutcome] = []
    for index, item in enumerate(outcomes):
        if item is None:
            continue
        if item.cue_id is None:
            # Preserve the caller's cue ids even on the proofread path.
            item.cue_id = lines[index].cue_id
        final.append(item)

    return VerifyBatchResult(
        lines=final,
        model=provider.model if provider else (decision_provider.model if decision_provider else ""),
        decision_model=decision_provider.model if decision_provider else None,
        triage_lines=triage_count,
        proofread_lines=proofread_count,
        corpus_lines=corpus_count,
    )


async def _triage(
    lines: list[VerifyLine],
    indexes: list[int],
    *,
    provider: decision.DecisionProviderConfig,
    cancel_event: threading.Event | None,
) -> tuple[set[int] | None, int]:
    """Return the set of line indexes that need a proofread.

    ``(None, count)`` means the decision model failed; the caller must fall back
    to proofreading every pending line.
    """
    flagged: set[int] = set()
    triaged = 0
    for offset in range(0, len(indexes), TRIAGE_BATCH_SIZE):
        raise_if_cancelled(cancel_event)
        chunk = indexes[offset : offset + TRIAGE_BATCH_SIZE]
        payload = [
            {
                "arabic_text": lines[index].arabic_text,
                "context_thai": lines[index].context_thai,
            }
            for index in chunk
        ]
        state, questions = decision_tasks.verify_triage_request(payload)
        try:
            answers = await decision.decide(
                provider, state, questions, cancel_event=cancel_event
            )
        except decision.DecisionError as exc:
            logger.warning("Verify triage failed; proofreading every line: %s", exc)
            return None, triaged
        decisions = decision_tasks.triage_from_answers(answers, len(chunk))
        for item, line_index in zip(decisions, chunk):
            if item.proofread is not False:
                flagged.add(line_index)
        triaged += len(chunk)
    return flagged, triaged


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
