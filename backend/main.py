"""FastAPI sidecar for Tafseer Clipper (localhost:8008).

Exposes exactly the six endpoints allowed by the architecture contract:

1. ``GET  /health``
2. ``POST /extract-and-transcribe``
3. ``POST /discover-clips``
4. ``POST /verify-arabic``
5. ``POST /fonts/import``
6. ``POST /render-batch``  (Server-Sent Events)

All heavy lifting (FFmpeg, Whisper, LLM calls) happens here, never in the
frontend.  Configuration defaults come from the environment; per-request
overrides mirror the Settings drawer.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import multiprocessing
import os
import re
import shutil
import sys
import threading
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Literal, TypeVar

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile as StarletteUploadFile

import config
from services import accel
from services.cancel import JobCancelled

# Register the optional GPU acceleration pack (TAFSEER_CUDA_DIR) before any
# module can import ctranslate2/faster-whisper, which load the CUDA DLLs.
accel.activate_runtime_dirs()

from services import analyzer, renderer, subtitle_gen, transcriber  # noqa: E402

# --------------------------------------------------------------------------- #
# Logging: console + rotating file under the user data directory
# --------------------------------------------------------------------------- #
LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
#: 5 MB x 5 files keeps the last ~25 MB of sidecar history for field support.
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 5


def _log_level() -> int:
    """Log level from ``TAFSEER_LOG_LEVEL`` (default INFO)."""
    raw = config.env_str("TAFSEER_LOG_LEVEL", "INFO").strip().upper()
    level = logging.getLevelName(raw)
    return level if isinstance(level, int) else logging.INFO


def _setup_logging() -> Path | None:
    """Configure console + rotating file logging; never blocks startup.

    A packaged sidecar has no visible console, so ``logs/sidecar.log`` is the
    only way to diagnose a field failure.  If the log directory or file cannot
    be opened (read-only profile, restrictive permissions) the sidecar still
    starts with console logging only and records why on that console.
    """
    root = logging.getLogger()
    root.setLevel(_log_level())
    formatter = logging.Formatter(LOG_FORMAT)

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    root.addHandler(console)

    log_file = config.log_dir() / config.LOG_FILE_NAME
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            log_file,
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
    except OSError as exc:
        root.warning("File logging disabled (%s): %s", log_file, exc)
        return None
    handler.setFormatter(formatter)
    root.addHandler(handler)
    return log_file


_LOG_FILE = _setup_logging()
logger = logging.getLogger("tafseer.main")
if _LOG_FILE is not None:
    logger.info(
        "Logging to %s (level=%s)",
        _LOG_FILE,
        logging.getLevelName(logging.getLogger().level),
    )


# --------------------------------------------------------------------------- #
# Shared schema helpers
# --------------------------------------------------------------------------- #
class TimeRange(BaseModel):
    start: float = Field(ge=0.0, description="Start of the interval in seconds.")
    end: float = Field(gt=0.0, description="End of the interval in seconds.")

    @model_validator(mode="after")
    def _ordered(self) -> TimeRange:
        if self.end <= self.start:
            raise ValueError("'end' must be greater than 'start'.")
        return self


class ProviderOverride(BaseModel):
    """Optional per-request override of the Settings drawer values."""

    base_url: str | None = Field(
        default=None, description="OpenAI-compatible base URL, e.g. http://localhost:11434/v1"
    )
    api_key: str | None = Field(default=None, description="Bearer token; omit for Ollama.")
    model: str | None = Field(default=None, description="Model id for this call.")
    timeout: float | None = Field(default=None, gt=0, description="Seconds.")

    def to_service(self) -> analyzer.ProviderOverride:
        return analyzer.ProviderOverride(
            base_url=self.base_url,
            api_key=self.api_key,
            model=self.model,
            timeout=self.timeout,
        )


# --------------------------------------------------------------------------- #
# 1. GET /health
# --------------------------------------------------------------------------- #
class WhisperStatus(BaseModel):
    model: str
    loaded: bool
    device: str
    compute_type: str


class AccelerationStatus(BaseModel):
    """Additive ``/health.acceleration`` block (GPU vs CPU, and why).

    Defaults keep older callers/tests working even if the block is absent from a
    cached payload; ``reason`` is ``None`` when GPU transcription is ready and
    otherwise one of ``no-nvidia-gpu``, ``cuda-runtime-missing`` or
    ``cuda-runtime-unusable``.
    """

    transcription: Literal["gpu", "cpu"] = "cpu"
    encoding: Literal["gpu", "cpu"] = "cpu"
    gpu_detected: bool = False
    gpu_name: str | None = None
    cuda_runtime: bool = False
    pack_installed: bool = False
    reason: str | None = None


class OllamaProviderStatus(BaseModel):
    detected: bool = False
    url: str | None = None
    models: list[str] = Field(default_factory=list)


class ProvidersStatus(BaseModel):
    """Detected AI services the app can use without extra setup."""

    ollama: OllamaProviderStatus = Field(default_factory=OllamaProviderStatus)


class HardwareTier(BaseModel):
    """Plain capability tier; product names stay in diagnostics (AGENTS.md §3)."""

    tier: Literal["high", "medium", "low"] = "low"


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    version: str
    cuda_available: bool
    nvenc_available: bool
    vram_mb: int
    ffmpeg_available: bool
    ffmpeg_path: str | None = None
    ffprobe_available: bool
    fonts_dir: str
    work_dir: str
    #: Recursive size of ``work_dir`` (temporary WAVs, job .ass files, transcripts).
    disk_cache_bytes: int = 0
    whisper: WhisperStatus
    #: Additive: GPU acceleration state + machine-readable reason for CPU.
    acceleration: AccelerationStatus = Field(default_factory=AccelerationStatus)
    #: Additive: detected local AI services (Ollama) for one-click setup.
    providers: ProvidersStatus = Field(default_factory=ProvidersStatus)
    #: Additive: coarse capability tier used for honest model recommendations.
    hardware: HardwareTier = Field(default_factory=HardwareTier)


# --------------------------------------------------------------------------- #
# 2. POST /extract-and-transcribe
# --------------------------------------------------------------------------- #
class CloudSttConfig(BaseModel):
    base_url: str = Field(description="OpenAI-compatible base URL for /audio/transcriptions.")
    api_key: str | None = None
    model: str = Field(default="whisper-1")
    language: str | None = None


class TranscribeRequest(BaseModel):
    file_path: str = Field(description="Absolute path to the lecture video/audio.")
    use_local_whisper: bool = Field(
        default=True, description="False routes the WAV to the Cloud STT API."
    )
    initial_prompt: str = Field(
        default="",
        description="Editable Whisper vocabulary hint (Surahs, Arabic/Islamic terms).",
    )
    language: str | None = Field(default=None, description="ISO code; None = auto-detect.")
    glossary: dict[str, str] = Field(
        default_factory=dict,
        description="Thai-Arabic spelling Find & Replace table applied post-transcription.",
    )
    model: str | None = Field(default=None, description="faster-whisper size override.")
    device: Literal["auto", "cuda", "cpu"] = Field(default="auto")
    compute_type: str | None = Field(
        default=None, description="CTranslate2 compute type; 'int8' is the plan default."
    )
    auto_unload: bool | None = Field(
        default=None, description="Unload the local transcription model after Step 1."
    )
    vad_filter: bool = Field(default=True, description="Skip silence with Silero VAD.")
    cloud: CloudSttConfig | None = Field(
        default=None, description="Required when use_local_whisper is false."
    )

    @field_validator("file_path")
    @classmethod
    def _non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("'file_path' must not be empty.")
        return value


class TranscriptSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    language: str | None = None


class TranscribeResponse(BaseModel):
    transcript_id: str
    status: Literal["completed"] = "completed"
    duration: float
    language: str | None = None
    language_probability: float | None = None
    segments: list[TranscriptSegment]
    audio_path: str
    model: str
    device: str
    compute_type: str
    vram_unloaded: bool
    #: Downsampled peak envelope (0..1, ~1200 points) for the Step-2 waveform.
    waveform_peaks: list[float] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# 3. POST /discover-clips
# --------------------------------------------------------------------------- #
class DiscoverRequest(BaseModel):
    transcript_id: str = Field(description="Id returned by /extract-and-transcribe.")
    base_prompt: str = Field(default="", description="Editable Base System Prompt.")
    session_guide: str = Field(default="", description="Optional session topic guide.")
    refinement_note: str = Field(
        default="", description="Re-roll instruction, e.g. 'shorter 60s reminders'."
    )
    excluded_ranges: list[TimeRange] = Field(
        default_factory=list,
        description="Approved clips locked out of the next re-roll.",
    )
    max_clips: int = Field(default=8, ge=1, le=50)
    min_duration: float = Field(default=15.0, gt=1.0, le=600.0)
    max_duration: float = Field(default=90.0, gt=1.0, le=1800.0)
    language: str = Field(default="th", description="Language for titles/rationales.")
    provider: ProviderOverride | None = None

    @model_validator(mode="after")
    def _duration_bounds(self) -> DiscoverRequest:
        if self.max_duration <= self.min_duration:
            raise ValueError("'max_duration' must be greater than 'min_duration'.")
        return self


class ClipProposal(BaseModel):
    """One LLM proposal; rejects NaN/Infinity so the JSON reply stays valid."""

    start: float = Field(ge=0.0, allow_inf_nan=False)
    end: float = Field(gt=0.0, allow_inf_nan=False)
    title: str
    rationale: str

    @model_validator(mode="after")
    def _ordered(self) -> ClipProposal:
        if self.end <= self.start:
            raise ValueError("'end' must be greater than 'start'.")
        return self


class DiscoverResponse(BaseModel):
    clips: list[ClipProposal]
    model: str
    excluded_ranges_applied: int


# --------------------------------------------------------------------------- #
# 4. POST /verify-arabic
# --------------------------------------------------------------------------- #
class VerifyArabicRequest(BaseModel):
    arabic_text: str = Field(description="One Arabic subtitle line to proofread.")
    context_thai: str = Field(default="", description="Surrounding Thai explanation.")
    provider: ProviderOverride | None = None

    @field_validator("arabic_text")
    @classmethod
    def _non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("'arabic_text' must not be empty.")
        return value


class VerifyArabicResponse(BaseModel):
    verified_text: str
    correction_applied: bool
    notes: str = ""
    model: str


# --------------------------------------------------------------------------- #
# 5. POST /fonts/import
# --------------------------------------------------------------------------- #
class FontImportRequest(BaseModel):
    font_paths: list[str] = Field(
        default_factory=list, description="Absolute .ttf/.otf paths already on disk."
    )

    @field_validator("font_paths")
    @classmethod
    def _non_empty(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("Provide at least one font path or upload files.")
        return value


class FontInfo(BaseModel):
    family: str
    style: str
    path: str
    format: str


class FontImportResponse(BaseModel):
    imported_fonts: list[str] = Field(description="Font family names now available.")
    fonts: list[FontInfo]
    fonts_dir: str


# --------------------------------------------------------------------------- #
# 6. POST /render-batch
# --------------------------------------------------------------------------- #
class SubtitleCue(BaseModel):
    start: float = Field(ge=0.0, description="Cue start (clip-relative by default).")
    end: float = Field(gt=0.0, description="Cue end (clip-relative by default).")
    arabic: str = Field(default="", description="Arabic/Quranic line (RTL).")
    thai: str = Field(default="", description="Thai translation line.")

    @model_validator(mode="after")
    def _ordered(self) -> SubtitleCue:
        if self.end <= self.start:
            raise ValueError("Cue 'end' must be greater than 'start'.")
        return self


#: ``subtitle_gen.ass_color`` understands ``#RRGGBB`` and ``&HAABBGGRR``; a
#: corrupted settings backup used to reach it unchecked and raise a bare 500.
_ASS_COLOR_RE = re.compile(r"^(?:#[0-9a-fA-F]{6}|&H[0-9a-fA-F]{8})$")


class StyleSpec(BaseModel):
    """Per-style overrides for the generated .ass (Settings -> Fonts tab)."""

    font: str | None = None
    size: int | None = Field(default=None, ge=8, le=200)
    color: str | None = Field(default=None, description="#RRGGBB or &HAABBGGRR")
    outline: float | None = Field(default=None, ge=0, le=20)
    shadow: float | None = Field(default=None, ge=0, le=20)
    outline_color: str | None = Field(
        default=None, description="Per-style OutlineColour (#RRGGBB or &HAABBGGRR)."
    )
    box_opacity: float | None = Field(
        default=None,
        ge=0,
        le=1,
        description="Background box opacity 0..1; 0 keeps BorderStyle 1 (outline only).",
    )
    line_height_pad: float | None = Field(
        default=None,
        ge=1,
        description=(
            "Harakat line-height padding (>=1, clamped to 3). ASS has no "
            "line-height field, so the extra leading shifts MarginV upwards."
        ),
    )
    margin_v: int | None = Field(default=None, ge=0, le=1000)
    margin_l: int | None = Field(default=None, ge=0, le=1000)
    margin_r: int | None = Field(default=None, ge=0, le=1000)
    bold: bool | None = None

    @field_validator("color", "outline_color")
    @classmethod
    def _valid_color(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not _ASS_COLOR_RE.match(cleaned):
            raise ValueError(
                f"Unsupported colour '{value}'. Use '#RRGGBB' or '&HAABBGGRR'."
            )
        return cleaned


class SubtitleStyles(BaseModel):
    arabic: StyleSpec = Field(default_factory=StyleSpec)
    thai: StyleSpec = Field(default_factory=StyleSpec)


class RenderClip(BaseModel):
    start: float = Field(ge=0.0, description="Clip start in the source video (seconds).")
    end: float = Field(gt=0.0, description="Clip end in the source video (seconds).")
    subtitles: list[SubtitleCue] = Field(default_factory=list)
    title: str = Field(default="clip", description="Used by the filename template.")
    output_path: str | None = Field(
        default=None, description="Absolute path or filename inside output_dir."
    )

    @model_validator(mode="after")
    def _ordered(self) -> RenderClip:
        if self.end <= self.start:
            raise ValueError("Clip 'end' must be greater than 'start'.")
        if self.end - self.start < 0.5:
            raise ValueError("Clips shorter than 0.5s are not rendered.")
        return self


class RenderBatchRequest(BaseModel):
    project_name: str = Field(default="tafseer")
    source_path: str | None = Field(
        default=None,
        description="Absolute path to the source video; falls back to the transcript record.",
    )
    transcript_id: str | None = Field(
        default=None, description="Alternative to source_path for a stored transcript."
    )
    clips: list[RenderClip] = Field(min_length=1, max_length=200)
    resolution: Literal["1080x1920", "1920x1080"] = Field(default="1080x1920")
    framing: Literal["blur-fill", "center-crop"] = Field(default="blur-fill")
    use_nvenc: bool = Field(default=True, description="NVENC first, libx264 fallback.")
    export_srt: bool = Field(default=False, description="Also write .srt next to the MP4.")
    output_dir: str | None = Field(default=None)
    filename_template: str = Field(default="{LectureName}_Clip{01}_{Title}.mp4")
    subtitle_timebase: Literal["clip", "source"] = Field(
        default="clip",
        description="'clip' = cue times relative to clip start, 'source' = absolute.",
    )
    styles: SubtitleStyles = Field(default_factory=SubtitleStyles)


# --------------------------------------------------------------------------- #
# Transcript store (bounded memory cache + durable JSON on disk)
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class TranscriptRecord:
    transcript_id: str
    source_path: str
    duration: float
    language: str | None
    segments: list[transcriber.Segment]
    created_at: float
    waveform_peaks: list[float] = field(default_factory=list)


_TRANSCRIPTS: dict[str, TranscriptRecord] = {}
_TRANSCRIPT_LIMIT = 8

#: Transcripts are small (a 3 h lecture is a few hundred KB) and they are what
#: lets a resumed `.tafseer` project re-run Step 2 after a sidecar restart, so
#: they are persisted under ``work_dir()/transcripts`` and never pruned.
_TRANSCRIPT_SCHEMA = 1
_TRANSCRIPT_ID_RE = re.compile(r"^[0-9a-fA-F]{32}$")


def _transcript_file(transcript_id: str) -> Path | None:
    """Path of the durable transcript JSON, or None for an invalid id."""
    if not _TRANSCRIPT_ID_RE.fullmatch(transcript_id):
        return None
    try:
        directory = config.work_dir() / "transcripts"
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:  # pragma: no cover - read-only work dir
        logger.warning("Transcript cache directory unavailable: %s", exc)
        return None
    return directory / f"{transcript_id}.json"


def _remember_transcript(record: TranscriptRecord) -> None:
    """Insert into the bounded memory cache, evicting the oldest entry."""
    _TRANSCRIPTS[record.transcript_id] = record
    while len(_TRANSCRIPTS) > _TRANSCRIPT_LIMIT:
        oldest = min(_TRANSCRIPTS.values(), key=lambda item: item.created_at)
        _TRANSCRIPTS.pop(oldest.transcript_id, None)


def _persist_transcript(record: TranscriptRecord) -> None:
    """Write the transcript JSON atomically; failures never fail the request."""
    target = _transcript_file(record.transcript_id)
    if target is None:
        return
    payload = {
        "schema": _TRANSCRIPT_SCHEMA,
        "transcript_id": record.transcript_id,
        "source_path": record.source_path,
        "duration": record.duration,
        "language": record.language,
        "created_at": record.created_at,
        "waveform_peaks": record.waveform_peaks,
        "segments": [
            {
                "id": segment.id,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "language": segment.language,
            }
            for segment in record.segments
        ],
    }
    temporary = target.with_name(target.name + ".tmp")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        temporary.replace(target)
    except OSError as exc:
        logger.warning(
            "Could not persist transcript %s: %s", record.transcript_id, exc
        )
        try:
            temporary.unlink(missing_ok=True)
        except OSError:  # pragma: no cover - best effort
            pass


def _coerce_peaks(value: Any, *, limit: int = transcriber.WAVEFORM_PEAK_COUNT) -> list[float]:
    """Validate a waveform envelope read from disk: finite floats in ``0..1``."""
    if not isinstance(value, (list, tuple)):
        return []
    peaks: list[float] = []
    for item in value[:limit]:
        try:
            sample = float(item)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(sample):
            continue
        peaks.append(min(1.0, max(0.0, round(sample, 4))))
    return peaks


def _load_transcript(transcript_id: str) -> TranscriptRecord | None:
    """Read a persisted transcript; corrupt/missing files fall back to 404."""
    target = _transcript_file(transcript_id)
    if target is None or not target.is_file():
        return None
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("transcript cache is not a JSON object")
        segments = [
            transcriber.Segment(
                id=int(item["id"]),
                start=float(item["start"]),
                end=float(item["end"]),
                text=str(item["text"]),
                language=item.get("language"),
            )
            for item in payload.get("segments") or []
        ]
        return TranscriptRecord(
            transcript_id=transcript_id,
            source_path=str(payload.get("source_path") or ""),
            duration=float(payload.get("duration") or 0.0),
            language=payload.get("language"),
            segments=segments,
            created_at=float(payload.get("created_at") or target.stat().st_mtime),
            waveform_peaks=_coerce_peaks(payload.get("waveform_peaks")),
        )
    except (OSError, ValueError, TypeError, KeyError) as exc:
        logger.warning("Ignoring unreadable transcript cache %s: %s", target, exc)
        return None


def _store_transcript(record: TranscriptRecord) -> None:
    _remember_transcript(record)
    _persist_transcript(record)


def _get_transcript(transcript_id: str) -> TranscriptRecord:
    record = _TRANSCRIPTS.get(transcript_id)
    if record is None:
        # The memory cache is bounded (and empty after a sidecar restart), so a
        # resumed project falls back to the durable copy before 404ing.
        record = _load_transcript(transcript_id)
        if record is not None:
            _remember_transcript(record)
            logger.info("Loaded transcript %s from the disk cache", transcript_id)
    if record is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Unknown transcript_id '{transcript_id}'. Re-run "
                "/extract-and-transcribe first."
            ),
        )
    return record


# --------------------------------------------------------------------------- #
# Disk cache reporting & startup pruning
# --------------------------------------------------------------------------- #
#: Startup prune: generated job folders (only ``.ass`` files - rendered MP4s
#: live in the user's output folder) and extracted WAVs are regenerable, while
#: ``work_dir()/transcripts`` backs Step-2 resume and is never pruned.
_JOB_TTL_SECONDS = 24 * 60 * 60
_AUDIO_TTL_SECONDS = 7 * 24 * 60 * 60

#: ``disk_cache_bytes`` walks the whole work dir; the UI polls /health every
#: 15 s, so cache the total for ~5 s (same idea as the NVENC probe).
_disk_cache: tuple[float, int] | None = None
_DISK_CACHE_TTL = 5.0


def _directory_size(root: Path) -> int:
    """Recursive byte size of ``root``; unreadable entries are ignored."""
    total = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _disk_cache_bytes() -> int:
    global _disk_cache
    now = time.monotonic()
    if _disk_cache is not None and now - _disk_cache[0] < _DISK_CACHE_TTL:
        return _disk_cache[1]
    try:
        total = _directory_size(config.work_dir())
    except OSError:  # pragma: no cover - /health must never fail on cache I/O
        total = 0
    _disk_cache = (now, total)
    return total


def _prune_work_dir() -> None:
    """Delete stale job folders (>24 h) and extracted WAVs (>7 d).

    Runs on startup, must never block or fail it: every filesystem error is
    logged and skipped.  ``work_dir()/transcripts`` is deliberately untouched.
    """
    global _disk_cache
    now = time.time()
    removed_jobs = 0
    removed_wavs = 0

    try:
        jobs_dir = config.work_dir() / "jobs"
        if jobs_dir.is_dir():
            for child in jobs_dir.iterdir():
                try:
                    if (
                        child.is_dir()
                        and now - child.stat().st_mtime > _JOB_TTL_SECONDS
                    ):
                        shutil.rmtree(child, ignore_errors=True)
                        removed_jobs += 1
                except OSError:
                    continue
    except OSError as exc:  # pragma: no cover - read-only work dir
        logger.warning("Could not prune the job cache: %s", exc)

    try:
        audio_dir = config.work_dir() / "audio"
        if audio_dir.is_dir():
            for child in audio_dir.iterdir():
                try:
                    if (
                        child.is_file()
                        and now - child.stat().st_mtime > _AUDIO_TTL_SECONDS
                    ):
                        child.unlink(missing_ok=True)
                        removed_wavs += 1
                except OSError:
                    continue
    except OSError as exc:  # pragma: no cover - read-only work dir
        logger.warning("Could not prune the audio cache: %s", exc)

    _disk_cache = None
    if removed_jobs or removed_wavs:
        logger.info(
            "Pruned cache: %d stale job folder(s) and %d extracted WAV(s)",
            removed_jobs,
            removed_wavs,
        )


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
def _shutdown_cleanup() -> tuple[int, bool]:
    """Kill in-flight FFmpeg encodes and release GPU memory when Tauri stops us."""
    terminated = renderer.terminate_active_processes()
    unloaded = transcriber.get_transcriber().unload()
    logger.info(
        "Shutdown cleanup: %d FFmpeg process(es) terminated, whisper unloaded=%s",
        terminated,
        unloaded,
    )
    return terminated, unloaded


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    logger.info(
        "Sidecar paths: fonts_dir=%s work_dir=%s log_file=%s frozen=%s",
        config.fonts_dir(),
        config.work_dir(),
        _LOG_FILE or "console-only",
        config.is_frozen(),
    )
    try:
        await run_in_threadpool(_prune_work_dir)
    except Exception:  # noqa: BLE001 - cache pruning must never block startup
        logger.exception("Cache prune failed; continuing startup")
    try:
        yield
    finally:
        await run_in_threadpool(_shutdown_cleanup)


#: The WebView origin differs between dev (Vite on :1420), the Playwright E2E
#: preview server (:4173) and production (``tauri.localhost``); everything else
#: is rejected - the sidecar is loopback only and serves exactly the six
#: contract routes.
ALLOWED_ORIGINS = [
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://tauri.localhost",
    "https://tauri.localhost",
]

app = FastAPI(
    title=config.APP_NAME,
    version=config.APP_VERSION,
    description="Local sidecar for Tafseer Clipper. Binds to 127.0.0.1 only.",
    lifespan=_lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(transcriber.TranscriptionError)
async def _transcription_error(_: Request, exc: transcriber.TranscriptionError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(analyzer.LLMError)
async def _llm_error(_: Request, exc: analyzer.LLMError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(renderer.RenderError)
async def _render_error(_: Request, exc: renderer.RenderError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


# --------------------------------------------------------------------------- #
# 1. GET /health
# --------------------------------------------------------------------------- #
_hardware_cache: tuple[float, dict] | None = None
_HARDWARE_TTL = 5.0


def _hardware_snapshot() -> dict:
    global _hardware_cache
    now = time.monotonic()
    if _hardware_cache and now - _hardware_cache[0] < _HARDWARE_TTL:
        return _hardware_cache[1]
    snapshot = transcriber.describe_environment()
    snapshot["nvenc_available"] = renderer.nvenc_available()
    _hardware_cache = (now, snapshot)
    return snapshot


# --------------------------------------------------------------------------- #
#    Detected providers + capability tier (additive /health fields)
# --------------------------------------------------------------------------- #
OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434"
OLLAMA_PROBE_TIMEOUT_SECONDS = 0.5
OLLAMA_PROBE_TTL_SECONDS = 30.0
_ollama_cache: tuple[float, OllamaProviderStatus] | None = None
_ollama_lock = threading.Lock()


def _probe_ollama() -> OllamaProviderStatus:
    """Detect a local Ollama instance and list its installed models."""
    global _ollama_cache
    now = time.monotonic()
    with _ollama_lock:
        if _ollama_cache is not None and now - _ollama_cache[0] < OLLAMA_PROBE_TTL_SECONDS:
            return _ollama_cache[1]

    status = OllamaProviderStatus(detected=False, url=OLLAMA_DEFAULT_URL, models=[])
    try:
        response = httpx.get(
            f"{OLLAMA_DEFAULT_URL}/api/tags", timeout=OLLAMA_PROBE_TIMEOUT_SECONDS
        )
        if response.status_code == 200:
            payload = response.json()
            entries = payload.get("models") if isinstance(payload, dict) else None
            names: list[str] = []
            if isinstance(entries, list):
                for entry in entries:
                    name = entry.get("name") if isinstance(entry, dict) else None
                    if isinstance(name, str) and name:
                        names.append(name)
            status = OllamaProviderStatus(
                detected=True,
                url=OLLAMA_DEFAULT_URL,
                models=sorted(set(names)),
            )
    except Exception:  # noqa: BLE001 - detection must never fail /health
        pass

    with _ollama_lock:
        _ollama_cache = (now, status)
    return status


_total_ram_gb_cache: int | None = None


def _total_ram_gb() -> int:
    """Total physical RAM in GiB; falls back to 0 when it cannot be read."""
    global _total_ram_gb_cache
    if _total_ram_gb_cache is not None:
        return _total_ram_gb_cache
    value = 0
    try:
        if os.name == "nt":
            import ctypes

            class _MemoryStatusEx(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = _MemoryStatusEx()
            status.dwLength = ctypes.sizeof(_MemoryStatusEx)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                value = int(status.ullTotalPhys // (1024**3))
        else:
            with open("/proc/meminfo", "r", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("MemTotal:"):
                        value = int(int(line.split()[1]) // (1024**2))
                        break
    except Exception:  # noqa: BLE001
        value = 0
    _total_ram_gb_cache = value
    return value


def _hardware_tier(vram_mb: int) -> HardwareTier:
    """Coarse capability tier for honest local-model recommendations."""
    ram_gb = _total_ram_gb()
    if vram_mb >= 12_000 or ram_gb >= 32:
        return HardwareTier(tier="high")
    if vram_mb >= 6_000 or ram_gb >= 16:
        return HardwareTier(tier="medium")
    return HardwareTier(tier="low")


@app.get("/health", response_model=HealthResponse, summary="Sidecar readiness & hardware")
async def health() -> HealthResponse:
    snapshot = await run_in_threadpool(_hardware_snapshot)
    disk_cache_bytes = await run_in_threadpool(_disk_cache_bytes)
    acceleration = await run_in_threadpool(accel.acceleration_report)
    ollama = await run_in_threadpool(_probe_ollama)
    ffmpeg = config.ffmpeg_path()
    return HealthResponse(
        version=config.APP_VERSION,
        cuda_available=bool(snapshot["cuda_available"]),
        nvenc_available=bool(snapshot["nvenc_available"]),
        vram_mb=int(snapshot["vram_mb"]),
        ffmpeg_available=bool(ffmpeg),
        ffmpeg_path=ffmpeg,
        ffprobe_available=bool(config.ffprobe_path()),
        fonts_dir=str(config.fonts_dir()),
        work_dir=str(config.work_dir()),
        disk_cache_bytes=disk_cache_bytes,
        whisper=WhisperStatus(
            model=str(snapshot["whisper_model"]),
            loaded=bool(snapshot["whisper_loaded"]),
            device=str(snapshot["whisper_device"]),
            compute_type=str(snapshot["whisper_compute_type"]),
        ),
        acceleration=AccelerationStatus.model_validate(acceleration),
        providers=ProvidersStatus(ollama=ollama),
        hardware=_hardware_tier(int(snapshot["vram_mb"])),
    )


# --------------------------------------------------------------------------- #
# 2. POST /extract-and-transcribe
# --------------------------------------------------------------------------- #
_T = TypeVar("_T")

#: How often the disconnect watcher polls an in-flight long job.
DISCONNECT_POLL_SECONDS = 1.0


async def _run_until_disconnected(
    request: Request,
    factory: Callable[[threading.Event], Awaitable[_T]],
) -> _T:
    """Run ``factory(cancel_event)`` and abort it when the client disconnects.

    The fixed REST surface has no cancel route (AGENTS.md §3), so cancellation
    rides on the HTTP disconnect: a watcher races the work and, on
    disconnection, sets the shared ``threading.Event`` (the services check it
    at their natural boundaries) and cancels the asyncio task (aborting
    in-flight provider HTTP calls).
    """
    cancel_event = threading.Event()

    async def work() -> _T:
        return await factory(cancel_event)

    async def watch() -> None:
        while True:
            if await request.is_disconnected():
                cancel_event.set()
                work_task.cancel()
                return
            if work_task.done():
                return
            await asyncio.sleep(DISCONNECT_POLL_SECONDS)

    work_task = asyncio.create_task(work())
    watcher = asyncio.create_task(watch())
    try:
        return await work_task
    except JobCancelled:
        logger.info("Client disconnected; %s cancelled at a service boundary.", request.url.path)
        raise HTTPException(status_code=499, detail="Client disconnected; job cancelled.")
    except asyncio.CancelledError:
        if cancel_event.is_set():
            # Our own watcher cancelled the work because the client left; no
            # response can be delivered either way.
            logger.info("Client disconnected; %s cancelled.", request.url.path)
            raise HTTPException(status_code=499, detail="Client disconnected; job cancelled.")
        raise  # server shutdown: propagate the real cancellation
    finally:
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watcher
        if not work_task.done():
            work_task.cancel()
            with contextlib.suppress(BaseException):
                await work_task


def _engine_for(body: TranscribeRequest) -> transcriber.WhisperTranscriber:
    """Return the warm singleton, replacing it only when the config differs."""
    return transcriber.get_transcriber(body.model, body.device, body.compute_type)


@app.post(
    "/extract-and-transcribe",
    response_model=TranscribeResponse,
    summary="Extract 16kHz WAV, transcribe (local int8 CUDA / cloud), apply glossary",
)
async def extract_and_transcribe(body: TranscribeRequest, request: Request) -> TranscribeResponse:
    source = Path(body.file_path)
    if not source.is_file():
        raise HTTPException(status_code=400, detail=f"File not found: {source}")

    wav_path = config.work_dir() / "audio" / f"{uuid.uuid4().hex}.wav"
    auto_unload = (
        config.whisper_auto_unload_default()
        if body.auto_unload is None
        else body.auto_unload
    )

    async def run(cancel_event: threading.Event) -> tuple[transcriber.TranscriptionResult, list[float]]:
        await run_in_threadpool(transcriber.extract_audio, source, wav_path)
        # Optional UI sugar: a downsampled envelope for the Step-2 wavesurfer bar.
        waveform_peaks = await run_in_threadpool(
            transcriber.compute_waveform_peaks, wav_path
        )

        if body.use_local_whisper:
            engine = _engine_for(body)
            result = await run_in_threadpool(
                engine.transcribe,
                wav_path,
                initial_prompt=body.initial_prompt,
                language=body.language,
                vad_filter=body.vad_filter,
                glossary=body.glossary,
                auto_unload=auto_unload,
                cancel_event=cancel_event,
            )
        else:
            if body.cloud is None:
                raise HTTPException(
                    status_code=400,
                    detail="'cloud' configuration is required when use_local_whisper is false.",
                )
            result = await transcriber.transcribe_cloud(
                wav_path,
                base_url=body.cloud.base_url,
                api_key=body.cloud.api_key,
                model=body.cloud.model,
                language=body.cloud.language or body.language,
                prompt=body.initial_prompt or None,
                glossary=body.glossary,
                cancel_event=cancel_event,
            )
        return result, waveform_peaks

    try:
        result, waveform_peaks = await _run_until_disconnected(request, run)
    except HTTPException as exc:
        if exc.status_code == 499:
            # Client left mid-transcription: no transcript record was stored,
            # so only the extracted WAV needs reclaiming.
            with contextlib.suppress(OSError):
                wav_path.unlink(missing_ok=True)
        raise

    transcript_id = uuid.uuid4().hex
    _store_transcript(
        TranscriptRecord(
            transcript_id=transcript_id,
            source_path=str(source),
            duration=result.duration,
            language=result.language,
            segments=result.segments,
            created_at=time.time(),
            waveform_peaks=waveform_peaks,
        )
    )

    return TranscribeResponse(
        transcript_id=transcript_id,
        duration=round(result.duration, 3),
        language=result.language,
        language_probability=result.language_probability,
        segments=[
            TranscriptSegment(
                id=segment.id,
                start=round(segment.start, 3),
                end=round(segment.end, 3),
                text=segment.text,
                language=segment.language,
            )
            for segment in result.segments
        ],
        audio_path=str(wav_path),
        model=result.model,
        device=result.device,
        compute_type=result.compute_type,
        vram_unloaded=result.vram_unloaded,
        waveform_peaks=waveform_peaks,
    )


# --------------------------------------------------------------------------- #
# 3. POST /discover-clips
# --------------------------------------------------------------------------- #
@app.post(
    "/discover-clips",
    response_model=DiscoverResponse,
    summary="Keep & Re-roll: propose clips, honouring approved exclusions",
)
async def discover_clips(body: DiscoverRequest, request: Request) -> DiscoverResponse:
    record = _get_transcript(body.transcript_id)
    provider = analyzer.merge_provider(
        "reasoning", body.provider.to_service() if body.provider else None
    )
    excluded = [item.model_dump() for item in body.excluded_ranges]
    segments = [
        {"start": segment.start, "end": segment.end, "text": segment.text}
        for segment in record.segments
    ]
    duration = record.duration or (
        max((segment.end for segment in record.segments), default=0.0)
    )

    async def run(cancel_event: threading.Event) -> list[dict[str, Any]]:
        return await analyzer.discover_clips(
            segments=segments,
            duration=duration,
            base_prompt=body.base_prompt,
            session_guide=body.session_guide,
            refinement_note=body.refinement_note,
            excluded_ranges=excluded,
            provider=provider,
            min_duration=body.min_duration,
            max_duration=body.max_duration,
            max_clips=body.max_clips,
            language=body.language,
            cancel_event=cancel_event,
        )

    clips = await _run_until_disconnected(request, run)

    return DiscoverResponse(
        clips=[ClipProposal(**clip) for clip in clips],
        model=provider.model,
        excluded_ranges_applied=len(excluded),
    )


# --------------------------------------------------------------------------- #
# 4. POST /verify-arabic
# --------------------------------------------------------------------------- #
@app.post(
    "/verify-arabic",
    response_model=VerifyArabicResponse,
    summary="Uthmani spelling / Harakat verification with the fast text model",
)
async def verify_arabic(body: VerifyArabicRequest) -> VerifyArabicResponse:
    provider = analyzer.merge_provider(
        "fast", body.provider.to_service() if body.provider else None
    )
    result = await analyzer.verify_arabic(
        arabic_text=body.arabic_text,
        context_thai=body.context_thai,
        provider=provider,
    )
    return VerifyArabicResponse(
        verified_text=result["verified_text"],
        correction_applied=result["correction_applied"],
        notes=result["notes"],
        model=provider.model,
    )


# --------------------------------------------------------------------------- #
# 5. POST /fonts/import
# --------------------------------------------------------------------------- #
FONT_SUFFIXES = {".ttf", ".otf"}
_FONT_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf")


#: Windows forbidden characters / reserved device names.  This mirrors
#: ``src/lib/filenameTemplate.ts`` so the Step-4 preview shows the exact name the
#: sidecar writes (control chars -> "_", forbidden -> "_", collapse whitespace,
#: strip trailing dots/spaces, prefix reserved device stems, cap at 150 chars).
_FORBIDDEN_CHARS_RE = re.compile(r'[<>:"/\\|?*]')
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f]")
_TRAILING_DOTS_OR_SPACES_RE = re.compile(r"[. ]+$")
_RESERVED_DEVICE_NAME_RE = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.IGNORECASE
)


def _sanitize_filename(name: str, fallback: str = "file") -> str:
    """Windows-safe file name, identical to the frontend's sanitizer."""
    cleaned = _CONTROL_CHARS_RE.sub("_", name)
    cleaned = _FORBIDDEN_CHARS_RE.sub("_", cleaned).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = _TRAILING_DOTS_OR_SPACES_RE.sub("", cleaned)
    if _RESERVED_DEVICE_NAME_RE.match(cleaned.split(".")[0]):
        cleaned = f"_{cleaned}"
    return cleaned[:150] or fallback


