# CI/CD, Versioning & Release Engineering Audit — Tafseer Clipper

**Method:** `cicd-architect` skill (SKILL.md Phases 1–2, read-only).
**Audit date:** 2026-11-15
**Repository root:** `C:\Users\muham\OneDrive\Documents\tafseer-clipper`
**Target type:** Desktop & CLI (Tauri v2 + Python sidecar) → `references/target-desktop-cli.md`
**Auditor scope:** CI/CD pipeline, versioning, release engineering, deployment hygiene only.
**Product/UI code was not reviewed** (out of scope for this skill; see `AUDIT_REPORT.md` for that).

> **Status: PHASE 1 + PHASE 2 COMPLETE — AWAITING APPROVAL.**
> Per SKILL.md §1.4 (Hard Trust Boundary #4), **no project file was modified** during this audit.
> The only file added is this report. Every proposed change in §6 is staged, not applied.

---

## 1. Executive Summary

Tafseer Clipper has a **functionally real but governance-fragile** delivery system. The release
engineering is genuinely good — a bespoke, signed, Windows-only NSIS pipeline with updater artifacts,
a GPU acceleration pack, SHA256 checksums and a manual release gate. What is missing is the
**discipline layer** around it: version control itself, automation of versioning, and the standard
hygiene scaffolding the `cicd-architect` contract requires.

| # | Headline finding | Severity |
|---|---|---|
| **F1** | **The project is not a Git repository.** `git status` → `fatal: not a git repository`. No `.git`, no `main`, no `origin`. Every `cicd-architect` guarantee (PR-only merges, branch protection, audit trail, release-please) is currently impossible. | 🔴 Critical |
| **F2** | **Version is hand-baked into 4 places** (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `backend/config.py`). No Release Please, no changelog automation. | 🔴 Critical |
| **F3** | **No Conventional Commit enforcement** — no `pr-title-lint` workflow, no `release-please.yml`, no `release-please-config.json`. | 🔴 High |
| **F4** | **Zero GitHub Actions are pinned to a commit SHA.** All **17** action references (**9** distinct actions) use floating tags (`@v4`, `@v5`, `@v2`, `@stable`, and `tauri-apps/tauri-action@v0`). Supply-chain exposure. | 🔴 High |
| **F5** | **`ci.yml` declares no `permissions:` block** — the job token inherits the repository default (commonly read-write). `release.yml` correctly scopes `contents: write`, but the CI job does not. | 🟠 High |
| **F6** | **No `lint` or `test` entrypoint exists.** `package.json` has `dev`, `build`, `preview`, `test:e2e`, `tauri` — no `lint`, no `test`. The standardized `lint`/`test`/`build` contract required by SKILL.md §Phase 1.7 is unmet. | 🟠 High |
| **F7** | **No toolchain pinning files** — no `.nvmrc`, `.python-version`, or `rust-toolchain.toml`. Node 22 / Python 3.12 / Rust stable live only as literals inside `ci.yml` and drift from local machines silently. | 🟠 Medium |
| **F8** | **FFmpeg is downloaded from `gyan.dev` with no checksum verification** in both `ci.yml` and `release.yml`. An unverified binary is then embedded into a signed, published installer. | 🟠 High |
| **F9** | **No `.gitattributes`** — `* text=auto eol=lf` is not enforced. Windows CRLF/LF churn will produce noisy diffs and can corrupt the shell scripts and `.ass` subtitle assets. | 🟠 Medium |
| **F10** | **No `.gitignore` coverage for Python caches, `.env*`, or `backend/.e2e/`** (≈3.4 MB of generated test workspace would be committed on first `git add`). | 🟠 Medium |
| **F11** | **No build provenance attestation and no CI-generated `SHA256SUMS.txt`.** `SHA256SUMS.txt` exists only as a local artifact under the gitignored `release/` folder; the release workflow never regenerates or uploads it. | 🟡 Medium |
| **F12** | **`release.yml` has no `concurrency` block**, so overlapping tag pushes can race on the draft release and the `gh release upload` of the accel pack. | 🟡 Medium |
| **F13** | **Backend dependency drift.** `backend/requirements.txt` pins 7 packages but leaves `faster-whisper>=1.1,<2` open-ranged; `ci.yml:57` re-declares a *second, different* Python dependency set inline, duplicating the manifest. | 🟡 Medium |
| **F14** | **`ci.yml` runs on both `push: [main, master]` and `pull_request`** → same-repo PRs execute the full Windows matrix twice (each job installs FFmpeg + Python deps). | 🟡 Low |
| **F15** | **No `dependabot.yml`** — the 9 third-party actions and the npm / Rust / Python dependency trees receive no automated update PRs. | 🟡 Low |

**Overall verdict: AMBER → RED.** The *pipeline* is strong; the *governance* is absent.
The single highest-leverage action is **initializing Git** (F1) — without it, no other
`cicd-architect` control can be enforced. Everything else is incremental on top of that.

---

## 2. Scope & Method

**Files inspected (read in full):**
`AGENTS.md` · `README.md` · `package.json` · `pnpm-lock.yaml` · `.gitignore` · `components.json` ·
`playwright.config.ts` · `tsconfig.json` · `tsconfig.node.json` · `vite.config.ts` ·
`.github/workflows/ci.yml` · `.github/workflows/release.yml` ·
`src-tauri/tauri.conf.json` · `src-tauri/Cargo.toml` · `src-tauri/.gitignore` ·
`src-tauri/capabilities/default.json` · `src-tauri/sign-windows.ps1` ·
`backend/requirements.txt` · `backend/config.py` (version anchor) · `backend/build_sidecar.spec` ·
`scripts/build-release.ps1` · `scripts/build-accel-pack.ps1` · `scripts/smoke-installer.ps1` ·
`docs/RELEASING.md` · `docs/RELEASE_CHECKLIST.md` · `docs/GPU_PACK.md` · `release/0.1.0/` artifacts.

**Reference files loaded (per SKILL.md §Phase 2.1):**
`references/lang-ecosystems.md` · `references/github-settings.md` · `references/target-desktop-cli.md`

**Commands executed (read-only):**
`git status` · `Get-ChildItem` inventory · `pnpm-lock.yaml` / `Cargo.lock` / `requirements.txt` inspection ·
secret-pattern scan (`sk-*`, `api_key=`, `BEGIN * PRIVATE KEY`, `password=`) · local toolchain probe
(`node -v` → v24.19.0, `corepack pnpm -v` → 12.18.0, `py -3.12 --version` → 3.12.9, `cargo --version` → 1.98.1).

**Not executed (require Phase 3 approval):** `git init`, any file write to the project tree,
any workflow execution, any release.

---

## 3. Phase 1 — Day-Zero Hygiene Check (Read-Only)

### 3.1 Git & Branch — ❌ FAIL

| Check | Result | Evidence |
|---|---|---|
| `git init` | ❌ Not a git repository | `git status` → `fatal: not a git repository (or any of the parent directories): .git`; `Test-Path .git` → `False` |
| `main` branch | ❌ n/a — no repo | — |
| `origin` remote | ❌ n/a — no repo | — |
| Working tree clean | ❌ n/a — 164 files / 5.3 MB are untracked-by-definition | Candidate-size scan (excludes `node_modules`, `.build-venv`, `.release-tools`, `.release-secrets`, `release/`, `dist/`, `src-tauri/binaries/`) |

**Impact:** `.github/workflows/*` exist but can never have run — they reference `actions/checkout`,
which requires a repository. The project has been developed and released (`release/0.1.0/` contains a
built installer and updater signature) **entirely outside version control**. There is no history,
no authorship trail, and no rollback path.

### 3.2 `.gitignore` — ⚠️ PARTIAL

**Present and correct:** `node_modules`, `dist`, `dist-ssr`, `*.local`, `backend/logs/`,
`.build-venv/`, `.release-tools/`, `.release-secrets/`, `.pip-tmp/`, `.cargo-target/`, `.tauri/`,
`test-results/`, `playwright-report/`, `blob-report/`, `sidecar-build*.log`, `tauri-build*.log`,
`ffmpeg.zip`, `release/`, `.vscode/*` (with `extensions.json` re-included), `.idea`, `.DS_Store`,
`.suo`, `.ntvs*`, `.njsproj`, `.sln`, `.sw?`.

**Missing (SKILL.md §Phase 1.2 requires build, cache, secrets, OS junk):**

| Missing pattern | Consequence |
|---|---|
| `__pycache__/`, `*.py[cod]` | `backend/__pycache__/` (present on disk) would be committed |
| `.env`, `.env.*`, `!.env.example` | SKILL.md explicitly requires `.env*` coverage. No `.env` exists today and the backend uses `os.environ` only (`backend/config.py:37-47`) — **no dotenv loader is present**, so this is a guard, not a live bug |
| `.venv/`, `venv/` | Only `.build-venv/` is covered; a generic venv is not |
| `backend/.e2e/` | ≈3.4 MB of generated E2E workspace (media, fonts, renders) — the 5 largest candidate files are all here |
| `*.key`, `*.pfx`, `*.p12` | Guard against the updater/Authenticode keys landing in the tree |
| `src-tauri/target/` | Covered by `src-tauri/.gitignore` (`/target/`), but a root-level belt-and-braces rule is safer |
| `/src-tauri/gen/` | `src-tauri/.gitignore` covers only `/gen/schemas`; the rest of `gen/` would be tracked |

**Note — a documentation conflict:** `README.md:44` advertises "Built artifacts for the current
version live in `release/0.1.0/`", but `release/` is gitignored (`.gitignore:32`). The referenced
path does not exist for anyone who clones the repository. Either the artifacts should be published
as a GitHub Release asset (they already are, via `release.yml`) and the README re-pointed at the
release URL, or `release/` should be un-ignored. **Recommend re-pointing the README** — do not
commit 160 MB binaries.

### 3.3 `.gitattributes` — ❌ FAIL

File does not exist. SKILL.md §Phase 1.3 requires `* text=auto eol=lf`.
This matters concretely here: the repo is Windows-only, contains `.ps1` release scripts with
CRLF-sensitive content, `.ass` subtitle templates (UTF-8, BOM-sensitive for Arabic shaping),
`tauri.conf.json`, and `Cargo.toml`. Without `eol=lf` + binary declarations, Git's default
`core.autocrlf=true` on Windows will rewrite LF→CRLF on checkout and produce whole-file diffs
on every `.ps1`/`.py`/`.rs` file across machines.

### 3.4 Secret Guard — ✅ PASS (with one caveat)

| Check | Result |
|---|---|
| Secret-pattern scan over `*.py,*.ts,*.tsx,*.rs,*.json,*.toml,*.md,*.ps1,*.yml` (excluding vendor dirs) | **0 hits** — no `sk-*` keys, no `api_key=`, no `BEGIN PRIVATE KEY`, no inline `password=` |
| Tracked `.env` / `.pem` / `.key` / keystore | None at repo root. `src-tauri/updater.key` does **not** exist — the minisign private key lives **only** in `.release-secrets/updater.key`, which is gitignored (`.gitignore:20`) and correctly excluded from `src-tauri/` |
| Public key exposure | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` is a **public** minisign key — safe to commit, and required |
| Cert material | None present; Authenticode credentials are CI-only by design (`docs/RELEASING.md` §6) |

**Caveat (C1):** `docs/RELEASING.md:15` instructs the operator to generate the keypair with
`npx tauri signer generate -w .release-secrets/updater.key --ci`. **The `--ci` flag suppresses the
password prompt**, i.e. it produces an *unencrypted* private key on disk. Combined with the
`.release-secrets/` folder sitting inside a OneDrive-synced working tree, the key is exposed to
cloud sync and to any process with user-profile read access. Recommend dropping `--ci` (use a
password) and confirming `.release-secrets/` is excluded from OneDrive sync.

**Caveat (C2):** `docs/RELEASING.md:18-20` states the currently-configured updater public key was
"generated locally for wiring; **rotate it before the first public release**". The keypair in
`.release-secrets/` is therefore still the dev placeholder. `release/0.1.0/latest.json` carries a
signature produced by that dev key. **Rotation must happen before any public ship** — this is the
single most consequential open item in the whole release system.

### 3.5 Pinned Versions — ⚠️ PARTIAL

| Ecosystem | Required file | Present | Actual source of truth today |
|---|---|---|---|
| Node.js | `.nvmrc` / `.node-version` | ❌ | Literal `node-version: 22` in `ci.yml:29` and `ci.yml:118`; local machine is **v24.19.0** (≠ CI) |
| pnpm | (via `packageManager`) | ❌ | `pnpm/action-setup@v4` with `version: 11` in `ci.yml:25-26`, `ci.yml:116-117`; local corepack resolves **12.18.0** (≠ CI) |
| Python | `.python-version` | ❌ | Literal `python-version: "3.12"` in `ci.yml:33`, `ci.yml:85`, `release.yml:41`; local `py -3.12` → 3.12.9 ✅ |
| Rust | `rust-toolchain.toml` | ❌ | `dtolnay/rust-toolchain@stable` in `ci.yml:124`, `release.yml:43` — a **floating** channel |
| Backend deps | `requirements.txt` | ✅ | `backend/requirements.txt` — 7 pins + 1 range (`faster-whisper>=1.1,<2`) |

**Note (V1):** the local toolchain (Node 24, pnpm 12) does not match CI (Node 22, pnpm 11).
`pnpm-lock.yaml` was generated by a newer pnpm than CI runs; `--frozen-lockfile` may or may not
tolerate the lockfile version. This is exactly the drift `.nvmrc` + `packageManager` prevent.

### 3.6 Lockfiles — ✅ PASS

| Lockfile | Path | Tracked-eligible |
|---|---|---|
| pnpm | `pnpm-lock.yaml` (128 KB) | ✅ root, not ignored |
| Cargo | `src-tauri/Cargo.lock` (139 KB) | ✅ not ignored |
| Python | `backend/requirements.txt` | ⚠️ pinned but **not a true lockfile** (no hashes, one open range, transitive deps unconstrained) |

CI correctly uses `pnpm install --frozen-lockfile` (`ci.yml:35`, `ci.yml:129`, `release.yml:50`)
and `cargo check --locked` (`ci.yml:153`). ✅

### 3.7 Entrypoints — ❌ FAIL

SKILL.md §Phase 1.7 requires standardized `lint`, `test`, `build` commands.

| Command | `package.json` | Gap |
|---|---|---|
| `build` | ✅ `tsc && vite build` | — |
| `lint` | ❌ **absent** | No linter of any kind is configured — no ESLint, no Biome, no Oxlint; no `ruff`/`flake8` for Python; no `clippy`/`rustfmt` gate. Verified: zero lint-config files in the tree. |
| `test` | ❌ **absent** | Only `test:e2e` exists. The Rust unit tests (`src-tauri/src/acceleration.rs:773-919`, 8 `#[test]` fns) and the backend E2E (`backend/test_phase1_e2e.py`, 40 assertions) are **not reachable through any standard script** and the Rust tests are **not run in CI at all**. |
| Rust build | ⚠️ implicit | `cargo check --locked` only in CI; no `build`/`test` script |
| Backend test | ⚠️ implicit | `python backend/test_phase1_e2e.py` only inside `ci.yml:110`; no `pytest`/`unittest` entrypoint, no `pyproject.toml` |

**Dead-code note:** `src-tauri/src/acceleration.rs` contains 8 unit tests (documented in
`docs/RELEASING.md:176` as "11/11 unit tests" — now **8**). They are compiled but never executed
by any pipeline. Adding `cargo test` to CI is a ~10-second change with real regression value.

### 3.8 Phase 1 Scorecard

| # | Phase 1 item | Verdict |
|---|---|---|
| 1.1 | Git & Branch | ❌ FAIL — no repository at all |
| 1.2 | `.gitignore` | ⚠️ PARTIAL — missing `__pycache__`, `.env*`, `backend/.e2e/`, key-file guards |
| 1.3 | `.gitattributes` | ❌ FAIL — file absent |
| 1.4 | Secret Guard | ✅ PASS — no leaks; 2 rotation/handling caveats (C1, C2) |
| 1.5 | Pinned Versions | ⚠️ PARTIAL — 3 of 5 ecosystems unpinned; local ≠ CI drift |
| 1.6 | Lockfiles | ✅ PASS — pnpm + Cargo locked & enforced in CI |
| 1.7 | Entrypoints | ❌ FAIL — no `lint`, no `test` |

---

## 4. Phase 2 — Detect → Route & Audit

### 4.1 Detected Stack

| Layer | Technology | Version anchor | Evidence |
|---|---|---|---|
| **Frontend** | React 19 + TypeScript 6 + Vite 8 + Tailwind 4 | `package.json` `"version": "0.1.0"` | `package.json:4`; `typescript ~6.0.3`, `vite ^8.0.16` |
| **UI kit** | shadcn/ui + Radix (`radix-ui` umbrella) | — | `package.json:26`, `components.json` |
| **State** | Zustand 5 | — | `package.json:32` |
| **Micro-interactions** | Sonner, Vaul, cmdk, NumberFlow, wavesurfer.js | — | `package.json:22,31,24,14,30` |
| **Desktop shell** | Tauri v2 (Rust 2024 edition) | `src-tauri/Cargo.toml` `version = "0.1.0"` | `Cargo.toml:3`; plugins: dialog, fs, opener, process, shell, updater |
| **Backend** | Python 3.12 · FastAPI sidecar | `backend/config.py:19` `APP_VERSION = "0.1.0"` | `backend/main.py` (59 KB), `backend/services/` |
| **Packaging** | PyInstaller onefile → `backend.exe` + bundled `ffmpeg.exe`/`ffprobe.exe` | `backend/build_sidecar.spec` | `scripts/build-release.ps1` |
| **Installer** | NSIS, per-user (`installMode: currentUser`), LZMA | `src-tauri/tauri.conf.json` | `tauri.conf.json` `bundle.targets: ["nsis"]` |
| **Code signing** | Azure Trusted Signing → PFX → cert-store fallback | `src-tauri/sign-windows.ps1` | `tauri.conf.json` `bundle.windows.signCommand` |
| **Updater** | Tauri updater + minisign; `latest.json` manifest | `tauri.conf.json` `plugins.updater` | `release/0.1.0/latest.json` |
| **Media** | FFmpeg (gyan.dev "essentials", GPL) | — | `ci.yml:16`, `release.yml:22` |
| **E2E** | Playwright (chromium) + `vite preview` + real sidecar | — | `playwright.config.ts`, `tests/e2e/*.spec.ts` |
| **CI** | GitHub Actions — 2 workflows, 3 jobs | — | `.github/workflows/ci.yml`, `release.yml` |
| **Package manager** | pnpm | `pnpm-lock.yaml` | `ci.yml:24-26` (pnpm 11) |

### 4.2 Reference Routing

| Reference | Applies? | Why |
|---|---|---|
| `references/lang-ecosystems.md` | ✅ **All 3 tracks** | Node/TS (`pnpm-lock.yaml`), Python (`requirements.txt`), Rust (`Cargo.lock`). Each needs version file + lockfile + commands, all mapped in §3.5/§3.7. |
| `references/github-settings.md` | ✅ | Output in §8. |
| `references/target-desktop-cli.md` | ✅ | Tauri is explicitly in scope. Its 4 requirements map to: matrix → Windows-only (§5 deviation), signing → **already implemented** (keep), `SHA256SUMS.txt` → **partially implemented** (local only, F11), provenance attestation → **missing** (F11). |
| `references/target-web.md` | ❌ | Not a web deployment target. |
| `references/target-mobile.md` | ❌ | Desktop-only; `Cargo.toml` comments explicitly exclude mobile crates. |
| `references/target-backend.md` | ❌ | The FastAPI sidecar is a **local loopback process**, not a deployed backend service. No container/hosting target. |

### 4.3 Brownfield — Version Anchor (4 locations)

SKILL.md §Phase 2.2 requires capturing the current version anchor.

| # | File | Field | Value | Must change on release? |
|---|---|---|---|---|
| 1 | `package.json:4` | `"version"` | `0.1.0` | ✅ |
| 2 | `src-tauri/tauri.conf.json` | `version` | `0.1.0` | ✅ (also drives the installer filename) |
| 3 | `src-tauri/Cargo.toml:3` | `[package] version` | `0.1.0` | ✅ (also drives the Cargo crate + binary version) |
| 4 | `backend/config.py:19` | `APP_VERSION` | `0.1.0` | ✅ (reported by `GET /health`) |

**Current anchor: `0.1.0`** — consistent across all 4 locations today. ✅ (Consistency is currently
maintained by hand and documented in `docs/RELEASING.md` §2, "all four must match".)

**Risk:** a manual bump that misses one location produces an installer named `0.1.1` while
`/health` reports `0.1.0`, or an updater that offers a version the app doesn't identify as.
Release Please's `extra-files` mechanism eliminates this class of bug.

### 4.4 Brownfield — Existing Workflow Catalog

#### `.github/workflows/ci.yml` (153 lines, 3 jobs, all `windows-latest`)

| Job | Steps | Notes |
|---|---|---|
| `frontend` | checkout → pnpm 11 → node 22 → python 3.12 → `pnpm install --frozen-lockfile` → `tsc --noEmit` + `pnpm build` → **FFmpeg download (no checksum)** → pip install (inline dep list) → `playwright install chromium` → `playwright test` → upload report on failure | ✅ Solid. FFmpeg cached by `actions/cache@v4` keyed on the workflow file hash |
| `backend` | checkout → python 3.12 → `pip install -r backend/requirements.txt` → FFmpeg download → `python backend/test_phase1_e2e.py` | ✅ The only Python test path |
| `tauri-check` | checkout → pnpm/node → **rust-toolchain@stable** → rust-cache → `pnpm install` → `pnpm build` → stage `where.exe` as a placeholder `backend.exe` → `cargo check --locked` | ✅ Smart placeholder trick (tauri-build requires every `externalBin` to exist). ❌ Does **not** run `cargo test` or `cargo clippy` |

#### `.github/workflows/release.yml` (98 lines, 1 job, `windows-latest`)

| Step | Notes |
|---|---|
| Triggers | `push: tags: ["v*"]` + `workflow_dispatch` ✅ (tag-driven, matching `docs/RELEASING.md` §2) |
| `permissions:` | `contents: write` ✅ scoped write |
| Env | `FFMPEG_URL`, `VITE_ACCEL_PACK_MANIFEST_URL` → `releases/latest/download/accel-manifest.json` ✅ |
| Setup | pnpm 11, node 22, python 3.12, `rust-toolchain@stable`, rust-cache ✅ |
| Sidecar | `pip install -r backend/requirements.txt pyinstaller` → `PyInstaller backend/build_sidecar.spec` ✅ |
| FFmpeg | download + stage `backend-<triple>.exe`, `ffmpeg-<triple>.exe`, `ffprobe-<triple>.exe` ✅ |
| Publish | `tauri-apps/tauri-action@v0` — `--bundles nsis`, `releaseDraft: true`, `REQUIRE_CODE_SIGNING: "1"`, all 7 Authenticode + updater secrets wired ✅ |
| Accel pack | `scripts/build-accel-pack.ps1` → `gh release upload` ✅ |

### 4.5 CI Secret Inventory

| Secret | Workflow | Required | Present in repo? |
|---|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | release | ✅ | ❌ (dev key only in `.release-secrets/`, gitignored) — **correct** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | release | ✅ | ❌ — **correct** |
| `AZURE_TRUSTED_SIGNING_METADATA` / `_DLIB` | release | optional | ❌ — **correct** |
| `WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD` | release | optional | ❌ — **correct** |
| `WINDOWS_CERT_THUMBPRINT` | release | optional | ❌ — **correct** |
| `SIGNTOOL_PATH` | release | optional | ❌ — **correct** |
| `GITHUB_TOKEN` | both | auto | n/a |

**Secret hygiene verdict: ✅ PASS.** Nothing sensitive is in the working tree except the
gitignored dev keypair. No secret is printed, deleted, or leaked by either workflow.

---

## 5. Audit Tables

### 5.1 ✅ KEEP — existing custom logic and secrets (do not touch)

| # | Item | Location | Why keep |
|---|---|---|---|
| K1 | **Bespoke Windows release pipeline** | `.github/workflows/release.yml` | Tag-driven NSIS build with sidecar freeze, externalBin staging, `REQUIRE_CODE_SIGNING=1`, draft release, accel-pack upload. Replacing it with a generic `release-please` deploy template would **destroy** the signing, updater-artifact and GPU-pack logic. Release Please must be wired as a *version/changelog manager* feeding this pipeline, not as a replacement. |
| K2 | **`REQUIRE_CODE_SIGNING=1` hard fail** | `release.yml:73` | Prevents silently shipping an unsigned installer. Keep verbatim. |
| K3 | **`where.exe` as placeholder sidecar for `cargo check`** | `ci.yml:150` | Elegant workaround for tauri-build's `externalBin` existence check. Keep verbatim. |
| K4 | **FFmpeg `actions/cache` keyed on workflow hash** | `ci.yml:40-45` | Saves ~80 MB/runner. Keep (but add checksum verification — see A12). |
| K5 | **All 7 signing secrets + their fallback order** | `release.yml:71-79`, `src-tauri/sign-windows.ps1` | Multi-credential fallback (Azure → PFX → cert store) is more robust than a single path. Keep. |
| K6 | **Updater public key in `tauri.conf.json`** | `plugins.updater.pubkey` | Public by design; required for update verification. Keep. |
| K7 | **Local release scripts** | `scripts/build-release.ps1`, `build-accel-pack.ps1`, `smoke-installer.ps1` | The local↔CI parity story: `smoke-installer.ps1` verifies the *installed* payload; `build-accel-pack.ps1` is reused by CI. Keep. |
| K8 | **Release gate docs** | `docs/RELEASING.md`, `docs/RELEASE_CHECKLIST.md` | Detailed, accurate, operational. Keep; extend rather than replace. |
| K9 | **GPU acceleration pack** | `scripts/build-accel-pack.ps1`, `docs/GPU_PACK.md` | SHA-256-verified optional runtime download; CPU fallback is a hard requirement per `AGENTS.md`. Keep. |
| K10 | **`.gitignore` existing rules** | `.gitignore` | Already correctly excludes `release/`, `.release-secrets/`, `.build-venv/`, `.release-tools/`, `src-tauri/binaries/*`. Additive changes only. |
| K11 | **Windows-only target** | both workflows | Deliberate per `AGENTS.md` §4. **Documented deviation** from `target-desktop-cli.md`'s Linux/macOS matrix — see §5.4. |

### 5.2 ➕ ADD / UPDATE — hygiene fixes and workflow files (all awaiting approval)

| # | Change | Target file | Skill phase | Priority | Rationale |
|---|---|---|---|---|---|
| **A1** | Initialize git, create `main`, add `origin` remote, make the first commit on `chore/cicd-pipeline` | *(git operations)* | P1/P3 | 🔴 P0 | Prerequisite for every other control (F1). Per Trust Boundary #1, the initial import lands on a **feature branch**, then a PR opens against `main`. |
| **A2** | Add `.gitattributes` — `* text=auto eol=lf`, `*.ps1 text eol=crlf`, `*.bat text eol=crlf`, binary rules for `*.exe *.dll *.png *.ico *.mp4 *.wav *.ttf *.otf` | `.gitattributes` (new) | P1.3 | 🟠 P1 | Prevents CRLF churn and binary corruption (F9) |
| **A3** | Add `.nvmrc` = `22`; add `"packageManager": "pnpm@11.11.0"` to `package.json`; add `.python-version` = `3.12` | new + `package.json` | P1.5 / P2 | 🟠 P1 | Aligns local (Node 24/pnpm 12) with CI (Node 22/pnpm 11) — F7, V1 |
| **A4** | Add `src-tauri/rust-toolchain.toml` — `channel = "stable"`, `components = ["rustfmt", "clippy"]` | `src-tauri/rust-toolchain.toml` (new) | P1.5 | 🟠 P1 | Pins the floating `rust-toolchain@stable` used by both workflows |
| **A5** | Extend `.gitignore` — `__pycache__/`, `*.py[cod]`, `.env`, `.env.*`, `!.env.example`, `.venv/`, `venv/`, `backend/.e2e/`, `*.key`, `*.pfx`, `*.p12`, `src-tauri/target/`, `/src-tauri/gen/` | `.gitignore` | P1.2 | 🟠 P1 | Closes F10; prevents a 3.4 MB generated-workspace commit |
| **A6** | Add standardized scripts: `lint`, `lint:rust`, `lint:py`, `test`, `test:rust`, `test:backend`, `build:rust`, `typecheck` | `package.json` | P1.7 | 🟠 P1 | Closes F6; the skill's required `lint`/`test`/`build` contract |
| **A7** | Add `permissions: contents: read` to `ci.yml`; add `permissions: { contents: read }` to non-publishing jobs | `.github/workflows/ci.yml` | P3.3 | 🟠 P1 | Closes F5 (token currently inherits repo default) |
| **A8** | Pin **all 17** action references (9 distinct actions) to full commit SHAs with `# vX.Y.Z` comments | both workflows | P3.3 | 🔴 P1 | Closes F4 — the skill's explicit "Pin actions to SHA" standard |
| **A9** | Add `concurrency` to `release.yml` (`group: release-${{ github.ref }}`, `cancel-in-progress: false`) | `.github/workflows/release.yml` | P3.3 | 🟡 P2 | Closes F12 |
| **A10** | Add `pr-title-lint.yml` from `assets/pr-title-lint.yml` (Conventional Commit enforcement) | `.github/workflows/pr-title-lint.yml` (new) | P3.2 | 🔴 P1 | Closes F3; required by `github-settings.md` branch protection (see §8) |
| **A11** | Add `release-please.yml` + `release-please-config.json` + `.release-please-manifest.json` — `release-type: node`, `extra-files` for `tauri.conf.json` (json), `Cargo.toml` (toml), `backend/config.py` (python); `bootstrap-sha` = the A1 initial commit | new (3 files) | P3.2 / P3.3 | 🔴 P1 | Closes F2 — automates all 4 version anchors |
| **A12** | Verify the FFmpeg download against a pinned SHA-256 before use | both workflows | P3.3 | 🟠 P1 | Closes F8 — unverified binary flows into a signed installer |
| **A13** | Add `cargo test --locked` and `cargo clippy -- -D warnings` (+ `cargo fmt --check`) to the `tauri-check` job | `.github/workflows/ci.yml` | P3.2 | 🟠 P1 | Activates the 8 dormant Rust unit tests |
| **A14** | Generate `SHA256SUMS.txt` in the release workflow and upload it as a release asset | `.github/workflows/release.yml` | P3.2 | 🟡 P2 | Closes F11 — satisfies `target-desktop-cli.md`; today it exists only in the gitignored `release/` folder |
| **A15** | Add `actions/attest-build-provenance` (`id-token: write`, `attestations: write`) | `.github/workflows/release.yml` | P3.2 | 🟡 P2 | Closes F11 — satisfies `target-desktop-cli.md` |
| **A16** | Add `.github/dependabot.yml` — `github-actions` (weekly) + `npm` + `cargo` + `pip` | `.github/dependabot.yml` (new) | P3.2 | 🟡 P2 | Closes F15 |
| **A17** | Drop the `push:` trigger from `ci.yml` (keep `pull_request` + `workflow_dispatch`) | `.github/workflows/ci.yml` | P3.2 | 🟡 P2 | Closes F14 — halves Windows-runner minutes |
| **A18** | Re-point `README.md` "Release" section at the GitHub Release asset instead of the gitignored `release/0.1.0/` | `README.md` | P1.2 | 🟢 P3 | Resolves the §3.2 doc conflict |
| **A19** | Inject `assets/AGENTS-cicd.md` into `AGENTS.md` as a new CI/CD rules section | `AGENTS.md` | P5.1 | 🟢 P3 | Skill Phase 5 hand-off |
| **A20** | Emit the GitHub Settings checklist (§8) and optionally apply via `gh` CLI | *(output only)* | P5.2 | 🟢 P3 | Skill Phase 5 hand-off |

### 5.3 ⚠️ RISK / BLOCKER — items outside CI/CD that gate a release

| # | Risk | Impact | Owner action |
|---|---|---|---|
| **R1** | **Updater key rotation pending** (`docs/RELEASING.md:18-20`) — the configured `pubkey` and the `release/0.1.0/latest.json` signature come from a locally generated dev key | A publicly shipped app can never be updated, or worse, ships with a key whose private half is weakly protected | Rotate the minisign keypair **before** the first public release; commit only the new public key; store the private key only in CI secrets |
| **R2** | **No Authenticode credentials configured** | Unsigned installer → SmartScreen "Windows protected your PC"; real-world install friction and security warnings | Obtain Azure Trusted Signing (recommended) or a PFX; `REQUIRE_CODE_SIGNING=1` already fails the build without them — good |
| **R3** | **Updater hosting URL is a placeholder** — `https://updates.tafseer-clipper.app/...` (`tauri.conf.json` `plugins.updater.endpoints`) does not serve `latest.json` | In-app "Check for updates" fails; `latest.json` is only in the GitHub Release | Point `endpoints` at the real host (or a GitHub-Releases-backed CDN) and publish `latest.json` + `.sig` alongside the installer |
| **R4** | **No repository at all** → the release workflow in `release.yml` has never been executed | The entire release pipeline is unproven; `docs/RELEASING.md` §9's "verified build facts" were produced by *local* scripts, not by CI | A1 must land first; then run `release.yml` via `workflow_dispatch` on a test tag to prove the pipeline end-to-end |
| **R5** | **`AUDIT_REPORT.md` is stale** — it documents a `frontend/src/` layout that no longer exists (the app now lives at root `src/`) | The repo's own audit artifact misdirects future readers/agents | Regenerate or archive it; out of CI/CD scope but worth a follow-up issue |

### 5.4 📄 Documented deviation — Windows-only release matrix

`references/target-desktop-cli.md` states: *"Matrix: Linux/Windows/macOS binaries only on release
tags/manual dispatch."*

**This project deliberately ships Windows-only** (per `AGENTS.md` §4: *"Release packaging is
Windows-only: PyInstaller-frozen `backend.exe` + bundled `ffmpeg.exe`/`ffprobe.exe` … per-user NSIS
installer"*; the GPU acceleration pack is CUDA/cuDNN-specific; the app is a Windows desktop
product).

**Recommendation: do not add Linux/macOS targets.** Adding them would require a separate PyInstaller
freeze per platform, platform-specific sidecar naming, a non-NVIDIA fallback path for the accel pack,
and a non-NSIS installer — a large, product-level scope change that `AGENTS.md` forbids without an
explicit instruction. The reference's *intent* (binaries built only on release tags / manual
dispatch, never on every PR) is **already satisfied** — `release.yml` triggers on `tags: ["v*"]` and
`workflow_dispatch` only. **This deviation is recorded here as an accepted, documented exception.**

