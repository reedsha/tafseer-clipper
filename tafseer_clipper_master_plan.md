# Master Plan: Tafseer Lecture AI Clipper & Bilingual Subtitle Studio

## 1. Project Overview & Vision

* **Product Type:** Dedicated Windows Desktop Application (`Windows 10/11`).
* **Target User:** A veteran Islamic studies / Tafseer video editor processing long-form lectures (1–3 hours) spoken primarily in **Thai** with frequent code-switching into **Classical Arabic** (Quranic recitations, Hadith, and Islamic terminology).
* **Core Goal:** Automate topic discovery and bilingual subtitling while maintaining a fast, precision human-in-the-loop workstation so the editor retains complete editorial control over clip boundaries, Arabic/Thai accuracy, and visual framing.
* **Explicit Scope Exclusions:** No channel watermark or automated intro/outro stitching (intentionally omitted to keep the workflow fast and focused).

---

## 2. Target Hardware & Tech Stack

* **Target Machine:** Windows 10/11 PC (64-bit). An NVIDIA GPU with CUDA support is **optional**: it accelerates local transcription (one-click GPU acceleration pack, no CUDA installation required) and hardware video encoding. Without a usable GPU the app always falls back to CPU transcription/encoding, and Cloud STT/LLM remains available.
* **Desktop Shell:** **Tauri v2** (Rust core + WebView2) paired with **React + TypeScript + Tailwind CSS**. Chosen for minimal RAM footprint during heavy 1080p/4K video playback and rendering.
* **Backend Engine:** **Python FastAPI Sidecar** compiled into a standalone, headless Windows executable (`backend.exe` via PyInstaller) and bundled inside the Tauri installer.
  * *Architecture Note:* Uses clean deterministic REST endpoints (`/transcribe`, `/find-clips`, `/render`) rather than LangGraph, keeping the single controlled loop in Step 2 simple, fast, and easy to debug.
* **Video & Audio Processing:** Bundled **`ffmpeg.exe`** using hardware encoding (`h264_nvenc`) when the machine supports it, with automatic fallback to CPU (`libx264`) otherwise.
* **AI Engines (Dual-Mode Local + Cloud Support):**
  * **Transcription:**
    * *Local Mode:* `faster-whisper` (`large-v3-turbo`, `int8` compute type by default), primed with an editable `initial_prompt` containing common Arabic/Islamic vocabulary and automatic GPU-memory unloading after Step 1. Runs on the GPU when available (optional one-click acceleration pack) and always falls back to CPU transcription when it is not.
    * *Cloud Mode:* External Speech-to-Text API endpoint (configurable in Settings) for faster processing or tougher Thai-Arabic code-switching.
  * **Topic Reasoning & Arabic Verification:**
    * *Cloud Mode:* Unified OpenAI-compatible API endpoint (`base_url`, `api_key`, plus separate *Reasoning Model* for Step 2 and *Fast Text Model* for Step 3).
    * *Local Mode:* **Ollama** (`http://localhost:11434/v1`) with one-click auto-detection of installed local models.

---

## 3. UI Architecture & Design System ("Ban the AI Look")

To prevent AI coding agents (OpenCode / DS Harness) from hand-rolling generic, unpolished UI components, the frontend enforces a **3-Layer Curated UI Stack** + agent skill rules:

