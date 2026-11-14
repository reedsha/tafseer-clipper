# Release Readiness — Programmatic End-to-End Report

**Date:** 2026-11-15
**Commit under test:** `f20ce71f` (`main` as merged at PR #13)
**Method:** every command below was executed on this machine against the working tree; every
pipeline fact was read from the GitHub API. Nothing here is copied from `docs/RELEASING.md`
§9 or any other prose — where those documents and this report disagree, this report is the
measured one.

**Scope:** does the app in its current state have a verified path to a shippable release? It
does not cover the product/UI audit (`AUDIT_REPORT.md`) or the CI/CD architecture audit
(`docs/CICD_AUDIT.md`).

---

## 0. Verdict

**NOT RELEASE READY — 1 product defect, 1 unstable required gate, 0/61 of the packaged gate.**

*(Pipeline and dependency counts below are as measured at commit `f20ce71f`; they move as PRs land.)*

| Area | Status | Evidence |
|---|---|---|
| Compile / type gates | 🟢 GREEN | `tsc --noEmit` exit 0 · `vite build` exit 0 |
| Rust unit tests | 🟠 AMBER | 11 passed locally and on CI generally — **but 1 of the 11 is flaky on CI** (§1.6), so the required gate can red-line without any change |
| Browser end-to-end | 🟢 GREEN | Playwright **6 passed** (18.0 s), exit 0 |
| **Backend end-to-end** | 🔴 **RED** | 40-check suite aborts at check 27 → exit 1 |
| **GPU→CPU fallback contract** | 🔴 **RED** | `/extract-and-transcribe` returns **HTTP 500 `text/plain`** instead of a JSON error, and does not fall back to CPU |
| HTTP error contract on that endpoint | 🔴 **RED** | 500 + `Internal Server Error`, not the documented 503/`{"detail":…}` |
| CI pipeline | 🟢 GREEN | 19 runs, 10 green / 8 pre-fix, PR Title Lint 13/13; required checks passing |
| Dependency management | 🟢 GREEN | Dependabot live on 4 ecosystems, 5 PRs open for review |
| Supplier / supply chain | 🟢 GREEN | 24/24 actions SHA-pinned; FFmpeg pinned + SHA-256 verified |
| Local artifact integrity | 🟢 GREEN | `release/0.1.0` **3/3 files match** `SHA256SUMS.txt` |
| **Updater signing chain** | 🟠 **AMBER** | artifacts signed with the **pre-rotation** key; config now advertises a different one |
| **Release pipeline end-to-end** | 🟠 **AMBER** | `release.yml` **has never run** (0 runs); deliberately blocked on Authenticode |
| **Packaged release gate** | 🔴 **RED** | `docs/RELEASE_CHECKLIST.md` → **61 unchecked, 0 checked** |

---

## 1. Automated verification (executed)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `pnpm lint` (`tsc --noEmit` + `compileall backend`) | **0** | clean |
| 2 | `pnpm build` (`tsc && vite build`) | **0** | built in 954 ms · 824 KB main chunk |
| 3 | `cargo test --manifest-path src-tauri/Cargo.toml --locked` | **0** | **11 passed** / 0 failed |
| 4 | `py -3.12 backend/test_phase1_e2e.py` | **1** | **26 PASS, 0 FAIL, then hard abort** (see §2) |
| 5 | `pnpm exec playwright test` | **0** | **6 passed** in 18.0 s |

> **Note on #4:** the harness raises out of `test_phase1_e2e.py:798` instead of recording a
> `FAIL` and continuing. So the remaining ~13 checks are **not evaluated at all** — the suite
> cannot currently produce a complete report on a new defect. That is itself a gate-quality
> issue: a real failure turns into a truncated run rather than a red-but-complete one.

CI independently confirms 1–3 and 5 on runners (`Frontend`, `Tauri shell`, and `PR Title Lint`
all green; `Backend` green *only* where the machine has no NVIDIA GPU — see §2.4).

### 1.6 Unexpected finding: one of the 11 Rust tests is flaky

Observed while running the pipeline on **PR #15, a docs-only change** (no Rust file touched in that
diff), so it is unrelated to what it was passed to validate:

```
running 11 tests
…
test acceleration::tests::corrupted_checksum_fails_and_cleans_up ... FAILED
   src/acceleration.rs:990:9  panicked: unexpected error:
   Could not reach the GPU acceleration manifest at http://127.0.0.1:53608/manifest.json:
   error sending request for url (http://127.0.0.1:53608/manifest.json)
  test result: FAILED. 10 passed; 1 failed (finished in 2.01s)
```

The test stands up an in-process HTTP server on an **ephemeral port** (53608 in this run) and the
downloader cannot reach it. The same test passed on every earlier CI run and on every local run in
this report's §1 — so the race is intermittent and machine/runner-dependent.

