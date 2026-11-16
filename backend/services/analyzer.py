"""Topic reasoning + Arabic verification against an OpenAI-compatible LLM.

Supports the two modes from the master plan:
* **Cloud mode** - any unified OpenAI-compatible endpoint (``base_url`` +
  ``api_key``, separate reasoning / fast text models).
* **Local mode** - Ollama's OpenAI-compatible server
  (``http://localhost:11434/v1``), no API key required.

The service is deliberately thin: one chat call, strict JSON validation, and
deterministic post-processing (clamping, exclusion filtering, ordering).  No
agent framework, no tool loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import threading
from dataclasses import dataclass
from typing import Any

import httpx

import config
from services import decision_tasks as tasks
from services.cancel import raise_if_cancelled
from services.decision import DecisionProviderConfig, decide
from services.errors import LLMError
from services.transcriber import normalize_language

logger = logging.getLogger("tafseer.analyzer")


# --------------------------------------------------------------------------- #
# Provider configuration
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class ProviderConfig:
    base_url: str
    api_key: str | None
    model: str
    timeout: float

    @property
    def endpoint(self) -> str:
        return self.base_url.rstrip("/") + "/chat/completions"

    def describe(self) -> dict[str, str]:
        return {"base_url": self.base_url, "model": self.model}


def merge_provider(
    model_role: str, override: ProviderOverride | None
) -> ProviderConfig:
    """Environment defaults overlaid with the per-request Settings values."""
    base_url = config.llm_base_url()
    api_key = config.llm_api_key()
    model = (
        config.llm_reasoning_model()
        if model_role == "reasoning"
        else config.llm_fast_model()
    )
    timeout = config.llm_timeout()

    if override is not None:
        base_url = override.base_url or base_url
        if override.api_key is not None:
            api_key = override.api_key
        model = override.model or model
        timeout = override.timeout or timeout

    if not model:
        raise LLMError(
            f"No {model_role} model is configured. Set the model in Settings "
            "or pass 'provider.model' in the request."
        )
    return ProviderConfig(
        base_url=base_url, api_key=api_key, model=model, timeout=timeout
    )


@dataclass(slots=True)
class ProviderOverride:
    """Per-request provider override sent by the Settings drawer."""

    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    timeout: float | None = None


# --------------------------------------------------------------------------- #
# Chat plumbing
# --------------------------------------------------------------------------- #
async def chat(
    provider: ProviderConfig,
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.2,
    json_mode: bool = True,
) -> str:
    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    payload: dict[str, Any] = {
        "model": provider.model,
        "messages": messages,
        "temperature": temperature,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    try:
        async with httpx.AsyncClient(timeout=provider.timeout) as client:
            response: httpx.Response | None = None
            for attempt in range(2):
                try:
                    response = await client.post(
                        provider.endpoint, headers=headers, json=payload
                    )
                except httpx.HTTPError as exc:
                    if attempt == 0:
                        # A single transient drop/read timeout is common on
                        # gateways; retry once before failing the whole pass.
                        await asyncio.sleep(0.6)
                        continue
                    raise LLMError(
                        f"Could not reach the LLM at {provider.endpoint}: {exc}"
                    ) from exc
                break
            if response is None:
                raise LLMError(f"Could not reach the LLM at {provider.endpoint}.")
            if response.status_code == 400 and json_mode:
                # Ollama and some gateways reject response_format: retry plain.
                payload.pop("response_format", None)
                response = await client.post(
                    provider.endpoint, headers=headers, json=payload
                )
    except httpx.HTTPError as exc:
        raise LLMError(
            f"Could not reach the LLM at {provider.endpoint}: {exc}"
        ) from exc

    if response.status_code >= 400:
        raise LLMError(
            f"LLM provider returned {response.status_code}: {response.text[:400]}"
        )

    try:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LLMError(
            f"Unexpected LLM response shape: {response.text[:400]}"
        ) from exc

    if isinstance(content, list):  # some providers return content parts
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return str(content)


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def extract_json(text: str) -> dict[str, Any]:
    """Parse JSON out of an LLM reply, tolerating code fences and prose."""
    cleaned = _FENCE_RE.sub("", text.strip())
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end <= start:
            raise LLMError("The LLM did not return JSON.")
        try:
            parsed = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError as exc:
            raise LLMError(f"The LLM returned invalid JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise LLMError("The LLM returned JSON that is not an object.")
    return parsed


# --------------------------------------------------------------------------- #
# Prompt construction
# --------------------------------------------------------------------------- #
DEFAULT_BASE_PROMPT = (
    "You are a senior Islamic-studies video editor who cuts Tafseer lectures "
    "(Thai with Arabic Quranic recitation) into short social clips. You select "
    "self-contained, emotionally resonant passages that begin and end on a "
    "complete thought."
)

CLIP_SYSTEM_RULES = """\
Return STRICT JSON only, with this exact shape:
{"clips": [{"start": <seconds>, "end": <seconds>, "title": "<Thai title, max 70 chars>", "rationale": "<one sentence in Thai>"}]}