def _font_family(path: Path) -> tuple[str, str]:
    """Read the font family/style names from the OpenType ``name`` table."""
    try:
        from fontTools.ttLib import TTFont  # type: ignore

        with TTFont(str(path), lazy=True, fontNumber=0) as font:
            name_table = font["name"]

            def lookup(name_id: int) -> str | None:
                for record in name_table.names:
                    if record.nameID != name_id:
                        continue
                    try:
                        text = record.toUnicode()
                    except Exception:
                        continue
                    if text.strip():
                        return text.strip()
                return None

            family = lookup(1) or lookup(16) or path.stem
            style = lookup(2) or lookup(17) or "Regular"
            return family, style
    except Exception as exc:  # pragma: no cover - corrupt font files
        logger.warning("Could not read font metadata from %s: %s", path, exc)
        return path.stem, "Regular"


def _import_font(source: Path, target_dir: Path) -> FontInfo:
    if source.suffix.lower() not in FONT_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported font type '{source.suffix}'. Use .ttf or .otf.",
        )
    if not source.is_file():
        raise HTTPException(status_code=400, detail=f"Font not found: {source}")

    with source.open("rb") as handle:
        magic = handle.read(4)
    if magic not in _FONT_MAGIC:
        raise HTTPException(
            status_code=400, detail=f"'{source.name}' is not a valid TTF/OTF font."
        )

    target_dir.mkdir(parents=True, exist_ok=True)
    destination = target_dir / _sanitize_filename(source.name)
    if source.resolve() != destination.resolve():
        destination.write_bytes(source.read_bytes())

    family, style = _font_family(destination)
    return FontInfo(
        family=family,
        style=style,
        path=str(destination),
        format=destination.suffix.lower().lstrip("."),
    )


