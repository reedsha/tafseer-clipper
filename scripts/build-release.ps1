#requires -Version 5.1
<#
.SYNOPSIS
    Build the Tafseer Clipper Windows release: frozen sidecar -> staged binaries ->
    NSIS installer (+ auto-updater artifacts).

.DESCRIPTION
    Steps:
      1. Build build/sidecar/backend/ (onedir) with PyInstaller
         (backend/build_sidecar.spec) using the .build-venv virtualenv.
      2. Copy ffmpeg.exe and ffprobe.exe into src-tauri/binaries/ with the Rust
         target-triple suffix that Tauri's `externalBin` requires.  The sidecar
         folder is bundled as a resource, not as an external binary.
      3. Run `npx tauri build --bundles nsis` with the updater signing key.

    Signing: the bundler calls src-tauri/sign-windows.ps1. Configure Authenticode
    credentials (see docs/RELEASING.md) or pass -SkipSigning for a local build.
    Updater artifacts need TAURI_SIGNING_PRIVATE_KEY (or .release-secrets/updater.key).

.EXAMPLE
    pwsh scripts/build-release.ps1
.EXAMPLE
    pwsh scripts/build-release.ps1 -SkipSidecar -SkipSigning
#>
param(
    [switch]$SkipSidecar,
    [switch]$SkipSigning,
    [string]$TargetTriple = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-Tool([string]$EnvVar, [string]$DefaultPath, [string]$Name) {
    $override = [Environment]::GetEnvironmentVariable($EnvVar)
    if ($override -and (Test-Path -LiteralPath $override)) { return (Resolve-Path $override).Path }
    if (Test-Path -LiteralPath $DefaultPath) { return (Resolve-Path $DefaultPath).Path }
    throw "Cannot find $Name. Set $EnvVar or install it (see docs/RELEASING.md)."
}

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path (Join-Path $cargoBin "rustc.exe")) {
    $env:PATH = "$cargoBin;$env:PATH"
}

# --- 0. sanity ------------------------------------------------------------- #
Write-Step "Checking prerequisites"
if (-not (Test-Path (Join-Path $root "node_modules"))) {
    throw "node_modules is missing. Run 'pnpm install' first."
}
$rustc = Join-Path $cargoBin "rustc.exe"
if (-not (Test-Path $rustc)) {
    throw "rustc not found in $cargoBin. Install the Rust toolchain (https://rustup.rs)."
}

if (-not $TargetTriple) {
    $hostLine = (& $rustc -vV | Select-String '^host:').ToString()
    $TargetTriple = ($hostLine -split ':', 2)[1].Trim()
}
Write-Host "Target triple: $TargetTriple"

if ($TargetTriple -like "*-windows-gnu*") {
    # The GNU toolchain needs its MinGW linker on PATH (release builds should use MSVC).
    $mingw = Join-Path $root ".release-tools\mingw\mingw64\bin"
    if (Test-Path $mingw) {
        $env:PATH = "$mingw;$env:PATH"
        $env:TEMP = Join-Path $root ".cargo-target\tmp"
        $env:TMP = $env:TEMP
        New-Item -ItemType Directory -Force $env:TEMP | Out-Null
    }
}

# --- 1. sidecar ------------------------------------------------------------ #
if (-not $SkipSidecar) {
    Write-Step "Building frozen sidecar (PyInstaller)"
    $venvPython = Join-Path $root ".build-venv\Scripts\python.exe"
    $venvPyInstaller = Join-Path $root ".build-venv\Scripts\pyinstaller.exe"
    if (-not (Test-Path $venvPython)) {
        throw "Missing .build-venv. Create it: py -3.12 -m venv .build-venv; .build-venv\Scripts\python -m pip install -r backend/requirements.txt pyinstaller"
    }
    $env:TEMP = Join-Path $root ".pip-tmp"
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Force $env:TEMP | Out-Null
    & $venvPyInstaller --noconfirm --clean --distpath build\sidecar backend/build_sidecar.spec
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE." }
}

