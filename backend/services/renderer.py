"""FFmpeg subprocess runner: NVENC -> libx264 fallback, 9:16 blur-fill, SSE.

Every FFmpeg invocation in the application lives here.  The renderer builds the
filtergraph from the plan (Section 6B), burns the dual-style ``.ass`` with
``fontsdir`` pointing at the imported font directory, and yields progress
dictionaries that ``main.py`` forwards as Server-Sent Events.
"""

from __future__ import annotations

import contextlib
import logging
import math
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import config
from services import subtitle_gen

logger = logging.getLogger("tafseer.renderer")

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


class RenderError(RuntimeError):
    """Raised when FFmpeg cannot produce the requested clip."""


# --------------------------------------------------------------------------- #
# Active subprocess registry
# --------------------------------------------------------------------------- #
# The sidecar is stopped by Tauri (SIGTERM/ctrl-break) while a batch may be
# encoding; the FastAPI lifespan shutdown hook calls
# :func:`terminate_active_processes` so no ffmpeg.exe is left running.
_ACTIVE_LOCK = threading.Lock()
_ACTIVE_PROCESSES: set[subprocess.Popen] = set()


def _register_process(process: subprocess.Popen) -> None:
    with _ACTIVE_LOCK:
        _ACTIVE_PROCESSES.add(process)


def _unregister_process(process: subprocess.Popen) -> None:
    with _ACTIVE_LOCK:
        _ACTIVE_PROCESSES.discard(process)


def _kill_process(process: subprocess.Popen) -> None:
    """Terminate FFmpeg, tolerating a process that already exited."""
    if process.poll() is not None:
        return
    try:
        process.kill()
    except OSError:  # pragma: no cover - dead process on Windows
        pass


def terminate_active_processes() -> int:
    """Kill every FFmpeg process still running; returns how many were killed."""
    with _ACTIVE_LOCK:
        processes = list(_ACTIVE_PROCESSES)
        _ACTIVE_PROCESSES.clear()
    killed = 0
    for process in processes:
        if process.poll() is None:
            _kill_process(process)
            killed += 1
    return killed


# --------------------------------------------------------------------------- #
# Encoder capability
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=8)
def encoder_available(encoder: str) -> bool:
    """True when the bundled FFmpeg was compiled with ``encoder``."""
    ffmpeg = config.ffmpeg_path()
    if not ffmpeg:
        return False
    try:
        completed = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=20,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return re.search(rf"\s{re.escape(encoder)}\s", completed.stdout or "") is not None


@lru_cache(maxsize=1)
def nvenc_available() -> bool:
    """Probe NVENC for real: compiled-in *and* a driver that accepts a frame.

    A compiled-in encoder is not enough - old drivers report
    ``Driver does not support the required nvenc API version`` only when the
    encoder is actually opened, so a one-frame null encode is the only reliable
    signal.  The result is cached for the process lifetime.
    """
    if not encoder_available("h264_nvenc"):
        return False
    ffmpeg = config.ffmpeg_path()
    if not ffmpeg:
        return False
    try:
        completed = subprocess.run(
            [
                ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=256x144:r=1:d=0.2",
                "-c:v",
                "h264_nvenc",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=30,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def clear_capability_cache() -> None:
    encoder_available.cache_clear()
    nvenc_available.cache_clear()


# --------------------------------------------------------------------------- #
# Path / filter escaping
# --------------------------------------------------------------------------- #
def escape_filter_path(path: str | Path) -> str:
    """Escape a Windows path for use inside an FFmpeg filtergraph value.

    Forward slashes are accepted everywhere; ``:`` separates filter options so
    it must be escaped even inside single quotes.  Brackets/commas/semicolons
    are left untouched: inside single quotes FFmpeg keeps a leading backslash
    literally, which corrupts Windows paths.
    """
    text = str(Path(path).resolve()).replace("\\", "/")
    text = text.replace(":", "\\:")
    text = text.replace("'", "\\'")
    return text


def build_filtergraph(
    *,
    resolution: str,
    framing: str,
    ass_path: str | Path,
    fonts_dir: str | Path,
) -> str:
    """Return the ``-filter_complex`` graph for one clip.

    ``blur-fill`` (plan default) preserves the lecture slide inside a blurred
    9:16 background; ``center-crop`` fills the frame by cropping.
    """
    width, height = subtitle_gen.parse_resolution(resolution)
    ass = (
        f"ass=filename='{escape_filter_path(ass_path)}'"
        f":fontsdir='{escape_filter_path(fonts_dir)}'"
    )

    if framing == "blur-fill":
        return (
            f"[0:v]split=2[main][bg];"
            f"[bg]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},boxblur=20:5,setsar=1[blurred];"
            f"[main]scale={width}:{height}:force_original_aspect_ratio=decrease:"
            f"force_divisible_by=2:flags=lanczos,setsar=1[fg];"
            f"[blurred][fg]overlay=(W-w)/2:(H-h)/2,{ass}[outv]"
        )

    if framing == "center-crop":
        return (
            f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1,{ass}[outv]"
        )

    raise RenderError(f"Unsupported framing mode '{framing}'")


# --------------------------------------------------------------------------- #
# Command construction
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class EncodeSettings:
    encoder: str
    args: list[str]


def encode_settings(encoder: str) -> EncodeSettings:
    if encoder == "h264_nvenc":
        return EncodeSettings(
            encoder=encoder,
            args=[
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p5",
                "-rc",
                "vbr",
                "-cq",
                "21",
                "-b:v",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-profile:v",
                "high",
            ],
        )
    return EncodeSettings(
        encoder="libx264",
        args=[
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high",
        ],
    )


def build_ffmpeg_args(
    *,
    ffmpeg: str,
    source: Path,
    output: Path,
    filtergraph: str,
    start: float,
    duration: float,
    encoder: str,
    audio_bitrate: str = "192k",
    threads: int = 0,
) -> list[str]:
    args = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(0.0, start):.3f}",
        "-t",
        f"{max(0.05, duration):.3f}",
        "-i",
        str(source),
        "-filter_complex",
        filtergraph,
        "-map",
        "[outv]",
        "-map",
        "0:a?",
        "-sn",
        "-dn",
    ]
    args += encode_settings(encoder).args
    if threads > 0:
        args += ["-threads", str(threads)]
    args += [
        "-c:a",
        "aac",
        "-b:a",
        audio_bitrate,
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(output),
    ]
    return args


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class RenderJob:
    source: Path
    output: Path
    start: float
    duration: float
    resolution: str
    framing: str
    ass_path: Path
    fonts_dir: Path
    use_nvenc: bool = True
    audio_bitrate: str = "192k"
    timeout: float | None = None


