# UX Alignment Plan — Tafseer Clipper for Video Editors

**Status:** approved for execution (user-instructed work, 2026-11-16)
**Executing agent:** treat this document as the complete work order. Do not expand scope beyond it.
**Goal:** make every user-facing surface speak the language of a non-technical video editor/clipper.
The app's job is to turn an editor's judgment into an AI-assisted workflow — the UI must feel like
editing equipment, not like a developer console.

---

## 0. How to read this plan

### 0.1 Granularity model (mandatory)

| Tier | Marker | Used for | Rule |
|---|---|---|---|
| Coarse | — | PRs / workstreams (5 total) | One PR = one reviewable unit, one branch |
| **Mid (default)** | `[M]` | Component-level tasks | One task = one UI block or one behavior; done = renders + tests pass |
| **Atomic** | `[A]` | Fragile, individually verifiable steps | One string mapping, one test assertion, one schema field, one contract-rule edit |

**Atomic tier is declared at exactly these places** (do not atomize elsewhere):

1. Every glossary string replacement (§2.3 copy decks): one edit per mapping row, verified by grep.
2. Every Playwright assertion that references changed copy: one edit per assertion, in the same PR
   as the copy change that breaks it.
3. Every backend schema field in the `GET /health` enrichment (PR-4): one field + one test per step.
4. Every new `settingsStore` field: one field + persistence + one test per step.
5. Every contract-document rule change (PR-4): one rule per edit, quoted before/after.

### 0.2 Execution protocol

1. Work PRs strictly in order (PR-1 → PR-5). PR-4 is the only one touching the backend and the
   contract documents; everything else is frontend-only.
