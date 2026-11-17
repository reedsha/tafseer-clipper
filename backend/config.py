"""Runtime configuration for the Tafseer Clipper FastAPI sidecar.

The sidecar is stateless: the frontend sends per-request overrides and the
defaults below come from the environment (set by Tauri when it spawns
``backend.exe``).  Nothing here talks to the network or the GPU; probing is
done by :mod:`services.transcriber` and :mod:`services.renderer`.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

APP_NAME = "Tafseer Clipper Sidecar"
APP_VERSION = "0.1.1-beta"  # x-release-please-version

#: Rotating log file name inside :func:`log_dir`.
LOG_FILE_NAME = "sidecar.log"

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent

#: Read-only resources bundled by PyInstaller.  In a frozen onefile build this
#: is the ephemeral ``%TEMP%\\_MEIxxxxxx`` extraction directory, so it must never
#: hold files that have to survive the process (imported fonts, work files).
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", BACKEND_DIR))


# --------------------------------------------------------------------------- #
# Environment helpers
# --------------------------------------------------------------------------- #
def env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def env_opt(name: str) -> str | None:
    value = os.environ.get(name)
    return value or None


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    try:
        return int(env_str(name, str(default)))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(env_str(name, str(default)))
    except ValueError:
        return default


# --------------------------------------------------------------------------- #
# Directories
# --------------------------------------------------------------------------- #
def is_frozen() -> bool:
    """True when running from the PyInstaller-built ``backend.exe``."""
    return bool(getattr(sys, "frozen", False))


def user_data_dir() -> Path:
    """Persistent, user-writable data root for the packaged application.

    A frozen sidecar cannot write next to its own executable (Program Files) or
    inside ``sys._MEIPASS`` (deleted on exit), so imported fonts and work files
    live under ``%LOCALAPPDATA%\\Tafseer Clipper``.  A source checkout keeps the
    historical ``backend/`` layout so ``python backend/main.py`` and
    ``backend/test_phase1_e2e.py`` behave exactly as before.

    ``TAFSEER_DATA_DIR`` relocates the whole data root explicitly.
    """
    override = env_opt("TAFSEER_DATA_DIR")
    if override:
        return Path(override)
    if is_frozen():
        local_appdata = os.environ.get("LOCALAPPDATA")
        base = Path(local_appdata) if local_appdata else Path.home() / "AppData" / "Local"
        return base / "Tafseer Clipper"
    return BACKEND_DIR


def fonts_dir() -> Path:
    """Local directory holding user-imported ``.ttf``/``.otf`` fonts.

    FFmpeg's ``ass`` filter receives this path as ``fontsdir`` so imported
    Thai/Arabic fonts resolve exactly as they do in the React preview.
    """
    override = env_opt("TAFSEER_FONTS_DIR")
    path = Path(override) if override else user_data_dir() / "fonts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def log_dir() -> Path:
    """Directory for the rotating sidecar log files.

    ``backend/logs`` in a source checkout, ``%LOCALAPPDATA%\\Tafseer Clipper\\logs``
    when frozen, so field support can read ``sidecar.log`` after a crash.
    ``TAFSEER_LOG_DIR`` relocates it explicitly.  Unlike :func:`fonts_dir` this
    helper does not create the directory: :func:`main._setup_logging` must be
    able to fall back to console-only logging when it is unwritable.
    """
    override = env_opt("TAFSEER_LOG_DIR")
    return Path(override) if override else user_data_dir() / "logs"


def work_dir() -> Path:
    """Scratch space for extracted WAVs, generated ``.ass`` files and renders."""
    override = env_opt("TAFSEER_WORK_DIR")
    if override:
        path = Path(override)
    elif env_opt("TAFSEER_DATA_DIR") or is_frozen():
        path = user_data_dir() / "work"
    else:
        path = Path(tempfile.gettempdir()) / "tafseer-clipper"
    path.mkdir(parents=True, exist_ok=True)
    return path


def accel_dir() -> Path | None:
    """Directory of the optional GPU acceleration pack (CUDA runtime DLLs).

    The Tauri shell downloads and verifies the pack, then passes its absolute
    path as ``TAFSEER_CUDA_DIR`` (``TAFSEER_ACCEL_DIR`` is accepted as an
    alias).  :mod:`services.accel` registers it for DLL loading before the AI
    stack is imported; when it is unset the sidecar simply runs on the CPU.
    """
    raw = env_opt("TAFSEER_CUDA_DIR") or env_opt("TAFSEER_ACCEL_DIR")
    return Path(raw) if raw else None


# --------------------------------------------------------------------------- #
# FFmpeg / FFprobe resolution
# --------------------------------------------------------------------------- #
def _executable_names(name: str) -> list[str]:
    """File names a bundled ``ffmpeg``/``ffprobe`` can carry.

    Tauri's ``externalBin`` staging keeps the Rust target-triple suffix
    (``ffmpeg-x86_64-pc-windows-msvc.exe``); the installed application strips it
    next to the main executable (``ffmpeg.exe``).  Both layouts are accepted.
    """
    if sys.platform != "win32":
        return [name]
    return [f"{name}.exe", f"{name}-x86_64-pc-windows-msvc.exe"]


def _candidate_ffmpeg_paths(name: str) -> list[Path]:
    candidates: list[Path] = []

    # 1. Explicit override (highest priority, used by tests and advanced users).
    override = env_opt(f"TAFSEER_{name.upper()}")
    if override:
        candidates.append(Path(override))

    names = _executable_names(name)

    # 2. Bundled binary shipped next to backend.exe by the Tauri installer.
    executable = sys.executable
    executable_dir = Path(executable).resolve().parent if executable else BACKEND_DIR
    candidates.extend(executable_dir / exe for exe in names)

    # 3. Read-only resources: the onefile ``_MEIPASS`` dir and, for an onedir
    #    build, the sidecar folder itself (``BACKEND_DIR`` in a source checkout).
    resource_dirs = [RESOURCE_DIR]
    if RESOURCE_DIR != BACKEND_DIR:
        resource_dirs.append(BACKEND_DIR)
    for directory in resource_dirs:
        candidates.extend(directory / exe for exe in names)
        candidates.extend(directory / "bin" / exe for exe in names)

    # 4. Repository layout used by a source checkout and by ``tauri build``.
    candidates.extend(REPO_ROOT / "src-tauri" / "binaries" / exe for exe in names)

    # 5. Whatever is on PATH (developer machines).
    on_path = shutil.which(name)
    if on_path:
        candidates.append(Path(on_path))

    unique: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


@lru_cache(maxsize=1)
def ffmpeg_path() -> str | None:
    for candidate in _candidate_ffmpeg_paths("ffmpeg"):
        if candidate.is_file():
            return str(candidate)
    return None


@lru_cache(maxsize=1)
def ffprobe_path() -> str | None:
    for candidate in _candidate_ffmpeg_paths("ffprobe"):
        if candidate.is_file():
            return str(candidate)
    # A bundled ffmpeg.exe is always shipped with ffprobe.exe next to it.
    ffmpeg = ffmpeg_path()
    if ffmpeg:
        sibling = Path(ffmpeg).with_name(
            "ffprobe.exe" if sys.platform == "win32" else "ffprobe"
        )
        if sibling.is_file():
            return str(sibling)
    return None


def clear_path_cache() -> None:
    """Drop cached binary lookups (tests set ``TAFSEER_FFMPEG`` at runtime)."""
    ffmpeg_path.cache_clear()
    ffprobe_path.cache_clear()


# --------------------------------------------------------------------------- #
# Subprocess watchdogs
# --------------------------------------------------------------------------- #
def render_clip_timeout() -> float:
    """Wall-clock cap for one clip encode (a hung FFmpeg must not block SSE)."""
    return env_float("TAFSEER_RENDER_TIMEOUT", 1800.0)


def extract_audio_timeout() -> float:
    """Wall-clock cap for the 16 kHz WAV extraction of one lecture."""
    return env_float("TAFSEER_EXTRACT_TIMEOUT", 1800.0)


# --------------------------------------------------------------------------- #
# Whisper defaults
# --------------------------------------------------------------------------- #
def whisper_model_default() -> str:
    return env_str("TAFSEER_WHISPER_MODEL", "large-v3-turbo")


def whisper_device_default() -> str:
    return env_str("TAFSEER_WHISPER_DEVICE", "auto")


def whisper_compute_default() -> str:
    # ``int8`` keeps memory use low and is supported on both CPU and GPU.
    return env_str("TAFSEER_WHISPER_COMPUTE", "int8")


def whisper_auto_unload_default() -> bool:
    return env_bool("TAFSEER_WHISPER_AUTO_UNLOAD", True)


# --------------------------------------------------------------------------- #
# LLM defaults (OpenAI-compatible endpoint: cloud API or local Ollama)
# --------------------------------------------------------------------------- #
def llm_base_url() -> str:
    return env_str("TAFSEER_LLM_BASE_URL", "http://localhost:11434/v1")


def llm_api_key() -> str | None:
    return env_opt("TAFSEER_LLM_API_KEY")


def llm_reasoning_model() -> str:
    return env_str("TAFSEER_REASONING_MODEL", "")


def llm_fast_model() -> str:
    return env_str("TAFSEER_FAST_MODEL", "")


def llm_timeout() -> float:
    return env_float("TAFSEER_LLM_TIMEOUT", 120.0)


# --------------------------------------------------------------------------- #
# Decision-model defaults (optional System One tier)
# --------------------------------------------------------------------------- #
#: No model is configured by default: the decision tier is opt-in and every
#: caller must behave exactly like today when it is absent.
def decision_model() -> str:
    return env_str("TAFSEER_DECISION_MODEL", "")


def decision_base_url() -> str:
    """Decision service address; follows the main AI connection by default."""
    return env_str("TAFSEER_DECISION_BASE_URL", llm_base_url())


def decision_api_key() -> str | None:
    raw = os.environ.get("TAFSEER_DECISION_API_KEY")
    return raw if raw else llm_api_key()


def decision_endpoint_style() -> str:
    """Wire format (``systemone``, ``decisions`` or ``auto`` to measure once)."""
    return env_str("TAFSEER_DECISION_ENDPOINT_STYLE", "auto")


def decision_timeout() -> float:
    return env_float("TAFSEER_DECISION_TIMEOUT", 45.0)


# --------------------------------------------------------------------------- #
# Server binding
# --------------------------------------------------------------------------- #
def host() -> str:
    # localhost only: the sidecar is never exposed to the LAN.
    return env_str("TAFSEER_HOST", "127.0.0.1")


def port() -> int:
    return env_int("TAFSEER_PORT", 8008)