Why it matters for release readiness rather than being cosmetic:

- It is part of a **required** status check (`Tauri shell (cargo check + unit tests)`), so a race
  in a test can **randomly block a merge** — the "is CI green?" signal is not trustworthy.
- It is confined to the accelerator-pack downloader's verification path — the same code that
  delivers the optional GPU pack. A test that can't reach its own fixture server hints the
  retry/loopback handling (`http_is_only_allowed_for_loopback` passes) is tight but timing-sensitive.
- It is **local-vs-CI asymmetric**: a developer running `pnpm test:rust` will not see it, so a red
  gate on CI cannot be reproduced locally — the worst flavour of flake.

CI explicitly has `cancel-in-progress: true` on `ci-…` groups, so a superseded run cancels its jobs;
that is a separate, expected reason for a `pending`/`cancelled` state and is **not** counted as a
flake here.

---

## 2. The blocker: GPU transcription does not fall back to CPU

This is the only defect found here that affects the **shipped product at runtime** (every other
finding concerns test infrastructure or release tooling), and it is in the exact hardware
configuration the product is built for.

### 2.1 Observed behaviour (machine: NVIDIA RTX 3050 Laptop GPU, pack **not** installed)

`faster-whisper` 1.2.1 imports fine. The sidecar preloads it **on CUDA** and then dies on the first
real inference:

```
2026-11-15 03:46:51  GET /health                                          200
2026-11-15 03:46:53  tafseer.transcriber: faster-whisper loaded: model=tiny device=cuda compute=int8
2026-11-15 03:46:53  faster_whisper: Processing audio with duration 00:10.000
        RuntimeError: Library cublas64_12.dll is not found or cannot be loaded
              at faster_whisper/transcribe.py:1400  -> self.model.encode(...)
         ← backend/services/transcriber.py:501      -> model.transcribe(...)
2026-11-15 03:46:53  POST /extract-and-transcribe                        500
```

The client sees:

```
status       : 500
content-type : text/plain; charset=utf-8
body         : b'Internal Server Error'
json()       : JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

### 2.2 Three separate contract violations

| # | Contract | Where written | What happened |
|---|---|---|---|
| **B1** | *"GPU support must always degrade to CPU transcription/encoding … the UI … the CPU fallback explicitly. Never gate the wizard on GPU availability."* | `AGENTS.md:71`; also `docs/RELEASING.md` §8 "CPU fallback is a hard requirement" | A missing cuBLAS DLL **aborts the request**. No CPU fallback occurs. |
| **B2** | REST surface returns `{"detail": …}` JSON errors | `AGENTS.md:59–65`; `backend/main.py:796` installs `@app.exception_handler(transcriber.TranscriptionError)` | The exception is a raw `RuntimeError`, **not** a `TranscriptionError`, so it bypasses the handler → bare `500 text/plain`. Any renderer doing `response.json()` gets a parse error instead of a message. |
| **B3** | `resolve_device("auto")`: *"picks CUDA only when the optional CUDA runtime is actually loadable, so a machine without the GPU acceleration pack never pays for a doomed CUDA load"* | `backend/services/transcriber.py:141` | The readiness probe (`accel.cuda_runtime_ready()`) answered **ready**, so device `cuda` was chosen, while `cublas64_12.dll` was **absent**. `/health` also reported `acceleration.pack_installed: false` **at the same time as** `cuda_runtime: true` and `transcription: "gpu"` — the two probes disagree inside one response. |

### 2.3 Where the gap is

```
backend/services/transcriber.py
  141  resolve_device() ................................ returned "cuda"   (probe said ready)
  402  _ensure_model()
  411  from faster_whisper import WhisperModel ......... OK
  423  WhisperModel(device="cuda") .................... SUCCEEDED
       ── load succeeded; this whole block IS guarded ──
  428  except Exception as exc ......................... ← the CPU fallback lives HERE
                                                          442 WhisperModel(device="cpu")
                                                          447 device = "cpu"
                                                          450 / 456 raise TranscriptionError
                                                            → handled by main.py:796 → 503 {"detail":…}
       ── heal done; nothing guards what follows ──
  501  model.transcribe(...) .......................... ← UNCHECKED, no fallback, lands upstream
                                                          in faster_whisper's encode() → RuntimeError
