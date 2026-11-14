# Third-Party Notices — Tafseer Clipper

Tafseer Clipper v0.1.0 bundles or depends on the following third-party software.
This file is bundled with the installer (`resources/THIRD_PARTY_NOTICES.md`).

Tafseer Clipper's own source code is licensed under the **MIT** license (see
`LICENSE`). That license does not extend to the components below, each of which
keeps its own terms.

## Bundled binaries

### FFmpeg (`ffmpeg.exe`, `ffprobe.exe`)

- **Build:** gyan.dev "essentials" release build, version 9.0.2, 64-bit Windows.
- **License:** **GPL v3** (the build includes `libx264`, which is GPL-licensed; the
  whole FFmpeg binary is therefore distributed under the GNU General Public
  License, version 3 or later).
- **Source code:** <https://www.ffmpeg.org/download.html> and
  <https://www.gyan.dev/ffmpeg/builds/>.
- **Written offer:** The distributor of this application must accompany the
  installer with a written offer to provide the complete corresponding source
  code of the bundled FFmpeg build (including the exact configuration flags)
  for a period of three years. Source archives for the exact FFmpeg version and
  build configuration are available from <https://www.gyan.dev/ffmpeg/builds/>
  and <https://ffmpeg.org/releases/>.
- **License text:** <https://www.gnu.org/licenses/gpl-3.0.txt>. A copy of the
  GPLv3 text is also shipped in the FFmpeg distribution's `LICENSE` file next to
  the binaries at build time.
- **No warranty:** FFmpeg is provided "as is", without warranty of any kind.

### Microsoft Visual C++ Runtime

The frozen sidecar bundles the Microsoft Visual C++ 2015–2022 Redistributable
DLLs (`msvcp140*.dll`, `vcruntime140*.dll`, `concrt140.dll`) copied from the
build machine's `System32`. They are redistributable with applications under the
Microsoft Visual Studio license terms
(<https://visualstudio.microsoft.com/license-terms/>) and are required by
CTranslate2/CUDA. The PyInstaller spec replaces older copies shipped by some
wheels so the GPU acceleration pack (built with the current MSVC runtime) loads
correctly.

### PyInstaller bootloader

The frozen `backend.exe` is produced with PyInstaller, whose bootloader is
distributed under GPL v2 with a special exception that permits distribution of
the bundled application under any license. See
<https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt>.

## Python runtime dependencies (frozen into `backend.exe`)

| Package | License |
|---|---|
| FastAPI | MIT |
| Uvicorn | BSD-3-Clause |
| Pydantic / pydantic-core | MIT |
| Starlette | BSD-3-Clause |
| HTTPX | BSD-3-Clause |
| python-multipart | Apache-2.0 |
| fontTools | MIT |
| faster-whisper | MIT |
| CTranslate2 | MIT |
| ONNX Runtime | MIT |
| PyAV (av) | BSD-3-Clause |
| huggingface-hub | Apache-2.0 |
| tokenizers | Apache-2.0 |
| numpy | BSD-3-Clause |

## JavaScript / Rust dependencies

The React frontend and the Tauri v2 Rust shell use the packages listed in
`package.json` and `src-tauri/Cargo.toml`; all are permissively licensed (MIT,
Apache-2.0, BSD, ISC or MPL-2.0). No GPL/AGPL code is linked into the shell.

## Runtime-downloaded assets (not bundled)

- **GPU acceleration pack (optional, NVIDIA):** the app can download the CUDA
  runtime, cuBLAS and cuDNN libraries on demand into
  `%LOCALAPPDATA%\Tafseer Clipper\accel\`. Those libraries are **not** bundled
  with the installer and are **not** open source; they are redistributed under
  the NVIDIA CUDA Toolkit and cuDNN license agreements (see
  <https://docs.nvidia.com/cuda/eula/> and
  <https://docs.nvidia.com/deeplearning/cudnn/sla/>). The pack is optional: CPU
  transcription and encoding work without it.
- **Whisper model weights** (`large-v3-turbo` by default): downloaded on first
  local transcription from Hugging Face (`Systran/faster-whisper-large-v3`,
  derived from OpenAI Whisper, MIT license). The model is stored in the user's
  cache directory and is not part of this installer.
- **WebView2 Runtime**: provided by Microsoft as a Windows component; the
  installer uses the Evergreen WebView2 bootstrapper when it is missing.

## Fonts

The application does not bundle font files. It uses fonts installed on the
user's system (e.g. Noto Naskh Arabic, Leelawadee UI, Tahoma) and any fonts the
user imports through Settings → Fonts; imported font files remain the user's
responsibility to license.
