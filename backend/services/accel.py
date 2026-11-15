"""Optional GPU acceleration detection and CUDA runtime registration.

The desktop application ships GPU acceleration as an **optional pack** that the
Tauri shell downloads, verifies and unpacks into ``%LOCALAPPDATA%``; the sidecar
receives its absolute directory as ``TAFSEER_CUDA_DIR``.  That directory has to
be registered for native DLL loading *before* ``ctranslate2`` /
``faster-whisper`` import their CUDA libraries, which is what
:func:`activate_runtime_dirs` does (and why ``main.py`` calls it before importing
the AI services).

Everything here degrades to the CPU: a missing GPU, a missing pack or a broken
CUDA runtime never fails startup, it only flips the ``/health.acceleration``
report to ``cpu`` with a machine-readable reason.  The report is additive, so
older frontends keep working.

Vocabulary note: user-facing strings say "GPU acceleration", "CUDA runtime" and
"CPU fallback".  Hardware product lines appear only in the technical probe
commands below.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import config

logger = logging.getLogger("tafseer.accel")

#: Hide the console window a probe would otherwise flash on Windows.
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

#: Probes spawn a process / load CUDA DLLs, so results are cached for ~30 s
#: (the UI polls /health every 15 s).
PROBE_TTL = 30.0
#: ``nvidia-smi`` must answer quickly or it is not a usable probe.
SMI_TIMEOUT = 4.0

_probe_lock = threading.Lock()
_gpu_cache: tuple[float, dict[str, Any] | None] | None = None
_runtime_cache: tuple[float, bool] | None = None
_registered_dirs: set[str] = set()
_missing_dirs: set[str] = set()
#: ``os.add_dll_directory`` handles must stay open for as long as the process
#: may load native libraries from the pack directory.
_dll_handles: list[Any] = []


# --------------------------------------------------------------------------- #
# CUDA runtime directory registration
# --------------------------------------------------------------------------- #
def activate_runtime_dirs() -> list[str]:
    """Register the optional GPU pack directory for DLL loading (idempotent).

    Windows needs ``os.add_dll_directory`` *and* a ``PATH`` entry: ctranslate2's
    native libraries resolve cuBLAS/cuDNN by name when the CUDA backend is
    initialised.  Returns the directories registered by this call (empty when no
    pack is configured or the directory is missing).
    """
    directory = config.accel_dir()
    if directory is None:
        return []
    resolved = str(directory)
    with _probe_lock:
        if resolved in _registered_dirs:
            return [resolved]
    if not directory.is_dir():
        with _probe_lock:
            first_time = resolved not in _missing_dirs
            _missing_dirs.add(resolved)
        if first_time:
            logger.warning(
                "GPU acceleration pack directory does not exist: %s", resolved
            )
        return []

    if sys.platform == "win32":
        try:
            handle = os.add_dll_directory(resolved)  # type: ignore[attr-defined]
            with _probe_lock:
                _dll_handles.append(handle)
        except (AttributeError, OSError) as exc:  # pragma: no cover - Windows-only
            logger.warning(
                "Could not register %s for DLL loading: %s", resolved, exc
            )

    current_path = os.environ.get("PATH", "")
    entries = current_path.split(os.pathsep) if current_path else []
    if resolved not in entries:
        os.environ["PATH"] = os.pathsep.join([resolved, *entries])

    with _probe_lock:
        _registered_dirs.add(resolved)
        _missing_dirs.discard(resolved)
    logger.info("Registered GPU acceleration runtime directory: %s", resolved)
    return [resolved]


# --------------------------------------------------------------------------- #
# GPU probe (nvidia-smi)
# --------------------------------------------------------------------------- #
def _nvidia_smi_candidates() -> list[str]:
    """Known locations of ``nvidia-smi``; the probe tolerates it being absent."""
    candidates: list[str] = []
    on_path = shutil.which("nvidia-smi")
    if on_path:
        candidates.append(on_path)
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    candidates.append(str(Path(system_root) / "System32" / "nvidia-smi.exe"))
    program_files = os.environ.get("ProgramFiles") or r"C:\Program Files"
    candidates.append(
        str(Path(program_files) / "NVIDIA Corporation" / "NVSMI" / "nvidia-smi.exe")
    )
    unique: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


def _parse_gpu_line(output: str) -> dict[str, Any] | None:
    """Parse ``nvidia-smi --query-gpu=name,memory.total --format=csv,noheader``."""
    for line in (output or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2 or not parts[0]:
            continue
        memory_field = parts[1].split()[0] if parts[1].split() else ""
        try:
            vram_mb = int(float(memory_field))
        except ValueError:
            vram_mb = 0
        return {"name": parts[0], "vram_mb": vram_mb}
    return None


def _probe_gpu() -> dict[str, Any] | None:
    for executable in _nvidia_smi_candidates():
        if not Path(executable).is_file():
            continue
        try:
            completed = subprocess.run(
                [
                    executable,
                    "--query-gpu=name,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=SMI_TIMEOUT,
                check=False,
                creationflags=CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if completed.returncode != 0:
            continue
        info = _parse_gpu_line(completed.stdout)
        if info is not None:
            return info
    return None


def nvidia_gpu_info() -> dict[str, Any] | None:
    """Detected GPU as ``{"name": str, "vram_mb": int}``, or ``None``.

    Uses the vendor diagnostic tool, which is present whenever a usable driver
    is installed; a missing executable, a non-zero exit or unparseable output
    all mean "no GPU detected" rather than an error.
    """
    global _gpu_cache
    now = time.monotonic()
    with _probe_lock:
        if _gpu_cache is not None and now - _gpu_cache[0] < PROBE_TTL:
            return _gpu_cache[1]
    info = _probe_gpu()
    with _probe_lock:
        _gpu_cache = (now, info)
    return info


# --------------------------------------------------------------------------- #
# CUDA runtime probe (ctranslate2)
# --------------------------------------------------------------------------- #
def _probe_cuda_runtime() -> bool:
    """True only when the CUDA *compute* runtime can actually be loaded.

    ``ctranslate2.get_supported_compute_types("cuda")`` answers "was this build
    compiled with CUDA support". It is true on any wheel with the CUDA backend
    even when ``cublas64_12.dll`` is nowhere on the machine, because it never
    loads cuBLAS. Trusting it made ``/health`` claim ``cuda_runtime: true`` next
    to ``pack_installed: false`` and sent transcription down a CUDA path that
    died at the first ``encode()``.

    The compute libraries are therefore loaded for real. cuBLAS/cuDNN are what
    CTranslate2 dlopen()s on first use, so a missing acceleration pack fails
    here - cheaply, before any user audio is involved.

    A deliberately *invalid* dummy model must not be used for this: CTranslate2
    validates the model file before touching CUDA, so a fake model fails on
    ``cpu`` as well and would report "no GPU" on machines that do have the pack.
    """
    activate_runtime_dirs()
    try:
        import ctranslate2  # type: ignore
    except Exception:  # pragma: no cover - depends on the build
        return False
    try:
        if not ctranslate2.get_supported_compute_types("cuda"):
            return False
    except Exception:
        return False
    return _load_cuda_compute_libraries()


def _load_cuda_compute_libraries() -> bool:
    """Force-load the CUDA libraries CTranslate2 needs, or report "not ready"."""
    if sys.platform != "win32":  # pragma: no cover - Windows-only app
        # Elsewhere the compiled-in answer is as good as it gets from here.
        return True

    import ctypes

    targets: list[str] = []
    directory = config.accel_dir()
    if directory is not None and directory.is_dir():
        for stem in ("cublas64", "cudnn64"):
            matches = sorted(directory.glob(f"{stem}*.dll"))
            if matches:
                targets.append(str(matches[0]))
    if not targets:
        # No pack installed: the libraries would have to come from a system-wide
        # CUDA install, so ask the loader for them by name. A missing one raises
        # OSError and the GPU path is reported unavailable.
        targets = ["cublas64_12.dll", "cudnn64_9.dll"]

    for target in targets:
        try:
            ctypes.WinDLL(target)
        except OSError as exc:
            logger.debug("CUDA compute library not loadable (%s): %s", target, exc)
            return False
    return True


def cuda_runtime_ready() -> bool:
    """True when the CUDA runtime can actually be loaded by CTranslate2."""
    global _runtime_cache
    now = time.monotonic()
    with _probe_lock:
        if _runtime_cache is not None and now - _runtime_cache[0] < PROBE_TTL:
            return _runtime_cache[1]
    ready = _probe_cuda_runtime()
    with _probe_lock:
        _runtime_cache = (now, ready)
    if not ready:
        logger.debug("CUDA runtime probe: not usable on this machine")
    return ready


# --------------------------------------------------------------------------- #
# /health acceleration report
# --------------------------------------------------------------------------- #
def _encoding_available() -> bool:
    """Whether FFmpeg can use the hardware encoder on this machine."""
    try:
        # Local import: accel must stay importable before the services package.
        from services import renderer

        return bool(renderer.nvenc_available())
    except Exception:  # pragma: no cover - defensive
        return False


def acceleration_report() -> dict[str, Any]:
    """The additive ``/health.acceleration`` block.

    ``reason`` is ``None`` when GPU transcription is ready, otherwise one of
    ``no-nvidia-gpu`` (no GPU detected), ``cuda-runtime-missing`` (GPU present
    but no acceleration pack) or ``cuda-runtime-unusable`` (pack present but the
    runtime cannot load).
    """
    gpu = nvidia_gpu_info()
    runtime = cuda_runtime_ready()
    gpu_detected = gpu is not None
    pack_installed = bool(config.accel_dir())
    transcription_gpu = gpu_detected and runtime

    if transcription_gpu:
        reason: str | None = None
    elif not gpu_detected:
        reason = "no-nvidia-gpu"
    elif not pack_installed:
        reason = "cuda-runtime-missing"
    else:
        reason = "cuda-runtime-unusable"

    return {
        "transcription": "gpu" if transcription_gpu else "cpu",
        "encoding": "gpu" if _encoding_available() else "cpu",
        "gpu_detected": gpu_detected,
        "gpu_name": gpu.get("name") if gpu else None,
        "cuda_runtime": runtime,
        "pack_installed": pack_installed,
        "reason": reason,
    }


def clear_cache() -> None:
    """Drop cached probe results (tests, or right after installing the pack)."""
    global _gpu_cache, _runtime_cache
    with _probe_lock:
        _gpu_cache = None
        _runtime_cache = None
