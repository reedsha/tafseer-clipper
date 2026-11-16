"""System One decision-model client.

The decision tier is an internal sidecar service: it asks a *discriminative*
model for calibrated answers to typed questions (``noul`` / ``choice`` /
``score``) in one forward pass, instead of spending a generative LLM call on a
binary or ranking judgment.

All providers speak one of exactly two wire shapes.  The shape is chosen by the
user (Settings) or measured once by :func:`detect_format`; it is never guessed
from a hostname:

* ``systemone`` - ``POST {root}/v1/systemone`` (Ollama, OpenRouter, TypeSafe):
  ``{model, state, questions: {name: {...}}}`` with answers keyed by name.
* ``decisions`` - ``POST {root}/v1/decisions`` (OpenAI Decisions API, Vercel AI
  Gateway, Perplexity): ``{model, input, questions: [{name, type, ...}]}`` with
  answers as a list in question order.

A full URL override (``endpoint_url``) bypasses the built-in path, so a gateway
that moved or renamed the route needs no code change.

The client is deliberately thin, exactly like :func:`services.analyzer.chat`:
one request (plus one transient retry), strict validation, and no partial
answers.  A malformed reply raises :class:`DecisionError` (an ``LLMError``) so
the caller's existing 502 handler and "escalate to the generative LLM" fallback
both keep working.
"""

from __future__ import annotations

import asyncio
import json
import math
import threading
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

import config
from services.errors import LLMError

DecisionType = Literal["noul", "choice", "score"]

#: The two wire shapes decision providers actually speak.  They differ in path,
#: request body and response body, so the client always knows which one it is
#: using - the format is never inferred from a hostname.
SYSTEMONE = "systemone"
DECISIONS = "decisions"
WIRE_FORMAT_PATHS: dict[str, str] = {
    SYSTEMONE: "/v1/systemone",
    DECISIONS: "/v1/decisions",
}
#: Sentinel meaning "measure the shape once (Settings Test) and remember it".
AUTO_FORMAT = "auto"
#: Values older builds and saved projects used.  They named a vendor, not a
#: format; each maps onto the shape that vendor serves.
LEGACY_STYLES: dict[str, str] = {
    "ollama": SYSTEMONE,
    "openrouter": SYSTEMONE,
    "typesafe": SYSTEMONE,
    "system-one": SYSTEMONE,
    "perplexity": DECISIONS,
    "runware": DECISIONS,
}
#: Kept for callers that only need the local Ollama route (`/health`).
SYSTEMONE_PATH = WIRE_FORMAT_PATHS[SYSTEMONE]
DECISIONS_PATH = WIRE_FORMAT_PATHS[DECISIONS]
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
    #: ``systemone``, ``decisions`` or ``auto`` (measure once, then cache).
    endpoint_style: str | None = None
    #: Advanced: a full URL that bypasses the built-in path for this format.
    endpoint_url: str | None = None
    timeout: float | None = None


@dataclass(slots=True)
class DecisionProviderConfig:
    base_url: str
    api_key: str | None
    model: str
    timeout: float
    #: ``systemone``, ``decisions`` or ``auto`` (detect once, then cache).
    wire_format: str = AUTO_FORMAT
    #: Full URL that overrides the built-in path (advanced Settings field).
    endpoint_url: str | None = None

    def endpoint_for(self, wire_format: str) -> str:
        if self.endpoint_url:
            return self.endpoint_url
        return decision_endpoint(self.base_url, wire_format)

    def describe(self) -> dict[str, str | None]:
        return {
            "base_url": self.base_url,
            "model": self.model,
            "wire_format": self.wire_format,
            "endpoint_url": self.endpoint_url,
        }


def _root_url(base_url: str) -> str:
    """Strip the OpenAI-compatible ``/v1`` suffix from a service address."""
    cleaned = (base_url or "").strip().rstrip("/")
    if cleaned.endswith("/v1"):
        cleaned = cleaned[: -len("/v1")].rstrip("/")
    return cleaned