Hard rules:
- Times are absolute seconds from the start of the lecture, floats.
- Every clip must start and end on a complete sentence; never cut mid-verse.
- Clips must not overlap each other and must not overlap any excluded range.
- Respect the requested duration bounds and clip count.
- Arabic Quranic quotes belong inside the clip; do not start a clip in the middle of a recitation.
"""


#: Discovery window budget.  A 1-3 h Tafseer lecture transcribes to roughly
#: 40k-90k characters; 24k-character windows keep every segment in a single
#: provider call, and the whole lecture is covered in at most 8 passes.  Longer
#: transcripts fall back to fewer, proportionally larger windows (see
#: :func:`split_transcript_windows`) rather than dropping their beginning.
TRANSCRIPT_WINDOW_CHARS = 24_000
MAX_DISCOVERY_WINDOWS = 8


def _segment_line(segment: dict[str, Any]) -> str | None:
    start = float(segment.get("start", 0.0))
    end = float(segment.get("end", 0.0))
    text = str(segment.get("text", "")).strip()
    if not text:
        return None
    return f"[{start:.1f}-{end:.1f}] {text}"


def _format_transcript(segments: list[dict[str, Any]]) -> str:
    """Format one discovery window; windowing itself bounds the prompt size."""
    lines = [line for line in (_segment_line(item) for item in segments) if line]
    return "\n".join(lines)


def split_transcript_windows(
    segments: list[dict[str, Any]],
    *,
    max_chars: int = TRANSCRIPT_WINDOW_CHARS,
    max_windows: int = MAX_DISCOVERY_WINDOWS,
) -> list[list[dict[str, Any]]]:
    """Split the transcript into provider-sized windows on segment boundaries.

    Segments are packed greedily into ~``max_chars`` windows (a single oversized
    segment still gets its own window).  If that exceeds ``max_windows`` the
    segments are re-packed into at most ``max_windows`` contiguous groups of
    roughly equal character size, so the entire lecture - including its first
    20-60 % - is always searched within the pass budget.  An empty transcript
    returns one empty window, preserving the previous single-pass prompt.
    """
    prepared: list[tuple[dict[str, Any], str]] = []
    for segment in segments:
        line = _segment_line(segment)
        if line is not None:
            prepared.append((segment, line))
    if not prepared:
        return [[]]

    window_budget = max(1, max_windows)
    char_budget = max(1, max_chars)

    def pack(budget: int) -> list[list[dict[str, Any]]]:
        windows: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        length = 0
        for segment, line in prepared:
            extra = len(line) + (1 if current else 0)
            if current and length + extra > budget:
                windows.append(current)
                current = []
                length = 0
                extra = len(line)
            current.append(segment)
            length += extra
        if current:
            windows.append(current)
        return windows

    windows = pack(char_budget)
    if len(windows) <= window_budget:
        return windows

    # Too many 24k windows for the pass budget: keep full coverage by packing
    # into at most ``window_budget`` contiguous groups of equal share.
    total = sum(len(line) + 1 for _, line in prepared)
    target = total / window_budget
    packed: list[list[dict[str, Any]]] = []
    current = []
    length = 0
    remaining = window_budget
    for segment, line in prepared:
        extra = len(line) + (1 if current else 0)
        if current and remaining > 1 and length + extra > target:
            packed.append(current)
            current = []
            length = 0
            remaining -= 1
            extra = len(line)
        current.append(segment)
        length += extra
    if current:
        packed.append(current)
    return packed


def build_discover_messages(
    *,
    segments: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    min_duration: float,
    max_duration: float,
    max_clips: int,
    language: str,
) -> list[dict[str, str]]:
    system = f"{base_prompt.strip() or DEFAULT_BASE_PROMPT}\n\n{CLIP_SYSTEM_RULES}"
    language_code = normalize_language(language)
    if language_code:
        system += f"- Write titles and rationales in the language '{language_code}'.\n"

    excluded_text = (
        "\n".join(
            f"- {float(r['start']):.1f}s .. {float(r['end']):.1f}s"
            for r in excluded_ranges
        )
        or "- (none)"
    )

    user = f"""\
SESSION TOPIC GUIDE (video specific notes):
{session_guide.strip() or "(none)"}

REFINEMENT NOTE (this re-roll only):
{refinement_note.strip() or "(none)"}

ALREADY APPROVED / EXCLUDED RANGES (never propose inside these):
{excluded_text}

CONSTRAINTS:
- between {min_duration:.0f}s and {max_duration:.0f}s per clip
- at most {max_clips} clips
- propose only inside the unclaimed parts of the lecture

