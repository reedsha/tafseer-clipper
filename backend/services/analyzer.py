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
from bisect import bisect_right
from collections.abc import Callable
import json
import logging
import math
import re
import threading
import weakref
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
    #: Resolved once for discovery; ``None`` means "use the safe fallback".
    context_tokens: int | None = None

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
#: Ollama's OpenAI-compatible server defaults to a 2,048-token context, which
#: silently truncates a lecture-length prompt mid-sentence.  Its compat layer
#: reads the native ``options`` block from the request body.
DEFAULT_OLLAMA_NUM_CTX = 8192
#: Unknown OpenAI-compatible gateways keep the previous roomy prompt sizes.
#: Ollama is measured through /api/show and otherwise falls back to 8k.
DEFAULT_CLOUD_CONTEXT_TOKENS = 32_768
#: Reserve room for prompt-estimation error and provider chat-template tokens.
PROMPT_SAFETY_TOKENS = 256
#: Discovery replies need less reserved output than proofreading/grouping.
DISCOVERY_MIN_REPLY_TOKENS = 1024
SELECTION_MIN_REPLY_TOKENS = 512

#: Every current caller asks for strict JSON, so the reply never needs to be
#: unbounded.  A reasoning model left uncapped can spend minutes thinking,
#: blow past the request timeout and bill every token generated before the
#: client aborts.
DEFAULT_MAX_TOKENS = 4096

#: Ask gateways that expose a reasoning switch to answer directly.  Clip
#: finding, titles, grouping and proofreading are deterministic JSON jobs:
#: hidden reasoning only adds latency and cost, and can consume the whole
#: reply budget (``finish_reason == "length"`` with empty content).
REASONING_OFF = {"effort": "none"}


def _reply_budget(
    items: int, *, per_item: int = 160, minimum: int = DEFAULT_MAX_TOKENS
) -> int:
    """Token cap for a JSON reply with one entry per item.

    The floor keeps small calls from ever being cut short; the ceiling stops a
    runaway model from generating for minutes.  ``per_item`` is generous for a
    title + rationale or a handful of ids, so the cap never truncates a valid
    reply at the documented request limits. Discovery uses a smaller floor so
    the output reservation cannot crowd the transcript out of an 8k context.
    """
    return max(minimum, min(16_384, 512 + max(0, items) * per_item))


def _estimate_tokens(text: str) -> int:
    """Conservative prompt estimate without a provider-specific tokenizer.

    ASCII is estimated at four characters per token. Non-ASCII text is counted
    as one token per character: Thai tokenizers vary, so this deliberately
    trades some context efficiency for never assuming an English-like ratio.
    """
    ascii_chars = sum(ord(char) < 128 for char in text)
    non_ascii_chars = len(text) - ascii_chars
    return max(1, math.ceil(ascii_chars / 4 + non_ascii_chars))


def _messages_fit(
    messages: list[dict[str, str]], max_tokens: int, context_tokens: int
) -> bool:
    """Whether prompt + reserved output + template slack fits the context."""
    prompt_tokens = sum(
        _estimate_tokens(message.get("content", "")) + 4 for message in messages
    )
    return prompt_tokens + max_tokens + PROMPT_SAFETY_TOKENS <= context_tokens


def _relax_payload(payload: dict[str, Any], body: str) -> bool:
    """Drop or translate optional keys a provider rejected with HTTP 400.

    Returns ``True`` when the payload changed and the call is worth retrying.
    A 400 is rejected before generation, so probing the supported shape costs
    no tokens.
    """
    lowered = body.lower()
    changed = False
    if "max_completion_tokens" in lowered and "max_tokens" in payload:
        payload["max_completion_tokens"] = payload.pop("max_tokens")
        changed = True
    if "reasoning" in lowered and "reasoning" in payload:
        payload.pop("reasoning", None)
        changed = True
    if "response_format" in lowered and "response_format" in payload:
        payload.pop("response_format", None)
        changed = True
    if not changed and "response_format" in payload:
        # Some gateways reject JSON mode with a generic 400 that never names
        # the field; keep today's plain-reply fallback for them.
        payload.pop("response_format", None)
        changed = True
    return changed


def _transport_error(provider: ProviderConfig, exc: httpx.HTTPError) -> LLMError:
    """Turn a transport failure into a plain, actionable message."""
    if isinstance(exc, httpx.TimeoutException):
        return LLMError(
            f"The AI service did not answer within {provider.timeout:g} seconds. "
            "Try again, or choose a faster model in Settings."
        )
    return LLMError(f"The AI request failed ({type(exc).__name__}). Try again.")


def is_ollama_endpoint(base_url: str, api_key: str | None) -> bool:
    """True only for a local/self-hosted Ollama server.

    Cloud gateways must never receive Ollama-only body keys, so the match is
    deliberately narrow: the standard Ollama port, or a host that names Ollama
    and sends no API key.
    """
    try:
        parsed = httpx.URL(base_url or "")
        port = parsed.port
    except (httpx.InvalidURL, ValueError, TypeError):
        return False
    host = (parsed.host or "").strip().lower()
    if not host:
        return False
    if port == 11434:
        return True
    return "ollama" in host and not api_key


def _ollama_show_endpoint(base_url: str) -> str:
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    return root + "/api/show"


_HTTP_CLIENTS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient] = (
    weakref.WeakKeyDictionary()
)
_DROPPED_KEYS_CACHE: dict[tuple[str, str], set[str]] = {}


def _get_shared_client() -> httpx.AsyncClient:
    """Per-event-loop pooled HTTP client for LLM chat and metadata calls."""
    loop = asyncio.get_running_loop()
    client = _HTTP_CLIENTS.get(loop)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10)
        )
        _HTTP_CLIENTS[loop] = client
    return client


async def close_http_client() -> None:
    """Close pooled HTTP clients on sidecar shutdown."""
    clients = list(_HTTP_CLIENTS.values())
    _HTTP_CLIENTS.clear()
    _DROPPED_KEYS_CACHE.clear()
    for client in clients:
        if not client.is_closed:
            await client.aclose()


async def resolve_context_tokens(
    provider: ProviderConfig, *, transport: httpx.AsyncBaseTransport | None = None
) -> int:
    """Resolve the model context once, without guessing from the model name.

    Ollama exposes the architecture's real context length through ``/api/show``.
    Other OpenAI-compatible gateways have no standard equivalent, so they keep
    a 32k planning fallback. A failed probe falls back to 8k for Ollama and is
    cached on this provider instance for the rest of the discovery run.
    """
    if provider.context_tokens and provider.context_tokens > 0:
        return provider.context_tokens
    if not is_ollama_endpoint(provider.base_url, provider.api_key):
        return DEFAULT_CLOUD_CONTEXT_TOKENS

    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    timeout = min(provider.timeout, 10.0)
    try:
        if transport is None:
            response = await _get_shared_client().post(
                _ollama_show_endpoint(provider.base_url),
                headers=headers,
                # Newer Ollama accepts "model"; older releases used "name".
                json={"model": provider.model, "name": provider.model},
                timeout=timeout,
            )
        else:
            async with httpx.AsyncClient(
                timeout=timeout, transport=transport
            ) as client:
                response = await client.post(
                    _ollama_show_endpoint(provider.base_url),
                    headers=headers,
                    json={"model": provider.model, "name": provider.model},
                )
        if response.status_code >= 400:
            raise ValueError(f"model metadata returned {response.status_code}")
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("model metadata is not an object")
        info = payload.get("model_info") or {}
        if not isinstance(info, dict):
            raise ValueError("model_info is not an object")
        candidates: list[int] = []
        for key, value in info.items():
            if key != "context_length" and not key.endswith(".context_length"):
                continue
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                continue
            if 512 <= parsed <= 1_048_576:
                candidates.append(parsed)
        if not candidates:
            raise ValueError("model metadata has no usable context_length")
        provider.context_tokens = max(candidates)
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.info(
            "Could not detect Ollama context for %s (%s); using %d tokens.",
            provider.model,
            exc,
            DEFAULT_OLLAMA_NUM_CTX,
        )
        provider.context_tokens = DEFAULT_OLLAMA_NUM_CTX
    return provider.context_tokens


