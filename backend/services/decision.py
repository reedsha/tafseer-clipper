"""System One decision-model client.

The decision tier is an internal sidecar service: it asks a *discriminative*
model for calibrated answers to typed questions (``noul`` / ``choice`` /
``score``) in one forward pass, instead of spending a generative LLM call on a
binary or ranking judgment.

All adapters share the same request body and differ only by path (and auth):

* ``POST {root}/v1/systemone`` - Ollama, OpenRouter, TypeSafe.
* ``POST {root}/v1/decisions`` - Perplexity, Runware.

The client is deliberately thin, exactly like :func:`services.analyzer.chat`:
one request (plus one transient retry), strict validation, and no partial
answers.  A malformed reply raises :class:`DecisionError` (an ``LLMError``) so
the caller's existing 502 handler and "escalate to the generative LLM" fallback
both keep working.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlparse

import httpx

import config
from services.errors import LLMError

DecisionType = Literal["noul", "choice", "score"]

#: Path templates per adapter.  The base URL is normalised to the service root
#: first, so ``http://localhost:11434/v1`` and ``http://localhost:11434`` both
#: resolve to ``/v1/systemone``.
SYSTEMONE_PATH = "/v1/systemone"
DECISIONS_PATH = "/v1/decisions"
ENDPOINT_STYLES: dict[str, str] = {
    "ollama": SYSTEMONE_PATH,
    "openrouter": SYSTEMONE_PATH,
    "typesafe": SYSTEMONE_PATH,
    "perplexity": DECISIONS_PATH,
    "runware": DECISIONS_PATH,
}
#: Ollama only exposes ``/v1/systemone`` from this version on.
OLLAMA_DECISION_MIN_VERSION = (0, 35, 0)


class DecisionError(LLMError):
    """The decision provider could not answer, or answered malformed data."""


# --------------------------------------------------------------------------- #
# Provider configuration
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class DecisionProviderOverride:
    """Per-request decision provider sent by Settings (all fields optional)."""

    mode: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    endpoint_style: str | None = None
    timeout: float | None = None


@dataclass(slots=True)
class DecisionProviderConfig:
    base_url: str
    api_key: str | None
    model: str
    timeout: float
    endpoint_style: str

    @property
    def endpoint(self) -> str:
        return decision_endpoint(self.base_url, self.endpoint_style)

    def describe(self) -> dict[str, str | None]:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "endpoint_style": self.endpoint_style,
        }


def _root_url(base_url: str) -> str:
    """Strip the OpenAI-compatible ``/v1`` suffix from a service address."""
    cleaned = (base_url or "").strip().rstrip("/")
    if cleaned.endswith("/v1"):
        cleaned = cleaned[: -len("/v1")].rstrip("/")
    return cleaned


def resolve_endpoint_style(
    endpoint_style: str | None, base_url: str, api_key: str | None = None
) -> str:
    """Pick the adapter for a base URL; an explicit style always wins."""
    chosen = (endpoint_style or "").strip().lower()
    if chosen and chosen != "auto":
        if chosen not in ENDPOINT_STYLES:
            raise DecisionError(
                f"Unknown decision endpoint style '{chosen}'. "
                f"Use one of: auto, {', '.join(sorted(ENDPOINT_STYLES))}."
            )
        return chosen
    host = (urlparse(base_url).hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        return "ollama"
    if host.endswith("perplexity.ai"):
        return "perplexity"
    if host.endswith("runware.ai"):
        return "runware"
    if host.endswith("typesafe.ai"):
        return "typesafe"
    return "openrouter"


def decision_endpoint(base_url: str, endpoint_style: str | None = "auto") -> str:
    """Full System One URL for a service address and adapter style."""
    root = _root_url(base_url) or _root_url(config.decision_base_url())
    style = resolve_endpoint_style(endpoint_style, root)
    return root + ENDPOINT_STYLES[style]


def merge_decision_provider(
    override: DecisionProviderOverride | None,
) -> DecisionProviderConfig | None:
    """Environment defaults overlaid with the per-request slot settings.

    Returns ``None`` when no decision model is configured: the decision tier is
    optional and every caller treats ``None`` as "keep today's behavior".
    """
    base_url = config.decision_base_url()
    api_key = config.decision_api_key()
    model = config.decision_model()
    timeout = config.decision_timeout()
    endpoint_style = config.decision_endpoint_style()

    if override is not None:
        base_url = override.base_url or base_url
        if override.api_key is not None:
            api_key = override.api_key
        model = (override.model or "").strip() or model
        timeout = override.timeout or timeout
        endpoint_style = override.endpoint_style or endpoint_style

    if not model:
        return None
    if not base_url.strip():
        return None

    style = resolve_endpoint_style(endpoint_style, base_url, api_key)
    return DecisionProviderConfig(
        base_url=base_url,
        api_key=api_key or None,
        model=model,
        timeout=timeout,
        endpoint_style=style,
    )


# --------------------------------------------------------------------------- #
# Request/answer types
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Question:
    """One typed question sent with a shared ``state``."""

    type: DecisionType
    instructions: str
    criteria: str | None = None


@dataclass(slots=True)
class Answer:
    """A validated answer; ``type`` decides which value field is populated."""

    name: str
    type: DecisionType
    choice: str | None = None
    noul: bool | None = None
    score: float | None = None
    probabilities: dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0
    legend: dict[str, str] = field(default_factory=dict)

    @property
    def value(self) -> str | bool | float | None:
        if self.type == "choice":
            return self.choice
        if self.type == "noul":
            return self.noul
        return self.score

    def probability(self, label: str) -> float | None:
        return self.probabilities.get(label)


def _question_payload(question: Question) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": question.type,
        "instructions": question.instructions,
    }
    if question.criteria:
        payload["criteria"] = question.criteria
    return payload


def _as_unit_float(value: Any, *, field_name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise DecisionError(f"Decision answer '{field_name}' is not a number.") from exc
    if not math.isfinite(number):
        raise DecisionError(f"Decision answer '{field_name}' is not finite.")
    return min(1.0, max(0.0, number))


def _probabilities(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for key, raw in value.items():
        if not isinstance(key, str):
            continue
        result[key] = _as_unit_float(raw, field_name=f"probabilities.{key}")
    return result


def _parse_answer(name: str, expected: DecisionType, entry: Any) -> Answer:
    if not isinstance(entry, dict):
        raise DecisionError(f"Decision answer '{name}' is missing or malformed.")

    declared = str(entry.get("type") or expected).strip().lower()
    if declared not in {"noul", "choice", "score"}:
        raise DecisionError(f"Decision answer '{name}' has an unknown type.")
    if declared != expected:
        raise DecisionError(
            f"Decision answer '{name}' has type '{declared}', expected '{expected}'."
        )

    probabilities = _probabilities(entry.get("probabilities"))
    legend_raw = entry.get("legend")
    legend = (
        {str(key): str(value) for key, value in legend_raw.items()}
        if isinstance(legend_raw, dict)
        else {}
    )

    choice: str | None = None
    noul: bool | None = None
    score: float | None = None
    if expected == "choice":
        raw_choice = entry.get("choice")
        if not isinstance(raw_choice, str) or not raw_choice.strip():
            raise DecisionError(f"Choice answer '{name}' is missing 'choice'.")
        choice = raw_choice.strip()
        if probabilities and choice not in probabilities:
            raise DecisionError(
                f"Choice answer '{name}' returned a label absent from its probabilities."
            )
    elif expected == "noul":
        raw_noul = entry.get("noul")
        if isinstance(raw_noul, bool):
            noul = raw_noul
        elif isinstance(raw_noul, str) and raw_noul.strip().lower() in {"true", "false"}:
            noul = raw_noul.strip().lower() == "true"
        else:
            raise DecisionError(f"noul answer '{name}' is missing a boolean 'noul'.")
    else:
        if "score" not in entry:
            raise DecisionError(f"Score answer '{name}' is missing 'score'.")
        score = _as_unit_float(entry.get("score"), field_name=f"{name}.score")

    if "confidence" in entry:
        confidence = _as_unit_float(entry.get("confidence"), field_name=f"{name}.confidence")
    elif expected == "choice" and probabilities:
        confidence = probabilities.get(choice, 0.0)
    elif expected == "noul" and probabilities:
        label = "true" if noul else "false"
        confidence = probabilities.get(label, max(probabilities.values(), default=0.0))
    else:
        # A boolean or score is already the model's direct judgment.
        confidence = 1.0

    return Answer(
        name=name,
        type=expected,
        choice=choice,
        noul=noul,
        score=score,
        probabilities=probabilities,
        confidence=confidence,
        legend=legend,
    )


def _parse_answers(payload: Any, questions: dict[str, Question]) -> dict[str, Answer]:
    if not isinstance(payload, dict):
        raise DecisionError("The decision provider returned a non-object reply.")
    raw = payload.get("answers")
    if not isinstance(raw, dict):
        raise DecisionError("The decision provider reply is missing an 'answers' object.")
    answers: dict[str, Answer] = {}
    for name, question in questions.items():
        answers[name] = _parse_answer(name, question.type, raw.get(name))
    return answers


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #
async def decide(
    provider: DecisionProviderConfig,
    state: str | dict[str, Any] | list[Any],
    questions: dict[str, Question],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    cancel_event: Any | None = None,
) -> dict[str, Answer]:
    """Ask one System One provider a batch of typed questions.

    Retry parity with :func:`services.analyzer.chat`: one transient transport
    failure is retried after a short pause; HTTP errors, timeouts and malformed
    answers raise :class:`DecisionError`.
    """
    if not questions:
        raise DecisionError("At least one decision question is required.")
    if cancel_event is not None and getattr(cancel_event, "is_set", None) and cancel_event.is_set():
        from services.cancel import raise_if_cancelled

        raise_if_cancelled(cancel_event)

    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    payload = {
        "model": provider.model,
        "state": state,
        "questions": {name: _question_payload(q) for name, q in questions.items()},
    }

    try:
        async with httpx.AsyncClient(
            timeout=provider.timeout, transport=transport
        ) as client:
            response: httpx.Response | None = None
            for attempt in range(2):
                try:
                    response = await client.post(
                        provider.endpoint, headers=headers, json=payload
                    )
                except httpx.HTTPError as exc:
                    if attempt == 0:
                        await asyncio.sleep(0.6)
                        continue
                    raise DecisionError(
                        f"Could not reach the decision model at {provider.endpoint}: {exc}"
                    ) from exc
                break
    except httpx.HTTPError as exc:
        raise DecisionError(
            f"Could not reach the decision model at {provider.endpoint}: {exc}"
        ) from exc

    if response is None:
        raise DecisionError(f"Could not reach the decision model at {provider.endpoint}.")
    if response.status_code >= 400:
        raise DecisionError(
            f"The decision provider returned {response.status_code}: {response.text[:400]}"
        )

    try:
        body = response.json()
    except ValueError as exc:
        raise DecisionError(
            f"The decision provider returned invalid JSON: {response.text[:400]}"
        ) from exc
    if isinstance(body, dict) and body.get("error"):
        raise DecisionError(f"The decision provider returned an error: {body['error']}")
    return _parse_answers(body, questions)


async def probe(
    provider: DecisionProviderConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Answer:
    """One trivial question that proves the slot is reachable and compatible."""
    answers = await decide(
        provider,
        "This is a connection test.",
        {
            "reachable": Question(
                type="noul",
                instructions="Is this message a connection test?",
                criteria="true when the state is a connection test",
            )
        },
        transport=transport,
    )
    return answers["reachable"]


def parse_ollama_version(value: Any) -> tuple[int, int, int] | None:
    """Parse Ollama's ``/api/version`` reply into a comparable tuple."""
    if isinstance(value, dict):
        value = value.get("version")
    if not isinstance(value, str):
        return None
    parts: list[int] = []
    for chunk in value.strip().split("."):
        digits = ""
        for char in chunk:
            if char.isdigit():
                digits += char
            else:
                break
        if not digits:
            break
        parts.append(int(digits))
        if len(parts) == 3:
            break
    if not parts:
        return None
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])  # type: ignore[return-value]


def supports_systemone(version: Any) -> bool:
    parsed = parse_ollama_version(version)
    return parsed is not None and parsed >= OLLAMA_DECISION_MIN_VERSION
