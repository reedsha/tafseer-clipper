#requires -Version 5.1
<#
.SYNOPSIS
    Build the optional GPU acceleration pack (CUDA runtime + cuBLAS + cuDNN) for
    the one-click "Enable GPU acceleration" download.

.DESCRIPTION
    The app installer stays small (~160 MB). Users with an NVIDIA GPU who want
    faster local transcription download this pack once; the Tauri shell stores it
    under %LOCALAPPDATA%\Tafseer Clipper\accel\<version>\ and passes that path to
    the sidecar as TAFSEER_CUDA_DIR. CPU transcription always works without it.

    Output (default release/<app-version>/accel/):
      accel-manifest.json     - version + per-file sha256/size, relative URLs
      files\<dll>             - the DLLs to upload next to the manifest
      accel-pack-<v>.zip      - optional single archive (-Zip)

    Hosting: upload `files\*` and `accel-manifest.json` to the same release/dir so
    the manifest's relative URLs resolve. GitHub Releases (latest/download) is the
    default; see docs/GPU_PACK.md.

.PARAMETER OutDir
    Output directory. Defaults to release\<package.json version>\accel.

.PARAMETER Python
    Python used for `pip download` (default: py -3.12).

.PARAMETER Zip
    Also produce a single accel-pack-<version>.zip archive.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-accel-pack.ps1