@app.post(
    "/fonts/import",
    response_model=FontImportResponse,
    summary="Copy .ttf/.otf fonts into backend/fonts and report family names",
)
async def import_fonts(request: Request) -> FontImportResponse:
    content_type = request.headers.get("content-type", "")
    sources: list[Path] = []
    uploads: list[StarletteUploadFile] = []

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        uploads = [
            item for item in form.getlist("files") if isinstance(item, StarletteUploadFile)
        ]
        if not uploads:
            raise HTTPException(
                status_code=400, detail="No font files uploaded under field 'files'."
            )
    else:
        try:
            payload = await request.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid JSON body.") from exc
        try:
            body = FontImportRequest.model_validate(payload)
        except ValidationError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid request body: {exc.errors()[0]['msg']}",
            ) from exc
        sources = [Path(item) for item in body.font_paths]

    fonts_dir = config.fonts_dir()
    staging = config.work_dir() / "font_uploads" / uuid.uuid4().hex
    imported: list[FontInfo] = []
    families: list[str] = []

    try:
        for upload in uploads:
            suffix = Path(upload.filename or "").suffix.lower()
            if suffix not in FONT_SUFFIXES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported font type '{suffix}'. Use .ttf or .otf.",
                )
            staging.mkdir(parents=True, exist_ok=True)
            temp = staging / _sanitize_filename(upload.filename or f"font{suffix}")
            temp.write_bytes(await upload.read())
            sources.append(temp)

        for source in sources:
            info = _import_font(source, fonts_dir)
            imported.append(info)
            if info.family not in families:
                families.append(info.family)
    finally:
        if staging.exists():
            for child in staging.glob("*"):
                child.unlink(missing_ok=True)
            staging.rmdir()

    return FontImportResponse(
        imported_fonts=families,
        fonts=imported,
        fonts_dir=str(fonts_dir),
    )


