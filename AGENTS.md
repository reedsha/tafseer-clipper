# AGENTS.md — Design & Architecture Contract

The former `tafseer_clipper_master_plan.md` has been retired at the user's direction — this file is the design and architecture contract.

**Current phase:** Phase 1 (backend core) is implemented under `backend/` and verified by `backend/test_phase1_e2e.py` (110/110 checks, including GPU→CPU fallback and decision-tier regressions). The Phase 2 shell (`StepperHeader`, `SettingsDrawer`, `CommandMenu`, `.tafseer` auto-save) and the full Phase 3 wizard (Steps 1–4: ingest, Keep & Re-roll discovery, bilingual subtitle studio, batch export) are implemented under `src/`, with the Tauri v2 shell under `src-tauri/` — this repository root is the canonical frontend root per the master plan's Section 7 layout. Phase 4 packaging is implemented and built in this checkout: frozen `backend.exe` (PyInstaller) + bundled `ffmpeg.exe`/`ffprobe.exe`, per-user NSIS installer with an Authenticode signing hook and signed auto-updater artifacts (see `release/0.1.0/`, `docs/RELEASING.md`, `docs/RELEASE_CHECKLIST.md`). A UX alignment pass for non-technical video editors is in progress (see `docs/UX_ALIGNMENT_PLAN.md`): user-facing copy uses editor vocabulary, Step 1 requires the user to choose the transcription and clip-finding engines explicitly, and `GET /health` carries additive provider/hardware blocks. **Do not write application code** (components, endpoints, services, stores, Tauri config) outside work the user explicitly instructs you to begin.

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
| --- | --- | --- |
| **Sonner** | All toast/notifications (background status, errors, confirmations) | Never build custom toasts, never use other toast libs (react-hot-toast, react-toastify, Notistack) |
| **Vaul** | Slide-over drawers for secondary panels: Editable Base System Prompt, Recent Projects | Never build custom slide-overs; dialogs that are genuinely modals may use shadcn/ui `Dialog`, but anything sliding/drawer-shaped is Vaul. Settings ⚙ and each stage's configuration are **full-page screens** (Settings = sidebar + content pane like a preferences window; stage configuration replaces the step with a Back button), not drawers — approved 2026-11 |
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
7. `POST /list-models` (model discovery for the Settings selectors — approved 2026-11; no hard-coded model lists may replace it)
- Do **not** add further endpoints, GraphQL, WebSockets, LangGraph, or an agent framework. The architecture is a simple deterministic REST loop (Section 2 of the master plan).
- `GET /health` may carry **additive, backward-compatible** blocks (`providers.ollama`, `providers.whisper_local`, `hardware.tier`), and that `GET /health` and `POST /list-models` both carry the additive `models_detail` field described below. Those are response enrichment of the existing endpoints, not new endpoints, and consumers must tolerate their absence.
- Do **not** call OpenAI-compatible APIs, Ollama, or Whisper directly from the frontend; all provider configuration flows through the sidecar.
### Internal decision tier (System One) — no new endpoints