async def _post_chat_with_client(
    client: httpx.AsyncClient,
    provider: ProviderConfig,
    headers: dict[str, str],
    payload: dict[str, Any],
    *,
    cache_key: tuple[str, str] | None,
) -> httpx.Response:
    response: httpx.Response | None = None
    for attempt in range(2):
        try:
            response = await client.post(
                provider.endpoint,
                headers=headers,
                json=payload,
                timeout=provider.timeout,
            )
        except (httpx.ConnectTimeout, httpx.ConnectError) as exc:
            if attempt == 0:
                # A transient connection drop is safe to retry; the
                # provider never started generating.
                await asyncio.sleep(0.6)
                continue
            raise LLMError(
                "Could not connect to the AI service. Check the connection "
                "in Settings, then try again."
            ) from exc
        except httpx.HTTPError as exc:
            # Read timeouts are deliberately *not* retried: the provider
            # accepted the request and is still generating, so a retry
            # bills the same window twice and doubles the wait.
            raise _transport_error(provider, exc) from exc
        break

    if response is None:
        raise LLMError("Could not reach the AI service. Try again.")

    # Compatibility with gateways that reject optional keys: a 400 happens
    # before generation, so probing the supported shape is free and only
    # runs until the provider accepts the payload.
    for _ in range(4):
        if response.status_code != 400:
            break
        before_keys = set(payload.keys())
        if not _relax_payload(payload, response.text):
            break
        if cache_key is not None:
            dropped = _DROPPED_KEYS_CACHE.setdefault(cache_key, set())
            if "reasoning" in before_keys and "reasoning" not in payload:
                dropped.add("reasoning")
            if "response_format" in before_keys and "response_format" not in payload:
                dropped.add("response_format")
            if (
                "max_completion_tokens" in payload
                and "max_completion_tokens" not in before_keys
            ):
                dropped.add("max_completion_tokens")
        try:
            response = await client.post(
                provider.endpoint,
                headers=headers,
                json=payload,
                timeout=provider.timeout,
            )
        except httpx.HTTPError as exc:
            raise _transport_error(provider, exc) from exc

    return response