### 5.5 🔀 Proposed end-state flow (for approval)

```
                ┌──────────────────────────────────────────────────────────┐
   dev ────────▶│ chore/cicd-pipeline  (ALL Phase 3 changes land here)     │
                └───────────────┬──────────────────────────────────────────┘
                                │ PR  (Conventional Commit title — enforced by pr-title-lint)
                                ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  CI (pull_request)  — permissions: contents: read             │
        │   ├─ frontend : tsc --noEmit + pnpm build + Playwright E2E    │
        │   ├─ backend  : python backend/test_phase1_e2e.py             │
        │   └─ tauri    : cargo fmt/clippy --locked + cargo test         │
        └───────────────┬───────────────────────────────────────────────┘
                                │ merge → main
                                ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  Release Please  → opens/updates "chore(release): v0.2.0"    │
        │   bumps: package.json · tauri.conf.json · Cargo.toml ·       │
        │          backend/config.py   (4 anchors, auto)                │
        │   generates CHANGELOG.md                                      │
        └───────────────┬───────────────────────────────────────────────┘
                                │ merge the release PR → tag v0.2.0
                                ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  Release (tag v*) — permissions: contents: write              │
        │   PyInstaller sidecar → stage externalBin → tauri-action      │
        │   (NSIS + Authenticode + updater .sig) → draft Release       │
        │   + accel-manifest.json + SHA256SUMS.txt + provenance        │
        └───────────────────────────────────────────────────────────────┘
```