# --------------------------------------------------------------------------- #
# 6. POST /render-batch  (SSE)
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class _PreparedClip:
    index: int
    clip: RenderClip
    duration: float
    ass_path: Path
    srt_path: Path | None
    output_path: Path


def _resolve_source(body: RenderBatchRequest) -> Path:
    if body.source_path:
        source = Path(body.source_path)
    elif body.transcript_id:
        source = Path(_get_transcript(body.transcript_id).source_path)
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide 'source_path' or 'transcript_id'.",
        )
    if not source.is_file():
        raise HTTPException(status_code=400, detail=f"Source video not found: {source}")
    return source


def _mkdir_checked(directory: Path) -> Path:
    """Create a directory, reporting an unwritable path as a 400 (not a 500)."""
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot create directory '{directory}': {exc}",
        ) from exc
    return directory


def _output_directory(body: RenderBatchRequest, source: Path) -> Path:
    if body.output_dir:
        directory = Path(body.output_dir)
    else:
        directory = source.parent / "exports"
    return _mkdir_checked(directory)


def _apply_template(template: str, *, index: int, title: str, source: Path, resolution: str) -> str:
    rendered = template
    rendered = rendered.replace("{LectureName}", source.stem)
    rendered = rendered.replace("{Title}", _sanitize_filename(title, "clip"))
    rendered = rendered.replace("{Clip}", f"{index + 1:02d}")
    rendered = rendered.replace("{Resolution}", resolution)
    # Generic zero-padded tokens: {01}, {001}, ...
    rendered = re.sub(
        r"\{(\d{2,3})\}",
        lambda match: f"{index + 1:0{len(match.group(1))}d}",
        rendered,
    )
    return _sanitize_filename(rendered, f"clip_{index + 1:02d}")


