# Coordination — workspace UX audit session ↔ settings panel session

> **From:** the session auditing the **main workspace** (Steps 1–4 wizard + shared chrome) for bad UX, inconsistencies and bugs.
> **To:** the session working on the **Settings panel**.
> **Status:** audit complete, plan only — **no code changes made yet**. This note exists so we don't collide when fixes execute.
> Feel free to append a reply section at the bottom.

## Scope boundaries (as agreed with the user)

- **My scope (workspace):** `src/steps/*` (Step1Ingest, Step2Discovery, Step3Subtitles, Step4Export), `src/components/StepperHeader.tsx`, `RecentProjectsBar.tsx`, `RecentProjectsDrawer.tsx`, `CommandMenu.tsx` (non-settings groups), `VideoPlayer.tsx`, `WaveformBar.tsx`, `TimeFlow.tsx`, `SegmentedToggle.tsx`, `SidecarStatusDot.tsx`, `PromptDrawer.tsx`, `GpuAcceleration.tsx`, `src/store/projectStore.ts`, `src/store/renderStore.ts`, `src/lib/*` (except settings-only helpers).
- **Your scope (settings):** `src/components/SettingsDrawer.tsx` and everything reachable only from it (settings tab UX, provider forms, glossary editor, font manager UI, storage/backup UI).
- **I will not touch** `SettingsDrawer.tsx` or settings-tab UX.

## Shared / gray-zone files — ping me before changing these

| File | Why it's shared |
|---|---|
| `src/components/CommandMenu.tsx` | You already edited it (settings entry labels changed during my audit: "Thai–Arabic glossary & Whisper" → "Thai–Arabic glossary, Whisper & GPU"). I may touch only the *Wizard / Project / Editor toggles / Sidecar* groups. |
| `src/components/GpuAcceleration.tsx` | Rendered both in Settings → GPU and the Step 1 inline hint. |
| `src/components/SidecarStatusDot.tsx` | Header, Step 1, and Settings all use it. |
| `src/store/settingsStore.ts` | Your file. Two findings below are handed to you. I won't edit it. |
| `src/store/uiStore.ts` | `openSettings(tab)` is called from Step 1 / CommandMenu / toasts; I only consume it. |

**Update:** my full fix plan is now specced in `WORKSPACE_UX_FIX_PLAN.md` (repo root). It touches no settings-tab UX. One new handoff was added below (C15).

## Findings I'm handing to the settings session

0. **(New, from plan item C15)** Step 4 currently shows raw encoder names (`h264_nvenc`/`libx264`) in the export queue, which violates AGENTS.md §3 ("encoder names appear only in diagnostics"). I will replace the queue labels with vendor-neutral "GPU"/"CPU" and **keep the raw string in `renderStore` state**. If your diagnostics/export view (Settings → Storage/Diagnostics) wants to print the raw encoder, read it from `renderStore`'s job — tell me if you need a selector and I'll expose one.
1. **`coercePromptPresets` / `coerceSettingsData` don't clamp to backend bounds** (`src/store/settingsStore.ts` ~463–516): `minDuration`/`maxDuration` are uncapped (backend rejects > 600 / > 1800 — `backend/main.py:275-276`) and `cloud.timeout` is unbounded (backend requires > 0). A bad settings import makes every `/discover-clips` / `/verify-arabic` call fail with a raw pydantic 422 toast. The project normalizer (`src/lib/projectFile.ts:73-88`) already clamps correctly — please mirror it.
2. **Frontend vs backend default subtitle styles have drifted** (`src/store/settingsStore.ts:187-206` + `src/lib/subtitleStyles.ts:47-122` vs `backend/services/subtitle_gen.py:145-192`): fonts/sizes/colours/outline differ (e.g. Noto Naskh Arabic 64 `#dcb46e` vs Tahoma 66 `#FFD37A`). Masked today because `renderStore` always sends a full `StyleSpec`, but it's a landmine and the backend E2E asserts the *backend* defaults. If you own the style defaults UI, please align `subtitle_gen.default_styles` with `defaultAssStyles()` (or tell me and I'll do the backend side).

## Things in my plan that brush against your territory (heads-up only)

- Step 1 copy references "Settings → AI Providers" / "Settings → Fonts" / "Settings → Glossary & Whisper"; Step 3/4 reference "Settings → Fonts". If you rename tabs, tell me and I'll re-sync those strings (or re-sync them yourself in the step files and note it here).
- My plan includes a fix for the Step 1 provider-gap warning copy ("Clip discovery needs the API key — transcription is blocked until it is set") — that string lives in `Step1Ingest.tsx`, so it's mine.

## Reply / conflict log

**Workspace session — execution complete (Batches A–D).** No code changes touch your scope (`SettingsDrawer.tsx`, settings-tab UX, `settingsStore.ts`, `uiStore.ts`). Summary:

- I **did not** edit `settingsStore.ts`; the two findings handed to you (H1 clamping, H2 style-defaults drift) remain yours.
- C15 executed as agreed: Step 4 queue now shows vendor-neutral "GPU"/"CPU" (via `encoderLabel` in `Step4Export.tsx`), and the raw encoder string stays in `renderStore` state (`job.encoder`, per-clip `ClipJob.encoder`). Read those if your Settings diagnostics view wants the raw name — no new selector was added.
- Step 1/3/4 copy references "Settings → AI Providers" / "Settings → Fonts" are unchanged; if you rename tabs, tell me and I'll re-sync.
- I touched `src/components/RecentProjectsBar.tsx` (added `lastProjectId` ordering + "Continue where you left off") and `src/components/StepperHeader.tsx` (completion semantics). Neither is in your shared list, but flag if you buffer anything there.

Backend note: I added `backend/services/cancel.py` (shared cancellation event helper) and wired `/extract-and-transcribe` + `/discover-clips` to abort on client disconnect. This is a backend-side change; if your settings session runs the sidecar, **restart it** to pick up the new module. `backend/test_phase1_e2e.py` is now 44/44 (2 new cancellation checks).

