# Decision Models — Implementation Plan

> **Granularity policy.** The base of this plan is **mid-tier**: work packages with scope, touch points, and acceptance criteria — enough to steer and review, not an edit-by-edit script. Selected parts are broken down to **atomic tier** (numbered steps, each with its own verification) where precision pays for itself: contract guards, unproven technology, and small fixes that are cheap to verify independently. Atomic sections are marked **[ATOMIC]**.

> **Status:** implemented 2026-11 (Phases 0-5). The tier lives in `backend/services/decision.py`, `decision_tasks.py`, `verify.py`, `recitation.py` and `quran.py`; the renderer only sends per-slot settings on its existing requests. Measured baselines, the gate and the per-slot runtime thresholds are in `docs/DECISION_MODELS_PHASE0.md`. The `clip_scoring` slot was retired in 2026-11; Step 2 is the writing model plus `sanitize_clips`.

---

## 1. Goal

Insert a **decision-model tier** into the 4-step workflow so that binary/multi-class/ranking judgments stop consuming the generative LLM. The tier in question is the "System One" class of models — discriminative models that take `state` + typed `questions` (`noul` / `choice` / `score`) and return calibrated probabilities in one forward pass (Jev, Tev1, Laya, Nimble, pplx-decider, and compatible models).

**Escalation principle (applies at every integration point):**

```
deterministic (corpus match, heuristics)  →  decision model (thresholded, confidence-gated)  →  generative LLM (writes text, or resolves low confidence)
```

Every stage degrades gracefully: **with no decision model configured, every endpoint behaves exactly as today.**

**Hard constraints (from `AGENTS.md`):**
- The frontend↔sidecar REST surface stays frozen at the 7 existing endpoints. The decision layer is an internal sidecar service; request schemas grow **additive fields only**.
- All provider configuration flows through the sidecar; the frontend only sends settings.
- User-facing copy follows `docs/UX_ALIGNMENT_PLAN.md` vocabulary (tier labels first, codenames in hints only; "This computer" / "Your AI account" toggles).
- Settings and stage configuration are full-page screens, not drawers.

---

## 2. Decision slots

Each slot is independently configurable in Settings (cloud/local toggle + a model picker that filters by familiar decision-family **name**; unfamiliar names are not listed but remain reachable via the free-text custom-model input, and the live probe validates on the Settings "Test" button).

| Slot ID | Where used | Question type | Escalates to |
|---|---|---|---|
| `analysis` | Step 1 — recitation detection (`{quran, hadith, quote, none}` per segment) and sentence-boundary gaps | `choice`, `noul` | Today's windowed LLM audit / LLM grouping (`analyzer.audit_arabic`, `analyzer.group_sentences`) |
| ~~`clip_scoring`~~ | Retired 2026-11 — Step 2 is the writing model plus `sanitize_clips` (see `docs/DECISION_MODELS_PHASE0.md`). | — | — |
| `verify_triage` | Step 3 — "is a correction likely?" gate before proofreading | `noul`, batched per clip | Fast generative proofreader (`ARABIC_SYSTEM_PROMPT`) |

**Explicit non-fit:** title/rationale writing, Uthmani correction, and transcription remain generative/STT work. No decision model touches them.

---

## 3. Phase 0 — Validation harness **[ATOMIC]**

> Why atomic: the accuracy of local decision models on Thai-script + Arabic content is unproven. Every downstream phase depends on these numbers; each step below is independently verifiable.

**0.1 — Fixture builder.** New `backend/scripts/eval_decision_models.py build-fixtures`:
walks `backend/services/quran.py` corpus matches and recitation-recovery outputs (`recitation.py` tags `quran`/`hadith`/`quote`) to emit labeled examples into `backend/eval_data/`:
(a) Thai segments with recitation class labels; (b) Arabic lines paired with synthetic corrupted variants (corpus lines with dropped harakat / swapped letters — free ground truth); (c) candidate clip windows with seeded quality labels.
*Verify:* fixture counts printed; ≥ 100 examples per task or the gap is reported honestly.

**0.2 — Task adapters.** One `state`/`questions` builder per task: recitation (`choice`), verify-triage (`noul`), clip-scoring (`score`).
*Verify:* round-trip unit tests on the request shape against the System One schema.

**0.3 — Candidate runner.** Probes `/v1/systemone` on local Ollama (`tev1`, `tev1:0.8b`, `laya`, `nimble` if present) and the configured cloud decisions endpoint (pplx-decider / platform dec models). Skips candidates that fail a 1-shot probe and records the reason.
*Verify:* runner reports per-candidate availability without crashing on missing models.

**0.4 — Metrics.** Accuracy per task, plus **calibration** (are returned probabilities honest? — reliability diagram / ECE). Per-language breakdown where labels allow.
*Verify:* a single JSON + Markdown report written to `backend/eval_data/report.*`.

**0.5 — Baselines.** Score the current heuristic baselines (Arabic char-ratio gate `recitation.py:31-32`, corpus match `quran.py:143-189`) on the same fixtures.
*Verify:* baseline numbers appear in the same report.