def _resolve_output_path(
    clip: RenderClip,
    *,
    index: int,
    body: RenderBatchRequest,
    source: Path,
    output_dir: Path,
) -> Path:
    if clip.output_path:
        candidate = Path(clip.output_path)
        if candidate.is_absolute():
            _mkdir_checked(candidate.parent)
            return candidate.with_name(_sanitize_filename(candidate.name))
        name = _sanitize_filename(candidate.name)
    else:
        name = _apply_template(
            body.filename_template,
            index=index,
            title=clip.title,
            source=source,
            resolution=body.resolution,
        )
    if not name.lower().endswith(".mp4"):
        name += ".mp4"
    return output_dir / name


#: ``line_height_pad`` is a CSS-style multiplier, but ASS has no line-height
#: field.  Extra leading is mapped to an equivalent upward shift of the bottom
#: anchor (``MarginV``) so the burned line sits where the preview draws it.
_MAX_LINE_HEIGHT_PAD = 3.0


def _style_from_spec(base: subtitle_gen.StyleConfig, spec: StyleSpec) -> subtitle_gen.StyleConfig:
    """Merge the Settings StyleSpec over a default style.

    ``box_opacity > 0`` switches the style to ``BorderStyle 3`` (opaque box)
    with ``BackColour`` alpha derived from the opacity; ``line_height_pad``
    shifts ``MarginV`` by the extra leading; ``outline_color`` is per style.
    """
    size = spec.size or base.size
    margin_v = base.margin_v if spec.margin_v is None else spec.margin_v
    pad = 1.0 if spec.line_height_pad is None else spec.line_height_pad
    pad = min(_MAX_LINE_HEIGHT_PAD, max(1.0, pad))
    if pad > 1.0:
        margin_v = max(0, margin_v + round((pad - 1.0) * size / 2))

    border_style = base.border_style
    back_color = base.back_color
    back_alpha = base.back_alpha
    if spec.box_opacity is not None and spec.box_opacity > 0:
        border_style = 3
        back_color = "#000000"
        # ASS alpha is inverted: 00 = opaque, FF = fully transparent.
        back_alpha = f"{round((1.0 - min(1.0, spec.box_opacity)) * 255):02X}"

    return subtitle_gen.StyleConfig(
        name=base.name,
        font=spec.font or base.font,
        size=size,
        primary_color=spec.color or base.primary_color,
        outline_color=spec.outline_color or base.outline_color,
        back_color=back_color,
        bold=base.bold if spec.bold is None else spec.bold,
        outline=base.outline if spec.outline is None else spec.outline,
        shadow=base.shadow if spec.shadow is None else spec.shadow,
        margin_v=margin_v,
        margin_l=base.margin_l if spec.margin_l is None else spec.margin_l,
        margin_r=base.margin_r if spec.margin_r is None else spec.margin_r,
        spacing=base.spacing,
        encoding=base.encoding,
        border_style=border_style,
        back_alpha=back_alpha,
    )


