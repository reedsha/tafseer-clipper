"""Recover Arabic recitation spans from a Thai-dominated transcript.

The LLM audit proposes spans (usually Thai transliteration of Arabic).  This
service cuts each span out of the extracted 16 kHz WAV, asks the configured STT
engine to transcribe that span alone (Arabic-only audio), checks that the
result really is Arabic, verifies Qur'anic candidates against the bundled
corpus, and replaces the original Thai segments with an Arabic-only segment.

The original Thai transliteration is kept on the replacement (``original_text``)
so the editor can restore it.
"""

from __future__ import annotations

import contextlib
import logging
import re
import unicodedata
import wave
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from services import quran, transcriber
from services.cancel import raise_if_cancelled

logger = logging.getLogger("tafseer.recitation")

SpanTranscriber = Callable[[Path], Awaitable[transcriber.TranscriptionResult]]

#: Extra audio kept on each side of a recitation span.  A frame-exact cut clips
#: the opening/closing syllables and their diacritics during re-transcription.
RECITATION_PAD_SECONDS = 0.3

_ARABIC_CHAR = re.compile(r"[\u0600-\u06FF]")
_THAI_CHAR = re.compile(r"[\u0E00-\u0E7F]")


def _has_arabic_script(text: str) -> bool:
    return bool(re.search(r"[\u0600-\u06FF]", text or ""))


_ARABIC_SCRIPT = re.compile(r"[\u0600-\u06FF]")
_THAI_COMBINING = frozenset(
    "\u0E31\u0E34\u0E35\u0E36\u0E37\u0E38\u0E39\u0E3A\u0E47\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4D\u0E4E"
)


def _orth_to_raw_token_span(
    text: str, span: Any
) -> tuple[list[str], int, int] | None:
    """Map ``span.start_word..span.end_word`` (orthographic words) onto whitespace tokens."""
    words = (text or "").split()
    if not words:
        return None
    orth_to_raw: list[int] = []
    for raw_idx, word in enumerate(words):
        for _orth_tok in quran.normalize_orthographic(word).split():
            orth_to_raw.append(raw_idx)
    if not orth_to_raw:
        return None
    start = max(0, min(len(orth_to_raw) - 1, int(span.start_word)))
    end = max(start, min(len(orth_to_raw) - 1, int(span.end_word)))
    return words, orth_to_raw[start], orth_to_raw[end]


def split_mixed_slice(text: str, span: Any) -> tuple[str, str, str]:
    """Split ``text`` into ``(leading, canonical_arabic, trailing)`` around ``span``."""
    canonical = str(getattr(span, "matched_canonical", "") or "").strip()
    mapped = _orth_to_raw_token_span(text, span)
    if mapped is None:
        return "", canonical or (text or "").strip(), ""
    words, start_orig, end_orig = mapped
    leading = " ".join(words[:start_orig]).strip()
    trailing = " ".join(words[end_orig + 1 :]).strip()
    if not canonical:
        canonical = " ".join(words[start_orig : end_orig + 1]).strip()
    return leading, canonical, trailing


def replace_slice(text: str, span: Any) -> str:
    """Rebuild ``text`` with the matched Arabic slice replaced by canonical text.

    Thai words outside the slice are preserved.
    """
    if _orth_to_raw_token_span(text, span) is None:
        return text
    leading, canonical, trailing = split_mixed_slice(text, span)
    parts = [part for part in (leading, canonical, trailing) if part]
    return " ".join(parts) if parts else text


def has_thai_outside(text: str, span: Any) -> bool:
    """Whether Thai characters survive outside the matched slice."""
    leading, _canonical, trailing = split_mixed_slice(text, span)
    if not leading and not trailing and _orth_to_raw_token_span(text, span) is None:
        return bool(_THAI_CHAR.search(text or ""))
    return bool(_THAI_CHAR.search(leading) or _THAI_CHAR.search(trailing))


