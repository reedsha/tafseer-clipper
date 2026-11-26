# Tafseer Lecture AI Clipper & Bilingual Subtitle Studio

Windows desktop app for turning long-form Tafseer lectures (Thai + Classical
Arabic) into short bilingual clips.

- `src/` — React + TypeScript + Tailwind (shadcn/ui) wizard UI, Zustand stores.
- `src-tauri/` — Tauri v2 Rust shell: window lifecycle, Win32 Job Object sidecar spawn/cleanup, native
  dialogs, atomic/scoped project-file access, DPAPI secret sealing, auto-updater and Authenticode signing hook.
- `backend/` — Python FastAPI sidecar on a dynamic loopback port: transcription,
  clip discovery, offline Qur'an verification, font import, SSE progress streams, and NVENC/libx264 batch rendering.
- `AGENTS.md` — binding UI/architecture contract.
- `docs/RELEASING.md` — release runbook (build, signing, updater, secrets).
- `docs/RELEASE_CHECKLIST.md` — packaged end-to-end release gate.

## Requirements

- **Windows 10 (21H2 or later) or Windows 11**, 64-bit. Windows 7/8.1 are **not**
  supported: the bundled FFmpeg 9.0.2 build targets the UCRT toolchain and needs
  Windows 10+.
- **WebView2 runtime.** Present on Windows 11; the installer fetches it on
  Windows 10 when it is missing (needs an internet connection on first install).
- **Disk:** ~550 MB for the installed app (165 MB installer: the engine ships
  unpacked under `backend\`, plus `ffmpeg.exe` and `ffprobe.exe`). Optional
  extras are much larger: the GPU acceleration pack is ~2.1 GB, and Whisper
  models are 0.5–3 GB depending on the model chosen.
- **GPU: optional.** An NVIDIA GPU only enables the one-click acceleration pack;
  transcription and rendering always work on the CPU.

## Development

```powershell
pnpm install          # frontend dependencies
pnpm dev              # Vite dev server (http://localhost:1420)
pnpm lint             # type-check + byte-compile the backend
pnpm test             # Rust unit tests + backend E2E + Playwright E2E
pnpm build            # production bundle in dist/
pnpm exec playwright test   # browser E2E only (starts the real sidecar + preview)

py -3.12 -m pip install -r backend/requirements.txt
py -3.12 backend/main.py    # start the FastAPI sidecar directly (port 8008)
py -3.12 backend/test_phase1_e2e.py   # Phase-1 backend E2E (needs ffmpeg)
```

Toolchain versions are pinned: Node 22 (`.nvmrc`), pnpm 11 (`packageManager`
in `package.json`), Python 3.12 (`.python-version`) and Rust stable
(`src-tauri/rust-toolchain.toml`).

> **Do not develop from a cloud-synced folder** (OneDrive, Dropbox, Google Drive…).
> From such a path, two separate subsystems fail on this machine: the PyInstaller
> sidecar cannot create its extraction directory, and **WebView2 cannot create the
> app window** — `pnpm tauri dev` then exits **101** with
> `failed to create webview: WebView2 error: WindowsError { code: HRESULT(0x8000FFFF) }`.
> The identical binaries work from a normal path (verified). Clone to something like
> `C:\dev\tafseer-clipper`; the installed app under `%LOCALAPPDATA%` is unaffected.
> If a window fails to open, run `scripts/diagnose-webview.ps1`.

## Release

Versions are **not** edited by hand. Merge a Conventional Commit into `main`
and a `chore(release): vX.Y.Z` pull request appears that bumps every version
anchor (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`backend/config.py`) and regenerates `CHANGELOG.md`. Merging that pull request
creates the `vX.Y.Z` tag and starts the Windows release build, which produces a
signed per-user NSIS installer plus the auto-updater artifacts and uploads them
into a draft GitHub Release.

Local release builds (no tag, no upload):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1            # sidecar -> staged binaries -> NSIS installer
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1 -SkipSidecar -SkipSigning   # fast local build
```

The installer is per-user (no admin), ships the onedir engine under `backend\`,
`ffmpeg.exe` and `ffprobe.exe`, and produces signed auto-updater artifacts. See
[`docs/RELEASING.md`](docs/RELEASING.md) for the signing/updater secrets and
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) for the clean-VM gate.

Built artifacts for the current version are published as GitHub Release assets:
<https://github.com/reedsha/tafseer-clipper/releases>.

## GPU acceleration (optional)

Transcription and encoding run on the CPU by default and always fall back to it.
On an NVIDIA GPU, Settings → GPU acceleration offers a one-click download of the
optional acceleration pack (CUDA runtime + cuDNN, no CUDA installation), after
which local transcription uses the GPU and rendering uses hardware encoding.
No GPU model names or VRAM requirements are part of the UI; the app reports
GPU/CPU state and the CPU fallback explicitly. Pack contents, hosting and
security are documented in [`docs/GPU_PACK.md`](docs/GPU_PACK.md).

## License

Source code: [MIT](LICENSE).

Note that the **bundled FFmpeg binaries are GPL v3**, so an installer containing
them carries the GPL's obligations regardless of the MIT license on this source.
The optional GPU acceleration pack and the Whisper model weights are downloaded
at runtime under their own (non-MIT) terms. Full inventory:
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