def _unique_output_path(
    output_path: Path, *, index: int, used_names: set[str]
) -> Path:
    """Duplicate-name guard mirroring ``src/lib/filenameTemplate.ts``.

    Suffixes keep incrementing (``_01``, ``_02`` ...) until the name is genuinely
    unused, so a clip titled ``Intro_03`` can never collide with a generated
    ``Intro_03.mp4``.
    """
    if output_path.name not in used_names:
        used_names.add(output_path.name)
        return output_path

    stem = output_path.stem
    suffix = output_path.suffix
    attempt = index + 1
    candidate = f"{stem}_{attempt:02d}{suffix}"
    while candidate in used_names:
        attempt += 1
        candidate = f"{stem}_{attempt:02d}{suffix}"
    used_names.add(candidate)
    return output_path.with_name(candidate)


def _cues_for_clip(clip: RenderClip, *, timebase: str) -> list[subtitle_gen.Cue]:
    cues: list[subtitle_gen.Cue] = []
    for item in clip.subtitles:
        offset = clip.start if timebase == "source" else 0.0
        start = max(0.0, item.start - offset)
        end = max(0.0, item.end - offset)
        cues.append(
            subtitle_gen.Cue(
                start=start,
                end=end,
                arabic=item.arabic,
                thai=item.thai,
            )
        )
    return cues


