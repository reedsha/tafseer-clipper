# Releasing Tafseer Clipper (Windows)

This document is the operational runbook for producing a signed v0.1.x Windows
installer and its auto-updater artifacts. The product gate itself (what must be
verified before publishing) lives in [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

## 0. Repository setup (one time)

The release pipeline assumes these repository settings. Apply them in
**Settings → Repository** (or with the `gh` CLI as an admin).

| Setting | Value | Why |
|---|---|---|
| Default branch | `main` | Release Please targets `main` |
| Merge strategy | **Squash merging**, enforced | Release Please's history is designed for squash merges |
| Actions permissions | "Allow GitHub Actions to create and approve pull requests" | Release Please must open its `chore(release):` pull request |
| Branch protection on `main` | Require a PR; require the `CI` and `PR Title Lint` checks; block force-pushes | No version bump or tag may skip CI |
| `production` environment | Required reviewer approval | Scope the signing secrets to the environment, not the repository |

### Open release blockers

These are **not** CI problems - they are prerequisites for a *public* release and
are tracked in `docs/CICD_AUDIT.md` §5.3:

- **Rotate the updater signing keypair.** The public key currently in
  `src-tauri/tauri.conf.json` was generated locally for wiring; rotate it
  before the first public release and keep the private half only in CI secrets.
- **Configure Authenticode credentials.** Without them the installer is
  unsigned and Windows SmartScreen warns on every install.
  `REQUIRE_CODE_SIGNING=1` already fails the build instead of shipping one.
- **Point the updater endpoint at a real host.** The configured
  `https://updates.tafseer-clipper.app/...` does not yet serve `latest.json`.

## 1. One-time setup

| Item | How |
|---|---|
| Node 22+ / pnpm 11 | `npm i -g pnpm@11` (CI uses `pnpm/action-setup@v4`) |
| Rust stable **MSVC** toolchain | <https://rustup.rs> (release builds use MSVC; the GNU toolchain also compiles the shell but produces non-standard Windows binaries) |
| Python 3.12 | `py -3.12` |
| FFmpeg + ffprobe | gyan.dev essentials build; either on `PATH`, or set `TAFSEER_FFMPEG` / `TAFSEER_FFPROBE` |
| Updater signing keypair | `npx tauri signer generate -w .release-secrets/updater.key --ci` — commit **only** the public key into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`; store the private key in CI secrets |
| Authenticode certificate | Azure Trusted Signing (recommended) or a PFX / certificate-store thumbprint — see §4 |

The public key currently configured in `tauri.conf.json` was generated locally
for wiring; **rotate it before the first public release** and store the new
private key only in CI.

## 2. Versioning and tagging (automated)

Versions are **not** edited by hand. [Release Please](https://github.com/googleapis/release-please)
owns every version anchor and `CHANGELOG.md`; the configuration lives in
`release-please-config.json` and `.release-please-manifest.json`.

The four anchors that must stay in sync are updated automatically by the
`chore(release): vX.Y.Z` pull request:

```
package.json                 "version": "0.1.0"
src-tauri/tauri.conf.json    "version": "0.1.0"
src-tauri/Cargo.toml         version = "0.1.0"
backend/config.py            APP_VERSION = "0.1.0"
```

### The flow

1. Merge a Conventional Commit (`feat:`, `fix:`, `chore:`, …) into `main`.
2. `.github/workflows/release-please.yml` opens or updates a
   `chore(release): vX.Y.Z` pull request that bumps all four anchors and
   regenerates `CHANGELOG.md`.
3. **Review and merge that pull request.** Release Please then creates the git
   tag `vX.Y.Z` and a **draft** GitHub Release carrying the changelog.
4. The tag push triggers `.github/workflows/release.yml`, which builds the
   frozen sidecar and the signed NSIS installer and uploads them into that
   draft release, together with the updater artifacts and the GPU acceleration
   pack.
5. Publish the draft release, then run §7 below.

> Never run `git tag vX.Y.Z && git push --tags` by hand: the tag must carry the
> Release Please changelog, and a hand-made tag leaves `main` without the
> matching version bump.

#### If the draft exists but the tag does not

Release Please usually pushes the tag with the draft. If it only opened the
draft (check `git ls-remote --tags origin "vX.Y.Z*"`), the Windows build never
starts, because `release.yml` triggers on the tag:

```bash
git push origin "<merge-commit-sha>:refs/tags/vX.Y.Z"
```

Pushing that tag flips the draft's tag to a placeholder (`untagged-…`), so the
release has to be re-attached before publishing. `release.yml` uploads by
release id, so its assets are unaffected:

```bash
gh api --method PATCH "repos/OWNER/REPO/releases/<release-id>" \
  -f "tag_name=vX.Y.Z" -f "target_commitish=<merge-commit-sha>"
```

#### Publishing

Publish with **`prerelease=false`**: the updater endpoint is
`releases/latest/download/latest.json`, GitHub never marks a pre-release as
"Latest", and `make_latest` is ignored for pre-releases. A release published as
a pre-release therefore leaves existing installs updating to the *previous*
version.

```bash
gh api --method PATCH "repos/OWNER/REPO/releases/<release-id>" \
  -F "draft=false" -F "prerelease=false" -F "make_latest=true"
```

### Making a release without a code change

```bash
git commit --allow-empty -m "chore: release 0.2.0"
```

Merge that commit; Release Please will propose `v0.2.0`.

## 3. Local build (one command)

```powershell
# Full build: frozen sidecar -> stage binaries -> NSIS installer (+ updater artifacts)
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1

# Reuse an existing build/sidecar/backend/ onedir sidecar
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1 -SkipSidecar

# Unsigned local build (never publish it)
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1 -SkipSigning
```

What the script does:

1. Builds `build/sidecar/backend/` (onedir) with PyInstaller from
   `backend/build_sidecar.spec` using `.build-venv` (create it with
   `py -3.12 -m venv .build-venv` + `pip install -r backend/requirements.txt pyinstaller`).
2. Copies `ffmpeg.exe`, `ffprobe.exe` into `src-tauri/binaries/` with the Rust
   target-triple suffix Tauri's `externalBin` requires. The sidecar folder is
   bundled as a resource (`<install>\backend\backend.exe`), **not** an
   `externalBin`; never build it into the Vite `dist/` folder.
3. Runs `npx tauri build --bundles nsis` with the updater signing key from
   `TAURI_SIGNING_PRIVATE_KEY` (or `.release-secrets/updater.key`).

Artifacts:

```
src-tauri/target/release/bundle/nsis/Tafseer Clipper_0.1.0_x64-setup.exe
src-tauri/target/release/bundle/nsis/Tafseer Clipper_0.1.0_x64-setup.exe.sig   (updater signature)
```

The installer is **per-user** (`installMode: currentUser`), installs under
`%LOCALAPPDATA%\Programs\Tafseer Clipper`, and needs no administrator rights.

## 4. Code signing (required for a public release)

The Tauri bundler calls [`src-tauri/sign-windows.ps1`](../src-tauri/sign-windows.ps1)
through `bundle.windows.signCommand`. The script signs with the first configured
credential source, in this order:

| Source | Environment variables |
|---|---|
| Azure Trusted Signing (recommended) | `AZURE_TRUSTED_SIGNING_METADATA`, `AZURE_TRUSTED_SIGNING_DLIB`, optional `SIGNTOOL_PATH` |
| PFX file | `WINDOWS_CERT_PFX`, `WINDOWS_CERT_PASSWORD` |
| Certificate store | `WINDOWS_CERT_THUMBPRINT` |

Set `REQUIRE_CODE_SIGNING=1` in CI so a missing credential **fails the build**
instead of silently producing an unsigned installer. Locally the script only
warns, so development builds still work.

> An unsigned installer triggers Windows SmartScreen ("Windows protected your
> PC"). Never publish one.

## 5. Auto-updater

- Config: `src-tauri/tauri.conf.json` â†’ `plugins.updater`
  - `pubkey`: minisign public key (must match the private key used at build time)
  - `endpoints`: `https://updates.tafseer-clipper.app/{{target}}/{{arch}}/{{current_version}}`
    — **replace with your real hosting URL**.
- Build-time env: `TAURI_SIGNING_PRIVATE_KEY` (path or key content) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if the key has no password).
  Without them `createUpdaterArtifacts` cannot produce the `.sig` files.
