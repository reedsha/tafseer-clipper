"""Frozen-sidecar smoke test for the packaged ``backend.exe`` (Phase 4).

Run from the repository root after building the onedir sidecar::

    .build-venv\\Scripts\\pyinstaller.exe --noconfirm --clean --distpath build/sidecar backend/build_sidecar.spec
    py -3.12 backend/smoke_frozen.py

What it proves against the *real* PyInstaller build (not a source run):

1. ``build/sidecar/backend/backend.exe`` cold-starts and ``GET /health``
   reports ``ok`` (the measured cold-start seconds are printed).
2. Frozen directories resolve under ``%LOCALAPPDATA%\\Tafseer Clipper`` - never
   the read-only ``_internal`` resource folder and never Program Files.
3. ``POST /fonts/import`` (multipart) persists the uploaded font under that user
   fonts dir and reports its family.
4. ``POST /render-batch`` streams SSE (start/progress/clip_done/done) and writes
   a real 1080x1920 H.264 MP4 plus its ``.srt`` sidecar for a 3 s clip of
   ``backend/.e2e/source_16x9.mp4`` with per-style overrides.
5. The rotating log file ``%LOCALAPPDATA%\\Tafseer Clipper\\logs\\sidecar.log``
   exists and carries the startup/render/access lines (``TAFSEER_LOG_LEVEL``
   honoured).
6. The 400/404/422/503 error contracts still hold in the frozen build (missing
   source, unknown transcript, invalid range, missing ffmpeg).
7. ``terminate`` stops the sidecar and leaves no orphan ``ffmpeg.exe`` behind.

Exit code 0 means every check passed.  Temporary render/staging dirs are
removed; the log file is deliberately kept - it is the support artifact this
test exists to verify.

Sandboxed-session note: the onedir build starts in place without unpacking to
``%TEMP%``, so nothing is written outside the user-data dirs it is given.  Pass
``--exe`` to test a copy installed elsewhere; the checks are identical.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
DEFAULT_EXE = REPO_ROOT / "build" / "sidecar" / "backend" / "backend.exe"
SOURCE_VIDEO = BACKEND_DIR / ".e2e" / "source_16x9.mp4"
FONT_CANDIDATES = [
    BACKEND_DIR / ".e2e" / "fonts" / "tahoma.ttf",
    BACKEND_DIR / ".e2e" / "fonts" / "LeelawUI.ttf",
]
SYSTEM_FONTS = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"

THAI_TEXT = "ฟังตัฟซีร: ซูเราะฮ์อัลฟาติฮะฮ์ (บทเรียนที่ 1)"
ARABIC_TEXT = "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ"

#: First start after install can be slow while Windows scans the onedir files.
READY_TIMEOUT = 90.0
#: A sidecar that needs longer than this to answer /health is a regression.
COLD_START_BUDGET = 60.0

RESULTS: list[tuple[str, bool, str]] = []

#: Exact /health contract (``main.HealthResponse``) - release must not change it.
HEALTH_KEYS = {
    "status",
    "version",
    "cuda_available",
    "nvenc_available",
    "vram_mb",
    "ffmpeg_available",
    "ffmpeg_path",
    "ffprobe_available",
    "fonts_dir",
    "work_dir",
    "disk_cache_bytes",
    "whisper",
    "acceleration",
}
WHISPER_KEYS = {"model", "loaded", "device", "compute_type"}
#: Additive GPU/CPU state block; ``reason`` explains a CPU fallback.
ACCELERATION_KEYS = {
    "transcription",
    "encoding",
    "gpu_detected",
    "gpu_name",
    "cuda_runtime",
    "pack_installed",
    "reason",
}
ACCELERATION_REASONS = {None, "no-nvidia-gpu", "cuda-runtime-missing", "cuda-runtime-unusable"}


# --------------------------------------------------------------------------- #
# Harness helpers
# --------------------------------------------------------------------------- #
def check(name: str, condition: bool, detail: str = "") -> bool:
    RESULTS.append((name, bool(condition), detail))
    line = f"[{'PASS' if condition else 'FAIL'}] {name}"
    if detail:
        line += f" - {detail}"
    print(line, flush=True)
    return bool(condition)


def info(message: str) -> None:
    print(f"[INFO] {message}", flush=True)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def user_data_root() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise SystemExit("FATAL: LOCALAPPDATA is not set; this is the Windows build.")
    return Path(local) / "Tafseer Clipper"


def resolve_exe(raw: str | None) -> Path:
    exe = Path(raw).expanduser().resolve() if raw else DEFAULT_EXE
    if not exe.is_file():
        raise SystemExit(
            f"FATAL: {exe} does not exist. Build it first with\n"
            "  .build-venv\\Scripts\\pyinstaller.exe --noconfirm --clean backend/build_sidecar.spec"
        )
    return exe


def resolve_ffmpeg() -> tuple[Path, Path]:
    hint = (
        Path(os.environ.get("LOCALAPPDATA", ""))
        / "tafseer-clipper-tools"
        / "ffmpeg"
        / "bin"
    )
    pairs = [
        (hint / "ffmpeg.exe", hint / "ffprobe.exe"),
        (
            REPO_ROOT / "src-tauri" / "binaries" / "ffmpeg-x86_64-pc-windows-msvc.exe",
            REPO_ROOT / "src-tauri" / "binaries" / "ffprobe-x86_64-pc-windows-msvc.exe",
        ),
    ]
    on_path_ffmpeg, on_path_ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if on_path_ffmpeg and on_path_ffprobe:
        pairs.append((Path(on_path_ffmpeg), Path(on_path_ffprobe)))
    for ffmpeg, ffprobe in pairs:
        if ffmpeg.is_file() and ffprobe.is_file():
            return ffmpeg, ffprobe
    raise SystemExit(
        "FATAL: ffmpeg.exe/ffprobe.exe not found. Install the tools to\n"
        f"  {hint}\n"
        "or put them in src-tauri/binaries/, or set them on PATH."
    )


def resolve_font() -> Path:
    for candidate in FONT_CANDIDATES:
        if candidate.is_file():
            return candidate
    for name in ("tahoma.ttf", "arial.ttf", "leelawui.ttf", "segoeui.ttf"):
        candidate = SYSTEM_FONTS / name
        if candidate.is_file():
            return candidate
    raise SystemExit("FATAL: no .ttf font found for the /fonts/import check.")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ffmpeg_pids() -> set[int]:
    """PIDs of running ffmpeg.exe processes (empty when tasklist is unavailable)."""
    if sys.platform != "win32":
        return set()
    try:
        completed = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq ffmpeg.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    pids: set[int] = set()
    for line in (completed.stdout or "").splitlines():
        parts = [part.strip().strip('"') for part in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == "ffmpeg.exe":
            try:
                pids.add(int(parts[1]))
            except ValueError:
                continue
    return pids


def probe(path: Path, ffprobe: Path) -> dict:
    completed = subprocess.run(
        [
            str(ffprobe),
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {completed.stderr[-800:]}")
    return json.loads(completed.stdout)


def stream_sse(client: httpx.Client, url: str, payload: dict) -> list[dict]:
    """Collect SSE events (same parser shape as backend/test_phase1_e2e.py)."""
    events: list[dict] = []
    with client.stream("POST", url, json=payload, timeout=None) as response:
        response.raise_for_status()
        event_name = "message"
        for line in response.iter_lines():
            line = line.rstrip("\r")
            if not line:
                event_name = "message"
                continue
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data = json.loads(line[5:].strip())
                data["_event"] = event_name
                events.append(data)
    return events


# --------------------------------------------------------------------------- #
# Sidecar process
# --------------------------------------------------------------------------- #
class Sidecar:
    def __init__(self, exe: Path, env: dict[str, str], port: int) -> None:
        self.exe = exe
        self.env = env
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.process: subprocess.Popen[str] | None = None
        self.console: list[str] = []
        self.cold_start: float | None = None
        self._pump_thread: threading.Thread | None = None

    # -- lifecycle --------------------------------------------------------- #
    def start(self) -> Sidecar:
        started = time.perf_counter()
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        )
        self.process = subprocess.Popen(
            [str(self.exe)],
            cwd=str(self.exe.parent),
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
        self._pump_thread = threading.Thread(target=self._pump, daemon=True)
        self._pump_thread.start()

        deadline = time.perf_counter() + READY_TIMEOUT
        while time.perf_counter() < deadline:
            if self.process.poll() is not None:
                break
            try:
                response = httpx.get(f"{self.url}/health", timeout=2.0)
                if response.status_code == 200:
                    self.cold_start = time.perf_counter() - started
                    return self
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
        self.stop()
        raise RuntimeError(
            f"backend.exe did not become healthy within {READY_TIMEOUT:.0f}s:\n"
            + "\n".join(self.console[-40:])
        )

    def stop(self) -> str:
        """Stop the sidecar; returns the shutdown mode that actually worked.

        A console CTRL_BREAK first (uvicorn's graceful path, which runs the
        FastAPI lifespan shutdown hook), falling back to ``terminate`` - the
        method Tauri uses when the window closes on Windows.
        """
        mode = self._stop_process()
        if self._pump_thread is not None:
            self._pump_thread.join(timeout=5)
        return mode

    def _stop_process(self) -> str:
        process = self.process
        if process is None:
            return "not-started"
        if process.poll() is not None:
            return "already-exited"
        if sys.platform == "win32":
            try:
                process.send_signal(signal.CTRL_BREAK_EVENT)
            except (OSError, ValueError):
                pass
            else:
                try:
                    process.wait(timeout=15)
                    return "ctrl-break"
                except subprocess.TimeoutExpired:
                    pass
        process.terminate()
        try:
            process.wait(timeout=10)
            return "terminate"
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            return "kill"

    def _pump(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            self.console.append(line.rstrip())

    def __enter__(self) -> Sidecar:
        return self.start()

    def __exit__(self, *_exc) -> None:
        self.stop()


# --------------------------------------------------------------------------- #
# Checks against the running frozen sidecar
# --------------------------------------------------------------------------- #
def check_frozen_dirs(health: dict, root: Path) -> None:
    fonts_dir = Path(str(health.get("fonts_dir", "")))
    work_dir = Path(str(health.get("work_dir", "")))
    for label, directory in (("fonts_dir", fonts_dir), ("work_dir", work_dir)):
        text = str(directory)
        check(
            f"Frozen {label} under %LOCALAPPDATA%\\Tafseer Clipper",
            directory.is_dir()
            and text.lower().startswith(str(root).lower())
            and "_mei" not in text.lower()
            and "program files" not in text.lower(),
            text,
        )
    check(
        "Frozen dirs differ from the read-only resource folder",
        "_MEI" not in str(fonts_dir) and "_MEI" not in str(work_dir),
        f"fonts={fonts_dir}",
    )


def check_fonts_import(
    client: httpx.Client, font: Path, root: Path, temp_root: Path
) -> Path | None:
    upload = temp_root / f"smoke_{os.getpid()}_{font.name}"
    shutil.copyfile(font, upload)
    with upload.open("rb") as handle:
        response = client.post(
            "/fonts/import",
            files=[("files", (upload.name, handle, "font/ttf"))],
        )
    payload = response.json() if response.status_code == 200 else {}
    fonts = payload.get("fonts") or []
    check(
        "POST /fonts/import (multipart): 200 + family reported",
        response.status_code == 200 and bool(payload.get("imported_fonts")),
        f"{response.status_code} families={payload.get('imported_fonts')}",
    )
    imported = Path(str(fonts[0]["path"])) if fonts else None
    check(
        "POST /fonts/import: file persisted in the user fonts dir",
        imported is not None
        and imported.is_file()
        and imported.parent.resolve() == (root / "fonts").resolve()
        and sha256(imported) == sha256(upload),
        str(imported),
    )
    check(
        "POST /fonts/import: response fonts_dir == frozen user fonts dir",
        str(payload.get("fonts_dir", "")).lower() == str(root / "fonts").lower(),
        str(payload.get("fonts_dir")),
    )
    return imported


def check_render_batch(
    client: httpx.Client,
    source: Path,
    output_dir: Path,
    work_dir: Path,
    ffprobe: Path,
) -> str:
    batch = {
        "project_name": "frozen-smoke",
        "source_path": str(source),
        "resolution": "1080x1920",
        "framing": "blur-fill",
        "use_nvenc": True,
        "export_srt": True,
        "output_dir": str(output_dir),
        "filename_template": "{LectureName}_Clip{01}_{Title}.mp4",
        "subtitle_timebase": "clip",
        "styles": {
            "arabic": {"color": "#FFD37A", "size": 66},
            "thai": {"color": "#FFFFFF", "size": 46},
        },
        "clips": [
            {
                "start": 0.0,
                "end": 3.0,
                "title": "frozen smoke",
                "subtitles": [
                    {
                        "start": 0.2,
                        "end": 1.4,
                        "arabic": ARABIC_TEXT,
                        "thai": THAI_TEXT,
                    },
                    {"start": 1.6, "end": 2.8, "thai": THAI_TEXT},
                ],
            }
        ],
    }
    events = stream_sse(client, "/render-batch", batch)
    names = [event["_event"] for event in events]
    done = next((event for event in events if event["_event"] == "done"), {})
    start_event = next((event for event in events if event["_event"] == "start"), {})
    check(
        "POST /render-batch: SSE start/progress/clip_done/done sequence",
        "start" in names
        and names.count("progress") >= 1
        and "clip_done" in names
        and "done" in names,
        f"events={len(events)} names={sorted(set(names))}",
    )
    check(
        "POST /render-batch: batch completed without failures",
        done.get("status") == "completed"
        and done.get("failed_clips") == 0
        and done.get("rendered_clips") == 1,
        f"status={done.get('status')} rendered={done.get('rendered_clips')} "
        f"failed={done.get('failed_clips')}",
    )

    mp4s = sorted(output_dir.glob("*.mp4"))
    mp4 = mp4s[0] if mp4s else None
    check(
        "POST /render-batch: MP4 written (3 s clip)",
        mp4 is not None and mp4.stat().st_size > 20_000,
        f"{mp4.name} ({mp4.stat().st_size // 1024} KiB)" if mp4 else "missing",
    )

    if mp4 is not None:
        media = probe(mp4, ffprobe)
        video = next(
            (s for s in media["streams"] if s.get("codec_type") == "video"), {}
        )
        audio = next(
            (s for s in media["streams"] if s.get("codec_type") == "audio"), None
        )
        duration = float(media["format"].get("duration", 0.0))
        check(
            "Rendered MP4: 1080x1920 H.264 with audio",
            video.get("width") == 1080
            and video.get("height") == 1920
            and video.get("codec_name") == "h264"
            and audio is not None,
            f"{video.get('width')}x{video.get('height')} {video.get('codec_name')} "
            f"audio={'yes' if audio else 'no'}",
        )
        check(
            "Rendered MP4: ~3 s duration",
            2.4 <= duration <= 3.8,
            f"{duration:.2f}s",
        )

        srt = mp4.with_suffix(".srt")
        srt_text = srt.read_text(encoding="utf-8") if srt.is_file() else ""
        check(
            "Rendered .srt sidecar next to the MP4",
            srt.is_file()
            and "-->" in srt_text
            and ARABIC_TEXT in srt_text
            and THAI_TEXT in srt_text,
            srt.name if srt.is_file() else "missing",
        )

    ass_path = str((start_event.get("clips") or [{}])[0].get("ass_path", ""))
    ass_file = Path(ass_path) if ass_path else None
    ass_text = ass_file.read_text(encoding="utf-8") if ass_file and ass_file.is_file() else ""
    check(
        "Generated .ass lives in the frozen work dir and carries both styles",
        ass_file is not None
        and ass_file.is_file()
        and str(ass_file).lower().startswith(str(work_dir).lower())
        and "PlayResX: 1080" in ass_text
        and "Style: ArabicStyle," in ass_text
        and "Style: ThaiStyle," in ass_text,
        f"{ass_file.name if ass_file else 'missing'}",
    )
    return str(start_event.get("job_id", ""))


def check_error_contracts(
    client: httpx.Client, source: Path, missing_source: Path
) -> None:
    bad_transcribe = client.post(
        "/extract-and-transcribe", json={"file_path": str(missing_source)}
    )
    check(
        "POST /extract-and-transcribe: missing file -> 400",
        bad_transcribe.status_code == 400,
        f"{bad_transcribe.status_code}",
    )
    no_source = client.post(
        "/render-batch", json={"clips": [{"start": 0.0, "end": 2.0}]}
    )
    check(
        "POST /render-batch: missing source_path/transcript_id -> 400",
        no_source.status_code == 400,
        f"{no_source.status_code}",
    )
    invalid_range = client.post(
        "/render-batch",
        json={"clips": [{"start": 1.0, "end": 0.5}], "source_path": str(source)},
    )
    check(
        "POST /render-batch: invalid clip range -> 422",
        invalid_range.status_code == 422,
        f"{invalid_range.status_code}",
    )
    unknown = client.post(
        "/discover-clips", json={"transcript_id": "0123456789abcdef0123456789abcdef"}
    )
    check(
        "POST /discover-clips: unknown transcript -> 404",
        unknown.status_code == 404,
        f"{unknown.status_code}",
    )


def check_missing_ffmpeg(exe: Path) -> None:
    """Second cold start without ffmpeg: the frozen 503 contract must hold."""
    port = free_port()
    env = os.environ.copy()
    env.update(
        {
            "TAFSEER_PORT": str(port),
            "TAFSEER_HOST": "127.0.0.1",
            "TAFSEER_LOG_LEVEL": "INFO",
            # No TAFSEER_FFMPEG/TAFSEER_FFPROBE, minimal PATH, and no bundled
            # copy in the sidecar folder or its parent -> ffmpeg must be missing.
            "PATH": r"C:\Windows\System32;C:\Windows",
        }
    )
    env.pop("TAFSEER_FFMPEG", None)
    env.pop("TAFSEER_FFPROBE", None)
    with Sidecar(exe, env, port) as sidecar:
        info(f"503-contract instance cold start: {sidecar.cold_start:.2f}s")
        with httpx.Client(base_url=sidecar.url, timeout=60.0) as client:
            health = client.get("/health").json()
            check(
                "No-ffmpeg instance: /health ok with ffmpeg_available=false",
                health.get("status") == "ok"
                and health.get("ffmpeg_available") is False,
                f"ffmpeg_available={health.get('ffmpeg_available')}",
            )
            render = client.post(
                "/render-batch",
                json={
                    "clips": [{"start": 0.0, "end": 2.0}],
                    "source_path": str(SOURCE_VIDEO),
                },
            )
            check(
                "POST /render-batch without ffmpeg -> 503",
                render.status_code == 503,
                f"{render.status_code} {render.text[:100]}",
            )
            extract = client.post(
                "/extract-and-transcribe", json={"file_path": str(SOURCE_VIDEO)}
            )
            check(
                "POST /extract-and-transcribe without ffmpeg -> 503",
                extract.status_code == 503,
                f"{extract.status_code} {extract.text[:100]}",
            )
        mode = sidecar.stop()
        info(f"503-contract instance shutdown: {mode}")


def check_log_fallback(exe: Path, temp_root: Path) -> None:
    """Third cold start with an unwritable log dir: console-only fallback."""
    blocker = temp_root / "blocked-log-dir"
    blocker.write_text("not a directory", encoding="utf-8")
    port = free_port()
    env = os.environ.copy()
    for override in (
        "TAFSEER_DATA_DIR",
        "TAFSEER_FONTS_DIR",
        "TAFSEER_WORK_DIR",
        "TAFSEER_LOG_DIR",
    ):
        env.pop(override, None)
    env.update(
        {
            "TAFSEER_PORT": str(port),
            "TAFSEER_HOST": "127.0.0.1",
            # blocker is a *file*, so mkdir(parents=True) for "<blocker>/logs"
            # must fail and the sidecar must fall back to console logging.
            "TAFSEER_LOG_DIR": str(blocker / "logs"),
        }
    )
    with Sidecar(exe, env, port) as sidecar:
        info(f"log-fallback instance cold start: {sidecar.cold_start:.2f}s")
        with httpx.Client(base_url=sidecar.url, timeout=60.0) as client:
            health = client.get("/health").json()
            check(
                "Unwritable log dir: sidecar still starts and /health is ok",
                health.get("status") == "ok",
                f"status={health.get('status')}",
            )
        console = "\n".join(sidecar.console)
        check(
            "Unwritable log dir: console-only fallback warning emitted",
            "File logging disabled" in console,
            next(
                (line for line in sidecar.console if "File logging disabled" in line),
                "warning missing",
            ),
        )
        info(f"log-fallback instance shutdown: {sidecar.stop()}")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--exe",
        default=None,
        help="Path to the frozen backend.exe (default: build/sidecar/backend/backend.exe).",
    )
    args = parser.parse_args(argv)

    if sys.platform != "win32":
        raise SystemExit("FATAL: the frozen sidecar is a Windows executable.")

    exe = resolve_exe(args.exe)
    ffmpeg, ffprobe = resolve_ffmpeg()
    font = resolve_font()
    root = user_data_root()
    log_file = root / "logs" / "sidecar.log"
    work_dir = root / "work"

    info(f"exe     : {exe} ({exe.stat().st_size / 1048576:.1f} MB, sha256 {sha256(exe)[:16]})")
    info(f"ffmpeg  : {ffmpeg}")
    info(f"ffprobe : {ffprobe}")
    info(f"font    : {font}")
    info(f"user data root: {root}")
    if not SOURCE_VIDEO.is_file():
        raise SystemExit(f"FATAL: fixture missing: {SOURCE_VIDEO}")

    temp_root = Path(tempfile.mkdtemp(prefix="tafseer-frozen-smoke-"))
    renders = temp_root / "renders"
    renders.mkdir(parents=True, exist_ok=True)
    imported_font: Path | None = None
    job_dir: Path | None = None
    pids_before = ffmpeg_pids()
    sidecar: Sidecar | None = None
    mode = "not-started"
    try:
        port = free_port()
        env = os.environ.copy()
        # This test exists to prove the *frozen defaults*; a developer shell that
        # exports these would silently weaken it.
        for override in (
            "TAFSEER_DATA_DIR",
            "TAFSEER_FONTS_DIR",
            "TAFSEER_WORK_DIR",
            "TAFSEER_LOG_DIR",
        ):
            env.pop(override, None)
        env.update(
            {
                "TAFSEER_PORT": str(port),
                "TAFSEER_HOST": "127.0.0.1",
                "TAFSEER_FFMPEG": str(ffmpeg),
                "TAFSEER_FFPROBE": str(ffprobe),
                "TAFSEER_LOG_LEVEL": "DEBUG",
            }
        )
        sidecar = Sidecar(exe, env, port)
        sidecar.start()
        info(f"cold start: {sidecar.cold_start:.2f}s on {sidecar.url}")
        check(
            "backend.exe cold start answers /health within budget",
            sidecar.cold_start is not None
            and sidecar.cold_start <= COLD_START_BUDGET,
            f"{sidecar.cold_start:.2f}s (budget {COLD_START_BUDGET:.0f}s)",
        )

        with httpx.Client(base_url=sidecar.url, timeout=180.0) as client:
            response = client.get("/health")
            health = response.json()
            check(
                "GET /health: 200, status=ok, ffmpeg available",
                response.status_code == 200
                and health.get("status") == "ok"
                and health.get("ffmpeg_available") is True
                and isinstance(health.get("whisper"), dict)
                and health["whisper"].get("compute_type") == "int8",
                f"cuda={health.get('cuda_available')} nvenc={health.get('nvenc_available')} "
                f"ffmpeg={health.get('ffmpeg_path')}",
            )
            check_frozen_dirs(health, root)
            check(
                "GET /health: response shape unchanged (13 fields + whisper/acceleration blocks)",
                set(health) == HEALTH_KEYS
                and isinstance(health.get("whisper"), dict)
                and set(health["whisper"]) == WHISPER_KEYS
                and isinstance(health.get("acceleration"), dict)
                and set(health["acceleration"]) == ACCELERATION_KEYS,
                f"keys={sorted(set(health))}",
            )
            acceleration = health.get("acceleration") or {}
            check(
                "GET /health: acceleration contract (CPU fallback unless the runtime is ready)",
                acceleration.get("transcription") in {"gpu", "cpu"}
                and acceleration.get("encoding") in {"gpu", "cpu"}
                and isinstance(acceleration.get("gpu_detected"), bool)
                and (
                    acceleration.get("gpu_name") is None
                    or isinstance(acceleration.get("gpu_name"), str)
                )
                and isinstance(acceleration.get("cuda_runtime"), bool)
                and isinstance(acceleration.get("pack_installed"), bool)
                and acceleration.get("reason") in ACCELERATION_REASONS
                # gpu <-> no reason, cpu <-> a machine-readable reason.
                and (
                    (
                        acceleration.get("transcription") == "gpu"
                        and acceleration.get("reason") is None
                    )
                    or (
                        acceleration.get("transcription") == "cpu"
                        and acceleration.get("reason") is not None
                    )
                )
                # Without a usable CUDA runtime the sidecar must report CPU.
                and (
                    acceleration.get("cuda_runtime")
                    or acceleration.get("transcription") == "cpu"
                )
                # A detected GPU without a pack is actionable, not "no GPU".
                and (
                    acceleration.get("gpu_detected")
                    or (
                        acceleration.get("transcription") == "cpu"
                        and acceleration.get("reason") == "no-nvidia-gpu"
                    )
                ),
                f"acceleration={acceleration}",
            )
            imported_font = check_fonts_import(client, font, root, temp_root)
            job_id = check_render_batch(client, SOURCE_VIDEO, renders, work_dir, ffprobe)
            check_error_contracts(client, SOURCE_VIDEO, temp_root / "nope.mp4")

        # The SSE start event carries the job id; remember its work folder so the
        # smoke test removes exactly the job folder it created.
        if re.fullmatch(r"[0-9a-f]{32}", job_id):
            candidate = work_dir / "jobs" / job_id
            if candidate.is_dir():
                job_dir = candidate

        mode = sidecar.stop()
        check(
            "Shutdown: backend.exe exited",
            sidecar.process is not None and sidecar.process.poll() is not None,
            f"mode={mode} exit={sidecar.process.returncode if sidecar.process else 'n/a'}",
        )
        if mode == "ctrl-break":
            info("Shutdown: graceful CTRL_BREAK (uvicorn lifespan shutdown ran)")
        else:
            info(f"Shutdown: {mode} (Windows TerminateProcess; lifespan hook not run)")

        # -- log file ----------------------------------------------------- #
        log_text = log_file.read_text(encoding="utf-8", errors="replace") if log_file.is_file() else ""
        check(
            "Rotating log file exists in %LOCALAPPDATA%\\Tafseer Clipper\\logs",
            log_file.is_file(),
            str(log_file),
        )
        check(
            "Log carries startup + frozen paths + DEBUG level",
            "Logging to" in log_text
            and "Sidecar paths:" in log_text
            and "frozen=True" in log_text
            and "(level=DEBUG)" in log_text
            and str(root) in log_text,
            f"{log_file.stat().st_size if log_file.is_file() else 0} bytes",
        )
        check(
            "Log carries the font import and render-batch access lines",
            "POST /fonts/import" in log_text and "POST /render-batch" in log_text,
            "uvicorn access lines present",
        )
        if mode == "ctrl-break":
            check(
                "Log carries the graceful shutdown cleanup line",
                "Shutdown cleanup" in log_text,
                "lifespan shutdown hook ran",
            )

        # -- orphan ffmpeg -------------------------------------------------- #
        time.sleep(1.0)
        pids_after = ffmpeg_pids()
        orphans = pids_after - pids_before
        check(
            "No orphan ffmpeg.exe after shutdown",
            not orphans,
            f"pids before={sorted(pids_before)} after={sorted(pids_after)}",
        )

        # -- 503 contract needs a second cold start ------------------------- #
        check_missing_ffmpeg(exe)
        # -- unwritable log dir needs a third cold start -------------------- #
        check_log_fallback(exe, temp_root)
    finally:
        if sidecar is not None and sidecar.process is not None and sidecar.process.poll() is None:
            sidecar.stop()
        # Remove only what this run created; the log file is kept on purpose.
        shutil.rmtree(temp_root, ignore_errors=True)
        if imported_font is not None and imported_font.is_file():
            try:
                imported_font.unlink()
            except OSError:
                pass
        if job_dir is not None and job_dir.is_dir():
            shutil.rmtree(job_dir, ignore_errors=True)

    failures = [name for name, ok, _ in RESULTS if not ok]
    print("\n" + "=" * 78)
    print(f"Frozen smoke: {len(RESULTS) - len(failures)}/{len(RESULTS)} checks passed")
    if failures:
        print("FAILED: " + ", ".join(failures))
    print(f"Log file kept for support: {log_file}")
    print("=" * 78)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
