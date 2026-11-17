"""Phase 1 end-to-end verification for the Tafseer Clipper sidecar.

What this script proves, against a real FFmpeg binary and a real running
FastAPI sidecar:

1. ``GET /health``             - FFmpeg wired up, hardware reported.
2. ``POST /fonts/import``      - .ttf/.otf copied into the fonts directory,
                                 family names returned (multipart + JSON modes,
                                 invalid fonts rejected).
3. ``subtitle_gen``            - .ass carries PlayResX/PlayResY plus the dual
                                 ``ArabicStyle`` + ``ThaiStyle`` definitions and
                                 the .srt sidecar.
4. ``POST /render-batch``      - SSE progress, NVENC->libx264 fallback, valid
                                 1080x1920 blur-filled MP4 + audio.
5. Burn-in proof               - the same clip is rendered with and without
                                 subtitles; frames are diffed and warm-gold
                                 Arabic + crisp-white Thai pixels are located
                                 in the subtitle band.
6. Fonts-dir proof             - the imported family resolves differently from a
                                 bogus family, so ``fontsdir`` is really used.
7. ``POST /verify-arabic``     - HTTP round trip against a mock OpenAI-
                                 compatible endpoint.
8. ``analyzer.discover_clips`` - prompt/JSON/exclusion logic against the mock
                                 provider (the HTTP route needs a transcript,
                                 which needs faster-whisper; its 404 contract is
                                 still asserted over HTTP).
9. ``POST /extract-and-transcribe`` - error contract (400 bad path, 503 when
                                 faster-whisper is absent) plus real 16 kHz mono
                                 WAV extraction, the Thai-Arabic glossary, and
                                 the Cloud STT chunking / gateway protocol.
10. ``POST /list-models``       - model discovery against the mock provider,
                                 friendly 502 for unreachable services, 422
                                 validation.

Run:  python test_phase1_e2e.py
Exit code 0 = every check passed.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

BACKEND = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND))

import config
from services import (
    accel,
    analyzer,
    decision,
    decision_tasks,
    quran,
    recitation,
    renderer,
    subtitle_gen,
    transcriber,
)
from services import verify as verify_service
from services.cancel import JobCancelled, raise_if_cancelled

ARTIFACTS = BACKEND / ".e2e"
WINDIR = Path(os.environ.get("WINDIR", r"C:\Windows"))
SYSTEM_FONTS = WINDIR / "Fonts"

THAI_TEXT = "ฟังตัฟซีร: ซูเราะฮ์อัลฟาติฮะฮ์ (บทเรียนที่ 1)"
ARABIC_TEXT = "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ"
THAI_TEXT_2 = "ท่านนบีกล่าวว่า การงานนั้นขึ้นอยู่กับเจตนา"
ARABIC_TEXT_2 = "إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ"

RESULTS: list[tuple[str, bool, str]] = []


# --------------------------------------------------------------------------- #
# Harness helpers
# --------------------------------------------------------------------------- #
def check(name: str, condition: bool, detail: str = "") -> bool:
    RESULTS.append((name, bool(condition), detail))
    status = "PASS" if condition else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" - {detail}"
    print(line, flush=True)
    return bool(condition)


def error_detail(response: "httpx.Response") -> str:
    """Extract the ``detail`` field from an error response without ever raising.

    The REST contract is ``{"detail": ...}`` JSON. A non-JSON body (for example a
    bare ``500 text/plain`` from an unhandled exception) must be *reported* as a
    failed check, not turn the whole suite into a traceback - otherwise one
    contract violation hides the remaining checks.
    """
    try:
        payload = response.json()
    except Exception:
        body = (response.text or "").strip().replace("\n", " ")
        return f"<non-JSON {response.headers.get('content-type', '?')}> {body[:120]}"
    if isinstance(payload, dict):
        return str(payload.get("detail", ""))
    return str(payload)[:120]


def guarded(label: str, func, *args, **kwargs):
    """Run one check group; a raised exception becomes a recorded FAIL.

    Keeps the suite reporting every remaining check instead of aborting at the
    first unexpected exception.
    """
    try:
        return func(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 - deliberate: report, never abort
        check(f"{label}: completed without raising", False, f"{type(exc).__name__}: {exc}")
        return None


def info(message: str) -> None:
    print(f"[INFO] {message}", flush=True)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def ffmpeg_bin() -> Path:
    return Path(config.ffmpeg_path() or "")


def ffprobe_bin() -> Path:
    return Path(config.ffprobe_path() or "")


def resolve_tools() -> tuple[Path, Path]:
    ffmpeg = config.ffmpeg_path()
    ffprobe = config.ffprobe_path()
    if not ffmpeg or not ffprobe:
        # Developer convenience: a local (non-repo) FFmpeg download used while
        # the Tauri bundle does not exist yet. Production resolves
        # src-tauri/binaries/ffmpeg.exe or TAFSEER_FFMPEG.
        hint = Path(os.environ.get("LOCALAPPDATA", "")) / "tafseer-clipper-tools" / "ffmpeg" / "bin"
        if (hint / "ffmpeg.exe").is_file():
            os.environ.setdefault("TAFSEER_FFMPEG", str(hint / "ffmpeg.exe"))
            os.environ.setdefault("TAFSEER_FFPROBE", str(hint / "ffprobe.exe"))
            config.clear_path_cache()
            ffmpeg, ffprobe = config.ffmpeg_path(), config.ffprobe_path()
    if not ffmpeg or not ffprobe:
        print(
            "FATAL: ffmpeg.exe / ffprobe.exe not found.\n"
            "Place them in src-tauri/binaries/ or set TAFSEER_FFMPEG and "
            "TAFSEER_FFPROBE.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return Path(ffmpeg), Path(ffprobe)


def pick_font(names: list[str]) -> Path | None:
    for name in names:
        candidate = SYSTEM_FONTS / name
        if candidate.is_file():
            return candidate
    return None


# --------------------------------------------------------------------------- #
# Mock OpenAI-compatible LLM
# --------------------------------------------------------------------------- #
class MockLLMHandler(BaseHTTPRequestHandler):
    calls: list[dict] = []
    lock = threading.Lock()

    def log_message(self, *_args):  # silence request logging
        return

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            payload = {}

        with MockLLMHandler.lock:
            MockLLMHandler.calls.append(payload)

        if self.path.rstrip("/").endswith("/systemone"):
            # System One probe reply: one `noul` answer to the "reachable"
            # question, so a live probe succeeds deterministically.
            body = json.dumps(
                {
                    "answers": {
                        "reachable": {"type": "noul", "noul": True, "confidence": 0.99}
                    }
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        prompt = json.dumps(payload.get("messages", []), ensure_ascii=False)
        if "Uthmani-script Quranic proofreader" in prompt:
            content = {
                "verified_text": ARABIC_TEXT,
                "correction_applied": True,
                "notes": "เพิ่มฮารอกัตให้ตรงกับอัลกุรอาน",
            }
        else:
            content = {
                "clips": [
                    {
                        "start": 1.0,
                        "end": 3.0,
                        "title": "คลิปทับช่วงที่อนุมัติแล้ว",
                        "rationale": "ต้องถูกตัดออกเพราะทับซ้อน",
                    },
                    {
                        "start": 5.0,
                        "end": 9.0,
                        "title": "คลิปที่ผ่านการคัดเลือก",
                        "rationale": "ช่วงต้นของซูเราะฮ์",
                    },
                    {
                        "start": 7.0,
                        "end": 11.0,
                        "title": "คลิปที่ทับคลิปก่อนหน้า",
                        "rationale": "ต้องถูกตัดออกเพราะทับซ้อน",
                    },
                    {
                        "start": 9.0,
                        "end": 999.0,
                        "title": "คลิปที่เลยความยาววิดีโอ",
                        "rationale": "ต้องถูกตัดออก",
                    },
                ]
            }

        body = json.dumps(
            {
                "id": "mock",
                "object": "chat.completion",
                "model": payload.get("model", "mock"),
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(content, ensure_ascii=False),
                        },
                        "finish_reason": "stop",
                    }
                ],
            },
            ensure_ascii=False,
        ).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            body = json.dumps(
                {
                    "object": "list",
                    "data": [
                        {"id": "mock-large", "object": "model"},
                        {"id": "mock-tiny", "object": "model"},
                        {"id": "mock-large", "object": "model"},
                    ],
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)


def start_mock_llm() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockLLMHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class MockOpenRouterHandler(BaseHTTPRequestHandler):
    """A provider that returns capability-bearing ``/models`` metadata."""

    def log_message(self, *_args):  # silence request logging
        return

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            body = json.dumps(
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "speech-wave",
                            "architecture": {
                                "input_modalities": ["Audio"],
                                "output_modalities": ["Text"],
                            },
                        },
                        {
                            "id": "chat-assistant",
                            "architecture": {
                                "input_modalities": ["Text"],
                                "output_modalities": ["Text"],
                            },
                        },
                        {
                            "id": "transcribe-endpoint",
                            "supported_endpoints": ["/v1/audio/transcriptions"],
                        },
                        {"id": "plain-model"},
                    ],
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)


def start_mock_openrouter() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenRouterHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# --------------------------------------------------------------------------- #
# Sidecar process
# --------------------------------------------------------------------------- #
class Sidecar:
    def __init__(self, env: dict[str, str], port: int) -> None:
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.env = env
        self.logs: list[str] = []
        self.process: subprocess.Popen | None = None

    def __enter__(self) -> Sidecar:
        self.process = subprocess.Popen(
            [sys.executable, "main.py"],
            cwd=str(BACKEND),
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        threading.Thread(target=self._pump, daemon=True).start()

        deadline = time.time() + 90
        while time.time() < deadline:
            if self.process.poll() is not None:
                break
            try:
                response = httpx.get(f"{self.url}/health", timeout=2.0)
                if response.status_code == 200:
                    return self
            except httpx.HTTPError:
                pass
            time.sleep(0.25)
        self.__exit__()
        raise RuntimeError(
            "Sidecar did not become healthy:\n" + "\n".join(self.logs[-30:])
        )

    def __exit__(self, *_exc) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()

    def _pump(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            self.logs.append(line.rstrip())


# --------------------------------------------------------------------------- #
# Fixtures and measurements
# --------------------------------------------------------------------------- #
def build_source_video(ffmpeg: Path, out: Path, thai_font: Path, arabic_font: Path) -> None:
    """10s, 1920x1080, 16:9 lecture stand-in with Thai + Arabic on-screen text."""
    work = ARTIFACTS / "fixtures"
    work.mkdir(parents=True, exist_ok=True)
    thai_txt = work / "thai.txt"
    arabic_txt = work / "arabic.txt"
    thai_txt.write_text(THAI_TEXT, encoding="utf-8")
    arabic_txt.write_text(ARABIC_TEXT, encoding="utf-8")

    def esc(path: Path) -> str:
        return renderer.escape_filter_path(path)

    graph = (
        "[0:v]"
        "drawbox=x=0:y=0:w=iw:h=ih:color=0x1b2a33:t=fill,"
        "drawbox=x=140:y=150:w=1640:h=780:color=0x22333d:t=2,"
        f"drawtext=fontfile='{esc(thai_font)}':textfile='{esc(thai_txt)}':"
        "fontsize=54:fontcolor=0xf2f5f7:x=(w-text_w)/2:y=250,"
        f"drawtext=fontfile='{esc(arabic_font)}':textfile='{esc(arabic_txt)}':"
        "fontsize=64:fontcolor=0xffd37a:x=(w-text_w)/2:y=520,"
        f"drawtext=fontfile='{esc(thai_font)}':text='PHASE 1 E2E SOURCE 16x9 1920x1080':"
        "fontsize=32:fontcolor=0x8aa0ad:x=60:y=980,"
        "drawbox=x='mod(t*260,1500)':y=760:w=260:h=120:color=0x2f6f7a:t=fill"
        "[v]"
    )

    completed = subprocess.run(
        [
            str(ffmpeg),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x14232b:s=1920x1080:r=30:d=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:sample_rate=48000:duration=10",
            "-filter_complex",
            graph,
            "-map",
            "[v]",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            str(out),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Source fixture failed: {completed.stderr[-1500:]}")


def extract_frame(ffmpeg: Path, video: Path, seconds: float, out: Path) -> Path:
    completed = subprocess.run(
        [
            str(ffmpeg),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{seconds:.3f}",
            "-i",
            str(video),
            "-frames:v",
            "1",
            str(out),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0 or not out.is_file():
        raise RuntimeError(f"Frame extraction failed: {completed.stderr[-800:]}")
    return out


def load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as handle:
        return np.asarray(handle.convert("RGB"), dtype=np.int16)


def subtitle_band_stats(array: np.ndarray) -> dict:
    """Gold (ArabicStyle) and white (ThaiStyle) pixel counts in the lower band."""
    height = array.shape[0]
    band = array[int(height * 0.55) :]
    red, green, blue = band[..., 0], band[..., 1], band[..., 2]
    gold = (red > 230) & (green > 180) & (green < 245) & (blue < 165) & ((red - blue) > 70)
    white = (red > 245) & (green > 245) & (blue > 245)
    return {
        "gold": int(gold.sum()),
        "white": int(white.sum()),
        "size": (int(array.shape[1]), int(array.shape[0])),
    }


def changed_ratios(before: np.ndarray, after: np.ndarray, threshold: int = 40) -> tuple[float, float]:
    """(changed ratio in the subtitle band, changed ratio above it)."""
    height = before.shape[0]
    delta = np.abs(before - after).max(axis=2)
    band = float((delta[int(height * 0.55) :] > threshold).mean())
    upper = float((delta[: int(height * 0.5)] > threshold).mean())
    return band, upper


def stream_sse(client: httpx.Client, url: str, payload: dict) -> list[dict]:
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


def probe(path: Path) -> dict:
    completed = subprocess.run(
        [
            str(ffprobe_bin()),
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
    )
    if completed.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {completed.stderr[-800:]}")
    return json.loads(completed.stdout)


# --------------------------------------------------------------------------- #
# HTTP checks
# --------------------------------------------------------------------------- #
def run_http_checks(
    sidecar: Sidecar,
    source: Path,
    thai_font: Path,
    arabic_font: Path,
    mock_base_url: str,
    openrouter_base_url: str,
    renders: Path,
    control_dir: Path,
) -> None:
    with httpx.Client(base_url=sidecar.url, timeout=180.0) as client:
        # ---- 1. /health ---------------------------------------------------- #
        health = client.get("/health").json()
        check(
            "GET /health: ok + ffmpeg + hardware fields",
            health.get("status") == "ok"
            and health.get("ffmpeg_available") is True
            and isinstance(health.get("vram_mb"), int)
            and isinstance(health.get("cuda_available"), bool)
            and isinstance(health.get("nvenc_available"), bool),
            f"cuda={health.get('cuda_available')} nvenc={health.get('nvenc_available')} "
            f"vram={health.get('vram_mb')}MB",
        )
        check(
            "GET /health: whisper int8 status block",
            isinstance(health.get("whisper"), dict)
            and health["whisper"].get("compute_type") == "int8",
            f"model={health.get('whisper', {}).get('model')} "
            f"loaded={health.get('whisper', {}).get('loaded')}",
        )
        accel_report = health.get("acceleration") or {}
        # The acceleration block must be self-consistent: "transcription: gpu"
        # has to agree with both the runtime flag and the reason field. The
        # original defect reported reason=null beside pack_installed=false while
        # a CUDA load failed at first inference.
        says_gpu = accel_report.get("transcription") == "gpu"
        consistent = (
            bool(accel_report)
            and says_gpu == (
                accel_report.get("cuda_runtime") is True
                and accel_report.get("gpu_detected") is True
            )
            and says_gpu == (accel_report.get("reason") is None)
        )
        check(
            "GET /health: acceleration block is self-consistent",
            consistent,
            f"transcription={accel_report.get('transcription')} "
            f"cuda_runtime={accel_report.get('cuda_runtime')} "
            f"gpu_detected={accel_report.get('gpu_detected')} "
            f"reason={accel_report.get('reason')}",
        )

        # Additive provider detection: shape only, a machine may or may not run
        # Ollama. `detected` must agree with the URL/models it reports.
        providers = health.get("providers") or {}
        ollama = providers.get("ollama") if isinstance(providers, dict) else None
        ollama_ok = (
            isinstance(ollama, dict)
            and isinstance(ollama.get("detected"), bool)
            and (ollama.get("url") is None or isinstance(ollama.get("url"), str))
            and isinstance(ollama.get("models"), list)
            and all(isinstance(name, str) for name in ollama.get("models", []))
            and (ollama.get("detected") is True or ollama.get("models") == [])
        )
        check(
            "GET /health: providers block reports Ollama detection",
            ollama_ok,
            f"ollama={ollama}",
        )

        # Settings passes its saved Ollama address, and "Check again" adds
        # refresh=1. The probe must normalise a ".../v1" chat URL to Ollama's
        # HTTP root and stay well-formed even when nothing listens there.
        refresh_probe = client.get(
            "/health",
            params={"refresh": "1", "ollama_base_url": "http://127.0.0.1:9/v1"},
        )
        refresh_ollama = (
            (refresh_probe.json().get("providers") or {}).get("ollama")
            if refresh_probe.status_code == 200
            else None
        )
        check(
            "GET /health: a configured Ollama address is probed and normalised",
            refresh_probe.status_code == 200
            and isinstance(refresh_ollama, dict)
            and refresh_ollama.get("detected") is False
            and refresh_ollama.get("url") == "http://127.0.0.1:9",
            f"status={refresh_probe.status_code} ollama={refresh_ollama}",
        )

        hardware = health.get("hardware") or {}
        check(
            "GET /health: hardware tier is a known value",
            isinstance(hardware, dict) and hardware.get("tier") in {"high", "medium", "low"},
            f"hardware={hardware}",
        )

        # Additive whisper_local scan: shape only — a machine may have no
        # downloaded models, but the block must always be well-formed.
        whisper_local = providers.get("whisper_local") if isinstance(providers, dict) else None
        whisper_local_ok = (
            isinstance(whisper_local, dict)
            and isinstance(whisper_local.get("models"), list)
            and all(isinstance(name, str) and name for name in whisper_local.get("models", []))
        )
        check(
            "GET /health: whisper_local scan block is well-formed",
            whisper_local_ok,
            f"whisper_local={whisper_local}",
        )

        # ---- 1b. POST /list-models ------------------------------------------- #
        response = client.post("/list-models", json={"base_url": mock_base_url})
        listed = response.json() if response.status_code == 200 else {}
        check(
            "POST /list-models: enumerates a service's models (deduped, sorted)",
            response.status_code == 200
            and listed.get("models") == ["mock-large", "mock-tiny"],
            f"status={response.status_code} models={listed.get('models')}",
        )
        response = client.post(
            "/list-models", json={"base_url": "http://127.0.0.1:1/unreachable"}
        )
        detail = error_detail(response)
        check(
            "POST /list-models: unreachable service is a friendly 502",
            response.status_code == 502 and "Could not reach" in detail,
            f"status={response.status_code} detail={detail}",
        )
        response = client.post("/list-models", json={"base_url": "   "})
        check(
            "POST /list-models: empty base_url is rejected",
            response.status_code == 422,
            f"status={response.status_code}",
        )

        # ---- 1c. additive capability metadata (AGENTS.md §3) ---------------- #
        # The OpenAI-compatible mock sends a bare `{data:[{id}]}` payload, so
        # every model must classify as "unknown" -- never guessed from a name.
        bare_details = listed.get("models_detail", [])
        check(
            "POST /list-models: bare provider payload classifies every model as unknown",
            [detail.get("kind") for detail in bare_details] == ["unknown", "unknown"]
            and [detail.get("id") for detail in bare_details] == ["mock-large", "mock-tiny"],
            f"models_detail={bare_details}",
        )
        # `filter="decision"` ranks familiar families first but never hides any
        # model; the full id set and `models` list shape must stay unchanged.
        filtered = client.post(
            "/list-models", json={"base_url": mock_base_url, "filter": "decision"}
        )
        filtered_payload = filtered.json() if filtered.status_code == 200 else {}
        check(
            "POST /list-models: filter=decision ranks but returns every model",
            filtered.status_code == 200
            and sorted(filtered_payload.get("models", [])) == ["mock-large", "mock-tiny"]
            and all(isinstance(name, str) for name in filtered_payload.get("models", [])),
            f"status={filtered.status_code} models={filtered_payload.get('models')}",
        )
        # A successful System One probe must still return `probe.ok` true with the
        # expected model -- the probe feature itself is unchanged.
        probed = client.post(
            "/list-models",
            json={
                "base_url": mock_base_url,
                "probe_model": "mock-large",
                "endpoint_style": "systemone",
            },
        )
        probed_payload = probed.json() if probed.status_code == 200 else {}
        check(
            "POST /list-models: a successful probe returns probe.ok with the model",
            probed.status_code == 200
            and probed_payload.get("probe", {}).get("ok") is True
            and probed_payload.get("probe", {}).get("model") == "mock-large",
            f"status={probed.status_code} probe={probed_payload.get('probe')}",
        )
        # Additive /health: providers.ollama.models_detail is additive (empty when
        # no Ollama). The removed `verified_models` field must no longer appear.
        health_recheck = client.get("/health").json()
        ollama_status = (health_recheck.get("providers") or {}).get("ollama") or {}
        check(
            "GET /health: additive ollama models_detail, no verified_models",
            isinstance(ollama_status.get("models_detail"), list)
            and all(
                isinstance(d, dict) and "kind" in d and "id" in d
                for d in ollama_status.get("models_detail", [])
            )
            and "verified_models" not in health_recheck,
            f"ollama_detail={ollama_status.get('models_detail')}",
        )
        # A provider that sends capability metadata (OpenRouter-style) proves
        # `kind` from `architecture`/`supported_endpoints`; a bare entry stays unknown.
        openrouter = client.post(
            "/list-models", json={"base_url": openrouter_base_url}
        )
        or_payload = openrouter.json() if openrouter.status_code == 200 else {}
        or_by_id = {d.get("id"): d for d in or_payload.get("models_detail", [])}
        check(
            "POST /list-models: OpenRouter metadata classifies speech/text/unknown",
            openrouter.status_code == 200
            and or_by_id.get("speech-wave", {}).get("kind") == "speech"
            and or_by_id.get("transcribe-endpoint", {}).get("kind") == "speech"
            and or_by_id.get("chat-assistant", {}).get("kind") == "text"
            and or_by_id.get("plain-model", {}).get("kind") == "unknown"
            and or_payload.get("models") == [
                "chat-assistant",
                "plain-model",
                "speech-wave",
                "transcribe-endpoint",
            ],
            f"status={openrouter.status_code} models_detail={or_payload.get('models_detail')}",
        )

        # ---- 2. /fonts/import ---------------------------------------------- #
        with thai_font.open("rb") as thai_handle, arabic_font.open("rb") as arabic_handle:
            response = client.post(
                "/fonts/import",
                files=[
                    ("files", (thai_font.name, thai_handle, "font/ttf")),
                    ("files", (arabic_font.name, arabic_handle, "font/ttf")),
                ],
            )
        fonts_payload = response.json() if response.status_code == 200 else {}
        families = fonts_payload.get("imported_fonts", [])
        check(
            "POST /fonts/import (multipart): families returned",
            response.status_code == 200 and len(families) >= 1,
            f"{response.status_code} families={families}",
        )
        imported_paths = [item["path"] for item in fonts_payload.get("fonts", [])]
        check(
            "POST /fonts/import: files copied into fonts dir",
            bool(imported_paths) and all(Path(p).is_file() for p in imported_paths),
            f"{len(imported_paths)} files in {fonts_payload.get('fonts_dir')}",
        )

        json_response = client.post(
            "/fonts/import", json={"font_paths": [str(thai_font)]}
        )
        check(
            "POST /fonts/import (JSON font_paths)",
            json_response.status_code == 200
            and bool(json_response.json().get("imported_fonts")),
            f"{json_response.status_code}",
        )

        bad_file = ARTIFACTS / "not_a_font.ttf"
        bad_file.write_text("not a font", encoding="utf-8")
        reject = client.post("/fonts/import", json={"font_paths": [str(bad_file)]})
        check(
            "POST /fonts/import: invalid font rejected",
            reject.status_code == 400,
            f"{reject.status_code} {reject.text[:80]}",
        )

        # ---- 3. /render-batch (SSE, blur-fill 9:16) ------------------------ #
        batch = {
            "project_name": "phase1",
            "source_path": str(source),
            "resolution": "1080x1920",
            "framing": "blur-fill",
            "use_nvenc": True,
            "export_srt": True,
            "output_dir": str(renders),
            "filename_template": "{LectureName}_Clip{01}_{Title}.mp4",
            "subtitle_timebase": "clip",
            "styles": {
                "arabic": {"color": "#FFD37A", "size": 66},
                "thai": {"color": "#FFFFFF", "size": 46},
            },
            "clips": [
                {
                    "start": 0.0,
                    "end": 5.0,
                    "title": "clip one",
                    "subtitles": [
                        {"start": 0.4, "end": 2.4, "arabic": ARABIC_TEXT, "thai": THAI_TEXT},
                        {"start": 2.6, "end": 3.8, "thai": THAI_TEXT_2},
                        {"start": 3.9, "end": 4.8, "arabic": ARABIC_TEXT_2},
                    ],
                },
                {
                    "start": 5.0,
                    "end": 10.0,
                    "title": "clip two",
                    "subtitles": [
                        {"start": 0.5, "end": 3.0, "arabic": ARABIC_TEXT_2, "thai": THAI_TEXT_2}
                    ],
                },
            ],
        }
        events = stream_sse(client, "/render-batch", batch)
        names = [event["_event"] for event in events]
        done = next((event for event in events if event["_event"] == "done"), {})
        start_event = next((event for event in events if event["_event"] == "start"), {})
        check(
            "POST /render-batch: SSE start/progress/done sequence",
            "start" in names and names.count("progress") >= 1 and "done" in names,
            f"events={len(events)} progress={names.count('progress')}",
        )
        check(
            "POST /render-batch: batch completed without failures",
            done.get("status") == "completed" and done.get("failed_clips") == 0,
            f"status={done.get('status')} rendered={done.get('rendered_clips')}",
        )

        encoders = {
            event.get("encoder")
            for event in events
            if event["_event"] in ("progress", "clip_done") and event.get("encoder")
        }
        check(
            "POST /render-batch: encoder reported (h264_nvenc or libx264)",
            bool(encoders) and encoders <= {"h264_nvenc", "libx264"},
            f"used={sorted(encoders)} nvenc_probe={renderer.nvenc_available()}",
        )
        if not renderer.nvenc_available():
            check(
                "POST /render-batch: NVENC unavailable -> CPU fallback emitted",
                "fallback" in names,
                f"events={sorted(set(names))}",
            )

        mp4s = sorted(renders.glob("*.mp4"))
        check(
            "POST /render-batch: two MP4 files written",
            len(mp4s) == 2 and all(path.stat().st_size > 20_000 for path in mp4s),
            ", ".join(f"{p.name} ({p.stat().st_size // 1024} KiB)" for p in mp4s),
        )
        check(
            "Filename template: {LectureName}_Clip{01}_{Title} zero-padded",
            len(mp4s) == 2
            and any("Clip01" in path.name for path in mp4s)
            and any("Clip02" in path.name for path in mp4s),
            ", ".join(path.name for path in mp4s),
        )

        first_mp4 = next(
            (path for path in mp4s if "Clip01" in path.name), mp4s[0] if mp4s else None
        )
        if first_mp4:
            media = probe(first_mp4)
            video = next(
                (s for s in media["streams"] if s.get("codec_type") == "video"), {}
            )
            audio = next(
                (s for s in media["streams"] if s.get("codec_type") == "audio"), None
            )
            check(
                "Rendered MP4: 1080x1920 H.264 with audio",
                video.get("width") == 1080
                and video.get("height") == 1920
                and video.get("codec_name") == "h264"
                and audio is not None,
                f"{video.get('width')}x{video.get('height')} "
                f"{video.get('codec_name')} audio={'yes' if audio else 'no'}",
            )
            duration = float(media["format"].get("duration", 0.0))
            check(
                "Rendered MP4: ~5s clip duration",
                4.4 <= duration <= 5.6,
                f"{duration:.2f}s",
            )

            srt = first_mp4.with_suffix(".srt")
            check(
                "Rendered .srt sidecar written next to MP4",
                srt.is_file() and ARABIC_TEXT in srt.read_text(encoding="utf-8"),
                srt.name if srt.is_file() else "missing",
            )

        ass_path = start_event.get("clips", [{}])[0].get("ass_path", "")
        ass_text = Path(ass_path).read_text(encoding="utf-8") if ass_path else ""
        check(
            "Generated .ass: PlayRes + ArabicStyle + ThaiStyle + dual events",
            "PlayResX: 1080" in ass_text
            and "PlayResY: 1920" in ass_text
            and "Style: ArabicStyle," in ass_text
            and "Style: ThaiStyle," in ass_text
            and ass_text.count("Dialogue:") >= 4,
            f"dialogues={ass_text.count('Dialogue:')} file={Path(ass_path).name}",
        )
        check(
            "Generated .ass: per-style fonts/sizes/colours from the request",
            "Style: ArabicStyle,Tahoma,66,&H007AD3FF" in ass_text
            and "Style: ThaiStyle,Leelawadee UI,46,&H00FFFFFF" in ass_text,
            next(
                (
                    line
                    for line in ass_text.splitlines()
                    if line.startswith("Style: ArabicStyle")
                ),
                "missing",
            )[:110],
        )

        # ---- 3b. control render without subtitles -------------------------- #
        control = json.loads(json.dumps(batch))
        control["output_dir"] = str(control_dir)
        control["export_srt"] = False
        for clip in control["clips"]:
            clip["subtitles"] = []
        control_events = stream_sse(client, "/render-batch", control)
        control_done = next(
            (event for event in control_events if event["_event"] == "done"), {}
        )
        check(
            "POST /render-batch: control render (no subtitles) completed",
            control_done.get("status") == "completed",
            f"status={control_done.get('status')}",
        )

        # ---- 3c. burn-in proof --------------------------------------------- #
        if first_mp4:
            control_mp4 = next(iter(sorted(control_dir.glob("*.mp4"))), None)
            if control_mp4:
                subtitled_frame = load_rgb(
                    extract_frame(
                        ffmpeg_bin(), first_mp4, 1.5, ARTIFACTS / "frame_subtitled.png"
                    )
                )
                control_frame = load_rgb(
                    extract_frame(
                        ffmpeg_bin(), control_mp4, 1.5, ARTIFACTS / "frame_control.png"
                    )
                )
                band_ratio, upper_ratio = changed_ratios(control_frame, subtitled_frame)
                stats = subtitle_band_stats(subtitled_frame)
                check(
                    "Burn-in: subtitles changed the lower band only",
                    band_ratio > 0.005 and upper_ratio < 0.001,
                    f"band={band_ratio:.4%} upper={upper_ratio:.4%}",
                )
                check(
                    "Burn-in: warm-gold Arabic + crisp-white Thai pixels present",
                    stats["gold"] > 200 and stats["white"] > 200,
                    f"gold={stats['gold']} white={stats['white']} px",
                )
                check(
                    "Burn-in: frame is 1080x1920",
                    stats["size"] == (1080, 1920),
                    str(stats["size"]),
                )

        # ---- 3d. center-crop framing --------------------------------------- #
        crop_dir = renders / "crop"
        crop_batch = {
            "project_name": "phase1-crop",
            "source_path": str(source),
            "resolution": "1080x1920",
            "framing": "center-crop",
            "use_nvenc": True,
            "output_dir": str(crop_dir),
            "clips": [
                {
                    "start": 0.0,
                    "end": 2.0,
                    "title": "crop",
                    "subtitles": [{"start": 0.2, "end": 1.8, "thai": THAI_TEXT}],
                }
            ],
        }
        crop_events = stream_sse(client, "/render-batch", crop_batch)
        crop_done = next((e for e in crop_events if e["_event"] == "done"), {})
        crop_mp4 = next(iter(sorted(crop_dir.glob("*.mp4"))), None)
        crop_ok = False
        crop_detail = "missing output"
        if crop_mp4:
            crop_video = next(
                (
                    s
                    for s in probe(crop_mp4)["streams"]
                    if s.get("codec_type") == "video"
                ),
                {},
            )
            crop_ok = (
                crop_done.get("status") == "completed"
                and crop_video.get("width") == 1080
                and crop_video.get("height") == 1920
            )
            crop_detail = f"{crop_video.get('width')}x{crop_video.get('height')}"
        check(
            "POST /render-batch: center-crop framing renders 1080x1920",
            crop_ok,
            crop_detail,
        )

        # ---- 4. /verify-arabic --------------------------------------------- #
        verify = client.post(
            "/verify-arabic",
            json={
                "arabic_text": ARABIC_TEXT,
                "context_thai": THAI_TEXT,
                "provider": {"model": "mock-fast"},
            },
        )
        verify_body = verify.json() if verify.status_code == 200 else {}
        check(
            "POST /verify-arabic: round trip through OpenAI-compatible provider",
            verify.status_code == 200
            and verify_body.get("verified_text") == ARABIC_TEXT
            and verify_body.get("correction_applied") is True,
            f"{verify.status_code} corrected={verify_body.get('correction_applied')}",
        )

        # ---- 5. /discover-clips contract ----------------------------------- #
        missing = client.post(
            "/discover-clips", json={"transcript_id": "does-not-exist"}
        )
        check(
            "POST /discover-clips: unknown transcript -> 404",
            missing.status_code == 404,
            f"{missing.status_code}",
        )

        # ---- 6. /extract-and-transcribe error contract --------------------- #
        bad_path = client.post(
            "/extract-and-transcribe", json={"file_path": str(ARTIFACTS / "nope.mp4")}
        )
        check(
            "POST /extract-and-transcribe: missing file -> 400",
            bad_path.status_code == 400,
            f"{bad_path.status_code}",
        )
        no_whisper = client.post(
            "/extract-and-transcribe", json={"file_path": str(source)}
        )
        detail = ""
        if no_whisper.status_code != 200:
            detail = error_detail(no_whisper)
        check(
            "POST /extract-and-transcribe: clean 503 when faster-whisper is absent",
            no_whisper.status_code in (200, 503)
            and (no_whisper.status_code == 200 or "faster-whisper" in detail),
            f"{no_whisper.status_code} {detail[:110]}",
        )

        # ---- 7. render-batch validation ------------------------------------ #
        invalid = client.post(
            "/render-batch",
            json={"clips": [{"start": 1.0, "end": 0.5}], "source_path": str(source)},
        )
        check(
            "POST /render-batch: invalid clip range -> 422",
            invalid.status_code == 422,
            f"{invalid.status_code}",
        )
        no_source = client.post(
            "/render-batch", json={"clips": [{"start": 0.0, "end": 2.0}]}
        )
        check(
            "POST /render-batch: missing source_path/transcript_id -> 400",
            no_source.status_code == 400,
            f"{no_source.status_code}",
        )


# --------------------------------------------------------------------------- #
# Unit checks
# --------------------------------------------------------------------------- #
def render_font_probe(
    *,
    source: Path,
    fonts_dir: Path,
    family: str,
    tag: str,
    work: Path,
) -> np.ndarray:
    cues = [subtitle_gen.Cue(0.0, 1.2, arabic=ARABIC_TEXT)]
    ass_path = work / f"font_{tag}.ass"
    subtitle_gen.write_ass(
        ass_path,
        cues=cues,
        resolution="1080x1920",
        arabic_style=subtitle_gen.StyleConfig(
            name="ArabicStyle", font=family, size=72, margin_v=420
        ),
        thai_style=subtitle_gen.StyleConfig(
            name="ThaiStyle", font="Tahoma", size=46, margin_v=200
        ),
        clip_duration=1.2,
    )
    job = renderer.RenderJob(
        source=source,
        output=work / f"font_{tag}.mp4",
        start=0.0,
        duration=1.2,
        resolution="1080x1920",
        framing="blur-fill",
        ass_path=ass_path,
        fonts_dir=fonts_dir,
        use_nvenc=False,
    )
    for _ in renderer.render(job):
        pass
    frame = extract_frame(ffmpeg_bin(), job.output, 0.6, work / f"font_{tag}.png")
    return load_rgb(frame)


def run_unit_checks(source: Path, fonts_dir: Path) -> None:
    work = ARTIFACTS / "unit"
    work.mkdir(parents=True, exist_ok=True)

    # ---- subtitle_gen ------------------------------------------------------ #
    cues = [
        subtitle_gen.Cue(0.5, 2.0, arabic=ARABIC_TEXT, thai=THAI_TEXT),
        subtitle_gen.Cue(2.2, 3.4, thai=THAI_TEXT_2),
    ]
    document = subtitle_gen.build_ass(
        cues, resolution="1080x1920", title="unit", clip_duration=4.0
    )
    check(
        "subtitle_gen.build_ass: header, styles and 3 dialogue events",
        document.content.startswith("[Script Info]")
        and "PlayResX: 1080" in document.content
        and "PlayResY: 1920" in document.content
        and "Style: ArabicStyle," in document.content
        and "Style: ThaiStyle," in document.content
        and document.content.count("Dialogue:") == 3,
        f"events={document.cue_count}",
    )
    landscape = subtitle_gen.build_ass(cues, resolution="1920x1080").content
    check(
        "subtitle_gen: 16:9 resolution keeps PlayRes 1920x1080",
        "PlayResX: 1920" in landscape and "PlayResY: 1080" in landscape,
    )
    check(
        "subtitle_gen: gold Arabic / white Thai default colours",
        subtitle_gen.default_styles("1080x1920")[0].primary_color == "#FFD37A"
        and subtitle_gen.default_styles("1080x1920")[1].primary_color == "#FFFFFF",
    )
    srt = subtitle_gen.build_srt(cues)
    check(
        "subtitle_gen.build_srt: timestamps + both languages",
        1 <= srt.count("-->") <= 2 and ARABIC_TEXT in srt and THAI_TEXT in srt,
        f"{srt.count('-->')} blocks",
    )

    # ---- renderer graph ---------------------------------------------------- #
    graph = renderer.build_filtergraph(
        resolution="1080x1920",
        framing="blur-fill",
        ass_path=r"C:\Users\muham\OneDrive\Documents\tafseer-clipper\backend\.e2e\clip 01.ass",
        fonts_dir=r"C:\Users\muham\OneDrive\Documents\tafseer-clipper\backend\fonts",
    )
    check(
        "renderer.build_filtergraph: split/blur/overlay/ass+fontsdir",
        "split=2[main][bg]" in graph
        and "boxblur=20:5" in graph
        and "overlay=(W-w)/2:(H-h)/2" in graph
        and "ass=filename=" in graph
        and "fontsdir=" in graph
        and "\\:" in graph,
        graph[:110] + "...",
    )

    # ---- fontsdir really resolves the imported family --------------------- #
    real = render_font_probe(
        source=source, fonts_dir=fonts_dir, family="Tahoma", tag="tahoma", work=work
    )
    bogus = render_font_probe(
        source=source,
        fonts_dir=fonts_dir,
        family="NoSuchFontFamilyXYZ",
        tag="bogus",
        work=work,
    )
    ratio, _ = changed_ratios(real, bogus)
    check(
        "fontsdir: imported family renders differently from a bogus family",
        ratio > 0.0005,
        f"diff={ratio:.4%}",
    )

    # ---- transcriber ------------------------------------------------------- #
    wav = work / "unit_audio.wav"
    extracted = transcriber.extract_audio(source, wav)
    audio_stream = next(
        (
            s
            for s in probe(extracted)["streams"]
            if s.get("codec_type") == "audio"
        ),
        {},
    )
    check(
        "transcriber.extract_audio: 16kHz mono PCM WAV",
        extracted.is_file()
        and audio_stream.get("sample_rate") == "16000"
        and audio_stream.get("channels") == 1,
        f"{audio_stream.get('sample_rate')}Hz ch={audio_stream.get('channels')}",
    )
    glossary = {"อัลเลาะห์": "อัลลอฮฺ", "ซอฮาบะห์": "เศาะฮาบะฮฺ"}
    check(
        "transcriber.apply_glossary: longest-match Thai-Arabic replacement",
        transcriber.apply_glossary("อัลเลาะห์ กับ ซอฮาบะห์", glossary)
        == "อัลลอฮฺ กับ เศาะฮาบะฮฺ",
        transcriber.apply_glossary("อัลเลาะห์ กับ ซอฮาบะห์", glossary),
    )

    # ---- Cloud STT: upload chunking, re-timing and actionable errors -------- #
    # Providers cap uploads at 25 MB (~12.5 min of 16 kHz PCM), so a long
    # lecture has to be split. The budget is shrunk here instead of writing a
    # 24 MB fixture; frame-exact slicing does not depend on the value.
    whole_chunks, whole_temps = transcriber._split_wav_for_upload(extracted)
    check(
        "transcriber: a short lecture stays a single Cloud STT upload",
        len(whole_chunks) == 1
        and whole_chunks[0].path == extracted
        and whole_chunks[0].offset == 0.0
        and whole_temps == [],
        f"chunks={len(whole_chunks)}",
    )
    parts, temporary = transcriber._split_wav_for_upload(extracted, max_bytes=64_000)
    try:
        offsets_ok = all(
            abs(chunk.offset - index * 2.0) < 0.01 for index, chunk in enumerate(parts)
        )
        check(
            "transcriber: a long lecture is split under the provider size cap",
            len(parts) >= 2
            and len(temporary) == len(parts)
            and all(chunk.path.is_file() for chunk in parts)
            and offsets_ok,
            f"chunks={len(parts)} offsets={[round(chunk.offset, 2) for chunk in parts]}",
        )
    finally:
        for created in temporary:
            created.unlink(missing_ok=True)

    re_timed, part_duration = transcriber._segments_from_cloud_payload(
        {"segments": [{"start": 1.0, "end": 2.5, "text": "hello"}], "duration": 2.5},
        offset=600.0,
    )
    check(
        "transcriber: cloud segments are re-timed onto the lecture timeline",
        len(re_timed) == 1
        and re_timed[0].start == 601.0
        and re_timed[0].end == 602.5
        and part_duration == 2.5,
        f"{[(segment.start, segment.end) for segment in re_timed]}",
    )

    hinted, hinted_duration = transcriber._segments_from_cloud_payload(
        {"text": "plain json, no timing"}, offset=120.0, duration_hint=60.0
    )
    check(
        "transcriber: a provider without timestamps still yields a timed segment",
        len(hinted) == 1
        and hinted[0].start == 120.0
        and hinted[0].end == 180.0
        and hinted_duration == 60.0,
        f"{[(segment.start, segment.end) for segment in hinted]} duration={hinted_duration}",
    )

    chat_only = transcriber._cloud_status_error(
        httpx.Response(404, text='{"error":"not found"}'),
        "https://gateway.example/v1/audio/transcriptions",
        "https://gateway.example/v1",
    )
    check(
        "transcriber: a 404 names the speech service problem, not raw provider JSON",
        "speech service" in str(chat_only) and "This computer" in str(chat_only),
        str(chat_only)[:120],
    )

    # ---- Vercel AI Gateway: its own transcription protocol ------------------ #
    # The gateway is OpenAI-compatible for chat only; its audio route is a 404.
    # These checks lock in the dedicated endpoint/header/payload path.
    gateway_url = "https://ai-gateway.vercel.sh/v1"
    gateway_segments, gateway_duration = transcriber._segments_from_gateway_payload(
        {
            "text": "full text",
            "language": "th",
            "durationInSeconds": 12.5,
            "segments": [
                {"text": "one", "startSecond": 0.0, "endSecond": 2.0},
                {"text": "two", "startSecond": 2.0, "endSecond": 4.5},
            ],
        },
        offset=600.0,
    )
    check(
        "transcriber: gateway segments use startSecond/endSecond and the lecture timeline",
        transcriber._is_vercel_gateway(gateway_url)
        and not transcriber._is_vercel_gateway("https://api.openai.com/v1")
        and transcriber._vercel_gateway_endpoint(gateway_url)
        == "https://ai-gateway.vercel.sh/v4/ai/transcription-model"
        and gateway_duration == 12.5
        and [(s.start, s.end) for s in gateway_segments] == [(600.0, 602.0), (602.0, 604.5)],
        f"duration={gateway_duration} segments={[(s.start, s.end) for s in gateway_segments]}",
    )

    gateway_text, gateway_text_duration = transcriber._segments_from_gateway_payload(
        {"text": "no timing", "durationInSeconds": 0}, duration_hint=30.0
    )
    check(
        "transcriber: gateway text-only payload falls back to the chunk duration",
        len(gateway_text) == 1
        and gateway_text[0].start == 0.0
        and gateway_text[0].end == 30.0
        and gateway_text_duration == 30.0,
        f"segments={[(s.start, s.end) for s in gateway_text]}",
    )

    gateway_error = transcriber._cloud_status_error(
        httpx.Response(400, text='{"error":{"message":"bad model"}}'),
        "https://ai-gateway.vercel.sh/v4/ai/transcription-model",
        gateway_url,
        gateway=True,
    )
    check(
        "transcriber: a gateway 400 points at the model/account, not at OpenAI routes",
        "AI Gateway" in str(gateway_error) and "transcription model" in str(gateway_error),
        str(gateway_error)[:120],
    )
    # ---- accel: the CUDA probe must be honest in BOTH directions ----------- #
    # Too permissive = the original bug (claiming a CUDA runtime that is not
    # loadable, then 500ing at the first inference). Too strict = the product's
    # headline feature silently disabled for everyone who installed the pack.
    probe_dir = Path(tempfile.mkdtemp(prefix="tafseer-probe-"))
    previous_cuda_dir = os.environ.get("TAFSEER_CUDA_DIR")
    try:
        system32 = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "kernel32.dll"
        if not system32.is_file():
            check(
                "accel: compute libraries load when they are present",
                False,
                f"fixture missing: {system32}",
            )
        else:
            # Copies of a real system DLL under the CUDA names. Legitimate here:
            # the only question is whether the library can be *loaded*, which is
            # exactly what the defective probe got wrong.
            for name in ("cublas64_12.dll", "cudnn64_9.dll"):
                shutil.copy2(system32, probe_dir / name)
            os.environ["TAFSEER_CUDA_DIR"] = str(probe_dir)
            accel.clear_cache()
            check(
                "accel: compute libraries load when they are present",
                accel._load_cuda_compute_libraries() is True,
                f"dir={probe_dir}",
            )

            # The full report can only claim "gpu" where there IS a GPU, so this
            # half is machine-dependent by definition. CI runners have none, so
            # assert the honest negative there instead of skipping silently.
            report = accel.acceleration_report()
            if report["gpu_detected"]:
                check(
                    "accel: probe reports GPU when the compute libraries actually load",
                    report["cuda_runtime"] is True
                    and report["transcription"] == "gpu"
                    and report["reason"] is None,
                    f"cuda_runtime={report['cuda_runtime']} "
                    f"transcription={report['transcription']} reason={report['reason']}",
                )
            else:
                info(
                    "accel: GPU positive-direction check is not applicable on a "
                    "machine without an NVIDIA GPU; asserting the negative instead"
                )
                check(
                    "accel: probe does not claim GPU on a machine without one",
                    report["cuda_runtime"] is False
                    and report["transcription"] == "cpu"
                    and report["reason"] == "no-nvidia-gpu",
                    f"cuda_runtime={report['cuda_runtime']} "
                    f"transcription={report['transcription']} reason={report['reason']}",
                )
    finally:
        if previous_cuda_dir is None:
            os.environ.pop("TAFSEER_CUDA_DIR", None)
        else:
            os.environ["TAFSEER_CUDA_DIR"] = previous_cuda_dir
        accel.clear_cache()
        shutil.rmtree(probe_dir, ignore_errors=True)

    engine = transcriber.WhisperTranscriber(model_size="tiny", device="cpu")
    check(
        "transcriber: unload() on an unloaded model is a no-op",
        engine.unload() is False and engine.loaded is False,
    )

    # ---- transcriber: GPU failure at INFERENCE falls back to the CPU -------- #
    # Regression guard for the defect where a CUDA runtime that passes the
    # readiness probe still fails inside encode() (missing cublas64_12.dll).
    # The fallback must kick in at transcription time, not only at model load,
    # and the failure must surface as TranscriptionError (503 JSON) - never as a
    # bare RuntimeError that becomes a 500 text/plain.
    class _FakeCudaModel:
        """Stands in for a CUDA WhisperModel whose inference blows up."""

        def __init__(self, fail: bool):
            self.fail = fail
            self.calls = 0

        def transcribe(self, *_args, **_kwargs):
            self.calls += 1
            if self.fail:
                raise RuntimeError(
                    "Library cublas64_12.dll is not found or cannot be loaded"
                )
            info = type("Info", (), {"language": "th", "duration": 1.0,
                                     "language_probability": 0.9})()
            return iter(()), info

    fallback_engine = transcriber.WhisperTranscriber(model_size="tiny", device="cpu")
    cuda_model = _FakeCudaModel(fail=True)
    fallback_engine._model = cuda_model
    fallback_engine._device = "cuda"
    fallback_engine._compute_type = "int8"
    cpu_model = _FakeCudaModel(fail=False)
    loaded_devices: list[str] = []

    class _FakeWhisperModel:
        def __init__(self, _size, device="cpu", compute_type="int8"):
            loaded_devices.append(device)
            self._inner = cpu_model

        def transcribe(self, *args, **kwargs):
            return self._inner.transcribe(*args, **kwargs)

    fake_module = type(sys)("faster_whisper")
    fake_module.WhisperModel = _FakeWhisperModel
    real_module = sys.modules.get("faster_whisper")
    sys.modules["faster_whisper"] = fake_module
    try:
        result = fallback_engine.transcribe(
            source, auto_unload=False, vad_filter=False
        )
        check(
            "transcriber: CUDA inference failure retries on the CPU",
            result.device == "cpu" and loaded_devices == ["cpu"] and cpu_model.calls == 1,
            f"device={result.device} loaded={loaded_devices} cpu_calls={cpu_model.calls}",
        )
    except Exception as exc:  # noqa: BLE001 - a raise here is the failure
        check(
            "transcriber: CUDA inference failure retries on the CPU",
            False,
            f"{type(exc).__name__}: {exc}",
        )
    finally:
        if real_module is not None:
            sys.modules["faster_whisper"] = real_module
        else:
            sys.modules.pop("faster_whisper", None)

    # The non-GPU path must raise TranscriptionError (=> 503 JSON), not
    # RuntimeError (=> 500 text/plain).
    cpu_only = transcriber.WhisperTranscriber(model_size="tiny", device="cpu")
    cpu_only._model = _FakeCudaModel(fail=True)
    cpu_only._device = "cpu"
    cpu_only._compute_type = "int8"
    raised: Exception | None = None
    try:
        cpu_only.transcribe(source, auto_unload=False, vad_filter=False)
    except Exception as exc:  # noqa: BLE001 - we are asserting the type
        raised = exc
    check(
        "transcriber: unrecoverable failure raises TranscriptionError (503 JSON)",
        isinstance(raised, transcriber.TranscriptionError),
        type(raised).__name__ if raised else "no exception raised",
    )

    # ---- analyzer (mock provider) ------------------------------------------ #
    provider = analyzer.ProviderConfig(
        base_url=os.environ["TAFSEER_LLM_BASE_URL"],
        api_key=None,
        model="mock-reasoning",
        timeout=30.0,
    )
    clips = asyncio.run(
        analyzer.discover_clips(
            segments=[{"start": 0.0, "end": 10.0, "text": "เนื้อหาบทเรียนตัฟซีร"}],
            duration=10.0,
            base_prompt="",
            session_guide="เน้นช่วงต้น",
            refinement_note="",
            excluded_ranges=[{"start": 2.0, "end": 4.0}],
            provider=provider,
            min_duration=3.0,
            max_duration=90.0,
            max_clips=8,
        )
    )
    check(
        "analyzer.discover_clips: exclusions, overlaps and out-of-range filtered",
        len(clips) == 1 and clips[0]["start"] == 5.0 and clips[0]["end"] == 9.0,
        json.dumps(clips, ensure_ascii=False)[:140],
    )
    last_prompt = json.dumps(MockLLMHandler.calls[-1], ensure_ascii=False)
    check(
        "analyzer: prompt carries session guide + excluded ranges",
        "SESSION TOPIC GUIDE" in last_prompt and "2.0s .. 4.0s" in last_prompt,
    )

    # ---- cooperative cancellation (services/cancel.py) ---------------------- #
    # The HTTP handlers set a shared `threading.Event` on client disconnect and
    # the services raise JobCancelled at their natural boundaries.
    none_event: threading.Event | None = None
    raise_if_cancelled(none_event)  # must be a no-op
    set_event = threading.Event()
    set_event.set()
    raised_cancel: Exception | None = None
    try:
        raise_if_cancelled(set_event)
    except Exception as exc:  # noqa: BLE001 - asserting the type
        raised_cancel = exc
    check(
        "cancel: raise_if_cancelled is a no-op when unset/None and raises when set",
        isinstance(raised_cancel, JobCancelled)
        and str(raised_cancel) == "The client disconnected; the job was cancelled.",
        type(raised_cancel).__name__ if raised_cancel else "no exception",
    )

    # discover_clips must stop at the first window boundary once the cancel
    # event is set — without issuing another provider call.
    mock_calls_before = len(MockLLMHandler.calls)
    cancel_before = threading.Event()
    cancel_before.set()
    raised_discover: Exception | None = None
    try:
        asyncio.run(
            analyzer.discover_clips(
                segments=[{"start": 0.0, "end": 10.0, "text": "เนื้อหาบทเรียนตัฟซีร"}],
                duration=10.0,
                base_prompt="",
                session_guide="",
                refinement_note="",
                excluded_ranges=[],
                provider=provider,
                min_duration=3.0,
                max_duration=90.0,
                max_clips=4,
                cancel_event=cancel_before,
            )
        )
    except Exception as exc:  # noqa: BLE001 - asserting the type
        raised_discover = exc
    check(
        "analyzer: discover_clips aborts at a window boundary on cancel",
        isinstance(raised_discover, JobCancelled)
        and len(MockLLMHandler.calls) == mock_calls_before,
        f"{type(raised_discover).__name__ if raised_discover else 'no exception'} "
        f"calls={len(MockLLMHandler.calls) - mock_calls_before}",
    )

    # ---- Qur'an corpus + Arabic recitation merge -------------------------- #
    check(
        "quran: bundled corpus has 6236 verses / 114 surahs",
        quran.corpus_size() == 6236,
        f"verses={quran.corpus_size()}",
    )
    match = quran.match_text("قل هو الله احد")
    check(
        "quran: fuzzy match recovers 112:1 without diacritics",
        match is not None and match.reference == "112:1",
        match.reference if match else "no match",
    )
    check(
        "quran: ordinary Thai/Arabic commentary is not forced to a verse",
        quran.match_text("هذا حديث عادي عن الصبر") is None,
    )

    wave_path = work / "recitation.wav"
    with wave.open(str(wave_path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16_000)
        writer.writeframes(b"\x00\x00" * 32_000)

    originals = [
        transcriber.Segment(
            id=0, start=0.0, end=2.0, text="ประโยคเดิม", language="th"
        )
    ]

    async def fake_arabic(_path: Path) -> transcriber.TranscriptionResult:
        return transcriber.TranscriptionResult(
            segments=[
                transcriber.Segment(
                    id=0, start=0.0, end=1.6, text="بسم الله الرحمن الرحيم", language="ar"
                )
            ],
            duration=1.6,
            language="ar",
            language_probability=1.0,
            device="cloud",
            compute_type="cloud",
            model="mock",
            vram_unloaded=False,
        )

    async def fake_thai(_path: Path) -> transcriber.TranscriptionResult:
        return transcriber.TranscriptionResult(
            segments=[
                transcriber.Segment(id=0, start=0.0, end=1.6, text="ภาษาไทย", language="th")
            ],
            duration=1.6,
            language="th",
            language_probability=1.0,
            device="cloud",
            compute_type="cloud",
            model="mock",
            vram_unloaded=False,
        )

    spans = [
        {
            "start": 0.2,
            "end": 1.8,
            "kind": "quran",
            "reference": "1:1",
            "confidence": 0.9,
        }
    ]
    merged = asyncio.run(
        recitation.recover_arabic(
            wav_path=wave_path,
            segments=originals,
            spans=spans,
            transcribe_span=fake_arabic,
        )
    )
    check(
        "recitation: Arabic span becomes an Arabic-only, corpus-verified segment",
        len(merged) == 1
        and merged[0].language == "ar"
        and merged[0].source == "quran"
        and merged[0].reference == "1:1"
        and bool(merged[0].original_text)
        and quran.normalize_arabic(merged[0].text) == "بسم الله الرحمن الرحيم",
        f"{merged[0].source if merged else 'empty'} {merged[0].reference if merged else ''}",
    )
    kept = asyncio.run(
        recitation.recover_arabic(
            wav_path=wave_path,
            segments=originals,
            spans=spans,
            transcribe_span=fake_thai,
        )
    )
    check(
        "recitation: a Thai second pass is rejected; original Thai is kept",
        len(kept) == 1 and kept[0].text == "ประโยคเดิม" and kept[0].language == "th",
    )

    # ====================================================================== #
    # Decision tier (docs/DECISION_MODELS_PLAN.md, Phase 5)
    # ====================================================================== #
    run_decision_checks(work, source)


# --------------------------------------------------------------------------- #
# Decision tier - adapters, sanitize table, gated verification, recitation,
# sentence grouping and the deferred-unload contract.
# --------------------------------------------------------------------------- #
def run_decision_checks(work: Path, source: Path) -> None:
    provider = decision.DecisionProviderConfig(
        base_url="http://127.0.0.1:11434/v1",
        api_key=None,
        model="mock-decision",
        timeout=5.0,
        wire_format=decision.SYSTEMONE,
    )

    # ---- A. the two wire formats, parsing and provider precedence ---------- #
    check(
        "decision: only two wire formats exist and their paths never depend on the host",
        decision.decision_endpoint("http://localhost:11434/v1", "systemone")
        == "http://localhost:11434/v1/systemone"
        and decision.decision_endpoint("https://ai-gateway.vercel.sh/v1", "decisions")
        == "https://ai-gateway.vercel.sh/v1/decisions"
        and decision.decision_endpoint("https://openrouter.ai/api/v1", "systemone")
        == "https://openrouter.ai/api/v1/systemone",
        decision.decision_endpoint("http://localhost:11434/v1", "systemone"),
    )
    unknown_style: Exception | None = None
    auto_path: Exception | None = None
    try:
        decision.normalize_wire_format("bogus")
    except Exception as exc:  # noqa: BLE001 - asserting the type
        unknown_style = exc
    try:
        decision.decision_endpoint("https://ai-gateway.vercel.sh/v1", "auto")
    except Exception as exc:  # noqa: BLE001 - asserting the type
        auto_path = exc
    check(
        "decision: an unknown format is rejected and 'auto' never silently becomes a URL",
        isinstance(unknown_style, decision.DecisionError)
        and isinstance(auto_path, decision.DecisionError)
        and decision.normalize_wire_format("ollama") == decision.SYSTEMONE
        and decision.normalize_wire_format("perplexity") == decision.DECISIONS,
        f"unknown={type(unknown_style).__name__ if unknown_style else 'none'} "
        f"auto={type(auto_path).__name__ if auto_path else 'none'}",
    )

    captured: dict[str, object] = {}

    def _reply(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "model": "mock-decision",
                "answers": {
                    "kind": {
                        "type": "choice",
                        "choice": "quran",
                        "probabilities": {"quran": 0.82, "none": 0.18},
                        "confidence": 0.82,
                    },
                    "needs_fix": {"type": "noul", "noul": 0.91},
                    "fit": {
                        "type": "score",
                        "score": 2.16,
                        "legend": {
                            "0": "Unusable",
                            "1": "Weak",
                            "2": "Good",
                            "3": "Excellent",
                        },
                        "probabilities": {"0": 0.02, "1": 0.1, "2": 0.6, "3": 0.28},
                        "confidence": 0.6,
                    },
                },
            },
        )

    questions = {
        "kind": decision.Question(
            type="choice",
            instructions="Classify.",
            criteria={"quran": "Recitation.", "none": "Other."},
        ),
        "needs_fix": decision.Question(
            type="noul",
            instructions="Fix?",
            criteria={"true": "Needs a fix.", "false": "Already correct."},
        ),
        "fit": decision.Question(
            type="score",
            instructions="Score.",
            criteria=["Unusable", "Weak", "Good", "Excellent"],
        ),
    }
    transport = httpx.MockTransport(_reply)
    answers = asyncio.run(
        decision.decide(provider, {"segments": [1, 2]}, questions, transport=transport)
    )
    sent = captured.get("payload") or {}
    sent_questions = sent.get("questions", {})
    check(
        "decision.decide: one POST with model/state/questions and parsed typed answers",
        captured.get("url") == "http://127.0.0.1:11434/v1/systemone"
        and sent.get("model") == "mock-decision"
        and sent.get("state") == {"segments": [1, 2]}
        and sent_questions.get("kind", {}).get("type") == "choice"
        and answers["kind"].value == "quran"
        and abs(answers["kind"].confidence - 0.82) < 1e-9
        and answers["needs_fix"].value is True
        and answers["needs_fix"].confidence == 0.91
        and abs(answers["fit"].value - 0.72) < 1e-9,
        json.dumps(sent, ensure_ascii=False)[:140],
    )
    check(
        "decision.decide: the payload matches the System One criteria contract",
        isinstance(sent_questions.get("kind", {}).get("criteria"), dict)
        and isinstance(sent_questions.get("fit", {}).get("criteria"), list)
        and len(sent_questions["fit"]["criteria"]) == 4
        and sent_questions.get("needs_fix", {}).get("criteria")
        == {"true": "Needs a fix.", "false": "Already correct."},
        json.dumps(sent_questions, ensure_ascii=False)[:200],
    )
    check(
        "decision.decide: a noul probability becomes a boolean plus its confidence",
        abs(answers["needs_fix"].probability("true") - 0.91) < 1e-9
        and abs(answers["fit"].level - 2.16) < 1e-9
        and answers["fit"].legend.get("2") == "Good",
        f"p_true={answers['needs_fix'].probability('true')} "
        f"level={answers['fit'].level}",
    )

    # A low, well-formed noul probability reads false and keeps its confidence;
    # a well-formed score level scales. (The old "score clamps"/1.0-default
    # behavior was a defect: malformed calibration must degrade, never mint a
    # confident verdict.)
    low_transport = httpx.MockTransport(
        lambda _r: httpx.Response(
            200,
            json={
                "answers": {
                    "kind": {"type": "choice", "choice": "none",
                             "probabilities": {"quran": 0.1, "none": 0.9}},
                    "needs_fix": {"type": "noul", "noul": 0.2},
                    "fit": {"type": "score", "score": 0.75},
                }
            },
        )
    )
    low = asyncio.run(
        decision.decide(provider, "state", questions, transport=low_transport)
    )
    check(
        "decision.decide: a low noul probability reads false with its confidence",
        low["needs_fix"].value is False
        and abs(low["needs_fix"].confidence - 0.8) < 1e-9
        and low["fit"].level == 0.75
        and abs(low["fit"].value - 0.25) < 1e-9,
        f"noul={low['needs_fix'].value} conf={low['needs_fix'].confidence} "
        f"score={low['fit'].value}",
    )

    # Grossly out-of-range calibration must DEGRADE (raise DecisionError): a
    # noul=-5, confidence=99 or score level=9.0 must never become a confident
    # verdict (AGENTS.md §3 "Degradation is mandatory").
    out_of_range_cases: list[tuple[str, httpx.Response]] = [
        (
            "out-of-range noul",
            httpx.Response(
                200,
                json={
                    "answers": {
                        "kind": {"type": "choice", "choice": "quran"},
                        "needs_fix": {"type": "noul", "noul": -5},
                        "fit": {"type": "score", "score": 1.0},
                    }
                },
            ),
        ),
        (
            "out-of-range confidence",
            httpx.Response(
                200,
                json={
                    "answers": {
                        "kind": {
                            "type": "choice",
                            "choice": "quran",
                            "confidence": 99,
                        },
                        "needs_fix": {"type": "noul", "noul": False},
                        "fit": {"type": "score", "score": 1.0},
                    }
                },
            ),
        ),
        (
            "out-of-range score level",
            httpx.Response(
                200,
                json={
                    "answers": {
                        "kind": {"type": "choice", "choice": "quran"},
                        "needs_fix": {"type": "noul", "noul": False},
                        "fit": {"type": "score", "score": 9.0},
                    }
                },
            ),
        ),
    ]
    not_degraded: list[str] = []
    for label, response in out_of_range_cases:
        try:
            asyncio.run(
                decision.decide(
                    provider,
                    "state",
                    questions,
                    transport=httpx.MockTransport(lambda _r, resp=response: resp),
                )
            )
        except decision.DecisionError:
            continue
        not_degraded.append(label)
    check(
        "decision.decide: out-of-range noul/confidence/score degrade via DecisionError",
        not not_degraded,
        f"accepted as confident: {not_degraded}",
    )

    # A bare answer with no calibration must carry confidence 0.0 so callers'
    # escalation gates kick in — never a defaulted 1.0.
    bare_transport = httpx.MockTransport(
        lambda _r: httpx.Response(
            200,
            json={
                "answers": {
                    "kind": {"type": "choice", "choice": "quran"},
                    "needs_fix": {"type": "noul", "noul": True},
                    "fit": {"type": "score", "score": 1.0},
                }
            },
        )
    )
    bare = asyncio.run(
        decision.decide(provider, "state", questions, transport=bare_transport)
    )
    check(
        "decision.decide: a bare answer without calibration carries confidence 0.0",
        bare["kind"].confidence == 0.0,
        f"confidence={bare['kind'].confidence}",
    )

    bad_questions: list[tuple[str, decision.Question]] = [
        (
            "choice with string criteria",
            decision.Question(type="choice", instructions="x", criteria="labels"),
        ),
        (
            "score with one level",
            decision.Question(type="score", instructions="x", criteria=["only"]),
        ),
        (
            "noul with string criteria",
            decision.Question(type="noul", instructions="x", criteria="yes/no"),
        ),
    ]
    rejected: list[str] = []
    for label, bad in bad_questions:
        try:
            asyncio.run(
                decision.decide(
                    provider,
                    "state",
                    {"bad": bad},
                    transport=httpx.MockTransport(
                        lambda _r: httpx.Response(200, json={"answers": {}})
                    ),
                )
            )
        except decision.DecisionError:
            continue
        rejected.append(label)
    check(
        "decision.decide: a criteria shape the provider would reject fails locally",
        not rejected,
        f"accepted={rejected}",
    )

    malformed_cases: list[tuple[str, httpx.Response]] = [
        ("missing answers object", httpx.Response(200, json={"model": "x"})),
        ("missing one answer", httpx.Response(200, json={"answers": {}})),
        (
            "wrong type",
            httpx.Response(
                200,
                json={
                    "answers": {
                        "kind": {"type": "noul", "noul": True},
                        "needs_fix": {"type": "noul", "noul": True},
                        "fit": {"type": "score", "score": 0.5},
                    }
                },
            ),
        ),
        (
            "choice label absent from probabilities",
            httpx.Response(
                200,
                json={
                    "answers": {
                        "kind": {
                            "type": "choice",
                            "choice": "quran",
                            "probabilities": {"none": 1.0},
                        },
                        "needs_fix": {"type": "noul", "noul": False},
                        "fit": {"type": "score", "score": 0.5},
                    }
                },
            ),
        ),
        (
            "non-boolean noul",
            httpx.Response(
                200,
                json={
                    "answers": {
                        "kind": {"type": "choice", "choice": "quran"},
                        "needs_fix": {"type": "noul", "noul": "maybe"},
                        "fit": {"type": "score", "score": 0.5},
                    }
                },
            ),
        ),
        (
            "non-numeric score",
            httpx.Response(
                200,
                json={
                    "answers": {
                        "kind": {"type": "choice", "choice": "quran"},
                        "needs_fix": {"type": "noul", "noul": False},
                        "fit": {"type": "score", "score": "high"},
                    }
                },
            ),
        ),
        ("HTTP 500", httpx.Response(500, text="upstream exploded")),
        ("invalid JSON", httpx.Response(200, text="<html>not json</html>")),
        ("provider error object", httpx.Response(200, json={"error": "quota"})),
    ]
    untyped: list[str] = []
    for label, response in malformed_cases:
        try:
            asyncio.run(
                decision.decide(
                    provider,
                    "state",
                    questions,
                    transport=httpx.MockTransport(lambda _r, resp=response: resp),
                )
            )
        except decision.DecisionError:
            continue
        except Exception:  # noqa: BLE001 - a wrong exception type is the defect
            untyped.append(label)
            continue
        untyped.append(label)
    check(
        "decision.decide: every malformed reply raises DecisionError (never a silent answer)",
        not untyped,
        f"not rejected as DecisionError: {untyped}",
    )

    # ---- A2. the OpenAI Decisions wire shape, detection and URL override ---- #
    decisions_sent: dict[str, Any] = {}
    decisions_questions = {
        "kind": decision.Question(
            type="choice",
            instructions="Classify.",
            criteria={"quran": "Recitation.", "none": "Other."},
        ),
        "needs_fix": decision.Question(
            type="noul",
            instructions="Fix?",
            criteria={"true": "Needs a fix.", "false": "Already correct."},
        ),
        "fit": decision.Question(
            type="score",
            instructions="Score.",
            criteria=[
                "Unusable: filler",
                "Weak: thin",
                "Good: coherent",
                "Excellent: ideal",
            ],
        ),
    }

    def _decisions_reply(request: httpx.Request) -> httpx.Response:
        decisions_sent["url"] = str(request.url)
        decisions_sent["payload"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "model": "mock-decision",
                "answers": [
                    {
                        "type": "choice",
                        "name": "kind",
                        "choice": "quran",
                        "confidence": 0.82,
                        "probabilities": [
                            {"value": "quran", "probability": 0.82},
                            {"value": "none", "probability": 0.18},
                        ],
                    },
                    {"type": "predicate", "name": "needs_fix", "probability": 0.91},
                    {
                        "type": "score",
                        "name": "fit",
                        "score": 2.16,
                        "confidence": 0.6,
                        "probabilities": [
                            {"value": 0, "probability": 0.02},
                            {"value": 1, "probability": 0.1},
                            {"value": 2, "probability": 0.6},
                            {"value": 3, "probability": 0.28},
                        ],
                    },
                ],
            },
        )

    decisions_provider = decision.DecisionProviderConfig(
        base_url="https://ai-gateway.vercel.sh/v1",
        api_key="test-key",
        model="typesafe-ai/jev-1.13.0",
        timeout=5.0,
        wire_format=decision.DECISIONS,
    )
    parsed = asyncio.run(
        decision.decide(
            decisions_provider,
            {"segments": [1, 2]},
            decisions_questions,
            transport=httpx.MockTransport(_decisions_reply),
        )
    )
    sent = decisions_sent.get("payload") or {}
    sent_questions = sent.get("questions") or []
    check(
        "decision.decide: /v1/decisions sends input, named questions and choices/levels",
        decisions_sent.get("url") == "https://ai-gateway.vercel.sh/v1/decisions"
        and sent.get("input")
        == [
            {
                "role": "user",
                "content": [{"type": "input_json", "data": {"segments": [1, 2]}}],
            }
        ]
        and [item.get("type") for item in sent_questions]
        == ["choice", "predicate", "score"]
        and sent_questions[0].get("choices", [{}])[0].get("value") == "quran"
        and len(sent_questions[2].get("levels", [])) == 4
        and sent_questions[1].get("instructions", "").startswith("Fix?"),
        json.dumps(sent, ensure_ascii=False)[:200],
    )
    check(
        "decision.decide: /v1/decisions answers are read in question order",
        parsed["kind"].value == "quran"
        and abs(parsed["kind"].confidence - 0.82) < 1e-9
        and parsed["needs_fix"].value is True
        and abs(parsed["needs_fix"].probability("true") - 0.91) < 1e-9
        and abs(parsed["fit"].value - 0.72) < 1e-9
        and parsed["fit"].legend.get("2") == "Good: coherent",
        f"kind={parsed['kind'].value} noul={parsed['needs_fix'].value} "
        f"score={parsed['fit'].value}",
    )

    refusal_error: Exception | None = None
    try:
        asyncio.run(
            decision.decide(
                decisions_provider,
                "state",
                decisions_questions,
                transport=httpx.MockTransport(
                    lambda _r: httpx.Response(
                        200,
                        json={
                            "answers": [
                                {"type": "refusal", "name": "kind"},
                                {"type": "predicate", "name": "needs_fix", "probability": 0.9},
                                {"type": "score", "name": "fit", "score": 1.0},
                            ]
                        },
                    )
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001 - asserting the type
        refusal_error = exc
    check(
        "decision.decide: a refusal raises so the step degrades, never 'all good'",
        isinstance(refusal_error, decision.DecisionError),
        type(refusal_error).__name__ if refusal_error else "no exception",
    )

    decision.reset_format_cache()
    probed: list[str] = []

    def _detect_reply(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        probed.append(path)
        if path.endswith(decision.DECISIONS_PATH):
            return httpx.Response(404, text="not found")
        return httpx.Response(
            200,
            json={"answers": {"reachable": {"type": "noul", "noul": 0.99}}},
        )

    auto_provider = decision.DecisionProviderConfig(
        base_url="http://127.0.0.1:11434/v1",
        api_key=None,
        model="tev1:4b",
        timeout=5.0,
        wire_format=decision.AUTO_FORMAT,
    )
    detect_transport = httpx.MockTransport(_detect_reply)
    fmt, _probe_answer = asyncio.run(
        decision.probe(auto_provider, transport=detect_transport)
    )
    fmt_again = asyncio.run(
        decision.detect_format(auto_provider, transport=detect_transport)
    )
    check(
        "decision: auto measures the format once, caches it and never guesses by host",
        fmt == decision.SYSTEMONE
        and fmt_again == decision.SYSTEMONE
        # Detection sends one rejected probe to /decisions, one accepted probe
        # to /systemone, then the Test question itself; a second detection adds
        # no request because the measured format is cached.
        and probed
        == ["/v1/decisions", "/v1/systemone", "/v1/systemone"],
        f"fmt={fmt} probed={probed}",
    )
    decision.reset_format_cache()

    saved_model = os.environ.get("TAFSEER_DECISION_MODEL")
    saved_key = os.environ.get("TAFSEER_DECISION_API_KEY")
    try:
        os.environ["TAFSEER_DECISION_MODEL"] = ""
        off = decision.merge_decision_provider(None)
        os.environ["TAFSEER_DECISION_MODEL"] = "env-model"
        inherited = decision.merge_decision_provider(None)
        overridden = decision.merge_decision_provider(
            decision.DecisionProviderOverride(
                model="slot-model",
                api_key="",
                endpoint_style="decisions",
                endpoint_url="https://gateway.test/custom/v1/decisions",
            )
        )
        check(
            "decision: no model means Off; the per-slot model and format beat the env default",
            off is None
            and inherited is not None
            and inherited.model == "env-model"
            and overridden is not None
            and overridden.model == "slot-model"
            and overridden.wire_format == "decisions"
            and overridden.endpoint_url == "https://gateway.test/custom/v1/decisions"
            and overridden.endpoint_for("decisions")
            == "https://gateway.test/custom/v1/decisions"
            and overridden.api_key is None,
            f"off={off} inherited={getattr(inherited, 'model', None)} "
            f"slot={getattr(overridden, 'model', None)}",
        )
    finally:
        for name, value in (
            ("TAFSEER_DECISION_MODEL", saved_model),
            ("TAFSEER_DECISION_API_KEY", saved_key),
        ):
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    # ---- B. sanitize_clips rules table (one case per row) ------------------ #
    def sanitize(raw, **overrides):
        options = dict(
            duration=100.0,
            excluded_ranges=[],
            min_duration=10.0,
            max_duration=20.0,
            max_clips=8,
        )
        options.update(overrides)
        return analyzer.sanitize_clips(raw, **options)

    r1 = sanitize([42, "clip", {"start": 0.0, "end": 10.0, "title": "ok"}])
    check(
        "sanitize R1: non-object proposals are dropped",
        len(r1) == 1 and r1[0]["title"] == "ok",
        json.dumps(r1, ensure_ascii=False)[:120],
    )
    r2 = sanitize(
        [
            {"start": "abc", "end": 5.0},
            {"start": float("nan"), "end": 5.0},
            {"start": 0.0, "end": float("inf")},
        ]
    )
    check(
        "sanitize R2: missing/non-numeric/NaN/Infinity bounds are dropped",
        r2 == [],
        json.dumps(r2, ensure_ascii=False)[:120],
    )
    r3 = sanitize(
        [{"start": 8.0, "end": 130.0}],
        duration=100.0,
        max_duration=120.0,
    )
    check(
        "sanitize R3: a duration overrun is clamped into [0, duration]",
        len(r3) == 1 and r3[0]["start"] == 8.0 and r3[0]["end"] == 100.0,
        json.dumps(r3, ensure_ascii=False)[:120],
    )
    r4 = sanitize([{"start": 0.0, "end": 0.5}])
    check("sanitize R4: an empty (<1s) window is dropped", r4 == [], str(r4))
    r5_short = sanitize([{"start": 0.0, "end": 4.9}], min_duration=10.0)
    r5_edge = sanitize([{"start": 0.0, "end": 5.0}], min_duration=10.0)
    check(
        "sanitize R5: below min_duration*0.5 is dropped, the exact edge is kept",
        r5_short == [] and len(r5_edge) == 1,
        f"short={r5_short} edge={r5_edge}",
    )
    r6_long = sanitize([{"start": 0.0, "end": 31.0}], max_duration=20.0)
    r6_edge = sanitize([{"start": 0.0, "end": 30.0}], max_duration=20.0)
    check(
        "sanitize R6: above max_duration*1.5 is dropped, the exact edge is kept",
        r6_long == [] and len(r6_edge) == 1,
        f"long={r6_long} edge={r6_edge}",
    )
    r7 = sanitize(
        [{"start": 1.0, "end": 3.0}],
        excluded_ranges=[{"start": 2.0, "end": 4.0}],
    )
    check("sanitize R7: an excluded-range overlap is dropped", r7 == [], str(r7))
    r8_rank = sanitize(
        [
            {"start": 0.0, "end": 10.0, "score": 0.2, "title": "early"},
            {"start": 5.0, "end": 15.0, "score": 0.9, "title": "better"},
        ]
    )
    check(
        "sanitize R8: overlap is resolved by score rank, not 'keep earliest'",
        len(r8_rank) == 1 and r8_rank[0]["title"] == "better",
        json.dumps(r8_rank, ensure_ascii=False)[:140],
    )
    r8_long = sanitize(
        [
            {"start": 0.0, "end": 10.0, "score": 0.5, "title": "short"},
            {"start": 5.0, "end": 18.0, "score": 0.5, "title": "longer"},
        ]
    )
    r8_tie = sanitize(
        [
            {"start": 0.0, "end": 10.0, "score": 0.5, "title": "earlier"},
            {"start": 2.0, "end": 12.0, "score": 0.5, "title": "later"},
        ]
    )
    check(
        "sanitize R8 ties: longer wins, then the earlier window",
        len(r8_long) == 1
        and r8_long[0]["title"] == "longer"
        and len(r8_tie) == 1
        and r8_tie[0]["title"] == "earlier",
        f"long={r8_long} tie={r8_tie}",
    )
    r9 = sanitize(
        [
            {"start": 40.0, "end": 50.0},
            {"start": 0.0, "end": 10.0},
            {"start": 20.0, "end": 30.0},
        ],
        max_clips=2,
    )
    check(
        "sanitize R9: result is start-ordered and capped at max_clips",
        [clip["start"] for clip in r9] == [0.0, 20.0],
        json.dumps(r9, ensure_ascii=False)[:140],
    )
    check(
        "sanitize R10: internal ordering keys never leave the service",
        all(
            set(clip) == {"start", "end", "title", "rationale"}
            for clip in r8_rank + r9
        ),
    )

    # ---- C/D. corpus gate + batched triage -------------------------------- #
    real_decide = decision.decide
    real_verify_arabic = analyzer.verify_arabic
    decide_calls: list[list[str]] = []
    proofread_calls: list[str] = []

    async def fake_proofread(*, arabic_text, context_thai, provider):  # noqa: ARG001
        proofread_calls.append(arabic_text)
        return {
            "verified_text": arabic_text,
            "correction_applied": False,
            "notes": "ok",
        }

    def make_triage(flag_index: int | None = None):
        async def fake_decision(
            _provider, _state, questions, *, transport=None, cancel_event=None  # noqa: ARG001
        ):
            decide_calls.append(list(questions))
            replies: dict[str, decision.Answer] = {}
            for name in questions:
                index = int(name.removeprefix("line_"))
                flagged = flag_index is not None and index == flag_index
                replies[name] = decision.Answer(
                    name=name,
                    type="noul",
                    noul=flagged,
                    probabilities={"true": 0.9 if flagged else 0.05, "false": 0.95},
                    confidence=0.95,
                )
            return replies

        return fake_decision

    not_a_verse = "نص عربي تجريبي للاختبار"

    # C: a corpus-exact line passes with zero model calls.
    decision.decide = make_triage()  # must never be reached
    analyzer.verify_arabic = fake_proofread
    try:
        gated = asyncio.run(
            verify_service.verify_lines(
                [verify_service.VerifyLine(arabic_text=ARABIC_TEXT)],
                provider=None,
                decision_provider=provider,
            )
        )
        check(
            "verify: a corpus-exact line passes with zero decision/proofreader calls",
            len(gated.lines) == 1
            and gated.lines[0].source == "quran"
            and gated.lines[0].reference == "1:1"
            and gated.corpus_lines == 1
            and gated.triage_lines == 0
            and gated.proofread_lines == 0
            and decide_calls == []
            and proofread_calls == [],
            f"source={gated.lines[0].source if gated.lines else 'none'} "
            f"decide={len(decide_calls)} proof={len(proofread_calls)}",
        )
    finally:
        decision.decide = real_decide
        analyzer.verify_arabic = real_verify_arabic

    # D1: 40 unflagged lines -> one batched call, zero proofreads.
    decide_calls.clear()
    proofread_calls.clear()
    decision.decide = make_triage()
    analyzer.verify_arabic = fake_proofread
    try:
        skipped = asyncio.run(
            verify_service.verify_lines(
                [
                    verify_service.VerifyLine(
                        arabic_text=f"{not_a_verse} {index}", cue_id=f"cue-{index}"
                    )
                    for index in range(40)
                ],
                provider=None,
                decision_provider=provider,
            )
        )
        check(
            "verify: 40 lines cost one triage call and no proofread (batched, confidence-gated)",
            len(skipped.lines) == 40
            and all(line.source == "triage" for line in skipped.lines)
            and skipped.triage_lines == 40
            and skipped.proofread_lines == 0
            and len(decide_calls) == 1
            and len(decide_calls[0]) == 40
            and proofread_calls == []
            and [line.cue_id for line in skipped.lines] == [f"cue-{index}" for index in range(40)],
            f"decide={len(decide_calls)}/{len(decide_calls[0]) if decide_calls else 0} "
            f"proof={len(proofread_calls)}",
        )

        # D2: exactly the flagged line reaches the proofreader.
        decide_calls.clear()
        proofread_calls.clear()
        decision.decide = make_triage(flag_index=7)
        flagged = asyncio.run(
            verify_service.verify_lines(
                [
                    verify_service.VerifyLine(arabic_text=f"{not_a_verse} {index}")
                    for index in range(40)
                ],
                provider=analyzer.ProviderConfig(
                    base_url="http://127.0.0.1:9/v1",
                    api_key=None,
                    model="mock-proofreader",
                    timeout=5.0,
                ),
                decision_provider=provider,
            )
        )
        check(
            "verify: only the triaged line is proofread, the other 39 are skipped",
            flagged.proofread_lines == 1
            and flagged.triage_lines == 40
            and len(proofread_calls) == 1
            and proofread_calls[0] == f"{not_a_verse} 7"
            and sum(1 for line in flagged.lines if line.source == "triage") == 39,
            f"proof={len(proofread_calls)} triage_lines={flagged.triage_lines}",
        )

        # D3: a decision failure falls back to proofreading every line.
        decide_calls.clear()
        proofread_calls.clear()

        async def failing_decision(*_args, **_kwargs):
            raise decision.DecisionError("provider down")

        decision.decide = failing_decision
        fallback = asyncio.run(
            verify_service.verify_lines(
                [verify_service.VerifyLine(arabic_text=f"{not_a_verse} {i}") for i in range(5)],
                provider=analyzer.ProviderConfig(
                    base_url="http://127.0.0.1:9/v1",
                    api_key=None,
                    model="mock-proofreader",
                    timeout=5.0,
                ),
                decision_provider=provider,
            )
        )
        check(
            "verify: a decision failure degrades to today's per-line proofread",
            fallback.proofread_lines == 5
            and len(proofread_calls) == 5
            and all(line.source == "proofread" for line in fallback.lines),
            f"proof={len(proofread_calls)}",
        )

        # D4: no decision slot -> today's per-line loop.
        decide_calls.clear()
        proofread_calls.clear()
        legacy = asyncio.run(
            verify_service.verify_lines(
                [verify_service.VerifyLine(arabic_text=f"{not_a_verse} {i}") for i in range(5)],
                provider=analyzer.ProviderConfig(
                    base_url="http://127.0.0.1:9/v1",
                    api_key=None,
                    model="mock-proofreader",
                    timeout=5.0,
                ),
                decision_provider=None,
            )
        )
        check(
            "verify: no decision model means one proofread per line, as today",
            legacy.proofread_lines == 5
            and len(proofread_calls) == 5
            and decide_calls == [],
            f"proof={len(proofread_calls)} decide={len(decide_calls)}",
        )

        # D5: batches split at 64 questions.
        decide_calls.clear()
        proofread_calls.clear()
        decision.decide = make_triage()
        chunked = asyncio.run(
            verify_service.verify_lines(
                [verify_service.VerifyLine(arabic_text=f"{not_a_verse} {i}") for i in range(70)],
                provider=None,
                decision_provider=provider,
            )
        )
        check(
            "verify: a 70-line clip splits into two triage batches of <=64",
            len(decide_calls) == 2
            and [len(call) for call in decide_calls] == [64, 6]
            and chunked.triage_lines == 70
            and chunked.proofread_lines == 0,
            f"batches={[len(call) for call in decide_calls]}",
        )

        # D6: a flagged line without any text model is an honest error.
        decide_calls.clear()
        decision.decide = make_triage(flag_index=0)
        missing_provider: Exception | None = None
        try:
            asyncio.run(
                verify_service.verify_lines(
                    [verify_service.VerifyLine(arabic_text=not_a_verse)],
                    provider=None,
                    decision_provider=provider,
                )
            )
        except Exception as exc:  # noqa: BLE001 - asserting the type
            missing_provider = exc
        check(
            "verify: a flagged line with no proofreader raises LLMError (502), never 'all good'",
            isinstance(missing_provider, analyzer.LLMError),
            type(missing_provider).__name__ if missing_provider else "no exception",
        )
    finally:
        decision.decide = real_decide
        analyzer.verify_arabic = real_verify_arabic

    # ---- E. recitation decisions + escalator ------------------------------ #
    recitation_segments = [
        {"id": 0, "start": 0.0, "end": 2.0, "text": "บิสมิลลาฮิรเราะห์มานิรรอฮีม", "language": "th"},
        {"id": 1, "start": 2.0, "end": 3.0, "text": "นี่คือคำอธิบายภาษาไทย", "language": "th"},
        {"id": 2, "start": 3.0, "end": 4.0, "text": "อัลฮัมดุลิลลาฮิร็อบบิลอาละมีน", "language": "th"},
        {"id": 3, "start": 4.0, "end": 5.0, "text": "ร็อบบิลอาละมีน", "language": "th"},
    ]
    real_analyzer_decide = analyzer.decide
    real_audit = analyzer.audit_arabic
    audit_calls: list[list[int]] = []

    def make_recitation(labels: dict[int, str], confidence: float = 0.9):
        async def fake_decision(
            _provider, _state, questions, *, transport=None, cancel_event=None  # noqa: ARG001
        ):
            replies: dict[str, decision.Answer] = {}
            for name in questions:
                index = int(name.removeprefix("segment_"))
                label = labels.get(index, "none")
                replies[name] = decision.Answer(
                    name=name,
                    type="choice",
                    choice=label,
                    probabilities={label: confidence, "none": 1.0 - confidence},
                    confidence=confidence,
                )
            return replies

        return fake_decision

    async def escalator(*, segments, provider, cancel_event=None):  # noqa: ARG001
        audit_calls.append([int(segment["id"]) for segment in segments])
        return [
            {
                "start_id": 0,
                "end_id": 0,
                "start": 0.0,
                "end": 2.0,
                "kind": "quran",
                "reference": "1:1",
                "confidence": 0.8,
                "reason": "escalated audit",
            }
        ]

    analyzer.decide = make_recitation({0: "quran", 2: "quran", 3: "quran"})
    analyzer.audit_arabic = escalator
    try:
        spans = asyncio.run(
            analyzer.audit_arabic_decision(
                segments=recitation_segments, provider=provider, escalator=None
            )
        )
        check(
            "recitation decision: one choice batch becomes contiguous Quran spans",
            [(span["start"], span["end"], span["kind"]) for span in spans]
            == [(0.0, 2.0, "quran"), (3.0, 5.0, "quran")],
            json.dumps(spans, ensure_ascii=False)[:160],
        )

        # Low confidence escalates instead of guessing.
        audit_calls.clear()
        analyzer.decide = make_recitation(
            {0: "quran", 2: "quran", 3: "quran"}, confidence=0.3
        )
        escalated = asyncio.run(
            analyzer.audit_arabic_decision(
                segments=recitation_segments, provider=provider, escalator=escalator  # type: ignore[arg-type]
            )
        )
        check(
            "recitation decision: low-confidence segments escalate to the windowed audit",
            audit_calls == [[0, 1, 2, 3]]
            and len(escalated) == 1
            and escalated[0]["reason"] == "escalated audit",
            f"escalated={audit_calls}",
        )

        # A decision transport failure degrades to today's audit.
        audit_calls.clear()

        async def failing_recitation(*_args, **_kwargs):
            raise decision.DecisionError("offline")

        analyzer.decide = failing_recitation
        degraded = asyncio.run(
            analyzer.audit_arabic_decision(
                segments=recitation_segments, provider=provider, escalator=escalator  # type: ignore[arg-type]
            )
        )
        check(
            "recitation decision: a provider failure degrades to today's audit",
            audit_calls == [[0, 1, 2, 3]]
            and len(degraded) == 1
            and degraded[0]["reference"] == "1:1",
            f"escalated={audit_calls}",
        )

        no_escalator: Exception | None = None
        try:
            asyncio.run(
                analyzer.audit_arabic_decision(
                    segments=recitation_segments, provider=provider, escalator=None
                )
            )
        except Exception as exc:  # noqa: BLE001 - asserting the type
            no_escalator = exc
        check(
            "recitation decision: without an escalator a total failure surfaces (no silent 'no Quran')",
            isinstance(no_escalator, analyzer.LLMError),
            type(no_escalator).__name__ if no_escalator else "no exception",
        )
    finally:
        analyzer.decide = real_analyzer_decide
        analyzer.audit_arabic = real_audit

    many_segments = [
        {"id": index, "start": float(index), "end": float(index + 1), "text": "نص"}
        for index in range(70)
    ]
    _, recitation_questions = decision_tasks.recitation_request(many_segments)
    check(
        "decision_tasks: recitation requests cap at 64 questions",
        len(recitation_questions) == 64
        and "segment_63" in recitation_questions
        and "segment_64" not in recitation_questions,
        f"questions={len(recitation_questions)}",
    )

    # ---- F. sentence boundaries ------------------------------------------- #
    sentence_segments = [
        {"id": 0, "start": 0.0, "end": 1.0, "text": "ประโยคแรก"},
        {"id": 1, "start": 1.5, "end": 2.0, "text": "ต่อเนื่องกัน"},
        {"id": 2, "start": 3.5, "end": 4.0, "text": "ประโยคใหม่"},
        {"id": 3, "start": 4.0, "end": 5.0, "text": "จบประโยค."},
        {"id": 4, "start": 5.0, "end": 6.0, "text": "เริ่มใหม่"},
    ]
    starts, ambiguous = analyzer.group_sentences_heuristic(sentence_segments)
    check(
        "sentences: timestamp pauses, punctuation and length produce deterministic starts",
        starts == {0, 2, 4} and ambiguous == [0],
        f"starts={sorted(starts)} ambiguous={ambiguous}",
    )

    real_group = analyzer.group_sentences
    real_analyzer_decide = analyzer.decide

    async def fake_group(*, segments, provider, cancel_event=None):  # noqa: ARG001
        return {99: 99}

    def make_breaks(answer: bool):
        async def fake_decision(
            _provider, _state, questions, *, transport=None, cancel_event=None  # noqa: ARG001
        ):
            return {
                name: decision.Answer(
                    name=name,
                    type="noul",
                    noul=answer,
                    probabilities={"true": 0.9 if answer else 0.1},
                    confidence=0.9,
                )
                for name in questions
            }

        return fake_decision

    sentence_provider = analyzer.ProviderConfig(
        base_url="http://127.0.0.1:9/v1",
        api_key=None,
        model="mock-reasoning",
        timeout=5.0,
    )
    analyzer.group_sentences = fake_group
    try:
        analyzer.decide = make_breaks(True)
        accepted = asyncio.run(
            analyzer.group_sentences_with_decision(
                segments=sentence_segments,
                provider=sentence_provider,
                decision_provider=provider,
            )
        )
        analyzer.decide = make_breaks(False)
        rejected = asyncio.run(
            analyzer.group_sentences_with_decision(
                segments=sentence_segments,
                provider=sentence_provider,
                decision_provider=provider,
            )
        )
        check(
            "sentences: only the ambiguous gap is asked, and the answer moves the boundary",
            accepted == {0: 0, 1: 1, 2: 2, 3: 2, 4: 3}
            and rejected == {0: 0, 1: 0, 2: 1, 3: 1, 4: 2},
            f"accepted={accepted} rejected={rejected}",
        )

        async def failing_sentences(*_args, **_kwargs):
            raise decision.DecisionError("offline")

        analyzer.decide = failing_sentences
        degraded = asyncio.run(
            analyzer.group_sentences_with_decision(
                segments=sentence_segments,
                provider=sentence_provider,
                decision_provider=provider,
            )
        )
        check(
            "sentences: a decision failure falls back to the LLM grouping",
            degraded == {99: 99},
            str(degraded),
        )

        degraded_no_llm = asyncio.run(
            analyzer.group_sentences_with_decision(
                segments=sentence_segments,
                provider=None,
                decision_provider=provider,
            )
        )
        check(
            "sentences: with no LLM the heuristic map is kept, not an empty result",
            degraded_no_llm == {0: 0, 1: 0, 2: 1, 3: 1, 4: 2},
            str(degraded_no_llm),
        )

        legacy_group = asyncio.run(
            analyzer.group_sentences_with_decision(
                segments=sentence_segments,
                provider=sentence_provider,
                decision_provider=None,
            )
        )
        check(
            "sentences: no decision slot is exactly today's single LLM grouping call",
            legacy_group == {99: 99},
            str(legacy_group),
        )
    finally:
        analyzer.group_sentences = real_group
        analyzer.decide = real_analyzer_decide

    # ---- G. deferred unload (Phase 3.0) ----------------------------------- #
    class _UnloadProbeEngine(transcriber.WhisperTranscriber):
        """Records load/infer calls without touching faster-whisper."""

        def __init__(self) -> None:
            super().__init__(model_size="tiny", device="cpu", compute_type="int8")
            self.events: list[str] = []

        def _ensure_model(self):
            if self._model is None:
                self.events.append("load")
                self._model = object()
            return self._model

        def _run_transcribe(self, model, audio_path, prompt, language, vad):  # noqa: ARG002
            self.events.append("infer")
            item = type("Item", (), {"text": "สวัสดี", "start": 0.0, "end": 1.0})()
            info = type(
                "Info",
                (),
                {"language": "th", "duration": 1.0, "language_probability": 0.9},
            )()
            return iter([item]), info

    try:
        import main as sidecar_main

        engine = _UnloadProbeEngine()
        primary = engine.transcribe(source, auto_unload=False, vad_filter=False)
        span_pass = engine.transcribe(source, auto_unload=False, vad_filter=False)
        check(
            "unload: the primary and recitation span passes keep the warm model loaded",
            engine.loaded is True
            and engine.events == ["load", "infer", "infer"]
            and primary.vram_unloaded is False
            and span_pass.vram_unloaded is False,
            f"events={engine.events} loaded={engine.loaded}",
        )
        released = asyncio.run(sidecar_main._release_local_model(engine))
        released_again = asyncio.run(sidecar_main._release_local_model(engine))
        check(
            "unload: one deferred release at end-of-request frees the model, second is a no-op",
            released is True
            and released_again is False
            and engine.loaded is False
            and engine.events == ["load", "infer", "infer"],
            f"released={released} again={released_again} loaded={engine.loaded}",
        )
    except ImportError as exc:  # pragma: no cover - fastapi is a sidecar dependency
        check(
            "unload: deferred release helper is importable from the sidecar",
            False,
            f"{type(exc).__name__}: {exc}",
        )


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    # Default Windows consoles use cp1252 and die printing Thai/Arabic; force
    # UTF-8 for stdout/stderr before any output. Older Python runtimes may lack
    # reconfigure, hence the guard.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older runtimes lack reconfigure
        pass

    ffmpeg, ffprobe = resolve_tools()

    if ARTIFACTS.exists():
        shutil.rmtree(ARTIFACTS, ignore_errors=True)
    fonts_dir = ARTIFACTS / "fonts"
    work_dir = ARTIFACTS / "work"
    renders = ARTIFACTS / "renders"
    control_dir = ARTIFACTS / "control"
    for directory in (fonts_dir, work_dir, renders, control_dir):
        directory.mkdir(parents=True, exist_ok=True)

    thai_font = pick_font(["LeelawUI.ttf", "leelawad.ttf", "tahoma.ttf", "arial.ttf"])
    arabic_font = pick_font(
        ["tahoma.ttf", "trado.ttf", "segoeui.ttf", "arabtype.ttf", "arial.ttf"]
    )
    if not thai_font or not arabic_font:
        print("FATAL: no Thai/Arabic capable system font found.", file=sys.stderr)
        return 2

    mock_server = start_mock_llm()
    mock_port = int(mock_server.server_address[1])
    openrouter_server = start_mock_openrouter()
    openrouter_port = int(openrouter_server.server_address[1])

    env = os.environ.copy()
    env.update(
        {
            "TAFSEER_FFMPEG": str(ffmpeg),
            "TAFSEER_FFPROBE": str(ffprobe),
            "TAFSEER_FONTS_DIR": str(fonts_dir),
            "TAFSEER_WORK_DIR": str(work_dir),
            "TAFSEER_WHISPER_MODEL": "tiny",
            "TAFSEER_WHISPER_DEVICE": "auto",
            "TAFSEER_WHISPER_COMPUTE": "int8",
            "TAFSEER_LLM_BASE_URL": f"http://127.0.0.1:{mock_port}/v1",
            "TAFSEER_LLM_API_KEY": "",
            "TAFSEER_REASONING_MODEL": "mock-reasoning",
            "TAFSEER_FAST_MODEL": "mock-fast",
        }
    )
    os.environ.update(env)
    config.clear_path_cache()
    renderer.clear_capability_cache()

    info(f"ffmpeg : {ffmpeg}")
    info(f"fonts  : {fonts_dir}")
    info(f"mock LLM: {env['TAFSEER_LLM_BASE_URL']}")

    source = ARTIFACTS / "source_16x9.mp4"
    build_source_video(ffmpeg, source, thai_font, arabic_font)
    check(
        "Fixture: 10s 16:9 source video with Thai/Arabic text",
        source.is_file() and source.stat().st_size > 10_000,
        f"{source.name} ({source.stat().st_size // 1024} KiB)",
    )

    try:
        port = free_port()
        env["TAFSEER_PORT"] = str(port)
        os.environ["TAFSEER_PORT"] = str(port)
        with Sidecar(env, port) as sidecar:
            info(f"sidecar healthy on {sidecar.url}")
            guarded(
                "HTTP checks",
                run_http_checks,
                sidecar,
                source,
                thai_font,
                arabic_font,
                env["TAFSEER_LLM_BASE_URL"],
                f"http://127.0.0.1:{openrouter_port}",
                renders,
                control_dir,
            )
        guarded("Unit checks", run_unit_checks, source, fonts_dir)
    finally:
        mock_server.shutdown()
        openrouter_server.shutdown()

    failures = [name for name, ok, _ in RESULTS if not ok]
    print("\n" + "=" * 78)
    print(f"Phase 1 E2E: {len(RESULTS) - len(failures)}/{len(RESULTS)} checks passed")
    if failures:
        print("FAILED: " + ", ".join(failures))
    print(f"Artifacts: {ARTIFACTS}")
    print("=" * 78)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