- Hosting: publish the NSIS `.exe` + its `.sig` and a `latest.json` manifest:

```json
{
  "version": "0.1.0",
  "notes": "Release notes shown in the app.",
  "pub_date": "2026-11-14T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of the .exe.sig file>",
      "url": "https://updates.tafseer-clipper.app/Tafseer-Clipper_0.1.0_x64-setup.exe"
    }
  }
}
```

  `tauri-apps/tauri-action` in `.github/workflows/release.yml` generates and
  uploads `latest.json` automatically from the tag.
- The app checks silently after startup (Tauri only) and offers
  Settings â†’ Storage â†’ Updates â†’ "Check for updates"; installation is always
  user-initiated and ends with "Install & restart".

## 6. GitHub secrets for the release workflow

These live in the **`production` environment**, not at repository level, so
they are only injected into the release job after a reviewer approves the
deployment. Add them under
**Settings → Environments → production → Environment secrets**.

| Secret | Status | Purpose |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | ✅ **set** | updater key (minisign) — the key content, base64-encoded |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | not needed | the current key is unencrypted; the Tauri CLI assumes an empty password in CI |
| `AZURE_TRUSTED_SIGNING_METADATA` / `AZURE_TRUSTED_SIGNING_DLIB` | ❌ **missing** | Azure Trusted Signing (recommended) |
| `WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD` | ❌ **missing** | PFX Authenticode signing (alternative) |
| `WINDOWS_CERT_THUMBPRINT` | ❌ **missing** | certificate-store signing (alternative) |
| `SIGNTOOL_PATH` | optional | path to `signtool.exe` when it is not on `PATH` |

