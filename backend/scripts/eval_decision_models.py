#!/usr/bin/env python3
"""Phase-0 validation harness for the optional decision-model tier.

Subcommands
-----------
``build-fixtures``
    Write labelled examples to ``backend/eval_data/*.jsonl`` plus a manifest.
    Counts are printed; when a task cannot reach the 100-example target the gap
    is recorded honestly instead of padding the set with invented data.

``probe``
    One-question availability probe per candidate model.  Missing models are
    reported with the provider's reason; the runner never crashes on them.

``baselines``
    Score the heuristics that ship today on the same fixtures.

``run``
    Probe + evaluate candidates + baselines, then write
    ``backend/eval_data/report.json`` and ``report.md`` with a per-slot
    recommendation.

Typical local use::

    py -3.12 backend/scripts/eval_decision_models.py build-fixtures
    py -3.12 backend/scripts/eval_decision_models.py run --models tev1,laya

Without a reachable model the report still exists and recommends keeping the
heuristic/LLM path - which is a valid Phase-0 outcome.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import config  # noqa: E402
from services import decision, decision_tasks, quran  # noqa: E402

EVAL_DIR = BACKEND_DIR / "eval_data"
FIXTURE_TARGET = 100

#: Conservative acceptance gate from the plan (see report footer).
MIN_ACCURACY_GAIN = 0.02
MAX_ECE = 0.15

#: Candidate local models named by the plan.  Any model the provider has can be
#: passed with ``--models``; this is only the default probe list.
DEFAULT_CANDIDATES = ["tev1", "tev1:0.8b", "laya", "nimble", "pplx-decider"]

THAI_EXPLANATION_SEEDS = [
    "วันนี้เราจะมาพูดถึงเรื่องความอดทน",
    "ท่านนบีได้กล่าวว่า",
    "ดังนั้นผู้ศรัทธาต้องอดทนต่อการทดสอบ",
    "คุณธรรมข้อนี้สำคัญมากสำหรับชีวิตประจำวัน",
    "เราจะเห็นได้ว่าอัลกุรอานสอนให้เรารู้จักขอบคุณ",
    "อาจารย์ได้อธิบายความหมายของหะดีษบทนี้",
    "ขอให้ทุกคนนำไปปฏิบัติในชีวิตจริง",
    "เรื่องเล่านี้สอนให้เราไม่หมดหวัง",
    "การงานที่ดีจะช่วยให้จิตใจสงบ",
    "เรามาเริ่มต้นด้วยการกล่าวบิสมิลลาห์",
]

THAI_ARABIC_SEEDS = [
    "นะวายีรก็ลลุกมุรฺรี",
    "อุฟาริจูอ๊สกาละถ้ากุกกล่าวให้พวกเจ้า",
    "บิสมิลลาฮิรเราะห์มานิรเราะฮีม",
    "อัลฮัมดุลิลลาฮิรอบบิลอาละมีน",
    "ลาอิลาฮะอิลลัลลอฮฺ",
    "ศ็อลลัลลอฮุอะลัยฮิวะซัลลัม",
    "อัสลามุอะลัยกุมวะเราะห์มะตุลลอฮฺ",
    "ยาซีนวัลกุรอานิลฮากีม",
]

HADITH_SEEDS = [
    "إنما الأعمال بالنيات",
    "الدين النصيحة",
    "من كان يؤمن بالله واليوم الآخر فليقل خيرا أو ليصمت",
    "لا يؤمن أحدكم حتى يحب لأخيه ما يحب لنفسه",
]

ARABIC_QUOTE_SEEDS = [
    "لا حول ولا قوة إلا بالله",
    "حسبنا الله ونعم الوكيل",
    "اللهم صل على محمد",
    "ربنا آتنا في الدنيا حسنة وفي الآخرة حسنة",
]


# --------------------------------------------------------------------------- #
# Fixture builders
# --------------------------------------------------------------------------- #
def _corpus_rows() -> list[tuple[int, int, str, str]]:
    try:
        payload = json.loads(quran.CORPUS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows: list[tuple[int, int, str, str]] = []
    for row in payload.get("verses") or []:
        if isinstance(row, (list, tuple)) and len(row) >= 4:
            rows.append((int(row[0]), int(row[1]), str(row[2]), str(row[3])))
    return rows


def _spread(rows: list[tuple[int, int, str, str]], count: int) -> list[tuple[int, int, str, str]]:
    if not rows:
        return []
    step = max(1, len(rows) // count)
    picked = rows[::step][:count]
    return picked or rows[:count]


def _strip_diacritics(text: str) -> str:
    return quran._DIACRITICS.sub("", text)


def _swap_letter(text: str) -> str:
    """Swap two adjacent non-space letters near the middle (deterministic)."""
    positions = [
        index
        for index in range(1, len(text) - 1)
        if text[index].isalpha() and text[index + 1].isalpha() and text[index] != text[index + 1]
    ]
    if not positions:
        return text + " ٮ"
    middle = positions[len(positions) // 2]
    return text[:middle] + text[middle + 1] + text[middle] + text[middle + 2 :]


def build_fixtures() -> dict[str, Any]:
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    verses = _spread(_corpus_rows(), 60)

    # (a) Recitation classification -----------------------------------------
    recitation_rows: list[dict[str, Any]] = []
    for index, verse in enumerate(verses[:40]):
        recitation_rows.append(
            {
                "segment": {
                    "id": index,
                    "start": float(index * 6),
                    "end": float(index * 6 + 5),
                    "text": verse[2],
                },
                "label": "quran",
                "language": "ar",
                "source": "quran-corpus",
            }
        )
    for index, text in enumerate(THAI_EXPLANATION_SEEDS):
        recitation_rows.append(
            {
                "segment": {"id": 100 + index, "start": 0.0, "end": 4.0, "text": text},
                "label": "none",
                "language": "th",
                "source": "curated-thai",
            }
        )
    for index, text in enumerate(THAI_ARABIC_SEEDS):
        recitation_rows.append(
            {
                "segment": {"id": 200 + index, "start": 0.0, "end": 4.0, "text": text},
                "label": "quran",
                "language": "th",
                "source": "curated-thai-arabic",
            }
        )
    for index, text in enumerate(HADITH_SEEDS):
        recitation_rows.append(
            {
                "segment": {"id": 300 + index, "start": 0.0, "end": 4.0, "text": text},
                "label": "hadith",
                "language": "ar",
                "source": "curated-hadith",
            }
        )
    for index, text in enumerate(ARABIC_QUOTE_SEEDS):
        recitation_rows.append(
            {
                "segment": {"id": 400 + index, "start": 0.0, "end": 4.0, "text": text},
                "label": "quote",
                "language": "ar",
                "source": "curated-quote",
            }
        )

    # (b) Verify triage: clean vs. corrupted corpus lines --------------------
    triage_rows: list[dict[str, Any]] = []
    for surah, ayah, arabic, _thai in verses:
        if len(arabic.split()) < 3:
            continue
        triage_rows.append(
            {
                "arabic_text": arabic,
                "context_thai": "บริบทภาษาไทย",
                "label": False,
                "variant": "clean",
                "language": "ar",
                "reference": f"{surah}:{ayah}",
            }
        )
        triage_rows.append(
            {
                "arabic_text": _strip_diacritics(arabic),
                "context_thai": "บริบทภาษาไทย",
                "label": True,
                "variant": "missing-harakat",
                "language": "ar",
                "reference": f"{surah}:{ayah}",
            }
        )
        triage_rows.append(
            {
                "arabic_text": _swap_letter(arabic),
                "context_thai": "บริบทภาษาไทย",
                "label": True,
                "variant": "swapped-letter",
                "language": "ar",
                "reference": f"{surah}:{ayah}",
            }
        )

    # (c) Clip scoring: seeded good/bad candidate windows --------------------
    clip_rows: list[dict[str, Any]] = []
    sentence_pool = THAI_EXPLANATION_SEEDS + [verse[3] for verse in verses[:10]]
    for index in range(120):
        variant = ("complete", "mid-sentence-start", "filler", "too-short")[index % 4]
        if variant == "complete":
            body = " ".join(
                sentence_pool[index % len(sentence_pool) :][:3]
                or sentence_pool[:3]
            )
            start, end, label = 10.0, 70.0, True
        elif variant == "mid-sentence-start":
            body = " ".join(sentence_pool[index % len(sentence_pool) :][:3])
            start, end, label = 10.0, 70.0, False
            body = "…" + body[3:]
        elif variant == "filler":
            body = "อ่า คือว่า เอ่อ วันนี้เรามาเริ่มกันเลยนะครับ"
            start, end, label = 10.0, 60.0, False
        else:
            body = sentence_pool[index % len(sentence_pool)]
            start, end, label = 10.0, 17.0, False
        clip_rows.append(
            {
                "id": f"cand{index:03d}",
                "start": start,
                "end": end,
                "text": body,
                "label": label,
                "variant": variant,
                "language": "th",
            }
        )

    files = {
        "recitation.jsonl": recitation_rows,
        "verify_triage.jsonl": triage_rows,
        "clip_scoring.jsonl": clip_rows,
    }
    counts: dict[str, int] = {}
    for name, rows in files.items():
        counts[name.removesuffix(".jsonl")] = len(rows)
        with (EVAL_DIR / name).open("w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    gaps = {
        task: max(0, FIXTURE_TARGET - count)
        for task, count in counts.items()
        if count < FIXTURE_TARGET
    }
    manifest = {
        "builtAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "counts": counts,
        "gaps": gaps,
        "notes": {
            "recitation": (
                "No real lecture transcript is stored in the repository, so Thai "
                "explanation and Thai-script-Arabic rows are curated seeds; the "
                "Qur'an rows are real corpus text. Treat Thai accuracy as indicative."
            ),
            "verify_triage": (
                "Corruptions are synthetic (diacritics dropped, one letter swapped) "
                "and ground truth is exact by construction."
            ),
            "clip_scoring": (
                "Candidates are synthetic windows with seeded quality labels; this "
                "measures rubric adherence, not real-lecture recall."
            ),
        },
        "candidates": DEFAULT_CANDIDATES,
    }
    (EVAL_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return manifest


# --------------------------------------------------------------------------- #
# Metric helpers
# --------------------------------------------------------------------------- #
def _load_rows(name: str) -> list[dict[str, Any]]:
    path = EVAL_DIR / name
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _ece(records: list[tuple[float, bool]], bins: int = 10) -> float | None:
    if not records:
        return None
    buckets: list[list[tuple[float, bool]]] = [[] for _ in range(bins)]
    for confidence, correct in records:
        index = min(bins - 1, max(0, int(confidence * bins)))
        buckets[index].append((confidence, correct))
    total = len(records)
    ece = 0.0
    for bucket in buckets:
        if not bucket:
            continue
        mean_confidence = sum(item[0] for item in bucket) / len(bucket)
        accuracy = sum(1 for item in bucket if item[1]) / len(bucket)
        ece += (len(bucket) / total) * abs(mean_confidence - accuracy)
    return ece


def _accuracy(records: Iterable[tuple[bool, bool]]) -> float | None:
    pairs = list(records)
    if not pairs:
        return None
    return sum(1 for predicted, truth in pairs if predicted == truth) / len(pairs)


def _metric_block(records: list[tuple[Any, Any, float]]) -> dict[str, Any]:
    if not records:
        return {"count": 0, "accuracy": None, "ece": None}
    accuracy = sum(1 for predicted, truth, _ in records if predicted == truth) / len(records)
    return {
        "count": len(records),
        "accuracy": round(accuracy, 4),
        "ece": None
        if any(math.isnan(confidence) for _, _, confidence in records)
        else round(
            _ece([(confidence, predicted == truth) for predicted, truth, confidence in records])
            or 0.0,
            4,
        ),
    }


# --------------------------------------------------------------------------- #
# Task adapters used by the runner
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Prediction:
    value: Any
    confidence: float


async def _predict_recitation(
    provider: decision.DecisionProviderConfig,
    rows: list[dict[str, Any]],
    transport: Any = None,
) -> list[Prediction] | None:
    predictions: list[Prediction] = []
    batch_size = 24
    for offset in range(0, len(rows), batch_size):
        chunk = rows[offset : offset + batch_size]
        segments = [row["segment"] for row in chunk]
        state, questions = decision_tasks.recitation_request(segments)
        try:
            answers = await decision.decide(
                provider, state, questions, transport=transport
            )
        except decision.DecisionError:
            return None
        for segment in segments:
            answer = answers.get(f"segment_{segment['id']}")
            label = answer.choice if answer and answer.choice else "none"
            predictions.append(
                Prediction(label, answer.confidence if answer else 0.0)
            )
    return predictions


async def _predict_triage(
    provider: decision.DecisionProviderConfig,
    rows: list[dict[str, Any]],
    transport: Any = None,
) -> list[Prediction] | None:
    predictions: list[Prediction] = []
    batch_size = 32
    for offset in range(0, len(rows), batch_size):
        chunk = rows[offset : offset + batch_size]
        state, questions = decision_tasks.verify_triage_request(chunk)
        try:
            answers = await decision.decide(
                provider, state, questions, transport=transport
            )
        except decision.DecisionError:
            return None
        decisions = decision_tasks.triage_from_answers(answers, len(chunk))
        for item in decisions:
            predictions.append(Prediction(bool(item.proofread), item.confidence))
    return predictions


async def _predict_clips(
    provider: decision.DecisionProviderConfig,
    rows: list[dict[str, Any]],
    transport: Any = None,
) -> list[Prediction] | None:
    predictions: list[Prediction] = []
    batch_size = 12
    for offset in range(0, len(rows), batch_size):
        chunk = rows[offset : offset + batch_size]
        candidates = [
            decision_tasks.ClipCandidate(
                id=str(row["id"]),
                start=float(row["start"]),
                end=float(row["end"]),
                text=str(row["text"]),
            )
            for row in chunk
        ]
        state, questions = decision_tasks.clip_scoring_request(
            candidates, brief="", min_duration=15.0, max_duration=90.0
        )
        try:
            answers = await decision.decide(
                provider, state, questions, transport=transport
            )
        except decision.DecisionError:
            return None
        scores = decision_tasks.scores_from_answers(
            [candidate.id for candidate in candidates], answers
        )
        by_id = {score.id: score for score in scores}
        for candidate in candidates:
            score = by_id[candidate.id]
            predictions.append(
                Prediction(score.rank_score >= 0.5, score.confidence)
            )
    return predictions


# --------------------------------------------------------------------------- #
# Baselines (today's heuristics)
# --------------------------------------------------------------------------- #
_ARABIC_CHAR = re.compile(r"[\u0600-\u06FF]")


def _recitation_baseline(row: dict[str, Any]) -> Any:
    text = str(row["segment"]["text"])
    if _ARABIC_CHAR.search(text):
        return "quran"
    if quran.normalize_arabic(text):
        return "quran"
    return "none"


def _triage_baseline(row: dict[str, Any]) -> bool:
    """Corpus-exact lines pass untouched; everything else is proofread."""
    text = str(row["arabic_text"])
    match = quran.match_text(text, min_score=0.99)
    return not (
        match is not None
        and quran.normalize_arabic(match.arabic) == quran.normalize_arabic(text)
    )


def _clip_baseline(row: dict[str, Any]) -> bool:
    duration = float(row["end"]) - float(row["start"])
    body = str(row["text"])
    filler = any(token in body for token in ("อ่า", "เอ่อ", "คือว่า"))
    return 15.0 <= duration <= 90.0 and not filler


def baseline_metrics() -> dict[str, Any]:
    recitation_rows = _load_rows("recitation.jsonl")
    triage_rows = _load_rows("verify_triage.jsonl")
    clip_rows = _load_rows("clip_scoring.jsonl")
    return {
        "recitation": _metric_block(
            [
                (_recitation_baseline(row), row["label"], 1.0)
                for row in recitation_rows
            ]
        ),
        "verify_triage": _metric_block(
            [
                (_triage_baseline(row), bool(row["label"]), 1.0)
                for row in triage_rows
            ]
        ),
        "clip_scoring": _metric_block(
            [
                (_clip_baseline(row), bool(row["label"]), 1.0)
                for row in clip_rows
            ]
        ),
    }


# --------------------------------------------------------------------------- #
# Candidate evaluation
# --------------------------------------------------------------------------- #
def _provider_for(model: str, args: argparse.Namespace) -> decision.DecisionProviderConfig | None:
    override = decision.DecisionProviderOverride(
        mode=None,
        base_url=args.base_url,
        api_key=args.api_key,
        model=model,
        endpoint_style=args.style,
        timeout=args.timeout,
    )
    return decision.merge_decision_provider(override)


def _records_for(
    task: str,
    rows: list[dict[str, Any]],
    predictions: list[Prediction] | None,
) -> list[tuple[Any, Any, float]]:
    if predictions is None or len(predictions) != len(rows):
        return []
    records: list[tuple[Any, Any, float]] = []
    for row, prediction in zip(rows, predictions):
        if task == "recitation":
            records.append((prediction.value, row["label"], prediction.confidence))
        elif task == "verify_triage":
            records.append((bool(prediction.value), bool(row["label"]), prediction.confidence))
        else:
            records.append((bool(prediction.value), bool(row["label"]), prediction.confidence))
    return records


def _language_breakdown(
    rows: list[dict[str, Any]], predictions: list[Prediction] | None, task: str
) -> dict[str, Any]:
    if predictions is None or len(predictions) != len(rows):
        return {}
    languages: dict[str, list[tuple[Any, Any, float]]] = {}
    for row, prediction in zip(rows, predictions):
        key = str(row.get("language") or "unknown")
        value = prediction.value
        truth = row["label"] if task == "recitation" else bool(row["label"])
        languages.setdefault(key, []).append((value, truth, prediction.confidence))
    return {key: _metric_block(value) for key, value in sorted(languages.items())}


async def evaluate_candidate(
    model: str, args: argparse.Namespace
) -> dict[str, Any]:
    provider = _provider_for(model, args)
    result: dict[str, Any] = {"model": model, "available": False, "tasks": {}}
    if provider is None:
        result["reason"] = "No decision model configured (pass --models or set TAFSEER_DECISION_MODEL)."
        return result
    try:
        fmt, _answer = await decision.probe(provider)
        result["available"] = True
        result["format"] = fmt
        result["endpoint"] = provider.endpoint_for(fmt)
    except decision.DecisionError as exc:
        result["reason"] = str(exc)
        return result

    tasks = {
        "recitation": ("recitation.jsonl", _predict_recitation),
        "verify_triage": ("verify_triage.jsonl", _predict_triage),
        "clip_scoring": ("clip_scoring.jsonl", _predict_clips),
    }
    for task, (file_name, predictor) in tasks.items():
        rows = _load_rows(file_name)
        if not rows:
            result["tasks"][task] = {"count": 0, "accuracy": None, "ece": None}
            continue
        predictions = await predictor(provider, rows)
        records = _records_for(task, rows, predictions)
        block = _metric_block(records)
        block["languages"] = _language_breakdown(rows, predictions, task)
        result["tasks"][task] = block
    return result


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def recommend(
    slot: str,
    candidates: list[dict[str, Any]],
    baseline: dict[str, Any],
    *,
    task: str,
) -> dict[str, Any]:
    baseline_accuracy = baseline.get("accuracy")
    eligible: list[tuple[float, dict[str, Any]]] = []
    for candidate in candidates:
        block = candidate.get("tasks", {}).get(task) or {}
        accuracy = block.get("accuracy")
        ece = block.get("ece")
        if accuracy is None or ece is None:
            continue
        if (
            baseline_accuracy is not None
            and accuracy < baseline_accuracy + MIN_ACCURACY_GAIN
        ):
            continue
        if ece > MAX_ECE:
            continue
        eligible.append((accuracy, candidate))
    if not eligible:
        return {
            "slot": slot,
            "winner": None,
            "action": "keep-today",
            "reason": (
                "No candidate beat the shipping baseline by "
                f"{MIN_ACCURACY_GAIN:.0%} with ECE <= {MAX_ECE:.0%}."
            ),
        }
    accuracy, winner = max(eligible, key=lambda item: item[0])
    return {
        "slot": slot,
        "winner": winner["model"],
        "action": "enable",
        "accuracy": accuracy,
        "ece": winner["tasks"][task]["ece"],
        "baseline_accuracy": baseline_accuracy,
    }


def write_report(evaluation: dict[str, Any]) -> dict[str, Any]:
    baselines = evaluation["baselines"]
    candidates = evaluation["candidates"]
    recommendations = [
        recommend("analysis", candidates, baselines["recitation"], task="recitation"),
        recommend(
            "clip_scoring", candidates, baselines["clip_scoring"], task="clip_scoring"
        ),
        recommend(
            "verify_triage", candidates, baselines["verify_triage"], task="verify_triage"
        ),
    ]
    report = {
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "gate": {
            "minAccuracyGain": MIN_ACCURACY_GAIN,
            "maxEce": MAX_ECE,
        },
        "baselines": baselines,
        "candidates": candidates,
        "recommendations": recommendations,
        "unavailable": [
            {"model": candidate["model"], "reason": candidate.get("reason", "")}
            for candidate in candidates
            if not candidate.get("available")
        ],
    }
    (EVAL_DIR / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    lines: list[str] = [
        "# Decision-model evaluation (Phase 0)",
        "",
        f"Generated: {report['generatedAt']}",
        f"Gate: accuracy gain ≥ {MIN_ACCURACY_GAIN:.0%}, ECE ≤ {MAX_ECE:.0%}",
        "",
        "## Baselines (today's heuristics)",
        "",
        "| Task | Examples | Accuracy | ECE |",
        "|---|---:|---:|---:|",
    ]
    for task, block in baselines.items():
        lines.append(
            f"| {task} | {block.get('count', 0)} | {_fmt(block.get('accuracy'))} | "
            f"{_fmt(block.get('ece'))} |"
        )
    lines += ["", "## Candidates", ""]
    if not candidates:
        lines.append("No candidate was evaluated (no model configured).")
    for candidate in candidates:
        lines.append(f"### {candidate['model']}")
        if not candidate.get("available"):
            lines.append(f"- unavailable: {candidate.get('reason', 'unknown')}")
            continue
        lines.append(f"- endpoint: `{candidate.get('endpoint', '')}`")
        lines.append("")
        lines.append("| Task | Examples | Accuracy | ECE |")
        lines.append("|---|---:|---:|---:|")
        for task, block in candidate["tasks"].items():
            lines.append(
                f"| {task} | {block.get('count', 0)} | {_fmt(block.get('accuracy'))} | "
                f"{_fmt(block.get('ece'))} |"
            )
        lines.append("")
    lines += ["## Per-slot recommendation", ""]
    for item in recommendations:
        if item["action"] == "enable":
            lines.append(
                f"- **{item['slot']}**: enable `{item['winner']}` "
                f"(accuracy {_fmt(item['accuracy'])} vs baseline "
                f"{_fmt(item['baseline_accuracy'])}, ECE {_fmt(item['ece'])})."
            )
        else:
            lines.append(f"- **{item['slot']}**: keep today's path — {item['reason']}")
    lines += [
        "",
        "## Known gaps",
        "",
    ]
    manifest_path = EVAL_DIR / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for task, note in manifest.get("notes", {}).items():
            lines.append(f"- {task}: {note}")
        for task, gap in manifest.get("gaps", {}).items():
            lines.append(f"- {task}: {gap} examples short of the {FIXTURE_TARGET} target.")
    else:
        lines.append("- Fixtures were not built; run `build-fixtures` first.")
    lines.append("")
    (EVAL_DIR / "report.md").write_text("\n".join(lines), encoding="utf-8")
    return report


def _fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _ensure_fixtures() -> None:
    if not (EVAL_DIR / "manifest.json").is_file():
        manifest = build_fixtures()
        print(f"Built fixtures: {manifest['counts']}")
        for task, gap in manifest["gaps"].items():
            print(f"  gap: {task} is {gap} examples short of {FIXTURE_TARGET}")


async def _run(args: argparse.Namespace) -> int:
    _ensure_fixtures()
    models = args.models or DEFAULT_CANDIDATES
    results: list[dict[str, Any]] = []
    for model in models:
        print(f"Evaluating {model}…")
        results.append(await evaluate_candidate(model, args))
    evaluation = {"baselines": baseline_metrics(), "candidates": results}
    report = write_report(evaluation)
    print(json.dumps(report["recommendations"], indent=2, ensure_ascii=False))
    print(f"Report: {EVAL_DIR / 'report.md'}")
    return 0


async def _probe(args: argparse.Namespace) -> int:
    models = args.models or DEFAULT_CANDIDATES
    for model in models:
        provider = _provider_for(model, args)
        if provider is None:
            print(f"{model}: no decision provider configured")
            continue
        try:
            fmt, answer = await decision.probe(provider)
        except decision.DecisionError as exc:
            print(f"{model}: unavailable — {exc}")
            continue
        print(
            f"{model}: available at {provider.endpoint_for(fmt)} [{fmt}] "
            f"(answer={answer.noul}, confidence={answer.confidence:.2f})"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build-fixtures", "probe", "baselines", "run"])
    parser.add_argument("--models", nargs="*", help="Model ids to probe/evaluate.")
    parser.add_argument("--base-url", help="Decision service address (default: TAFSEER_DECISION_*).")
    parser.add_argument("--api-key", help="Bearer token for a cloud decision service.")
    parser.add_argument(
        "--style",
        help="Endpoint style: auto, ollama, openrouter, perplexity, runware, typesafe.",
    )
    parser.add_argument("--timeout", type=float, help="Per-request timeout in seconds.")
    args = parser.parse_args(argv)

    if args.command == "build-fixtures":
        manifest = build_fixtures()
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
        return 0
    if args.command == "baselines":
        _ensure_fixtures()
        print(json.dumps(baseline_metrics(), indent=2))
        return 0
    if args.command == "probe":
        return asyncio.run(_probe(args))
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