async def chat(
    provider: ProviderConfig,
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.2,
    json_mode: bool = True,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    disable_reasoning: bool = True,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"

    ollama = is_ollama_endpoint(provider.base_url, provider.api_key)
    payload: dict[str, Any] = {
        "model": provider.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    if ollama:
        payload["options"] = {
            "num_ctx": provider.context_tokens or DEFAULT_OLLAMA_NUM_CTX
        }
    elif disable_reasoning:
        payload["reasoning"] = dict(REASONING_OFF)

    cache_key: tuple[str, str] | None = None
    if transport is None:
        cache_key = (provider.endpoint, provider.model)
        dropped = _DROPPED_KEYS_CACHE.get(cache_key)
        if dropped:
            if "max_completion_tokens" in dropped and "max_tokens" in payload:
                payload["max_completion_tokens"] = payload.pop("max_tokens")
            if "reasoning" in dropped:
                payload.pop("reasoning", None)
            if "response_format" in dropped:
                payload.pop("response_format", None)
        response = await _post_chat_with_client(
            _get_shared_client(),
            provider,
            headers,
            payload,
            cache_key=cache_key,
        )
    else:
        async with httpx.AsyncClient(
            timeout=provider.timeout, transport=transport
        ) as client:
            response = await _post_chat_with_client(
                client,
                provider,
                headers,
                payload,
                cache_key=None,
            )

    if response.status_code >= 400:
        raise LLMError(
            f"The AI service returned {response.status_code}: {response.text[:400]}"
        )

    try:
        data = response.json()
        choice = data["choices"][0]
        content = choice["message"].get("content")
    except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
        raise LLMError(
            f"The AI service returned an unexpected response: {response.text[:400]}"
        ) from exc

    finish_reason = choice.get("finish_reason")
    if isinstance(content, list):  # some providers return content parts
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    elif isinstance(content, dict):
        content = json.dumps(content, ensure_ascii=False)
    content = "" if content is None else str(content)

    if not content.strip():
        if finish_reason == "length":
            raise LLMError(
                "The AI model spent its whole reply on internal reasoning and "
                "returned no answer. Choose a model that answers directly in "
                "Settings, then try again."
            )
        raise LLMError("The AI service returned an empty reply. Try again.")
    if finish_reason == "length":
        logger.warning(
            "LLM reply hit the output limit (model=%s); callers may salvage it.",
            provider.model,
        )
    return content


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
{"clips": [{"start": <seconds>, "end": <seconds>, "title": "<short title, max 70 chars>", "rationale": "<one sentence>"}]}

Hard rules:
- Times are absolute seconds from the start of the lecture, floats.
- Every clip must start and end on a complete sentence; never cut mid-verse.
- Let the passage decide its length: never pad, trim or split a thought to hit a target length.
- Every clip must be at least 15 seconds long.
- Quality over quantity: return only passages you would genuinely publish. An empty list is a valid answer for a window that has no standalone moment.
- Clips must not overlap an excluded range.
- Arabic Quranic quotes belong inside the clip; do not start a clip in the middle of a recitation.
"""

CLIP_SELECTION_RULES = """\
Return STRICT JSON only, with this exact shape:
{"keep": [<candidate numbers, ascending>]}

Hard rules:
- Keep every candidate that clearly earns its place; drop every candidate that does not.
- When two candidates cover the same moment or repeat the same point, keep only the stronger one.
- There is no target count: do not pad the set to reach a number, and do not drop a strong moment to stay under one.
- Return {"keep": []} when no candidate earns its place; an empty selection is a valid editorial decision.
- Respect the refinement note and the session topic guide.
- Never output a number that is not in the candidate list.
"""

#: Deterministic safety guards. These are not editorial limits: the discovery
#: model decides the real count and length of clips. The floor keeps
#: sub-15-second fragments out of Step 2, and the flood ceiling stops a
#: pathological reply from flooding the editor.
SAFETY_MIN_CLIP_SECONDS = 15.0
#: One clip slot per this many seconds of lecture. Mirrors the renderer's
#: ``src/lib/clipGuards.ts``; that file carries the shared sample vectors
#: (``FLOOD_CEILING_SAMPLES``) and ``test_phase1_e2e.py`` asserts the two
#: implementations agree, so they cannot drift.
FLOOD_CEILING_DIVISOR = 120.0
FLOOD_CEILING_MIN = 6
FLOOD_CEILING_MAX = 120
#: Upper bound on the Pass-1 pool handed to the editorial pass, so one runaway
#: window cannot blow up the synthesis prompt.
SAFETY_MAX_CANDIDATES = 120


def flood_ceiling(duration: float) -> int:
    """Maximum number of clips one reply may deliver for this lecture.

    ``clamp(ceil(duration / 120 s), 6, 120)``. Pathological-reply tripwire,
    not an editorial limit: the model decides clip count and length; this only
    bounds how many clips one reply may deliver.
    """
    if not math.isfinite(duration) or duration <= 0:
        return FLOOD_CEILING_MIN
    scaled = math.ceil(duration / FLOOD_CEILING_DIVISOR)
    return max(FLOOD_CEILING_MIN, min(FLOOD_CEILING_MAX, scaled))
#: The editorial reply is only a list of indices, so each keep costs few tokens.
_SELECTION_TOKENS_PER_ITEM = 24


#: Initial discovery window budget. A 1-3 h Tafseer lecture transcribes to
#: roughly 40k-90k characters. These are only initial groups: the context-aware
#: planner splits any group whose prompt + reserved output does not fit, and
#: never drops transcript coverage to stay within the character budget.
TRANSCRIPT_WINDOW_CHARS = 24_000
#: Work bounds, not prompt-size targets. Windows/batches are split further when
#: the model context requires it; exceeding either bound is an honest error.
MAX_DISCOVERY_WINDOWS = 16
MAX_EDITORIAL_CALLS = 8
MAX_DISCOVERY_CALLS = MAX_DISCOVERY_WINDOWS + MAX_EDITORIAL_CALLS


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


#: Re-roll feedback is bounded so a replayed prompt can never blow up.
EXEMPLAR_MAX_ITEMS = 12
EXEMPLAR_MAX_CHARS = 400


def format_exemplars(
    approved: list[dict[str, Any]] | None,
    rejected: list[dict[str, Any]] | None,
) -> str:
    """Render the editor's kept/passed clips as prompt guidance.

    Returns an empty string when there is nothing to say, so the prompt of a
    first discovery pass is byte-identical to before.
    """

    def rows(items: list[dict[str, Any]] | None) -> list[str]:
        rendered: list[str] = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            text = str(item.get("text") or "").strip()
            if not title and not text:
                continue
            label = title[:80] or "(untitled)"
            rendered.append(
                f"- {label}: {text[:EXEMPLAR_MAX_CHARS]}" if text else f"- {label}"
            )
            if len(rendered) >= EXEMPLAR_MAX_ITEMS:
                break
        return rendered

    blocks: list[str] = []
    kept = rows(approved)
    if kept:
        blocks.append(
            "PREVIOUSLY APPROVED CLIPS (imitate their shape):\n" + "\n".join(kept)
        )
    passed = rows(rejected)
    if passed:
        blocks.append(
            "PREVIOUSLY PASSED CLIPS (do not propose their shape):\n"
            + "\n".join(passed)
        )
    return "\n\n".join(blocks)


def build_discover_messages(
    *,
    segments: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    language: str,
    exemplar_block: str = "",
) -> list[dict[str, str]]:
    """Pass 1: find every passage in this window that stands on its own.

    There is deliberately no desired clip count or length here. The model reads
    the transcript (the only "watching" this stage has) and lets each complete
    thought define its own boundaries; the editorial pass decides the final set.
    """
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

    # Static lecture context precedes dynamic re-roll exclusions/exemplars/notes
    # so OpenAI-compatible prompt-prefix caches hit across Keep & Re-roll calls.
    user = f"""\
SESSION TOPIC GUIDE (video specific notes):
{session_guide.strip() or "(none)"}

TRANSCRIPT:
{_format_transcript(segments)}

ALREADY APPROVED / EXCLUDED RANGES (never propose inside these):
{excluded_text}
"""
    if exemplar_block.strip():
        user += "\n" + exemplar_block.strip() + "\n"
    user += f"""
REFINEMENT NOTE (this re-roll only):
{refinement_note.strip() or "(none)"}
"""
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


#: Transcript context shown per candidate in the editorial pass.
SYNTHESIS_EXCERPT_CHARS = 200


@dataclass(slots=True)
class _SegmentIndex:
    """Sorted segment spans with prefix max-ends for O(log S + K) range queries."""

    starts: list[float]
    ends: list[float]
    texts: list[str]
    prefix_max_end: list[float]


def _build_segment_index(segments: list[dict[str, Any]]) -> _SegmentIndex:
    entries: list[tuple[float, float, str]] = []
    for segment in segments:
        try:
            seg_start = float(segment.get("start", 0.0))
            seg_end = float(segment.get("end", 0.0))
        except (TypeError, ValueError):
            continue
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        entries.append((seg_start, seg_end, text))
    entries.sort(key=lambda item: (item[0], item[1]))
    starts: list[float] = []
    ends: list[float] = []
    texts: list[str] = []
    prefix_max_end: list[float] = []
    running_max = float("-inf")
    for seg_start, seg_end, text in entries:
        starts.append(seg_start)
        ends.append(seg_end)
        texts.append(text)
        if seg_end > running_max:
            running_max = seg_end
        prefix_max_end.append(running_max)
    return _SegmentIndex(
        starts=starts, ends=ends, texts=texts, prefix_max_end=prefix_max_end
    )


def _format_head_tail_excerpt(parts: list[str], max_chars: int) -> str:
    full = " ".join(parts).strip()
    if not full or max_chars <= 0:
        return ""
    if len(full) <= max_chars:
        return full
    if max_chars <= 20:
        return full[:max_chars].strip()
    tail_budget = max(24, max_chars // 3)
    head_budget = max(1, max_chars - tail_budget - 3)
    head = full[:head_budget].rstrip()
    tail = full[-tail_budget:].lstrip()
    return f"{head} … {tail}"[:max_chars].strip()


def _candidate_excerpt(
    segments: list[dict[str, Any]],
    start: float,
    end: float,
    *,
    max_chars: int = SYNTHESIS_EXCERPT_CHARS,
    index: _SegmentIndex | None = None,
) -> str:
    """Opening + closing excerpt of what the candidate says, bounded to ``max_chars``."""
    seg_index = index if index is not None else _build_segment_index(segments)
    n = len(seg_index.starts)
    if n == 0 or end <= start:
        return ""
    pos = bisect_right(seg_index.prefix_max_end, start)
    parts: list[str] = []
    while pos < n and seg_index.starts[pos] < end:
        if seg_index.ends[pos] > start:
            parts.append(seg_index.texts[pos])
        pos += 1
    return _format_head_tail_excerpt(parts, max_chars)


def _format_candidate_row(
    index: int, candidate: dict[str, Any], excerpt: str
) -> str:
    start = float(candidate.get("start", 0.0))
    end = float(candidate.get("end", 0.0))
    title = str(candidate.get("title") or "").strip()[:90]
    rationale = str(candidate.get("rationale") or "").strip()[:200]
    return (
        f"[{index}] {start:.1f}s .. {end:.1f}s | {title} | {rationale}\n"
        f"    excerpt: {excerpt or '(none)'}"
    )


def build_synthesis_messages(
    *,
    candidates: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    segment_index: _SegmentIndex | None = None,
) -> list[dict[str, str]]:
    """Pass 2: the editorial call that decides the final, publishable set.

    It answers with candidate indices only, so it can never invent or shift a
    timestamp; the sidecar maps the kept indices back to the exact Pass-1
    records. Excerpts give it enough context to judge quality without replaying
    the whole transcript.
    """
    system = f"{base_prompt.strip() or DEFAULT_BASE_PROMPT}\n\n{CLIP_SELECTION_RULES}"
    seg_index = segment_index if segment_index is not None else _build_segment_index(segments)

    rows: list[str] = []
    for index, candidate in enumerate(candidates, start=1):
        start = float(candidate.get("start", 0.0))
        end = float(candidate.get("end", 0.0))
        excerpt = _candidate_excerpt(segments, start, end, index=seg_index)
        rows.append(_format_candidate_row(index, candidate, excerpt))

    user = f"""\
SESSION TOPIC GUIDE (video specific notes):
{session_guide.strip() or "(none)"}

REFINEMENT NOTE (this re-roll only):
{refinement_note.strip() or "(none)"}

CANDIDATES ({len(candidates)}):
{chr(10).join(rows)}
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


def _thin_evenly(items: list[Any], limit: int) -> list[Any]:
    """Keep ``limit`` items spread across the whole list, never just its head."""
    if limit <= 0 or not items:
        return []
    if len(items) <= limit:
        return list(items)
    step = len(items) / limit
    return [items[min(len(items) - 1, int(position * step))] for position in range(limit)]


def sanitize_clips(
    raw_clips: list[Any],
    *,
    duration: float,
    excluded_ranges: list[dict[str, float]],
    min_duration: float = SAFETY_MIN_CLIP_SECONDS,
    max_clips: int | None = None,
    preserve_order: bool = False,
) -> list[dict[str, Any]]:
    """Clamp, filter and order proposals into deterministic clip records.

    The model decides how many clips the lecture contains and how long each one
    is. This function only applies deterministic *safety* guards, so a broken
    reply cannot leak invalid JSON or flood Step 2.

    =====  =====================================================================
    Rule   Behaviour
    =====  =====================================================================
    R1     A proposal that is not a JSON object is dropped.
    R2     Missing/non-numeric/NaN/Infinity bounds are dropped (never leaks
           invalid JSON to the renderer).
    R3     With a known media duration, bounds are clamped into ``[0, duration]``
           (a duration overrun is clamped, never allowed past the end).
    R4     After clamping, an empty window (``end - start < 1s``) is dropped.
    R5     A window shorter than the safety floor (15 s) is dropped: a
           fragment under 15 seconds is not a publishable moment.
    R6     There is no maximum length: a long window is kept, because the
           model decides how long a clip may be.
    R7     A window overlapping an approved/excluded range is dropped.
    R8     Overlapping proposals are **kept** and surfaced to the editor with
           collision labels; the editorial pass decides what to keep.
    R9     The result is start-ordered. Above ``max_clips`` (the
           lecture-scaled flood ceiling by default), the caller's order is
           preserved when ``preserve_order`` is set (the editorial ranking);
           otherwise the pool is evenly thinned so the lecture tail is never
           dropped.
    R10    Internal ordering keys never leave the service.
    =====  =====================================================================
    """
    candidates: list[dict[str, Any]] = []
    finite_duration = math.isfinite(duration) and duration > 0
    if max_clips is None:
        max_clips = flood_ceiling(duration)
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
        # R4/R5
        if length < 1.0:
            continue
        if length < min_duration:
            continue
        # R7
        if _overlaps_excluded(start, end, excluded_ranges):
            continue

        title = str(item.get("title") or "").strip() or f"Clip {len(candidates) + 1}"
        rationale = str(item.get("rationale") or "").strip()
        candidates.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "title": title[:120],
                "rationale": rationale[:400],
            }
        )

    # R8: overlaps are deliberately **not** resolved here. Two proposals that
    # cover the same seconds both ship, so the editor can see the collision and
    # choose. The editorial pass is where duplicate moments collapse.
    accepted = candidates[:max_clips] if preserve_order else _thin_evenly(candidates, max_clips)

    # R9 + R10
    accepted = sorted(accepted, key=lambda clip: clip["start"])
    return [
        {
            "start": clip["start"],
            "end": clip["end"],
            "title": clip["title"],
            "rationale": clip["rationale"],
        }
        for clip in accepted
    ]


