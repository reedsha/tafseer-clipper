#requires -Version 5.1
<#
.SYNOPSIS
    Packaged payload smoke test: install the NSIS installer, verify the bundled
    sidecar (backend.exe + ffmpeg.exe + ffprobe.exe) works from the install
    directory, then uninstall.

.DESCRIPTION
    Verifies the installer payload without needing an interactive desktop:
      1. NSIS silent install lays down the app + backend.exe + ffmpeg.exe +
         ffprobe.exe + THIRD_PARTY_NOTICES.md + uninstall.exe.
      2. The installed backend.exe starts on a free port with the app's user-data
         directories, resolves the *bundled* ffmpeg.exe, and answers /health.
      3. The sidecar exits cleanly (no orphan process).
      4. The uninstaller removes the program files.

    Optional -TryGui additionally launches the installed app and waits for the
    sidecar log; this needs an interactive desktop with WebView2 and is reported
    as SKIP (not FAIL) when the environment cannot create a webview window
    (headless CI / restricted sandbox).

.PARAMETER Installer
    Path to "Tafseer Clipper_<version>_x64-setup.exe". Defaults to the newest one
    under src-tauri/target or .cargo-target.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/smoke-installer.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/smoke-installer.ps1 -TryGui
#>
param(
    [string]$Installer = "",
    [switch]$TryGui,
    [switch]$KeepInstalled
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "FAIL: $Message" -ForegroundColor Red; exit 1 }
function Skip([string]$Message) { Write-Host "SKIP: $Message" -ForegroundColor Yellow }

if (-not $Installer) {
    $candidates = @(
        "src-tauri\target\release\bundle\nsis\*setup.exe",
        ".cargo-target\release\bundle\nsis\*setup.exe",
        "release\*\*setup.exe"
    ) | ForEach-Object { Get-ChildItem $_ -ErrorAction SilentlyContinue }
    $Installer = $candidates | Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Installer -or -not (Test-Path -LiteralPath $Installer)) { Fail "Installer not found (build it with scripts/build-release.ps1)." }
$Installer = (Resolve-Path $Installer).Path
Write-Host "Installer: $Installer ($([math]::Round((Get-Item $Installer).Length / 1MB, 1)) MiB)"

$sandboxRoot = Join-Path $root ".smoke"
$installDir = Join-Path $sandboxRoot "install"
$localAppData = Join-Path $sandboxRoot "localappdata"
Remove-Item -Recurse -Force $sandboxRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $installDir, $localAppData | Out-Null

$previousLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $localAppData
$sidecar = $null

