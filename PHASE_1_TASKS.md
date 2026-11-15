# PHASE_1_TASKS.md — Backend Core & Bilingual FFmpeg Verification

Status: **implemented and verified** (see [Verification](#verification)).
Scope: `backend/` only. No frontend, Tauri or packaging changes were made.

---

## 1. FastAPI Endpoints & Pydantic Schemas

All six endpoints live in `backend/main.py`; every model is a Pydantic v2
`BaseModel` with `Field` descriptions, validators and explicit bounds.

*   [x] **`GET /health`**
    *   Response: `HealthResponse`
        ```
        status: Literal["ok"]
        version: str
        cuda_available: bool          # CTranslate2 sees a CUDA device
        nvenc_available: bool         # real 1-frame NVENC probe, not just compiled-in
        vram_mb: int                  # nvidia-smi total, 0 when unknown
        ffmpeg_available: bool
        ffmpeg_path: str | None
        ffprobe_available: bool
        fonts_dir: str
        work_dir: str
        whisper: {model, loaded, device, compute_type}
        ```

*   [x] **`POST /extract-and-transcribe`**
    *   Request `TranscribeRequest`:
        ```
        file_path: str (required)
        use_local_whisper: bool = True
        initial_prompt: str = ""
        language: str | None = None
        glossary: dict[str, str] = {}
        model: str | None = None          # faster-whisper size override
        device: Literal["auto","cuda","cpu"] = "auto"
        compute_type: str | None = None   # "int8" default
        auto_unload: bool | None = None
        vad_filter: bool = True
        cloud: CloudSttConfig | None      # base_url, api_key, model, language
        ```
    *   Response `TranscribeResponse`:
        ```
        transcript_id: str, status: Literal["completed"], duration: float,
        language, language_probability, segments: list[TranscriptSegment],
        audio_path: str, model: str, device: str, compute_type: str,
        vram_unloaded: bool
        ```
        `TranscriptSegment = {id, start, end, text, language}`.
    *   Errors: `400` missing file, `503` faster-whisper/CUDA unavailable,
        `400` cloud config missing.

*   [x] **`POST /discover-clips`**
    *   Request `DiscoverRequest`:
        ```
        transcript_id: str (required)
        base_prompt: str = ""
        session_guide: str = ""
        refinement_note: str = ""
        excluded_ranges: list[TimeRange] = []
        max_clips: int = 8 (1..50)
        min_duration: float = 15.0, max_duration: float = 90.0
        language: str = "th"
        provider: ProviderOverride | None
        ```
    *   Response `DiscoverResponse`:
        ```
        clips: [{start, end, title, rationale}], model: str,
        excluded_ranges_applied: int
        ```
    *   Post-processing: clamp to media duration, drop overlaps with approved
        ranges, drop overlaps between proposals, sort, cap at `max_clips`.

*   [x] **`POST /verify-arabic`**
    *   Request: `{arabic_text, context_thai, provider?}`
    *   Response: `{verified_text, correction_applied, notes, model}`

*   [x] **`POST /fonts/import`**
    *   Accepts **either** `multipart/form-data` (field `files`, used by the
        Tauri dialog) **or** JSON `{font_paths: [str]}`.
    *   Validates the TTF/OTF magic bytes, copies into `fonts/`, reads the
        OpenType `name` table (family/style) with fontTools.
    *   Response: `{imported_fonts: [str], fonts: [{family, style, path, format}], fonts_dir}`

*   [x] **`POST /render-batch`** (SSE)
    *   Request `RenderBatchRequest`:
        ```
        project_name: str = "tafseer"
        source_path: str | None      # or transcript_id (resolved from the store)
        transcript_id: str | None
        clips: [RenderClip]  (1..200)
          RenderClip = {start, end, title, output_path?, subtitles: [SubtitleCue]}
          SubtitleCue = {start, end, arabic, thai}
        resolution: Literal["1080x1920","1920x1080"] = "1080x1920"
        framing: Literal["blur-fill","center-crop"] = "blur-fill"
        use_nvenc: bool = True
        export_srt: bool = False
        output_dir: str | None
        filename_template: str = "{LectureName}_Clip{01}_{Title}.mp4"
        subtitle_timebase: Literal["clip","source"] = "clip"
        styles: {arabic: StyleSpec, thai: StyleSpec}
        ```
    *   SSE events: `start`, `progress`, `fallback`, `clip_done`, `clip_error`,
        `done`. Every payload carries `progress` (0..1 overall) and `status`
        (`processing` | `completed` | `error`), plus per-clip detail, encoder
        and output path.
    *   Errors before streaming: `422` invalid clip range, `400` no source,
        `503` no ffmpeg.

---

## 2. Logic Implementation

*   [x] **faster-whisper CUDA int8 + VRAM unloading** — `backend/services/transcriber.py`
    *   `extract_audio()`: FFmpeg `-ac 1 -ar 16000 -c:a pcm_s16le`.
    *   `WhisperTranscriber._ensure_model()`: lazy `WhisperModel(model, device, compute_type)`
        with `compute_type="int8"` by default (4–6 GB GTX), `device="auto"`
        resolving through `ctranslate2.get_cuda_device_count()` (torch fallback).
    *   `transcribe()`: VAD filter (500 ms), editable `initial_prompt`, beam 5,
        glossary applied per segment.
    *   `unload()`: drops the CTranslate2 model reference, `gc.collect()`,
        `torch.cuda.empty_cache()/ipc_collect()` when torch is present, then logs
        “faster-whisper unloaded from VRAM”. Called automatically after Step 1
        when `auto_unload` is on; a one-off model override is always unloaded.
    *   Glossary: `apply_glossary()` replaces longest keys first.

*   [x] **Dual-style `.ass` + 9:16 blur-fill filtergraph** — `backend/services/subtitle_gen.py`, `backend/services/renderer.py`
    *   `.ass` header: `PlayResX/PlayResY` locked to the export resolution,
        `WrapStyle: 2`, `ScaledBorderAndShadow: yes`, `YCbCr Matrix: TV.709`.
    *   Styles: `ArabicStyle` (Tahoma, gold `&H007AD3FF`, MarginV 252) and
        `ThaiStyle` (Leelawadee UI, white `&H00FFFFFF`, MarginV 150) at
        1080x1920; 1920x1080 uses 54/38 pt and 142/80 px margins.
    *   Events: each cue emits up to two `Dialogue` lines so the Arabic and Thai
        lines keep independent fonts, margins and Harakat padding.
    *   Colours are normalised from `#RRGGBB` to `&HAABBGGRR`.
    *   Filtergraph (`framing="blur-fill"`):
        ```text
        [0:v]split=2[main][bg];
        [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5,setsar=1[blurred];
        [main]scale=1080:-2:flags=lanczos,setsar=1[fg];
        [blurred][fg]overlay=(W-w)/2:(H-h)/2,ass=filename='…clip_01.ass':fontsdir='…/fonts'[outv]
        ```
        Windows paths are escaped (`C\:/…`) for the filter parser.
    *   Encode: `h264_nvenc -preset p5 -rc vbr -cq 21` first, automatic full-clip
        retry with `libx264 -preset medium -crf 18`; audio `aac 192k/48k`,
        `-movflags +faststart`. Progress is parsed from `-progress pipe:1`.
    *   `.srt` sidecar written next to the MP4 when `export_srt` is true.

---

## 3. Deviations from the original checklist (all additive)

| Original | Implemented | Why |
|---|---|---|
| `render-batch` request had no source reference | `source_path` **or** `transcript_id` | the renderer must know which video to cut |
| SSE `{progress, status}` only | adds `job_id`, `clip_index`, `encoder`, `fallback` events, paths | UI progress + Sonner toasts |
| `/fonts/import` JSON only | also `multipart/form-data` | Tauri native dialog uploads files |
| — | `backend/config.py` | env-driven settings shared by all services |
| `nvenc_available` = compiled-in | real one-frame probe | a compiled-in encoder still fails on old drivers |
| `.srt` in the job temp dir | `.srt` next to the MP4 | Step 4 says “alongside the MP4” |
| `subtitle_timebase` absent | `clip` (default) / `source` | Step 3 edits clip-relative times |

---

## Verification

`backend/test_phase1_e2e.py` — **42/42** checks pass on this machine
(Windows 11, FFmpeg 9.0.2 essentials, GTX with 4096 MB VRAM).

```powershell
$env:TAFSEER_FFMPEG   = "…\ffmpeg.exe"   # or place it in src-tauri/binaries/
$env:TAFSEER_FFPROBE  = "…\ffprobe.exe"
python backend/test_phase1_e2e.py
```

The verification run used FFmpeg 9.0.2 essentials kept outside the repository
(`%LOCALAPPDATA%\tafseer-clipper-tools\ffmpeg\bin`); the script auto-detects
that folder so `python test_phase1_e2e.py` works without extra setup.

The script:

1. builds a 10 s, 1920x1080 fixture with Thai + Arabic on-screen text and an
   AAC track;
2. boots the real sidecar on a free port with a mock OpenAI-compatible LLM;
3. imports `LeelawUI.ttf` + `tahoma.ttf` through `/fonts/import` (multipart,
   JSON, invalid-font rejection);
4. renders two 9:16 blur-fill clips with dual-line cues via `/render-batch`
   and asserts SSE sequence, encoder reporting, NVENC→CPU fallback, 1080x1920
   H.264 + audio, ~5 s duration and the `.ass`/`.srt` artefacts;
5. renders the same clips **without** subtitles and diffs frames: 2.0 % of the
   subtitle band changed, 0.0 % above it, with 4 005 warm-gold and 2 001
   crisp-white pixels — proof that both styles burned in;
6. proves `fontsdir` is real (imported family ≠ bogus family rendering);
7. exercises `/verify-arabic` over HTTP and `discover_clips` exclusion logic
   against the mock provider;
8. checks the `/extract-and-transcribe` error contract and a real 16 kHz mono
   WAV extraction, plus the Thai–Arabic glossary and the 422/400/404 contracts.

Artifacts (source, MP4s, frames) land in `backend/.e2e/` and are regenerated on
each run.

### Not verifiable on this machine

* **CUDA int8 inference** — `faster-whisper`/CTranslate2 are not installed and
  there is no working CUDA runtime here, so `/extract-and-transcribe` was
  verified through its 503 error path, the WAV extraction and the glossary.
* **NVENC encode** — the GPU driver (12.2) is older than FFmpeg 9.0.2 requires
  (13.1), so the render exercised the automatic `libx264` fallback instead.
  `/health` now reports `nvenc_available: false` correctly for this driver.

Both paths are implemented and their failure handling is covered by the test.

---

## Next (Phase 4, not part of this phase)

* `backend/build_sidecar.spec` is still the skeleton placeholder: PyInstaller
  packaging, `ffmpeg.exe` bundling and Tauri `externalBin` wiring belong to
  Phase 4 of the master plan.