**0.6 — Gate decision.** A candidate earns a slot only if it beats the slot's baseline and calibrates acceptably (ECE within tolerance set in the report). A slot nothing wins keeps its heuristic/LLM path — that is a valid outcome.
*Verify:* the report ends with a per-slot recommendation; this becomes the default in Phase 1.

---

## 4. Phase 1 — Decision client, plumbing, Settings tab

### 1A. `backend/services/decision.py` **[ATOMIC — interface contract]**

The client is the foundation; its contract is fixed before anything calls it.

- `decide(provider, state, questions) -> DecisionAnswers` where `questions: dict[str, Question]`, `Question ∈ {noul, choice(criteria), score(criteria)}`, and answers carry `type`, value, `probabilities`, `confidence`.
- Adapters (identical request shape, different path/auth): Ollama `POST /v1/systemone`; cloud decisions endpoint with `endpoint_style ∈ {openrouter, perplexity, runware, typesafe}` (path template table in the module).
- Error semantics and retry parity with `analyzer.chat()` (`backend/services/analyzer.py:99-166`); malformed answers raise `LLMError`-equivalent, never return partial types.
- Role resolution parallel to `merge_provider` (`analyzer.py:56-83`) with env defaults `TAFSEER_DECISION_*` in `backend/config.py`.
*Verify:* contract unit tests (mock transport): happy path per adapter, 400/timeout/parse-failure paths, provider merge precedence.

### 1B. Provider plumbing (mid-tier)

- Additive request field `decision_provider: {mode, base_url, api_key, model, endpoint_style}` on `/extract-and-transcribe`, `/discover-clips`, `/verify-arabic` (optional; absence = legacy behavior).
- `/health` gains additive `providers.ollama.decision_models`, `decision_endpoint` (Ollama ≥ 0.35 required — detect, never assume), and `models_detail`. `/list-models` and `ModelSelect` gain `filter="decision"`, which filters the picker by familiar decision-family **name**; unfamiliar ids are not listed but remain reachable via the free-text custom-model input, and the live probe validates on the Settings "Test" button. Hiding is an explicit UI choice, never silent suppression, and never blocks degradation. It matches the existing filter pattern in `src/components/config/shared.tsx:536-551`.
*Acceptance:* a request carrying `decision_provider` reaches `decide()`; one without behaves byte-for-byte like today; `test_phase1_e2e.py` stays green and grows fallback cases.

### 1C. Settings tab (mid-tier)

- `src/store/settingsStore.ts`: `decisionSlots: { analysis, verify_triage: { mode, model } }`; base URL/key reused from the existing `cloud` / `ollama` connections (never duplicated). Persisted with the rest of settings.
- New section in `src/components/config/SettingsScreen.tsx`: one card per slot — `SegmentedToggle` "This computer" / "Your AI account", `ModelSelect` filtered to decision models, **Test** button (single trivial systemone probe), status line in UX-plan vocabulary (tier label first, codename in hint).
- `src/lib/aiActivity.ts` labels for decision calls; toasts follow "event + next action" copy rules.
*Acceptance:* per-slot choice round-trips to the sidecar on the next relevant call; Playwright covers the section; `pnpm lint` / `pnpm test` / `pnpm build` green.

---

## 5. Phase 2 — Step 3: verify triage + batching *(first user-visible win)*

**2.1 — Additive batch field **[ATOMIC — contract guard]****. `/verify-arabic` accepts optional `lines: [{arabic_text, context_thai}]` (≤ 64) alongside the existing single-line shape. Schema tests pin both shapes; the single-line path is untouched.
*Verify:* request-schema tests; single-line regression in `test_phase1_e2e.py` unchanged.

**2.2 — Corpus-first gate **[ATOMIC]****. Before any model: `quran.match_text` (`backend/services/quran.py:143-189`) over each line; near-exact matches pass instantly with `source: "quran"`.
*Verify:* unit test — a corpus-exact line triggers zero model calls.

**2.3 — Dec triage (mid-tier).** One `verify_triage` request per clip: all lines as questions (`noul`: "is a correction likely?"), confidence-gated. Only flagged lines reach the fast generative proofreader (`ARABIC_SYSTEM_PROMPT`, `analyzer.py:507-521`).
*Acceptance:* "Check N Arabic" on a 40-line clip costs 1–3 round-trips instead of N sequential ones; flagged-line correction quality identical to today; no dec model ⇒ today's per-line loop.

**2.4 — Frontend batch call (mid-tier).** `handleVerifyAll` in `src/steps/Step3Subtitles.tsx:924-987` issues one batched request per clip (progress UI simplified to per-clip counts). Per-line "Check Arabic" keeps its single-call path.

---

## 6. Phase 3 — Step 1: recitation detection + sentence boundaries

**3.0 — Whisper auto-unload ordering fix **[ATOMIC — independent bug fix]****. Today the warm model is unloaded after the main pass and immediately re-loaded for recitation spans, then left resident against the user's `auto_unload` preference (`backend/main.py:1340` vs `1398`). Move span passes inside the unload window (or defer unload to end-of-request).
*Verify:* targeted regression in `test_phase1_e2e.py` asserting load/unload sequence; no behavior change otherwise.