TRANSCRIPT:
{_format_transcript(segments)}
"""
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


# --------------------------------------------------------------------------- #
# Clip discovery
# --------------------------------------------------------------------------- #
def _overlaps_excluded(
    start: float, end: float, excluded: list[dict[str, float]]
) -> bool:
    for item in excluded:
        ex_start = float(item["start"])
        ex_end = float(item["end"])
        if start < ex_end and end > ex_start:
            return True
    return False


def _overlap_between(first: dict[str, Any], second: dict[str, Any]) -> bool:
    return float(first["start"]) < float(second["end"]) and float(
        first["end"]
    ) > float(second["start"])


def sanitize_clips(
    raw_clips: list[Any],
    *,
    duration: float,
    excluded_ranges: list[dict[str, float]],
    min_duration: float,
    max_duration: float,
    max_clips: int,
) -> list[dict[str, Any]]:
    """Clamp, filter and order proposals into deterministic clip records.

    Pinned rules (Phase 4.4):

    =====  =====================================================================
    Rule   Behaviour
    =====  =====================================================================
    R1     A proposal that is not a JSON object is dropped.
    R2     Missing/non-numeric/NaN/Infinity bounds are dropped (never leaks
           invalid JSON to the renderer).
    R3     With a known media duration, bounds are clamped into ``[0, duration]``
           (a duration overrun is clamped, never allowed past the end).
    R4     After clamping, an empty window (``end - start < 1s``) is dropped.
    R5     A too-short window (``< min_duration * 0.5``) is dropped; no
           sentence-safe extension information exists here.
    R6     An oversized window (``> max_duration * 1.5``) is dropped.
    R7     A window overlapping an approved/excluded range is dropped.
    R8     Overlapping proposals are resolved by score rank (higher score first,
           then longer, then earlier) instead of "keep earliest".
    R9     The result is ordered by start time and capped at ``max_clips``.
    R10    Internal ordering keys (``score``) never leave the service.
    =====  =====================================================================
    """
    candidates: list[dict[str, Any]] = []
    finite_duration = math.isfinite(duration) and duration > 0
    for item in raw_clips:
        # R1
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start"))
            end = float(item.get("end"))
        except (TypeError, ValueError):
            continue

        # R2: ``json.dumps`` happily emits bare NaN/Infinity, which is invalid
        # JSON and crashes the browser parser, so never let them through.
        if not math.isfinite(start) or not math.isfinite(end):
            continue

        # R3
        if finite_duration:
            start = max(0.0, min(start, duration))
            end = max(0.0, min(end, duration))
        elif start < 0.0:
            start = 0.0

        length = end - start
        # R4/R5/R6
        if length < 1.0:
            continue
        if length < min_duration * 0.5:
            continue
        if length > max_duration * 1.5:
            continue
        # R7
        if _overlaps_excluded(start, end, excluded_ranges):
            continue

        try:
            score = float(item.get("score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        if not math.isfinite(score):
            score = 0.0

        title = str(item.get("title") or "").strip() or f"Clip {len(candidates) + 1}"
        rationale = str(item.get("rationale") or "").strip()
        candidates.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "title": title[:120],
                "rationale": rationale[:400],
                "_score": max(0.0, min(1.0, score)),
                "_order": len(candidates),
            }
        )

    # R8: score rank, then longer, then earlier, then original order.
    ranked = sorted(
        candidates,
        key=lambda clip: (
            -clip["_score"],
            -(clip["end"] - clip["start"]),
            clip["start"],
            clip["_order"],
        ),
    )
    accepted: list[dict[str, Any]] = []
    for clip in ranked:
        if any(_overlap_between(clip, kept) for kept in accepted):
            continue
        accepted.append(clip)

    # R9 + R10
    accepted.sort(key=lambda clip: clip["start"])
    return [
        {
            "start": clip["start"],
            "end": clip["end"],
            "title": clip["title"],
            "rationale": clip["rationale"],
        }
        for clip in accepted[:max_clips]
    ]


async def _discover_with_prompts(
    *,
    segments: list[dict[str, Any]],
    duration: float,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    provider: ProviderConfig,
    min_duration: float = 15.0,
    max_duration: float = 90.0,
    max_clips: int = 8,
    language: str = "th",
    cancel_event: threading.Event | None = None,
) -> list[dict[str, Any]]:
    """Propose clips across the *whole* lecture, not just its tail.

    The transcript is split into provider-sized windows on segment boundaries
    (``TRANSCRIPT_WINDOW_CHARS``) and the reasoning model is called once per
    window, with at most ``MAX_DISCOVERY_WINDOWS`` passes.  ``max_clips`` is
    divided proportionally across the windows (the remainder goes to the first
    windows); every window keeps its own segment timestamps and the global
    exclusion/dedupe/cap pipeline then runs once over the merged proposals, so
    the response contract is unchanged.  A window whose proportional budget is
    zero is skipped, but ``max_clips >= 1`` and the window count is capped by
    ``max_clips``, so no window is dropped in practice.
    """
    window_budget = min(MAX_DISCOVERY_WINDOWS, max(1, max_clips))
    windows = split_transcript_windows(segments, max_windows=window_budget)
    window_total = len(windows)
    per_window, remainder = divmod(max_clips, window_total)

    proposals: list[Any] = []
    failed_windows = 0
    parsed_windows = 0
    for index, window in enumerate(windows):
        # Natural cancellation boundary: one LLM pass per window; a
        # disconnected client stops before the next provider call.
        raise_if_cancelled(cancel_event)
        budget = per_window + (1 if index < remainder else 0)
        if budget < 1:
            continue
        messages = build_discover_messages(
            segments=window,
            base_prompt=base_prompt,
            session_guide=session_guide,
            refinement_note=refinement_note,
            excluded_ranges=excluded_ranges,
            min_duration=min_duration,
            max_duration=max_duration,
            max_clips=budget,
            language=language,
        )
        reply = await chat(provider, messages, temperature=0.3)
        try:
            payload = extract_json(reply)
            raw = payload.get("clips")
            if not isinstance(raw, list):
                raise LLMError("The LLM reply is missing a 'clips' array.")
        except LLMError as exc:
            # A malformed reply must not lose the window: salvage every complete
            # object that still carries start/end and let the rules table filter
            # the rest. Only a window with nothing salvageable is skipped.
            salvaged = _salvage_clip_objects(reply)
            logger.warning(
                "Clip window %d reply was malformed (%s); salvaged %d proposal(s).",
                index,
                exc,
                len(salvaged),
            )
            if not salvaged:
                failed_windows += 1
                continue
            raw = salvaged
        proposals.extend(raw)
        parsed_windows += 1

    if parsed_windows == 0 and failed_windows:
        raise LLMError(
            "The clip-finding model returned no usable JSON for any transcript "
            "window. Try a different model, or run it again."
        )

    return sanitize_clips(
        proposals,
        duration=duration,
        excluded_ranges=excluded_ranges,
        min_duration=min_duration,
        max_duration=max_duration,
        max_clips=max_clips,
    )


# --------------------------------------------------------------------------- #
# Clip candidate generation + decision scoring (Phase 4)
# --------------------------------------------------------------------------- #
#: Complete objects only; enough to salvage a window whose outer JSON broke.
_OBJECT_RE = re.compile(r"\{[^{}]*\}")


def _salvage_clip_objects(text: str) -> list[dict[str, Any]]:
    """Recover individual ``{start, end, ...}`` objects from a malformed reply."""
    salvaged: list[dict[str, Any]] = []
    for match in _OBJECT_RE.finditer(text or ""):
        try:
            item = json.loads(match.group(0))
        except ValueError:
            continue
        if (
            isinstance(item, dict)
            and "start" in item
            and "end" in item
        ):
            salvaged.append(item)
    return salvaged


_THAI_CHAR = re.compile(r"[\u0E00-\u0E7F]")
_SENTENCE_END = (".", "!", "?", "…", "ฯ", "。", "！", "？")


def _join_segment_text(left: str, right: str) -> str:
    if _THAI_CHAR.search(left) or _THAI_CHAR.search(right):
        return left + right
    return f"{left} {right}".strip()


def _ends_sentence(text: str) -> bool:
    return text.rstrip().endswith(_SENTENCE_END)


def build_sentence_units(
    segments: list[dict[str, Any]],
    *,
    max_chars: int = 220,
    pause: float = 0.9,
) -> list[dict[str, Any]]:
    """Merge transcript segments into deterministic sentence-ish units.

    Boundaries come from the Whisper timestamps (a pause) and terminal
    punctuation; the character cap stops one run-on sentence from swallowing a
    whole window.  No model call is involved.
    """
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for segment in sorted(segments, key=lambda item: float(item.get("start", 0.0))):
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", 0.0))
        if current is None:
            current = {"start": start, "end": end, "text": text, "ids": []}
            continue
        gap = start - current["end"]
        if (
            gap >= pause
            or _ends_sentence(current["text"])
            or len(current["text"]) + len(text) > max_chars
        ):
            units.append(current)
            current = {"start": start, "end": end, "text": text, "ids": []}
        else:
            current["text"] = _join_segment_text(current["text"], text)
            current["end"] = end
    if current is not None:
        units.append(current)
    return units


def generate_clip_candidates(
    segments: list[dict[str, Any]],
    *,
    duration: float,
    excluded_ranges: list[dict[str, float]],
    min_duration: float,
    max_duration: float,
    max_candidates: int = 48,
) -> list[dict[str, Any]]:
    """Deterministic candidate windows: sentence starts, sentence ends, bounds.

    The reasoning LLM no longer invents timestamps from raw text; it only names
    and explains windows that already respect the lecture's sentence and
    duration bounds.
    """
    units = build_sentence_units(segments)
    if not units:
        return []
    finite_duration = math.isfinite(duration) and duration > 0
    candidates: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    stride = max(1, len(units) // max(1, max_candidates // 2))

    def add(start_index: int, end_index: int) -> None:
        if end_index <= start_index:
            return
        start = units[start_index]["start"]
        end = units[end_index - 1]["end"]
        if finite_duration:
            start = max(0.0, min(start, duration))
            end = max(0.0, min(end, duration))
        length = end - start
        if length < min_duration or length > max_duration:
            return
        if _overlaps_excluded(start, end, excluded_ranges):
            return
        key = (round(start, 2), round(end, 2))
        if key in seen:
            return
        seen.add(key)
        text = ""
        for unit in units[start_index:end_index]:
            text = _join_segment_text(text, unit["text"]) if text else unit["text"]
        candidates.append(
            {
                "id": f"cand{len(candidates)}",
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text[:900],
            }
        )

    for start_index in range(0, len(units), stride):
        end_index = start_index + 1
        while (
            end_index <= len(units)
            and units[end_index - 1]["end"] - units[start_index]["start"] < min_duration
        ):
            end_index += 1
        if end_index > len(units):
            break
        add(start_index, end_index)
        # Also offer the longest sentence-aligned window that still fits.
        longest = end_index
        while (
            longest < len(units)
            and units[longest]["end"] - units[start_index]["start"] <= max_duration
        ):
            longest += 1
        if longest > end_index:
            add(start_index, longest)
        if len(candidates) >= max_candidates:
            break
    return candidates[:max_candidates]


CLIP_TITLE_SYSTEM = """\
You name and explain finalist clips for a Thai Tafseer channel. The timestamps
are already decided; never invent, move, or resize a window.

