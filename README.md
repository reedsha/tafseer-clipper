# Tafseer Lecture AI Clipper & Bilingual Subtitle Studio

Windows desktop app for turning long-form Tafseer lectures (Thai + Classical
Arabic) into short bilingual clips.

- `src/` — React + TypeScript + Tailwind (shadcn/ui) wizard UI, Zustand stores.
- `src-tauri/` — Tauri v2 Rust shell: window lifecycle, sidecar spawn, native
  dialogs, scoped project-file access, auto-updater and Authenticode signing hook.
- `backend/` — Python FastAPI sidecar on a dynamic loopback port: transcription,
  clip discovery, Arabic verification, font import and NVENC batch rendering.
- `AGENTS.md` — binding UI/architecture contract.
- `tafseer_clipper_master_plan.md` — authoritative specification.
- `AUDIT_REPORT.md` — audit findings and remediation checklist.
- `docs/RELEASING.md` — release runbook (build, signing, updater, secrets).
- `docs/RELEASE_CHECKLIST.md` — packaged end-to-end release gate.

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

The installer is per-user (no admin), ships `backend.exe`, `ffmpeg.exe` and
`ffprobe.exe`, and produces signed auto-updater artifacts. See
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

