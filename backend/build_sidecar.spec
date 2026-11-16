# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Tafseer Clipper FastAPI sidecar (``backend.exe``).

Build (with the sidecar requirements installed)::

    py -m PyInstaller --noconfirm --clean backend/build_sidecar.spec

The default output is a single-file ``dist/backend.exe`` that is copied to
``src-tauri/binaries/backend-x86_64-pc-windows-msvc.exe`` (Tauri's
``externalBin`` naming).  Set ``TAFSEER_SIDECAR_ONEDIR=1`` to emit an onedir
``dist/backend/`` folder instead (faster start-up, easier to debug).

The hooks below exist because static analysis cannot see these runtime assets:

* ``faster_whisper`` loads the Silero VAD ONNX model from its package data and
  imports its VAD/feature-extractor modules dynamically;
* ``ctranslate2`` ships the C++/CUDA shared libraries;
* ``av`` (PyAV) and ``onnxruntime`` are imported dynamically and ship DLLs;
* ``uvicorn`` resolves its event loop / HTTP protocol / lifespan implementation
  through string imports at runtime.

Frozen path handling lives in ``backend/config.py`` (``RESOURCE_DIR`` vs
``user_data_dir()``); this spec only bundles read-only resources.
"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs, collect_submodules

BACKEND_DIR = Path(SPECPATH)  # noqa: F821 - injected by PyInstaller


def _collect(package: str) -> tuple[list, list, list]:
    """Collect datas/binaries/hiddenimports, tolerating a missing optional dep."""
    try:
        datas, binaries, hiddenimports = collect_all(package)
        return list(datas), list(binaries), list(hiddenimports)
    except Exception:
        return [], [], []


datas: list = []
binaries: list = []
hiddenimports: list = []

# --- Bundled Qur'an corpus -------------------------------------------------- #
_quran_corpus = BACKEND_DIR / "data" / "quran.json"
if _quran_corpus.is_file():
    datas.append((str(_quran_corpus), "data"))
else:
    print(f"[spec] WARNING: Qur'an corpus missing at {_quran_corpus}")

# --- AI stack -------------------------------------------------------------- #
for _package in ("faster_whisper", "ctranslate2", "av", "onnxruntime"):
    _datas, _binaries, _hidden = _collect(_package)
    datas += _datas
    binaries += _binaries
    hiddenimports += _hidden

# CUDA runtime DLLs installed by the ``nvidia-*-cu12`` wheels.  ctranslate2
# loads cuBLAS/cuDNN at runtime, so they must sit next to the extracted libs.
for _package in (
    "nvidia.cublas",
    "nvidia.cudnn",
    "nvidia.cuda_nvrtc",
    "nvidia.cuda_runtime",
):
    try:
        binaries += list(collect_dynamic_libs(_package))
    except Exception:
        pass

# --- Web layer ------------------------------------------------------------- #
# uvicorn imports these by name (loop=auto, http=auto, lifespan=on).
hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    # python-multipart provides both the modern and the legacy import name.
    "multipart",
    "python_multipart",
]

# --- Font metadata --------------------------------------------------------- #
# fontTools resolves its table implementations dynamically from
# ``fontTools.ttLib.tables``.
try:
    hiddenimports += list(collect_submodules("fontTools.ttLib.tables"))
except Exception:
    pass

# Keep the executable lean: none of these are needed by the sidecar (torch is
# only an optional VRAM-cleanup helper in services/transcriber.py and is
# imported inside a try/except).
EXCLUDES = [
    "torch",
    "torchaudio",
    "torchvision",
    "tensorflow",
    "matplotlib",
    "tkinter",
    "IPython",
    "pytest",
]

analysis = Analysis(
    [str(BACKEND_DIR / "main.py")],
    pathex=[str(BACKEND_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
)

# --------------------------------------------------------------------------- #
# MSVC runtime: use the build machine's current redistributable, not a wheel's
# --------------------------------------------------------------------------- #
# Some wheels (av/onnxruntime/…) still ship the Visual Studio 2019 (14.29)
# redistributable DLLs. In a PyInstaller onefile build they are extracted next
# to the app, and the extraction directory precedes System32 in the DLL search
# order. The CUDA/cuDNN libraries from the optional GPU acceleration pack are
# built with the current MSVC runtime (14.4x/14.5x), so mixing them crashes at
# GPU model load (0xc0000005 in MSVCP140.dll). Replace the bundled copies with
# the build machine's redistributable files (Microsoft permits redistribution).
VC_RUNTIME_DLLS = (
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcruntime140_threads.dll",
    "concrt140.dll",
)
_system32 = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32"
_keep = {name.lower() for name in VC_RUNTIME_DLLS}
analysis.binaries = [
    entry for entry in analysis.binaries if Path(entry[0]).name.lower() not in _keep
]
for _name in VC_RUNTIME_DLLS:
    _source = _system32 / _name
    if _source.is_file():
        analysis.binaries.append((_name, str(_source), "BINARY"))
    else:
        print(f"[spec] WARNING: {_name} not found in {_system32}; relying on the system runtime")

pyz = PYZ(analysis.pure)

ONEDIR = os.environ.get("TAFSEER_SIDECAR_ONEDIR", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

if ONEDIR:
    exe = EXE(
        pyz,
        analysis.scripts,
        [],
        exclude_binaries=True,
        name="backend",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
    COLLECT(
        exe,
        analysis.binaries,
        analysis.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name="backend",
    )
else:
    EXE(
        pyz,
        analysis.scripts,
        analysis.binaries,
        analysis.datas,
        [],
        name="backend",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