---

## 6. Trust & Approval Plan

### 6.1 Hard trust boundaries observed during this audit

| # | Boundary | How it was honoured |
|---|---|---|
| 1 | Never push/commit directly to `main` | No git operation was executed at all. The plan places every change on `chore/cicd-pipeline` with a PR. |
| 2 | No destructive history | No `git push --force`, no `git rebase`, no history rewrite. |
| 3 | No secrets | No secret was printed, copied, deleted, or moved. The dev keypair was **never read** — only its *location* was confirmed. |
| 4 | No unauthorized changes | **No project file was modified.** Only this report (`docs/CICD_AUDIT.md`) was created. Every change in §5.2 is a proposal. |
| 5 | No guessing | Every finding is cited by `file:line` or by an executed command. Phase 4 will report exact exit codes. |

### 6.2 Approval gate

Per SKILL.md §Phase 2.3, execution is blocked until you explicitly approve. Please pick a scope:

| Option | Scope | Files touched |
|---|---|---|
| **A — Hygiene only** (recommended starting point) | A2, A3, A4, A5, A6, A7, A17, A18 | 4 new + 3 modified — unblocks lint/test, prevents CRLF & cache noise, tightens token scope |
| **B — Full Phase 3** | A1–A17 | +3 workflows (2 new, 1 rewritten), +4 config files, all action SHA pinning, Release Please, attestation, Dependabot |
| **C — A + version automation** | A + A8, A10, A11 | Adds Conventional Commits, SHA pinning, Release Please across the 4 version anchors |
| **D — Custom** | your selection | — |