def _snap_char_boundary(text: str, approx: int, *, side: str) -> int:
    """Clamp character cut index away from combining marks and snap to spaces when near."""
    n = len(text)
    idx = max(0, min(n, approx))
    if " " in text and 0 < idx < n:
        # Snap to a nearby whitespace boundary when spaces exist (e.g. Arabic/Latin).
        window = max(6, min(20, n // 6))
        if side == "prefix":
            sp = text.rfind(" ", max(0, idx - window), min(n, idx + window))
        else:
            sp = text.find(" ", max(0, idx - window), min(n, idx + window))
        if sp > 0:
            return sp
    # Avoid breaking a combining cluster (Thai/Arabic diacritics).
    while 0 < idx < n and (text[idx] in _THAI_COMBINING or unicodedata.combining(text[idx])):
        idx += 1
    return idx


def _slice_text_by_ratio(text: str, *, end_ratio: float | None = None, start_ratio: float | None = None) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "")).strip()
    if not cleaned:
        return ""
    n = len(cleaned)
    lo = 0 if start_ratio is None else _snap_char_boundary(cleaned, round(n * max(0.0, min(1.0, start_ratio))), side="suffix")
    hi = n if end_ratio is None else _snap_char_boundary(cleaned, round(n * max(0.0, min(1.0, end_ratio))), side="prefix")
    if hi <= lo:
        return ""
    return cleaned[lo:hi].strip()


def split_mixed_segment(
    segment: transcriber.Segment,
    span: Any,
    *,
    leading_text: str,
    canonical_text: str,
    trailing_text: str,
    source: str,
    reference: str | None,
    confidence: float,
    original_text: str | None,
    translation: str | None,
) -> list[transcriber.Segment]:
    """Allocate non-overlapping times for ``leading``, ``canonical``, ``trailing`` parts."""
    start = float(segment.start)
    end = float(segment.end)
    dur = max(0.05, end - start)
    pieces: list[tuple[str, str, bool]] = []
    if leading_text:
        pieces.append(("lead", leading_text, False))
    if canonical_text:
        pieces.append(("ar", canonical_text, True))
    if trailing_text:
        pieces.append(("trail", trailing_text, False))
    if not pieces:
        return []
    weights = [max(1, len(text)) for _, text, _ in pieces]
    total_w = sum(weights)
    out: list[transcriber.Segment] = []
    cursor = start
    for idx, ((_kind, text, is_ar), w) in enumerate(zip(pieces, weights)):
        next_t = end if idx == len(pieces) - 1 else min(end, cursor + dur * (w / total_w))
        if next_t <= cursor:
            next_t = min(end, cursor + 0.01)
        if is_ar:
            out.append(
                transcriber.Segment(
                    id=-1,
                    start=round(cursor, 3),
                    end=round(max(next_t, cursor + 0.01), 3),
                    text=text,
                    language="ar",
                    sentence_id=None,
                    source=source,
                    reference=reference or None,
                    confidence=round(min(1.0, max(0.0, confidence)), 3),
                    original_text=original_text,
                    translation=translation,
                )
            )
        else:
            out.append(
                transcriber.Segment(
                    id=-1,
                    start=round(cursor, 3),
                    end=round(max(next_t, cursor + 0.01), 3),
                    text=text,
                    language=segment.language if segment.language != "ar" else "th",
                    sentence_id=segment.sentence_id,
                    source=segment.source if segment.source != "quran" else None,
                    reference=None,
                    confidence=segment.confidence,
                    original_text=None,
                    translation=None,
                )
            )
        cursor = next_t
    return out
_MIN_ARABIC_CHARS = 4
_MIN_ARABIC_RATIO = 0.45


def slice_wav(source: Path, start: float, end: float, target: Path) -> None:
    """Write ``[start, end)`` from a PCM WAV into ``target`` (same format)."""
    with wave.open(str(source), "rb") as reader:
        rate = reader.getframerate()
        total = reader.getnframes()
        first = max(0, int(round(start * rate)))
        last = min(total, int(round(end * rate)))
        if last <= first:
            raise ValueError("The Arabic span is empty.")
        reader.setpos(first)
        frames = reader.readframes(last - first)
        with wave.open(str(target), "wb") as writer:
            writer.setparams(reader.getparams())
            writer.writeframes(frames)