def normalize_wire_format(value: str | None) -> str:
    """Return ``systemone``, ``decisions``, or ``auto`` when unset.

    Vendor names from older settings are translated once; a genuinely unknown
    value is an error, because guessing a format is what produced 404s.  The
    returned sentinel is never used to build a URL - :func:`decide` measures
    the real format first (see :func:`detect_format`).
    """
    chosen = (value or "").strip().lower()
    if not chosen or chosen == AUTO_FORMAT:
        return AUTO_FORMAT
    if chosen in WIRE_FORMAT_PATHS:
        return chosen
    if chosen in LEGACY_STYLES:
        return LEGACY_STYLES[chosen]
    raise DecisionError(
        f"Unknown decision format '{chosen}'. "
        f"Use one of: {AUTO_FORMAT}, {', '.join(sorted(WIRE_FORMAT_PATHS))}."
    )


def decision_endpoint(base_url: str, wire_format: str | None = SYSTEMONE) -> str:
    """Full decision URL for a service address and a concrete wire format."""
    root = _root_url(base_url) or _root_url(config.decision_base_url())
    fmt = normalize_wire_format(wire_format)
    if fmt == AUTO_FORMAT:
        raise DecisionError(
            "The decision format has not been detected yet; test this slot in Settings."
        )
    return root + WIRE_FORMAT_PATHS[fmt]


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

    endpoint_url = ""
    if override is not None:
        endpoint_url = (override.endpoint_url or "").strip()

    return DecisionProviderConfig(
        base_url=base_url,
        api_key=api_key or None,
        model=model,
        timeout=timeout,
        wire_format=normalize_wire_format(endpoint_style),
        endpoint_url=endpoint_url or None,
    )


# --------------------------------------------------------------------------- #
# Request/answer types
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Question:
    """One typed question sent with a shared ``state``.

    ``criteria`` is typed per question, exactly as the System One API defines it:

    * ``choice`` - ``{label: description}`` (required, one entry per option);
    * ``score`` - a ``list[str]`` of 2-10 level descriptions, lowest first;
    * ``noul`` - optional ``{"true": ..., "false": ...}`` descriptions.

    A string is rejected: the provider answers ``400`` for it.
    """

    type: DecisionType
    instructions: str
    criteria: dict[str, str | None] | list[str] | None = None


@dataclass(slots=True)
class Answer:
    """A validated answer; ``type`` decides which value field is populated."""

    name: str
    type: DecisionType
    choice: str | None = None
    noul: bool | None = None
    score: float | None = None
    #: The provider's raw level index for a ``score`` answer (before 0..1 scaling).
    level: float | None = None
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
    """Serialise one question in the shape the provider validates.

    The provider rejects string criteria (``'criteria' must be an object``), a
    ``choice`` without labels, and a ``score`` without 2-10 levels, so the
    mismatch is caught here with an actionable message instead of a round-trip.
    """
    payload: dict[str, Any] = {
        "type": question.type,
        "instructions": question.instructions,
    }
    criteria = question.criteria
    if question.type == "choice":
        if not isinstance(criteria, dict) or not criteria:
            raise DecisionError(
                "A choice question needs 'criteria' as {label: description}."
            )
        if len(criteria) > 255:
            raise DecisionError("A choice question allows at most 255 labels.")
        payload["criteria"] = criteria
    elif question.type == "score":
        if not isinstance(criteria, list) or not 2 <= len(criteria) <= 10:
            raise DecisionError(
                "A score question needs 'criteria' as 2-10 level descriptions, "
                "lowest first."
            )
        payload["criteria"] = criteria
    elif criteria is not None:
        if not isinstance(criteria, dict):
            raise DecisionError(
                "A noul question takes 'criteria' as {'true': ..., 'false': ...}."
            )
        payload["criteria"] = criteria
    return payload


