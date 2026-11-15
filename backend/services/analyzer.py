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

import json
import logging
import math
import re
import threading
from dataclasses import dataclass
from typing import Any

import httpx

import config
from services.cancel import raise_if_cancelled
from services.transcriber import normalize_language

logger = logging.getLogger("tafseer.analyzer")


class LLMError(RuntimeError):
    """Raised when the configured provider cannot be reached or misbehaves."""


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
            response = await client.post(
                provider.endpoint, headers=headers, json=payload
            )
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


def sanitize_clips(
    raw_clips: list[Any],
    *,
    duration: float,
    excluded_ranges: list[dict[str, float]],
    min_duration: float,
    max_duration: float,
    max_clips: int,
) -> list[dict[str, Any]]:
    """Clamp, filter and order LLM proposals into deterministic clip records."""
    clips: list[dict[str, Any]] = []
    finite_duration = math.isfinite(duration) and duration > 0
    for item in raw_clips:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start"))
            end = float(item.get("end"))
        except (TypeError, ValueError):
            continue

        # ``json.dumps`` happily emits bare NaN/Infinity, which is invalid JSON
        # and crashes the browser parser, so never let them through - even when
        # the transcript duration is unknown (``duration == 0``).
        if not math.isfinite(start) or not math.isfinite(end):
            continue
        if start < 0.0 or end <= 0.0:
            continue

        if finite_duration:
            start = max(0.0, min(start, duration))
            end = max(0.0, min(end, duration))
        if end - start < 1.0:
            continue
        if end - start > max_duration * 1.5:
            continue
        if end - start < min_duration * 0.5:
            continue
        if _overlaps_excluded(start, end, excluded_ranges):
            continue

        title = str(item.get("title") or "").strip() or f"Clip {len(clips) + 1}"
        rationale = str(item.get("rationale") or "").strip()
        clips.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "title": title[:120],
                "rationale": rationale[:400],
            }
        )

    clips.sort(key=lambda clip: clip["start"])

    # Drop overlaps between proposals, keeping the earliest.
    deduped: list[dict[str, Any]] = []
    for clip in clips:
        if deduped and clip["start"] < deduped[-1]["end"]:
            continue
        deduped.append(clip)

    return deduped[:max_clips]


async def discover_clips(
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
        payload = extract_json(reply)
        raw = payload.get("clips")
        if not isinstance(raw, list):
            raise LLMError("The LLM reply is missing a 'clips' array.")
        proposals.extend(raw)

    return sanitize_clips(
        proposals,
        duration=duration,
        excluded_ranges=excluded_ranges,
        min_duration=min_duration,
        max_duration=max_duration,
        max_clips=max_clips,
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
