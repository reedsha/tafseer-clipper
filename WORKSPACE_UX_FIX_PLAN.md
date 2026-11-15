# Workspace Fix & Improvement Plan — Mid-Level Spec

**Scope:** main workspace (Steps 1–4 wizard, shared chrome, `projectStore`/`renderStore`, `src/lib`) — the Settings panel is owned by a parallel session and is **out of scope** (see `COORDINATION_workspace_vs_settings.md`).
**Status:** plan only — no code changes yet. Verified against the live app (seeded demo project) and by code + frontend↔backend contract audit.
**Spec levels:** **[MID]** = decisions, data flow, edge cases and acceptance criteria are fixed here; implementation detail is the executor's. **[ATOMIC]** = mechanical, single-behavior change; the spec below is effectively the implementation instruction.

**AGENTS.md compliance (binding for execution):** no new endpoints (REST surface stays the 6 allowed routes); no Tauri role expansion; Sonner for all toasts; NumberFlow for every animated number; Vaul for drawers; shadcn/ui primitives only; dark-studio tokens only (no new colors); vendor-neutral GPU copy (no product lines; encoder/hardware names only in diagnostics); keep the 4-step wizard and the Step-1-only focal dropzone; Windows-only packaging untouched; no hand-edited versions (Release Please owns them); conventional commits via PR, `pnpm lint && pnpm test && pnpm build` green before review. No stack change → no AGENTS.md edit required.

---

## Batch A — Correctness (P0: wrong output / silent data loss)

### A1 [MID] Re-base subtitle cues when clip boundaries change
**Files:** `src/store/projectStore.ts`, (read-only consistency) `src/store/renderStore.ts`, `src/steps/Step3Subtitles.tsx`.
**Problem:** cues are stored clip-relative (`cue.start = segment.start − clip.start`, seeded in `Step3Subtitles.tsx:417`) and `render-batch` is sent with `subtitle_timebase: "clip"`. Any later change of `clip.start` (Step 2 trim commit, `nudgeEdge`, or the buffer re-apply effect which calls `setClips`) shifts the real speech but not the cues → every burned cue drifts by the delta, silently.
**Spec:**
1. Add a pure helper `rebaseCuesForClip(subtitles, clipId, delta): Record<string, SubtitleCue[]>` (exported for unit tests): shift `start`/`end` of every cue of `clipId` by `delta`; clamp into `[0, clipDuration]` where `clipDuration = clip.end − clip.start` after the move; never delete text — clamp degenerate cues to a minimum 0.05 s window. No-op when `|delta| < 0.0005` (same epsilon the buffer effect uses).
2. `updateClip(id, patch)`: when `patch.start != null` and differs from the old start by ≥ 0.0005, compute `delta = oldStart − patch.start` and apply the helper to `project.subtitles` in the same `touch(...)`.
3. `setClips(clips)`: diff against the previous `clips` array by id (it is used wholesale by the buffer re-apply effect *and* the discovery merge); re-base every existing clip whose start moved. `addClips` cannot move existing starts — leave it.
4. Schema stays `schemaVersion: 1` (existing `.tafseer` files load unchanged; they self-heal on the next trim).
**Rejected alternative:** storing absolute cue times and converting at render — larger schema + serializer churn for no user-visible gain.
**AC:** with cues seeded, nudge "Cut in" −0.2 s five times, open Step 3 → every cue shifted +1.0 s (e.g. 2.00→3.00); export payload keeps the same absolute cue positions as before the nudges. Buffer-slider change also re-bases (verified via the re-apply effect path).
**Test:** unit tests for `rebaseCuesForClip` (±delta, clamping, empty track); Playwright: trim → Step 3 timestamp assertion.

### A2 [ATOMIC] Render style spec parity with the Step 3 preview
**Files:** `src/store/renderStore.ts` (`startRender`, ~L127–145).
**Problem:** the `resolveAssStyles` overrides omit `outlineColor` and `boxOpacity` (Step 3 passes all fields), so `assStyleToSpec` sends `defaultAssStyles` values to FFmpeg: the burned `.ass` ignores the user's outline color and background-box opacity while the preview shows them.
**Spec:** add `outlineColor: settings.arabic.outlineColor, boxOpacity: settings.arabic.boxOpacity` and the Thai pair to the two override objects, mirroring `Step3Subtitles.tsx:181–205` field-for-field (keep the Thai `lineHeightPad: 1.2` convention both places use).
**AC:** set box opacity 0.4 in settings → `StyleSpec` in the `/render-batch` request carries `boxOpacity: 0.4` for both styles; backend E2E asserts the emitted `.ass` `BackColour`/`BorderStyle` match.
**Test:** extend `backend/test_phase1_e2e.py` render test.

