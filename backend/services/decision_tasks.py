"""State/question builders for the decision-model slots.

Each public ``*_request`` function returns the exact ``(state, questions)``
pair :func:`services.decision.decide` expects for one task.  The parsing
helpers turn validated :class:`services.decision.Answer` objects back into the
domain shapes the workflow uses, with deliberate conservatism:

* low confidence never suppresses work - it escalates to the generative LLM,
* a malformed/unknown label is treated as "escalate", never as "skip".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from services.decision import Answer, Question

RECITATION_LEGEND: dict[str, str] = {
    "quran": "Qur'anic recitation",
    "hadith": "A quoted hadith",
    "quote": "Another Arabic quotation (du'a, poem, term)",
    "none": "Thai explanation, framing, or any non-Arabic speech",
}

#: A decision answer below this confidence escalates to the generative passthrough.
MIN_CONFIDENT = 0.6

#: System One requests carry a bounded number of questions each.
RECITATION_BATCH_SIZE = 24
SENTENCE_BATCH_SIZE = 24


def _format_segments(segments: Iterable[dict[str, Any]]) -> str:
    lines: list[str] = []
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", 0.0))
        lines.append(f"#{int(segment['id'])} [{start:.1f}-{end:.1f}] {text}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Step 1 - recitation classification (choice)
# --------------------------------------------------------------------------- #
def recitation_request(
    segments: list[dict[str, Any]],
    *,
    max_questions: int = 64,
) -> tuple[str, dict[str, Question]]:
    """One ``choice`` question per non-empty segment.

    The caller batches at most ``max_questions`` segments per request so a long
    lecture never becomes a single oversized prompt.
    """
    usable = [segment for segment in segments if str(segment.get("text", "")).strip()]
    usable = usable[:max_questions]
    state = (
        "A Thai Tafseer lecture transcript. Speech-to-text often renders spoken "
        "Arabic phonetically in Thai characters. Classify each numbered segment.\n\n"
        + _format_segments(usable)
    )
    classes = ", ".join(RECITATION_LEGEND)
    questions: dict[str, Question] = {}
    for segment in usable:
        segment_id = int(segment["id"])
        questions[f"segment_{segment_id}"] = Question(
            type="choice",
            instructions=(
                f"Classify segment #{segment_id}. Choose exactly one of: {classes}."
            ),
            criteria=dict(RECITATION_LEGEND),
        )
    return state, questions


@dataclass(slots=True)
class RecitationClassification:
    """Decision-model recitation output for one batch."""

    spans: list[dict[str, Any]]
    needs_audit: list[dict[str, Any]]
    answered_ids: set[int]


def _segment_index(segments: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {int(segment["id"]): segment for segment in segments}


def recitation_from_answers(
    segments: list[dict[str, Any]],
    answers: dict[str, Answer],
) -> RecitationClassification:
    """Turn choice answers into audit-compatible spans.

    Segments below ``MIN_CONFIDENT`` (or with an unknown label) land in
    ``needs_audit`` exactly like an unresolved window in the legacy audit, so
    the escalator re-checks them with the big model.
    """
    by_id = _segment_index(segments)
    order = [int(segment["id"]) for segment in segments if int(segment["id"]) in by_id]
    labels: dict[int, str] = {}
    confidences: dict[int, float] = {}
    needs_audit: list[dict[str, Any]] = []

    for segment_id in order:
        answer = answers.get(f"segment_{segment_id}")
        label = (answer.choice if answer else None) or ""
        if label not in RECITATION_LEGEND:
            needs_audit.append(by_id[segment_id])
            continue
        if answer is not None and answer.confidence < MIN_CONFIDENT:
            needs_audit.append(by_id[segment_id])
            # Keep a high-confidence-looking label out of the spans entirely:
            # the audit pass decides, mirroring the legacy unknown path.
            continue
        labels[segment_id] = label
        confidences[segment_id] = answer.confidence if answer else 0.0

    spans: list[dict[str, Any]] = []
    run_start: int | None = None
    run_kind: str | None = None
    run_ids: list[int] = []

    def flush() -> None:
        nonlocal run_start, run_kind, run_ids
        if run_start is None or run_kind is None or not run_ids:
            run_start, run_kind, run_ids = None, None, []
            return
        first = by_id[run_start]
        last = by_id[run_ids[-1]]
        spans.append(
            {
                "start_id": run_start,
                "end_id": run_ids[-1],
                "start": float(first["start"]),
                "end": float(last["end"]),
                "kind": run_kind,
                "reference": "",
                "confidence": min(confidences[item] for item in run_ids),
                "reason": "decision model",
            }
        )
        run_start, run_kind, run_ids = None, None, []

    for segment_id in order:
        label = labels.get(segment_id, "none")
        if label == "none":
            flush()
            continue
        if run_kind is not None and label != run_kind:
            flush()
        if run_start is None:
            run_start = segment_id
            run_kind = label
        run_ids.append(segment_id)
    flush()

    return RecitationClassification(
        spans=spans, needs_audit=needs_audit, answered_ids=set(labels)
    )


# --------------------------------------------------------------------------- #
# Step 1 - sentence boundaries (noul)
# --------------------------------------------------------------------------- #
def sentence_break_request(
    segments: list[dict[str, Any]],
    *,
    target_ids: Iterable[int] | None = None,
    max_questions: int = 64,
) -> tuple[str, dict[str, Question]]:
    """Ask about the gaps after ``target_ids`` only, with the rest as context.

    ``segments`` is the surrounding transcript window; ``target_ids`` are the
    segment ids whose boundary is genuinely uncertain.  A ``None`` target set
    asks about every segment (used by the eval harness).
    """
    wanted = None if target_ids is None else {int(value) for value in target_ids}
    usable = list(segments)
    targets = [
        segment
        for segment in usable
        if wanted is None or int(segment["id"]) in wanted
    ][:max_questions]
    state = (
        "Consecutive Thai transcript segments. Decide where one complete sentence "
        "ends and the next begins.\n\n" + _format_segments(usable)
    )
    questions: dict[str, Question] = {}
    for segment in targets:
        segment_id = int(segment["id"])
        questions[f"break_{segment_id}"] = Question(
            type="noul",
            instructions=(
                f"Does a complete sentence end immediately after segment #{segment_id}?"
            ),
            criteria={
                "true": "The next segment starts a new thought.",
                "false": (
                    "The next segment continues the same sentence or is filler."
                ),
            },
        )
    return state, questions


def sentence_breaks_from_answers(
    answers: dict[str, Answer],
) -> set[int]:
    breaks: set[int] = set()
    for name, answer in answers.items():
        if not name.startswith("break_") or answer.noul is not True:
            continue
        if answer.confidence < 0.5:
            continue
        try:
            breaks.add(int(name.removeprefix("break_")))
        except ValueError:
            continue
    return breaks


__all__ = [
    "MIN_CONFIDENT",
    "RECITATION_LEGEND",
    "RecitationClassification",
    "recitation_from_answers",
    "recitation_request",
    "sentence_break_request",
    "sentence_breaks_from_answers",
]
