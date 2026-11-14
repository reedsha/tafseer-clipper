# AGENTS.md — Design & Architecture Contract

**Authoritative specification:** `tafseer_clipper_master_plan.md` (Sections 3, 6, 7). If anything in this file conflicts with the master plan, the master plan wins.

**Current phase:** Phase 1 (backend core) is implemented under `backend/` and verified by `backend/test_phase1_e2e.py`. The Phase 2 shell (`StepperHeader`, `SettingsDrawer`, `CommandMenu`, `.tafseer` auto-save) and the full Phase 3 wizard (Steps 1–4: ingest, Keep & Re-roll discovery, bilingual subtitle studio, batch export) are implemented under `src/`, with the Tauri v2 shell under `src-tauri/` — this repository root is the canonical frontend root per the master plan's Section 7 layout. Phase 4 packaging is implemented and built in this checkout: frozen `backend.exe` (PyInstaller) + bundled `ffmpeg.exe`/`ffprobe.exe`, per-user NSIS installer with an Authenticode signing hook and signed auto-updater artifacts (see `release/0.1.0/`, `docs/RELEASING.md`, `docs/RELEASE_CHECKLIST.md`). **Do not write application code** (components, endpoints, services, stores, Tauri config) outside a phase the user explicitly instructs you to begin from Section 8.

Violation of any rule below is a defect. Do not propose alternatives; do not "improve" the stack.

---

## 1. The 3-Layer UI Stack (Mandatory, No Substitutions)

The frontend exists to prevent generic, hand-rolled, AI-looking UI. Every piece of interface must come from one of the three approved layers.

### Layer 1 — Foundations: `shadcn/ui` + `Base UI` / Radix + Tailwind CSS
- All primitives — buttons, inputs, sliders, tabs, selects, dialogs, switches, checkboxes, tooltips, popovers — come from **shadcn/ui** (Base UI / Radix primitives) styled with **Tailwind CSS**.
- **NEVER** hand-roll a primitive widget or copy raw HTML/CSS widgets that shadcn/ui already covers.
- **NEVER** install another component library: no MUI, Ant Design, Chakra, HeroUI, React Aria hand-assemblies, NextUI, Blueprint, or similar.
- All styling uses Tailwind utility classes and the shadcn/ui CSS-variable token system defined by the dark studio theme (Section 2). No inline style objects for theming, no CSS-in-JS libraries (no styled-components, no Emotion).

### Layer 2 — Specialist Micro-Interaction Libraries (Exact Jobs)
These five libraries are pre-approved. Use each only for its assigned job:

| Library | Mandatory use | Forbidden use |
|---|---|---|
| **Sonner** | All toast/notifications (background status, errors, confirmations) | Never build custom toasts, never use other toast libs (react-hot-toast, react-toastify, Notistack) |
| **Vaul** | Slide-over drawers for secondary panels: Settings ⚙, Editable Base System Prompt, Thai–Arabic Spelling Glossary, Font & Style Manager, Recent Projects | Never build custom slide-overs; dialogs that are genuinely modals may use shadcn/ui `Dialog`, but anything sliding/drawer-shaped is Vaul |
| **cmdk** | The `Ctrl + K` Command Palette (`src/components/CommandMenu.tsx`) and nothing else | Never hand-build a command palette or fuzzy-search overlay |
| **NumberFlow** | Every animated number: render percentages, clip durations, timestamps, disk cache / VRAM stats | Never animate numbers manually (no CSS counters, no hand-written requestAnimationFrame counters) |
| **wavesurfer.js** | The audio waveform scrubber beneath the clip trim bar (`src/components/WaveformBar.tsx`) | Never draw waveforms on a raw `<canvas>` by hand |

### Layer 3 — Focal Design Component (The One-Standout Rule)
- `21st.dev` / `Magic UI` components may be used for **exactly one element in the entire app: the Lecture Video Dropzone on Step 1** (`src/steps/Step1Ingest.tsx`) — a tactile, subtle glowing dropzone.
- **Everywhere else (Steps 2, 3, 4 and all chrome) the UI must stay calm, tactile, and distraction-free.** No glow, no animated gradient borders, no particle effects, no confetti, no "AI look" flourish anywhere outside that dropzone.
- Do not add a second Magic UI / 21st.dev component. Do not upgrade the dropzone into a spectacle.

### Agent Enforcement
- This file (`AGENTS.md`) is the design contract; keep it in sync with any approved stack change and treat it as binding instructions.
- If the `pick-ui-library` agent skill is available (`npx skills add emilkowalski/skills --skill pick-ui-library`), follow it; it must agree with this file.

---

## 2. Dark Studio Theme (Mandatory)