### A3 [MID] Flush the outgoing project's autosave on every project switch
**Files:** `src/store/projectStore.ts`.
**Problem:** `openProject`, `closeProject`, `createProject`, `resumeRecent` (L223–237, 407–428) replace/clear `project` without saving; only the debounce timer and `beforeunload` write, and they save whatever is current *at fire time*. Switching lectures inside the autosave window silently discards the outgoing project's edits.
**Spec:**
1. Private `flushCurrent()`: `if (get().project && get().dirty) get().autosave()` (localStorage write is synchronous; the disk copy is already fire-and-forget).
2. Call it first thing in `openProject`, `closeProject`, `createProject`, `resumeRecent`. Double-flush (close→create) is harmless and allowed.
3. `handleReplaceConfirm` in `Step1Ingest` needs no change (it goes through `createProject`).
**AC:** edit cues → click another Recent entry < 1 s later → resume the first project → edits present. Playwright asserts the journal entry `updatedAt` advanced.
**Test:** Playwright `project-flow.spec.ts` case.

### A4 [MID] Autosave: add a max-wait to the debounce
**Files:** `src/store/projectStore.ts` (`startProjectAutosave`, L478–492).
**Problem:** every mutation restarts the timer; continuous typing/trim-dragging postpones autosave indefinitely — a crash loses everything since the last pause.
**Spec:** throttle+debounce hybrid: keep `lastSavedAt`; in `schedule()`, if `Date.now() − lastSavedAt ≥ interval` save immediately, else arm the timer for the *remaining* time (not a full interval). `autosave()` updates `lastSavedAt` on success. Preserve current semantics of `autosaveIntervalMs === 0` (whatever it is today — verify and document in code) and the `beforeunload` flush; the settings subscriber keeps re-arming on interval change.
**AC:** simulate a mutation every 5 s with interval 15 s → at least one journal write per 20 s; constant typing for 60 s → ≥ 3 writes.
**Test:** unit-testable by extracting `schedule` math; otherwise Playwright with fake timers.

### A5 [ATOMIC] Durable disk autosave must not depend on localStorage
**Files:** `src/store/projectStore.ts` (`autosave`, L386–403).
**Problem:** `autosave()` returns early when `writeAutosave` fails (quota/privacy mode), so `persistAutosaveToDisk` — the safety net for exactly that situation — never runs, and `lastAutosaveError` stays empty.
**Spec:** call `persistAutosaveToDisk(project)` regardless of the localStorage result; when `writeAutosave` returns `false`, set `lastAutosaveError` to a short "local journal write failed" message so diagnostics (Settings → Storage) shows it. Keep the function's boolean return semantics.
**AC:** stub `localStorage.setItem` to throw → disk write still issued, `lastAutosaveError` non-null.
**Test:** unit test with a storage stub.

### A6 [MID] Cancel/interrupt render: correct clip states + delete partial MP4s
**Files:** `src/store/renderStore.ts` (`cancelRender`, abort branch), `backend/services/renderer.py` (`_run_once`, `_kill_process`).
**Problem:** after Cancel, `job.status` resets but per-clip rows stay "rendering" → Step 4 shows frozen "Encoding" badges + progress forever; the killed FFmpeg leaves a truncated, unplayable MP4 in the exports folder.
**Spec:**
1. Extend `ClipStatus` with `"cancelled"`; `statusLabel` → "Cancelled", `statusVariant` → `outline`.
2. `cancelRender` (and the abort path): map `rendering`/`queued` → `cancelled`, keep `done` rows, keep `rendered` count, clear per-clip `progress`, set `job.message` to "Render cancelled.", `status: "idle"`.
3. `renderer.py`: in `_run_once`, track a `completed` flag; in the kill/`finally` path, when not completed, `Path(job.output).unlink(missing_ok=True)` so no partial MP4 survives (Windows-safe via `pathlib`).
4. `statusLabel`/`statusVariant` maps stay exhaustive (TypeScript will enforce).
**AC:** start a 2-clip batch, cancel mid-clip-1 → row 1 "Cancelled", row 2 "Cancelled" (or "Queued"→next run re-queues anyway), no file (or zero-byte file) remains in the output folder; starting a new batch resets rows cleanly.
**Test:** backend E2E (disconnect mid-render → output absent); Playwright badge assertion against the fixed fixture (see D1).

