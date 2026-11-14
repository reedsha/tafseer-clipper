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

import gc
import logging
import math
import subprocess
import sys
import threading
import wave
from array import array
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import httpx

import config
from services import accel

logger = logging.getLogger("tafseer.transcriber")

#: Hide the console window a bundled FFmpeg would otherwise flash on Windows.
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

#: Downsampled waveform envelope returned to the Step-2 wavesurfer scrubber.
WAVEFORM_PEAK_COUNT = 1200


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
def extract_audio(video_path: str | Path, out_wav: str | Path) -> Path:
    """Extract a 16 kHz mono PCM WAV with FFmpeg (plan Section 6A.2)."""
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
    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise TranscriptionError(
            f"FFmpeg did not finish extracting audio within {timeout:.0f}s; "
            "the lecture may be corrupt or the file is on a stalled drive."
        ) from exc
    except OSError as exc:
        raise TranscriptionError(f"Could not start FFmpeg: {exc}") from exc
    if completed.returncode != 0 or not target.is_file():
        detail = (completed.stderr or "").strip().splitlines()
        raise TranscriptionError(
            "FFmpeg failed to extract audio: "
            + (" | ".join(detail[-3:]) if detail else "unknown error")
        )
    return target


# --------------------------------------------------------------------------- #
# Waveform envelope (Step-2 wavesurfer scrubber)
# --------------------------------------------------------------------------- #
def compute_waveform_peaks(
    wav_path: str | Path, *, points: int = WAVEFORM_PEAK_COUNT
) -> list[float]:
    """Downsampled peak envelope (``0..1``) of a PCM WAV, stdlib only.

    The extracted audio is always 16 kHz mono ``pcm_s16le``; numpy is only a
    test dependency, so this streams the file bucket by bucket with the stdlib
    ``wave``/``array`` modules (C-level ``max``/``min`` per bucket).  Any
    unreadable/unsupported WAV yields an empty list - the waveform is optional
    UI sugar, never a reason to fail a transcription.
    """
    target = Path(wav_path)
    try:
        with wave.open(str(target), "rb") as handle:
            total_frames = handle.getnframes()
            sample_width = handle.getsampwidth()
            if total_frames <= 0 or sample_width != 2:
                return []
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
    ) -> TranscriptionResult:
        model = self._ensure_model()

        try:
            segments_iter, info = model.transcribe(
                str(audio_path),
                language=normalize_language(language),
                task="transcribe",
                beam_size=5,
                vad_filter=vad_filter,
                vad_parameters={"min_silence_duration_ms": 500},
                initial_prompt=initial_prompt or None,
                word_timestamps=False,
            )

            raw: list[Segment] = []
            for index, item in enumerate(segments_iter):
                text = (item.text or "").strip()
                if not text:
                    continue
                raw.append(
                    Segment(
                        id=index,
                        start=float(item.start),
                        end=float(item.end),
                        text=text,
                        language=getattr(info, "language", None),
                    )
                )

            segments = apply_glossary_to_segments(raw, glossary)
            duration = float(getattr(info, "duration", 0.0) or 0.0)
            if duration <= 0 and segments:
                duration = max(segment.end for segment in segments)
            language_detected = getattr(info, "language", None)
            language_probability = getattr(info, "language_probability", None)
        finally:
            # Drop the last local reference before unload() so the CTranslate2
            # engine is actually destroyed (and its CUDA pool freed) when the
            # auto-unload toggle is on.
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


# --------------------------------------------------------------------------- #
# Cloud STT (optional)
# --------------------------------------------------------------------------- #
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
) -> TranscriptionResult:
    """Transcribe through an OpenAI-compatible ``/audio/transcriptions`` API."""
    endpoint = base_url.rstrip("/") + "/audio/transcriptions"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    data = {"model": model, "response_format": "verbose_json"}
    language = normalize_language(language)
    if language:
        data["language"] = language
    if prompt:
        data["prompt"] = prompt

    path = Path(audio_path)
    if not path.is_file():
        raise TranscriptionError(f"Audio file not found: {path}")

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            with path.open("rb") as handle:
                response = await client.post(
                    endpoint,
                    headers=headers,
                    data=data,
                    files={"file": (path.name, handle, "audio/wav")},
                )
    except httpx.HTTPError as exc:
        raise TranscriptionError(
            f"Could not reach the Cloud STT endpoint at {endpoint}: {exc}"
        ) from exc
    except OSError as exc:
        raise TranscriptionError(
            f"Could not read the extracted audio file {path}: {exc}"
        ) from exc

    if response.status_code >= 400:
        raise TranscriptionError(
            f"Cloud STT rejected the request ({response.status_code}): "
            f"{response.text[:400]}"
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
        segments, duration = _segments_from_cloud_payload(payload)
    except (AttributeError, TypeError, ValueError) as exc:
        raise TranscriptionError(
            f"Cloud STT returned malformed segments: {exc}"
        ) from exc

    return TranscriptionResult(
        segments=apply_glossary_to_segments(segments, glossary),
        duration=duration,
        language=payload.get("language"),
        language_probability=None,
        device="cloud",
        compute_type="cloud",
        model=model,
        vram_unloaded=False,
    )


def _segments_from_cloud_payload(
    payload: dict,
) -> tuple[list[Segment], float]:
    """Normalise a verbose-json Cloud STT payload into segments + duration."""
    raw_segments = payload.get("segments") or []
    segments: list[Segment] = []
    if raw_segments:
        for index, item in enumerate(raw_segments):
            if not isinstance(item, dict):
                continue
            text = (item.get("text") or "").strip()
            if text:
                segments.append(
                    Segment(
                        id=index,
                        start=float(item.get("start", 0.0)),
                        end=float(item.get("end", 0.0)),
                        text=text,
                        language=payload.get("language"),
                    )
                )
    else:
        text = (payload.get("text") or "").strip()
        if text:
            segments.append(
                Segment(
                    id=0,
                    start=0.0,
                    end=float(payload.get("duration", 0.0) or 0.0),
                    text=text,
                    language=payload.get("language"),
                )
            )
    return segments, float(payload.get("duration", 0.0) or 0.0)


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
