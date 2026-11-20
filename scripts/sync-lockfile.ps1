param(
  [switch]$Check
)

$manifest = "src-tauri/Cargo.toml"
Push-Location (Resolve-Path "$PSScriptRoot/..")
try {
  cargo check --manifest-path $manifest --locked 2>&1 | Out-Host
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Cargo.lock is in sync with Cargo.toml."
    exit 0
  }
  if ($Check) {
    Write-Error "Cargo.lock is out of sync with Cargo.toml."
    exit 1
  }
  cargo check --manifest-path $manifest
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "Cargo.lock regenerated. Review and commit the changes."
} finally {
  Pop-Location
}