def _arabic_ratio(text: str) -> float:
    letters = [char for char in text if char.strip()]
    if not letters:
        return 0.0
    arabic = sum(1 for char in letters if _ARABIC_CHAR.match(char))
    return arabic / len(letters)


def _join_original(parts: list[str]) -> str:
    texts = [part.strip() for part in parts if part.strip()]
    if not texts:
        return ""
    # Thai/word-level segments: concatenating is right.  Latin: keep a space.
    if any(_THAI_CHAR.search(text) for text in texts):
        return "".join(texts)
    return " ".join(texts)


def _kind_source(kind: str, verified: bool) -> str:
    if verified:
        return "quran"
    if kind in {"hadith", "quote"}:
        return kind
    return "stt"


def _resolve_span_translation(q_span: Any) -> str | None:
    thai = str(getattr(q_span, "candidate_thai", "") or "").strip()
    if thai:
        return thai
    try:
        base = str(q_span.reference).split("-")[0]
        parts = base.split(":")
        if len(parts) == 2:
            verse = quran.lookup(int(parts[0]), int(parts[1]))
            if verse is not None:
                return verse.thai
    except (ValueError, TypeError):  # noqa: BLE001
        pass
    return None


def _replacements_for_span(
    *,
    span: dict[str, Any],
    removed: list[transcriber.Segment],
    arabic_text: str,
) -> list[transcriber.Segment]:
    text = re.sub(r"\s+", " ", arabic_text).strip()
    if len(_ARABIC_CHAR.findall(text)) < _MIN_ARABIC_CHARS or _arabic_ratio(text) < _MIN_ARABIC_RATIO:
        return []
    start = float(span.get("start") or 0.0)
    end = float(span.get("end") or 0.0)
    if end <= start and removed:
        start = min(segment.start for segment in removed)
        end = max(segment.end for segment in removed)
    kind = str(span.get("kind") or "quote")
    confidence = float(span.get("confidence") or 0.0)
    reference = str(span.get("reference") or "").strip()
    translation: str | None = None
    source = _kind_source(kind, False)
    original_joined = _join_original([segment.text for segment in removed]) or None

    q_span = quran.match_span(text)
    if q_span is not None and q_span.tier in ("auto", "rescue"):
        span_len = q_span.end_word - q_span.start_word + 1
        auto = q_span.tier == "auto" or (q_span.tier == "rescue" and span_len >= 6)
        if auto:
            reference = q_span.reference
            translation = _resolve_span_translation(q_span)
            confidence = max(confidence, q_span.score_orthographic)
            source = "quran"
            if has_thai_outside(text, q_span):
                leading, canonical, trailing = split_mixed_slice(text, q_span)
                return split_mixed_segment(
                    transcriber.Segment(id=-1, start=start, end=end, text=text, language="th"),
                    q_span,
                    leading_text=leading,
                    canonical_text=canonical,
                    trailing_text=trailing,
                    source=source,
                    reference=reference or None,
                    confidence=confidence,
                    original_text=original_joined,
                    translation=translation,
                )
            text = replace_slice(text, q_span)
        else:
            reference = q_span.reference
            confidence = max(confidence, q_span.score_phonetic)
            source = "recitation"
    elif q_span is not None and q_span.reference:
        reference = q_span.reference
        confidence = max(confidence, q_span.score_orthographic)
        source = "recitation"

    language = "th" if _THAI_CHAR.search(text) else "ar"
    return [
        transcriber.Segment(
            id=-1,
            start=start,
            end=end,
            text=text,
            language=language,
            sentence_id=None,
            source=source,
            reference=reference or None,
            confidence=round(min(1.0, max(0.0, confidence)), 3),
            original_text=original_joined,
            translation=translation,
        )
    ]


def _replacement_for_span(
    *,
    span: dict[str, Any],
    removed: list[transcriber.Segment],
    arabic_text: str,
) -> transcriber.Segment | None:
    items = _replacements_for_span(span=span, removed=removed, arabic_text=arabic_text)
    if not items:
        return None
    for item in items:
        if item.language == "ar":
            return item
    return items[0]