def _prepare_clips(
    body: RenderBatchRequest, source: Path, job_id: str
) -> list[_PreparedClip]:
    output_dir = _output_directory(body, source)
    work = config.work_dir() / "jobs" / job_id
    _mkdir_checked(work)

    default_arabic, default_thai = subtitle_gen.default_styles(body.resolution)
    arabic_style = _style_from_spec(default_arabic, body.styles.arabic)
    thai_style = _style_from_spec(default_thai, body.styles.thai)

    prepared: list[_PreparedClip] = []
    used_names: set[str] = set()

    for index, clip in enumerate(body.clips):
        duration = round(clip.end - clip.start, 3)
        cues = _cues_for_clip(clip, timebase=body.subtitle_timebase)
        stem = f"clip_{index + 1:02d}"

        output_path = _unique_output_path(
            _resolve_output_path(
                clip,
                index=index,
                body=body,
                source=source,
                output_dir=output_dir,
            ),
            index=index,
            used_names=used_names,
        )

        ass_path = work / f"{stem}.ass"
        subtitle_gen.write_ass(
            ass_path,
            cues=cues,
            resolution=body.resolution,
            arabic_style=arabic_style,
            thai_style=thai_style,
            title=f"{body.project_name} - {clip.title or stem}",
            clip_duration=duration,
        )

        # The .srt sidecar ships next to the MP4, as toggled in Step 4.
        srt_path: Path | None = None
        if body.export_srt:
            srt_path = output_path.with_suffix(".srt")
            subtitle_gen.write_srt(srt_path, cues, clip_duration=duration)

        prepared.append(
            _PreparedClip(
                index=index,
                clip=clip,
                duration=duration,
                ass_path=ass_path,
                srt_path=srt_path,
                output_path=output_path,
            )
        )

    return prepared


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _stream_batch(
    job_id: str,
    prepared: list[_PreparedClip],
    body: RenderBatchRequest,
    source: Path,
) -> Iterator[str]:
    total = len(prepared)
    started = time.monotonic()
    failures = 0
    last_overall = 0.0

    yield _sse(
        "start",
        {
            "job_id": job_id,
            "status": "processing",
            "progress": 0.0,
            "clip_count": total,
            "resolution": body.resolution,
            "framing": body.framing,
            "source_path": str(source),
            "clips": [
                {
                    "index": item.index,
                    "start": item.clip.start,
                    "end": item.clip.end,
                    "duration": item.duration,
                    "output_path": str(item.output_path),
                    "ass_path": str(item.ass_path),
                    "srt_path": str(item.srt_path) if item.srt_path else None,
                }
                for item in prepared
            ],
        },
    )

    for position, item in enumerate(prepared):
        render_job = renderer.RenderJob(
            source=source,
            output=item.output_path,
            start=item.clip.start,
            duration=item.duration,
            resolution=body.resolution,
            framing=body.framing,
            ass_path=item.ass_path,
            fonts_dir=config.fonts_dir(),
            use_nvenc=body.use_nvenc,
        )

        encoder = "unknown"
        try:
            for update in renderer.render(render_job):
                encoder = update.get("encoder", encoder)
                clip_progress = float(update.get("clip_progress", 0.0))
                if not math.isfinite(clip_progress):
                    clip_progress = 0.0
                clip_progress = min(1.0, max(0.0, clip_progress))
                overall = min(1.0, max(last_overall, (position + clip_progress) / total))
                last_overall = overall
                stage = str(update.get("stage", "encoding"))
                # Surface encoder fallbacks as their own event so the UI can
                # toast "NVENC unavailable - using CPU" instead of silently
                # mixing two encoders into the progress stream.
                event_name = "fallback" if stage == "fallback" else "progress"
                yield _sse(
                    event_name,
                    {
                        "job_id": job_id,
                        "status": "processing",
                        "progress": round(overall, 4),
                        "clip_index": item.index,
                        "clip_count": total,
                        "clip_progress": round(clip_progress, 4),
                        "encoder": encoder,
                        "failed_encoder": update.get("failed_encoder"),
                        "reason": update.get("reason"),
                        "stage": stage,
                        "output_path": str(item.output_path),
                        "elapsed": round(time.monotonic() - started, 2),
                    },
                )
        except Exception as exc:
            failures += 1
            logger.exception("Clip %s failed", item.index)
            yield _sse(
                "clip_error",
                {
                    "job_id": job_id,
                    "status": "error",
                    "progress": round(position / total, 4),
                    "clip_index": item.index,
                    "clip_count": total,
                    "detail": str(exc),
                    "output_path": str(item.output_path),
                },
            )
            continue

        yield _sse(
            "clip_done",
            {
                "job_id": job_id,
                "status": "processing",
                "progress": round((position + 1) / total, 4),
                "clip_index": item.index,
                "clip_count": total,
                "encoder": encoder,
                "output_path": str(item.output_path),
                "srt_path": str(item.srt_path) if item.srt_path else None,
                "duration": item.duration,
                "elapsed": round(time.monotonic() - started, 2),
            },
        )

    final_status = "completed" if failures == 0 else ("error" if failures == total else "completed")
    yield _sse(
        "done",
        {
            "job_id": job_id,
            "status": final_status,
            "progress": 1.0,
            "clip_count": total,
            "failed_clips": failures,
            "rendered_clips": total - failures,
            "elapsed": round(time.monotonic() - started, 2),
            "output_dir": str(prepared[0].output_path.parent) if prepared else "",
        },
    )