---

## Batch B — Reliability & honesty (P1)

### B1 [MID] Make cancel real: sidecar stops work on client disconnect (no new endpoint)
**Files:** `backend/main.py` (`/extract-and-transcribe`, `/discover-clips`), `backend/services/transcriber.py` + `analyzer.py` (cancel checkpoints), `src/steps/Step1Ingest.tsx` (toast copy only if needed).
**Problem:** the frontend aborts its fetch and toasts "Transcription cancelled", but the sidecar keeps transcribing/analysing (CPU/GPU burn, model stays loaded, orphaned transcript). The render stream already cancels correctly via `GeneratorExit` (`renderer.py:453–456`) — the other two long jobs have no cancellation path.
**Spec (within the fixed REST surface — cancellation rides on HTTP disconnect, not a new route):**
1. In both handlers, run the long work in an `asyncio.Task` and race it against a disconnect watcher (`await request.is_disconnected()` poll, ~1 s); on disconnect set a `threading.Event` passed into the service call.
2. Services check the event at natural boundaries — transcriber: between segment batches; analyzer: between discovery windows (`MAX_DISCOVERY_WINDOWS`) — and raise a `CancelledError`-style exception that the handler swallows (client is gone; no response is sent).
3. Transcript-store cleanup on cancel: remove the partial transcript record so `/discover-clips` can't be pointed at it.
4. Frontend toast stays "Transcription cancelled" — it becomes true. If full service-side abort proves too invasive for one PR, the fallback is honest copy ("Stopped waiting — the sidecar finishes in the background"), but the primary spec is real cancellation.
**AC:** backend test drives transcribe with a stub transcriber that yields segments slowly, disconnects the client, and asserts the work stopped within one segment batch and the transcript record was removed.
**Test:** extend `backend/test_phase1_e2e.py`; keep the 42 existing checks green.

