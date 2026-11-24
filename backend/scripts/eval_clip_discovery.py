#!/usr/bin/env python3
"""Blind editorial review of Step 2 clip discovery.

Step 2 has one pipeline: the writing model reads transcript windows and
proposes clips.  This harness measures whether those clips are any good, and
whether the model is leaving good material on the table.

Subcommands
-----------
``run``
    Run discovery over one or more ``.tafseer`` projects and record each
    lecture's clips, wall time and captured warnings.

``sheet``
    Build ``review.csv``: the model's clips plus a few control windows it did
    *not* propose, shuffled together so a rating is blind to which is which.
    Rate each row 0 (not a clip), 1 (usable) or 2 (strong).  The mapping lives
    in ``key.json``; do not open it before rating.

``report``
    Join ``review.csv`` with ``key.json`` and report precision on the model's
    clips versus the control base rate.  A high control precision means the
    model is missing good material; a low one means it is not.

Typical local use::

    py -3.12 backend/scripts/eval_clip_discovery.py run
    py -3.12 backend/scripts/eval_clip_discovery.py sheet --controls 6
    # ... edit backend/.tmp/clip_discovery/review.csv ...
    py -3.12 backend/scripts/eval_clip_discovery.py report

Real lecture transcripts are personal data: everything is written under
``backend/.tmp/`` (gitignored), never under ``backend/eval_data/``.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import datetime
import json
import logging
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import analyzer  # noqa: E402

DEFAULT_OUT = BACKEND_DIR / ".tmp" / "clip_discovery"
DEFAULT_PROJECTS = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "com.muham.tafseer-clipper"
    / "projects"
)

#: A control window only counts as "not proposed" below this overlap.
CONTROL_EXCLUDE_IOU = 0.2
#: Transcript text shown per review row.
SHEET_TEXT_CHARS = 400


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Lecture:
    id: str
    name: str
    duration: float
    segments: list[dict[str, Any]]
    base_prompt: str
    session_guide: str
    language: str


def load_lecture(path: Path) -> Lecture | None:
    """Read a ``.tafseer`` project; ``None`` when it has no transcript yet."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    project = doc.get("project") or {}
    transcript = project.get("transcript") or {}
    segments = transcript.get("segments") or []
    duration = project.get("duration")
    if not segments or not isinstance(duration, (int, float)) or duration <= 0:
        return None
    return Lecture(
        id=str(project.get("id") or path.stem),
        name=str(project.get("name") or path.stem),
        duration=float(duration),
        segments=segments,
        base_prompt=str(project.get("basePrompt") or ""),
        session_guide=str(project.get("sessionGuide") or ""),
        language=str(transcript.get("language") or "th"),
    )