@app.post(
    "/render-batch",
    summary="Render clips with burned dual-style subtitles; streams SSE progress",
    response_class=StreamingResponse,
)
async def render_batch(body: RenderBatchRequest) -> StreamingResponse:
    if not config.ffmpeg_path():
        raise HTTPException(
            status_code=503,
            detail="ffmpeg.exe is not available to the sidecar.",
        )
    source = _resolve_source(body)
    job_id = uuid.uuid4().hex
    prepared = _prepare_clips(body, source, job_id)

    return StreamingResponse(
        _stream_batch(job_id, prepared, body, source),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def _start_parent_watchdog() -> None:
    """Exit the sidecar when the Tauri shell that spawned it dies.

    The shell kills the sidecar on a graceful window close, but a crash or
    "End task" in Task Manager bypasses that path. The shell passes its own PID
    as ``TAFSEER_PARENT_PID``; a daemon thread waits on the parent process
    handle and shuts the sidecar down (terminating active FFmpeg children)
    when the parent exits. No-op outside Windows or when the variable is unset
    (source runs, tests, cloud-only setups).
    """
    raw = os.environ.get("TAFSEER_PARENT_PID")
    if not raw or sys.platform != "win32":
        return
    try:
        parent_pid = int(raw)
    except ValueError:
        return

    def watch() -> None:
        import ctypes

        SYNCHRONIZE = 0x00100000
        INFINITE = 0xFFFFFFFF
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
        if not handle:
            return
        try:
            kernel32.WaitForSingleObject(handle, INFINITE)
        finally:
            kernel32.CloseHandle(handle)
        logger.warning(
            "Tauri shell (pid %s) exited; shutting the sidecar down.", parent_pid
        )
        try:
            renderer.terminate_active_processes()
        except Exception:  # pragma: no cover - best effort on abrupt shutdown
            logger.exception("Could not terminate FFmpeg children on parent exit.")
        try:
            transcriber.get_transcriber().unload()
        except Exception:  # pragma: no cover - best effort on abrupt shutdown
            pass
        os._exit(0)

    threading.Thread(target=watch, name="parent-watchdog", daemon=True).start()


def main() -> None:
    import uvicorn

    logger.info(
        "%s %s starting on http://%s:%s (ffmpeg=%s, fonts=%s, work=%s)",
        config.APP_NAME,
        config.APP_VERSION,
        config.host(),
        config.port(),
        config.ffmpeg_path() or "NOT FOUND",
        config.fonts_dir(),
        config.work_dir(),
    )
    _start_parent_watchdog()
    # ``log_config=None`` keeps uvicorn's loggers propagating to the root
    # handlers installed by ``_setup_logging``: uvicorn's default dictConfig
    # gives them propagate=False handlers, so server/access lines would never
    # reach sidecar.log.
    uvicorn.run(
        app,
        host=config.host(),
        port=config.port(),
        log_level="info",
        log_config=None,
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
