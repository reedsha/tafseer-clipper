# Authenticode signing hook for the Tauri bundler (Windows).
#
# Tauri invokes this through `bundle.windows.signCommand` with `%1` replaced by
# the installer path, so the bundler fails loudly if signing fails. Signing is
# OPTIONAL for local/dev builds and REQUIRED for a public release:
#
#   * Locally: no certificate configured -> warn and leave the installer
#     unsigned (Windows SmartScreen will warn users; never publish such a file).
#   * CI/release: set REQUIRE_CODE_SIGNING=1 together with one of
#       - AZURE_TRUSTED_SIGNING_ENDPOINT + AZURE_TRUSTED_SIGNING_ACCOUNT +
#         AZURE_TRUSTED_SIGNING_PROFILE  (Azure Trusted Signing, recommended), or
#       - WINDOWS_CERT_PFX + WINDOWS_CERT_PASSWORD   (PFX file), or
#       - SIGNTOOL_PATH + WINDOWS_CERT_THUMBPRINT    (certificate in the store).
#     A missing/incomplete configuration then fails the build instead of
#     silently shipping an unsigned installer.
#
# Usage (Tauri calls it automatically):
#   powershell -NoProfile -ExecutionPolicy Bypass -File sign-windows.ps1 "<installer.exe>"

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

$ErrorActionPreference = "Stop"

# Tauri passes the path possibly quoted; PowerShell usually strips the quotes,
# but be defensive when the command is invoked through cmd.exe.
$FilePath = $FilePath.Trim('"')
if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-Error "sign-windows.ps1: file not found: $FilePath"
    exit 1
}

$requireSigning = ($env:REQUIRE_CODE_SIGNING -eq "1") -or ($env:REQUIRE_CODE_SIGNING -eq "true")

function Find-SignTool {
    if ($env:SIGNTOOL_PATH -and (Test-Path -LiteralPath $env:SIGNTOOL_PATH)) {
        return $env:SIGNTOOL_PATH
    }
    $candidates = @(
        (Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
        "$env:ProgramFiles (x86)\Windows Kits\10\bin\x64\signtool.exe",
        "$env:ProgramFiles\Windows Kits\10\bin\x64\signtool.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    if ($candidates.Count -gt 0) { return $candidates[0] }

    $sdkRoot = "$env:ProgramFiles (x86)\Windows Kits\10\bin"
    if (Test-Path -LiteralPath $sdkRoot) {
        $found = Get-ChildItem -Path $sdkRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

function Invoke-AzureTrustedSigning([string]$Path) {
    # Azure Trusted Signing uses the `TrustedSigning` dotnet tool (or the
    # `signtool` dlib hook). CI is expected to install it and expose these env
    # vars; see docs/RELEASING.md.
    $signTool = Find-SignTool
    if (-not $signTool) { throw "signtool.exe not found (Azure Trusted Signing needs the Windows SDK)." }
    & $signTool sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
        /dlib "$env:AZURE_TRUSTED_SIGNING_DLIB" /dmdf "$env:AZURE_TRUSTED_SIGNING_METADATA" $Path
    if ($LASTEXITCODE -ne 0) { throw "Azure Trusted Signing failed with exit code $LASTEXITCODE." }
}

function Invoke-PfxSigning([string]$Path) {
    $signTool = Find-SignTool
    if (-not $signTool) { throw "signtool.exe not found (install the Windows 10/11 SDK or set SIGNTOOL_PATH)." }
    & $signTool sign /v /fd SHA256 /tr "http://timestamp.digicert.com" /td SHA256 `
        /f "$env:WINDOWS_CERT_PFX" /p "$env:WINDOWS_CERT_PASSWORD" $Path
    if ($LASTEXITCODE -ne 0) { throw "PFX code signing failed with exit code $LASTEXITCODE." }
}

function Invoke-StoreSigning([string]$Path) {
    $signTool = Find-SignTool
    if (-not $signTool) { throw "signtool.exe not found (install the Windows 10/11 SDK or set SIGNTOOL_PATH)." }
    & $signTool sign /v /fd SHA256 /tr "http://timestamp.digicert.com" /td SHA256 `
        /sha1 "$env:WINDOWS_CERT_THUMBPRINT" $Path
    if ($LASTEXITCODE -ne 0) { throw "Certificate-store code signing failed with exit code $LASTEXITCODE." }
}

try {
    if ($env:AZURE_TRUSTED_SIGNING_METADATA -and $env:AZURE_TRUSTED_SIGNING_DLIB) {
        Invoke-AzureTrustedSigning $FilePath
    }
    elseif ($env:WINDOWS_CERT_PFX) {
        Invoke-PfxSigning $FilePath
    }
    elseif ($env:WINDOWS_CERT_THUMBPRINT) {
        Invoke-StoreSigning $FilePath
    }
    elseif ($requireSigning) {
        throw "REQUIRE_CODE_SIGNING is set but no signing credentials are configured (Azure Trusted Signing, WINDOWS_CERT_PFX, or WINDOWS_CERT_THUMBPRINT)."
    }
    else {
        Write-Warning "No code-signing credentials configured - '$FilePath' will be UNSIGNED. Set REQUIRE_CODE_SIGNING=1 and the signing secrets before publishing."
    }
    exit 0
}
catch {
    Write-Error "sign-windows.ps1: $($_.Exception.Message)"
    exit 1
}