def _app_cloud_settings() -> dict[str, Any]:
    """Read the writing-model settings the desktop app last saved.

    Best effort: WebView2 appends settings writes to a LevelDB log, so the
    newest occurrence of the ``"cloud"`` block is the current one.  The key is
    never printed; callers only forward it to the provider config.
    """
    leveldb = (
        Path(os.environ.get("LOCALAPPDATA", ""))
        / "com.muham.tafseer-clipper"
        / "EBWebView"
        / "Default"
        / "Local Storage"
        / "leveldb"
    )
    logs = sorted(leveldb.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    for log in logs:
        raw = log.read_bytes().decode("utf-16-le", errors="ignore")
        start = raw.rfind('"cloud":{"baseUrl"')
        if start < 0:
            continue
        blob = raw[start : start + 500]
        base_url = re.search(r'"baseUrl":"([^"]*)"', blob)
        api_key = re.search(r'"apiKey":"([^"]*)"', blob)
        model = re.search(r'"model":"([^"]*)"', blob)
        timeout = re.search(r'"timeout":(\d+)', blob)
        if base_url and model:
            return {
                "base_url": base_url.group(1),
                "api_key": api_key.group(1) if api_key else None,
                "model": model.group(1),
                "timeout": float(timeout.group(1)) if timeout else 120.0,
            }
    raise SystemExit(
        "Could not read the app's writing-model settings. Pass --base-url, "
        "--api-key and --model explicitly."
    )


def writing_provider(args: argparse.Namespace) -> analyzer.ProviderConfig:
    if args.base_url:
        if not args.model:
            raise SystemExit("--model is required with --base-url.")
        return analyzer.ProviderConfig(
            base_url=args.base_url,
            api_key=args.api_key,
            model=args.model,
            timeout=args.timeout or 120.0,
        )
    cfg = _app_cloud_settings()
    return analyzer.ProviderConfig(
        base_url=cfg["base_url"],
        api_key=cfg["api_key"],
        model=cfg["model"],
        timeout=cfg["timeout"],
    )


# --------------------------------------------------------------------------- #
# Run
# --------------------------------------------------------------------------- #
class _Capture(logging.Handler):
    """Keep the warnings a run emitted, so failures are visible in results."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.messages.append(record.getMessage())
        except Exception:  # pragma: no cover - logging must never break a run
            pass


async def _run_lecture(
    lecture: Lecture, *, writing: analyzer.ProviderConfig
) -> dict[str, Any]:
    logger = logging.getLogger("tafseer.analyzer")
    capture = _Capture()
    logger.addHandler(capture)
    started = time.monotonic()
    try:
        clips = await analyzer.discover_clips(
            segments=lecture.segments,
            duration=lecture.duration,
            base_prompt=lecture.base_prompt,
            session_guide=lecture.session_guide,
            refinement_note="",
            excluded_ranges=[],
            provider=writing,
            language=lecture.language,
        )
        return {
            "ok": True,
            "clips": clips,
            "elapsed_s": round(time.monotonic() - started, 2),
            "warnings": list(capture.messages),
        }
    except Exception as exc:  # noqa: BLE001 - a failed run is a data point
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "clips": [],
            "elapsed_s": round(time.monotonic() - started, 2),
            "warnings": list(capture.messages),
        }
    finally:
        logger.removeHandler(capture)


async def _run(args: argparse.Namespace) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    project_paths = [Path(p) for p in (args.project or [])]
    if not project_paths:
        if not DEFAULT_PROJECTS.is_dir():
            raise SystemExit(f"No --project given and {DEFAULT_PROJECTS} does not exist.")
        project_paths = sorted(DEFAULT_PROJECTS.glob("*.tafseer"))

    lectures = [lec for lec in (load_lecture(p) for p in project_paths) if lec]
    if not lectures:
        raise SystemExit("No project with a finished transcript was found.")

    writing = writing_provider(args)
    print(f"writing model: {writing.model} at {writing.base_url}")

    payload: dict[str, Any] = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "writing_model": writing.model,
        "lectures": [],
    }
    for lecture in lectures:
        print(f"running {lecture.name} ({lecture.duration:.0f}s, {len(lecture.segments)} segments)")
        run = await _run_lecture(lecture, writing=writing)
        status = "ok" if run["ok"] else "failed"
        print(f"  {status}: {len(run['clips'])} clips in {run['elapsed_s']:.1f}s")
        if not run["ok"]:
            print(f"    error: {run['error']}")
        payload["lectures"].append(
            {
                "id": lecture.id,
                "name": lecture.name,
                "duration": lecture.duration,
                "settings": {
                    "mode": "model-decided",
                    "safety_min_seconds": analyzer.SAFETY_MIN_CLIP_SECONDS,
                    "flood_ceiling": analyzer.flood_ceiling(lecture["duration"]),
                },
                "run": run,
            }
        )

    target = out / "results.json"
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    # Segments live beside the results, never inside them: the sheet needs the
    # transcript text, but results.json stays small enough to read by hand.
    (out / "lectures.json").write_text(
        json.dumps(
            [
                {"id": lecture.id, "name": lecture.name, "segments": lecture.segments}
                for lecture in lectures
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"wrote {target}")
    return 0


# --------------------------------------------------------------------------- #
# Sheet
# --------------------------------------------------------------------------- #
def _iou(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    inter = max(0.0, min(a_end, b_end) - max(a_start, b_start))
    union = max(a_end, b_end) - min(a_start, b_start)
    return inter / union if union > 0 else 0.0


def _window_text(segments: list[dict[str, Any]], start: float, end: float) -> str:
    parts: list[str] = []
    for segment in segments:
        try:
            seg_start = float(segment["start"])
            seg_end = float(segment["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if seg_end > start and seg_start < end:
            text = str(segment.get("text") or "").strip()
            if text:
                parts.append(text)
    return " ".join(parts)[:SHEET_TEXT_CHARS]


def _even_sample(items: list[Any], count: int) -> list[Any]:
    if count <= 0 or not items:
        return []
    if len(items) <= count:
        return list(items)
    step = len(items) / count
    return [items[min(len(items) - 1, int(index * step))] for index in range(count)]


def _build_sheet(args: argparse.Namespace) -> int:
    out = Path(args.out)
    results = json.loads((out / "results.json").read_text(encoding="utf-8"))
    segments_by_lecture = {
        lecture["id"]: lecture.get("segments") or []
        for lecture in json.loads((out / "lectures.json").read_text(encoding="utf-8"))
    }

    items: list[dict[str, Any]] = []
    for lecture in results["lectures"]:
        segments = segments_by_lecture.get(lecture["id"], [])
        proposed = [
            {
                "lecture": lecture["id"],
                "lecture_name": lecture["name"],
                "start": float(clip["start"]),
                "end": float(clip["end"]),
                "source": "proposed",
            }
            for clip in (lecture.get("run") or {}).get("clips") or []
        ]
        candidates = analyzer.generate_clip_candidates(
            segments,
            duration=lecture["duration"],
            excluded_ranges=[],
            min_duration=analyzer.SAFETY_MIN_CLIP_SECONDS,
        )
        controls = [
            candidate
            for candidate in candidates
            if not any(
                _iou(
                    float(candidate["start"]),
                    float(candidate["end"]),
                    item["start"],
                    item["end"],
                )
                > CONTROL_EXCLUDE_IOU
                for item in proposed
            )
        ]
        for candidate in _even_sample(controls, args.controls):
            proposed.append(
                {
                    "lecture": lecture["id"],
                    "lecture_name": lecture["name"],
                    "start": float(candidate["start"]),
                    "end": float(candidate["end"]),
                    "source": "control",
                }
            )
        for item in proposed:
            item["text"] = _window_text(segments, item["start"], item["end"])
        items.extend(proposed)

    random.Random(args.seed).shuffle(items)
    key: dict[str, Any] = {}
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        item_id = f"r{index:03d}"
        key[item_id] = {
            "lecture": item["lecture"],
            "lecture_name": item["lecture_name"],
            "source": item["source"],
            "kind": item["source"],
            "start": item["start"],
            "end": item["end"],
        }
        rows.append(
            {
                "item_id": item_id,
                "lecture": item["lecture_name"],
                "start": f"{item['start']:.1f}",
                "end": f"{item['end']:.1f}",
                "duration_s": f"{item['end'] - item['start']:.0f}",
                "text": item["text"],
                "rating": "",
                "note": "",
            }
        )

    csv_path = out / "review.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (out / "key.json").write_text(
        json.dumps(key, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    counts = {"proposed": 0, "control": 0}
    for item in key.values():
        counts[item["source"]] = counts.get(item["source"], 0) + 1
    print(f"wrote {csv_path} ({len(rows)} rows: {counts})")
    print("Rate each row 0 (not a clip), 1 (usable) or 2 (strong); blank = skip.")
    print("Do not open key.json before rating: it reveals which rows are controls.")
    return 0


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def _read_ratings(path: Path) -> dict[str, int]:
    ratings: dict[str, int] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            raw = (row.get("rating") or "").strip()
            if raw in {"", "?", "-"}:
                continue
            try:
                ratings[row["item_id"]] = max(0, min(2, int(float(raw))))
            except (TypeError, ValueError):
                continue
    return ratings


def _group_metrics(
    key: dict[str, Any], ratings: dict[str, int], source: str
) -> dict[str, Any]:
    values = [
        rating
        for item_id, rating in ratings.items()
        if key.get(item_id, {}).get("source") == source
    ]
    if not values:
        return {"rated": 0, "usable": 0, "strong": 0, "mean": 0.0, "precision": 0.0}
    usable = sum(1 for value in values if value >= 1)
    strong = sum(1 for value in values if value == 2)
    return {
        "rated": len(values),
        "usable": usable,
        "strong": strong,
        "mean": sum(values) / len(values),
        "precision": usable / len(values),
    }


def _report(args: argparse.Namespace) -> int:
    out = Path(args.out)
    results = json.loads((out / "results.json").read_text(encoding="utf-8"))
    key = json.loads((out / "key.json").read_text(encoding="utf-8"))
    ratings = _read_ratings(out / "review.csv")
    if not ratings:
        raise SystemExit("No ratings found in review.csv; fill the rating column first.")

    lines: list[str] = []
    lines.append("# Clip discovery - blind review")
    lines.append("")
    lines.append(f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"Writing model: {results.get('writing_model')}")
    lines.append(f"Rated rows: {len(ratings)} of {len(key)}")
    lines.append("")

    lines.append("## Preference (0 = not a clip, 1 = usable, 2 = strong)")
    lines.append("")
    lines.append("| Rows | Rated | Usable+ | Strong | Mean | Precision |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for source in ("proposed", "control"):
        metric = _group_metrics(key, ratings, source)
        lines.append(
            f"| {source} | {metric['rated']} | {metric['usable']} | {metric['strong']} "
            f"| {metric['mean']:.2f} | {metric['precision']:.0%} |"
        )
    lines.append("")
    lines.append(
        "`control` rows are windows the model did not propose. Controls rating as "
        "well as proposals means the model is leaving good material on the table."
    )
    lines.append("")

    lines.append("## Runs")
    lines.append("")
    lines.append("| Lecture | Clips | Seconds |")
    lines.append("|---|---:|---:|")
    for lecture in results["lectures"]:
        run = lecture.get("run") or {}
        lines.append(
            f"| {lecture['name']} | {len(run.get('clips') or [])} "
            f"| {run.get('elapsed_s', 0):.1f} |"
        )
    lines.append("")

    warnings = [
        f"{lecture['name']}: {message}"
        for lecture in results["lectures"]
        for message in (lecture.get("run") or {}).get("warnings") or []
    ]
    if warnings:
        lines.append("## Warnings captured during the runs")
        lines.append("")
        for warning in warnings:
            lines.append(f"- {warning}")
        lines.append("")

    lines.append("## Caveats")
    lines.append("")
    lines.append(
        "A few dozen rows over two lectures is directional evidence, not a "
        "significance test. Add lectures with `--project` before treating a "
        "difference between proposals and controls as a verdict."
    )
    lines.append("")

    text = "\n".join(lines)
    (out / "report.md").write_text(text, encoding="utf-8")
    print(text)
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["run", "sheet", "report"])
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output directory.")
    parser.add_argument(
        "--project",
        action="append",
        help="A .tafseer file (repeatable; default: every finished project in the app data dir).",
    )
    parser.add_argument("--base-url", help="Writing model base URL (default: the app's saved settings).")
    parser.add_argument("--api-key", help="Writing model API key.")
    parser.add_argument("--model", help="Writing model id.")
    parser.add_argument("--timeout", type=float, help="Writing model timeout in seconds.")
    parser.add_argument("--controls", type=int, default=6, help="Control windows per lecture.")
    parser.add_argument("--seed", type=int, default=7, help="Shuffle seed for the review sheet.")
    args = parser.parse_args(argv)

    if args.command == "run":
        return asyncio.run(_run(args))
    if args.command == "sheet":
        return _build_sheet(args)
    return _report(args)


if __name__ == "__main__":
    raise SystemExit(main())