def _window_reply_capacity(window: list[dict[str, Any]]) -> int:
    """A cost guard for one Pass-1 reply, not an editorial target.

    The floor keeps the token budget from truncating a small window; the ceiling
    stops a runaway reply. Nothing is said to the model about it.
    """
    chars = sum(len(str(segment.get("text", ""))) for segment in window)
    return max(4, min(24, math.ceil(chars / 1200)))


def _parse_keep_indices(reply: str, count: int) -> list[int] | None:
    """Map an editorial reply to zero-based candidate indices, or ``None``.

    ``None`` means "not usable" so the caller can degrade to keeping every
    candidate instead of losing the window's discoveries. A valid empty list
    stays empty: the editorial model deliberately selected no candidates.
    """
    try:
        payload = extract_json(reply)
    except LLMError:
        return None
    keep = payload.get("keep")
    if not isinstance(keep, list):
        return None
    indexes: list[int] = []
    seen: set[int] = set()
    for value in keep:
        if isinstance(value, bool):
            continue
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if 1 <= index <= count and index not in seen:
            seen.add(index)
            indexes.append(index - 1)
    # An explicit empty list is a valid editorial decision: keep none of the
    # candidates. Only a non-empty list with no usable indices is "unusable".
    if not keep:
        return []
    return indexes if indexes else None


def _selection_request(
    candidates: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    *,
    segment_index: _SegmentIndex | None = None,
) -> tuple[list[dict[str, str]], int]:
    messages = build_synthesis_messages(
        candidates=candidates,
        segments=segments,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        segment_index=segment_index,
    )
    budget = _reply_budget(
        len(candidates),
        per_item=_SELECTION_TOKENS_PER_ITEM,
        minimum=SELECTION_MIN_REPLY_TOKENS,
    )
    return messages, budget


def _char_counts(text: str) -> tuple[int, int]:
    ascii_chars = sum(ord(char) < 128 for char in text)
    return ascii_chars, len(text) - ascii_chars


def _plan_selection_batches(
    candidates: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    context_tokens: int,
) -> list[list[dict[str, Any]]]:
    """Pack every candidate in O(C + S log S) matching exact token limits."""
    if not candidates:
        return []
    seg_index = _build_segment_index(segments)
    excerpts = [
        _candidate_excerpt(
            segments,
            float(candidate.get("start", 0.0)),
            float(candidate.get("end", 0.0)),
            index=seg_index,
        )
        for candidate in candidates
    ]
    # Precompute constant suffix character counts (excluding `[index]`).
    suffix_counts: list[tuple[int, int]] = []
    for candidate, excerpt in zip(candidates, excerpts):
        start = float(candidate.get("start", 0.0))
        end = float(candidate.get("end", 0.0))
        title = str(candidate.get("title") or "").strip()[:90]
        rationale = str(candidate.get("rationale") or "").strip()[:200]
        suffix = (
            f" {start:.1f}s .. {end:.1f}s | {title} | {rationale}\n"
            f"    excerpt: {excerpt or '(none)'}"
        )
        suffix_counts.append(_char_counts(suffix))

    empty_messages = build_synthesis_messages(
        candidates=[],
        segments=segments,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        segment_index=seg_index,
    )
    system_tokens = _estimate_tokens(empty_messages[0]["content"]) + 4
    base_user_prefix = empty_messages[1]["content"].replace("CANDIDATES (0):", "CANDIDATES (")
    base_ascii, base_non_ascii = _char_counts(base_user_prefix)

    def fits_with(
        row_ascii: int,
        row_non_ascii: int,
        count: int,
    ) -> bool:
        count_ascii = len(f"{count}):")  # always ASCII digits + "):"
        total_ascii = base_ascii + count_ascii + row_ascii
        total_non_ascii = base_non_ascii + row_non_ascii
        user_tokens = max(1, math.ceil(total_ascii / 4 + total_non_ascii)) + 4
        budget = _reply_budget(
            count,
            per_item=_SELECTION_TOKENS_PER_ITEM,
            minimum=SELECTION_MIN_REPLY_TOKENS,
        )
        return system_tokens + user_tokens + budget + PROMPT_SAFETY_TOKENS <= context_tokens

    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    cur_ascii = 0
    cur_non_ascii = 0
    for candidate, (cand_ascii, cand_non_ascii) in zip(candidates, suffix_counts):
        next_index = len(current) + 1
        prefix_len = len(f"[{next_index}]") + (1 if current else 0)
        trial_ascii = cur_ascii + cand_ascii + prefix_len
        trial_non_ascii = cur_non_ascii + cand_non_ascii
        if fits_with(trial_ascii, trial_non_ascii, next_index):
            current.append(candidate)
            cur_ascii = trial_ascii
            cur_non_ascii = trial_non_ascii
            continue
        if not current:
            raise LLMError(
                "The selected AI model's context is too small for the clip "
                "editorial prompt. Shorten the clip brief or choose a model "
                "with a larger context."
            )
        batches.append(current)
        current = [candidate]
        prefix_len = len("[1]")
        cur_ascii = cand_ascii + prefix_len
        cur_non_ascii = cand_non_ascii
        if not fits_with(cur_ascii, cur_non_ascii, 1):
            raise LLMError(
                "The selected AI model's context is too small for one clip "
                "candidate. Shorten the clip brief or choose a model with a "
                "larger context."
            )
    if current:
        batches.append(current)
    return batches


