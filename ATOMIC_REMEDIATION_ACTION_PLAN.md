# ATOMIC_REMEDIATION_ACTION_PLAN.md — Codebase Redesign & Full Action Plan

> **Document Status:** Complete Architecture Redesign & Execution Action Plan  
> **Canonical Document:** [docs/ATOMIC_REMEDIATION_ACTION_PLAN.md](file:///c:/dev/tafseer-clipper/docs/ATOMIC_REMEDIATION_ACTION_PLAN.md)  
> **Source Audit:** [ATOMIC_AUDIT.md](file:///c:/dev/tafseer-clipper/ATOMIC_AUDIT.md)  
> **Architecture Contract:** [AGENTS.md](file:///c:/dev/tafseer-clipper/AGENTS.md)  
> **Target Platform:** Windows 10/11 x64 (Tauri v2 + FastAPI Sidecar + React 19 Studio)  
> **Standard:** Atomic-tier verification tasks (`[A-01]` through `[A-24]`). Every task is individually verifiable with a stated automated command.

Please refer to the full canonical document at:  
👉 **[docs/ATOMIC_REMEDIATION_ACTION_PLAN.md](file:///c:/dev/tafseer-clipper/docs/ATOMIC_REMEDIATION_ACTION_PLAN.md)**

---

## Quick Reference Summary

| Phase | Tasks | Primary Domain Focus | Target Files |
| :--- | :--- | :--- | :--- |
| **Phase 1** | `[A-01]` - `[A-04]` | Critical Religious & Filesystem Integrity | `backend/services/quran.py`, `recitation.py`, `src-tauri/src/lib.rs`, `projectFile.ts`, `subtitle_gen.py` |
| **Phase 2** | `[A-05]` - `[A-09]` | Domain Precision, Subtitles & FFmpeg Rendering | `quran.py`, `verify.py`, `subtitleWrap.ts`, `subtitleCues.ts`, `renderer.py` |
| **Phase 3** | `[A-10]` - `[A-13]` | AI Services, Context Budgets & Decision Models | `analyzer.py`, `decision.py`, `SettingsScreen.tsx`, `Step2Discovery.tsx`, `main.py` |
| **Phase 4** | `[A-14]` - `[A-22]` | State Hygiene, Memory GC & Desktop UX | `taskResults.ts`, `projectFile.ts`, `api.ts`, `WaveformBar.tsx`, `subtitleWidth.ts`, `projectStore.ts` |
| **Phase 5** | `[A-23]` - `[A-24]` | Build, Release & CI/CD Pipeline Hardening | `.github/workflows/release.yml`, `.github/workflows/ci.yml` |

For the full architectural redesign, exact data structures, algorithms, formulas, and verification commands, see [docs/ATOMIC_REMEDIATION_ACTION_PLAN.md](file:///c:/dev/tafseer-clipper/docs/ATOMIC_REMEDIATION_ACTION_PLAN.md).