**3.1 — Recitation detection (mid-tier).** Replace the big-LLM audit (`analyzer.audit_arabic`, `analyzer.py:694-744`) with `analysis`-slot `choice` calls: segments batched as one `state`, one question per segment (≤ 64/req), confidence-gated — low-confidence segments escalate to the existing windowed audit. Downstream span handling (`main.py:1387-1424`) unchanged.
*Acceptance:* 2–16 LLM calls drop to 1–3 systemone calls plus an escalator tail; labels match Phase-0 accuracy; fallback = today's audit.

**3.2 — Sentence boundaries (mid-tier).** Heuristics first (pause gaps already present in Whisper timestamps + punctuation + length caps), `noul` only on ambiguous gaps, LLM grouping as final fallback (frontend `groupWords` fallback already exists, `src/lib/subtitleCues.ts:258`).
*Acceptance:* grouping quality no worse than today on the Phase-0 fixture set; most windows need zero model calls.

---

## 7. Phase 4 — Step 2: candidate generation + decision scoring

**7.1 — Candidate generator (mid-tier).** Deterministic candidate windows in `backend/services/analyzer.py`: sentence boundaries + silence gaps + duration bounds (`project.discovery`). The LLM stops inventing timestamps from raw text.
*Acceptance:* generator covers ≥ the spans today's LLM finds on fixture lectures (recall check against current outputs).

**7.2 — Scoring + finalists (retired 2026-11).** ~~`clip_scoring` slot scores candidates against the clip brief (`score` + `noul`); the reasoning LLM writes Thai titles/rationales for finalists only.~~ Removed: with a local scoring model the ranking was flat on a real lecture and failed its own confidence gate on every run, so the writing model did the work anyway (`docs/DECISION_MODELS_PHASE0.md`). The writing model now proposes and names clips in one pass.

**7.3 — Re-roll exemplars (mid-tier).** The user's approved/trash clips enter `state` as positive/negative exemplars (`excluded_ranges` retained). The Step 2 request grows additive fields carrying this feedback.
*Acceptance:* re-rolls respect exclusions as today and measurably reuse feedback (spot-check set of re-rolls on fixture projects).

**7.4 — `sanitize_clips` upgrades **[ATOMIC — rules table]****. Pin the exact post-processing rules before coding (`analyzer.py:372-433`): clamp vs. drop per violation type (duration bounds clamp where sentence-safe; overlap and exclusion violations drop), per-window JSON salvage (a malformed reply no longer loses the window — current `discover_clips` behavior), overlap resolution by score rank instead of "keep earliest".
*Verify:* table-driven unit tests, one case per rule row.

---

## 8. Phase 5 — Tests, docs, contract sync (mid-tier)

- `pnpm lint` / `pnpm test` / `pnpm build` green: backend E2E extensions (fallbacks + existing GPU→CPU regressions untouched), Playwright for the Settings section and batched Verify-all.
- Sync `AGENTS.md` §3: record the internal decision layer (endpoint list unchanged; additive request fields and provider-side adapters documented).
- `docs/` note capturing Phase-0 results as the source of truth for per-slot defaults: `docs/DECISION_MODELS_PHASE0.md` (fixtures, baselines, gate, runtime thresholds).

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Thai-script / Arabic accuracy of local decision models | Phase 0 gate + confidence thresholds + LLM escalator everywhere |
| Ollama < 0.35 (no `/v1/systemone`) | Detected via `/health`; slots label it honestly; cloud slot unaffected |
| Cloud platform decisions-endpoint variance | `endpoint_style` adapters (1A) + probe in the Settings **Test** button |
| Silent output regressions in clip discovery | 7.4 rules table pinned before code; fixture recall checks in 7.1 |
| Installer size creep (if an ONNX-bundled route is ever added) | Out of scope — see below |

**Out of scope (deliberate):** ONNX weights bundled into `backend.exe` (v2 candidate; the Settings-driven Ollama/cloud routes cover current needs); new REST endpoints; translation; any change to the wizard flow or Keep & Re-roll UX.

---

## 10. Order, dependencies, definition of done

```
Phase 0 (eval gate)
   └─► Phase 1 (client 1A → plumbing 1B → Settings 1C)
          └─► Phase 2 (Step 3 win)  ─► Phase 3 (Step 1)  ─► Phase 4 (Step 2)
                                          └─► Phase 5 (tests/docs, continuous from Phase 1)
```

- Phase 2 ships before 3/4: biggest latency win, least risk.
- 3.0 (unload fix) is independent and may land any time after Phase 0 starts.
- Commits are conventional (`feat:` / `fix:` / `chore:`) while Release Please is in use; local `pnpm lint`, `pnpm test`, `pnpm build` green before each push.

**Definition of done (whole plan):** all three slots selectable in Settings and exercised in their steps; every integration point degrades to today's behavior with no decision model configured; Phase-0 report exists and justifies the shipped defaults; `AGENTS.md` and docs updated; CI green.