async def _select_with_prompts(
    *,
    candidates: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    provider: ProviderConfig,
    cancel_event: threading.Event | None,
    segment_index: _SegmentIndex | None = None,
) -> list[dict[str, Any]]:
    """Pass 2: the model's editorial decision over the pooled candidates.

    A failed or unusable reply keeps the whole candidate pool (degradation is
    mandatory); it never turns a discovery run into an error.
    """
    raise_if_cancelled(cancel_event)
    messages, budget = _selection_request(
        candidates,
        segments,
        base_prompt,
        session_guide,
        refinement_note,
        segment_index=segment_index,
    )
    try:
        reply = await chat(
            provider,
            messages,
            temperature=0.2,
            max_tokens=budget,
        )
        keep = _parse_keep_indices(reply, len(candidates))
    except LLMError as exc:
        logger.warning(
            "Editorial clip selection failed (%s); keeping all %d candidate(s).",
            exc,
            len(candidates),
        )
        return list(candidates)
    if keep is None:
        logger.warning(
            "Editorial clip selection returned no usable 'keep' list; "
            "keeping all %d candidate(s).",
            len(candidates),
        )
        return list(candidates)
    return [candidates[index] for index in keep]


def _emit_discovery_progress(
    on_progress: Callable[[str, float, str, int | None, int | None], None] | None,
    stage: str,
    ratio: float,
    label: str,
    done: int | None = None,
    total: int | None = None,
) -> None:
    if on_progress is None:
        return
    try:
        on_progress(stage, min(1.0, max(0.0, float(ratio))), label, done, total)
    except Exception:  # pragma: no cover - callbacks must never fail discovery
        logger.debug("Ignoring discovery progress callback failure", exc_info=True)


async def _select_candidates(
    *,
    candidates: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    provider: ProviderConfig,
    context_tokens: int,
    cancel_event: threading.Event | None,
    on_progress: Callable[[str, float, str, int | None, int | None], None] | None = None,
) -> list[dict[str, Any]]:
    """Run Pass 2 in context-sized batches, reconciling shrinking selections.

    Every candidate is considered in the first round. If a round keeps a
    smaller pool, the next round compares those survivors together. A round
    that drops nothing needs no further reconciliation: overlaps are already
    kept and labelled by design.
    """
    current = list(candidates)
    calls = 0
    while current:
        batches = _plan_selection_batches(
            current, segments, base_prompt, session_guide, refinement_note, context_tokens
        )
        if calls + len(batches) > MAX_EDITORIAL_CALLS:
            if calls == 0:
                raise LLMError(
                    f"The clip editorial pass needs {len(batches)} model calls for "
                    f"this context, above the supported {MAX_EDITORIAL_CALLS}. "
                    "Choose a model with a larger context or shorten the clip brief."
                )
            logger.warning(
                "Editorial call budget exhausted after %d calls; keeping the %d "
                "candidate(s) selected so far.",
                calls,
                len(current),
            )
            return current

        segment_index = _build_segment_index(segments)
        batch_total = max(1, len(batches))
        if calls == 0:
            _emit_discovery_progress(
                on_progress,
                "selecting",
                0.78,
                f"Comparing clip candidates ({len(current)})…",
                0,
                batch_total,
            )
        next_round: list[dict[str, Any]] = []
        for batch_index, batch in enumerate(batches, start=1):
            next_round.extend(
                await _select_with_prompts(
                    candidates=batch,
                    segments=segments,
                    base_prompt=base_prompt,
                    session_guide=session_guide,
                    refinement_note=refinement_note,
                    provider=provider,
                    cancel_event=cancel_event,
                    segment_index=segment_index,
                )
            )
            calls += 1
            _emit_discovery_progress(
                on_progress,
                "selecting",
                0.78 + 0.18 * (batch_index / batch_total),
                f"Comparing candidates ({batch_index} of {batch_total})…"
                if batch_total > 1
                else "Comparing clip candidates…",
                batch_index,
                batch_total,
            )
        if len(batches) == 1 or not next_round or len(next_round) == len(current):
            return next_round
        current = next_round
    return current


def _window_request(
    window: list[dict[str, Any]],
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    language: str,
    exemplar_block: str,
) -> tuple[list[dict[str, str]], int]:
    capacity = _window_reply_capacity(window)
    messages = build_discover_messages(
        segments=window,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        excluded_ranges=excluded_ranges,
        language=language,
        exemplar_block=exemplar_block,
    )
    return messages, _reply_budget(capacity, minimum=DISCOVERY_MIN_REPLY_TOKENS)


def _fit_discovery_window(
    window: list[dict[str, Any]],
    *,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    language: str,
    exemplar_block: str,
    context_tokens: int,
) -> list[list[dict[str, Any]]]:
    """Split one window until prompt + reply fits, never dropping a segment."""
    messages, budget = _window_request(
        window,
        base_prompt,
        session_guide,
        refinement_note,
        excluded_ranges,
        language,
        exemplar_block,
    )
    if _messages_fit(messages, budget, context_tokens):
        return [window]
    if len(window) <= 1:
        raise LLMError(
            "The selected AI model's context is too small for one transcript "
            "segment. Shorten the clip brief or choose a model with a larger context."
        )
    midpoint = len(window) // 2
    return [
        *_fit_discovery_window(
            window[:midpoint],
            base_prompt=base_prompt,
            session_guide=session_guide,
            refinement_note=refinement_note,
            excluded_ranges=excluded_ranges,
            language=language,
            exemplar_block=exemplar_block,
            context_tokens=context_tokens,
        ),
        *_fit_discovery_window(
            window[midpoint:],
            base_prompt=base_prompt,
            session_guide=session_guide,
            refinement_note=refinement_note,
            excluded_ranges=excluded_ranges,
            language=language,
            exemplar_block=exemplar_block,
            context_tokens=context_tokens,
        ),
    ]


def _fit_discovery_windows(
    segments: list[dict[str, Any]],
    *,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    language: str,
    exemplar_block: str,
    context_tokens: int,
) -> list[list[dict[str, Any]]]:
    windows: list[list[dict[str, Any]]] = []
    for window in split_transcript_windows(
        segments, max_windows=MAX_DISCOVERY_WINDOWS
    ):
        windows.extend(
            _fit_discovery_window(
                window,
                base_prompt=base_prompt,
                session_guide=session_guide,
                refinement_note=refinement_note,
                excluded_ranges=excluded_ranges,
                language=language,
                exemplar_block=exemplar_block,
                context_tokens=context_tokens,
            )
        )
    if len(windows) > MAX_DISCOVERY_WINDOWS:
        raise LLMError(
            f"This lecture needs {len(windows)} prompt windows for the selected "
            f"model's context, above the supported {MAX_DISCOVERY_WINDOWS}. "
            "Choose a model with a larger context or shorten the clip brief."
        )
    return windows


