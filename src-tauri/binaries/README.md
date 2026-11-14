# `src-tauri/binaries/` — bundled sidecars

This directory is the **input** folder for Tauri's `bundle.externalBin`
configuration (`tauri.conf.json` → `bundle.externalBin: ["binaries/backend",
"binaries/ffmpeg", "binaries/ffprobe"]`).

It is intentionally empty in git: the executables are build artifacts that must
be staged here **before** `tauri build` (and before `tauri dev` / `cargo check`,
because `tauri-build` verifies their presence). They are git-ignored; only this
README is committed.

`scripts/build-release.ps1` performs the whole staging step automatically.

## Required files

Tauri requires every external binary to exist with the host target triple
appended to the file name. On this project's target platform (Windows x64):

| Config entry        | File that must exist here                       | Built from |
| ------------------- | ----------------------------------------------- | ---------- |
| `binaries/backend`  | `backend-x86_64-pc-windows-msvc.exe`            | `backend/build_sidecar.spec` (PyInstaller) |
| `binaries/ffmpeg`   | `ffmpeg-x86_64-pc-windows-msvc.exe`             | FFmpeg "essentials" build (GPL — see `THIRD_PARTY_NOTICES.md`) |
| `binaries/ffprobe`  | `ffprobe-x86_64-pc-windows-msvc.exe`            | Same FFmpeg build |

The Rust toolchain's host triple is `rustc -vV | findstr host:` — use
`x86_64-pc-windows-gnu` instead if you build with the GNU toolchain. Keep both
suffixes staged if you build with both.

## Build/rename steps (manual)

1. Build the sidecar: `.build-venv\Scripts\pyinstaller.exe --noconfirm --clean backend/build_sidecar.spec`
   → `dist/backend.exe`.
2. `rustc -vV` → note the `host:` triple (e.g. `x86_64-pc-windows-msvc`).
3. Copy/rename:
   - `backend.exe` → `backend-<triple>.exe`
   - `ffmpeg.exe` → `ffmpeg-<triple>.exe`
   - `ffprobe.exe` → `ffprobe-<triple>.exe`

## Why the suffixed names are mandatory

`tauri-build` (run from `src-tauri/build.rs`) copies every `externalBin` entry
into the Cargo target directory, stripping the `-<target-triple>` suffix. If a
suffixed file is missing the build fails with `"… does not exist"`, so
**`tauri dev` will not compile until all three suffixed files are present**.

At bundle time Tauri copies the same binaries next to the application executable
as plain `backend.exe` / `ffmpeg.exe` / `ffprobe.exe`. `src-tauri/src/lib.rs`
spawns the sidecar with `app.shell().sidecar("backend")`, which resolves to that
file name next to the app executable (the configured name without the suffix).
The sidecar's FFmpeg resolver looks for `ffmpeg.exe` / `ffprobe.exe` in the
application directory, so the bundle is self-contained.

## Runtime contract implemented by `src/lib.rs`

On startup the Rust shell:

1. binds `127.0.0.1:0` to pick a free loopback port and releases it,
2. spawns `backend.exe` with:
   - `TAFSEER_HOST=127.0.0.1`
   - `TAFSEER_PORT=<picked port>`
   - `TAFSEER_FONTS_DIR=%LOCALAPPDATA%\Tafseer Clipper\fonts`
   - `TAFSEER_WORK_DIR=%LOCALAPPDATA%\Tafseer Clipper\work`
3. injects `window.__TAFSEER_SIDECAR_URL__ = "http://127.0.0.1:<picked port>"` as a
   webview initialization script before the renderer loads,
4. kills the sidecar (and its Windows job object/process group, so FFmpeg
   children die too) when the main window is destroyed or the app exits.

If the sidecar cannot be spawned (for example a placeholder binary during
`cargo check`, or a missing file), the shell does **not** crash: it injects
`http://127.0.0.1:8008` instead, so a backend started manually
(`py -3.12 backend/main.py`, default port `8008`) keeps working in development.

## GPU note

`backend.exe` bundles `faster-whisper`/CTranslate2/ONNX Runtime but **not** the
CUDA runtime libraries. GPU acceleration is optional: the Tauri shell can
download the optional acceleration pack into
`%LOCALAPPDATA%\Tafseer Clipper\accel\<version>` and passes it to the sidecar as
`TAFSEER_CUDA_DIR`; the sidecar registers those DLLs before importing
CTranslate2. Without the pack (or without an NVIDIA GPU) transcription and
encoding run on the CPU — the CPU fallback is always available. See
`docs/GPU_PACK.md` and `THIRD_PARTY_NOTICES.md`.