async def recover_arabic(
    *,
    wav_path: Path,
    segments: list[transcriber.Segment],
    spans: list[dict[str, Any]],
    transcribe_span: SpanTranscriber,
    cancel_event=None,
) -> list[transcriber.Segment]:
    """Replace audited Thai transliteration with Arabic-only segments.

    ``spans`` are the LLM audit results (absolute times + segment ids).  A span
    is only replaced when the isolated STT pass returns Arabic script; otherwise
    the original Thai segments are kept untouched.
    """
    if not segments or not spans:
        return segments
    ordered = sorted(segments, key=lambda segment: segment.start)
    replacements: list[transcriber.Segment] = []
    fragments: list[transcriber.Segment] = []
    removed_ids: set[int] = set()
    slices: list[Path] = []

    try:
        for span in sorted(spans, key=lambda item: float(item.get("start", 0.0))):
            raise_if_cancelled(cancel_event)
            start = float(span.get("start") or 0.0)
            end = float(span.get("end") or 0.0)
            if end - start < 0.25:
                continue
            # Temporal interval overlap with independent leading & trailing boundary splitting.
            removed: list[transcriber.Segment] = []
            split_segments: list[transcriber.Segment] = []
            for segment in ordered:
                if segment.id in removed_ids:
                    continue
                overlap = max(0.0, min(segment.end, end) - max(segment.start, start))
                if overlap <= 0.15:
                    continue
                seg_dur = max(1e-6, segment.end - segment.start)
                removed.append(segment)
                if segment.start < start - 0.2 and segment.end > start:
                    lead_text = _slice_text_by_ratio(
                        segment.text,
                        end_ratio=(start - segment.start) / seg_dur,
                    )
                    if lead_text:
                        split_segments.append(
                            transcriber.Segment(
                                id=segment.id,
                                start=segment.start,
                                end=start,
                                text=lead_text,
                                language=segment.language,
                                sentence_id=segment.sentence_id,
                                source=segment.source,
                                reference=segment.reference,
                                confidence=segment.confidence,
                                original_text=segment.original_text,
                                translation=segment.translation,
                            )
                        )
                if segment.end > end + 0.2 and segment.start < end:
                    trail_text = _slice_text_by_ratio(
                        segment.text,
                        start_ratio=(end - segment.start) / seg_dur,
                    )
                    if trail_text:
                        split_segments.append(
                            transcriber.Segment(
                                id=segment.id,
                                start=end,
                                end=segment.end,
                                text=trail_text,
                                language=segment.language,
                                sentence_id=segment.sentence_id,
                                source=segment.source,
                                reference=segment.reference,
                                confidence=segment.confidence,
                                original_text=segment.original_text,
                                translation=segment.translation,
                            )
                        )
            if not removed:
                continue
            slice_start = max(0.0, start - RECITATION_PAD_SECONDS)
            slice_end = end + RECITATION_PAD_SECONDS
            target = wav_path.with_name(f"{wav_path.stem}-ar-{len(slices)}.wav")
            slices.append(target)
            try:
                slice_wav(wav_path, slice_start, slice_end, target)
                result = await transcribe_span(target)
            except Exception as exc:  # noqa: BLE001 - a bad span must not fail Step 1
                logger.warning("Arabic recovery span %.1f-%.1f failed: %s", start, end, exc)
                continue
            text = " ".join(
                segment.text.strip() for segment in result.segments if segment.text.strip()
            )
            span_replacements = _replacements_for_span(
                span=span, removed=removed, arabic_text=text
            )
            if not span_replacements:
                logger.info(
                    "Arabic recovery span %.1f-%.1f did not return Arabic; keeping Thai.",
                    start,
                    end,
                )
                continue
            replacements.extend(span_replacements)
            removed_ids.update(segment.id for segment in removed)
            fragments.extend(split_segments)
    finally:
        for path in slices:
            with contextlib.suppress(OSError):
                path.unlink(missing_ok=True)

    if not replacements:
        return ordered

    merged: list[transcriber.Segment] = [
        segment for segment in ordered if segment.id not in removed_ids
    ]
    merged.extend(fragments)
    merged.extend(replacements)
    merged.sort(key=lambda segment: (segment.start, segment.end))
    for index, segment in enumerate(merged):
        segment.id = index
    return merged
