#requires -Version 5.1
<#
.SYNOPSIS
    Diagnose why the Tauri shell cannot create its WebView2 window.

.DESCRIPTION
    Read-only by default. Checks the things that actually cause
    `tauri dev` / the installed app to die with "failed to create webview:
    WebView2 error: WindowsError { code: HRESULT(0x8000FFFF) ... }" and exit
    code 101 (a Rust panic, not a compile error):

      * session interactivity and elevation
      * the installed WebView2 Runtime version
      * whether this session can create a GUI window at all
      * the WebView2 user-data folder state
      * the built dev binary / installer presence

    Prints a summary of likely causes and exits 1 when it finds a problem.

.PARAMETER AppIdentifier
    The Tauri bundle identifier, used to locate the WebView2 profile folder.

.PARAMETER ResetProfile
    Delete the WebView2 user-data folder before probing. This is the standard
    fix for a corrupt profile; it only discards WebView2 cache/cookies for this
    app, never project data.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/diagnose-webview.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/diagnose-webview.ps1 -ResetProfile
#>
param(
    [string]$AppIdentifier = "com.muham.tafseer-clipper",
    [switch]$ResetProfile
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

function Section([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Ok([string]$Message) { Write-Host "  [ OK ] $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { Write-Host "  [FAIL] $Message" -ForegroundColor Red }

$problems = New-Object System.Collections.Generic.List[string]

# --- 1. session ------------------------------------------------------------ #
Section "Session"
Write-Host "  UserInteractive : $([Environment]::UserInteractive)"
Write-Host "  SessionId       : $((Get-Process -Id $PID).SessionId)"
if ($env:SESSIONNAME) { Write-Host "  Session name    : $($env:SESSIONNAME)" }
if (-not [Environment]::UserInteractive) {
    Fail "the process has no interactive desktop - WebView2 cannot create a window"
    $problems.Add("run this from an interactive desktop session, not a service/agent/CI shell")
}

# --- 2. elevation ---------------------------------------------------------- #
Section "Elevation"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($elevated) {
    Fail "running elevated - WebView2 commonly fails with 0x8000FFFF in an elevated process"
    $problems.Add("run from a NON-administrator terminal")
}
else {
    Ok "not elevated"
}

# --- 3. WebView2 runtime --------------------------------------------------- #
Section "WebView2 Runtime"
$clientKey = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$keyPaths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientKey",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientKey",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientKey"
)
$runtimeVersion = $null
foreach ($path in $keyPaths) {
    $value = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue
    if ($value -and $value.pv) {
        Ok "$path -> $($value.pv)"
        if (-not $runtimeVersion) { $runtimeVersion = $value.pv }
    }
}
if (-not $runtimeVersion) {
    Fail "the WebView2 Evergreen Runtime is not installed"
    $problems.Add("install the Microsoft Edge WebView2 Runtime (Evergreen, x64)")
}

# --- 4. GUI capability probe ----------------------------------------------- #
Section "GUI capability probe"
# Two samples on purpose: the first launch of a GUI process can spend a few
# seconds on first-run/profile work, and a single short sample produced a false
# negative while this script was being written.
function Test-GuiWindow {
    $process = $null
    try {
        $process = Start-Process notepad -PassThru -ErrorAction Stop
    }
    catch {
        return $false
    }
    $alive = $false
    foreach ($attempt in 1..16) {
        Start-Sleep -Milliseconds 500
        if (-not $process.HasExited) { $alive = $true; break }
    }
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    return $alive
}

$guiOk = Test-GuiWindow
if (-not $guiOk) { $guiOk = Test-GuiWindow }
if ($guiOk) {
    Ok "a GUI process starts and stays running - this session can create windows"
}
else {
    Warn "a GUI process exited immediately, twice - this session may block desktop windows"
    Warn "that alone can explain 'failed to create webview' with 0x8000FFFF"
    $problems.Add("this session appears unable to host a desktop window; try a normal interactive terminal")
}

# --- 5. cloud-synced checkout ---------------------------------------------- #
Section "Checkout location"
# Highest-value check on this project: a checkout under OneDrive breaks BOTH the
# PyInstaller sidecar (it cannot create its extraction dir) and WebView2 (the
# window fails with 0x8000FFFF). The same binaries work from a normal path.
$cloudMarkers = @("OneDrive", "Dropbox", "Google Drive", "iCloudDrive", "Box")
$inCloud = $null
foreach ($marker in $cloudMarkers) {
    if ($root -like "*$marker*") { $inCloud = $marker; break }
}
if ($inCloud) {
    Fail "project is inside a $inCloud-synced folder: $root"
    Fail "this alone causes 'failed to create webview ... 0x8000FFFF' and exit 101"
    $problems.Add("move the checkout outside $inCloud (e.g. C:\dev\tafseer-clipper); the installed app under %LOCALAPPDATA% is unaffected")
}
else {
    Ok "not inside a known cloud-sync folder"
}

# --- 6. WebView2 profile --------------------------------------------------- #
Section "WebView2 user-data folder"
$profileDir = Join-Path $env:LOCALAPPDATA (Join-Path $AppIdentifier "EBWebView")
if ($ResetProfile) {
    if (Test-Path -LiteralPath $profileDir) {
        Remove-Item -Recurse -Force -LiteralPath $profileDir -ErrorAction SilentlyContinue
        Warn "deleted $profileDir (-ResetProfile)"
    }
    else {
        Warn "$profileDir did not exist; nothing to reset"
    }
}
if (Test-Path -LiteralPath $profileDir) {
    $size = (Get-ChildItem -LiteralPath $profileDir -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    Write-Host ("  present: {0} ({1:N1} MB)" -f $profileDir, ($size / 1MB))
    Warn "a corrupt profile also produces 0x8000FFFF; retry with -ResetProfile"
}
else {
    Ok "no profile yet at $profileDir (WebView2 has not started successfully here)"
}

# --- 7. build artifacts ---------------------------------------------------- #
Section "Build artifacts"
$devExe = Join-Path $root "src-tauri\target\debug\tafseer-clipper.exe"
if (Test-Path -LiteralPath $devExe) {
    Ok "dev binary present: $devExe"
}
else {
    Warn "no dev binary yet (run 'pnpm tauri dev' once to build it)"
}
$installers = @(Get-ChildItem (Join-Path $root "release") -Recurse -Filter "*setup.exe" -ErrorAction SilentlyContinue)
if ($installers.Count -gt 0) {
    $newest = $installers | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Ok ("installer: {0} ({1:N1} MiB)" -f $newest.FullName, ($newest.Length / 1MB))
}
else {
    Warn "no built installer under release/"
}

# --- 8. summary ------------------------------------------------------------ #
Section "Summary"
if ($problems.Count -eq 0) {
    Write-Host "  No obvious blocker found on this machine." -ForegroundColor Green
    Write-Host "  If 'tauri dev' still panics, capture the exact HRESULT:"
    Write-Host "    `$env:RUST_BACKTRACE=1; pnpm tauri dev"
    exit 0
}
Write-Host "  Likely cause(s):" -ForegroundColor Yellow
foreach ($problem in $problems) { Write-Host "   - $problem" -ForegroundColor Yellow }
Write-Host ""
Write-Host "  Reminder: exit code 101 is a Rust panic, not a compile error." -ForegroundColor DarkGray
Write-Host "  Re-run with `$env:RUST_BACKTRACE=1 for the full trace." -ForegroundColor DarkGray
exit 1
