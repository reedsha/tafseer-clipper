# RELEASE GREEN PLAN

**Date:** 2026-11-15
**Objective:** move Tafseer Clipper from `NOT RELEASE READY` to **all green**, and keep it there.

**Entry state** — the measurements behind this plan live in
[`docs/RELEASE_READINESS.md`](RELEASE_READINESS.md) (`blocker BL-x` below point into it):

| Blocked on | Count | Nature |
|---|---|---|
| Product defect | 1 | GPU→CPU fallback missing (BL-1) |
| Broken/uncertain gate | 2 | backend suite aborts at 27/40 (BL-2) · 2 required tests are flaky (BL-7) |
| Publishing path | 2 | no Authenticode credential (BL-3) · existing artifacts signed with a rotated-out key (BL-4) |
| Untested acceptance | 1 | `docs/RELEASE_CHECKLIST.md` → **61/61 unchecked** (BL-5) |
| Pending review | 1 | 5 Dependabot PRs (BL-6) |

**Hard constraint on this plan.** `AGENTS.md:5` forbids writing application code —
"components, endpoints, services, stores, Tauri config" — outside a phase the user explicitly
instructs to begin from Section 8 of the master plan. **Streams 2 and 3 below change application
code and therefore need an explicit go-ahead before I touch them.** This document is a plan only;
nothing in it is applied yet. Streams 0, 1 (docs/settings), 4, 5 and 6 are not blocked by that
constraint and can run on your word.

---

## What "green" means (Definition of Done)

Chasing "CI is green" is not enough — the release-readiness report proved that signal lies in both
directions. Green is five separate states, and all of them must hold simultaneously.

| # | Green state | Exit criterion | Evidence to produce |
|---|---|---|---|
| **G-A** | **Trustworthy gates** | Every **required** check is deterministic — a re-run of an identical commit must never change its verdict | Re-run proof on a branch: same SHA, same result |
| **G-B** | **Functional gates hold** | `pnpm lint`, `pnpm build`, `cargo test --locked`, **backend E2E 40/40**, Playwright `6/6` — all exit 0 in one run | §-referenced run log + matching CI run |
| **G-C** | **Product contract holds on GPU hardware** | `/extract-and-transcribe` degrades to **CPU** and returns `503 {"detail":…}` JSON on an NVIDIA machine **without** the acceleration pack installed | Screenshot/log of the contract on your RTX 3050 & a `40/40` run there |
| **G-D** | **Package acceptance holds** | `docs/RELEASE_CHECKLIST.md` = **61 checked / 0 unchecked**, signed off | Checkboxed checklist + sign-off line |
| **G-E** | **A shippable artifact exists** | A rebuilt installer whose signing chain matches `tauri.conf.json`'s key `DCC8B926EA9F6F2B`, with `SHA256SUMS.txt` re-verified | New `release/<v>/` + checksum match (§3 of the readiness report style) |

G-E has **two variants**, and you pick one (Stream 4):

- **G-E-signed** — a genuine release (needs an Authenticode credential; you said not now).
- **G-E-internal** — an unsigned build plus a documented install path for personal/other use;
  `release.yml` stays blocked on signing so a public release stays impossible.

---

## Work streams

### Stream 0 — Prep (unblocked, ~30 min)

Blocking nothing; makes the rest measurable.

| ID | Item | Where | Exit |
|---|---|---|---|
| P-0.1 | Preserve the measured baseline — leave `release/0.1.0/` untouched until Stream 4 replaces it, and keep `f20ce71f` recorded as the "before" SHA. **Do not tag it**: a `v*` tag would trigger `release.yml`, which fails closed without signing credentials | `release/0.1.0/`, `docs/RELEASE_READINESS.md:4` | Baseline preserved and clearly labelled obsolete |
| P-0.2 | Copy `RELEASE_CHECKLIST.md` section list into §Status tracker as rows | this file | Single tracker |
| P-0.3 | Merge the four green Dependabot PRs **or** park them behind Stream 1; recommend: land **Stream 1 first**, so `Tauri shell` is deterministic before judging them | `#5`, `#8`, `#10`, `#14` | Queue = 0 blockers |

### Stream 1 — Make the signal trustworthy (unblocked, test-only)

**This is the single highest-value stream.** Until it lands, every "red" in CI is ambiguous and every
"green" is partial — including a review of the Dependabot queue.

