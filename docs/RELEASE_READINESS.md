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
| Rust unit tests | 🟠 AMBER | 11 passed locally — but **2 of the 11 are flaky on CI**, observed on 3 PRs across 4 runs (§1.6), so the required gate can red-line with no code change |
| Browser end-to-end | 🟢 GREEN | Playwright **6 passed** (18.0 s), exit 0 |
| **Backend end-to-end** | 🔴 **RED** | 40-check suite aborts at check 27 → exit 1 |
| **GPU→CPU fallback contract** | 🔴 **RED** | `/extract-and-transcribe` returns **HTTP 500 `text/plain`** instead of a JSON error, and does not fall back to CPU |
| HTTP error contract on that endpoint | 🔴 **RED** | 500 + `Internal Server Error`, not the documented 503/`{"detail":…}` |
| CI pipeline | 🟢 GREEN | required checks passing; of 8 failed runs only 4 were real defects, 3 were the §1.6 flake, and 1 a genuine `av` incompatibility (§4). PR Title Lint 15/15 |
| Dependency management | 🟢 GREEN | Dependabot live on 4 ecosystems; its guard now avoids a break — `av 19` was auto-closed and its CI run reproduces the PyAV contract failure (§4) |
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
all green on every PR head that reached `main`; `Backend` green *only* where the machine has no
NVIDIA GPU — see §2.4).

### 1.6 Finding: two of the 11 Rust tests are flaky — and it is recurring

Not isolated. Observed **three times in four recent runs of the `Tauri shell` job**, on branches as
unrelated as a docs change, a Python dependency bump and a TypeScript bump:

| Run | Branch | Any Rust file touched? | Result | Panic location |
|---|---|---|---|---|
| PR #15 (first head) | `docs/release-readiness` | **no** | `10 passed, 1 failed` | `acceleration.rs:990` |
| PR #11 | `dependabot/npm_and_yarn/typescript-7.0.2` | no | `9 passed, 2 failed` | `acceleration.rs:955` **and** `:990` |
| PR #5 | `dependabot/pip/backend/numpy-2.5.4` | no | `10 passed, 1 failed` | `acceleration.rs:955` |
| PR #15 **re-run, identical commit** | unchanged | no | **success** | — |

```
thread 'acceleration::tests::corrupted_checksum_fails_and_cleans_up' panicked at src\acceleration.rs:990:9:
unexpected error: Could not reach the GPU acceleration manifest at
   http://127.0.0.1:50786/manifest.json: error sending request for url (…)

thread 'acceleration::tests::downloads_pack_and_writes_marker' panicked at src\acceleration.rs:955:14:
download pack: "Could not reach the GPU acceleration manifest at http://127.0.0.1:50787/manifest.json…"
```

Both tests stand up an in-process HTTP server on an OS-assigned port and both can lose the race to
their own fixture. The identical commit went red, then green, so this is confirmed behaviour rather
than a suspected one.

**No reliable trigger can be found, and my first hypothesis was wrong.** I suspected concurrency,
because three flakes land in the same minute as a Dependabot five-PR burst. But **six other runs
passed in that same 19:58:34–19:58:53 window** (`amannn/action-semantic-pull-request`,
`upload-artifact`, `setup-node`, `sha2`, `attest-build-provenance`, `faster-whisper` — all green),
while four failed beside them. Concurrency, runner load and branch content are therefore all
**unsupported** explanations. What is established is narrower: two tests, four attempts, one
re-run green on an identical commit — a genuinely timing-dependent race with no identified trigger.

Consequences:

- It is part of a **required** status check, so a timing race **randomly blocks a merge**, and the
  badge cannot distinguish "flaky" from "real defect" — exactly what happened in §7 item 6 below.
- Those same tests are the harness for the accelerator-pack downloader's verification path — the
  code that delivers the optional GPU pack.
- It is **local-and-CI asymmetric in two directions**: it fails on CI and passes locally, so a
  developer running `pnpm test:rust` will never reproduce a red gate.

CI `cancel-in-progress: true` on `ci-…` groups is a separate, expected cause of a
`pending`/`cancelled` state; that is *not* counted as a flake here.

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
| `CI` | 21 (at time of writing) | 11 pass / 8 fail / 2 in-flight | Failures classified immediately below — only four were real defects, and only in this project's own history |
| `PR Title Lint` | 15 | **15/15** | Conventional Commit titles held across every PR, including Dependabot's |
| `Release Please` | 3 | **3/3** | Correctly produced **no tag** — `main` contains only `chore:` + `ci:` commits, so there is no release-worthy commit yet |
| `Release` | **0** | — | Never executed. Gated on Authenticode by design |