def _drain_stderr(stream, sink: deque[str]) -> None:
    try:
        for line in stream:
            line = line.rstrip()
            if line:
                sink.append(line)
    except (ValueError, OSError):  # pragma: no cover - pipe closed early
        pass


@dataclass(slots=True)
class _WatchdogState:
    timed_out: bool = False


def _start_watchdog(
    process: subprocess.Popen, timeout: float, state: _WatchdogState
) -> threading.Thread:
    """Kill ``process`` when it runs longer than ``timeout`` seconds.

    A blocking ``for line in process.stdout`` can never notice the deadline
    itself (a wedged FFmpeg may emit no progress lines at all), so the wall
    clock is enforced from a daemon thread instead.
    """

    def watch() -> None:
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            state.timed_out = True
            logger.warning(
                "FFmpeg exceeded the %.0fs watchdog; terminating it", timeout
            )
            _kill_process(process)
        except Exception:  # pragma: no cover - defensive
            pass

    thread = threading.Thread(target=watch, name="ffmpeg-watchdog", daemon=True)
    thread.start()
    return thread


def _run_once(job: RenderJob, encoder: str, ffmpeg: str) -> Iterator[dict]:
    graph = build_filtergraph(
        resolution=job.resolution,
        framing=job.framing,
        ass_path=job.ass_path,
        fonts_dir=job.fonts_dir,
    )
    # Render into a hidden sibling file in the same directory so a failed,
    # cancelled, or timed-out FFmpeg run never leaves a truncated target MP4 or
    # destroys an existing output on re-render; os.replace promotes atomically.
    staging = job.output.with_name(
        f".{job.output.stem}.rendering.{uuid.uuid4().hex[:8]}{job.output.suffix}"
    )
    args = build_ffmpeg_args(
        ffmpeg=ffmpeg,
        source=job.source,
        output=staging,
        filtergraph=graph,
        start=job.start,
        duration=job.duration,
        encoder=encoder,
        audio_bitrate=job.audio_bitrate,
    )

    try:
        job.output.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RenderError(
            f"Cannot create the output directory '{job.output.parent}': {exc}"
        ) from exc
    stderr_tail: deque[str] = deque(maxlen=40)
    started = time.monotonic()

    try:
        process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=CREATE_NO_WINDOW,
        )
    except OSError as exc:
        raise RenderError(f"Could not start FFmpeg: {exc}") from exc

    _register_process(process)

    reader = threading.Thread(
        target=_drain_stderr, args=(process.stderr, stderr_tail), daemon=True
    )
    reader.start()

    timeout = job.timeout if job.timeout and job.timeout > 0 else config.render_clip_timeout()
    timeout = max(1.0, float(timeout))
    state = _WatchdogState()
    watchdog = _start_watchdog(process, timeout, state)

    total = max(0.05, float(job.duration))
    last_ratio = -1.0
    last_emit = 0.0
    returncode = -1
    # True only when FFmpeg exited 0 with a complete output file; anything else
    # (cancel, watchdog kill, failure) leaves a truncated MP4 that must go.
    completed = False

    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            key, _, value = raw_line.strip().partition("=")
            ratio = last_ratio
            if key == "out_time_us":
                try:
                    out_time_us = float(value)
                except ValueError:
                    continue
                if not math.isfinite(out_time_us) or out_time_us < 0:
                    continue
                ratio = min(1.0, max(0.0, out_time_us / 1_000_000.0 / total))
            elif key == "progress" and value == "end":
                ratio = 1.0
            else:
                continue

            now = time.monotonic()
            if ratio >= last_ratio + 0.01 or now - last_emit >= 1.0 or ratio >= 1.0:
                last_ratio = ratio
                last_emit = now
                yield {
                    "stage": "encoding",
                    "encoder": encoder,
                    "clip_progress": round(ratio, 4),
                    "elapsed": round(now - started, 2),
                }
    except GeneratorExit:
        # The SSE client disconnected: stop FFmpeg instead of waiting it out.
        _kill_process(process)
        raise
    except BaseException:
        # Any read/parse failure must not leave FFmpeg running (the old code
        # waited on the process without killing it and could deadlock).
        _kill_process(process)
        raise
    finally:
        _unregister_process(process)
        returncode = process.wait()
        watchdog.join(timeout=5)
        reader.join(timeout=5)
        if returncode == 0 and staging.is_file() and staging.stat().st_size > 0:
            try:
                os.replace(staging, job.output)
                completed = True
            except OSError as exc:
                logger.warning("Could not finalize rendered output %s: %s", job.output, exc)
                with contextlib.suppress(OSError):
                    staging.unlink(missing_ok=True)
        else:
            # A killed or failed FFmpeg leaves a partial, unplayable MP4;
            # clean up only the staging file so any prior good output survives.
            try:
                staging.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("Could not remove partial staging output %s: %s", staging, exc)

    if state.timed_out:
        detail = " | ".join(list(stderr_tail)[-3:]) or "no FFmpeg output"
        raise RenderError(
            f"{encoder} was still running after {timeout:.0f}s and was "
            f"terminated by the watchdog: {detail}"
        )

    if returncode != 0 or not completed or not job.output.is_file():
        detail = " | ".join(list(stderr_tail)[-3:]) or "unknown FFmpeg error"
        raise RenderError(f"{encoder} failed (exit {returncode}): {detail}")