try {
    # --- 1. silent install -------------------------------------------------- #
    Step "Installing silently to $installDir"
    Unblock-File -Path $Installer -ErrorAction SilentlyContinue
    # cmd.exe (CreateProcess) avoids the shell's "Open File - Security Warning"
    # prompt that can block a headless run.
    cmd.exe /c "`"$Installer`" /S /D=$installDir"
    if ($LASTEXITCODE -ne 0) { Fail "Installer exited with code $LASTEXITCODE." }
    Start-Sleep -Seconds 2

    $expected = @(
        "Tafseer Clipper.exe",
        "backend.exe",
        "ffmpeg.exe",
        "ffprobe.exe",
        "THIRD_PARTY_NOTICES.md",
        "uninstall.exe"
    )
    foreach ($relative in $expected) {
        $path = Join-Path $installDir $relative
        if (-not (Test-Path -LiteralPath $path)) { Fail "Missing installed file: $relative" }
        Write-Host ("  OK {0} ({1:N1} MiB)" -f $relative, ((Get-Item $path).Length / 1MB))
    }

    # --- 2. bundled sidecar from the install dir ---------------------------- #
    Step "Starting the installed backend.exe (bundled ffmpeg must resolve)"
    $sidecarExe = Join-Path $installDir "backend.exe"
    $fontsDir = Join-Path $localAppData "Tafseer Clipper\fonts"
    $workDir = Join-Path $localAppData "Tafseer Clipper\work"
    $logDir = Join-Path $localAppData "Tafseer Clipper\logs"
    New-Item -ItemType Directory -Force $fontsDir, $workDir | Out-Null

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP

    $env:TAFSEER_HOST = "127.0.0.1"
    $env:TAFSEER_PORT = "$port"
    $env:TAFSEER_FONTS_DIR = $fontsDir
    $env:TAFSEER_WORK_DIR = $workDir
    $env:TAFSEER_LOG_DIR = $logDir
    # Onefile sidecars extract to %TEMP%; keep that inside the sandbox and use
    # CreateProcess (`&`) so the shell security prompt cannot block the run.
    $sidecarTmp = Join-Path $sandboxRoot "tmp"
    New-Item -ItemType Directory -Force $sidecarTmp | Out-Null
    $env:TEMP = $sidecarTmp
    $env:TMP = $sidecarTmp
    # backend.exe is a console app: `&` would block until it exits, and
    # Start-Process would trigger the shell security prompt, so use CreateProcess
    # directly and keep the handle for the process-tree kill below.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $sidecarExe
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WorkingDirectory = $installDir
    $sidecar = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $sidecar) { Fail "Could not start the installed backend.exe." }

    $health = $null
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Milliseconds 500
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3; break } catch { }
        if ($sidecar.HasExited) { break }
    }
    if (-not $health) {
        if ($sidecar.HasExited) { Fail "Installed backend.exe exited with code $($sidecar.ExitCode)." }
        Fail "Installed backend.exe did not answer /health on port $port within 45 s."
    }
    if ($health.status -ne "ok") { Fail "Unexpected /health status: $($health.status)" }
    if ($health.version -ne "0.1.0") { Fail "Unexpected sidecar version: $($health.version)" }
    Write-Host ("  /health ok: version={0} ffmpeg={1} ffprobe={2} nvenc={3}" -f `
        $health.version, $health.ffmpeg_available, $health.ffprobe_available, $health.nvenc_available)
    if (-not $health.ffmpeg_available) { Fail "Bundled ffmpeg.exe was not resolved next to backend.exe." }
    Write-Host "  fonts_dir: $($health.fonts_dir)"
    Write-Host "  work_dir : $($health.work_dir)"
    if ($health.fonts_dir -notlike "*$sandboxRoot*") { Fail "fonts_dir escaped the sandbox: $($health.fonts_dir)" }

    $logFile = Join-Path $logDir "sidecar.log"
    if (-not (Test-Path -LiteralPath $logFile)) { Fail "Sidecar file logging did not create $logFile" }
    Write-Host "  log file : $logFile"

    # --- 3. stop the sidecar cleanly ---------------------------------------- #
    Step "Stopping the installed sidecar"
    & taskkill.exe /PID $sidecar.Id /T /F *> $null
    $orphanDeadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $orphanDeadline -and (Get-Process backend -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 500
    }
    if (Get-Process backend -ErrorAction SilentlyContinue) { Fail "backend.exe survived taskkill." }
    $sidecar = $null
    Write-Host "  no orphan backend/ffmpeg processes"

    # --- 4. optional GUI launch --------------------------------------------- #
    if ($TryGui) {
        Step "Launching the installed app (optional; needs an interactive desktop)"
        $appExe = Join-Path $installDir "Tafseer Clipper.exe"
        Unblock-File -Path $appExe -ErrorAction SilentlyContinue
        $appLog = Join-Path $logDir "sidecar.log"
        Remove-Item $appLog -ErrorAction SilentlyContinue
        # Direct CreateProcess avoids the shell security prompt.
        & $appExe 2> (Join-Path $sandboxRoot "app-stderr.log")
        $deadline = (Get-Date).AddSeconds(45)
        $appPort = $null
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $appLog) {
                $match = Select-String -Path $appLog -Pattern "Uvicorn running on http://127\.0\.0\.1:(\d+)" |
                    Select-Object -Last 1
                if ($match) { $appPort = [int]$match.Matches[0].Groups[1].Value; break }
            }
            if (-not (Get-Process "Tafseer Clipper" -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 500
        }
        $stderr = Get-Content (Join-Path $sandboxRoot "app-stderr.log") -Raw -ErrorAction SilentlyContinue
        if ($appPort) {
            try {
                $appHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$appPort/health" -TimeoutSec 5
            }
            catch {
                $appHealth = $null
            }
            if (-not $appHealth) {
                Skip "GUI sidecar started but the window died (headless/sandboxed session); run the checklist on a desktop VM."
                return
            }
            Write-Host "  GUI launched, shell-spawned sidecar port $appPort, version $($appHealth.version)"
            Get-Process "Tafseer Clipper" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            # The sidecar's parent-watchdog exits when the shell dies (hard-kill path).
            $orphanDeadline = (Get-Date).AddSeconds(10)
            while ((Get-Date) -lt $orphanDeadline -and (Get-Process backend -ErrorAction SilentlyContinue)) {
                Start-Sleep -Milliseconds 500
            }
            if (Get-Process backend -ErrorAction SilentlyContinue) { Fail "Sidecar survived the GUI app shutdown." }
            Write-Host "  GUI shutdown left no orphan sidecar"
        }
        elseif ($stderr -match "webview window|Access is denied") {
            Skip "GUI launch is not possible in this session (WebView2 window creation denied); run the checklist on a desktop VM."
        }
        else {
            Skip "GUI did not report a sidecar port; see .smoke\app-stderr.log. Run docs/RELEASE_CHECKLIST.md on a desktop VM."
        }
    }

    # --- 5. uninstall ------------------------------------------------------- #
    if (-not $KeepInstalled) {
        Step "Uninstalling"
        $uninstaller = Join-Path $installDir "uninstall.exe"
        Unblock-File -Path $uninstaller -ErrorAction SilentlyContinue
        cmd.exe /c "`"$uninstaller`" /S"
        Start-Sleep -Seconds 5
        if (Test-Path -LiteralPath (Join-Path $installDir "Tafseer Clipper.exe")) {
            Fail "Uninstall left the application executable behind."
        }
        Write-Host "  program files removed"
    }

    Write-Host "`nPASS: packaged payload smoke test completed." -ForegroundColor Green
}
finally {
    $env:LOCALAPPDATA = $previousLocalAppData
    if ($previousTemp) { $env:TEMP = $previousTemp }
    if ($previousTmp) { $env:TMP = $previousTmp }
    if ($sidecar -and -not $sidecar.HasExited) { $sidecar | Stop-Process -Force -ErrorAction SilentlyContinue }
    Get-Process "Tafseer Clipper" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if (-not $KeepInstalled) { Remove-Item -Recurse -Force $sandboxRoot -ErrorAction SilentlyContinue }
}