#: Tail seconds of the preceding window overlapped into the next Pass-1 window
#: so passages straddling a window split remain intact for the discovery model.
DISCOVERY_WINDOW_OVERLAP_SECONDS = 60.0


def _overlap_windows(
    windows: list[list[dict[str, Any]]],
    *,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    language: str,
    exemplar_block: str,
    context_tokens: int,
) -> list[list[dict[str, Any]]]:
    """Prepend up to 60 s of context from window[i-1] while still fitting context."""
    overlapped: list[list[dict[str, Any]]] = []
    for index, window in enumerate(windows):
        if index == 0 or not window or not windows[index - 1]:
            overlapped.append(window)
            continue
        prev = windows[index - 1]
        cutoff = float(window[0].get("start", 0.0)) - DISCOVERY_WINDOW_OVERLAP_SECONDS
        max_prefix = max(1, len(prev) // 2)
        tail = [
            seg
            for seg in prev[-max_prefix:]
            if float(seg.get("end", 0.0)) >= cutoff
        ]
        while tail:
            candidate = [*tail, *window]
            messages, budget = _window_request(
                candidate,
                base_prompt,
                session_guide,
                refinement_note,
                excluded_ranges,
                language,
                exemplar_block,
            )
            if _messages_fit(messages, budget, context_tokens):
                overlapped.append(candidate)
                break
            tail = tail[1:]
        else:
            overlapped.append(window)
    return overlapped


def _dedupe_overlap_proposals(
    proposals: list[Any], *, iou_threshold: float = 0.75
) -> list[Any]:
    """Drop near-duplicate raw proposals emitted in the 60 s overlap zone."""
    kept: list[Any] = []
    intervals: list[tuple[float, float, int]] = []
    for item in proposals:
        if not isinstance(item, dict):
            kept.append(item)
            continue
        try:
            start = float(item.get("start"))
            end = float(item.get("end"))
        except (TypeError, ValueError):
            kept.append(item)
            continue
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            kept.append(item)
            continue
        rationale_len = len(str(item.get("rationale") or "").strip())
        replaced = False
        duplicate = False
        for idx, (k_start, k_end, k_rlen) in enumerate(intervals):
            inter = max(0.0, min(end, k_end) - max(start, k_start))
            if inter <= 0.0:
                continue
            union = max(end, k_end) - min(start, k_start)
            if union > 0.0 and inter / union >= iou_threshold:
                duplicate = True
                if rationale_len > k_rlen:
                    kept[idx] = item
                    intervals[idx] = (start, end, rationale_len)
                    replaced = True
                break
        if duplicate or replaced:
            continue
        intervals.append((start, end, rationale_len))
        kept.append(item)
    return kept


def _is_transient_llm_error(exc: LLMError) -> bool:
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "returned 429",
            "returned 500",
            "returned 502",
            "returned 503",
            "returned 504",
            "did not answer within",
            "could not connect",
        )
    )


async def _discover_with_prompts(
    *,
    segments: list[dict[str, Any]],
    duration: float,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    provider: ProviderConfig,
    language: str = "th",
    cancel_event: threading.Event | None = None,
    approved_exemplars: list[dict[str, Any]] | None = None,
    rejected_exemplars: list[dict[str, Any]] | None = None,
    context_tokens: int = DEFAULT_OLLAMA_NUM_CTX,
    on_progress: Callable[[str, float, str, int | None, int | None], None] | None = None,
) -> list[dict[str, Any]]:
    """Find clips across the *whole* lecture with the writing model.

    The transcript is first packed into character-sized windows on segment
    boundaries, then split further until each prompt and its reserved output
    fit ``context_tokens``. Pass 1 asks each window (with up to 60 s boundary
    overlap) for every passage that stands on its own - no count and no length
    target. The pooled candidates go through context-sized editorial batches
    (Pass 2), with another round when a batch round shrinks the pool.
    ``sanitize_clips`` applies safety guards.
    """
    exemplar_block = format_exemplars(approved_exemplars, rejected_exemplars)
    windows = _fit_discovery_windows(
        segments,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        excluded_ranges=excluded_ranges,
        language=language,
        exemplar_block=exemplar_block,
        context_tokens=context_tokens,
    )
    effective_windows = _overlap_windows(
        windows,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        excluded_ranges=excluded_ranges,
        language=language,
        exemplar_block=exemplar_block,
        context_tokens=context_tokens,
    )

    raise_if_cancelled(cancel_event)
    total_windows = len(effective_windows)
    _emit_discovery_progress(
        on_progress,
        "planning",
        0.08,
        f"Reading transcript ({total_windows} section{'s' if total_windows != 1 else ''})…",
        0,
        total_windows,
    )
    concurrency = 1 if is_ollama_endpoint(provider.base_url, provider.api_key) else 4
    sem = asyncio.Semaphore(concurrency)
    done_windows = 0

    async def _run_window(
        index: int, window: list[dict[str, Any]]
    ) -> tuple[list[Any], LLMError | None, bool]:
        nonlocal done_windows
        async with sem:
            raise_if_cancelled(cancel_event)
            messages, budget = _window_request(
                window,
                base_prompt,
                session_guide,
                refinement_note,
                excluded_ranges,
                language,
                exemplar_block,
            )
            reply: str | None = None
            last_exc: LLMError | None = None
            for attempt in range(2):
                try:
                    reply = await chat(
                        provider,
                        messages,
                        temperature=0.3,
                        max_tokens=budget,
                    )
                    break
                except LLMError as exc:
                    last_exc = exc
                    if attempt == 0 and _is_transient_llm_error(exc):
                        await asyncio.sleep(0.6)
                        raise_if_cancelled(cancel_event)
                        continue
                    logger.warning("Clip window %d LLM call failed: %s", index, exc)
                    done_windows += 1
                    _emit_discovery_progress(
                        on_progress,
                        "discovering",
                        0.10 + 0.65 * (done_windows / max(1, total_windows)),
                        f"Scanning section {done_windows} of {total_windows}…",
                        done_windows,
                        total_windows,
                    )
                    return [], exc, False
            if reply is None:
                done_windows += 1
                _emit_discovery_progress(
                    on_progress,
                    "discovering",
                    0.10 + 0.65 * (done_windows / max(1, total_windows)),
                    f"Scanning section {done_windows} of {total_windows}…",
                    done_windows,
                    total_windows,
                )
                return [], last_exc, False
            try:
                payload = extract_json(reply)
                raw = payload.get("clips")
                if not isinstance(raw, list):
                    raise LLMError("The LLM reply is missing a 'clips' array.")
            except LLMError as exc:
                salvaged = _salvage_clip_objects(reply)
                logger.warning(
                    "Clip window %d reply was malformed (%s); salvaged %d proposal(s).",
                    index,
                    exc,
                    len(salvaged),
                )
                if not salvaged:
                    done_windows += 1
                    _emit_discovery_progress(
                        on_progress,
                        "discovering",
                        0.10 + 0.65 * (done_windows / max(1, total_windows)),
                        f"Scanning section {done_windows} of {total_windows}…",
                        done_windows,
                        total_windows,
                    )
                    return [], None, False
                raw = salvaged
            done_windows += 1
            _emit_discovery_progress(
                on_progress,
                "discovering",
                0.10 + 0.65 * (done_windows / max(1, total_windows)),
                f"Scanning section {done_windows} of {total_windows}…",
                done_windows,
                total_windows,
            )
            return raw, None, True

    results = await asyncio.gather(
        *(_run_window(index, window) for index, window in enumerate(effective_windows))
    )

    proposals: list[Any] = []
    failed_windows = 0
    parsed_windows = 0
    last_chat_error: LLMError | None = None
    for raw, chat_error, ok in results:
        if not ok:
            failed_windows += 1
            if chat_error is not None:
                last_chat_error = chat_error
            continue
        proposals.extend(raw)
        parsed_windows += 1

    if parsed_windows == 0 and failed_windows:
        if last_chat_error is not None:
            raise last_chat_error
        raise LLMError(
            "The clip-finding model returned no usable JSON for any transcript "
            "window. Try a different model, or run it again."
        )

    deduped_proposals = _dedupe_overlap_proposals(proposals)

    # Pool + deterministic guards before the editorial call. The pool ceiling is
    # a prompt-size guard only; the model decides the real final count.
    pool = sanitize_clips(
        deduped_proposals,
        duration=duration,
        excluded_ranges=excluded_ranges,
        max_clips=SAFETY_MAX_CANDIDATES,
    )
    if not pool:
        return []

    selected = await _select_candidates(
        candidates=pool,
        segments=segments,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        provider=provider,
        context_tokens=context_tokens,
        cancel_event=cancel_event,
        on_progress=on_progress,
    )
    return sanitize_clips(
        selected,
        duration=duration,
        excluded_ranges=excluded_ranges,
        max_clips=flood_ceiling(duration),
        preserve_order=True,
    )