```

`backend/main.py`

```
796  @app.exception_handler(transcriber.TranscriptionError)
797  async def _transcription_error(_: Request, exc): ...
798      return JSONResponse(status_code=503, content={"detail": str(exc)})
```

Note what `main.py:798` proves: the handler serves **503 + JSON** for `TranscriptionError`.
The measured response was **500 + `text/plain`**, i.e. `RuntimeError` is *not* that type and
reached Starlette's default plain-text 500 handler. The fallback wraps **model loading** (428–447),
not **inference** (501); `cublas64_12.dll` is first used inside `encode()` at inference, so the
failure always lands in the uncovered half by construction.

### 2.4 Why the pipeline cannot catch it — and why that matters

GitHub-hosted runners have **no NVIDIA GPU**, so on CI `cuda_runtime_ready()` is false, the CPU
path is taken, `Backend (Phase-1 E2E)` passes, and `main` looks green. The configuration that
fails is, precisely, the one CI can never install.

So today: **the greenest possible review signal and a hard user-facing failure are compatible.**
Any release tagged now would carry a transcription path that 500s on an NVIDIA laptop without
the acceleration pack — i.e. on day one, before the user clicks *Enable GPU acceleration*.

### 2.5 Suggested fix (NOT applied)

`AGENTS.md:5` forbids application-code changes outside an explicitly instructed phase, so this
is a recommendation only:

1. Wrap `model.transcribe(...)` in the same fallback used in `_ensure_model` — catch the CUDA
   failure, log, downgrade `device="cpu"` + `compute_type=int8`, and retry.
2. Raise `TranscriptionError` (not `RuntimeError`) for unrecoverable GPU failures so
   `main.py:796` returns the JSON contract, and let FastAPI's generic 500 handler fall back to
   JSON as a backstop rather than `text/plain`.
3. Reconcile the two CUDA probes so `pack_installed:false` + `cuda_runtime:true` cannot both hold,
   and make `/health` reflect the device actually used.

---

## 3. Artifact integrity & signing chain

| Check | Result |
|---|---|
| `release/0.1.0/SHA256SUMS.txt` vs files | **3/3 MATCH** — installer, `backend.exe`, `accel-manifest.json` are byte-intact |
| Key ID declared in `tauri.conf.json` | `DCC8B926EA9F6F2B` |
| Keypair on disk (`.release-secrets/updater.key.pub`) | `DCC8B926EA9F6F2B` ✅ consistent with config |
| What signed `release/0.1.0/latest.json` | the **pre-rotation** key `27B71DBE720BE1B7` — the only key that existed when those artifacts were built |

**Consequence:** every file in `release/0.1.0/` is intact but **signed with a key the current
config no longer advertises**. The two directions both fail: a build produced today cannot verify
the old artifacts, and any already-installed copy of the old build cannot verify anything signed
with the new key. `release/0.1.0/` must be treated as **obsolete and rebuilt**, not shipped, and
anything installed from it must be reinstalled.

**Supply chain (current `main`):**

| Item | Result |
|---|---|
| Action references pinned to a 40-char commit SHA | **24/24** |
| FFmpeg | pinned `packages/ffmpeg-9.0.2-essentials_build.zip`, SHA-256 verified **before** execution (`60f467…047ba`, matches gyan.dev's published checksum for the versioned build) |
| `.release-secrets/` private key | gitignored; **no** `.key` file tracked by git |
| `backend/.e2e/` Microsoft fonts | gitignored; excluded from the first commit |

---

## 4. Pipeline readiness (from the GitHub API)

| Workflow | Runs | Green | Notes |
|---|---|---|---|
| `CI` | 19 | 10 pass / 8 fail / 1 pending | Every failure was a pre-existing defect now fixed, or the baseline push; every PR merged only after `mergeable_state: clean` |
| `PR Title Lint` | 13 | **13/13** | Conventional Commit titles held across every PR, including Dependabot's |
| `Release Please` | 3 | **3/3** | Correctly produced **no tag** — `main` contains only `chore:` + `ci:` commits, so there is no release-worthy commit yet |
| `Release` | **0** | — | Never executed. Gated on Authenticode by design |

**Branch protection** (verified on `main`): 4 required checks (`Frontend…`, `Backend…`,
`Tauri shell…`, `Conventional Commit title`) · `strict` up-to-date · `enforce_admins`
· linear history · **no force-push, no deletions** · approvals 0 (solo repo).

**Environments:** `production` — required reviewer `reedsha`, secret `TAURI_SIGNING_PRIVATE_KEY`;
`staging` — reserved, no secrets.

> One deliberate trade-off: `ci.yml` triggers on `pull_request` only, so `main` has no *push*
> signal. Because merges require a passing, up-to-date head, `main` is green **by construction at
> each merge** rather than by re-running.

---

## 5. The packaged release gate — 0/61 executed

`docs/RELEASE_CHECKLIST.md` is the clean-VM gate: **61 unchecked boxes, 0 checked**, across
0. Artifact integrity · 1. Launch and shell plumbing · 1b. GPU acceleration pack (NVIDIA) ·
2–5. Wizard Steps 1–4 · 6. Persistence/resume · 7. Updater · 8. Uninstall/reinstall ·
9. Diagnostics · Sign-off.

That gate **cannot** be partly automated from here:

| Segment | Automatable | Why |
|---|---|---|
| 0. Artifact integrity | ✅ | Done in §3 — but must be redone against a **newly built** artifact, since the existing one is stale |
| 8. Uninstall / reinstall | ⚠️ partially | `scripts/smoke-installer.ps1` covers silent install/diagnostics; `-TryGui` SKIPs headlessly |
| 1 & 2–5 & 6 & 7 | ❌ | Need a real WebView2 window, a desktop session, GPU hardware and human judgement. CI has a browser E2E covering the **renderer only**, not the frozen sidecar + real window |
| 9. Diagnostics | ❌ | Requires the running desktop app |

Two of the checklist's own sections — `1b. GPU acceleration pack (NVIDIA)` and `7. Updater`
— are **exactly** the areas §2 and §3 show as broken/unverified today.

---

## 6. Blockers

### Product — blocks release until fixed

| # | Blocker | Evidence | Owner |
|---|---|---|---|
| **BL-1** | GPU transcription 500s and never falls back to CPU (§2) | sidecar log + 500 probe on this machine | Application code — needs an explicitly instructed phase (`AGENTS.md:5`) |
| **BL-2** | Backend E2E aborts at check 27 of 40 (§1 table, row 4) | exit 1; harness raises instead of recording FAIL | Same root cause as BL-1; arguably also a harness defect |

### Process — blocks *publishing*, not development

| # | Blocker | Note |
|---|---|---|
| **BL-3** | No Authenticode credential → `REQUIRE_CODE_SIGNING=1` fails every tag build. **You have stated you will not sign soon** — so the release path stays closed by design. Unsigned local builds remain available via `scripts/build-release.ps1 -SkipSigning`. | Yours |
| **BL-4** | `release/0.1.0` signed with the pre-rotation key (§3) | Rebuild after BL-1 |
| **BL-5** | 61/61 packaged-gate boxes unchecked (§5) | Needs a clean Windows 11 VM + desktop |
| **BL-6** | 5 Dependabot PRs awaiting review (*hold `#11` TypeScript 7; the rest are safe to merge*) | Yours |
| **BL-7** | One of the 11 required Rust tests is **unstable** (`corrupted_checksum_fails_and_cleans_up`) → a merge gate that randomly red-lines (§1.6) | Application/test code — needs an instructed phase |

