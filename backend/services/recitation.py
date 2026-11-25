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
import wave
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from services import quran, transcriber

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


def _arabic_word_indices(words: list[str]) -> list[int]:
    return [i for i, word in enumerate(words) if _ARABIC_SCRIPT.search(word)]


def replace_slice(text: str, span: Any) -> str:
    """Rebuild ``text`` with the matched Arabic slice replaced by canonical text.

    Slice indices from ``match_span`` refer to the *normalized* (Arabic-only)
    word list, so they are mapped back onto the original token list via the
    Arabic-script word positions.  Thai words outside the slice are preserved.
    """
    words = (text or "").split()
    arabic_idx = _arabic_word_indices(words)
    if not arabic_idx:
        return text
    start = int(span.start_word)
    end = int(span.end_word)
    if start >= len(arabic_idx):
        start = len(arabic_idx) - 1
    if end >= len(arabic_idx):
        end = len(arabic_idx) - 1
    if end < start:
        end = start
    start_orig = arabic_idx[start]
    end_orig = arabic_idx[end]
    canonical_words = str(span.matched_canonical or "").split()
    new_words = words[:start_orig] + canonical_words + words[end_orig + 1 :]
    return " ".join(new_words)


def has_thai_outside(text: str, span: Any) -> bool:
    """Whether Thai characters survive outside the matched slice."""
    words = (text or "").split()
    arabic_idx = _arabic_word_indices(words)
    if not arabic_idx:
        return bool(_THAI_CHAR.search(text or ""))
    start = int(span.start_word)
    end = int(span.end_word)
    if start >= len(arabic_idx):
        start = len(arabic_idx) - 1
    if end >= len(arabic_idx):
        end = len(arabic_idx) - 1
    if end < start:
        end = start
    start_orig = arabic_idx[start]
    end_orig = arabic_idx[end]
    outside = words[:start_orig] + words[end_orig + 1 :]
    return any(_THAI_CHAR.search(word) for word in outside)
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


def _replacement_for_span(
    *,
    span: dict[str, Any],
    removed: list[transcriber.Segment],
    arabic_text: str,
) -> transcriber.Segment | None:
    text = re.sub(r"\s+", " ", arabic_text).strip()
    if len(_ARABIC_CHAR.findall(text)) < _MIN_ARABIC_CHARS or _arabic_ratio(text) < _MIN_ARABIC_RATIO:
        return None
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

    span = quran.match_span(text)
    if span is not None and span.tier in ("auto", "rescue"):
        # Only overwrite when the match is strong enough; otherwise keep the
        # verbatim Whisper transcription and merely annotate the reference.
        span_len = span.end_word - span.start_word + 1
        auto = span.tier == "auto" or (span.tier == "rescue" and span_len >= 6)
        if auto:
            text = replace_slice(text, span)
            reference = span.reference
            # Resolve thai translation from the candidate verse if possible.
            try:
                base = span.reference.split("-")[0]
                parts = base.split(":")
                if len(parts) == 2:
                    verse = quran.lookup(int(parts[0]), int(parts[1]))
                    if verse is not None:
                        translation = verse.thai
            except (ValueError, TypeError):  # noqa: BLE001
                pass
            confidence = max(confidence, span.score_orthographic)
            source = "quran"
        else:
            reference = span.reference
            confidence = max(confidence, span.score_phonetic)
            source = "recitation"
    elif span is not None and span.reference:
        reference = span.reference
        confidence = max(confidence, span.score_orthographic)
        source = "recitation"

    return transcriber.Segment(
        id=-1,
        start=start,
        end=end,
        text=text,
        language="ar",
        sentence_id=None,
        source=source,
        reference=reference or None,
        confidence=round(min(1.0, max(0.0, confidence)), 3),
        original_text=_join_original([segment.text for segment in removed]) or None,
        translation=translation,
    )


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
            if cancel_event is not None and cancel_event.is_set():
                break
            start = float(span.get("start") or 0.0)
            end = float(span.get("end") or 0.0)
            if end - start < 0.25:
                continue
            # Temporal interval overlap with boundary splitting.
            removed: list[transcriber.Segment] = []
            split_segments: list[transcriber.Segment] = []
            for segment in ordered:
                if segment.id in removed_ids:
                    continue
                overlap = max(0.0, min(segment.end, end) - max(segment.start, start))
                if overlap <= 0.15:
                    continue
                # Split straddling boundary segments to preserve surrounding speech.
                if segment.start < start - 0.2 and segment.end > start:
                    # Preserve leading Thai speech [segment.start, start].
                    leading = transcriber.Segment(
                        id=segment.id,
                        start=segment.start,
                        end=start,
                        text=segment.text,
                        language=segment.language,
                        sentence_id=segment.sentence_id,
                        source=segment.source,
                        reference=segment.reference,
                        confidence=segment.confidence,
                        original_text=segment.original_text,
                        translation=segment.translation,
                    )
                    split_segments.append(leading)
                    removed.append(segment)
                elif segment.end > end + 0.2 and segment.start < end:
                    trailing = transcriber.Segment(
                        id=segment.id,
                        start=end,
                        end=segment.end,
                        text=segment.text,
                        language=segment.language,
                        sentence_id=segment.sentence_id,
                        source=segment.source,
                        reference=segment.reference,
                        confidence=segment.confidence,
                        original_text=segment.original_text,
                        translation=segment.translation,
                    )
                    split_segments.append(trailing)
                    removed.append(segment)
                else:
                    removed.append(segment)
            if not removed:
                continue
            # Re-insert split boundary fragments into the ordered list later by
            # appending them to `ordered` replacement handling: store on span.
            span["_split_fragments"] = split_segments
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
            replacement = _replacement_for_span(
                span=span, removed=removed, arabic_text=text
            )
            if replacement is None:
                logger.info(
                    "Arabic recovery span %.1f-%.1f did not return Arabic; keeping Thai.",
                    start,
                    end,
                )
                continue
            replacements.append(replacement)
            removed_ids.update(segment.id for segment in removed)
            fragments.extend(span.get("_split_fragments") or [])
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