1. **Layer 1 — Foundations (`shadcn/ui` + `Base UI` / `Radix` + `Tailwind CSS`):**
   * Accessible primitives for inputs, sliders, tabs, selects, and dialogs styled in a custom **dark neutral studio palette** (calibrated dark slate/charcoal so UI colors never distort the editor's visual judgment of video color/contrast).
2. **Layer 2 — Specialist Micro-Interaction Libraries:**
   * **`Sonner`:** Crisp stacked toast notifications for non-intrusive background status (*"Custom font imported"*, *"Whisper unloaded from GPU memory"*, *"Clip 1 of 4 rendered"*).
   * **`Vaul`:** Smooth slide-over drawers for secondary panels (*Editable Base System Prompt*, *Thai–Arabic Spelling Glossary*, *Font & Style Manager*, and *Recent Projects*) so the core editing timeline stays uncluttered.
   * **`cmdk` (`Ctrl + K` Command Palette):** Pro-editor keyboard launcher to jump directly to any clip, toggle `16:9` / `9:16`, apply subtitle style presets, run AI re-rolls, or trigger batch export without touching the mouse.
   * **`NumberFlow`:** Smoothly animated numeric transitions for batch render percentages, clip durations, timestamps, and disk cache / VRAM stats.
   * **`wavesurfer.js`:** Interactive audio waveform visualization beneath the clip trim bar so the editor can spot breaths/pauses and avoid cutting mid-word.
3. **Layer 3 — Focal Design Component ("The One-Standout Rule" via `21st.dev` / `Magic UI`):**
   * Apply visual flair strictly to **one** focal element on Step 1: a tactile, subtle glowing **Lecture Video Dropzone** (sourced/adapted from `21st.dev` / `Magic UI`), while keeping Steps 2–4 calm, tactile, and distraction-free.
4. **Agent Enforcement (`AGENTS.md` + `pick-ui-library` Skill):**
   * Include an `AGENTS.md` / `CLAUDE.md` design contract in the repository root and install Emil Kowalski's `pick-ui-library` agent skill (`npx skills add emilkowalski/skills --skill pick-ui-library`) so OpenCode / DS Harness uses these exact libraries instead of building raw custom widgets.

---

## 4. User Interface & 4-Step Linear Wizard

The application opens to a **Recent Lectures / Auto-Save Resume** bar above a persistent top progress stepper (`[1. Upload] -> [2. Find Clips] -> [3. Subtitles] -> [4. Export]`) and a global **Settings (`⚙`)** drawer/modal.

### Step 1: Ingest, Prompt Presets & Project Resume
* **Recent Projects Auto-Save List:** Displays recent `.tafseer` project files so the editor can resume any lecture directly at Step 2 or Step 3 without re-transcribing.
* **Standout Video Dropzone:** Drag-and-drop or browse for raw long-form lecture files (`.mp4`, `.mov`, `.mkv`).
* **Prompt Preset Library & Editable Base System Prompt:**
  * Dropdown selector for saved prompt presets (e.g., *"60s Emotional Hooks for TikTok"*, *"3–5 Min Fiqh Q&A for YouTube"*, *"Stories of the Prophets"*).
  * Expandable `Vaul` drawer or inline editor to view, edit, and save the underlying Base System Prompt directly in the UI.
* **Optional Session Topic Guide:** Text area for video-specific notes (e.g., *"Focus on stories of the Prophets and practical rulings; ignore the first 10 minutes of audio checks"*).
* **Engine Toggles:** Quick switches for Transcription (`Local Faster-Whisper` vs. `Cloud API`) and Topic Analysis (`Cloud Unified API` vs. `Local Ollama`).

### Step 2: Iterative Clip Discovery ("Keep & Re-roll" Loop)
* **Layout:** Split-screen workstation.
  * **Left Panel (Proposed Clips List):** Cards showing Clip Title, Start/End Timestamps, animated duration (`NumberFlow`), a 1-sentence AI rationale, and an **`[✓ Approve]`** toggle.
  * **Right Panel (Instant Video Player + Audio Waveform Trim):** Instant seek video player paired with a `wavesurfer.js` audio waveform, fine-grained `Start`/`End` nudge controls (`-0.2s` / `+0.2s`), and configurable **Auto-Pad Cut Buffer** (e.g., `+0.3s` before/after speech).
* **The Keep & Re-roll Loop:**
  1. Editor marks good clips as **`[✓ Approved]`**.
  2. Editor optionally enters a refinement note (e.g., *"Search the second half for shorter 60-second reminders"*).
  3. Editor clicks **\[Re-run AI on Unapproved Parts\]**.
  4. The backend locks all `[✓ Approved]` timestamp intervals, passes them as exclusions, and instructs the LLM to search only the unclaimed segments of the lecture.

### Step 3: Bilingual Subtitle Studio (Dual-Line Quranic Styling)
* **Clip Switcher:** Top tabs for each approved clip.
* **Left Panel (Synchronized Thai + Arabic Transcript Editor):**
  * Automatically distinguishes **Arabic Quranic/Hadith lines (RTL)** from **Thai explanation lines (LTR)**—supporting stacked **Dual-Line Quranic Styling** (Arabic verse on top + Thai translation underneath) as well as standalone Thai lines.
  * **Auto-Corrected via Spelling Glossary:** Pre-cleaned using the editor's custom Thai–Arabic Find & Replace dictionary.
  * **One-Click "Verify Quran / Fix Arabic" Button:** Sends any selected Arabic block to the Fast Text LLM to verify Uthmani spelling and Harakat against authentic scripture.
  * **Smart Auto-Line Wrapping & Splitting:** Automatically wraps Thai captions at a configurable `Max Characters Per Line` (default `40 chars`), plus `Ctrl + Enter` to split blocks at the cursor.
* **Right Panel (Live Aspect Ratio, Safe-Zone & Dual-Typography Preview):**
  * **Aspect Ratio Toggle:** Switch between **`16:9 Widescreen`** (YouTube/Facebook) and **`9:16 Vertical`** (TikTok/Reels/Shorts).
  * **9:16 Framing Modes:** *Blurred Background Fill* (default—preserves slides/wide shots inside blurred vertical bars) or *Smart Center Crop*.
  * **Platform Safe-Zone Overlay Toggle:** Overlays translucent TikTok / Reels / Shorts UI guides (right-side Like/Comment buttons and bottom description area) so subtitles are never covered up.
  * **Independent Thai vs. Arabic Style Controls + Presets:** Separate font family, font size, text color (e.g., warm gold for Arabic Quran, crisp white for Thai), outline/box opacity, and vertical diacritics/Harakat padding, saved as 1-click **Visual Style Presets**.

### Step 4: Batch Render & Export
* **Export Queue:** Lists finalized clips with target resolution (`1920x1080` or `1080x1920`), framing mode, and sanitized Windows output filenames based on customizable templates (e.g., `{LectureName}_Clip{01}_{Title}.mp4`).
* **Subtitle Output Options:**
  * **Burned-in Subtitles (Hardsubs):** Default on, rendered via `.ass` (Advanced SubStation Alpha) referencing local imported fonts so Thai diacritics and Arabic script render identically across all platforms.
  * **Soft Subtitles (`.srt`):** Toggleable **`[✓] Also export .SRT file`** checkbox alongside the MP4.
* **Hardware Acceleration & Progress:** **`[✓] Hardware encoding (GPU)`** toggle (NVIDIA NVENC when available, automatic CPU fallback) and real-time per-clip progress bars powered by `NumberFlow` + SSE streaming.

---

## 5. Comprehensive Configuration UI (`Settings ⚙` & `Ctrl+K`)

All power-user configurations live inside a clean tabbed Settings modal/drawer:

1. **AI Providers & Models Tab:**
   * **Unified Cloud API:** `Base URL`, `API Key`, **`[Test Connection]`** button, **Reasoning Model** selector (Step 2), and **Fast Text Model** selector (Step 3 Arabic verification).
   * **Local Ollama:** `Ollama URL` (`http://localhost:11434/v1`) + **`[Auto-Detect Installed Models]`** button.
   * **Cloud STT API:** Optional external speech-to-text endpoint & API key.
2. **Fonts & Dual-Line Style Presets Tab:**
   * **Custom Font Importer (`[+ Import .TTF / .OTF]`):** Copies user font files directly into the app's local `fonts/` directory so FFmpeg `.ass` rendering always resolves Thai and Uthmani Arabic fonts reliably.
   * **Dual-Line Defaults:** Default Arabic style (font, size, gold/white color, Harakat line-height padding) vs. Default Thai style (font, size, color, outline/background box, max chars per line).
   * **Saved Style Presets Manager:** Create, rename, and delete 1-click visual themes.
3. **Thai–Arabic Glossary & Whisper Tab:**
   * **Islamic Spelling Auto-Replace Table:** Editable Find & Replace pairs (e.g., `อัลเลาะห์ -> อัลลอฮฺ`, `ซอฮาบะห์ -> เศาะฮาบะฮฺ`) applied automatically post-transcription.
   * **Whisper Arabic Hint (`initial_prompt`):** Editable vocabulary list of Surahs and Islamic terms to improve Thai-to-Arabic code-switching accuracy.
   * **GPU & Performance Controls:** GPU acceleration status with a one-click **GPU acceleration pack** (downloads the CUDA runtime/cuDNN once — no manual CUDA installation), Whisper compute precision (`Automatic`/`int8` default), and **`[✓] Unload Whisper from GPU memory after Step 1`** toggle. CPU transcription/encoding is always available as a fallback.
4. **Editor & Export Defaults Tab:**
   * **Cut Buffer Padding:** Default pre/post speech padding in seconds (e.g., `0.3s`).
   * **Filename Template:** Pattern builder (`{LectureName}_Clip{01}_{Title}`) with automatic Windows forbidden-character (`\ / : * ? " < > |`) sanitization.
   * **Keyboard Shortcuts Reference:** Built-in cheat sheet (`Space` Play/Pause, `J/K/L` Shuttle, `Left/Right` `0.2s` Nudge, `Ctrl+Enter` Split Subtitle, `Ctrl+K` Command Palette).
5. **Storage, Auto-Save & Backup Tab:**
   * **Auto-Save Interval & Project Folder:** Location for `.tafseer` auto-save files.
   * **Disk Cache Manager:** Displays temporary WAV/preview size with a **`[Clear Temp Cache]`** button.
   * **Portable Settings Backup:** **`[Export Settings (.json)]`** and **`[Import Settings (.json)]`** to back up or transfer all API keys, custom fonts, glossaries, and prompt presets.

---

## 6. Technical Specifications & Backend Contracts

### A. FastAPI Sidecar Endpoints (`localhost:8008`)
1. `GET /health` — Confirms sidecar readiness and reports hardware capability: `acceleration` (`transcription: gpu|cpu`, `encoding: gpu|cpu`, `gpu_detected`, `gpu_name`, `cuda_runtime`, `pack_installed`, `reason`), plus CUDA/NVENC/VRAM details. It also carries additive, backward-compatible `providers` (`ollama: { detected, url, models[] }`) and `hardware: { tier: high|medium|low }` blocks so the UI can offer one-click local AI setup with an honest, vendor-neutral capability verdict. This is response enrichment of an existing endpoint — it does **not** add a seventh endpoint.
2. `POST /extract-and-transcribe` — Extracts 16kHz WAV via FFmpeg, runs `faster-whisper` (GPU when available, CPU fallback otherwise) or Cloud STT, applies the Thai–Arabic Spelling Glossary, and unloads the Whisper model from GPU memory if enabled.
3. `POST /discover-clips` — Sends transcript + `base_prompt` + `session_guide` + `refinement_note` + `excluded_ranges` to Unified Cloud API or Ollama; returns structured JSON clip proposals.
4. `POST /verify-arabic` — Sends an Arabic subtitle line + surrounding Thai context to the Fast Text LLM to verify Uthmani Quranic/Hadith spelling.
5. `POST /fonts/import` — Copies `.ttf`/`.otf` files into the local `fonts/` directory and returns available font family names for WebView preview and FFmpeg `fontsdir`.
6. `POST /render-batch` — Generates `.ass` files (with separate `[V4+ Styles]` for `ArabicStyle` and `ThaiStyle` + `fontsdir` pointing to local `fonts/`), executes FFmpeg with hardware encoding when available (automatic CPU fallback), exports optional `.srt` files, and streams SSE progress.

### B. FFmpeg Dual-Style `.ASS` & 9:16 Blur-Fill Pipeline
* **Dual-Line `.ASS` Styles:** Python generates two distinct styles inside the `.ass` header (`Style: ArabicStyle,...` and `Style: ThaiStyle,...`) with `PlayResX`/`PlayResY` locked to target output resolution (`1080x1920` or `1920x1080`) and passes `fontsdir='./fonts'` to FFmpeg's `ass` filter so custom imported Thai and Arabic fonts render identically to the React preview.
* **9:16 Blurred Background Filtergraph:**
  ```text
  [0:v]split=2[main][bg];
  [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[blurred];
  [main]scale=1080:-2[fg];
  [blurred][fg]overlay=(W-w)/2:(H-h)/2,ass='subtitles.ass':fontsdir='./fonts'[outv]
  ```

---

## 7. Repository Folder Structure

```text
tafseer-clipper/
├── AGENTS.md                   # UI rules & library enforcement for OpenCode / DS Harness
├── src-tauri/                  # Tauri v2 Rust shell & sidecar configuration
│   ├── binaries/               # Bundled ffmpeg.exe & compiled backend.exe
│   ├── src/main.rs             # Window lifecycle, sidecar spawn, native file dialogs
│   └── tauri.conf.json         # External binary permissions & Windows MSI config
├── src/                        # React + TypeScript Frontend
│   ├── components/
│   │   ├── StepperHeader.tsx   # Top 4-step navigation + Settings & Ctrl+K triggers
│   │   ├── VideoPlayer.tsx     # Precision seek, safe-zone overlay & trim preview
│   │   ├── WaveformBar.tsx     # wavesurfer.js audio waveform scrubber
│   │   ├── CommandMenu.tsx     # cmdk (Ctrl+K) pro-editor quick action palette
│   │   └── SettingsDrawer.tsx  # Vaul/Modal tabbed config (APIs, Fonts, Glossary, Cache)
│   ├── steps/
│   │   ├── Step1Ingest.tsx     # Recent projects, standout dropzone, Prompt Presets
│   │   ├── Step2Discovery.tsx  # Keep & Re-roll clip approval + waveform trim
│   │   ├── Step3Subtitles.tsx  # Dual-line Thai/Arabic editor + 9:16 safe-zone preview
│   │   └── Step4Export.tsx     # Batch render queue, filename templates & .SRT toggles
│   ├── store/
│   │   ├── projectStore.ts     # Zustand project state + .tafseer auto-save serializer
│   │   └── settingsStore.ts    # Persistent user config, style presets & glossary
│   └── App.tsx
├── backend/                    # Python FastAPI Sidecar
│   ├── fonts/                  # Local imported .ttf / .otf fonts for FFmpeg & UI
│   ├── services/
│   │   ├── transcriber.py      # faster-whisper (GPU when available, CPU fallback) + Glossary
│   │   ├── analyzer.py         # OpenAI/Ollama client + excluded-range & Arabic check
│   │   ├── subtitle_gen.py     # Dual-style .ASS (Arabic + Thai) & .SRT generator
│   │   └── renderer.py         # FFmpeg encoder (hardware when available, CPU fallback) + SSE progress
│   ├── main.py                 # FastAPI app & endpoints
│   ├── requirements.txt
│   └── build_sidecar.spec      # PyInstaller config to build backend.exe
└── master_plan.md              # This specification document
```

---

## 8. Phased Implementation Plan (For AI Coding Agents)

* **Phase 1: Backend Core & Bilingual FFmpeg Verification**
  * Set up Python FastAPI server with `/extract-and-transcribe`, `/discover-clips`, `/verify-arabic`, `/fonts/import`, and `/render-batch`.
  * Verify `faster-whisper` (GPU when available, CPU fallback, GPU-memory unload) on mixed Thai/Arabic audio and test FFmpeg `9:16` blur-fill rendering with dual-style `.ass` subtitles and local `fontsdir`.
* **Phase 2: UI Foundation & Design System Setup**
  * Scaffold Tauri v2 + React + TypeScript + Tailwind, install `shadcn/ui` (`Base UI`/`Radix`), `Sonner`, `Vaul`, `cmdk`, `NumberFlow`, `wavesurfer.js`, and configure `AGENTS.md` + `pick-ui-library` skill.
  * Build the dark studio theme, `SettingsDrawer`, and `.tafseer` auto-save/resume store.
* **Phase 3: 4-Step Wizard & Dual-Line Preview Polish**
  * Implement Steps 1–4 including the Keep & Re-roll loop, `wavesurfer.js` trim bar, TikTok/Reels safe-zone overlays, and synchronized live dual-line Thai/Arabic preview matching FFmpeg `.ass` output.
* **Phase 4: Sidecar Packaging for Windows**
  * Compile the Python backend via PyInstaller (`backend.exe`), bundle `ffmpeg.exe`, configure Tauri `externalBin`, and generate the standalone Windows `.msi` / `.exe` installer.