# --------------------------------------------------------------------------- #
# Clip candidate generation + malformed-reply salvage (Phase 4)
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


#: Candidate starts are sampled about three times denser than the old
#: one-per-capacity stride, so a clip that begins mid-window is still offered.
CANDIDATE_STRIDE_DIVISOR = 3
#: A pause at least this long between sentence units is a natural clip start.
CANDIDATE_PAUSE_SECONDS = 1.5


def generate_clip_candidates(
    segments: list[dict[str, Any]],
    *,
    duration: float,
    excluded_ranges: list[dict[str, float]],
    min_duration: float = SAFETY_MIN_CLIP_SECONDS,
    max_duration: float | None = None,
    max_candidates: int = 144,
) -> list[dict[str, Any]]:
    """Deterministic candidate windows: sentence starts, sentence ends, bounds.

    Used only for graceful degradation when no writing model is available. The
    floor here is the safety guard, not an editorial target. ``max_duration``
    is an optional sampling bound only (tests/eval); with no bound the second
    window offer per start extends to the next pause - a complete thought -
    never to the tail of the lecture.

    Starts are sampled about three times denser than a single pass budget, plus
    every pause, so a clip that begins mid-window is still offered. When that
    sampling exceeds the budget the starts are thinned *evenly* across the whole
    lecture - never truncated at a cap, which would leave the tail unsearched.
    """
    units = build_sentence_units(segments)
    if not units:
        return []
    finite_duration = math.isfinite(duration) and duration > 0
    candidates: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    stride = max(
        1, len(units) // max(1, (max_candidates // 2) * CANDIDATE_STRIDE_DIVISOR)
    )
    start_budget = max(1, max_candidates // 2)

    def even_sample(indexes: list[int], count: int) -> list[int]:
        """Evenly spaced subset, so a cap never chops off the lecture tail."""
        if count <= 0 or not indexes:
            return []
        if len(indexes) <= count:
            return list(indexes)
        step = len(indexes) / count
        return [indexes[min(len(indexes) - 1, int(pos * step))] for pos in range(count)]

    # Pause-anchored starts are the most likely sentence/clip boundaries, so they
    # claim the budget first; the denser stride grid fills what is left.
    paused = [
        index
        for index in range(1, len(units))
        if units[index]["start"] - units[index - 1]["end"] >= CANDIDATE_PAUSE_SECONDS
    ]
    chosen: set[int] = {0} | set(even_sample(paused, start_budget))
    remaining = start_budget - len(chosen)
    if remaining > 0:
        chosen |= set(even_sample(list(range(0, len(units), stride)), remaining))
    starts = sorted(chosen)

    def add(start_index: int, end_index: int) -> None:
        if end_index <= start_index:
            return
        start = units[start_index]["start"]
        end = units[end_index - 1]["end"]
        if finite_duration:
            start = max(0.0, min(start, duration))
            end = max(0.0, min(end, duration))
        length = end - start
        if length < min_duration or (
            max_duration is not None and length > max_duration
        ):
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
                "text": text[:400],
            }
        )

    for start_index in starts:
        end_index = start_index + 1
        while (
            end_index <= len(units)
            and units[end_index - 1]["end"] - units[start_index]["start"] < min_duration
        ):
            end_index += 1
        if end_index > len(units):
            break
        add(start_index, end_index)
        # Also offer the longest sentence-aligned window that still fits. With
        # no length target that runs to the next pause (a complete thought),
        # never to the tail of the lecture.
        longest = end_index
        if max_duration is None:
            while (
                longest < len(units)
                and units[longest]["start"] - units[longest - 1]["end"]
                < CANDIDATE_PAUSE_SECONDS
            ):
                longest += 1
        else:
            while (
                longest < len(units)
                and units[longest]["end"] - units[start_index]["start"]
                <= max_duration
            ):
                longest += 1
        if longest > end_index:
            add(start_index, longest)
        if len(candidates) >= max_candidates:
            break
    return candidates[:max_candidates]


async def discover_clips(
    *,
    segments: list[dict[str, Any]],
    duration: float,
    base_prompt: str,
    session_guide: str,
    refinement_note: str,
    excluded_ranges: list[dict[str, float]],
    provider: ProviderConfig | None,
    language: str = "th",
    cancel_event: threading.Event | None = None,
    approved_exemplars: list[dict[str, Any]] | None = None,
    rejected_exemplars: list[dict[str, Any]] | None = None,
    on_progress: Callable[[str, float, str, int | None, int | None], None] | None = None,
) -> list[dict[str, Any]]:
    """Find clips across the whole transcript with the writing model.

    The model chooses both the clips and their length; only the safety guards
    in ``sanitize_clips`` are deterministic. ``provider=None`` returns the
    deterministic candidate windows with neutral titles, so the step degrades
    instead of hard-failing when no model is set.
    """
    if provider is None:
        # Graceful degradation: with no writing model available, still return
        # the deterministic candidate windows with neutral titles so clip
        # finding degrades instead of hard-failing.
        logger.warning(
            "No clip-finding model configured; returning unscored candidate windows."
        )
        _emit_discovery_progress(on_progress, "planning", 0.25, "Scanning transcript windows…")
        candidates = generate_clip_candidates(
            segments,
            duration=duration,
            excluded_ranges=excluded_ranges,
            min_duration=SAFETY_MIN_CLIP_SECONDS,
            max_candidates=flood_ceiling(duration),
        )
        records: list[dict[str, Any]] = []
        for candidate in candidates:
            records.append(
                {
                    "start": float(candidate["start"]),
                    "end": float(candidate["end"]),
                    "title": str(candidate["text"]).strip()[:60]
                    or f"Clip {len(records) + 1}",
                    "rationale": "",
                }
            )
        _emit_discovery_progress(on_progress, "selecting", 0.9, "Filtering candidate clips…")
        return sanitize_clips(
            records,
            duration=duration,
            excluded_ranges=excluded_ranges,
            max_clips=flood_ceiling(duration),
        )
    context_tokens = await resolve_context_tokens(provider)
    return await _discover_with_prompts(
        segments=segments,
        duration=duration,
        base_prompt=base_prompt,
        session_guide=session_guide,
        refinement_note=refinement_note,
        excluded_ranges=excluded_ranges,
        provider=provider,
        language=language,
        cancel_event=cancel_event,
        approved_exemplars=approved_exemplars,
        rejected_exemplars=rejected_exemplars,
        context_tokens=context_tokens,
        on_progress=on_progress,
    )


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
{"starts":[<segment id>, ...]}

