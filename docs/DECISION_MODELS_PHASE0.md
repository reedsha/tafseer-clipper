# Decision models — Phase 0 results

Status: **fixtures + baselines recorded; no candidate model has cleared the gate
in this checkout.** This note is the source of truth for the per-slot
thresholds and defaults used by the decision tier
(`docs/DECISION_MODELS_PLAN.md` §4, §8).

## Harness

`backend/scripts/eval_decision_models.py` is the only evaluator. It builds the
fixtures, probes candidate models, scores the shipping heuristics on the same
rows, and writes `backend/eval_data/report.{json,md}` with a per-slot
recommendation.

```powershell
py -3.12 backend/scripts/eval_decision_models.py build-fixtures
py -3.12 backend/scripts/eval_decision_models.py baselines
py -3.12 backend/scripts/eval_decision_models.py run --models tev1,laya
```

`run` never crashes on an unreachable model: the probe records the provider's
reason, the baseline is still measured, and the report recommends keeping
today's path. That is a valid Phase-0 outcome.

## Fixtures

`backend/eval_data/manifest.json` records the counts and every known gap rather
than padding the sets with invented rows.

| Task | Rows | Gap to the 100-row target | Honesty note |
|---|---:|---:|---|
| `recitation` | 66 | 34 | No real lecture transcript is stored in the repository. Qur'an rows are real corpus text; Thai explanation and Thai-script-Arabic rows are curated seeds. Treat Thai accuracy as indicative. |
| `verify_triage` | 177 | 0 | Corruptions are synthetic (diacritics dropped, one letter swapped); ground truth is exact by construction. |
| `clip_scoring` | 120 | 0 | Candidates are synthetic windows with seeded quality labels. This measures rubric adherence, not real-lecture recall. |

The 34-row recitation gap is reported by `build-fixtures` and must not be
silently closed by duplicating seeds; the recitation slot needs real lecture
transcripts (and the Phase-3 recall check on fixture lectures) before its
accuracy claim is treated as production-grade.

## Baselines (shipping heuristics, same rows)

| Task | Rows | Accuracy | ECE |
|---|---:|---:|---:|
| `recitation` | 66 | 0.7576 | 0.2424 |
| `verify_triage` | 177 | 0.6610 | 0.3390 |
| `clip_scoring` | 120 | 0.7500 | 0.2500 |

These heuristics report nominal confidence `1.0`, so their ECE mostly measures
how often the rule is wrong, not calibration. The gate below applies to
candidate decision models, which report real probabilities.

## Gate and per-slot defaults

A candidate is eligible for a slot only when it beats the shipping baseline by
at least **2 accuracy points** and its **ECE is ≤ 0.15**
(`MIN_ACCURACY_GAIN`, `MAX_ECE` in the harness). The runtime thresholds are
deliberately more conservative than the harness gate, because a live mistake
costs a real lecture:

| Slot | Runtime rule | Where |
|---|---|---|
| `analysis` (recitation) | A choice answer below `0.6` confidence escalates that segment to the windowed generative audit; an unknown label always escalates. | `decision_tasks.MIN_CONFIDENT`, `analyzer.audit_arabic_decision` |
| `verify_triage` | A line is skipped only when the model says "no correction" **and** `P(true) ≤ 0.4` **and** confidence is `≥ 0.5`. Everything else is proofread. Any triage error proofreads every pending line. | `decision_tasks.triage_from_answers`, `services/verify.py` |
| Sentence breaks | A proposed boundary below `0.5` confidence is ignored; a decision failure falls back to the single LLM grouping call (or the heuristic map when no LLM is configured). | `analyzer.sentence_breaks_decision`, `analyzer.group_sentences_with_decision` |
| `clip_scoring` | Finalists need `rank_score ≥ 0.2`; an incomplete window is multiplied by `0.55` before ranking. Titles are written only for finalists. | `analyzer._discover_with_decisions` |

Two invariants sit above every threshold:

1. **Off means today's behavior.** All slots default to `enabled: false` and an
   empty model, so every caller takes the legacy path unchanged.
2. **Failure is not a verdict.** A malformed, unreachable or over-confident
   decision answer escalates to the generative model or to the deterministic
   rule; it never silently suppresses Arabic correction, recitation recovery,
   or a clip candidate.

## Ollama version gate

Local decision models require Ollama `>= 0.35` (`/v1/systemone`). `GET /health`
reports `providers.ollama.decision_models` and `providers.decision_endpoint`
only when the probe answers from that version; the Settings picker labels an
older server honestly instead of offering a slot that cannot work. Cloud slots
are unaffected.

## Reproducing the note

`build-fixtures` is deterministic for the seeded rows; the manifest timestamp
changes, the counts and baselines do not. Re-run `baselines` before changing any
runtime threshold in the table above, and update this note in the same change.