---

## 7. Shortest path to release-ready

1. **Fix BL-1/BL-2** (inference fallback + `TranscriptionError` + harness records FAIL instead of
   raising). Then re-run §1 row 4 until **40/40**, and run it on a machine **with** an NVIDIA
   GPU — CI alone can never prove this. Consider adding a GPU-labelled, self-hosted or manual
   trigger for that one suite.
2. **Stabilise the gate (BL-7)** — `acceleration::tests::corrupted_checksum_fails_and_cleans_up`
   races its own fixture server. Until it stops, "CI red" is ambiguous: a merge block may mean a
   real defect or a timing race. Reproduce on CI (re-run the job) before touching the downloader.
3. **Rebuild** `release/0.1.0` so the signing chain points at `DCC8B926EA9F6F2B`; re-verify
   `SHA256SUMS.txt` afterwards (§3).
4. **Run `docs/RELEASE_CHECKLIST.md` §0, §1, §1b, §7, §8** against the new build on a clean VM —
   those are exactly the sections §5 reports unverified, and §1b/§7 directly re-test BL-1/BL-4.
5. **Decide on signing (BL-3).** Until then: no public release, local `-SkipSigning` builds only.
6. **Review the Dependabot queue (BL-6)**; hold `#11`.

**Do not tag or publish** until BL-1 is fixed and the §5 gate has been walked in real conditions —
right now the app would ship with its headline GPU feature failing closed on the target hardware.

---

## 8. Summary

Verified green today: compile, production build, 11 Rust tests, 6 browser E2E, CI-required checks,
title conventions, 24/24 SHA-pinned actions, checksum-verified FFmpeg, artifact file integrity,
and the release-safety controls (environment gate, protected branch, immutable tags).

Verified red or unverified: **GPU→CPU fallback (hard failure, 500, contract violation, invisible to
CI)**, the backend suite that detects it, the signing chain's key identity, a release pipeline that
has never executed, **all 61** packaged-gate items, and **a flaky required check** whose red-light
can mean timing race rather than defect.

The two systems most shifted by this work — "is CI green?" and "is the matrix green?" — answer
*"yes"* on a machine where the primary transcribe call returns HTTP 500 (§2.4), while the reverse
case produced a red gate through no code change at all (§1.6). Both directions of the release signal
are currently untrustworthy. That is the report's central finding.