- Step 1/2/3 may use an optional **decision model** for fast typed judgments (`choice`, `noul`, `score`). It is an internal sidecar layer (`backend/services/decision.py`, `decision_tasks.py`, `verify.py`); the renderer only sends per-slot settings inside the existing requests. With no slot configured, every path is today's exact behavior.
- **Wire format:** Every provider speaks one of exactly **two** shapes — `systemone` (`POST {root}/v1/systemone`, keyed `questions`, answers keyed by name) or `decisions` (`POST {root}/v1/decisions`, the OpenAI Decisions API: `input` + `questions[]` with `name`, `predicate`/`choices`/`levels`, answers as an **ordered list**, `refusal` → `DecisionError` so the step degrades). No hostname guessing and no per-vendor adapter table: legacy vendor names in saved settings are translated to a format once. `endpoint_style` carries `auto` (measure once with the Settings **Test** button, cache for the process and persist the result in the slot), `systemone` or `decisions`; the additive `endpoint_url` accepts a full URL for a gateway that moved the route. `criteria` is typed per question: `choice` takes `{label: description}`, `score` takes 2–10 level descriptions (lowest first), `noul` takes an optional `{"true": …, "false": …}` object — a string is rejected by the provider. Answers carry `noul` as P(true), `choice` with `probabilities`/`confidence`, and `score` as a probability-weighted level index that the client scales to 0–1 before any caller sees it. Local Ollama needs `>= 0.35`; older servers are reported honestly in Settings and never offered a working-looking slot.
- **Additive request fields only:**`decision_provider` on `/extract-and-transcribe`, `/discover-clips`, `/verify-arabic`; `lines[]` (batched verification) and `approved_exemplars` / `rejected_exemplars` (re-roll feedback) on their existing requests. Responses gain `source` / `reference` / `confidence` per verified line plus tally fields. No field is required, so older renderers and sidecars keep working.
- **`/list-models` enrichment:** additive `filter: "decision"` (narrows the decision picker by **name** — the familiar decision-family pattern — hiding non-matching ids), `probe_model`, `endpoint_style`, `endpoint_url`, and an optional `probe` result (including the detected `format`) for the Settings **Test** button. The picker's "Custom model name…" free-text input is the escape hatch (unfamiliar ids stay reachable by typing the exact name); hiding is an explicit UI choice, not silent suppression. Degradation is still mandatory: unverified/unreachable decisions fall back to today's behavior. Model discovery still comes only from this endpoint; no hard-coded candidate lists, and all model metadata comes from the provider. `/list-models` and `/health` gain **additive capability metadata**: `models_detail` (an array of `{id, kind: "speech"|"text"|"unknown", evidence}`); `models: string[]` stays unchanged. All fields are optional and provider-supplied, so older sidecars/renderers keep working; when a sidecar sends no metadata, the old name-regex behavior remains as fallback.
- **Degradation is mandatory:** low confidence escalates to the generative model, a malformed/unreachable decision reply falls back to today's prompt, windowed audit, or per-line proofread, and a corpus-exact Qur'an line needs no model at all. No decision failure may silently suppress a correction, a recitation span, or a clip candidate.
- Phase-0 fixtures, baselines, gate and per-slot thresholds: `docs/DECISION_MODELS_PHASE0.md`; work order and acceptance criteria: `docs/DECISION_MODELS_PLAN.md`.
- Long-running progress reaches the UI **only** via SSE from `/render-batch` (rendered with NumberFlow + shadcn/ui progress).
- **Tauri's role is limited to:** window lifecycle, spawning/pinging the sidecar, injecting the sidecar URL at boot, native file dialogs, scoped file-system access for `.tafseer` project auto-save (the `tauri-plugin-fs` permissions are scoped to `$LOCALDATA`/`$APPDATA`/`$HOME`/`$DOCUMENT` and are used only to write/read/delete project snapshots), the signed auto-updater (`tauri-plugin-updater` verifies update signatures in Rust; the renderer only triggers check/download/install and relaunches via `tauri-plugin-process`), provisioning the **optional GPU acceleration pack** (download + SHA-256 verification into `%LOCALAPPDATA%`; the sidecar receives its path as `TAFSEER_CUDA_DIR`), and **opening external documentation/download links** (link-out only, via `tauri-plugin-opener`; never fetching or business logic). No business logic in `src-tauri/src/main.rs` beyond that.
- **Background tasks and the tray:** the renderer owns long-running task state (`src/store/jobStore.ts` for transcription/discovery/verification, `src/store/renderStore.ts` for rendering), so changing steps, Settings, a stage configuration, or the open session never cancels a job. Results are routed by project id (`src/lib/taskResults.ts`); a result for a session that is not open is journaled and applied when that session next opens. On a graceful window close the shell emits `app://close-requested` when tasks are running and the renderer asks whether to stop them or keep them alive with the window hidden in the system tray (core `tauri` `tray-icon` feature; commands `set_running_jobs`, `quit_app`, `minimize_to_tray`). Unexpected exits (crash, Task Manager, OS shutdown) bypass this path and terminate the sidecar through the existing parent watchdog.
- **Hardware acceleration is optional and vendor-neutral in user-facing copy.** GPU support must never require the user to install CUDA manually, must never name GPU product lines (no "GTX"/"RTX"/VRAM-capacity requirements in UI or docs), and must always degrade to CPU transcription/encoding. The UI reports GPU/CPU state and the CPU fallback explicitly; hardware names/encoder names appear only in diagnostics and technical docs.
- **FFmpeg rules:** hardware encoding (`h264_nvenc`) first with automatic CPU (`libx264`) fallback; subtitle burn-in via dual-style `.ass` with `fontsdir` pointing at the app's font directory (`backend/fonts/` in a source checkout, `%LOCALAPPDATA%\Tafseer Clipper\fonts` when packaged; `TAFSEER_FONTS_DIR` overrides). FFmpeg is invoked only from the sidecar (`backend/services/renderer.py`).
---

## 4. Structure & Scope Discipline

- Follow the Section 7 folder layout exactly: shared UI in `src/components/`, wizard screens in `src/steps/`, state in `src/store/` (Zustand), Python services in `backend/services/`.
- Scope exclusions are intentional: **no channel watermark, no automated intro/outro stitching.** Do not add them.
- Keep the 4-step linear wizard: `[1. Upload] -> [2. Find Clips] -> [3. Subtitles] -> [4. Export]`, with the Recent Lectures bar and Settings ⚙ entry as specified.
- Release packaging is Windows-only: PyInstaller-frozen `backend.exe` + bundled `ffmpeg.exe`/`ffprobe.exe` via `bundle.externalBin`, a per-user NSIS installer, Authenticode signing through `src-tauri/sign-windows.ps1`, and updater artifacts signed with the minisign key in `plugins.updater`. Runbook: `docs/RELEASING.md`; gate: `docs/RELEASE_CHECKLIST.md`.
- Placeholder files in this skeleton may be edited freely once a phase begins, but never silently change the stack, endpoints, or palette defined here.
---

### Repository-specific detail

- **Single source of truth for the version:** Release Please owns `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `backend/config.py` (`release-please-config.json`). Never hand-edit a version; open an empty conventional commit (`chore: release X.Y.Z`) instead. Runbook: `docs/RELEASING.md` §2.
- **Standard entrypoints:**`pnpm lint` (type-check + backend byte-compile), `pnpm test` (Rust unit tests + backend E2E + Playwright E2E), `pnpm build`. The `CI` workflow runs the same three, so a green local run is what a green PR means.
- **Toolchain is pinned:** Node 22 (`.nvmrc`), pnpm 11 (`packageManager`), Python 3.12 (`.python-version`), Rust stable (`src-tauri/rust-toolchain.toml`). Do not bump these in a feature branch; change them deliberately and in the same commit.
- **All GitHub Actions are pinned to a commit SHA** with a `# vX.Y.Z` comment. Never introduce a floating tag — the tag is what gets audited, the SHA is what gets executed.
- **Least privilege:** every workflow declares `permissions:` explicitly. CI is `contents: read`; only the release workflows get scoped write.
- **Release Please owns the tag and the draft release.**`.github/workflows/release.yml` only *attaches* artifacts to the existing draft; it never creates a second release. Do not hand-run `git tag` — see `docs/RELEASING.md` §2.
- **The Windows-only release matrix is deliberate.** Do not add Linux/macOS targets without an explicit instruction; the rationale is recorded in `docs/CICD_AUDIT.md` §5.4.