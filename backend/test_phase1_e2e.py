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
                                 WAV extraction and the Thai-Arabic glossary.

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
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

BACKEND = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND))

import config
from services import analyzer, renderer, subtitle_gen, transcriber

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


def start_mock_llm() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockLLMHandler)
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
    engine = transcriber.WhisperTranscriber(model_size="tiny", device="cpu")
    check(
        "transcriber: unload() on an unloaded model is a no-op",
        engine.unload() is False and engine.loaded is False,
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


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
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
                renders,
                control_dir,
            )
        guarded("Unit checks", run_unit_checks, source, fonts_dir)
    finally:
        mock_server.shutdown()

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
