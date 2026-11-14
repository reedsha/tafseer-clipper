# GPU Acceleration Pack

Tafseer Clipper runs local Whisper transcription on the CPU out of the box and
always falls back to it. Users with an NVIDIA GPU can enable faster GPU
transcription with **one click** in Settings → GPU acceleration — no CUDA
toolkit installation, no driver work.

That click downloads the **GPU acceleration pack**: the CUDA runtime libraries
that CTranslate2/faster-whisper need, packaged as a handful of DLLs and served
from a manifest. The installer itself stays ~160 MB.

```
Settings → GPU acceleration → "Enable GPU acceleration"
        │
        ▼
Rust shell downloads accel-manifest.json + every file (HTTPS)
        │  verifies each SHA-256, streams to disk, shows progress
        ▼
%LOCALAPPDATA%\Tafseer Clipper\accel\<pack-version>\*.dll
%LOCALAPPDATA%\Tafseer Clipper\accel\current.json      (marker)
        │  app restart
        ▼
Sidecar starts with TAFSEER_CUDA_DIR=<that dir>
        │  os.add_dll_directory(dir) before importing ctranslate2
        ▼
/health.acceleration = { transcription: "gpu", cuda_runtime: true, ... }
```

If anything is missing, the app simply reports `transcription: "cpu"` and keeps
working — the CPU fallback is never blocked by the GPU pack.

## Contents

The pack is assembled from the official NVIDIA pip wheels, so versions are
pinned by the wheel metadata:

| Wheel | Provides |
|---|---|
| `nvidia-cuda-runtime-cu12` | `cudart64_12.dll` |
| `nvidia-cublas-cu12` | `cublas64_12.dll`, `cublasLt64_12.dll` |
| `nvidia-cudnn-cu12` | `cudnn64_9.dll` + cuDNN 9 graph/engines/ops libraries |
| `nvidia-cuda-nvrtc-cu12` | `nvrtc64_*.dll` (runtime-compiled cuDNN engines) |
| `nvidia-nvjitlink-cu12` | `nvJitLink_*.dll` |

Total size is roughly **2 GB uncompressed** (cuBLAS + cuDNN dominate). The
app shows the real size from the manifest before/while downloading. Only NVIDIA
GPUs are accelerated; encoding is NVIDIA-only too (NVENC), with automatic
`libx264` fallback.

## Build the pack

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-accel-pack.ps1
# -> release/<app-version>/accel/accel-manifest.json
# -> release/<app-version>/accel/files/*.dll
# optional single archive:
powershell -ExecutionPolicy Bypass -File scripts/build-accel-pack.ps1 -Zip
```

The script downloads the wheels with `pip download`, extracts the DLLs, computes
SHA-256 per file and writes the manifest. It needs Python 3.12 and internet
access; no NVIDIA GPU is required to build it.

## Manifest schema

```json
{
  "version": "cuda12.9.79-cudnn9.28.1.4",
  "total_size": 1723445248,
  "files": [
    {
      "name": "cudart64_12.dll",
      "url": "cudart64_12.dll",
      "sha256": "…",
      "size": 562688
    }
  ]
}
```

`url` may be relative — the shell resolves it against the manifest URL. That is
why the files must be hosted **next to the manifest**.

## Hosting

### GitHub Releases (default, automated)

`.github/workflows/release.yml` builds the pack and uploads `accel-manifest.json`
plus every DLL as release assets after `tauri-action` creates the draft release.
The frontend's manifest URL is baked at build time from:

```
VITE_ACCEL_PACK_MANIFEST_URL=https://github.com/<owner>/<repo>/releases/latest/download/accel-manifest.json
```

The release workflow sets this automatically from `${{ github.repository }}`.

### Any static host

Upload `accel-manifest.json` and the `files/*.dll` to the same directory (S3,
Cloudflare R2, your own CDN), then build the app with:

```powershell
$env:VITE_ACCEL_PACK_MANIFEST_URL = "https://downloads.example.com/accel/accel-manifest.json"
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
```

HTTPS is required (plain `http://127.0.0.1`/`localhost` is allowed only for
tests). No authentication is supported — the pack is public content.

## Security and integrity

- Every file is verified against the manifest's SHA-256; a mismatch aborts the
  install, deletes the partial directory and surfaces a readable error.
- Downloads go to `accel\<version>.tmp\`, then the directory is renamed into
  place atomically; `current.json` is written last, so a crash mid-download can
  never leave a half-installed runtime that the sidecar would load.
- The sidecar only loads the directory named in `current.json` (via
  `TAFSEER_CUDA_DIR`); a corrupt marker is ignored and transcription stays on CPU.
- Keep the manifest and DLLs in the same release as the app version they are
  tested with. The app tolerates a newer/older pack (it reports what it finds),
  but QA should test the matching pair.

## Runtime layout

```
%LOCALAPPDATA%\Tafseer Clipper\
├── accel\
│   ├── current.json                  # {version, dir, total_size, installed_at, files}
│   └── cuda12.9.79-cudnn9.28.1.4\
│       ├── cudart64_12.dll
│       ├── cublas64_12.dll
│       ├── cublasLt64_12.dll
│       ├── cudnn64_9.dll
│       └── …
├── fonts\
├── work\
└── logs\sidecar.log
```

Removing the pack = delete `%LOCALAPPDATA%\Tafseer Clipper\accel` and restart.
The app returns to CPU transcription.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Settings shows "GPU detected — runtime not installed" | Driver is present, CUDA libraries are not. Click **Enable GPU acceleration**. |
| Settings shows "CPU only (no NVIDIA GPU)" | No NVIDIA driver detected (`nvidia-smi` missing/failing). CPU and Cloud STT still work. |
| Download fails with a hash mismatch | Manifest/DLL mismatch on the host; rebuild the pack and re-upload both together. |
| After install, `/health.acceleration.transcription` is still `cpu` | Restart the app (the sidecar reads `TAFSEER_CUDA_DIR` at startup). Check `logs\sidecar.log` for a CUDA load warning. |
| `cudnn64_9.dll` or `msvcp140.dll` missing | The pack covers CUDA/cuDNN; install the Microsoft Visual C++ 2015–2022 Redistributable if the system lacks it. |
| GPU out of memory / driver too old | Use the CPU fallback (automatic), switch to Cloud STT, or update the NVIDIA driver (CUDA 12-capable driver required). |

## Version bumps

- Re-run `scripts/build-accel-pack.ps1` when the NVIDIA wheels or the
  CTranslate2/faster-whisper versions change.
- The manifest `version` is derived from the CUDA/cuDNN wheel versions; the app
  displays it in Settings and diagnostics.
- The pack is versioned independently from the app, so it can be refreshed
  without shipping a new installer (upload a new manifest + files and bump the
  `version` string).