#>
param(
    [string]$OutDir = "",
    [string]$Python = "py -3.12",
    [switch]$Zip
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

if (-not $OutDir) {
    $appVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $OutDir = Join-Path $root "release\$appVersion\accel"
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$filesDir = Join-Path $OutDir "files"
$work = Join-Path $root ".release-tools\accel-work"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work, $filesDir | Out-Null

# Keep pip/temp writes inside the workspace (sandboxed sessions deny %TEMP%).
$env:TEMP = Join-Path $work "tmp"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null

# cuDNN 9 needs its engines + graph libs; cuBLAS/cudart are required by CTranslate2;
# nvrtc/nvjitlink are needed by the runtime-compiled cuDNN engines.
$packages = @(
    "nvidia-cuda-runtime-cu12",
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12",
    "nvidia-cuda-nvrtc-cu12",
    "nvidia-nvjitlink-cu12"
)

Step "Downloading NVIDIA runtime wheels"
$wheelDir = Join-Path $work "wheels"
New-Item -ItemType Directory -Force $wheelDir | Out-Null
$existingWheels = Get-ChildItem $wheelDir -Filter *.whl
if ($existingWheels.Count -ge $packages.Count) {
    Write-Host ("Reusing {0} already-downloaded wheels (delete {1} to refresh)" -f $existingWheels.Count, $wheelDir)
}
else {
    $pipArgs = @("-m", "pip", "download", "--disable-pip-version-check", "--no-cache-dir", "--no-deps", "--only-binary=:all:", "-d", $wheelDir) + $packages
    $pythonParts = $Python -split '\s+'
    $pythonExe = $pythonParts[0]
    $pythonArgs = @()
    if ($pythonParts.Count -gt 1) { $pythonArgs = $pythonParts[1..($pythonParts.Count - 1)] }
    & $pythonExe @pythonArgs @pipArgs
    if ($LASTEXITCODE -ne 0) { throw "pip download failed with exit code $LASTEXITCODE." }
}

$wheels = Get-ChildItem $wheelDir -Filter *.whl
if (-not $wheels) { throw "No wheels were downloaded." }
Write-Host ("Downloaded {0} wheels ({1:N0} MB)" -f $wheels.Count, (($wheels | Measure-Object Length -Sum).Sum / 1MB))

Step "Extracting DLLs"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$extractDir = Join-Path $work "extract"
$dllSources = @()
foreach ($wheel in $wheels) {
    $target = Join-Path $extractDir $wheel.BaseName
    [System.IO.Compression.ZipFile]::ExtractToDirectory($wheel.FullName, $target)
    $dllSources += Get-ChildItem -Path $target -Recurse -Filter *.dll |
        Where-Object { $_.FullName -match '\\nvidia\\(cublas|cudnn|cuda_runtime|cuda_nvrtc|nvjitlink)\\bin\\' }
}
if (-not $dllSources) { throw "No NVIDIA DLLs found in the downloaded wheels." }

# cuDNN ships small loader DLLs in the ctranslate2 wheel already; keep every DLL
# from the wheels above so the runtime is self-contained.
$copied = @{}
foreach ($dll in $dllSources) {
    $destination = Join-Path $filesDir $dll.Name
    if ($copied.ContainsKey($dll.Name)) {
        if ((Get-FileHash $dll.FullName -Algorithm SHA256).Hash -ne $copied[$dll.Name]) {
            Write-Warning "Duplicate DLL name with different content: $($dll.Name) (keeping first)"
        }
        continue
    }
    Copy-Item $dll.FullName $destination -Force
    $copied[$dll.Name] = (Get-FileHash $destination -Algorithm SHA256).Hash
}

# Version string: cuda<cudart version>-cudnn<cudnn version>
$cudartWheel = $wheels | Where-Object { $_.Name -like 'nvidia_cuda_runtime_cu12-*' } | Select-Object -First 1
$cudnnWheel = $wheels | Where-Object { $_.Name -like 'nvidia_cudnn_cu12-*' } | Select-Object -First 1
function Wheel-Version([string]$name) {
    if ($name -match '^\S+?-(\d+(?:\.\d+)+)-') { return $Matches[1] }
    return "unknown"
}
$cudaVersion = if ($cudartWheel) { Wheel-Version $cudartWheel.Name } else { "unknown" }
$cudnnVersion = if ($cudnnWheel) { Wheel-Version $cudnnWheel.Name } else { "unknown" }
$packVersion = "cuda$cudaVersion-cudnn$cudnnVersion"

Step "Writing manifest ($packVersion)"
$files = Get-ChildItem $filesDir -Filter *.dll | Sort-Object Name | ForEach-Object {
    [ordered]@{
        name   = $_.Name
        url    = $_.Name          # relative to the manifest URL
        sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        size   = [int64]$_.Length
    }
}
$totalSize = [int64]0
foreach ($entry in $files) { $totalSize += [int64]$entry['size'] }
$manifest = [ordered]@{
    version    = $packVersion
    total_size = [int64]$totalSize
    files      = $files
}
$manifestPath = Join-Path $OutDir "accel-manifest.json"
# UTF-8 without BOM on purpose: the Tauri shell parses the manifest with
# serde_json, which rejects a leading BOM ("expected value at line 1 column 1").
# `Set-Content -Encoding utf8` writes a BOM under Windows PowerShell 5.1.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), $utf8NoBom)

if ($Zip) {
    Step "Creating archive"
    $zipPath = Join-Path $OutDir "accel-pack-$packVersion.zip"
    Remove-Item $zipPath -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $filesDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
    Write-Host ("Archive: {0} ({1:N0} MB)" -f $zipPath, ((Get-Item $zipPath).Length / 1MB))
}

Step "Summary"
Write-Host ("Pack version : {0}" -f $packVersion)
Write-Host ("DLLs         : {0}" -f $files.Count)
Write-Host ("Total size   : {0:N0} MB" -f ($totalSize / 1MB))
Write-Host ("Output       : {0}" -f $OutDir)
Write-Host ""
Write-Host "Upload these to the same release/directory so the manifest's relative URLs resolve:" -ForegroundColor Green
Write-Host "  accel-manifest.json"
$files | ForEach-Object { Write-Host ("  {0}" -f $_.name) }
Write-Host ""
Write-Host "Then point the app at it (default: docs/GPU_PACK.md):" -ForegroundColor Green
Write-Host "  VITE_ACCEL_PACK_MANIFEST_URL=<url-to-accel-manifest.json>"