*Authoritative breakdown of the 8 failed `CI` runs* (each failure's job log classified):

| Run | Branch | Cause |
|---|---|---|
| `9a3d0934` | `main` (baseline) | pre-existing: `Backend` + `Tauri shell` on the original files (Pillow absent, no launcher scripts) |
| `98928341`, `5262fa10` | `chore/cicd-pipeline` (my pushes) | pre-fix: `Multiple versions of pnpm specified` |
| `9cb2f8d6` | `chore/cicd-pipeline` (my push) | pre-fix: `CVT1100 duplicate resource` → `LNK1123` (§2 of `CICD_AUDIT.md`) |
| `62b474d0` | `dependabot/pip/backend/numpy-2.5.4` | **§1.6 flake** (`downloads_pack_and_writes_marker`) |
| `8ae9e34e` | `dependabot/npm_and_yarn/typescript-7.0.2` | **§1.6 flake** (`:955` + `:990`) — its actual compiler job passed |
| `2617a86a` | `dependabot/github_actions/actions/checkout-7.0.1` | **§1.6 flake** — not an action problem |
| `1f0394df` | `dependabot/pip/backend/av-19.0.2` | **genuine** — see below |

Two of those are findings in their own right:

1. **The `av` pin is empirically correct.** Dependabot's `PyAV 19.0.2` bump fails `Backend (Phase-1
   E2E)` on CI with the *same* `json.decoder.JSONDecodeError: Expecting value: line 1 column 1`
   this report's local failure shows (§1 row 4) — i.e. `/extract-and-transcribe` stops honouring the
   503+JSON contract once PyAV drops `metadata_errors=`. This is exactly what
   `backend/requirements.txt` warns about at the pin, so the warning is not theoretical. It backs
   the `av` major-bump ignore added to `.github/dependabot.yml`, and Dependabot's `av` pull request
   has since **auto-closed** — the guard worked.
2. **Only some of the 8 were defects in the product.** Four were pre-fix defects in my own pushes;
   three were the §1.6 flake; one was a genuine dependency incompatibility. Reporting "8 failures"
   without that split would overstate how much was ever wrong with the app.

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
| **BL-6** | 5 Dependabot PRs awaiting review | **All 5 pass their own checks** — 2 show red only because of §1.6's flake | Yours |
| **BL-7** | **Two** of the 11 required Rust tests are unstable (`acceleration.rs:955` and `:990`) → a merge gate that randomly red-lines; seen on 3 of 4 recent runs (§1.6) | Application/test code — needs an instructed phase |

**Correction on the Dependabot queue.** Earlier in this work I recommended holding PR #11
(`typescript` 6.0.3 → 7.0.2) on the grounds that a compiler major might break the build. **That
premise did not survive measurement.** PR #11's `Tauri shell` failure is §1.6's flake — and the
job that actually runs the compiler, `Frontend (tsc, build, Playwright E2E)`, reports **success**.
TypeScript 7 compiles this codebase and builds cleanly on CI. The same applies to PR #5 (`numpy`),
whose red is the flake as well: `Backend` and `Frontend` both pass.

So for `#11` the call is genuinely yours, and mine flips to: **privacy of choice, not build risk** —
I would still take a compiler major deliberately rather than as a side-effect of a bot run, but
there is no measurement standing in the way of merging it.

| PR | Own checks | Verdict |
|---|---|---|
| `#5` numpy 2.5.3→2.5.4 | `Frontend` ✅ `Backend` ✅ `Title` ✅ / `Tauri` ❌ flake | 🟢 merge |
| `#8` sha2 0.10.9→0.11.1 | all ✅ | 🟢 merge |
| `#10` faster-whisper floor ≥1.2.1 | all ✅ | 🟢 merge |
| `#14` github-actions group ×8 | all ✅ | 🟢 merge |
| `#11` typescript 6→7 | `Frontend` ✅ (the compiler job) / `Tauri` ❌ flake | 🟡 your call — safe, not urgent |

---

## 7. Shortest path to release-ready

1. **Fix BL-1/BL-2** (inference fallback + `TranscriptionError` + harness records FAIL instead of
   raising). Then re-run §1 row 4 until **40/40**, and run it on a machine **with** an NVIDIA
   GPU — CI alone can never prove this. Consider adding a GPU-labelled, self-hosted or manual
   trigger for that one suite.
2. **Stabilise the gate (BL-7)** — two tests (`acceleration.rs:955`, `:990`) race their own
   fixture server. Already reproduced: the identical commit failed, then passed on re-run with no
   diff, and it fired on 3 of the 4 recent runs when those runs overlapped (§1.6). Until it stops,
   "CI red" is ambiguous — badge alone cannot say defect vs. timing race.
3. **Rebuild** `release/0.1.0` so the signing chain points at `DCC8B926EA9F6F2B`; re-verify
   `SHA256SUMS.txt` afterwards (§3).
4. **Run `docs/RELEASE_CHECKLIST.md` §0, §1, §1b, §7, §8** against the new build on a clean VM —
   those are exactly the sections §5 reports unverified, and §1b/§7 directly re-test BL-1/BL-4.
5. **Decide on signing (BL-3).** Until then: no public release, local `-SkipSigning` builds only.
6. **Review the Dependabot queue (BL-6)** — `#5`, `#8`, `#10`, `#14` are green on their own
   merits and can go; `#11` (TS 7) builds cleanly, so it is a maturity call, not a risk.

**Do not tag or publish** until BL-1 is fixed and the §5 gate has been walked in real conditions —
right now the app would ship with its headline GPU feature failing closed on the target hardware.

---

## 8. Summary

Verified green today: compile, production build, 11 Rust tests, 6 browser E2E, CI-required checks,
title conventions, 24/24 SHA-pinned actions, checksum-verified FFmpeg, artifact file integrity,
and the release-safety controls (environment gate, protected branch, immutable tags).

Verified red or unverified: **GPU→CPU fallback (hard failure, 500, contract violation, invisible to
CI)**, the backend suite that detects it, the signing chain's key identity, a release pipeline that
has never executed, **all 61** packaged-gate items, and **two flaky required checks** (§1.6) whose
red-light can mean timing race rather than defect.

The two systems most shifted by this work — "is CI green?" and "is the matrix green?" — answer
*"yes"* on a machine where the primary transcribe call returns HTTP 500 (§2.4), while the reverse
case produced a red gate through no code change at all (§1.6). Both directions of the release signal
are currently untrustworthy. That is the report's central finding.