| ID | Item | Where | Exit |
|---|---|---|---|
| **S-1.1** | Make `acceleration::tests::downloads_pack_and_writes_marker` and `corrupted_checksum_fails_and_cleans_up` deterministic: both stand up an in-process fixture HTTP server on an OS-assigned port and can lose the race to it | `src-tauri/src/acceleration.rs:955`, `:990` (test module `:660`) | A re-run of the identical commit changes no verdict; the tests pass 20 consecutive local runs |
| **S-1.2** | Turn `test_phase1_e2e.py` into a runner that reports `FAIL` and *continues* instead of raising past a check | `backend/test_phase1_e2e.py:798` (`.json()` on a non-JSON body) | A deliberate run where Tree one check is broken **still prints 40 lines and a non-zero exit** |
| **S-1.3** | Fold in the two tests' shared fixture concern: a per-test long-lived fixture server, or await-readiness before the first request; either is fine, but no `sleep` added | `src-tauri/src/acceleration.rs` | Same as S-1.1 |

Verification for **G-A**: branch `chore/green-signal`, run `CI` on it twice on the same SHA; both
runs must be identical. That is the acceptance test of Stream 1.

> Why no workaround instead: the flake is in the accelerator-pack downloader's own verification
> — the same code that ships the optional GPU pack — so a "sleep to make it pass" fix would hide a
> real defect in delivery code.

### Stream 2 — Product block: GPU fallback + error contract (**needs your explicit instruction**)

Applies to **G-B (part)** and **G-C**. Refusal to proceed until instructed is deliberate
(`AGENTS.md:5`).

| ID | Item | Where | Behaviour expected afterwards |
|---|---|---|---|
| **S-2.1** | Apply the same **CPU fallback at inference** that already exists at model-load: catch the CUDA failure at `model.transcribe(...)`, downgrade to `device="cpu"` + `compute_type="int8"`, retry; escalate to `TranscriptionError` only when CPU also fails | `backend/services/transcriber.py:501` vs `:428` (`except` → `:442 WhisperModel(device="cpu")`) | Transcription completes on this RTX 3050 with **no** acceleration pack |
| **S-2.2** | Raise `TranscriptionError` — never a bare `RuntimeError` — from every unrecoverable transcribe path | `model.transcribe(...)` call site | `/extract-and-transcribe` returns `503 {"detail":…}` per the existing handler `main.py:796-798` |
| **S-2.3** | Reconcile the CUDA readiness probe with `pack_installed` so `cuda_runtime:true` and `pack_installed:false` can never coexist; `/health` must describe the device actually in use | `accel.*` readiness probe vs `backend/main.py` `/health`; `resolve_device` at `transcriber.py:141` | `/health` reports `device: "cuda"` only when transcribing actually works on CUDA |
| **S-2.4** | Convert non-`ImportError` import failures of `faster_whisper` (e.g. `TypeError` from an incompatible `av`) into `TranscriptionError` | `transcriber.py:411` `except ImportError` | The `av 19` class of dependency drift degrades to a clean 503 instead of a 500 |
| **S-2.5** | Regression coverage: one test that forces the CUDA failure at inference and asserts (a) CPU fallback, (b) JSON `{"detail":…}` shape | new test alongside `backend/test_phase1_e2e.py` | Coverage that CI (no GPU) *can* run |

**Acceptance for G-B/G-C:** `py -3.12 backend/test_phase1_e2e.py` → **40/40** here, plus
**40/40 on this laptop** before and after `Enable GPU acceleration`. CI alone cannot prove this —
it has no GPU (`docs/RELEASE_READINESS.md:2.4`).

### Stream 3 — Test/code hygiene (**needs your explicit instruction**)

Applies to **G-A** only. Optional: not a blocker in practice, but this is where the repo stops
accumulating "known-broken" states.

| ID | Item | Where | Exit |
|---|---|---|---|
| **S-3.1** | Enable `cargo clippy -- -D warnings` and `cargo fmt --check` as gates after a formatting/lint cleanup commit | `src-tauri/src/**`, `.github/workflows/ci.yml` | both gates green and enforced |
| **S-3.2** | Docs numbering nit in `docs/RELEASE_READINESS.md` §1.6 heading | docs | 1-line diff in whatever PR comes next |

### Stream 4 — Artifacts and signing (unblocked for the *local* variant)

Applies to **G-E**. Choose explicitly.