Rules:
- List the first `#<id>` of every complete sentence in ascending order (always begin with the first `#<id>` in the window).
- Group by complete thoughts/sentences, not by a character limit.
- A sentence may contain many short word/character segments.
- Attach fillers and fragments to the sentence they belong to.
- A very long sentence still starts only once; subtitle wrapping happens later.
"""


def _format_indexed_segments(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        lines.append(f"#{int(segment['id'])} {text}")
    return "\n".join(lines)


def _split_indexed_windows(
    segments: list[dict[str, Any]],
    *,
    system_prompt: str,
    context_tokens: int,
    per_item_output_tokens: int,
    min_reply_tokens: int = DEFAULT_MAX_TOKENS,
) -> list[list[dict[str, Any]]]:
    """Pack indexed transcript segments so every window fits ``context_tokens``."""
    non_empty = [seg for seg in segments if str(seg.get("text", "")).strip()]
    if not non_empty:
        return []
    sys_tokens = _estimate_tokens(system_prompt) + 4
    overhead_tokens = sys_tokens + PROMPT_SAFETY_TOKENS + 32

    windows: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    cur_tokens = 0
    for segment in non_empty:
        line = f"#{int(segment['id'])} {str(segment.get('text', '')).strip()}"
        line_tokens = _estimate_tokens(line) + 1
        next_count = len(current) + 1
        budget = _reply_budget(
            next_count, per_item=per_item_output_tokens, minimum=min_reply_tokens
        )
        if (
            current
            and overhead_tokens + cur_tokens + line_tokens + budget > context_tokens
        ):
            windows.append(current)
            current = [segment]
            cur_tokens = line_tokens
        else:
            current.append(segment)
            cur_tokens += line_tokens
    if current:
        windows.append(current)
    return windows


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
    context_tokens = await resolve_context_tokens(provider)
    windows = _split_indexed_windows(
        segments,
        system_prompt=ARABIC_AUDIT_SYSTEM,
        context_tokens=context_tokens,
        per_item_output_tokens=32,
        min_reply_tokens=DEFAULT_MAX_TOKENS,
    )
    if not windows:
        return []
    by_id = _segment_bounds(segments)
    concurrency = 1 if is_ollama_endpoint(provider.base_url, provider.api_key) else 4
    sem = asyncio.Semaphore(concurrency)

    async def _run_audit_window(window: list[dict[str, Any]]) -> list[dict[str, Any]]:
        async with sem:
            raise_if_cancelled(cancel_event)
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
                reply = await chat(
                    provider,
                    messages,
                    temperature=0.0,
                    max_tokens=_reply_budget(len(window), per_item=32),
                )
                payload = extract_json(reply)
            except LLMError as exc:
                logger.warning("Arabic audit window failed: %s", exc)
                return []
            return _sanitize_spans(payload, by_id, window_ids)

    raise_if_cancelled(cancel_event)
    per_window = await asyncio.gather(*(_run_audit_window(w) for w in windows))
    spans: list[dict[str, Any]] = []
    for chunk in per_window:
        spans.extend(chunk)
    return merge_spans(spans)


def _sanitize_groups(
    payload: dict[str, Any],
    window_ids: list[int],
) -> list[list[int]] | None:
    if "starts" in payload:
        raw_starts = payload.get("starts")
        if not isinstance(raw_starts, list):
            return None
        id_pos = {segment_id: idx for idx, segment_id in enumerate(window_ids)}
        start_positions: list[int] = []
        last_pos = -1
        for value in raw_starts:
            if isinstance(value, bool):
                return None
            try:
                segment_id = int(value)
            except (TypeError, ValueError):
                return None
            pos = id_pos.get(segment_id)
            if pos is None or pos <= last_pos:
                return None
            start_positions.append(pos)
            last_pos = pos
        if not start_positions:
            return [list(window_ids)] if window_ids else None
        if start_positions[0] != 0:
            start_positions.insert(0, 0)
        groups: list[list[int]] = []
        for idx, start_pos in enumerate(start_positions):
            end_pos = (
                start_positions[idx + 1]
                if idx + 1 < len(start_positions)
                else len(window_ids)
            )
            groups.append(window_ids[start_pos:end_pos])
        return groups

    raw = payload.get("groups")
    if not isinstance(raw, list) or not raw:
        return None
    groups = []
    seen: list[int] = []
    for group in raw:
        if not isinstance(group, list):
            return None
        cleaned: list[int] = []
        for value in group:
            if isinstance(value, bool):
                return None
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
    context_tokens = await resolve_context_tokens(provider)
    windows = _split_indexed_windows(
        segments,
        system_prompt=SENTENCE_SYSTEM,
        context_tokens=context_tokens,
        per_item_output_tokens=6,
        min_reply_tokens=512,
    )
    if not windows:
        return {}
    concurrency = 1 if is_ollama_endpoint(provider.base_url, provider.api_key) else 4
    sem = asyncio.Semaphore(concurrency)

    async def _run_group_window(
        window: list[dict[str, Any]],
    ) -> list[list[int]] | None:
        async with sem:
            raise_if_cancelled(cancel_event)
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
                reply = await chat(
                    provider,
                    messages,
                    temperature=0.0,
                    max_tokens=_reply_budget(len(window), per_item=6, minimum=512),
                )
                payload = extract_json(reply)
            except LLMError as exc:
                logger.warning("Sentence grouping window failed: %s", exc)
                return None
            groups = _sanitize_groups(payload, window_ids)
            if groups is None:
                logger.warning("Sentence grouping returned invalid ids; using fallback.")
            return groups

    raise_if_cancelled(cancel_event)
    results = await asyncio.gather(*(_run_group_window(w) for w in windows))
    mapping: dict[int, int] = {}
    sentence_index = 0
    for groups in results:
        if not groups:
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
            unsure_ids = {int(segment["id"]) for segment in unsure}
            position = {int(segment["id"]): idx for idx, segment in enumerate(usable)}
            keep_indices: set[int] = set()
            for segment_id in unsure_ids:
                idx = position.get(segment_id)
                if idx is None:
                    continue
                keep_indices.update(
                    range(max(0, idx - 2), min(len(usable), idx + 3))
                )
            escalate_segments = [usable[idx] for idx in sorted(keep_indices)]
            escalated_spans = await audit_arabic(
                segments=escalate_segments,
                provider=escalator,
                cancel_event=cancel_event,
            )
            for span in escalated_spans:
                span_range = range(int(span["start_id"]), int(span["end_id"]) + 1)
                if any(sid in unsure_ids for sid in span_range):
                    spans.append(span)
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

        ordered = [
            segment
            for segment in sorted(segments, key=lambda item: float(item.get("start", 0.0)))
            if str(segment.get("text", "")).strip()
        ]
        for left, right in zip(ordered, ordered[1:]):
            if int(left["id"]) in breaks:
                starts.add(int(right["id"]))
    return rebuild_sentence_map(segments, starts)