Return STRICT JSON only:
{"clips": [{"id": "<candidate id>", "title": "<Thai title, max 70 chars>", "rationale": "<one sentence in Thai>"}]}

Rules:
- Return exactly one entry per FINALIST id, using the id verbatim.
- The title must describe the moment, not the editing process.
- The rationale names why the passage works as a standalone clip.
"""


def build_title_messages(
    finalists: list[dict[str, Any]],
    *,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    language: str,
    approved_exemplars: list[dict[str, Any]] | None = None,
    rejected_exemplars: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    system = f"{base_prompt.strip() or DEFAULT_BASE_PROMPT}\n\n{CLIP_TITLE_SYSTEM}"
    language_code = normalize_language(language)
    if language_code:
        system += f"- Write titles and rationales in the language '{language_code}'.\n"

    def exemplars(items: list[dict[str, Any]] | None) -> str:
        rows = []
        for item in items or []:
            title = str(item.get("title") or "").strip()
            excerpt = str(item.get("text") or "").strip()
            if not title and not excerpt:
                continue
            rows.append(f"- {title or '(untitled)'}: {excerpt[:280]}")
        return "\n".join(rows) or "- (none)"

    blocks = "\n\n".join(
        f"#{candidate['id']} [{float(candidate['start']):.1f}-"
        f"{float(candidate['end']):.1f}]\n{str(candidate['text']).strip()}"
        for candidate in finalists
    )
    user = f"""\
SESSION TOPIC GUIDE:
{session_guide.strip() or "(none)"}

REFINEMENT NOTE (this re-roll only):
{refinement_note.strip() or "(none)"}

CLIPS THE EDITOR KEPT (imitate their shape):
{exemplars(approved_exemplars)}

CLIPS THE EDITOR PASSED ON (avoid their shape):
{exemplars(rejected_exemplars)}