- **Palette:** custom **dark neutral studio palette** — calibrated dark slate/charcoal, low chroma, no bright surfaces. The purpose is that UI colors never distort the editor's visual judgment of video color/contrast.
- **Dark-only.** There is no light theme. All shadcn/ui tokens (background, foreground, card, border, accent, muted, ring, destructive) are defined as dark-slate/charcoal CSS variables. Tailwind's `dark` variant is the default state, not an opt-in.
- **No pure `#FFFFFF` backgrounds, no saturated brand gradients in chrome.** Accent use is restrained; the UI reads as neutral equipment.
- **Content colors, not theme colors:** warm gold for Quranic Arabic text and crisp white for Thai subtitle text are *content/preview* colors inside the subtitle preview and `.ass` output only — they do not leak into app chrome.
- Video preview areas must not add color overlays, tints, or filters that alter perceived video color.

---

## 3. FastAPI Sidecar Architecture (Mandatory)

- **Desktop shell:** Tauri v2 (Rust + WebView2). The React app is a renderer only.
- **Backend:** a **Python FastAPI sidecar** on a loopback port (dynamic: the Tauri shell probes a free `127.0.0.1` port at startup and injects `window.__TAFSEER_SIDECAR_URL__`; `8008` is the fallback for a manually started backend), packaged as `backend.exe` (PyInstaller, `backend/build_sidecar.spec`) and bundled in `src-tauri/binaries/` alongside `ffmpeg.exe`.
- **All heavy work lives in the sidecar.** The frontend never runs transcription, LLM calls, FFmpeg, file-heavy AI processing, or Python-equivalent logic itself.

### Allowed frontend ↔ backend surface (REST + SSE only)
1. `GET /health`
2. `POST /extract-and-transcribe`
3. `POST /discover-clips`
4. `POST /verify-arabic`
5. `POST /fonts/import`
6. `POST /render-batch` (SSE progress stream)

- Do **not** add endpoints, GraphQL, WebSockets, LangGraph, or an agent framework. The architecture is a simple deterministic REST loop (Section 2 of the master plan).
- Do **not** call OpenAI-compatible APIs, Ollama, or Whisper directly from the frontend; all provider configuration flows through the sidecar.
- Long-running progress reaches the UI **only** via SSE from `/render-batch` (rendered with NumberFlow + shadcn/ui progress).
- **Tauri's role is limited to:** window lifecycle, spawning/pinging the sidecar, injecting the sidecar URL at boot, native file dialogs, scoped file-system access for `.tafseer` project auto-save (the `tauri-plugin-fs` permissions are scoped to `$LOCALDATA`/`$APPDATA`/`$HOME`/`$DOCUMENT` and are used only to write/read/delete project snapshots), the signed auto-updater (`tauri-plugin-updater` verifies update signatures in Rust; the renderer only triggers check/download/install and relaunches via `tauri-plugin-process`), and provisioning the **optional GPU acceleration pack** (download + SHA-256 verification into `%LOCALAPPDATA%`; the sidecar receives its path as `TAFSEER_CUDA_DIR`). No business logic in `src-tauri/src/main.rs` beyond that.
- **Hardware acceleration is optional and vendor-neutral in user-facing copy.** GPU support must never require the user to install CUDA manually, must never name GPU product lines (no "GTX"/"RTX"/VRAM-capacity requirements in UI or docs), and must always degrade to CPU transcription/encoding. The UI reports GPU/CPU state and the CPU fallback explicitly; hardware names/encoder names appear only in diagnostics and technical docs.
- **FFmpeg rules:** hardware encoding (`h264_nvenc`) first with automatic CPU (`libx264`) fallback; subtitle burn-in via dual-style `.ass` with `fontsdir` pointing at the app's font directory (`backend/fonts/` in a source checkout, `%LOCALAPPDATA%\Tafseer Clipper\fonts` when packaged; `TAFSEER_FONTS_DIR` overrides). FFmpeg is invoked only from the sidecar (`backend/services/renderer.py`).

---

## 4. Structure & Scope Discipline

- Follow the Section 7 folder layout exactly: shared UI in `src/components/`, wizard screens in `src/steps/`, state in `src/store/` (Zustand), Python services in `backend/services/`.
- Scope exclusions are intentional: **no channel watermark, no automated intro/outro stitching.** Do not add them.
- Keep the 4-step linear wizard: `[1. Upload] -> [2. Find Clips] -> [3. Subtitles] -> [4. Export]`, with the Recent Lectures bar and Settings ⚙ entry as specified.
- Release packaging is Windows-only: PyInstaller-frozen `backend.exe` + bundled `ffmpeg.exe`/`ffprobe.exe` via `bundle.externalBin`, a per-user NSIS installer, Authenticode signing through `src-tauri/sign-windows.ps1`, and updater artifacts signed with the minisign key in `plugins.updater`. Runbook: `docs/RELEASING.md`; gate: `docs/RELEASE_CHECKLIST.md`.
- Placeholder files in this skeleton may be edited freely once a phase begins, but never silently change the stack, endpoints, or palette defined here.