`REQUIRE_CODE_SIGNING` defaults to `1` in the workflow, so **the build fails
rather than shipping an unsigned installer** while the Authenticode secrets
are missing. That is intentional — add one of the three credential sets above
before the first release. The `production` environment secret
`REQUIRE_CODE_SIGNING` overrides the default; it is set to `0` for the
**v0.1.0-beta** pre-release only, which was published **unsigned by explicit
decision** (SmartScreen warnings accepted). Set it back to `1` — or delete it —
once Authenticode credentials are configured, to restore fail-closed.

> **Note on the onedir engine.** Since 0.1.4 the Python engine is a resource
> folder (`<install>\backend\`) with ~96 `.dll`/`.exe` files, so a build with
> Authenticode credentials signs each of them through `sign-windows.ps1` as well
> as the app and the installer (~2 extra minutes; that is expected). Without
> credentials they stay unsigned, and `scripts/build-release.ps1 -SkipSigning`
> removes `bundle.windows.signCommand` for that build — Tauri asks `signtool`
> whether a bundled DLL is already signed *before* deciding to sign it, so the
> hook cannot stay in place on a machine without the Windows SDK.

> **Note on the key format.** `TAURI_SIGNING_PRIVATE_KEY` must be the **base64
> text** of the minisign key (exactly the contents of `.release-secrets/updater.key`).
> The Tauri CLI base64-decodes the value before loading it; passing the decoded
> "untrusted comment: …" text instead will fail with a key-parse error.
>
> **Note on rotating the key.** The key currently stored is the locally
> generated development key. Rotate it before the first public release: generate
> a new pair, commit only the new `plugins.updater.pubkey` in
> `src-tauri/tauri.conf.json`, and update `TAURI_SIGNING_PRIVATE_KEY` in the
> `production` environment.

## 7. Post-release

- Run [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) on **both** a clean Windows 11 VM
  and a clean Windows 10 (21H2+) VM (no Python, Node, Rust, or system FFmpeg) against
  the *installed* app. Windows 10 is the supported floor; Windows 7/8.1 are not.
- Smoke-test the updater: install the previous version, publish a newer
  `latest.json`, confirm the in-app update downloads, installs and relaunches.
- Keep the updater private key backed up offline. Losing it (or its password)
  makes future updates impossible to sign.

## 8. GPU acceleration pack (optional)

GPU transcription is **optional and hardware-agnostic in user-facing copy**: no
GPU model names, no CUDA installation. The installer ships CPU-only; users with
an NVIDIA GPU click **Enable GPU acceleration** once and the Tauri shell
downloads the CUDA runtime/cuDNN pack, verifies it and stores it under
`%LOCALAPPDATA%\Tafseer Clipper\accel\<version>`. The sidecar receives
`TAFSEER_CUDA_DIR` and registers the DLLs before importing CTranslate2.

Full details (contents, manifest schema, hosting, security, troubleshooting) live
in [`GPU_PACK.md`](GPU_PACK.md). Release-relevant points:

- Build the pack: `powershell -ExecutionPolicy Bypass -File scripts/build-accel-pack.ps1`
  → `release/<version>/accel/{accel-manifest.json,files/*.dll}`.
- Host `accel-manifest.json` and the DLLs **in the same directory** (relative
  URLs). `.github/workflows/release.yml` builds and uploads them to the GitHub
  Release automatically and bakes
  `VITE_ACCEL_PACK_MANIFEST_URL=https://github.com/<owner>/<repo>/releases/latest/download/accel-manifest.json`
  into the frontend build.
- Any static host works; set `VITE_ACCEL_PACK_MANIFEST_URL` before
  `scripts/build-release.ps1`. HTTPS is required (loopback HTTP only for tests).
- The pack is ~1.5–2 GB (cuBLAS + cuDNN), versioned independently of the app.
- **CPU fallback is a hard requirement:** without the pack, with a failed
  download, on a non-NVIDIA machine, or after a driver problem, transcription and
  encoding must keep working on the CPU and the UI must say so. Never gate the
  wizard on GPU availability.

## 9. Verified build facts for this v0.1.0 checkout

| Fact | Value |
|---|---|
| Rust shell compile | `cargo check` exit 0 (stable 1.98, GNU host + MinGW linker); full `tauri build` exit 0 |
| Frozen sidecar | `dist/backend.exe` 110.8 MB onefile; cold start 3.9–7.7 s; `backend/smoke_frozen.py` 32/32 |
| Installer | `Tafseer Clipper_0.1.0_x64-setup.exe` 162.9 MiB (NSIS, per-user) + `.sig` updater artifact |
| Signing hook | unsigned local build warns and succeeds; `REQUIRE_CODE_SIGNING=1` fails without credentials (verified both) |
| Frontend | `tsc --noEmit` 0, `vite build` 0, Playwright E2E 6/6 (real sidecar, mocked LLM/render) |
| Backend E2E | `backend/test_phase1_e2e.py` **42/42** (re-verified 2026-11-15; the suite gained two GPU-fallback regressions) |
| GPU path (real hardware) | Laptop NVIDIA GPU (4 GB): pack installed → `/health.acceleration.transcription=gpu`; source and frozen sidecars both loaded faster-whisper on `device=cuda`/`int8` and unloaded GPU memory |
| GPU fallback (no pack) | Same laptop, pack absent: `/health` reports `transcription=cpu`, `cuda_runtime=false`, `reason=cuda-runtime-missing`, and `/extract-and-transcribe` returns **200 JSON on `device=cpu`** (previously `500 text/plain` — see `docs/RELEASE_READINESS.md` §2/§9) |
| GPU pack | `scripts/build-accel-pack.ps1` → manifest + 18 DLLs / 2.0 GB (CUDA 12.9 + cuDNN 9.28); Rust downloader/verifier 11/11 unit tests |
| Packaged payload | `powershell -ExecutionPolicy Bypass -File scripts/smoke-installer.ps1` — silent install, installed `backend.exe` serves `/health` with the **bundled** ffmpeg, clean sidecar shutdown, silent uninstall |

### Packaged smoke scope

`scripts/smoke-installer.ps1` verifies the installer payload without a desktop.
Add `-TryGui` to also launch the installed app and wait for the shell-spawned
sidecar; in headless/restricted sessions WebView2 window creation is denied, so
that part reports **SKIP** instead of failing. The full window + wizard flow is
covered by `docs/RELEASE_CHECKLIST.md` on a desktop VM.

Pass `-Sandbox <dir>` to put the throwaway install somewhere other than
`<repo>/.smoke`. Use it whenever the checkout lives in a cloud-synced folder
(OneDrive, Dropbox): the script redirects the sidecar's `%TEMP%` there, and
temporary-file creation fails inside OneDrive for reasons unrelated to the app.
Release builds are onedir and no longer extract to `%TEMP%`. Example:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-installer.ps1 -Sandbox C:\smoke-test
```

The script must also be run from an **interactive session**: a silent `/S`
install can stall on a prompt that a non-interactive agent session cannot answer.

### Troubleshooting: the window never appears

`pnpm tauri dev` exiting **101** is a Rust panic, not a compile error. If the
panic reads `failed to create webview: WebView2 error: WindowsError { code:
HRESULT(0x8000FFFF) }`, the shell started and WebView2 refused to create its
window. Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/diagnose-webview.ps1
```

The check that matters most on this project is the **checkout location**: from a
OneDrive-synced folder WebView2 fails with exactly that HRESULT, while the same
binary works from a normal path (verified by running the debug build from
`C:\` and watching the window open and the sidecar spawn). Other candidates the
script reports: elevation (WebView2 fails in an elevated process), a missing or
damaged WebView2 Runtime, and a corrupt user-data folder — pass `-ResetProfile`
to clear the last one.

Remaining before a *public* release: a real updater hosting URL, and the two
clean-VM checklist runs on GPU hardware with real lecture material. Authenticode
signing is **deliberately out of scope** (`docs/RELEASE_READINESS.md` BL-3), so
builds stay internal-unsigned; `release.yml` keeps failing closed on tags, which
means the public-release path stays shut rather than shipping unsigned.

Exception on record (2026-11-17): the **v0.1.0-beta** pre-release was published
unsigned to GitHub Releases by explicit decision, with the `production`
environment secret `REQUIRE_CODE_SIGNING=0`. The workflow default remains
fail-closed; restore `1` before any further release.