FINALIST WINDOWS (name these exact ids):
{blocks}
"""
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


async def title_candidates(
    finalists: list[dict[str, Any]],
    *,
    provider: ProviderConfig,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    language: str,
    approved_exemplars: list[dict[str, Any]] | None = None,
    rejected_exemplars: list[dict[str, Any]] | None = None,
) -> dict[str, dict[str, str]]:
    """Ask the writing model for titles/rationales on already-chosen windows."""
    if not finalists:
        return {}
    messages = build_title_messages(
        finalists,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        language=language,
        approved_exemplars=approved_exemplars,
        rejected_exemplars=rejected_exemplars,
    )
    reply = await chat(provider, messages, temperature=0.3)
    payload = extract_json(reply)
    raw = payload.get("clips")
    if not isinstance(raw, list):
        raise LLMError("The LLM reply is missing a 'clips' array.")
    allowed = {str(candidate["id"]) for candidate in finalists}
    named: dict[str, dict[str, str]] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        candidate_id = str(item.get("id") or "").strip()
        if candidate_id not in allowed:
            continue
        named[candidate_id] = {
            "title": str(item.get("title") or "").strip()[:120],
            "rationale": str(item.get("rationale") or "").strip()[:400],
        }
    return named


def _exemplar_brief(
    approved: list[dict[str, Any]] | None,
    rejected: list[dict[str, Any]] | None,
) -> str:
    parts: list[str] = []
    kept = [str(item.get("text") or "").strip() for item in approved or [] if item.get("text")]
    passed = [
        str(item.get("text") or "").strip() for item in rejected or [] if item.get("text")
    ]
    if kept:
        parts.append("KEPT EXCERPTS:\n" + "\n".join(text[:240] for text in kept[:4]))
    if passed:
        parts.append("PASSED EXCERPTS:\n" + "\n".join(text[:240] for text in passed[:4]))
    return "\n\n".join(parts)


async def score_clip_candidates(
    candidates: list[dict[str, Any]],
    *,
    provider: DecisionProviderConfig,
    brief: str,
    min_duration: float,
    max_duration: float,
    cancel_event: threading.Event | None = None,
) -> list[tasks.CandidateScore]:
    """Score candidate windows in small batches; a failure aborts the pass."""
    scored: list[tasks.CandidateScore] = []
    for offset in range(0, len(candidates), 16):
        raise_if_cancelled(cancel_event)
        chunk = candidates[offset : offset + 16]
        payload = [
            tasks.ClipCandidate(
                id=str(candidate["id"]),
                start=float(candidate["start"]),
                end=float(candidate["end"]),
                text=str(candidate["text"]),
            )
            for candidate in chunk
        ]
        state, questions = tasks.clip_scoring_request(
            payload,
            brief=brief,
            min_duration=min_duration,
            max_duration=max_duration,
        )
        answers = await decide(provider, state, questions, cancel_event=cancel_event)
        scored.extend(
            tasks.scores_from_answers([candidate.id for candidate in payload], answers)
        )
    return scored


async def _discover_with_decisions(
    *,
    segments: list[dict[str, Any]],
    duration: float,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    provider: ProviderConfig | None,
    decision_provider: DecisionProviderConfig,
    approved_exemplars: list[dict[str, Any]] | None,
    rejected_exemplars: list[dict[str, Any]] | None,
    min_duration: float,
    max_duration: float,
    max_clips: int,
    language: str,
    cancel_event: threading.Event | None,
) -> list[dict[str, Any]]:
    candidates = generate_clip_candidates(
        segments,
        duration=duration,
        excluded_ranges=excluded_ranges,
        min_duration=min_duration,
        max_duration=max_duration,
    )
    if not candidates:
        return []
    brief_parts = [
        base_prompt.strip(),
        session_guide.strip(),
        refinement_note.strip(),
        _exemplar_brief(approved_exemplars, rejected_exemplars),
    ]
    brief = "\n\n".join(part for part in brief_parts if part)
    scores = await score_clip_candidates(
        candidates,
        provider=decision_provider,
        brief=brief,
        min_duration=min_duration,
        max_duration=max_duration,
        cancel_event=cancel_event,
    )
    by_id = {score.id: score for score in scores}
    ranked = sorted(
        candidates,
        key=lambda candidate: (
            by_id.get(str(candidate["id"]), tasks.CandidateScore(
                id=str(candidate["id"]), score=0.0, complete=False, confidence=0.0
            )).rank_score,
            float(candidate["end"]) - float(candidate["start"]),
        ),
        reverse=True,
    )
    limit = min(max_clips, len(ranked))
    finalists = ranked[:limit]
    clear = [
        candidate
        for candidate in finalists
        if by_id.get(str(candidate["id"]), None) is not None
        and by_id[str(candidate["id"])].rank_score >= 0.2
    ]
    if clear:
        finalists = clear

    titles: dict[str, dict[str, str]] = {}
    if provider is not None:
        try:
            titles = await title_candidates(
                finalists,
                provider=provider,
                base_prompt=base_prompt,
                session_guide=session_guide,
                refinement_note=refinement_note,
                language=language,
                approved_exemplars=approved_exemplars,
                rejected_exemplars=rejected_exemplars,
            )
        except LLMError as exc:
            logger.warning("Title pass failed; using neutral titles: %s", exc)

    records: list[dict[str, Any]] = []
    for candidate in finalists:
        candidate_id = str(candidate["id"])
        naming = titles.get(candidate_id, {})
        fallback_title = str(candidate["text"]).strip()[:60] or f"Clip {len(records) + 1}"
        score = by_id.get(candidate_id)
        records.append(
            {
                "start": float(candidate["start"]),
                "end": float(candidate["end"]),
                "title": naming.get("title") or fallback_title,
                "rationale": naming.get("rationale") or "",
                "score": score.rank_score if score else 0.0,
            }
        )
    return sanitize_clips(
        records,
        duration=duration,
        excluded_ranges=excluded_ranges,
        min_duration=min_duration,
        max_duration=max_duration,
        max_clips=max_clips,
    )


async def discover_clips(
    *,
    segments: list[dict[str, Any]],
    duration: float,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    provider: ProviderConfig | None,
    min_duration: float = 15.0,
    max_duration: float = 90.0,
    max_clips: int = 8,
    language: str = "th",
    cancel_event: threading.Event | None = None,
    decision_provider: DecisionProviderConfig | None = None,
    approved_exemplars: list[dict[str, Any]] | None = None,
    rejected_exemplars: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Propose clips; with a decision slot, score first and write titles last.

    ``decision_provider=None`` (or any decision/title failure) runs today's
    whole-transcript prompt pipeline unchanged.
    """
    if decision_provider is not None:
        try:
            return await _discover_with_decisions(
                segments=segments,
                duration=duration,
                base_prompt=base_prompt,
                session_guide=session_guide,
                refinement_note=refinement_note,
                excluded_ranges=excluded_ranges,
                provider=provider,
                decision_provider=decision_provider,
                approved_exemplars=approved_exemplars,
                rejected_exemplars=rejected_exemplars,
                min_duration=min_duration,
                max_duration=max_duration,
                max_clips=max_clips,
                language=language,
                cancel_event=cancel_event,
            )
        except LLMError as exc:
            logger.warning(
                "Decision clip scoring failed; falling back to the writing model: %s",
                exc,
            )
    if provider is None:
        raise LLMError(
            "No clip-finding model is configured. Choose a model in Settings or "
            "configure a fast-judgment model for clip scoring."
        )
    return await _discover_with_prompts(
        segments=segments,
        duration=duration,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        excluded_ranges=excluded_ranges,
        provider=provider,
        min_duration=min_duration,
        max_duration=max_duration,
        max_clips=max_clips,
        language=language,
        cancel_event=cancel_event,
    )


