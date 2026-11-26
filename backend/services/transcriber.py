"""Transcription service: faster-whisper (GPU ``int8`` with CPU fallback) + Glossary.

Responsibilities
----------------
* Extract a 16 kHz mono WAV from the lecture with FFmpeg (Step 1 of the plan).
* Run ``faster-whisper`` with ``compute_type="int8"`` and the editable
  ``initial_prompt`` that biases Thai -> Arabic code-switching.  GPU
  acceleration is used only when the optional CUDA runtime is actually usable;
  otherwise transcription runs on the CPU.
* Apply the editor's Thai-Arabic spelling glossary to every segment.
* Unload the model when the editor enabled the auto-unload toggle.

Optional Cloud STT is supported through any OpenAI-compatible
``/audio/transcriptions`` endpoint (Section 2 of the master plan).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import gc
import logging
import math
import re
import subprocess
import sys
import threading
import time
import wave
from array import array
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from starlette.concurrency import run_in_threadpool

import config
from services import accel
from services.cancel import JobCancelled, raise_if_cancelled

logger = logging.getLogger("tafseer.transcriber")

#: Silent, non-editable bias list for STT code-switching into Arabic script.
#: Hard-coded so editors never have to curate ASR hints (idea 1).  Covers the
#: standard Arabic recitation intros plus high-frequency verse openers that
#: typically follow a Thai intro ("อัลลอฮฺทรงตรัสว่า...").
RECITATION_INTRO_PROMPT = (
    "أعوذ بالله من الشيطان الرجيم. بسم الله الرحمن الرحيم. "
    "قال الله تعالى. قال الله عز وجل. صدق الله العظيم. "
    "يا أيها الذين آمنوا. يا أيها الناس. الحمد لله رب العالمين. "
    "قل هو الله أحد. إن الله مع الصابرين. وما خلقت الجن والإنس. "
    "إنا أنزلناه. ومن يتق الله."
)

#: Hide the console window a bundled FFmpeg would otherwise flash on Windows.
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

#: Waveform envelope returned to the Step-2 wavesurfer scrubber. The envelope
#: targets ~4 points per second so a short clip still has a readable shape on a
#: long lecture, with a floor for tiny files and a cap that keeps the response
#: and the persisted transcript bounded.
WAVEFORM_PEAKS_PER_SECOND = 4
WAVEFORM_PEAK_MIN = 6000
WAVEFORM_PEAK_MAX = 48000
#: Backwards-compatible upper bound for envelopes read from disk. Older
#: transcripts carry 1200 points; new ones never exceed the cap above.
WAVEFORM_PEAK_COUNT = WAVEFORM_PEAK_MAX


class TranscriptionError(RuntimeError):
    """Raised for user-fixable transcription failures (reported as HTTP 503)."""


# --------------------------------------------------------------------------- #
# Language handling
# --------------------------------------------------------------------------- #
_AUTO_LANGUAGE_SENTINELS = {"auto", "automatic", "auto-detect", "autodetect"}


def normalize_language(language: str | None) -> str | None:
    """Map the UI's "auto-detect" sentinel onto faster-whisper's ``None``.

    The Settings drawer offers ``"auto"``, which used to be forwarded verbatim
    to ``WhisperModel.transcribe()``; faster-whisper only accepts ISO codes or
    ``None`` for auto-detection.  Empty strings are treated the same way.
    """
    if language is None:
        return None
    value = language.strip()
    if not value or value.lower() in _AUTO_LANGUAGE_SENTINELS:
        return None
    return value


# --------------------------------------------------------------------------- #
# Data transfer objects
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Segment:
    id: int
    start: float
    end: float
    text: str
    language: str | None = None
    #: Step-1 enrichment: sentence group (Thai segments), Arabic passage
    #: provenance, and the original Thai transliteration for restore.
    sentence_id: int | None = None
    source: str | None = None
    reference: str | None = None
    confidence: float | None = None
    original_text: str | None = None
    translation: str | None = None


@dataclass(slots=True)
class TranscriptionResult:
    segments: list[Segment]
    duration: float
    language: str | None
    language_probability: float | None
    device: str
    compute_type: str
    model: str
    vram_unloaded: bool


@dataclass(frozen=True, slots=True)
class WhisperConfig:
    """The requested ``(model, device, compute_type)`` of one engine.

    Used to decide whether the warm singleton can serve a request as-is or has
    to be unloaded and replaced.
    """

    model: str
    device: str
    compute_type: str


# --------------------------------------------------------------------------- #
# Hardware probing
# --------------------------------------------------------------------------- #
def cuda_device_count() -> int:
    """Number of CUDA devices visible to CTranslate2 (0 when unavailable)."""
    try:
        import ctranslate2  # type: ignore

        return int(ctranslate2.get_cuda_device_count())
    except Exception:  # pragma: no cover - depends on local install
        pass
    try:
        import torch  # type: ignore

        return int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
    except Exception:
        return 0


def cuda_available() -> bool:
    return cuda_device_count() > 0


def nvidia_smi_available() -> bool:
    """True when the vendor diagnostic tool sees a GPU (diagnostics only)."""
    return accel.nvidia_gpu_info() is not None


def nvidia_vram_mb() -> int:
    """Total memory of the first detected GPU in MB (0 when unknown)."""
    info = accel.nvidia_gpu_info()
    return int(info["vram_mb"]) if info else 0


def resolve_device(requested: str) -> str:
    """Map the request's device preference onto a usable CTranslate2 device.

    ``auto`` picks CUDA only when the optional CUDA runtime is actually
    loadable, so a machine without the GPU acceleration pack never pays for a
    doomed CUDA load.  An explicit ``cuda`` request without a usable runtime is
    a user-fixable error.
    """
    if requested == "cpu":
        return "cpu"
    runtime_ready = accel.cuda_runtime_ready()
    if requested == "cuda":
        if not runtime_ready:
            raise TranscriptionError(
                "CUDA runtime is not installed. Enable GPU acceleration in "
                "Settings (one-time download) or switch to Cloud STT."
            )
        return "cuda"
    return "cuda" if runtime_ready else "cpu"


def resolve_compute_type(device: str, requested: str | None) -> str:
    """Normalise the compute type for the device actually being used."""
    compute_type = (requested or "").strip() or "int8"
    if device != "cuda" and compute_type in {"float16", "bfloat16"}:
        # The CPU backend does not support half precision; int8/float32 are fine.
        # Downgrade silently so a GPU-oriented setting still runs on the CPU.
        return "int8"
    return compute_type


# --------------------------------------------------------------------------- #
# Audio extraction
# --------------------------------------------------------------------------- #
def extract_audio(
    video_path: str | Path,
    out_wav: str | Path,
    *,
    cancel_event: threading.Event | None = None,
) -> Path:
    """Extract a 16 kHz mono PCM WAV with FFmpeg, supporting cooperative cancellation."""
    raise_if_cancelled(cancel_event)
    ffmpeg = config.ffmpeg_path()
    if not ffmpeg:
        raise TranscriptionError(
            "ffmpeg.exe was not found. Place it in src-tauri/binaries/ or set "
            "TAFSEER_FFMPEG."
        )

    source = Path(video_path)
    if not source.is_file():
        raise TranscriptionError(f"Source video not found: {source}")

    target = Path(out_wav)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise TranscriptionError(
            f"Cannot create the audio working directory '{target.parent}': {exc}"
        ) from exc

    args = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(target),
    ]
    timeout = config.extract_audio_timeout()
    deadline = time.monotonic() + timeout
    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
        )
    except OSError as exc:
        raise TranscriptionError(f"Could not start FFmpeg: {exc}") from exc

    stderr_text = ""
    try:
        while True:
            ret = proc.poll()
            if ret is not None:
                break
            if cancel_event is not None and cancel_event.is_set():
                proc.kill()
                with contextlib.suppress(Exception):
                    proc.wait(timeout=3)
                with contextlib.suppress(OSError):
                    target.unlink(missing_ok=True)
                raise JobCancelled("The client disconnected; audio extraction cancelled.")
            if time.monotonic() > deadline:
                proc.kill()
                with contextlib.suppress(Exception):
                    proc.wait(timeout=3)
                raise TranscriptionError(
                    f"FFmpeg did not finish extracting audio within {timeout:.0f}s; "
                    "the lecture may be corrupt or the file is on a stalled drive."
                )
            time.sleep(0.05)
        if proc.stderr is not None:
            stderr_text = proc.stderr.read()
    finally:
        if proc.poll() is None:
            proc.kill()
            with contextlib.suppress(Exception):
                proc.wait(timeout=2)

    if proc.returncode != 0 or not target.is_file():
        detail = (stderr_text or "").strip().splitlines()
        raise TranscriptionError(
            "FFmpeg failed to extract audio: "
            + (" | ".join(detail[-3:]) if detail else "unknown error")
        )
    return target


# --------------------------------------------------------------------------- #
# Waveform envelope (Step-2 wavesurfer scrubber)
# --------------------------------------------------------------------------- #
def waveform_peak_target(duration_seconds: float) -> int:
    """Envelope point count for a lecture of ``duration_seconds``.

    ~4 points/second keeps a 30 s clip on a 3 h lecture above a hundred points,
    while the 6k floor gives short files a smooth bar and the 48k cap keeps the
    JSON payload (and the persisted transcript) under a few hundred kilobytes.
    """
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        return WAVEFORM_PEAK_MIN
    return max(
        WAVEFORM_PEAK_MIN,
        min(WAVEFORM_PEAK_MAX, round(duration_seconds * WAVEFORM_PEAKS_PER_SECOND)),
    )


def compute_waveform_peaks(
    wav_path: str | Path, *, points: int | None = None
) -> list[float]:
    """Downsampled peak envelope (``0..1``) of a PCM WAV, stdlib only.

    The extracted audio is always 16 kHz mono ``pcm_s16le``; numpy is only a
    test dependency, so this streams the file bucket by bucket with the stdlib
    ``wave``/``array`` modules (C-level ``max``/``min`` per bucket).  When
    ``points`` is omitted the count adapts to the lecture length via
    :func:`waveform_peak_target`. Any unreadable/unsupported WAV yields an empty
    list - the waveform is optional UI sugar, never a reason to fail a
    transcription.
    """
    target = Path(wav_path)
    try:
        with wave.open(str(target), "rb") as handle:
            total_frames = handle.getnframes()
            sample_width = handle.getsampwidth()
            if total_frames <= 0 or sample_width != 2:
                return []
            if points is None:
                frame_rate = handle.getframerate()
                duration = total_frames / frame_rate if frame_rate > 0 else 0.0
                points = waveform_peak_target(duration)
            buckets = max(1, min(int(points), total_frames))
            frames_per_bucket = max(1, math.ceil(total_frames / buckets))
            peaks: list[float] = []
            remaining = total_frames
            while remaining > 0:
                count = min(frames_per_bucket, remaining)
                data = handle.readframes(count)
                if not data:
                    break
                samples = array("h")
                samples.frombytes(data[: len(data) - (len(data) % 2)])
                if sys.byteorder == "big":
                    samples.byteswap()
                if samples:
                    peak = max(max(samples), -min(samples))
                else:
                    peak = 0
                peaks.append(min(1.0, round(peak / 32768.0, 4)))
                remaining -= count
    except (OSError, EOFError, wave.Error) as exc:
        logger.warning("Could not compute waveform peaks for %s: %s", target, exc)
        return []
    return peaks


# --------------------------------------------------------------------------- #
# Glossary
# --------------------------------------------------------------------------- #
def apply_glossary(text: str, glossary: dict[str, str] | None) -> str:
    """Apply the Thai-Arabic spelling Find & Replace table to a segment.

    Longer source strings are replaced first so ``อัลลอฮฺ`` wins over ``อัล``.
    """
    if not text or not glossary:
        return text
    for source in sorted(glossary, key=len, reverse=True):
        replacement = glossary[source]
        if source:
            text = text.replace(source, replacement)
    return " ".join(text.split())


def apply_glossary_to_segments(
    segments: Iterable[Segment], glossary: dict[str, str] | None
) -> list[Segment]:
    cleaned: list[Segment] = []
    for segment in segments:
        cleaned.append(
            Segment(
                id=segment.id,
                start=segment.start,
                end=segment.end,
                text=apply_glossary(segment.text, glossary),
                language=segment.language,
            )
        )
    return cleaned


# --------------------------------------------------------------------------- #
# Local faster-whisper engine
# --------------------------------------------------------------------------- #
def _empty_torch_cache() -> None:
    """Flush PyTorch's CUDA caching allocator when torch happens to be installed.

    faster-whisper runs on CTranslate2, which owns its own CUDA pool, so this is
    only a best-effort extra: torch is deliberately not a sidecar dependency.
    """
    try:
        import torch  # type: ignore
    except ImportError:  # pragma: no cover - torch is not installed
        return
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:  # pragma: no cover - driver dependent
        logger.debug("torch CUDA cache flush failed", exc_info=True)


class WhisperTranscriber:
    """Lazily loaded faster-whisper model with explicit memory unloading.

    ``WhisperModel`` owns a CTranslate2 engine whose CUDA pool is released when
    the Python object is destroyed, so :meth:`unload` drops the reference and
    forces ``gc.collect()``; PyTorch is *not* a sidecar dependency, but if it is
    installed we also flush its caching allocator (see :func:`_empty_torch_cache`).
    """

    def __init__(
        self,
        model_size: str | None = None,
        device: str | None = None,
        compute_type: str | None = None,
    ) -> None:
        self.model_size = model_size or config.whisper_model_default()
        self.device_request = device or config.whisper_device_default()
        self.compute_request = compute_type or config.whisper_compute_default()
        self._model = None
        self._device = "cpu"
        self._compute_type = "int8"
        self._lock = threading.RLock()

    # -- configuration ----------------------------------------------------- #
    def requested_config(self) -> WhisperConfig:
        """The (normalised) configuration this engine was created for."""
        return WhisperConfig(
            model=self.model_size,
            device=self.device_request,
            compute_type=self.compute_request,
        )

    def configured_with(
        self,
        model: str | None,
        device: str | None,
        compute_type: str | None,
    ) -> bool:
        """True when a request with these overrides can reuse this engine."""
        return WhisperConfig(
            model=model or config.whisper_model_default(),
            device=device or config.whisper_device_default(),
            compute_type=compute_type or config.whisper_compute_default(),
        ) == self.requested_config()

    # -- state ------------------------------------------------------------- #
    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        return self._device

    @property
    def compute_type(self) -> str:
        return self._compute_type

    # -- lifecycle --------------------------------------------------------- #
    def _ensure_model(self):
        with self._lock:
            if self._model is not None:
                return self._model

            # Register the optional GPU acceleration pack before the AI stack
            # imports its native libraries (the CUDA DLLs are loaded on import).
            accel.activate_runtime_dirs()
            try:
                from faster_whisper import WhisperModel  # type: ignore
            except ImportError as exc:  # pragma: no cover - env dependent
                raise TranscriptionError(
                    "faster-whisper is not installed in this sidecar build. "
                    "Install backend/requirements.txt or switch Settings to "
                    "Cloud STT."
                ) from exc
            except Exception as exc:  # pragma: no cover - env dependent
                # An incompatible native dependency (for example PyAV 17+ dropping
                # the `metadata_errors` argument that faster-whisper 1.2 passes)
                # raises TypeError/AttributeError at import, not ImportError.
                # Surface it as the documented 503 JSON contract instead of a bare
                # 500 from an unhandled exception.
                raise TranscriptionError(
                    "faster-whisper could not be loaded in this sidecar build "
                    f"({type(exc).__name__}: {exc}). Install a compatible "
                    "backend/requirements.txt or switch Settings to Cloud STT."
                ) from exc

            device = resolve_device(self.device_request)
            compute_type = resolve_compute_type(device, self.compute_request)

            try:
                self._model = WhisperModel(
                    self.model_size,
                    device=device,
                    compute_type=compute_type,
                )
            except Exception as exc:  # pragma: no cover - env dependent
                # Even a probed runtime can fail to initialise (driver reset,
                # memory pressure); transcription still works on the CPU, so fall
                # back instead of failing the whole step.
                if device == "cuda":
                    cpu_compute_type = resolve_compute_type("cpu", self.compute_request)
                    logger.warning(
                        "GPU transcription failed (%s); retrying on the CPU with "
                        "compute_type=%s. Enable GPU acceleration in Settings to "
                        "install the optional CUDA runtime.",
                        exc,
                        cpu_compute_type,
                    )
                    try:
                        self._model = WhisperModel(
                            self.model_size,
                            device="cpu",
                            compute_type=cpu_compute_type,
                        )
                        device = "cpu"
                        compute_type = cpu_compute_type
                    except Exception as cpu_exc:  # pragma: no cover - env dependent
                        raise TranscriptionError(
                            "Could not load faster-whisper "
                            f"'{self.model_size}' on GPU or CPU: {cpu_exc}. "
                            "Switch Settings to CPU (or Cloud STT) and try again."
                        ) from cpu_exc
                else:
                    raise TranscriptionError(
                        f"Could not load faster-whisper '{self.model_size}' on "
                        f"{device}/{compute_type}: {exc}"
                    ) from exc

            self._device = device
            self._compute_type = compute_type
            logger.info(
                "faster-whisper loaded: model=%s device=%s compute=%s",
                self.model_size,
                device,
                compute_type,
            )
            return self._model

    def unload(self) -> bool:
        """Drop the model and release its GPU memory; idempotent.

        CTranslate2 frees its CUDA pool when the engine object is destroyed, so
        the reference drop + ``gc.collect()`` is the real cleanup.  The torch
        flush below is an optional bonus (torch is not a sidecar dependency).
        """
        with self._lock:
            if self._model is None:
                return False
            self._model = None
            gc.collect()
            _empty_torch_cache()
            logger.info("faster-whisper unloaded from GPU memory")
            return True

    # -- inference --------------------------------------------------------- #
    def transcribe(
        self,
        audio_path: str | Path,
        *,
        initial_prompt: str = "",
        language: str | None = None,
        vad_filter: bool = True,
        glossary: dict[str, str] | None = None,
        auto_unload: bool = True,
        cancel_event: threading.Event | None = None,
        on_progress: Callable[[float, str], None] | None = None,
    ) -> TranscriptionResult:
        with self._lock:
            model = self._ensure_model()

            try:
                try:
                    segments_iter, info = self._run_transcribe(
                        model, audio_path, initial_prompt, language, vad_filter
                    )
                except Exception as exc:
                    if self._device != "cuda":
                        raise TranscriptionError(
                            f"Transcription failed on {self._device}/"
                            f"{self._compute_type}: {exc}"
                        ) from exc

                    cpu_compute_type = resolve_compute_type("cpu", self.compute_request)
                    logger.warning(
                        "GPU transcription failed at inference (%s); retrying on the "
                        "CPU with compute_type=%s. Enable GPU acceleration in Settings "
                        "to install the optional CUDA runtime.",
                        exc,
                        cpu_compute_type,
                    )
                    self.unload()
                    try:
                        from faster_whisper import WhisperModel  # type: ignore

                        model = WhisperModel(
                            self.model_size,
                            device="cpu",
                            compute_type=cpu_compute_type,
                        )
                    except Exception as cpu_exc:  # pragma: no cover - env dependent
                        raise TranscriptionError(
                            "Could not load faster-whisper "
                            f"'{self.model_size}' on the CPU after the GPU failed: "
                            f"{cpu_exc}. Switch Settings to Cloud STT and try again."
                        ) from cpu_exc

                    self._model = model
                    self._device = "cpu"
                    self._compute_type = cpu_compute_type
                    segments_iter, info = self._run_transcribe(
                        model, audio_path, initial_prompt, language, vad_filter
                    )

                raw: list[Segment] = []
                est_duration = float(getattr(info, "duration", 0.0) or 0.0)
                last_progress_at = 0.0
                last_progress_ratio = -1.0
                for index, item in enumerate(segments_iter):
                    raise_if_cancelled(cancel_event)
                    text = (item.text or "").strip()
                    if not text:
                        continue
                    end_sec = float(item.end)
                    raw.append(
                        Segment(
                            id=index,
                            start=float(item.start),
                            end=end_sec,
                            text=text,
                            language=getattr(info, "language", None),
                        )
                    )
                    if on_progress is not None:
                        now = time.monotonic()
                        if est_duration > 0:
                            ratio = min(0.99, max(0.0, end_sec / est_duration))
                            if now - last_progress_at >= 0.5 or ratio >= last_progress_ratio + 0.02:
                                last_progress_at = now
                                last_progress_ratio = ratio
                                _safe_progress(
                                    on_progress,
                                    ratio,
                                    f"Transcribing speech ({int(round(ratio * 100))}%)…",
                                )
                        elif now - last_progress_at >= 0.5:
                            last_progress_at = now
                            _safe_progress(
                                on_progress,
                                0.0,
                                f"Transcribing speech ({len(raw)} segments)…",
                            )

                segments = apply_glossary_to_segments(raw, glossary)
                duration = float(getattr(info, "duration", 0.0) or 0.0)
                if duration <= 0 and segments:
                    duration = max(segment.end for segment in segments)
                language_detected = getattr(info, "language", None)
                language_probability = getattr(info, "language_probability", None)
            finally:
                del model

            unloaded = self.unload() if auto_unload else False

            return TranscriptionResult(
                segments=segments,
                duration=duration,
                language=language_detected,
                language_probability=language_probability,
                device=self._device,
                compute_type=self._compute_type,
                model=self.model_size,
                vram_unloaded=unloaded,
            )

    @staticmethod
    def _run_transcribe(
        model,
        audio_path: str | Path,
        initial_prompt: str,
        language: str | None,
        vad_filter: bool,
    ):
        """Issue the faster-whisper call. Split out so it can be retried on CPU."""
        return model.transcribe(
            str(audio_path),
            language=normalize_language(language),
            task="transcribe",
            beam_size=5,
            vad_filter=vad_filter,
            vad_parameters={"min_silence_duration_ms": 500},
            initial_prompt=initial_prompt or None,
            word_timestamps=False,
        )


# --------------------------------------------------------------------------- #
# Cloud STT (optional)
# --------------------------------------------------------------------------- #
#: Upload budget per request. OpenAI and Groq reject files over 25 MB; 16 kHz
#: mono PCM is 32 KB/s, so a single 24 MB request is ~12.5 minutes of lecture.
#: Longer lectures are split on WAV frame boundaries and stitched back together
#: with their timestamps offset.
CLOUD_STT_MAX_UPLOAD_BYTES = 24 * 1024 * 1024
#: Hard per-chunk cap even for servers without an upload limit: keeps one
#: request comfortably inside the 300 s timeout on slow providers.
CLOUD_STT_MAX_CHUNK_SECONDS = 10 * 60

#: A provider that answers plain ``json`` (no ``segments``) still has to yield a
#: usable timeline. Text longer than this is split into sentence-ish
#: pseudo-segments with proportional timestamps instead of one chunk-long cue.
CLOUD_STT_PLAIN_SPLIT_MIN_CHARS = 500
#: Cap for one pseudo-segment when the text carries no sentence punctuation.
CLOUD_STT_PLAIN_CHUNK_CHARS = 400
_PLAIN_SENTENCE_BREAK = re.compile(r"(?<=[.!?…。！？])\s+|\s*\n+\s*")

#: The Vercel AI Gateway is OpenAI-compatible for chat but serves speech-to-text
#: on its own protocol endpoint: ``POST /v4/ai/transcription-model`` with the
#: audio base64-encoded in a JSON body. ``/v1/audio/transcriptions`` is a hard
#: 404 there, whatever the model is called.
VERCEL_GATEWAY_HOST = "ai-gateway.vercel.sh"
VERCEL_GATEWAY_PATH = "/v4/ai/transcription-model"
#: Base64 inflates the payload by ~33 %, so the raw-audio budget is lower than
#: for a multipart upload.
VERCEL_GATEWAY_MAX_UPLOAD_BYTES = 8 * 1024 * 1024
VERCEL_GATEWAY_HEADERS = {
    "ai-gateway-protocol-version": "0.0.1",
    "ai-transcription-model-specification-version": "4",
}


def _is_vercel_gateway(base_url: str) -> bool:
    raw = (base_url or "").strip()
    try:
        parts = urlsplit(raw if "://" in raw else f"https://{raw}")
    except ValueError:
        return False
    return (parts.hostname or "").lower() == VERCEL_GATEWAY_HOST


def _vercel_gateway_endpoint(base_url: str) -> str:
    """The gateway's transcription route, derived from the configured host.

    The saved address usually is the chat URL (``https://ai-gateway.vercel.sh/v1``);
    only the scheme and host are kept.
    """
    raw = (base_url or "").strip()
    try:
        parts = urlsplit(raw if "://" in raw else f"https://{raw}")
    except ValueError:
        parts = None
    if parts is None or not parts.netloc:
        return f"https://{VERCEL_GATEWAY_HOST}{VERCEL_GATEWAY_PATH}"
    return f"{parts.scheme or 'https'}://{parts.netloc}{VERCEL_GATEWAY_PATH}"


@dataclass(frozen=True, slots=True)
class _CloudChunk:
    offset: float
    #: Duration of this chunk in seconds (from the WAV header), used when the
    #: provider returns plain ``json`` without a duration/segment times.
    duration: float
    path: Path
    temporary: bool


def _wav_duration(path: Path) -> float:
    """Duration in seconds from the WAV header; 0.0 when it cannot be read."""
    try:
        with wave.open(str(path), "rb") as reader:
            rate = reader.getframerate()
            if rate <= 0:
                return 0.0
            return reader.getnframes() / float(rate)
    except (wave.Error, OSError, EOFError):
        return 0.0


def _split_wav_for_upload(
    path: Path, *, max_bytes: int | None = None
) -> tuple[list[_CloudChunk], list[Path]]:
    """Split a PCM WAV into API-sized pieces; also return the files to delete.

    A file that already fits the budget is returned untouched (the previous
    single-request behaviour). Anything else is written as numbered ``.partNNN``
    WAVs next to the original, preserving channels/width/rate exactly.

    ``max_bytes`` overrides the multipart budget (the gateway needs a smaller
    one because its JSON body is base64).
    """
    budget = CLOUD_STT_MAX_UPLOAD_BYTES if max_bytes is None else max_bytes
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise TranscriptionError(
            f"Could not read the extracted audio file {path}: {exc}"
        ) from exc
    if size <= budget:
        return [
            _CloudChunk(offset=0.0, duration=_wav_duration(path), path=path, temporary=False)
        ], []

    try:
        reader = wave.open(str(path), "rb")
    except (wave.Error, OSError, EOFError):
        # Not a WAV we can split: let the provider judge the single request.
        return [
            _CloudChunk(offset=0.0, duration=_wav_duration(path), path=path, temporary=False)
        ], []

    with reader:
        params = reader.getparams()
        channels = reader.getnchannels()
        width = reader.getsampwidth()
        rate = reader.getframerate()
        bytes_per_frame = channels * width
        if bytes_per_frame <= 0 or rate <= 0 or reader.getnframes() <= 0:
            return [
                _CloudChunk(offset=0.0, duration=0.0, path=path, temporary=False)
            ], []
        frames_per_chunk = min(
            max(1, budget // bytes_per_frame),
            rate * CLOUD_STT_MAX_CHUNK_SECONDS,
        )
        chunks: list[_CloudChunk] = []
        temporary: list[Path] = []
        index = 0
        while True:
            frames = reader.readframes(frames_per_chunk)
            if not frames:
                break
            part_path = path.with_name(f"{path.stem}.part{index:03d}.wav")
            try:
                with wave.open(str(part_path), "wb") as writer:
                    writer.setnchannels(params.nchannels)
                    writer.setsampwidth(params.sampwidth)
                    writer.setframerate(params.framerate)
                    writer.writeframes(frames)
            except (wave.Error, OSError) as exc:
                for created in temporary:
                    with contextlib.suppress(OSError):
                        created.unlink(missing_ok=True)
                raise TranscriptionError(
                    f"Could not prepare the audio for Cloud STT: {exc}"
                ) from exc
            frame_count = len(frames) // bytes_per_frame if bytes_per_frame else 0
            chunks.append(
                _CloudChunk(
                    offset=index * frames_per_chunk / float(rate),
                    duration=frame_count / float(rate),
                    path=part_path,
                    temporary=True,
                )
            )
            temporary.append(part_path)
            index += 1

    if len(chunks) <= 1:
        for created in temporary:
            with contextlib.suppress(OSError):
                created.unlink(missing_ok=True)
        return [
            _CloudChunk(offset=0.0, duration=_wav_duration(path), path=path, temporary=False)
        ], []
    return chunks, temporary


def _cloud_status_error(
    response: httpx.Response,
    endpoint: str,
    base_url: str,
    *,
    gateway: bool = False,
) -> TranscriptionError:
    """Turn a provider rejection into something the editor can act on."""
    status = response.status_code
    body = (response.text or "")[:400]
    if gateway:
        if status in (400, 404, 422):
            return TranscriptionError(
                "The AI Gateway rejected the speech-to-text request "
                f"(HTTP {status}). Check that the chosen model is a transcription "
                "model available to your account (for example openai/whisper-1) "
                "and that audio transcription is enabled. "
                f"Provider response: {body}"
            )
        if status in (401, 403):
            return TranscriptionError(
                f"The AI Gateway rejected the API key for speech-to-text "
                f"(HTTP {status}). Check the key saved in Settings. "
                f"Provider response: {body}"
            )
        return TranscriptionError(f"Cloud STT rejected the request ({status}): {body}")
    if status in (404, 405):
        return TranscriptionError(
            f"The speech service at {base_url.strip() or endpoint} has no "
            f"OpenAI-compatible audio transcription endpoint (HTTP {status}). "
            "This account works for chat but not for speech-to-text. In "
            "Upload → Speech-to-text, add a speech service that supports "
            "transcription (for example an OpenAI or Groq API key), or switch "
            f"the engine to “This computer”. Provider response: {body}"
        )
    if status in (401, 403):
        return TranscriptionError(
            f"The speech service rejected the API key (HTTP {status}). Check the "
            f"speech service credentials. Provider response: {body}"
        )
    return TranscriptionError(f"Cloud STT rejected the request ({status}): {body}")


def _audio_mime_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".mp3":
        return "audio/mpeg"
    if suffix in {".ogg", ".opus"}:
        return "audio/ogg"
    return "audio/wav"


_SILENCE_TIME_RE = re.compile(r"silence_(?:start|end):\s*([0-9]+(?:\.[0-9]+)?)")
CLOUD_STT_COMPRESS_MIN_BYTES = 2 * 1024 * 1024
CLOUD_STT_OVERLAP_SECONDS = 1.5


def _detect_silences(ffmpeg: str, path: Path) -> list[float]:
    """Return sorted silence midpoints (seconds) to guide cloud chunk splits."""
    try:
        completed = subprocess.run(
            [
                ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-i",
                str(path),
                "-af",
                "silencedetect=noise=-35dB:d=0.4",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=20,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    midpoints: list[float] = []
    pending_start: float | None = None
    for line in (completed.stderr or "").splitlines():
        if "silence_start:" in line:
            match = _SILENCE_TIME_RE.search(line)
            if match:
                pending_start = float(match.group(1))
        elif "silence_end:" in line and pending_start is not None:
            match = _SILENCE_TIME_RE.search(line)
            if match:
                end_t = float(match.group(1))
                midpoints.append((pending_start + end_t) * 0.5)
            pending_start = None
    return sorted(midpoints)


def _encode_mp3_slice(
    ffmpeg: str,
    wav_path: Path,
    out_mp3: Path,
    *,
    start: float | None = None,
    duration: float | None = None,
    cancel_event: threading.Event | None = None,
) -> bool:
    """Transcode ``wav_path`` (or a time slice) to 48 kbps mono MP3 for Cloud STT."""
    raise_if_cancelled(cancel_event)
    args = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    if start is not None and start > 0:
        args.extend(["-ss", f"{start:.3f}"])
    args.extend(["-i", str(wav_path)])
    if duration is not None and duration > 0:
        args.extend(["-t", f"{duration:.3f}"])
    args.extend(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", str(out_mp3)])
    try:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
        )
    except OSError:
        return False

    deadline = time.monotonic() + 120.0
    try:
        while proc.poll() is None:
            if cancel_event is not None and cancel_event.is_set():
                proc.kill()
                with contextlib.suppress(Exception):
                    proc.wait(timeout=2)
                raise JobCancelled("The client disconnected; cloud audio encoding cancelled.")
            if time.monotonic() > deadline:
                proc.kill()
                return False
            time.sleep(0.05)
        if proc.stderr is not None:
            proc.stderr.read()
        return proc.returncode == 0 and out_mp3.is_file() and out_mp3.stat().st_size > 0
    finally:
        if proc.poll() is None:
            proc.kill()


def _prepare_cloud_upload(
    path: Path,
    *,
    max_bytes: int | None = None,
    cancel_event: threading.Event | None = None,
) -> tuple[list[_CloudChunk], list[Path]]:
    """Compress real WAV audio to 48 kbps mono MP3 chunks aligned to silences when useful.

    Tiny inputs and synthetic test budgets (<256 KB) skip FFmpeg transcoding and
    stay on ``_split_wav_for_upload`` directly.
    """
    raise_if_cancelled(cancel_event)
    budget = CLOUD_STT_MAX_UPLOAD_BYTES if max_bytes is None else max_bytes
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise TranscriptionError(
            f"Could not read the extracted audio file {path}: {exc}"
        ) from exc

    ffmpeg = config.ffmpeg_path()
    should_compress = (
        bool(ffmpeg)
        and path.suffix.lower() == ".wav"
        and budget >= 256 * 1024
        and (size > CLOUD_STT_COMPRESS_MIN_BYTES or size > budget)
    )
    if should_compress and ffmpeg:
        duration = _wav_duration(path)
        if duration > 0:
            # 48 kbps MP3 = 6,000 bytes/sec; keep safe headroom under budget.
            max_chunk_sec = max(
                60.0, min(float(CLOUD_STT_MAX_CHUNK_SECONDS), (budget * 0.8) / 6_000.0)
            )
            silences = _detect_silences(ffmpeg, path) if duration > max_chunk_sec else []
            ranges: list[tuple[float, float]] = []
            cursor = 0.0
            while cursor < duration - 0.05:
                target = min(duration, cursor + max_chunk_sec)
                if target >= duration - 0.5:
                    ranges.append((cursor, duration))
                    break
                candidates = [s for s in silences if target - 25.0 <= s <= target + 5.0 and s > cursor + 20.0]
                if candidates:
                    split_at = min(candidates, key=lambda s: abs(s - target))
                    ranges.append((cursor, split_at))
                    cursor = split_at
                else:
                    # Hard cut when no pause was found: overlap 1.5 s to avoid severed words.
                    chunk_end = min(duration, target + CLOUD_STT_OVERLAP_SECONDS)
                    ranges.append((cursor, chunk_end))
                    cursor = target

            chunks: list[_CloudChunk] = []
            temporary: list[Path] = []
            ok = True
            for index, (start_t, end_t) in enumerate(ranges):
                out_mp3 = path.with_name(f"{path.stem}.cloud{index:03d}.mp3")
                temporary.append(out_mp3)
                if not _encode_mp3_slice(
                    ffmpeg,
                    path,
                    out_mp3,
                    start=start_t if len(ranges) > 1 or start_t > 0 else None,
                    duration=(end_t - start_t) if len(ranges) > 1 else None,
                    cancel_event=cancel_event,
                ):
                    ok = False
                    break
                if out_mp3.stat().st_size > budget:
                    ok = False
                    break
                chunks.append(
                    _CloudChunk(
                        offset=start_t,
                        duration=max(0.01, end_t - start_t),
                        path=out_mp3,
                        temporary=True,
                    )
                )
            if ok and chunks:
                return chunks, temporary
            for created in temporary:
                with contextlib.suppress(OSError):
                    created.unlink(missing_ok=True)

    return _split_wav_for_upload(path, max_bytes=max_bytes)


def _merge_overlap_segments(
    existing: list[Segment], incoming: list[Segment]
) -> list[Segment]:
    """Append ``incoming`` chunks while trimming overlap-zone duplicate segments."""
    if not existing:
        return list(incoming)
    if not incoming:
        return existing
    tail_end = existing[-1].end
    prev_tail_texts = {
        re.sub(r"\s+", "", seg.text).strip().lower()
        for seg in existing[-3:]
        if seg.text.strip()
    }
    for seg in incoming:
        if seg.start < tail_end - 0.05:
            norm = re.sub(r"\s+", "", seg.text).strip().lower()
            if norm and any(
                norm == prev or (len(norm) >= 4 and (norm in prev or prev in norm))
                for prev in prev_tail_texts
            ):
                continue
        existing.append(seg)
    return existing


def _read_and_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


async def _post_audio_chunk(
    client: httpx.AsyncClient,
    endpoint: str,
    headers: dict[str, str],
    data: dict[str, str],
    chunk_path: Path,
) -> httpx.Response:
    """POST one audio chunk, retrying once without ``verbose_json`` and remembering it."""
    payload = dict(data)
    mime = _audio_mime_type(chunk_path)
    response: httpx.Response | None = None
    for attempt in range(2):
        try:
            with chunk_path.open("rb") as handle:
                response = await client.post(
                    endpoint,
                    headers=headers,
                    data=payload,
                    files={"file": (chunk_path.name, handle, mime)},
                )
        except OSError as exc:
            raise TranscriptionError(
                f"Could not read the extracted audio file {chunk_path}: {exc}"
            ) from exc
        if (
            attempt == 0
            and response.status_code == 400
            and payload.get("response_format") == "verbose_json"
        ):
            body = (response.text or "").lower()
            if "response_format" in body or "verbose_json" in body:
                payload["response_format"] = "json"
                data["response_format"] = "json"
                continue
        return response
    assert response is not None
    return response


async def _post_gateway_chunk(
    client: httpx.AsyncClient,
    endpoint: str,
    headers: dict[str, str],
    model: str,
    chunk_path: Path,
) -> httpx.Response:
    """POST one audio chunk to the Vercel AI Gateway transcription protocol."""
    try:
        audio = await run_in_threadpool(_read_and_b64, chunk_path)
    except OSError as exc:
        raise TranscriptionError(
            f"Could not read the extracted audio file {chunk_path}: {exc}"
        ) from exc
    return await client.post(
        endpoint,
        headers={**headers, "ai-model-id": model},
        json={"audio": audio, "mediaType": _audio_mime_type(chunk_path)},
    )


def _segments_from_gateway_payload(
    payload: dict,
    *,
    offset: float = 0.0,
    duration_hint: float = 0.0,
) -> tuple[list[Segment], float]:
    """Normalise an AI Gateway transcription payload into segments + duration.

    The gateway reports ``durationInSeconds`` and, when the model provides
    timing, segments with ``startSecond``/``endSecond``. ``start``/``end`` are
    accepted as well so either shape parses.
    """
    reported = payload.get("durationInSeconds", payload.get("duration", 0.0))
    try:
        reported_duration = float(reported or 0.0)
    except (TypeError, ValueError):
        reported_duration = 0.0
    duration = (
        reported_duration if reported_duration > 0 else max(0.0, duration_hint)
    )
    language = payload.get("language")
    segments: list[Segment] = []
    raw_segments = payload.get("segments") or []
    if isinstance(raw_segments, list):
        for index, item in enumerate(raw_segments):
            if not isinstance(item, dict):
                continue
            text = (item.get("text") or "").strip()
            if not text:
                continue
            start, end = _extract_segment_times(item)
            segments.append(
                Segment(
                    id=index,
                    start=start + offset,
                    end=end + offset,
                    text=text,
                    language=language,
                )
            )
    if segments and duration > 0 and all(seg.end <= seg.start for seg in segments):
        logger.warning(
            "Gateway STT returned segments without timestamps; distributing "
            "%d segment(s) proportionally across %.1fs",
            len(segments),
            duration,
        )
        segments = _distribute_segments_proportionally(
            [(seg.text, seg.language) for seg in segments],
            start=offset,
            duration=duration,
        )
    if not segments:
        text = (payload.get("text") or "").strip()
        if text:
            segments = _segments_from_plain_text(
                text, start=offset, duration=duration, language=language
            )
    segments = _split_oversized_segments(segments)
    return segments, duration


def _safe_progress(
    on_progress: Callable[[float, str], None] | None,
    ratio: float,
    label: str,
) -> None:
    if on_progress is None:
        return
    try:
        on_progress(min(1.0, max(0.0, float(ratio))), label)
    except Exception:  # pragma: no cover - callbacks must never fail transcription
        logger.debug("Ignoring transcription progress callback failure", exc_info=True)


async def transcribe_cloud(
    audio_path: str | Path,
    *,
    base_url: str,
    api_key: str | None,
    model: str,
    language: str | None = None,
    prompt: str | None = None,
    glossary: dict[str, str] | None = None,
    timeout: float = 300.0,
    cancel_event: threading.Event | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> TranscriptionResult:
    """Transcribe through a cloud speech service.

    Two protocols are supported: OpenAI's multipart ``/audio/transcriptions``
    (OpenAI, Groq, local servers) and the Vercel AI Gateway's own
    ``/v4/ai/transcription-model`` (base64 JSON), which is what the gateway
    exposes instead of the OpenAI audio route.

    Audio is segmented so no upload exceeds the provider's size cap, then the
    per-chunk segments are re-timed onto the lecture timeline and returned as
    one transcript. Short files keep the old single-request path.
    """
    raise_if_cancelled(cancel_event)
    language = normalize_language(language)
    gateway = _is_vercel_gateway(base_url)
    data: dict[str, str] = {}
    max_bytes: int | None = None
    if gateway:
        endpoint = _vercel_gateway_endpoint(base_url)
        headers = {**VERCEL_GATEWAY_HEADERS, "Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        # The gateway schema has no top-level language/prompt fields.
        max_bytes = VERCEL_GATEWAY_MAX_UPLOAD_BYTES
    else:
        endpoint = base_url.rstrip("/") + "/audio/transcriptions"
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        data = {"model": model, "response_format": "verbose_json"}
        if language:
            data["language"] = language
        if prompt:
            data["prompt"] = prompt

    path = Path(audio_path)
    if not path.is_file():
        raise TranscriptionError(f"Audio file not found: {path}")

    audio_duration = await run_in_threadpool(_wav_duration, path)
    chunks, temporary = await run_in_threadpool(
        _prepare_cloud_upload, path, max_bytes=max_bytes, cancel_event=cancel_event
    )
    if len(chunks) > 1:
        logger.info(
            "Cloud STT: uploading %.1fs of audio as %d requests",
            audio_duration,
            len(chunks),
        )

    segments: list[Segment] = []
    detected_language: str | None = None
    duration = 0.0
    shared_data = dict(data)
    sem = asyncio.Semaphore(3)
    total_chunks = max(1, len(chunks))
    completed_chunks = 0

    async def _upload_one(
        client: httpx.AsyncClient, index: int, chunk: _CloudChunk
    ) -> tuple[int, _CloudChunk, list[Segment], float, str | None]:
        nonlocal completed_chunks
        async with sem:
            raise_if_cancelled(cancel_event)
            if index:
                logger.info(
                    "Cloud STT: request %d/%d at %.1fs",
                    index + 1,
                    len(chunks),
                    chunk.offset,
                )
            if gateway:
                response = await _post_gateway_chunk(
                    client, endpoint, headers, model, chunk.path
                )
            else:
                response = await _post_audio_chunk(
                    client, endpoint, headers, shared_data, chunk.path
                )
            if response.status_code >= 400:
                raise _cloud_status_error(
                    response, endpoint, base_url, gateway=gateway
                )
            try:
                payload = response.json()
            except ValueError as exc:
                raise TranscriptionError(
                    "Cloud STT returned a response that is not JSON: "
                    f"{response.text[:400]}"
                ) from exc
            if not isinstance(payload, dict):
                raise TranscriptionError(
                    f"Cloud STT returned an unexpected payload: {response.text[:400]}"
                )
            try:
                if gateway:
                    part_segments, part_duration = _segments_from_gateway_payload(
                        payload, offset=chunk.offset, duration_hint=chunk.duration
                    )
                else:
                    part_segments, part_duration = _segments_from_cloud_payload(
                        payload, offset=chunk.offset, duration_hint=chunk.duration
                    )
            except (AttributeError, TypeError, ValueError) as exc:
                raise TranscriptionError(
                    f"Cloud STT returned malformed segments: {exc}"
                ) from exc
            completed_chunks += 1
            _safe_progress(
                on_progress,
                completed_chunks / total_chunks,
                "Speech transcript received…"
                if total_chunks == 1
                else f"Transcribed chunk {completed_chunks} of {total_chunks}…",
            )
            return index, chunk, part_segments, part_duration, payload.get("language")

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        ) as client:
            if chunks:
                _safe_progress(
                    on_progress,
                    0.0,
                    "Uploading audio to speech service…"
                    if len(chunks) == 1
                    else f"Uploading audio ({len(chunks)} chunks)…",
                )
                # Send chunk 0 first so any verbose_json -> json fallback is learned
                # before remaining chunks fan out concurrently.
                first_res = await _upload_one(client, 0, chunks[0])
                results = [first_res]
                if len(chunks) > 1:
                    rest = await asyncio.gather(
                        *(
                            _upload_one(client, idx, ch)
                            for idx, ch in enumerate(chunks[1:], start=1)
                        )
                    )
                    results.extend(rest)
                for _idx, ch, part_segments, part_duration, lang in sorted(
                    results, key=lambda r: r[0]
                ):
                    segments = _merge_overlap_segments(segments, part_segments)
                    detected_language = detected_language or lang
                    duration = max(duration, ch.offset + part_duration)
    except httpx.HTTPError as exc:
        raise TranscriptionError(
            f"Could not reach the Cloud STT endpoint at {endpoint}: {exc}"
        ) from exc
    finally:
        for created in temporary:
            with contextlib.suppress(OSError):
                created.unlink(missing_ok=True)

    for index, segment in enumerate(segments):
        segment.id = index
    if duration <= 0:
        duration = audio_duration

    return TranscriptionResult(
        segments=apply_glossary_to_segments(segments, glossary),
        duration=duration,
        language=detected_language,
        language_probability=None,
        device="cloud",
        compute_type="cloud",
        model=model,
        vram_unloaded=False,
    )


CLOUD_STT_OVERSIZED_SEGMENT_SECONDS = 30.0


def _extract_segment_times(item: dict) -> tuple[float, float]:
    """Extract ``(start, end)`` across common OpenAI / gateway / Whisper schemas."""
    start_val = item.get("start")
    if start_val is None:
        start_val = item.get("startSecond", item.get("start_time"))
    end_val = item.get("end")
    if end_val is None:
        end_val = item.get("endSecond", item.get("end_time"))
    if (start_val is None or end_val is None) and isinstance(
        item.get("timestamp"), (list, tuple)
    ):
        ts = item["timestamp"]
        if len(ts) >= 2:
            if start_val is None:
                start_val = ts[0]
            if end_val is None:
                end_val = ts[1]
    return float(start_val or 0.0), float(end_val or 0.0)


def _split_plain_cloud_text(text: str) -> list[str]:
    """Split a segment-less or oversized text into sentence-ish chunks.

    Sentence-ending punctuation (and hard newlines) are the boundaries; a run
    with no punctuation at all is cut near a space so no chunk becomes a
    multi-minute cue again.
    """
    pieces = [
        piece.strip() for piece in _PLAIN_SENTENCE_BREAK.split(text) if piece.strip()
    ]
    chunks: list[str] = []
    min_space_cut = CLOUD_STT_PLAIN_CHUNK_CHARS // 2
    for piece in pieces:
        while len(piece) > CLOUD_STT_PLAIN_CHUNK_CHARS:
            cut = piece.rfind(" ", min_space_cut, CLOUD_STT_PLAIN_CHUNK_CHARS)
            if cut <= 0:
                cut = CLOUD_STT_PLAIN_CHUNK_CHARS
            part = piece[:cut].strip()
            if part:
                chunks.append(part)
            piece = piece[cut:].strip()
        if piece:
            chunks.append(piece)
    return chunks


def _distribute_segments_proportionally(
    items: list[tuple[str, str | None]],
    *,
    start: float,
    duration: float,
) -> list[Segment]:
    if not items:
        return []
    total_chars = max(1, sum(len(text) for text, _ in items))
    cursor = start
    out: list[Segment] = []
    for index, (chunk, lang) in enumerate(items):
        share = duration * len(chunk) / total_chars
        seg_end = start + duration if index == len(items) - 1 else cursor + share
        out.append(
            Segment(
                id=index,
                start=round(cursor, 3),
                end=round(max(cursor + 0.001, seg_end), 3),
                text=chunk,
                language=lang,
            )
        )
        cursor = seg_end
    return out


def _segments_from_plain_text(
    text: str,
    *,
    start: float,
    duration: float,
    language: str | None,
) -> list[Segment]:
    chunks = (
        _split_plain_cloud_text(text)
        if len(text) > CLOUD_STT_PLAIN_SPLIT_MIN_CHARS and duration > 0
        else [text]
    )
    if len(chunks) > 1:
        logger.warning(
            "Cloud STT returned plain text without segments; splitting "
            "proportionally into %d pseudo-segments",
            len(chunks),
        )
        return _distribute_segments_proportionally(
            [(chunk, language) for chunk in chunks],
            start=start,
            duration=duration,
        )
    return [
        Segment(
            id=0,
            start=start,
            end=start + duration,
            text=text,
            language=language,
        )
    ]


def _split_oversized_segments(segments: list[Segment]) -> list[Segment]:
    """Sub-divide multi-minute STT segments into readable sentence/clause chunks."""
    out: list[Segment] = []
    for seg in segments:
        seg_dur = seg.end - seg.start
        if (
            seg_dur > CLOUD_STT_OVERSIZED_SEGMENT_SECONDS
            and len(seg.text) > CLOUD_STT_PLAIN_SPLIT_MIN_CHARS
        ):
            chunks = _split_plain_cloud_text(seg.text)
            if len(chunks) > 1:
                parts = _distribute_segments_proportionally(
                    [(chunk, seg.language) for chunk in chunks],
                    start=seg.start,
                    duration=seg_dur,
                )
                out.extend(parts)
                continue
        out.append(seg)
    for index, seg in enumerate(out):
        seg.id = index
    return out


def _segments_from_cloud_payload(
    payload: dict,
    *,
    offset: float = 0.0,
    duration_hint: float = 0.0,
) -> tuple[list[Segment], float]:
    """Normalise a verbose-json Cloud STT payload into segments + duration.

    ``offset`` shifts a chunk's relative timestamps onto the lecture timeline;
    ``duration_hint`` is the chunk's known length, used when a provider answers
    with plain ``json`` (no duration, no segments). A plain-``json`` reply whose
    text is long is split into sentence-ish pseudo-segments with proportional
    timestamps, so Step 2 still sees clip boundaries. Ids are renumbered by the
    caller after all chunks are merged.
    """
    reported_duration = float(payload.get("duration", 0.0) or 0.0)
    duration = reported_duration if reported_duration > 0 else max(0.0, duration_hint)
    raw_segments = payload.get("segments") or []
    language = payload.get("language")
    segments: list[Segment] = []
    if raw_segments:
        for index, item in enumerate(raw_segments):
            if not isinstance(item, dict):
                continue
            text = (item.get("text") or "").strip()
            if text:
                seg_start, seg_end = _extract_segment_times(item)
                segments.append(
                    Segment(
                        id=index,
                        start=seg_start + offset,
                        end=seg_end + offset,
                        text=text,
                        language=language,
                    )
                )
    if segments and duration > 0 and all(seg.end <= seg.start for seg in segments):
        logger.warning(
            "Cloud STT returned segments without timestamps; distributing "
            "%d segment(s) proportionally across %.1fs",
            len(segments),
            duration,
        )
        segments = _distribute_segments_proportionally(
            [(seg.text, seg.language) for seg in segments],
            start=offset,
            duration=duration,
        )
    if not segments:
        text = (payload.get("text") or "").strip()
        if text:
            segments = _segments_from_plain_text(
                text, start=offset, duration=duration, language=language
            )
    segments = _split_oversized_segments(segments)
    return segments, duration


# --------------------------------------------------------------------------- #
# Module-level singleton (one warm model, shared by /health and the endpoint)
# --------------------------------------------------------------------------- #
_transcriber = WhisperTranscriber()
_transcriber_lock = threading.Lock()


def get_transcriber(
    model: str | None = None,
    device: str | None = None,
    compute_type: str | None = None,
) -> WhisperTranscriber:
    """Return the warm singleton, replacing it when the request config differs.

    The frontend always sends its configured model/device/compute_type, so a
    naive "is any override present?" check would build a throwaway engine on
    every call: the warm model was never reused, ``/health.whisper.loaded``
    always said ``False`` and ``auto_unload=False`` was defeated.  Matching the
    requested config against the singleton fixes all three.  A mismatching
    request unloads the old engine (freeing GPU memory) and installs a new singleton.
    """
    global _transcriber
    if model is None and device is None and compute_type is None:
        return _transcriber
    with _transcriber_lock:
        if not _transcriber.configured_with(model, device, compute_type):
            previous = _transcriber.requested_config()
            _transcriber.unload()
            _transcriber = WhisperTranscriber(
                model_size=model,
                device=device,
                compute_type=compute_type,
            )
            logger.info(
                "Replaced the Whisper singleton: %s -> %s",
                previous,
                _transcriber.requested_config(),
            )
        return _transcriber


def describe_environment() -> dict:
    return {
        "cuda_available": cuda_available(),
        "cuda_device_count": cuda_device_count(),
        "nvidia_smi_available": nvidia_smi_available(),
        "vram_mb": nvidia_vram_mb(),
        "whisper_model": _transcriber.model_size,
        "whisper_loaded": _transcriber.loaded,
        "whisper_device": _transcriber.device,
        "whisper_compute_type": _transcriber.compute_type,
    }