def render(job: RenderJob) -> Iterator[dict]:
    """Render one clip, yielding progress dicts; NVENC falls back to CPU.

    The fallback re-runs the whole clip with ``libx264`` because an NVENC
    failure (missing GPU, driver mismatch, session limit) leaves a partial file.
    """
    ffmpeg = config.ffmpeg_path()
    if not ffmpeg:
        raise RenderError(
            "ffmpeg.exe was not found. Place it in src-tauri/binaries/ or set "
            "TAFSEER_FFMPEG."
        )
    if not job.source.is_file():
        raise RenderError(f"Source video not found: {job.source}")
    if not job.ass_path.is_file():
        raise RenderError(f"Subtitle file not found: {job.ass_path}")

    attempts: list[str] = []
    if job.use_nvenc:
        if nvenc_available():
            attempts.append("h264_nvenc")
        else:
            # Keep the UI's "NVENC unavailable - using CPU" toast, but do not
            # pay for a doomed NVENC encode before the fallback.
            yield {
                "stage": "fallback",
                "encoder": "libx264",
                "failed_encoder": "h264_nvenc",
                "clip_progress": 0.0,
                "reason": (
                    "NVENC is not available on this machine (GPU/driver probe "
                    "failed); using libx264."
                ),
            }
    attempts.append("libx264")

    last_error: RenderError | None = None
    for attempt_index, encoder in enumerate(attempts):
        try:
            yield from _run_once(job, encoder, ffmpeg)
        except RenderError as exc:
            last_error = exc
            logger.warning("encoder %s failed, falling back: %s", encoder, exc)
            if attempt_index + 1 < len(attempts):
                yield {
                    "stage": "fallback",
                    "encoder": attempts[attempt_index + 1],
                    "failed_encoder": encoder,
                    "clip_progress": 0.0,
                    "reason": str(exc)[:300],
                }
                continue
            break
        else:
            yield {
                "stage": "encoded",
                "encoder": encoder,
                "clip_progress": 1.0,
                "output_path": str(job.output),
            }
            return

    raise last_error or RenderError("FFmpeg could not render the clip")