# The onedir folder is bundled through `bundle.resources` in tauri.conf.json.
$backendExe = Join-Path $root "build\sidecar\backend\backend.exe"
if (-not (Test-Path $backendExe)) {
    throw "build\sidecar\backend\backend.exe not found. Run the sidecar build (or pass an existing artifact)."
}

# --- 2. stage external binaries -------------------------------------------- #
Write-Step "Staging external binaries for $TargetTriple"
$binDir = Join-Path $root "src-tauri\binaries"
New-Item -ItemType Directory -Force $binDir | Out-Null
# Remove the pre-0.1.4 onefile sidecar if a previous build left one behind; it is
# no longer an externalBin and must not be shipped accidentally.
Get-ChildItem $binDir -Filter "backend-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force

$ffmpeg = Resolve-Tool "TAFSEER_FFMPEG" (Join-Path $env:LOCALAPPDATA "tafseer-clipper-tools\ffmpeg\bin\ffmpeg.exe") "ffmpeg.exe"
$ffprobe = Resolve-Tool "TAFSEER_FFPROBE" (Join-Path $env:LOCALAPPDATA "tafseer-clipper-tools\ffmpeg\bin\ffprobe.exe") "ffprobe.exe"
Copy-Item $ffmpeg (Join-Path $binDir "ffmpeg-$TargetTriple.exe") -Force
Copy-Item $ffprobe (Join-Path $binDir "ffprobe-$TargetTriple.exe") -Force
Write-Host "Staged: ffmpeg-$TargetTriple.exe, ffprobe-$TargetTriple.exe (+ resource backend/)"

# --- 3. updater signing key ------------------------------------------------ #
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $localKey = Join-Path $root ".release-secrets\updater.key"
    if (Test-Path $localKey) {
        $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path $localKey).Path
        Write-Host "Using local updater key: $localKey"
    }
    else {
        Write-Warning "TAURI_SIGNING_PRIVATE_KEY is not set and no .release-secrets/updater.key exists; updater artifacts will not be signed."
    }
}

if ($SkipSigning) {
    $env:REQUIRE_CODE_SIGNING = "0"
    Write-Warning "Code signing disabled (-SkipSigning): the installer will be UNSIGNED and must not be published."
}

# --- 4. tauri build -------------------------------------------------------- #
Write-Step "Building NSIS installer"
$tauriArgs = @("tauri", "build", "--bundles", "nsis")
if ($SkipSigning) {
    # Drop the Authenticode hook for this build. Tauri asks signtool whether each
    # bundled .exe/.dll is already signed before deciding to sign it, and that
    # lookup fails with "SignTool not found" on a machine without the Windows
    # SDK. The onedir engine ships ~96 DLLs/EXEs, so an unsigned build must not
    # carry a signCommand at all (sign-windows.ps1 only warns in that mode).
    $unsignedConfig = Join-Path $root "build\tauri.unsigned.json"
    New-Item -ItemType Directory -Force (Split-Path $unsignedConfig) | Out-Null
    # UTF-8 without BOM: serde_json rejects a BOM, and `Set-Content -Encoding
    # utf8` on Windows PowerShell 5.1 writes one.
    [System.IO.File]::WriteAllText(
        $unsignedConfig,
        '{ "bundle": { "windows": { "signCommand": null } } }',
        [System.Text.UTF8Encoding]::new($false)
    )
    $tauriArgs += @("--config", $unsignedConfig)
    Write-Host "Signing hook removed for this build: $unsignedConfig"
}
& npx @tauriArgs
if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE." }

# --- 5. report ------------------------------------------------------------- #
Write-Step "Artifacts"
$bundleDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
if (-not (Test-Path $bundleDir)) {
    $bundleDir = Join-Path $root ".cargo-target\release\bundle\nsis"
}
Get-ChildItem $bundleDir -ErrorAction SilentlyContinue |
    Select-Object Name, @{n = "SizeMB"; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime |
    Format-Table -AutoSize

Write-Host "Next: run docs/RELEASE_CHECKLIST.md on a clean Windows 11 VM." -ForegroundColor Green