2. Branch naming: `ux/pr-1-copy-pass`, `ux/pr-2-automatic-mode`, `ux/pr-3-errors`,
   `ux/pr-4-ai-presets`, `ux/pr-5-i18n`. Conventional Commit titles only (`fix:`, `feat:`,
   `chore:`, `docs:`). **Never push directly to `main`. Never edit version numbers** (Release
   Please owns `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   `backend/config.py`).
3. Before every commit: `pnpm lint && pnpm test && pnpm build` must pass locally. `pnpm test` runs
   Rust unit tests + `backend/test_phase1_e2e.py` + Playwright E2E (`tests/e2e/`). Copy changes WILL
   break Playwright assertions — updating them is part of the task, not a follow-up.
4. After every PR: run the self-verification greps in §6.1. A single hit outside
   comments/diagnostics fails the PR.
5. **Stop conditions** (halt and report, do not improvise):
   - A change would require a new REST endpoint, WebSocket, or new frontend→backend surface.
   - A change would require a new npm/pip/cargo dependency (see §3.2 for the allowed fallbacks).
   - A change conflicts with `tafseer_clipper_master_plan.md` or `AGENTS.md` and is not covered by
     the PR-4 contract amendment.
   - Copy you need to write is not in §2.3 and cannot be derived from the glossary + tone rules.

---

## 1. Context

The audit (2026-11-16) found the information architecture is built around the developer's mental
model: "sidecar", "engines", "providers", "endpoints", model codenames, raw paths, and API field
names appear in first-run UI, toasts, and errors. Approved direction:

1. Purge internal architecture vocabulary from user-visible copy. ✅ approved
2. Step 1 engine controls → **Automatic / Advanced** segmented toggle. ✅ approved
3. AI-platform contact is unavoidable → make it account-connection shaped; **Ollama auto-detects**.
   ✅ approved (with honest device verdict)
4. Toasts = event + next action; technical detail → diagnostics. ✅ approved
5. Cloud model codenames unavoidable → tier labels + codename hints; Ollama offers install with an
   **honest fit verdict** (no hardware names — AGENTS.md §3). ✅ approved
6. Fix error dead-ends (folder picker, browser-preview branches, "Fast text model missing"). ✅
7. Type-size floor and density pass. ✅
8. Terminology map ("Ingest"→"Add", "re-roll"→"find more", "base prompt"→"clip brief", …). ✅
9. Localization groundwork (string extraction; Thai content later). ✅ approved

**Explicitly out of scope:** in-app Ollama model pull (v2 — deferred, see PR-4 §4.9), Thai
translation content, channel watermark, intro/outro stitching, light theme, any new endpoint.

---

## 2. Ground rules and copy constitution

### 2.1 Binding constraints (from `AGENTS.md` — violations are defects)

- **UI stack:** shadcn/ui + Radix + Tailwind only for primitives. Sonner = all toasts. Vaul = all
  drawers. cmdk = command palette only. NumberFlow = ALL animated numbers (percentages, durations,
  stats). wavesurfer.js = waveform only. Magic UI/21st.dev = the Step 1 dropzone only — never add a
  second one. No new component libraries. No inline-style theming, no CSS-in-JS.
- **Dark studio theme:** dark-only; no pure-white surfaces; content colors (warm gold Arabic, crisp
  white Thai) never leak into chrome; no color filters over video previews.
- **Architecture:** Tauri v2 shell + FastAPI sidecar. Frontend never calls OpenAI-compatible APIs,
  Ollama, or Whisper directly. The REST surface is fixed at the six existing endpoints — PR-4
  *enriches `GET /health`'s response*; it does **not** add an endpoint. Long-running progress only
  via SSE from `/render-batch`.
- **Hardware copy (AGENTS.md §3):** never name GPU product lines, never state VRAM requirements in
  UI or docs. GPU/CPU state and CPU fallback must always be visible and honest. Hardware/encoder
  names appear only in diagnostics.
- **Wizard:** keep the 4-step stepper labels exactly as contracted: `1. Upload`, `2. Find Clips`,
  `3. Subtitles`, `4. Export` (see `StepperHeader.tsx`; Playwright asserts them). Keep the Recent
  Lectures bar and Settings ⚙ entry. No watermark, no intro/outro.
- **Keyboard copy stays:** Space, J/K/L shuttle, ←/→ nudge, Ctrl+Enter split, Ctrl+K palette — this
  is editor mother-tongue and is explicitly retained.
- Tauri's role stays limited (window lifecycle, sidecar spawn, file dialogs, scoped FS for
  `.tafseer`, updater, GPU pack). PR-4 proposes one narrow addition: *opening external
  documentation/download links* — see §4.4.

### 2.2 Glossary (single source of truth)

| Concept | Say | Never say (user-visible) |
|---|---|---|
| The processing backend | "the app", "Tafseer Clipper", "the background engine" | sidecar, backend.exe, FastAPI, service, 127.0.0.1 |
| Speech-to-text | "transcribe", "transcription", "transcript" | STT; "Whisper" only in Settings→advanced |
| Where it runs | "on this computer" / "uses your AI account" | local inference, endpoint, runtime, compute type |
| AI configuration | "AI setup", "connect your AI", "AI account" | provider, engine routing, base URL (Custom preset excepted), API config |
| AI clip criteria | "clip brief" | base prompt, system prompt, editorial policy |
| Subtitle unit | "subtitle line" | cue, segment (diagnostics excepted) |
| SRT output | "separate .SRT file" | .SRT sidecar |
| Rendering | "render", "export", "rendering your clips" | FFmpeg, encode, nvenc, h264 |
| Acceleration | "GPU (faster)", "CPU", "GPU acceleration" | CUDA, VRAM, driver, adapter |
| Models | tier label first, codename in hint | bare codename as primary label |
| JSON / API fields | never | `subtitle_timebase`, "JSON", request/response |

**Tone rules**

- Sentence case. No exclamation marks. No emoji in chrome (🟢🟡🔴 fit badges are the one approved
  exception — they are status symbols, not decoration).
- Toast = event + next action. Technical detail (model names, devices, paths, timings) goes to
  `buildDiagnostics()` (`src/lib/diagnostics.ts`) only — it already strips API keys and is the
  sanctioned sink.
- Error = one plain line ("what happened") + exactly one primary action button. Never raw paths,
  URLs, executable names, or HTTP codes.
- All animated numbers via NumberFlow. All toasts via Sonner. All drawers via Vaul.

### 2.3 Copy decks (exact strings — `[A]` one edit per row)

#### 2.3.1 Step 1 — `src/steps/Step1Ingest.tsx`

| # | Before | After |
|---|---|---|
| S1-1 | `Ingest a lecture` (h1) | `Add your lecture` |
| S1-2 | `Drop a long-form Tafseer lecture, pick an editorial preset, then let the sidecar extract and transcribe the Thai–Arabic audio.` | `Drop a long-form Tafseer lecture. We'll transcribe the Thai–Arabic audio and find clip-worthy moments for you.` |
| S1-3 | `Topic analysis (Step 2) needs ${gap}. Transcribing now would produce a transcript Step 2 can't search, so it's blocked until this is set.` | `Clip finding needs an AI connection first (${gap}). Set it up and transcription starts right away.` |
| S1-4 | `Whisper runs inside the sidecar. Long lectures can take a few minutes; the editor stays responsive.` | `Transcription runs in the background. Long lectures can take a few minutes — the app stays responsive.` |
| S1-5 | `FFmpeg extracts a 16 kHz WAV, then Whisper or your Cloud STT endpoint transcribes the Thai–Arabic audio. The Thai–Arabic glossary is applied after transcription.` | `We pull out the audio and transcribe the Thai–Arabic speech. Your glossary is applied to the transcript afterwards.` |
| S1-6 | `Sidecar online` / `Checking sidecar` / `Sidecar offline` / `Sidecar not checked` | `Ready` / `Checking…` / `Engine not responding` / `Not checked yet` |
| S1-7 | `` {sidecar.error ?? `Start backend.exe on ${SIDECAR_URL}.`} `` | `The processing engine didn't start.` + buttons **Retry** (existing `refreshHealth`), **Restart the app** (`relaunchApp()` from `lib/updater.ts`), **Copy diagnostics** (`copyText(buildDiagnostics())`) |
| S1-8 | toast desc `` `${result.segments.length} segments · ${result.model} · ${result.device}` `` | toast `Transcript ready`, desc `` `${formatClock(result.duration)} of speech transcribed` `` |
| S1-9 | toast `Whisper unloaded from GPU memory` | **delete the toast** (state stays in diagnostics) |
| S1-10 | `Editorial default (sidecar)` | `Built-in default` |
| S1-11 | `Editorial policy for the clip discovery model.` | `Tell the AI what kind of moments to look for.` |
| S1-12 | `The sidecar's built-in editorial policy will be used.` | `The built-in defaults will be used.` |
| S1-13 | `Edit base prompt` | `Edit clip brief` |
| S1-14 | `Custom prompt (edit…)` | `Edit clip brief…` |
| S1-15 | `Prompt preset` (section title) | `Clip brief` |
| S1-16 | `Routing only; all inference runs in the sidecar.` | **delete line** |
| S1-17 | SegmentedToggle `Local Whisper` / `Cloud API` | `This computer` / `Your AI account` |
| S1-18 | SegmentedToggle `Local Ollama` / `Cloud API` | `This computer` / `Your AI account` |
| S1-19 | detail `faster-whisper ${model} · ${computeType} · GPU/CPU` | `On this computer · GPU` / `On this computer · CPU` (model tier arrives in PR-4) |
| S1-20 | detail `Cloud STT · ${model} · endpoint missing` | `Your AI account · ${model}` / `Your AI account — not set up` |
| S1-21 | detail `${reasoningModel} · key saved / no API key` and `Ollama · ${model}` | `Your AI account · ${model}` / `Connected` / `Not set up`; `This computer · ${model}` |
| S1-22 | `API keys, models and the Whisper prompt live in Settings → AI Providers.` | `Connections, models and the transcription prompt live in Settings → AI.` |
| S1-23 | `First local run downloads the faster-whisper model (~1.5 GB).` | `The first transcription on this computer downloads about 1.5 GB of AI files.` |
| S1-24 | toast `Transcription failed` / `Clip discovery failed` | keep titles; description = `caught.message` must itself be plain (see S2/E-strings); never surface raw URLs |
| S1-25 | `Transcribe the lecture` (card title) + button `Transcribe lecture & find clips` | keep both (outcome-oriented) |

#### 2.3.2 Step 2 — `src/steps/Step2Discovery.tsx`

| # | Before | After |
|---|---|---|
| S2-1 | `Step 2 of 4 · Keep &amp; re-roll` | `Step 2 of 4 · Review & find more` |
| S2-2 | `Upload the lecture on Step 1 so the sidecar can extract audio and run Whisper first.` | `Add the lecture on Step 1 first — we'll transcribe it and then find clips.` |
| S2-3 | toast `Whisper found no speech` + desc | title `No speech detected`, desc `We couldn't find any speech in this lecture. Check the audio, then transcribe again on Step 1.` |
| S2-4 | toast `Re-roll complete` / `Clip proposals ready` + `` `… · ${result.model}` `` | `More clips found` / `Clip proposals ready`; desc `` `${n} new clips${approvedLocked ? ` — your ${m} approved clips were kept` : ""}` `` (model name removed) |
| S2-5 | `Re-run AI on unapproved parts` | `Find more clips (keeps approved)` |
| S2-6 | `Searching the unclaimed segments…` | `Looking for more moments…` |
| S2-7 | `Searching the transcript for self-contained moments…` | `Reading the transcript for self-contained moments…` |
| S2-8 | `Approve clips to lock them out of the next re-roll.` | `Approve clips to keep them out of the next search.` |
| S2-9 | `${n} approved interval(s) locked out of the next search.` | `${n} approved clips will be kept.` |
| S2-10 | `Run discovery to let the reasoning model search the transcript, or add a refinement note and try again.` | `Let the AI search the transcript for moments — or add a note about what to look for and try again.` |
| S2-11 | `Refinement note` + `applies to the next search` | `What to look for next` + `used in the next search` |
| S2-12 | `No clips proposed yet` | keep |
| S2-13 | TrimRow `Cut in` / `Cut out`, `speech …` readout, keyboard hint line | **keep unchanged** (editor vocabulary) |
| S2-14 | `Auto-pad cut buffer` | keep (editors understand padding; the slider label `Cut buffer in seconds` → `Cut buffer padding` already reads well) |

#### 2.3.3 Step 3 — `src/steps/Step3Subtitles.tsx`

| # | Before | After |
|---|---|---|
| S3-1 | `Transcript cues` (h2) | `Subtitle lines` |
| S3-2 | badge `` `${cues.length} cue(s)` `` | `` `${cues.length} line(s)` `` |
| S3-3 | `Ctrl + Enter splits a block` | `Ctrl + Enter splits a line at the cursor` |
| S3-4 | toast `Block split`; `Place the cursor where the block should split` + `Click inside the line first, then press Ctrl + Enter.` | `Line split`; `Click inside the line where you want to split it` + `Then press Ctrl + Enter.` |
| S3-5 | `Cue is too short to split` / `Shorten the surrounding blocks instead.` | `This line is too short to split` / `Make the surrounding lines longer first.` |
| S3-6 | toast `Fast text model missing` + `Set the Step 3 verification model in Settings → AI Providers.` | `The Arabic checker isn't connected yet` + `Choose a model in Settings → AI.` + button `Set up` → `openSettings("providers")` |
| S3-7 | `The subtitle overlay is positioned exactly as the burned-in `.ass` will be. The video frame appears here in the desktop shell.` | `The subtitles are placed exactly as they'll appear in the exported video. The video frame appears here in the desktop app.` |
| S3-8 | `The sidecar burns the same framing.` | `The exported video uses this framing.` |
| S3-9 | `Preview cues are relative to the clip start. The export step sends them to the sidecar with subtitle_timebase: clip.` | `Times are shown relative to the start of the clip.` |
| S3-10 | styles readout `margin V ${…}` (also Step 4) | `bottom margin ${…} px` |
| S3-11 | `No cues for this clip` / `The transcript has no segments inside this clip. Widen the cut in Step 2 so the speech is covered.` | `No subtitle lines for this clip` / `The transcript has no speech inside this clip. Widen the cut in Step 2 so the speech is covered.` |
| S3-12 | Verify button `Verify Quran / Fix Arabic`, `Arabic verified`, `Arabic corrected`, safe-zone block | **keep unchanged** (audience vocabulary) |

#### 2.3.4 Step 4 — `src/steps/Step4Export.tsx`

| # | Before | After |
|---|---|---|
| S4-1 | `Encoding with FFmpeg inside the sidecar…` | `Rendering your clips…` |
| S4-2 | footer `` `${path} (from the sidecar)` `` / `` `${path} (defaults to)` `` / `Output folder decided by the sidecar at render time` | `Saving to: ${path}` / `The output folder is chosen when rendering starts.` |
| S4-3 | `Writes a subtitle sidecar next to every MP4.` | `Also saves a separate .SRT file next to each video.` |
| S4-4 | tooltip `Invalid characters are replaced with underscores, exactly like the sidecar does.` | `File names are cleaned up automatically.` |
| S4-5 | `…falls back to CPU encoding automatically if the driver refuses.` / `…encoding runs on the CPU. Enable GPU acceleration in Settings.` | `…If it isn't available, we render on the CPU instead.` / `…rendering runs on the CPU. Turn on GPU acceleration in Settings.` |
| S4-6 | status label `Encoding` | `Rendering` |
| S4-7 | `Burned-in subtitle styles`, `{n} approved clip(s) have no subtitles…`, `Render N clip(s)`, `Batch rendered`, `Queued/Rendered/Failed/Cancelled` | **keep unchanged** (Playwright asserts several) |

#### 2.3.5 Command palette — `src/components/CommandMenu.tsx`

| # | Before | After |
|---|---|---|
| C-1 | group `Sidecar` | `App status` |
| C-2 | `Check sidecar health` | `Check that everything is running` |
| C-3 | toasts `Sidecar online` / `Sidecar offline` | `Everything is running` / `The processing engine isn't responding` |
| C-4 | health toast VRAM `NumberFlow` block + `v{version}` | move to the diagnostics payload only; the toast keeps one line: `Transcription: GPU` / `Transcription: CPU` |
| C-5 | `Unload Whisper from GPU memory: on/off` | `Free up memory after transcription: on/off` |
| C-6 | command `value="hardware encoding gpu acceleration nvenc"` etc. | **keep** (invisible search keywords; `nvenc` here is acceptable) |

#### 2.3.6 Settings — `src/components/SettingsDrawer.tsx` (PR-1 does strings only; PR-4 reworks the AI tab)

| # | Before | After |
|---|---|---|
| ST-1 | tab `AI Providers` | `AI` |
| ST-2 | tab `Glossary & Whisper` | `Glossary & transcription` |
| ST-3 | `All provider calls run inside the FastAPI sidecar. The frontend only sends configuration.` | **delete** |
| ST-4 | select `Local Faster-Whisper (on this machine)` / `Cloud STT API` | `This computer (offline)` / `Cloud speech-to-text` |
| ST-5 | select `Unified cloud API` / `Local Ollama` | `Your AI account` / `This computer (Ollama)` |
| ST-6 | `Custom font importer` desc `…copied into the sidecar's fonts/ directory so FFmpeg .ass burn-in resolves Thai and Uthmani Arabic reliably.` | `Fonts are added to the app so exported subtitles always render Thai and Uthmani Arabic correctly.` |
| ST-7 | toast `Diagnostics copied` desc `Paste the JSON into the support report…` | `Paste it into your support request. No API keys are included.` |
| ST-8 | `Settings exported — Includes API keys in plain text — keep the file private.` | **keep** (honest warning) |
| ST-9 | all other provider labels/fields | **PR-4 owns them** — do not redesign here |

#### 2.3.7 Shared components

| # | File | Before | After |
|---|---|---|---|
| SH-1 | `PromptDrawer.tsx` | `Editorial policy for clip discovery. Strict JSON and timing rules are appended by the sidecar.` | `Tell the AI what kind of clips to find. We add the timing and formatting rules automatically.` |
| SH-2 | `PromptDrawer.tsx` | `Empty text falls back to the sidecar's built-in policy.` | `Leave empty to use the built-in defaults.` |
| SH-3 | `PromptDrawer.tsx` | `Editorial policy for clip discovery.` (second occurrence) | `What kind of clips to find.` |
| SH-4 | `StepperHeader.tsx` | status tooltip copy mentioning sidecar/VRAM | follow glossary; VRAM/adapter names → tooltip stays diagnostic-only (allowed) but the label reads `GPU acceleration` / `CPU` |
| SH-5 | `Step4Export.tsx` + `Step3Subtitles.tsx` | `margin V` | see S3-10 |
| SH-6 | any | `the sidecar` in user-visible prose | `the app` (comments may keep "sidecar" — it is the architectural term) |

---

## 3. PR-1 — Copy pass (`fix: …`) `[M]` workstream, `[A]` per mapping

**Branch:** `ux/pr-1-copy-pass` · **Touches:** `src/**` strings + `tests/e2e/*.ts` assertions only.

### Tasks

- **1.1 `[M]`** Apply copy deck §2.3.1–§2.3.7. Each row is one atomic edit; run the deck's own
  "before" string through grep first (some strings appear twice — e.g. `The sidecar's built-in
  editorial policy will be used.` in both Step1 and PromptDrawer; both map to their row).
- **1.2 `[A]`** Update Playwright assertions that reference renamed strings, one per assertion:
  - `tests/e2e/shell.spec.ts:13` `Ingest a lecture` → `Add your lecture`
  - `tests/e2e/shell.spec.ts:24` `Sidecar online` button → the new label (it is a button via
    `SidecarStatusDot`; verify accessible name after change)
  - `tests/e2e/settings.spec.ts:29` tab `Storage & Backup` — unchanged
  - `tests/e2e/settings.spec.ts:57,64` tab `Glossary & Whisper` → `Glossary & transcription`
  - `tests/e2e/settings.spec.ts:113` tab `AI Providers` → `AI`
  - `tests/e2e/settings.spec.ts:127` option `Local Ollama` → `This computer (Ollama)`
  - `tests/e2e/project-flow.spec.ts` — `Find clips`, `Approve`, `3. Subtitles`, `Continue to
    export`, `Export`, `9:16 Vertical`, `Blur fill`, `2 cues`→`2 lines`, `Queued`, `Render 1
    clip`, `Batch rendered`, `Rendered`, `Render again` — update only what the deck changes.
- **1.3 `[M]`** Re-run `pnpm lint && pnpm test && pnpm build`. Green = PR ready.

### Acceptance
- §6.1 greps clean. All Playwright specs pass unchanged in count. No component logic changed
  (pure strings + test sync).

---

## 4. PR-2 — Automatic/Advanced + density (`feat: …`)

**Branch:** `ux/pr-2-automatic-mode` · **Touches:** `Step1Ingest.tsx`, `settingsStore.ts`,
`SettingsDrawer.tsx` (read-only), `Step3Subtitles.tsx`/`Step4Export.tsx` (style-details expander),
type-scale pass across steps/components.

### Tasks

- **4.1 `[A]`** `src/store/settingsStore.ts`: add `engineUiMode: "automatic" | "advanced"`
  (default `"automatic"`), persisted like other settings. One field, one action
  (`setEngineUiMode`), one persistence unit test.
- **4.2 `[M]`** Replace the Step 1 "Engines" section with an **AI setup card**:
  ```
  AI setup                          [ Automatic | Advanced ]
  ─────────────────────────────────────────────────────────
  ✓ Ready — transcribing on this computer, clip finding on this computer
  [ Change AI settings ]
  ```
  - `SegmentedToggle` (existing component) switches `engineUiMode`.
  - **Automatic:** hide all engine toggles and detail strings. Routing: local Whisper if healthy,
    else configured cloud STT; Ollama if detected (PR-4; until then, configured analysis engine).
    One honest status line derived from `describeAcceleration()` + provider gap state. If a route
    is missing: `Clip finding needs an AI connection — [Set up]` (opens Settings → AI).
  - **Advanced:** existing toggles (S1-17/S1-18 wording) + cleaned detail lines.
  - `Change AI settings` → `openSettings("providers")`.
- **4.3 `[M]`** Step 1 right rail: show `Clip brief` and `Session topic guide` sections only once a
  lecture is staged (`project?.sourcePath` present). First run = dropzone + AI-setup card + Recent
  lectures. (The dropzone's Magic UI glow stays — it is the one approved focal component.)
- **4.4 `[M]`** Type floor: helper copy `text-[11px]`/`text-[10px]` → `text-xs` (12px) minimum;
  eyebrows may stay 10–11px uppercase; badge chips exempt. Applies to Steps 1–4, SettingsDrawer,
  PromptDrawer. Do not change layout structure while doing this.
- **4.5 `[M]`** "Burned-in styles" blocks (Step 3 §2.3.3 + Step 4): collapse into a `Style details`
  expander. Add the shadcn **Collapsible** primitive (Radix — allowed Layer 1) to
  `src/components/ui/collapsible.tsx` via the shadcn CLI pattern used for the other primitives.
  Expanded content keeps the S3-10 wording.
- **4.6 `[A]`** Update any Playwright assertions hit by label changes (e.g. combobox accessible
  names if the engines toggle labels moved), one per assertion.

### Acceptance
- With `engineUiMode: "automatic"` a fresh user sees zero model/endpoint vocabulary on Step 1.
- `pnpm lint && pnpm test && pnpm build` green. No new dependency except the shadcn Collapsible
  source file (Radix primitive already in the dependency tree — verify before adding; if
  `@radix-ui/react-collapsible` is NOT already installed and adding it is disallowed, implement the
  expander with the existing `Tabs`/`Switch` primitives instead and note it in the PR).

---

## 5. PR-3 — Errors & dead-ends (`fix: …`)

**Branch:** `ux/pr-3-errors` · **Touches:** new `src/components/InlineError.tsx`, `Step4Export.tsx`,
`Step1Ingest.tsx`, `Step3Subtitles.tsx`, `src/lib/media.ts` (dialog helper), e2e.

### Tasks

- **5.1 `[M]`** `InlineError` component: icon + one plain line + exactly one primary action
  (+ optional ghost secondary). Composed from shadcn `Button`; Sonner toasts remain for success
  only. Adopt in Steps 1–4 replacing raw error divs (Step 1's existing inline box is the reference
  design).
- **5.2 `[M]`** Step 4 `Output folder`: add **[Browse…]** using the native directory dialog,
  following the exact pattern of `openLectureFile()` in `src/lib/media.ts` (same Tauri plugin /
  same browser fallback). Keep the text field editable. After a successful render, primary action
  becomes **[Open folder]** if an opener is available (see §5.4), else **[Copy path]** (current
  behavior).
- **5.3 `[M]`** Gate browser-preview dead-ends: the "browser preview cannot expose the absolute
  path / desktop shell required" family (`Step1Ingest.tsx` `handleBrowserFile`, `browserFile`
  warning block) renders its detailed developer copy only when `import.meta.env.DEV`; production
  browser fallback shows one line: `Please open the Tafseer Clipper desktop app.`
- **5.4 `[A]`** Opener fallback rule: check `src-tauri/Cargo.toml` + `src-tauri/capabilities/` for an
  existing shell/opener plugin. If present, use it for `Open folder` + `Get Ollama` (PR-4). If
  absent, **do not add a dependency** — use clipboard-copy fallbacks and record the gap in the PR
  description (the PR-4 contract amendment lists the plugin as a proposed addition).
- **5.5 `[M]`** `Fast text model missing` path (S3-6) gets its `Set up` jump button wired to
  `useUiStore.openSettings("providers")`.
- **5.6 `[A]`** Playwright sync (one per assertion).

### Acceptance
- No user-visible string contains a filesystem path at ≤11px, a URL, or an executable name.
- Output folder is settable without typing. `pnpm …` trio green.

---

## 6. PR-4 — AI presets + Ollama auto-detect + fit badges (`feat: …`) — contract amendment included

**Branch:** `ux/pr-4-ai-presets` · **Touches:** `tafseer_clipper_master_plan.md`, `AGENTS.md`,
`backend/main.py` (+ services), `backend/test_phase1_e2e.py`, `src/lib/providers.ts`,
`src/lib/acceleration.ts`, `src/store/settingsStore.ts`, `SettingsDrawer.tsx`, `GpuAcceleration.tsx`,
`Step1Ingest.tsx` detail lines, e2e.

### 6.1 Contract amendment (FIRST commit of this PR — `[A]` one rule per edit)

Amend `tafseer_clipper_master_plan.md` and `AGENTS.md` (keep them in sync; master plan wins) to
record exactly these deltas, each as a quoted before/after in the commit message:

1. **`GET /health` response enrichment** (not a new endpoint): an optional `providers` block —
   `ollama: { detected: bool, url: string|null, models: string[] }` — and `hardware: { tier:
   "high" | "medium" | "low" }` (tier only; hardware names remain diagnostics-only). Backward
   compatible: absent block = old behavior.
2. **Tauri role + one capability:** opening external documentation/download links (link-out only;
   no fetching, no business logic). If no opener plugin exists, this rule stays dormant until the
   dependency is added deliberately with the toolchain pinned.
3. **Out of scope recorded:** in-app model pull (Ollama `pull`) deferred to a future plan.

Also update `AGENTS.md` "Current phase" line to mention the UX alignment work.

### 6.2 Backend tasks

- **6.2.1 `[A]`** `HealthResponse`: add `providers` block field (optional). Test: absent by default.
- **6.2.2 `[A]`** Ollama probe: sidecar `GET http://localhost:11434/api/tags` (≈500 ms timeout,
  never raises, never blocks `/health` beyond the timeout) filling `ollama`. Test: mocked
  detected/not-detected/timeout.
- **6.2.3 `[A]`** `hardware.tier` classifier: RAM/VRAM heuristic in the existing health probe code
  (the same code that already produces `vram_mb`). Tier thresholds documented in the master plan.
  **No GPU names anywhere in emitted copy.** Test: mapping unit checks.
- **6.2.4 `[M]`** Extend `backend/test_phase1_e2e.py`; the existing 42/42 checks must stay green and
  new checks are added (state the new total in the PR).

### 6.3 Frontend tasks

- **6.3.1 `[A]`** Types for the enriched health payload in `src/lib/api.ts` (or `providers.ts`),
  tolerant of the block being absent.
- **6.3.2 `[M]`** Settings → **AI** tab rewrite:
  - Preset select: `This computer (Ollama)` | `OpenAI` | `OpenRouter` | `DeepSeek` | `Custom`.
    Preset fills the base URL; the URL field collapses to `Change` unless Custom.
  - Model fields = **tier label + codename hint**: `Best quality — gpt-4.1`, `Balanced —
    gpt-4.1-mini`, `Fastest — gpt-4.1-nano`, `Custom…` (free text stays — codenames are
    unavoidable for unified APIs; placeholder: `Paste the model name from your AI service`).
  - `Check connection` (existing) with copy `Connected — the model answered.`
- **6.3.3 `[M]`** Ollama card states, driven by `/health`:
  - Detected + models → dropdown of installed models (no free-text ids), fit badge attached.
  - Detected, no models → `Ollama is installed but has no AI models yet` + **[Install a recommended
    model]** which (v1) deep-links/copies `ollama pull <recommended>` with auto-refresh detection.
  - Not detected → `Ollama isn't installed yet. It's free and runs everything offline.` + **[Get
    Ollama]** (link-out per §6.1.2, clipboard fallback) + 3-step checklist with live detection.
- **6.3.4 `[M]`** **Fit badge** (honest device verdict, AGENTS.md §3 compliant): 🟢 `Great fit` /
  🟡 `Workable` / 🔴 `Too heavy`, from `hardware.tier`, with recommendation copy like: `This
  computer: 🟡 Workable — the best local model will be slow. We recommend Balanced.` Numbers stay
  in diagnostics. Apply to the Ollama model list and the local Whisper picker.
- **6.3.5 `[M]`** Whisper model picker → tier labels (`Fastest / Balanced / Best quality`) with
  `tiny / small / medium / large-v3-turbo` demoted to hint text. Step 1 detail lines (S1-19) gain
  the tier name.
- **6.3.6 `[A]`** Playwright sync (the `Local Ollama`→preset combobox rework changes several
  selectors — one edit per assertion; `settings.spec.ts:112-132` provider-routing test is the main
  one).

### Acceptance
- A user with zero AI knowledge reaches a working state via: pick `This computer (Ollama)` →
  guided install → pick recommended model → done. No URL/key ever typed.
- `pnpm lint && pnpm test && pnpm build` green; backend E2E total stated; §6.1 greps clean;
  AGENTS.md and master plan agree.

---

## 7. PR-5 — String extraction (i18n groundwork) (`chore: …`) — after copy settles

**Branch:** `ux/pr-5-i18n`

- **7.1 `[M]`** `src/lib/i18n.ts`: typed key→string dictionary (plain object + `t(key)` helper —
  **no new dependency**), `language: "en" | "th"` in `settingsStore` (default `"en"`), Settings
  control `Language: English / ไทย`.
- **7.2 `[M]``** Mechanical extraction of user-facing strings into the dictionary. English values
  must be byte-identical to post-PR-1..4 copy. Tests assert key stability, not English text.
- **7.3** Thai content = future work (community review); scaffold only. Thai chrome needs no new
  fonts (Leelawadee UI/Tahoma in stack); Arabic stays content-only, chrome never RTL.

**Do not start PR-5 until PR-1..4 copy is merged** — otherwise you extract strings that then change.

---

## 8. Verification

### 8.1 Self-verification greps (run after PR-1, PR-2, PR-4)

```powershell
# User-visible strings must be clean (comments/diagnostics may keep technical terms):
rg -n "sidecar|backend\.exe|FastAPI|FFmpeg|nvenc|subtitle_timebase|margin V|endpoint|base_url|compute" src --glob "*.tsx" -g "!*.test.*"
# Review each hit: allowed in code comments, aria-search keywords, or lib/diagnostics.ts only.
rg -n "Whisper|Ollama|API key|model" src/steps src/components --glob "*.tsx"   # review per glossary §2.2
```

### 8.2 Per-PR gate

```powershell
pnpm lint   # type-check + backend byte-compile
pnpm test   # Rust unit tests + backend E2E + Playwright E2E
pnpm build
```

### 8.3 Manual QA checklist (per PR)

1. First run with no lecture: no model/endpoint vocabulary visible (PR-2 onward).
2. Transcribe → toast reads event + duration only (PR-1).
3. Step 2 re-roll → toast has no model name; approved-kept message correct.
4. Step 4: set output folder via Browse…; render; `Saving to:` line reads clean (PR-3).
5. Settings → AI: preset select, Ollama card states simulated (PR-4).
6. Ctrl+K palette: no "sidecar" strings; VRAM only in diagnostics.
7. Offline engine state (stop backend.exe manually): panel offers Retry / Restart the app / Copy
   diagnostics — no URL, no executable name.

---

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Copy churn breaks Playwright | Assertion updates are atomic steps *inside* each PR; `pnpm test` is the gate |
| PR-1 and PR-4 both edit SettingsDrawer strings | PR-1 is strings-only per deck ST-1..ST-8; ST-9 explicitly reserved for PR-4 |
| Adding a dependency for link-out/folder-open | §5.4 fallback rule; dependency additions need the PR-4 amendment + pinned toolchain discipline |
| `/health` enrichment seen as "new endpoint" | §6.1.1 documents it as response enrichment of an existing endpoint; amend the master plan in the same PR |
| Fit badge leaks hardware specifics | Tier vocabulary only (🟢🟡🔴 + three labels); names stay in diagnostics — enforce in review |
| Scope creep in PR-4 | §1 out-of-scope list; stop conditions §0.2 |

---

## 10. Definition of Done

- [ ] All 5 PRs merged via review (never direct-to-main), conventional commit titles.
- [ ] §6.1 greps clean; toasts = event + action; errors = one line + one button.
- [ ] A non-technical editor can complete the full wizard without encountering: sidecar, backend,
      endpoint, model codename (as primary label), URL, path typing, or "engine routing".
- [ ] `pnpm lint && pnpm test && pnpm build` green on every PR.
- [ ] `AGENTS.md` + master plan updated (PR-4) and mutually consistent; Current phase line fresh.
- [ ] No version numbers edited by hand anywhere.