def _level_entry(text: str) -> dict[str, str]:
    """Split a score-level description into a short label plus its detail."""
    label, _, detail = str(text).partition(":")
    entry = {"label": label.strip() or str(text).strip()}
    if detail.strip():
        entry["description"] = detail.strip()
    return entry


def _decisions_question(name: str, question: Question) -> dict[str, Any]:
    """Serialise one question in the OpenAI Decisions shape."""
    criteria = question.criteria
    payload: dict[str, Any] = {
        "name": name,
        "type": "predicate" if question.type == "noul" else question.type,
        "instructions": question.instructions,
    }
    if question.type == "choice":
        if not isinstance(criteria, dict) or not criteria:
            raise DecisionError(
                "A choice question needs 'criteria' as {label: description}."
            )
        if len(criteria) > 255:
            raise DecisionError("A choice question allows at most 255 labels.")
        choices: list[dict[str, Any]] = []
        for label, description in criteria.items():
            entry: dict[str, Any] = {"value": label}
            if isinstance(description, str) and description.strip():
                entry["description"] = description.strip()
            choices.append(entry)
        payload["choices"] = choices
    elif question.type == "score":
        if not isinstance(criteria, list) or not 2 <= len(criteria) <= 10:
            raise DecisionError(
                "A score question needs 'criteria' as 2-10 level descriptions, "
                "lowest first."
            )
        payload["levels"] = [_level_entry(text) for text in criteria]
    elif isinstance(criteria, dict) and criteria:
        # A predicate carries only instructions in this shape, so the true/false
        # framing travels with the text instead of being dropped.
        hints = [
            f"{label} = {text}"
            for label, text in criteria.items()
            if isinstance(text, str) and text.strip()
        ]
        if hints:
            payload["instructions"] = f"{question.instructions} ({'; '.join(hints)})"
    return payload


def _decisions_input(state: Any) -> Any:
    """Map our shared ``state`` onto the Decisions ``input`` field."""
    if isinstance(state, str):
        return state
    if isinstance(state, dict) or (
        isinstance(state, list)
        and state
        and all(isinstance(item, dict) for item in state)
    ):
        return [{"role": "user", "content": [{"type": "input_json", "data": state}]}]
    return json.dumps(state, ensure_ascii=False)