**Approval is requested for the selected option, plus confirmation of the two items only you can decide:**

1. **Repository identity** — GitHub owner/repo URL for the `origin` remote and the repo name (affects `release.yml`'s `VITE_ACCEL_PACK_MANIFEST_URL` and the `github-settings.md` checklist). If the repo should be **private**, say so — the checklist's Actions-permission step differs.
2. **A11 `bootstrap-sha`** — Release Please needs the SHA of the first commit to compute the initial changelog. This can only be known after A1, so A11 will be applied in a second commit on the same branch.

### 6.3 Rollback posture

Every proposed change is additive or a new file, except: `.gitignore` (additive rules only),
`package.json` (additive scripts + one `packageManager` field), `ci.yml` (additive blocks + trigger
change), `release.yml` (additive blocks + SHA pinning), `README.md` (one paragraph). All are
revertible by a single `git revert` on `chore/cicd-pipeline` — no history rewrite required.

---

## 7. Phase 4 — Local Proof-of-Work Plan (to run after approval)

The skill requires running `lint`, `test`, `build` locally and reporting **exact exit results**.
Toolchain available on this machine (probed):

| Tool | Available | Version |
|---|---|---|
| Node | ✅ | v24.19.0 |
| pnpm | ✅ via corepack | 12.18.0 (CI uses 11 → A3 will align) |
| Python | ✅ via `py` launcher | 3.12.9 |
| Rust | ✅ `~/.cargo/bin/cargo` | 1.98.1 (not on `PATH` by default) |
| FFmpeg | ❓ | `TAFSEER_FFMPEG` / `TAFSEER_FFPROBE` env vars or `%LOCALAPPDATA%\tafseer-clipper-tools\ffmpeg\bin` |

**Planned command sequence (all with exact exit-code capture):**

```powershell
# 1. lint
pnpm exec tsc --noEmit                                      # expect exit 0
cargo fmt --manifest-path src-tauri/Cargo.toml --check      # expect exit 0 (or report diffs)
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings

# 2. test
cargo test --manifest-path src-tauri/Cargo.toml --locked    # expect 8 passed
py -3.12 backend/test_phase1_e2e.py                        # expect 40/40
pnpm exec playwright test                                   # expect 6/6

# 3. build
pnpm build                                                  # expect exit 0
cargo build --manifest-path src-tauri/Cargo.toml --release --locked
```

**Baseline before any change** (to be captured at the start of Phase 4) is: `tsc --noEmit` 0,
`vite build` 0, Playwright 6/6, backend E2E 40/40, `cargo check --locked` 0, Rust unit tests
**not currently run by any pipeline** (8 present).

**Known environment caveat:** local Node is v24 while CI is Node 22, and local pnpm is 12.18.0
while CI is 11 — Phase 4 results on the *local* toolchain may not be identical to CI. A3 resolves
this by pinning both.

---

## 8. Phase 5 — Hand-Off: GitHub Settings Checklist

From `references/github-settings.md`. Apply manually in **Settings → Repository**, or via `gh`
(requires admin). **Not applied by this audit.**

1. **Actions Permissions** → Settings → Actions → General → Workflow permissions: enable
   **"Allow GitHub Actions to create and approve pull requests"** (required for Release Please to
   open its release PR).
2. **Merge Strategy** → Settings → General → Pull Requests: set **Squash Merging** as default and
   **enforce** it (Release Please's commit history is designed for squash-merge).
3. **Branch Protection** → Settings → Branches → Add rule for `main`:
   - Require a pull request before merging (and require review).
   - Require status checks to pass: **`ci`**, **`pr-title-lint`** (and the Release Please check if added).
   - **Block force pushes** (also block branch deletion and require linear history).
4. **Environments** → Settings → Environments:
   - `staging` — no wait timer (used for draft/auto-updater artifact staging).
   - `production` — **required reviewer approval**; this is where the tagged installer is finally
     published and where `TAURI_SIGNING_PRIVATE_KEY` / Authenticode secrets should be scoped.
   - Scope environment-specific secrets to `production`, not the repository level.
5. **Automation** — optionally apply the above with the `gh` CLI
   (`gh api -X PUT repos/{owner}/{repo}/branches/main/protection ...`), after `gh auth login` as an
   admin.
6. **Additional for this repo (from the audit):** enable **"Allow GitHub Actions to create and
   approve pull requests"** *and* set the repository default branch to `main`; consider enabling
   **signed commits** (`Require signed commits` in branch protection) once the user has a GPG or
   SSH signing key — this directly strengthens Trust Boundary #2 for a repo that has **no history
   at all** today.

---

## 9. AGENTS.md Injection (Phase 5.1)

The content of `cicd-architect/assets/AGENTS-cicd.md` is to be appended to `AGENTS.md` as a new
top-level section, per SKILL.md §Phase 5.1:

```markdown
## CI/CD, Versioning & Release Rules

1. **Never manually edit version numbers** in manifests; versions are managed automatically via Release Please PRs.
2. **Always use Conventional Commit formatting** for PR titles (`feat:`, `fix:`, `chore:`, `feat!:`).
3. **Never push directly to `main`**; always open a PR and ensure local `lint`, `test`, and `build` pass first.
4. **Release lifecycle:** Merging to `main` updates Staging and refreshes the Release PR; merging the Release PR ships to Production.
```

**Note:** clause 1 will conflict with the current `docs/RELEASING.md` §2 ("Version bump (all four
must match)") and with `AGENTS.md`'s existing statement that Phase 4 packaging is *"implemented and
built in this checkout"*. When A11 lands, `docs/RELEASING.md` §2 must be rewritten to describe the
Release Please flow instead of the manual four-file bump. This is flagged as a required
companion edit (A21, included in option B/C scope).

---

## 10. Summary & Recommendation

**Recommended path: Option C (A + version automation), executed in three PRs on
`chore/cicd-pipeline`:**

| PR | Contents | Why separate |
|---|---|---|
| **PR-1** | A1 (git init + first import on the branch) + A2, A3, A4, A5, A6, A7, A17, A18 | Unblocks everything; no behavioral change to the product |
| **PR-2** | A8 (SHA pinning), A10 (pr-title-lint), A11 (Release Please + 3 config files), A21 (RELEASING.md §2 rewrite) | Release automation is the highest-risk change and deserves isolated review |
| **PR-3** | A9, A12, A13, A14, A15, A16 | Supply-chain hardening, test activation, attestation, Dependabot |

**Do first, ahead of any of the above (not CI/CD work, but gating):**

- **R1** — rotate the updater signing keypair before the first public release.
- **R4** — after PR-1, run `release.yml` via `workflow_dispatch` on a throwaway tag to prove the
  pipeline works end-to-end. The release pipeline has **never executed in CI** (there was no repo).

**Not recommended, and explicitly out of scope:**

- Adding Linux/macOS release targets (§5.4).
- Replacing the bespoke `release.yml` with a generic deploy template (K1).
- Adding a heavyweight linter (ESLint/Biome/Ruff) beyond `tsc --noEmit` + `cargo clippy` +
  `python -m compileall` — it would add dependencies and risk a `AGENTS.md` stack-contract dispute
  for modest gain. *Optional add-on available on request.*

---

**End of report.** No project file was modified. Execution awaits explicit approval per §6.2.