| ID | Variant | What I can do | What only you can do |
|---|---|---|---|
| **S-4.1** | **G-E-internal (recommended now)** | Rebuild via `scripts/build-release.ps1 -SkipSigning`; verify `SHA256SUMS.txt` matches the new files and that the signing chain ends at `DCC8B926EA9F6F2B` | Decide who may install it, and where (SmartScreen will warn on other people's machines) |
| **S-4.2** | **G-E-signed** | Keep `release.yml` exactly as built — it already fails closed on unsigned (`REQUIRE_CODE_SIGNING: "1"`, `docs/RELEASING.md:4`) | Obtain and install an Authenticode credential into the `production` environment (Azure Trusted Signing / PFX / thumbprint) |
| **S-4.3** | Optional CI dry run | Add a manual-dispatch "unsigned internal build" so a tag-less run can produce an installer; **not** recommended while the app itself is red at BL-1 | — |

**Recommendation:** S-4.1 now, S-4.2 when/if you want a public release. Do **not** enable S-4.3 until
S-2.1 lands, otherwise it would ship an internal build with the GPU feature failing closed.

### Stream 5 — Pending dependency queue (unblocked after Stream 1)

Applies to nothing in G-A…G-E directly, but leaves zero open-audit debt.

| PR | Action | Why |
|---|---|---|
| `#14` actions group ×8 | **merge** | all checks green |
| `#10` faster-whisper floor ≥1.2.1 | **merge** | matches the currently verified environment |
| `#8` sha2 0.10.9→0.11.1 | **merge** | covered by 11 Rust tests incl. `sha256_hex_matches_known_vectors` |
| `#5` numpy 2.5.3→2.5.4 | **merge** | `Backend`/`Frontend` green; only red is the §1.6 flake |
| `#11` typescript 6→7 | **optional** | measurement says builds clean (`Frontend` ✅); hold only as maturity policy, not risk |

Do these *after* Stream 1, so the badge means something when you look.

### Stream 6 — Packaged acceptance gate (unblocked, human-driven)

Applies to **G-D**. Runs only after **Stream 2** produces a build whose GPU path works.

| ID | Section | Automatable? | Note |
|---|---|---|---|
| S-6.1 | `RELEASE_CHECKLIST.md` §0 Artifacts | ✅ mine | Already one-shot checkable via the `SHA256SUMS.txt` verifier; redo against the new build |
| S-6.2 | §8 Uninstall/reinstall, §9 Diagnostics | ⚠️ partial | `scripts/smoke-installer.ps1` covers silent install + diagnostics; `-TryGui` is skipped headlessly |
| S-6.3 | §1 launch, §1b GPU pack, §2–§5 wizard, §6 persistence, §7 updater | ❌ human | Needs a clean Windows 11 VM, desktop session, real GPU |
| S-6.4 | Sign-off line | ❌ human | Records `G-D` |

**Ordering matters:** stream S-6.3 re-tests BL-1 (§1b) and BL-4 (§7), so run it *after* Stream 2 and
Stream 4, otherwise the walkthrough will hit the same defects and restart the matrix.

---

## Sequence — what runs in what order

```
   S-0  prep + freeze baseline          (unblocked)
   `->  S-1  deterministic gates        (unblocked, test-only)      <- do this FIRST
        `->  S-5  merge pending deps    (so the badge is meaningful)
   `->  S-2  GPU fallback + contract    (NEEDS YOUR INSTRUCTION)
        `->  S-4  rebuild artifacts     (G-E-internal now, signed later)
             `->  S-6  packaged VM gate (61 items)
   `->  S-3  clippy/fmt enablement      (optional, NEEDS YOUR INSTRUCTION)
```

## Landing sequence — pull requests

Each PR lands through the existing strict gate (required checks, linear history, no force-push),
so its own title must be a Conventional Commit (`docs:`/`ci:`/`fix:`/`test:`).

| PR | Content | Reference |
|---|---|---|
| PR-G1 | Stream 1 (S-1.1 + S-1.2) | `test: make the pack-download and E2E gates deterministic` |
| PR-G2 | Stream 5 (dependabot merges) | normal review, no plan change |
| PR-G3 | Stream 2 (S-2.1…S-2.5) | `fix: fall back to CPU at inference and honour the 503 contract` — *waits for go-ahead* |
| PR-G4 | Stream 4 (local rebuild + checksum refresh) | `chore: rebuild internal artifacts against the rotated key` |
| PR-G5 | Stream 3 (clippy/fmt) — optional | `chore: enable clippy and rustfmt gates` — *waits for go-ahead* |

## Verification matrix (what proves each exit)

| Gate | Command / evidence | Pass condition |
|---|---|---|
| **G-A** | Same SHA, two CI runs | identical verdicts |
| **G-B** | `pnpm lint`; `pnpm build`; `cargo test --locked`; `py -3.12 backend/test_phase1_e2e.py`; `pnpm exec playwright test` | all exit 0; backend reports **40/40**, not a truncated 26 |
| **G-C** | same backend suite **on this laptop, with no accel pack**; then **with** the pack installed | 40/40 both, with device reported correctly in `/health` |
| **G-D** | `docs/RELEASE_CHECKLIST.md` walkthrough + `scripts/smoke-installer.ps1` | 61/61 checked, sign-off line filled |
| **G-E** | `SHA256SUMS.txt` match + updater signature validity against `DCC8B926EA9F6F2B` | match; signature accepted; `latest.json` points at the rebuilt asset |

## Rollback / stop conditions

Stop and report, do **not** continue:

1. Any required check fails for a reason **other than** the two known flake signatures
   (`acceleration.rs:955` / `:990`) after Stream 1 — a red gate at that point is a defect, not noise.
2. `Backend` E2E drops below 40/40 after any change.
3. A change to `transcriber.py`, `main.py`, `acceleration.rs` needs regressing GPU behaviour on
   this laptop — verify locally before pushing.
4. Anything that would let `release.yml` publish an **unsigned** artifact — never acceptable.

## Non-goals

- No Linux/macOS release matrix (deliberate; `AGENTS.md:4`).
- No channel watermark, no intro/outro (deliberate; `AGENTS.md:4`).
- No change to the architecture contract (FastAPI sidecar, REST + SSE only; `AGENTS.md:3`).

---

## Status tracker

Update this table as streams complete. Do not edit application code to close S-2/S-3 cells without
an explicit instruction.

| Stream | Item | State | ETA | Owner |
|---|---|---|---|---|
| 0 | P-0.1 baseline freeze | DONE — `release/0.1.0/` left untouched, labelled obsolete in the readiness report | — | — |
| 0 | P-0.2 tracker present | DONE (this file) | — | — |
| 0 | P-0.3 dependabot queue | TODO | — | you |
| 1 | S-1.1 flaky Rust tests | **DONE** — 35 consecutive clean runs (20 GNU + 15 MSVC) | — | — |
| 1 | S-1.2 E2E reports FAIL not raise | **DONE** — a red run now prints all 42 checks | — | — |
| 2 | S-2.1 CPU fallback at inference | **DONE** — verified: 200 JSON on `device: cpu` | — | — |
| 2 | S-2.2 `TranscriptionError` contract | **DONE** — regression test asserts the type | — | — |
| 2 | S-2.3 reconcile CPU readiness probes | **DONE** — probe loads the runtime; no more `cuda_runtime:true` + `pack_installed:false` | — | — |
| 2 | S-2.4 non-ImportError transcribe path | **DONE** — the `av 19` class now yields 503 JSON | — | — |
| 2 | S-2.5 GPU fallback regression test | **DONE** — 2 new checks; suite is 42/42 | — | — |
| 3 | S-3.1 clippy/fmt gates | Optional · still blocked | — | ? |
| 3 | S-3.2 docs nit | DONE — folded into this change set | — | — |
| 4 | S-4.1 internal rebuild | **DONE** — fresh build; signing chain verified against `DCC8B926EA9F6F2B`; 3/3 checksums. One stale file was caught and corrected (see §9.4 correction in the readiness report) | — | — |
| 4 | S-4.2 signed release | Optional | — | you |
| 5 | S-5 Dependabot merge batch | IN PROGRESS — `#14` merged; `#10`/`#8` re-running; `#5`/`#11` updated to pick up the flake fix | — | you |
| 6 | S-6.1 artifacts check | **DONE** — signing chain + 3/3 checksums verified on the rebuilt set | — | — |
| 6 | S-6.2 partial install smoke | **BLOCKED HERE** — frozen exes cannot be launched from the agent shell (`PYI … Could not create temporary directory!`, and a minimal PyInstaller build fails with `PermissionError`). Needs a normal terminal. | — | you |
| 6 | S-6.3 61-item VM walkthrough | TODO | after S-6.2 | you |
| 6 | S-6.4 sign-off | TODO | last | you |

### Also completed in this pass

- **MIT license** (`LICENSE`), with the bundled-FFmpeg GPL v3 caveat stated in `README.md` and
  `THIRD_PARTY_NOTICES.md` so the MIT grant is not mistaken for covering the FFmpeg binaries.

## Open decisions (need you)

1. ~~Authorize Stream 2~~ — **authorized and done** (see §9 of the readiness report).
2. **G-E-internal or G-E-signed** — today, or when a credential exists?
3. **S-3.1** — enable clippy/fmt gates (source cleanup commit) or leave advisory?
4. **S-5 PR #11 (TS 7)** — merge, hold, or accept later once included in a real feature release?

With Streams 1 and 2 landed, **G-A / G-B / G-C are achieved and verified**. **G-D** and **G-E**
remain — they need a rebuilt artifact and a human walkthrough, not more code.