def _as_number(value: Any, *, field_name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise DecisionError(f"Decision answer '{field_name}' is not a number.") from exc
    if not math.isfinite(number):
        raise DecisionError(f"Decision answer '{field_name}' is not finite.")
    return number


def _as_unit_float(value: Any, *, field_name: str) -> float:
    return min(1.0, max(0.0, _as_number(value, field_name=field_name)))


def _probabilities(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for key, raw in value.items():
        if not isinstance(key, str):
            continue
        result[key] = _as_unit_float(raw, field_name=f"probabilities.{key}")
    return result


def _parse_answer(name: str, question: Question, entry: Any) -> Answer:
    expected = question.type
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
    level: float | None = None
    #: Confidence the provider implied, when it did not send one.
    implied_confidence: float | None = None
    if expected == "choice":
        raw_choice = entry.get("choice")
        if not isinstance(raw_choice, str) or not raw_choice.strip():
            # Tolerate a provider that only returns probabilities.
            if not probabilities:
                raise DecisionError(f"Choice answer '{name}' is missing 'choice'.")
            raw_choice = max(probabilities, key=probabilities.get)
        choice = raw_choice.strip()
        if probabilities and choice not in probabilities:
            raise DecisionError(
                f"Choice answer '{name}' returned a label absent from its probabilities."
            )
    elif expected == "noul":
        raw_noul = entry.get("noul")
        if isinstance(raw_noul, bool):
            noul = raw_noul
            implied_confidence = 1.0
            probabilities = probabilities or {
                "true": 1.0 if raw_noul else 0.0,
                "false": 0.0 if raw_noul else 1.0,
            }
        elif isinstance(raw_noul, (int, float)):
            # The System One contract: the probability that the answer is true.
            probability = _as_unit_float(raw_noul, field_name=f"{name}.noul")
            noul = probability >= 0.5
            implied_confidence = max(probability, 1.0 - probability)
            probabilities = probabilities or {
                "true": probability,
                "false": 1.0 - probability,
            }
        elif isinstance(raw_noul, str) and raw_noul.strip().lower() in {"true", "false"}:
            noul = raw_noul.strip().lower() == "true"
            implied_confidence = 1.0
        else:
            raise DecisionError(
                f"noul answer '{name}' is missing a probability or boolean 'noul'."
            )
    else:
        if "score" not in entry:
            raise DecisionError(f"Score answer '{name}' is missing 'score'.")
        # The provider returns the probability-weighted level, numbered from 0.
        level = _as_number(entry.get("score"), field_name=f"{name}.score")
        levels = len(question.criteria) if isinstance(question.criteria, list) else 0
        if levels >= 2 and 0.0 <= level <= levels - 1:
            score = level / (levels - 1)
        else:
            # Already normalised (or no levels to scale against).
            score = level
        score = min(1.0, max(0.0, score))
        implied_confidence = max(probabilities.values(), default=None)

    if "confidence" in entry:
        confidence = _as_unit_float(entry.get("confidence"), field_name=f"{name}.confidence")
    elif expected == "choice" and probabilities:
        confidence = probabilities.get(choice, 0.0)
    elif implied_confidence is not None:
        confidence = implied_confidence
    else:
        confidence = 1.0

    return Answer(
        name=name,
        type=expected,
        choice=choice,
        noul=noul,
        score=score,
        level=level,
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
        answers[name] = _parse_answer(name, question, raw.get(name))
    return answers


def _decision_probabilities(value: Any) -> tuple[dict[str, float], dict[str, str]]:
    """Read ``[{value, label?, probability}]`` into our label -> probability map."""
    if not isinstance(value, list):
        return {}, {}
    probabilities: dict[str, float] = {}
    legend: dict[str, str] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        raw = item.get("value")
        if raw is None:
            continue
        key = raw if isinstance(raw, str) else str(raw)
        probabilities[key] = _as_unit_float(
            item.get("probability", 0.0), field_name=f"probabilities.{key}"
        )
        label = item.get("label")
        if isinstance(label, str) and label.strip():
            legend[key] = label.strip()
    return probabilities, legend


def _parse_decisions_answer(name: str, question: Question, entry: Any) -> Answer:
    """Validate one answer from the ``/v1/decisions`` list shape."""
    if not isinstance(entry, dict):
        raise DecisionError(f"Decision answer '{name}' is missing or malformed.")
    if str(entry.get("type") or "").strip().lower() == "refusal":
        raise DecisionError(f"The decision model declined to answer '{name}'.")

    probabilities, legend = _decision_probabilities(entry.get("probabilities"))
    if not legend and isinstance(question.criteria, list):
        legend = {str(index): str(text) for index, text in enumerate(question.criteria)}

    choice: str | None = None
    noul: bool | None = None
    score: float | None = None
    level: float | None = None
    #: Confidence the provider implied, when it did not send one.
    implied_confidence: float | None = None
    if question.type == "choice":
        raw_choice = entry.get("choice")
        if isinstance(raw_choice, bool):
            raw_choice = "true" if raw_choice else "false"
        if not isinstance(raw_choice, str) or not raw_choice.strip():
            if not probabilities:
                raise DecisionError(f"Choice answer '{name}' is missing 'choice'.")
            raw_choice = max(probabilities, key=probabilities.get)
        choice = raw_choice.strip()
        if probabilities and choice not in probabilities:
            raise DecisionError(
                f"Choice answer '{name}' returned a label absent from its probabilities."
            )
        implied_confidence = probabilities.get(choice, 0.0)
    elif question.type == "noul":
        probability = _as_unit_float(
            entry.get("probability"), field_name=f"{name}.probability"
        )
        noul = probability >= 0.5
        probabilities = probabilities or {
            "true": probability,
            "false": 1.0 - probability,
        }
        implied_confidence = max(probability, 1.0 - probability)
    else:
        if "score" not in entry:
            raise DecisionError(f"Score answer '{name}' is missing 'score'.")
        # Same contract as System One: a probability-weighted level index.
        level = _as_number(entry.get("score"), field_name=f"{name}.score")
        levels = len(question.criteria) if isinstance(question.criteria, list) else 0
        if levels >= 2 and 0.0 <= level <= levels - 1:
            score = level / (levels - 1)
        else:
            score = level
        score = min(1.0, max(0.0, score))
        implied_confidence = max(probabilities.values(), default=0.0)

    if "confidence" in entry:
        confidence = _as_unit_float(
            entry.get("confidence"), field_name=f"{name}.confidence"
        )
    elif implied_confidence is not None:
        confidence = implied_confidence
    else:
        confidence = 1.0

    return Answer(
        name=name,
        type=question.type,
        choice=choice,
        noul=noul,
        score=score,
        level=level,
        probabilities=probabilities,
        confidence=confidence,
        legend=legend,
    )


def _parse_decisions_answers(
    payload: Any, questions: dict[str, Question]
) -> dict[str, Answer]:
    """Validate the ordered ``answers`` list the Decisions API returns."""
    if not isinstance(payload, dict):
        raise DecisionError("The decision provider returned a non-object reply.")
    raw = payload.get("answers")
    if not isinstance(raw, list):
        raise DecisionError("The decision provider reply is missing an 'answers' list.")
    entries = [entry for entry in raw if isinstance(entry, dict)]
    by_name: dict[str, dict[str, Any]] = {}
    unnamed: list[dict[str, Any]] = []
    for entry in entries:
        key = entry.get("name")
        if isinstance(key, str) and key.strip():
            by_name[key.strip()] = entry
        else:
            unnamed.append(entry)
    answers: dict[str, Answer] = {}
    remaining = iter(unnamed)
    for index, (name, question) in enumerate(questions.items()):
        entry = by_name.get(name)
        if entry is None:
            entry = next(remaining, None)
        if entry is None and index < len(entries):
            entry = entries[index]
        if entry is None:
            raise DecisionError(f"Decision answer '{name}' is missing.")
        answers[name] = _parse_decisions_answer(name, question, entry)
    return answers


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #
#: Formats measured by Test (or by an ``auto`` slot), so discovery costs one
#: probe per process instead of one per request.  Failures are never cached:
#: fixing the address or key in Settings must take effect on the next run.
_detected_formats: dict[tuple[str, str], str] = {}
_detected_lock = threading.Lock()


def reset_format_cache() -> None:
    """Forget measured formats (used by tests and after a settings change)."""
    with _detected_lock:
        _detected_formats.clear()


def _probe_questions() -> dict[str, Question]:
    """The one trivial question a connection test asks."""
    return {
        "reachable": Question(
            type="noul",
            instructions="Is this message a connection test?",
            criteria={
                "true": "The state is a connection test.",
                "false": "The state is anything else.",
            },
        )
    }


async def detect_format(
    provider: DecisionProviderConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """Measure which wire shape a service answers, then remember it.

    The probe question is sent in one format at a time - ``decisions`` first
    (the forward-looking OpenAI shape), then ``systemone`` - and the first
    parseable answer wins.  This is a measurement, not a hostname guess: a slot
    left on "Detect automatically" works without the user knowing what a wire
    format is, and an explicit format never pays for it.
    """
    key = (provider.endpoint_url or provider.base_url.rstrip("/"), provider.model)
    with _detected_lock:
        cached = _detected_formats.get(key)
    if cached:
        return cached
    reasons: list[str] = []
    for candidate in (DECISIONS, SYSTEMONE):
        try:
            await _ask(
                provider,
                "This is a connection test.",
                _probe_questions(),
                candidate,
                transport=transport,
            )
        except DecisionError as exc:
            reasons.append(f"{candidate}: {exc}")
            continue
        with _detected_lock:
            _detected_formats[key] = candidate
        return candidate
    raise DecisionError(
        "Could not detect how this service answers decision questions. "
        + " ".join(reasons)
    )


async def decide(
    provider: DecisionProviderConfig,
    state: str | dict[str, Any] | list[Any],
    questions: dict[str, Question],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    cancel_event: Any | None = None,
    wire_format: str | None = None,
) -> dict[str, Answer]:
    """Ask one decision provider a batch of typed questions.

    ``auto`` (the Settings default) measures the format once; a concrete format
    is used as-is.  Retry parity with :func:`services.analyzer.chat`: one
    transient transport failure is retried after a short pause; HTTP errors,
    timeouts and malformed answers raise :class:`DecisionError`.
    """
    if not questions:
        raise DecisionError("At least one decision question is required.")
    fmt = normalize_wire_format(wire_format or provider.wire_format)
    if fmt == AUTO_FORMAT:
        fmt = await detect_format(provider, transport=transport)
    return await _ask(
        provider,
        state,
        questions,
        fmt,
        transport=transport,
        cancel_event=cancel_event,
    )


async def _ask(
    provider: DecisionProviderConfig,
    state: str | dict[str, Any] | list[Any],
    questions: dict[str, Question],
    wire_format: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    cancel_event: Any | None = None,
) -> dict[str, Answer]:
    """One request in a known wire format (no discovery)."""
    if cancel_event is not None and getattr(cancel_event, "is_set", None) and cancel_event.is_set():
        from services.cancel import raise_if_cancelled

        raise_if_cancelled(cancel_event)

    headers = {"Content-Type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    if wire_format == DECISIONS:
        payload: dict[str, Any] = {
            "model": provider.model,
            "input": _decisions_input(state),
            "questions": [
                _decisions_question(name, question)
                for name, question in questions.items()
            ],
        }
    else:
        payload = {
            "model": provider.model,
            "state": state,
            "questions": {name: _question_payload(q) for name, q in questions.items()},
        }
    endpoint = provider.endpoint_for(wire_format)

    try:
        async with httpx.AsyncClient(
            timeout=provider.timeout, transport=transport
        ) as client:
            response: httpx.Response | None = None
            for attempt in range(2):
                try:
                    response = await client.post(
                        endpoint, headers=headers, json=payload
                    )
                except httpx.HTTPError as exc:
                    if attempt == 0:
                        await asyncio.sleep(0.6)
                        continue
                    raise DecisionError(
                        f"Could not reach the decision model at {endpoint}: {exc}"
                    ) from exc
                break
    except httpx.HTTPError as exc:
        raise DecisionError(
            f"Could not reach the decision model at {endpoint}: {exc}"
        ) from exc

    if response is None:
        raise DecisionError(f"Could not reach the decision model at {endpoint}.")
    if response.status_code == 404:
        raise DecisionError(
            f"{endpoint} does not exist (404). This service may use the other "
            "decision format, or the address is wrong - press Test in Settings "
            "to detect it."
        )
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
    if wire_format == DECISIONS:
        return _parse_decisions_answers(body, questions)
    return _parse_answers(body, questions)


async def probe(
    provider: DecisionProviderConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str, Answer]:
    """One trivial question that proves the slot is reachable and compatible.

    Returns the format that answered, so Settings can remember it and the next
    run needs no discovery.
    """
    fmt = normalize_wire_format(provider.wire_format)
    if fmt == AUTO_FORMAT:
        fmt = await detect_format(provider, transport=transport)
    answers = await _ask(
        provider,
        "This is a connection test.",
        _probe_questions(),
        fmt,
        transport=transport,
    )
    return fmt, answers["reachable"]


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