### B2 [ATOMIC] Size the `/discover-clips` client timeout from the real worst case
**Files:** `src/lib/api.ts` (`discoverClips`, L342).
**Problem:** client timeout 5 min; the sidecar runs up to 8 sequential LLM windows × 120 s provider timeout (`analyzer.py:203`, `config.py:284`) ≈ 16 min worst case → false "did not answer within 300s" while the sidecar keeps spending tokens.
**Spec:** `timeoutMs = clamp(providerTimeoutSec × MAX_DISCOVERY_WINDOWS × 1000 + 60_000, 5 min, 30 min)` where `providerTimeoutSec` is the timeout `buildProvider`/`buildProviderFor` sends (`settings.cloud.timeout` — the only provider timeout in settings; defaults 120 s) and `MAX_DISCOVERY_WINDOWS = 8` is a mirrored constant with a comment pointing at `analyzer.py:203`. Keep `extractAndTranscribe` at 30 min (flagged: may be short for multi-hour CPU lectures — monitor, don't change now).
**AC:** with `cloud.timeout = 120`, the computed budget ≥ 16 min; with `cloud.timeout = 5`, ≥ 460 s.

### B3 [ATOMIC] Distinguish caller abort from timeout in `request()`
**Files:** `src/lib/api.ts` (L124–163).
**Spec:** in the `AbortError` catch: if `options.signal?.aborted` → throw `ApiError("The request was cancelled.", detail: "cancelled")` (make the existing cancelled branch reachable); else keep the timeout message keyed on the internal timeout signal. No caller changes needed.
**AC:** aborting Step 1 mid-flight (after B1 lands) shows the cancelled path; a genuine timeout still shows "did not answer within …".

### B4 [ATOMIC] One GPU-fallback toast per batch
**Files:** `src/store/renderStore.ts` (fallback handler, L216–231).
**Spec:** keep a per-job `fallbackToastKeyRef = \`${failedEncoder}:${reason}\``; toast (Sonner, `toast.info`/`toast.warning`) only when the key changes; always refresh `job.message` for the on-screen banner.
**AC:** 8-clip batch on CPU-only machine → exactly one fallback toast.

### B5 [ATOMIC] A batch with failures must not toast success
**Files:** `src/store/renderStore.ts` (done handler, L320–327).
**Spec:** `event.failedClips > 0` → `toast.error("Batch finished with errors", { description: \`${rendered} rendered, ${failed} failed\` })`, else the existing success toast.
**AC:** forced `clip_error` fixture → error toast, footer shows the failed count (footer logic already correct).

### B6 [MID] Trim floor: stop silent no-ops, align minimums with the sidecar
**Files:** `src/lib/clipMath.ts`, `src/lib/projectFile.ts`, `src/steps/Step2Discovery.tsx` (`handleTrimCommit`, `nudgeEdge`).
**Problem:** `handleTrimCommit` derives speech = cut − 2×buffer and `normalizeSpeechRange` rejects speech < 1 s with `null` — the caller returns silently. A drag below `1 s + 2×buffer` (≥ 1.6 s at defaults, ≥ 4 s at max buffer) does nothing with zero feedback. The real render floor is 0.5 s (`MIN_RENDERABLE_CLIP_SECONDS`, matching the backend `RenderClip` validator).
**Spec:**
1. Move `MIN_RENDERABLE_CLIP_SECONDS = 0.5` into `clipMath.ts` and re-export from `projectFile.ts` (one source of truth).
2. `normalizeSpeechRange(start, end, duration, minSeconds = 1)` — the 1 s default stays for AI proposals; user-driven trims/nudges pass `0.5`.
3. `handleTrimCommit`: reject when `range.end − range.start < 0.5` with a Sonner toast "Clip is too short to render — minimum 0.5 s."; same floor for `nudgeEdge` results.
**AC:** drag the region to 0.6 s → commits; drag to 0.3 s → toast, region snaps back unchanged (the WaveformBar region sync effect already restores it).

---

## Batch C — UX & consistency (P2)

### C1 [MID] Recent lectures must render once, not three times
**Files:** `src/components/RecentProjectsBar.tsx`, `src/App.tsx`, `src/steps/Step1Ingest.tsx`.
**Problem (verified live):** with recents present, Step 1 shows the shell compact bar (above the stepper) + an inline row + a card strip — each lecture appears 3× per screen. Master plan §4 puts the bar above the stepper; the Step 1 surfaces are the duplication.
**Spec:** keep the shell compact bar (opening affordance, `App.tsx`) and the Step 1 **card strip** only; the non-compact bar's inline row renders only in `compact` mode. `RecentProjectsBar` header row keeps label + "Open .tafseer"/"View all". Update the component's own doc comment to describe the two intended surfaces.
**AC:** with 3 recents on Step 1: one bar above the stepper (≤ 4 items) + one card strip below; each lecture listed at most twice (once per surface), never 3×.
**Test:** Playwright count assertion on `[aria-label="Recent lectures"] button` names.

### C2 [ATOMIC] One coherent sentence for the Step 1 provider-gap warning
**Files:** `src/steps/Step1Ingest.tsx` (inline warning ~L945–960, `handleTranscribe` pre-flight toast ~L446–452).
**Problem:** "Clip discovery needs the API key — transcription is blocked until it is set" reads self-contradictory and is the default first-run state (analysis defaults to Cloud with no key).
**Spec:** single shared string: *"Topic analysis (Step 2) needs {gap}. Transcribing now would produce a transcript Step 2 can't search, so it's blocked until this is set."* used by both the inline warning and the pre-flight toast. Keep the deliberate pre-flight block (the code comment's rationale — don't waste an hour-long transcription — is sound).
**AC:** copy is identical in both places; no claim that "clip discovery is blocked" while pointing at transcription.

### C3 [ATOMIC] Unify control terminology across Steps 3/4
**Files:** `src/steps/Step3Subtitles.tsx`, `src/steps/Step4Export.tsx`, `src/lib/projectTypes.ts`.
**Problem:** same setting called "Aspect ratio" (S3) / "Output format" (S4 label) / "Output resolution" (S4 aria); same option called "Blur fill" (S3) / "Blurred fill" (S4) / "Blur fill" (S4 queue rows — same screen).
**Spec:** export `FRAMING_LABELS: Record<FramingMode, string> = { "blur-fill": "Blur fill", "center-crop": "Center crop" }` from `lib/projectTypes.ts`; use it in Step 3, Step 4 and the queue rows. Step 4's toggle section label becomes "Aspect ratio" and its `SegmentedToggle label` becomes "Aspect ratio" (aria parity).
**AC:** text search shows one label per concept; the queue row and the panel agree on the same screen.

### C4 [ATOMIC] Don't offer 9:16 framing when the output is 16:9
**Files:** `src/steps/Step4Export.tsx` (settings column).
**Spec:** when `resolution === "1920x1080"`, replace the Framing mode toggle with the explanatory line Step 3 already uses ("16:9 output uses the whole frame, so 9:16 framing does not apply."), or render the toggle `disabled` with that caption. Match Step 3 behavior.
**AC:** switching the Step 4 aspect toggle to 16:9 removes/disables framing with the caption; the per-row "framing" chip shows "—" for 16:9.

### C5 [MID] Tell the truth about the output folder; add Copy path
**Files:** `src/steps/Step4Export.tsx`, `src/store/renderStore.ts` (expose `job.outputDir` — already set from SSE `start`/`done`).
**Problem:** hint says "the sidecar writes to the source folder" — it writes to `<source>\exports` (`main.py:1216–1221`); the authoritative `output_dir` from SSE is stored but never shown; `resolvedOutputDir` is `""` for transcript-only resumes.
**Spec:**
1. Folder line shows `job.outputDir` when known (labelled "from the sidecar"), else `defaultOutputDirectory(sourcePath)` labelled "defaults to"; when both are empty show "decided by the sidecar at render time".
2. Fix the hint text to "the exports folder next to the lecture".
3. Add a ghost "Copy path" button (shadcn `Button size="xs"`) next to the footer folder text: `navigator.clipboard.writeText(path)`, Sonner toast "Output path copied"; disabled when no path. **No Tauri change** — "Open in Explorer" would require an AGENTS.md §3 role amendment and is out of scope.
**AC:** after `start` SSE arrives, the displayed path equals the sidecar's `output_dir`; Copy path lands it on the clipboard.

### C6 [ATOMIC] "Render again" must not look like a spinner
**Files:** `src/steps/Step4Export.tsx` (footer, ~L646).
**Spec:** swap `Loader2` for `RotateCw` (same size/spacing). Loader2 stays reserved for real in-progress states.

### C7 [MID] Stepper checkmarks must mean "complete", not "below the current step"
**Files:** `src/components/StepperHeader.tsx`.
**Problem:** `done = step < currentStep` marks steps ✓ even when their work never happened (project with no transcript at step 4 shows ✓ on 1–3).
**Spec:** derive completion (project-scoped, cheap selectors):
- step 1 ✓ ⇔ `project.transcriptId && project.transcript`
- step 2 ✓ ⇔ ≥ 1 approved clip
- step 3 ✓ ⇔ every approved clip has ≥ 1 non-empty cue
- step 4 ✓ ⇔ the render job for `project.id` has `status === "done"`
Navigation stays free (the empty states already guard each screen); only the glyph changes. Active step keeps `aria-current="step"`; `aria-label` of each button gains the state ("step 2, complete").
**AC:** fresh project → jump to step 4 via the palette → no ✓ anywhere; approve one clip → step 2 gains ✓ only.

### C8 [ATOMIC] Discovery cancel must acknowledge itself
**Files:** `src/steps/Step2Discovery.tsx` (catch branch, L475–480).
**Spec:** on `controller.signal.aborted`, `toast("Discovery cancelled")` (matches Step 1's "Transcription cancelled" pattern). No state change beyond existing `setStatus("idle")`.

### C9 [ATOMIC] One relative-time + duration formatter
**Files:** `src/components/RecentProjectsDrawer.tsx`.
**Problem:** the drawer has its own `relativeTime` (L13–20) and shows "1 min" for a 45 s lecture where the bar shows "45 s" (`RecentProjectsBar` switches s/min).
**Spec:** delete the local `relativeTime`; import from `@/lib/format`. Reuse the bar's s/min switch by extracting it as `formatLectureDuration(seconds)` in `lib/format.ts` and using it in both components (NumberFlow stays the renderer in both).

### C10 [ATOMIC] Waveform axis labels must match the visible window
**Files:** `src/components/WaveformBar.tsx` (bottom row, L288–291).
**Spec:** in `focus` mode label the clip window: `formatClock(clipStart)` … `formatClock(clipEnd)`; in fit mode keep `0:00` … `formatClock(duration)`.

### C11 [ATOMIC] Collapse the Step 2 player when there's no video
**Files:** `src/steps/Step2Discovery.tsx` (video wrapper, ~L920).
**Spec:** when `videoSrc` is null or the player reports `error`, render the placeholder in a compact `h-24`-ish box instead of `aspect-video`, so the waveform + trim controls sit above the fold on 900-px-tall windows. Keep `aspect-video` when the preview works. No visual flourish (Steps 2–4 stay calm per AGENTS.md §1 Layer 3).

### C12 [MID] Accessible names and semantics for clip cards and cue blocks
**Files:** `src/steps/Step2Discovery.tsx` (`ClipCard`), `src/steps/Step3Subtitles.tsx` (cue container).
**Problem:** accessible names concatenate NumberFlow/TimeFlow digit spans into garbage (`"1เรื่องราว…:→:·…"`); cue blocks are `role="button"` divs containing textareas and buttons (button-inside-button semantics).
**Spec:**
1. `ClipCard`: explicit `aria-label` on the selection button — `` `${clip.title}, ${formatClock(clip.start)} to ${formatClock(clip.end)}, ${clip.approved ? "approved" : "not approved"}` `` (formatClock is already the aria source in `TimeFlow`).
2. Cue block: drop `role="button"`/`aria-pressed`/`tabIndex`; select on `focusin` (keyboard) and `onClick` (pointer); keep the visual active state via `data-active` styling.
3. Same explicit-label treatment for the Step 3 cue time header if the snapshot is still noisy.
**AC:** Playwright `ariaSnapshot()` shows the card as a named button and no button nested in a button; keyboard tab order reaches both textareas and activates the block.

### C13 [ATOMIC] Clamp seeded cue end to the clip window
**Files:** `src/steps/Step3Subtitles.tsx` (seed effect, L413–422).
**Spec:** `end: Math.min(segment.end − clip.start, clip.end − clip.start)` alongside the existing `Math.max(0, …)` on both fields; segments fully outside the clip are already filtered.
**AC:** a segment straddling the cut produces a cue ending exactly at the clip duration.

### C14 [MID] Wrap Thai on commit, not on every keystroke
**Files:** `src/steps/Step3Subtitles.tsx` (`handleCueChange`, `handleSplit`), `src/store/renderStore.ts` (payload build).
**Problem:** `wrapSubtitleText` runs per keystroke — typing past 40 chars inserts hard breaks mid-edit and can jump the caret.
**Spec:**
1. `handleCueChange` stores the raw value; wrap on textarea `onBlur` (and keep wrapping the two halves in `handleSplit`, which is a commit point).
2. Guarantee wrapped output at the boundary: `renderStore` wraps `cue.thai` with `maxCharsPerLine` when building `subtitles[]` for `/render-batch` (idempotent — `wrapSubtitleText` is already safe to re-apply), so preview-by-commit and export stay identical.
3. Seeding keeps wrapping (unchanged).
**AC:** typing a 60-char Thai line produces no `\\n` until blur; the `/render-batch` payload for that cue is wrapped to ≤ 40 chars/line; caret stays where typed.

### C15 [ATOMIC] Encoder names out of the main UI (AGENTS.md §3 copy rule)
**Files:** `src/steps/Step4Export.tsx` (queue header L241–246, row L347).
**Problem:** the queue shows raw encoder names (`h264_nvenc`, `libx264`); AGENTS.md §3: "hardware names/encoder names appear only in diagnostics and technical docs".
**Spec:** map to vendor-neutral labels — encoder containing `nvenc` → "GPU", else "CPU" (header chip: "GPU encoding"/"CPU encoding"; row chip likewise). Keep the raw string in `renderStore` state so diagnostics can still print it (the diagnostics view is Settings-side — handoff note appended to the coordination file).
**AC:** no encoder identifier is visible anywhere in Steps 1–4; diagnostics (Settings) still receives the raw value.

### C16 [ATOMIC, optional] "Continue where you left off" affordance
**Files:** `src/components/RecentProjectsBar.tsx`, `src/store/projectStore.ts`.
**Problem:** a reload/app restart silently drops the open project (only `recentProjects` persists).
**Spec (contract-safe — the Recent Lectures bar stays the opening surface per master plan §4):** persist `lastProjectId` alongside `recentProjects` in `tafseer.projects.v1`; when set and matching a recent entry, that entry renders first with a "Continue where you left off" caption. No modal, no auto-restore.
**AC:** reload with an open project → the bar leads with that project, one click resumes at the saved step.

---

## Batch D — Test & contract hygiene (P3)

### D1 [MID] Make the SSE fixture speak the backend's actual dialect
**Files:** `tests/e2e/fixtures.ts`.
**Problem:** the mock `start` frame carries `output_dir` and `status: "running"` (real: no `output_dir`, `status: "processing"`); `clip_done` omits `duration` and adds `clip_progress` — tests pass against a shape the backend never emits.
**Spec:** mirror `backend/main.py:1433–1549` frame-for-frame (including `fallback` and `clip_error`); if the client-side `outputDir` guess path needs coverage, cover it with a fixture variant that omits `output_dir` explicitly and assert the guessed value, so drift is visible both ways.

### D2 [ATOMIC] Use or document the dead contract surface
**Files:** `src/lib/api.ts`, `src/steps/Step2Discovery.tsx`, `src/store/renderStore.ts`.
**Spec:** use `DiscoverResponse.excluded_ranges_applied.length` for the Step 2 re-roll toast ("N approved intervals locked" — server truth instead of the client count). Add a code comment above `RenderEvent.stage/clipCount/duration` stating they are parsed and intentionally ignored (removal is a contract change and not worth it now).

### D3 [ATOMIC] Remove the duplicated `/* Step 1 */` comment block
**Files:** `src/steps/Step1Ingest.tsx` (L67–73).

### D4 [ATOMIC] Defensive SSE defaults in `renderStore`
**Files:** `src/store/renderStore.ts` (progress/done handlers).
**Spec:** `overall: event.progress ?? state.job.overall`; `failedClips ?? state.job.failed`; `status: (event.failedClips ?? state.job.failed) ? "error" : "done"` — protects against older sidecars per the repo's compatibility stance.

### Handoffs to the settings session (tracked in the coordination file, not mine to execute)
- **H1:** clamp `minDuration`/`maxDuration`/`cloud.timeout` in `settingsStore` coercion to backend bounds (`main.py:275–276`, `> 0`).
- **H2:** align `subtitle_gen.default_styles` (backend) with `defaultAssStyles()` (frontend) — ownership to be confirmed in the coordination file.

---

## Execution order & CI rules

1. **Batch A** (A1–A6) → `pnpm lint && pnpm test && pnpm build` → PR `fix(workspace): …`.
2. **Batch B** (B1–B6) → same gates → PR(s) `fix(api): …` / `fix(render): …` (B1 touches `backend/` — run `backend/test_phase1_e2e.py` in full, keep 42/42 + new checks).
3. **Batch C** (C1–C16) in the table order (visible wins first) → PR `fix(ui): …` / `feat(ui): …` for C16.
4. **Batch D** with whichever batch touches the same files first.
5. Never push to `main`; never hand-edit versions (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `backend/config.py` are Release Please's). Conventional Commit PR titles. No workflow/action changes → no SHA-pinning work. Windows-only matrix untouched.

## Out of scope (explicit)

- `SettingsDrawer.tsx` and all settings-tab UX (other session).
- New endpoints, WebSockets, agent frameworks (contract §3).
- "Open in Explorer" / anything expanding the Tauri role.
- Channel watermark, intro/outro stitching (contract §4 exclusions).
- Light theme, new component libraries, second Magic UI element (contract §1–2).