# --------------------------------------------------------------------------- #
# Arabic verification
# --------------------------------------------------------------------------- #
ARABIC_SYSTEM_PROMPT = """\
You are an Uthmani-script Quranic proofreader for a Thai Tafseer channel.
You receive one Arabic subtitle line (Quranic verse, Hadith, or Islamic term)
and the surrounding Thai explanation. Verify the Arabic spelling, the Uthmani
orthography and the Harakat against authentic scripture.

Return STRICT JSON only:
{"verified_text": "<corrected Arabic, exactly one line>", "correction_applied": <true|false>, "notes": "<short reason, Thai or English>"}

Rules:
- Never translate, never add commentary inside verified_text.
- Never "improve" wording of a Hadith or verse: only fix spelling/orthography.
- If the line is already correct, return it unchanged with correction_applied=false.
- Keep the Arabic RTL order and the diacritics exactly as authenticated.
"""


def _coerce_flag(value: Any) -> bool | None:
    """Parse a provider boolean strictly; never ``bool("false") == True``."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    return None


async def verify_arabic(
    *,
    arabic_text: str,
    context_thai: str,
    provider: ProviderConfig,
) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": ARABIC_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"ARABIC LINE:\n{arabic_text}\n\n"
                f"SURROUNDING THAI CONTEXT:\n{context_thai or '(none)'}"
            ),
        },
    ]
    reply = await chat(provider, messages, temperature=0.0)
    payload = extract_json(reply)

    verified = payload.get("verified_text")
    if not isinstance(verified, str) or not verified.strip():
        raise LLMError("The LLM reply is missing 'verified_text'.")

    verified = verified.strip()
    changed = bool(_coerce_flag(payload.get("correction_applied")))
    if verified != arabic_text.strip():
        changed = True

    notes = payload.get("notes")
    return {
        "verified_text": verified,
        "correction_applied": changed,
        "notes": str(notes).strip() if notes else "",
    }


# --------------------------------------------------------------------------- #
# Arabic recitation audit + sentence grouping (Step 1 enrichment)
# --------------------------------------------------------------------------- #
ARABIC_AUDIT_SYSTEM = """\
You audit Thai Tafseer lecture transcripts for spoken Arabic recitation.
The speech-to-text often renders Arabic phonetically in Thai characters. A
segment is a candidate when its Thai characters spell Arabic speech, even if it
contains no Arabic letters at all. Include the whole phonetic Arabic run and
exclude the Thai framing/explanations around it.

Examples of Thai-script Arabic (these ARE recitation):
- "นะวายีรก็ลลุกมุรฺรี" -> Arabic recitation.
- "อุฟาริจูอ๊สกาละถ้ากุกกล่าวให้พวกเจ้า" -> Arabic recitation.
- "บิสมิลลาฮิรเราะห์มานิรเราะฮีม" -> Arabic recitation.
Examples that are NOT recitation:
- "ท่านนบีได้กล่าวว่า" -> Thai explanation.
- "วันนี้เราจะมาพูดถึงเรื่องความอดทน" -> Thai explanation.
If a line mixes Thai framing and phonetic Arabic, include the segment ids of the
phonetic run; if the provider only gives coarse segments, include the whole
segment with a lower confidence and let the isolated audio pass verify it.

Return STRICT JSON with this exact shape:
{"spans":[{"start_id":<segment id>,"end_id":<segment id>,"kind":"quran"|"hadith"|"quote","reference":"<surah:ayah or hadith reference or empty>","confidence":<0.0-1.0>,"reason":"<short reason>"}]}

Rules:
- The transcript lines are prefixed with `#<id>`. Use those exact ids.
- A span is a contiguous range of ids and must not overlap another span.
- Include a complete phonetic Arabic run; do not include Thai introductions,
  translations, or Thai words that merely mention Arabic.
- Include a span when it is plausibly phonetic Arabic even if you cannot name
  the exact verse; the audio pass and the editor will verify it.
- `reference` is a best-effort hint (e.g. "2:153" or "Bukhari 1") and may be empty.
"""

SENTENCE_SYSTEM = """\
You group a Thai Tafseer transcript into complete sentences for subtitle lines.
You do not rewrite, translate, or punctuate the text.

Return STRICT JSON with this exact shape:
{"groups":[[<segment id>,<segment id>,...], ...]}

Rules:
- Every input id appears exactly once, in order; groups are consecutive.
- Group by complete thoughts/sentences, not by a character limit.
- A sentence may contain many short word/character segments.
- Attach fillers and fragments to the sentence they belong to.
- A very long sentence is still one group; subtitle wrapping happens later.
"""


def _format_indexed_segments(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        lines.append(f"#{int(segment['id'])} {text}")
    return "\n".join(lines)


def _segment_bounds(segments: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {int(segment["id"]): segment for segment in segments}


def _sanitize_spans(
    payload: dict[str, Any],
    by_id: dict[int, dict[str, Any]],
    window_ids: set[int],
) -> list[dict[str, Any]]:
    raw = payload.get("spans")
    if not isinstance(raw, list):
        return []
    spans: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            start_id = int(item.get("start_id"))
            end_id = int(item.get("end_id"))
        except (TypeError, ValueError):
            continue
        if start_id not in window_ids or end_id not in window_ids or end_id < start_id:
            continue
        start_segment = by_id[start_id]
        end_segment = by_id[end_id]
        kind = str(item.get("kind") or "quote").strip().lower()
        if kind not in {"quran", "hadith", "quote"}:
            kind = "quote"
        try:
            confidence = float(item.get("confidence", 0.5))
        except (TypeError, ValueError):
            confidence = 0.5
        confidence = max(0.0, min(1.0, confidence))
        spans.append(
            {
                "start_id": start_id,
                "end_id": end_id,
                "start": float(start_segment["start"]),
                "end": float(end_segment["end"]),
                "kind": kind,
                "reference": str(item.get("reference") or "").strip(),
                "confidence": confidence,
                "reason": str(item.get("reason") or "").strip(),
            }
        )
    spans.sort(key=lambda span: (span["start"], span["end"]))
    # Keep the first of overlapping spans; the model is asked not to overlap.
    cleaned: list[dict[str, Any]] = []
    for span in spans:
        if cleaned and span["start"] < cleaned[-1]["end"]:
            continue
        cleaned.append(span)
    return cleaned


def merge_spans(
    spans: list[dict[str, Any]], *, join_gap: float = 0.75
) -> list[dict[str, Any]]:
    """Merge contiguous spans of the same kind/reference split by a window edge.

    Overlaps keep the earliest span, exactly like the original audit pass.
    """
    merged: list[dict[str, Any]] = []
    for span in sorted(spans, key=lambda item: item["start"]):
        if (
            merged
            and span["start"] - merged[-1]["end"] <= join_gap
            and span["kind"] == merged[-1]["kind"]
            and (span["reference"] or "") == (merged[-1]["reference"] or "")
        ):
            merged[-1]["end"] = max(merged[-1]["end"], span["end"])
            merged[-1]["end_id"] = span["end_id"]
            merged[-1]["confidence"] = max(merged[-1]["confidence"], span["confidence"])
            continue
        merged.append(span)
    return merged


async def audit_arabic(
    *,
    segments: list[dict[str, Any]],
    provider: ProviderConfig,
    cancel_event: threading.Event | None = None,
) -> list[dict[str, Any]]:
    """Find candidate Arabic recitation spans with one LLM pass per window."""
    if not segments:
        return []
    windows = split_transcript_windows(segments)
    by_id = _segment_bounds(segments)
    spans: list[dict[str, Any]] = []
    for window in windows:
        raise_if_cancelled(cancel_event)
        if not window:
            continue
        window_ids = {int(segment["id"]) for segment in window}
        messages = [
            {"role": "system", "content": ARABIC_AUDIT_SYSTEM},
            {
                "role": "user",
                "content": (
                    "TRANSCRIPT WINDOW:\n"
                    f"{_format_indexed_segments(window)}\n\n"
                    "Return the JSON object only."
                ),
            },
        ]
        try:
            reply = await chat(provider, messages, temperature=0.0)
            payload = extract_json(reply)
        except LLMError as exc:
            logger.warning("Arabic audit window failed: %s", exc)
            continue
        spans.extend(_sanitize_spans(payload, by_id, window_ids))

    return merge_spans(spans)


def _sanitize_groups(
    payload: dict[str, Any],
    window_ids: list[int],
) -> list[list[int]] | None:
    raw = payload.get("groups")
    if not isinstance(raw, list) or not raw:
        return None
    groups: list[list[int]] = []
    seen: list[int] = []
    for group in raw:
        if not isinstance(group, list):
            return None
        cleaned: list[int] = []
        for value in group:
            try:
                segment_id = int(value)
            except (TypeError, ValueError):
                return None
            if segment_id not in window_ids or segment_id in cleaned:
                return None
            cleaned.append(segment_id)
        if not cleaned:
            continue
        groups.append(cleaned)
        seen.extend(cleaned)
    if seen != window_ids:
        return None
    return groups


async def group_sentences(
    *,
    segments: list[dict[str, Any]],
    provider: ProviderConfig,
    cancel_event: threading.Event | None = None,
) -> dict[int, int]:
    """Return ``segment id -> sentence index`` from an LLM grouping pass.

    Only Thai segments should be passed.  Invalid or failed windows are left
    ungrouped so the caller can fall back to deterministic pause/segment rules.
    """
    if not segments:
        return {}
    windows = split_transcript_windows(segments)
    mapping: dict[int, int] = {}
    sentence_index = 0
    for window in windows:
        raise_if_cancelled(cancel_event)
        if not window:
            continue
        window_ids = [int(segment["id"]) for segment in window]
        messages = [
            {"role": "system", "content": SENTENCE_SYSTEM},
            {
                "role": "user",
                "content": (
                    "TRANSCRIPT WINDOW:\n"
                    f"{_format_indexed_segments(window)}\n\n"
                    "Return the JSON object only."
                ),
            },
        ]
        try:
            reply = await chat(provider, messages, temperature=0.0)
            payload = extract_json(reply)
        except LLMError as exc:
            logger.warning("Sentence grouping window failed: %s", exc)
            continue
        groups = _sanitize_groups(payload, window_ids)
        if groups is None:
            logger.warning("Sentence grouping returned invalid ids; using fallback.")
            continue
        for group in groups:
            for segment_id in group:
                mapping[segment_id] = sentence_index
            sentence_index += 1
    return mapping


# --------------------------------------------------------------------------- #
# Phase 3 - decision-model recitation and sentence boundaries
# --------------------------------------------------------------------------- #
#: A pause at least this long always ends a sentence.
SENTENCE_PAUSE = 0.9
#: A shorter pause is a maybe: only the decision slot resolves it.
SENTENCE_AMBIGUOUS_PAUSE = 0.4
#: A running sentence longer than this is cut regardless of punctuation.
SENTENCE_MAX_CHARS = 170
#: Segments on either side of a gap that the decision slot sees as context.
SENTENCE_CONTEXT_RADIUS = 2


async def audit_arabic_decision(
    *,
    segments: list[dict[str, Any]],
    provider: DecisionProviderConfig,
    escalator: ProviderConfig | None = None,
    cancel_event: threading.Event | None = None,
) -> list[dict[str, Any]]:
    """Classify recitation with the analysis slot, escalating uncertainty.

    Each batch is one ``choice`` question per segment.  Segments the model is
    unsure about fall through to the windowed generative audit (the escalator);
    a total decision failure degrades to that same audit so Step 1 still finds
    recitation.  With no escalator, unsure segments simply stay Thai.
    """
    usable = [segment for segment in segments if str(segment.get("text", "")).strip()]
    if not usable:
        return []

    spans: list[dict[str, Any]] = []
    unsure: list[dict[str, Any]] = []
    size = tasks.RECITATION_BATCH_SIZE
    try:
        for offset in range(0, len(usable), size):
            raise_if_cancelled(cancel_event)
            batch = usable[offset : offset + size]
            state, questions = tasks.recitation_request(batch)
            answers = await decide(provider, state, questions, cancel_event=cancel_event)
            classification = tasks.recitation_from_answers(batch, answers)
            spans.extend(classification.spans)
            unsure.extend(classification.needs_audit)
    except LLMError as exc:
        if escalator is None:
            raise
        logger.warning("Recitation decision failed; using the windowed audit: %s", exc)
        return await audit_arabic(
            segments=usable, provider=escalator, cancel_event=cancel_event
        )

    if unsure and escalator is not None:
        try:
            spans.extend(
                await audit_arabic(
                    segments=unsure, provider=escalator, cancel_event=cancel_event
                )
            )
        except LLMError as exc:
            logger.warning("Recitation escalator failed; keeping decision spans: %s", exc)
    elif unsure:
        logger.info(
            "%d segment(s) stayed Thai: no escalator model is configured.", len(unsure)
        )
    return merge_spans(spans)


def group_sentences_heuristic(
    segments: list[dict[str, Any]],
) -> tuple[set[int], list[int]]:
    """Deterministic sentence starts from timestamps, punctuation and length.

    Returns ``(starts, ambiguous)``: segment ids that definitely begin a
    sentence, and ids after which a boundary is uncertain (a short-to-medium
    pause with no terminal punctuation).  ``ambiguous`` is exactly the set the
    decision slot is asked about; without a slot the boundary is simply not
    taken, so the grouping stays conservative.
    """
    ordered = [
        segment
        for segment in sorted(segments, key=lambda item: float(item.get("start", 0.0)))
        if str(segment.get("text", "")).strip()
    ]
    starts: set[int] = set()
    ambiguous: list[int] = []
    if not ordered:
        return starts, ambiguous

    first = ordered[0]
    starts.add(int(first["id"]))
    running = str(first["text"]).strip()
    previous = first
    for segment in ordered[1:]:
        text = str(segment["text"]).strip()
        gap = float(segment["start"]) - float(previous["end"])
        too_long = len(running) + len(text) > SENTENCE_MAX_CHARS
        if gap >= SENTENCE_PAUSE or _ends_sentence(running) or too_long:
            starts.add(int(segment["id"]))
            running = text
        else:
            if gap >= SENTENCE_AMBIGUOUS_PAUSE:
                ambiguous.append(int(previous["id"]))
            running = _join_segment_text(running, text)
        previous = segment
    return starts, ambiguous


def rebuild_sentence_map(
    segments: list[dict[str, Any]], starts: set[int]
) -> dict[int, int]:
    """Assign a sentence index to every segment, honouring ``starts``."""
    ordered = sorted(segments, key=lambda item: float(item.get("start", 0.0)))
    mapping: dict[int, int] = {}
    index = -1
    for segment in ordered:
        segment_id = int(segment["id"])
        if index < 0 or segment_id in starts:
            index += 1
        mapping[segment_id] = index
    return mapping


async def sentence_breaks_decision(
    *,
    segments: list[dict[str, Any]],
    candidates: list[int],
    provider: DecisionProviderConfig,
    cancel_event: threading.Event | None = None,
) -> set[int]:
    """Resolve ambiguous sentence gaps with the analysis slot.

    Returns the ids after which a complete sentence ends.  Each request carries
    a small neighbourhood around its targets, so a long lecture never becomes
    one oversized state.
    """
    ordered = [
        segment
        for segment in sorted(segments, key=lambda item: float(item.get("start", 0.0)))
        if str(segment.get("text", "")).strip()
    ]
    wanted = {int(value) for value in candidates}
    if not ordered or not wanted:
        return set()

    position = {int(segment["id"]): index for index, segment in enumerate(ordered)}
    waiting = sorted(segment_id for segment_id in wanted if segment_id in position)
    breaks: set[int] = set()
    size = tasks.SENTENCE_BATCH_SIZE
    for offset in range(0, len(waiting), size):
        raise_if_cancelled(cancel_event)
        chunk = waiting[offset : offset + size]
        keep: set[int] = set()
        for segment_id in chunk:
            index = position[segment_id]
            keep.update(
                range(
                    max(0, index - SENTENCE_CONTEXT_RADIUS),
                    min(len(ordered), index + SENTENCE_CONTEXT_RADIUS + 1),
                )
            )
        window = [ordered[index] for index in sorted(keep)]
        state, questions = tasks.sentence_break_request(window, target_ids=chunk)
        answers = await decide(provider, state, questions, cancel_event=cancel_event)
        breaks.update(tasks.sentence_breaks_from_answers(answers))
    return breaks


async def group_sentences_with_decision(
    *,
    segments: list[dict[str, Any]],
    provider: ProviderConfig | None,
    decision_provider: DecisionProviderConfig | None,
    cancel_event: threading.Event | None = None,
) -> dict[int, int]:
    """Sentence map: heuristics, one triage call for ambiguous gaps, LLM last.

    With no decision slot this is exactly today's single LLM grouping call.
    """
    if decision_provider is None:
        if provider is None:
            return {}
        return await group_sentences(
            segments=segments, provider=provider, cancel_event=cancel_event
        )

    starts, ambiguous = group_sentences_heuristic(segments)
    if ambiguous:
        try:
            breaks = await sentence_breaks_decision(
                segments=segments,
                candidates=ambiguous,
                provider=decision_provider,
                cancel_event=cancel_event,
            )
        except LLMError as exc:
            logger.warning("Sentence decisions failed; using the LLM grouping: %s", exc)
            if provider is not None:
                return await group_sentences(
                    segments=segments, provider=provider, cancel_event=cancel_event
                )
            return rebuild_sentence_map(segments, starts)

        ordered = sorted(segments, key=lambda item: float(item.get("start", 0.0)))
        for left, right in zip(ordered, ordered[1:]):
            if int(left["id"]) in breaks:
                starts.add(int(right["id"]))
    return rebuild_sentence_map(segments, starts)
