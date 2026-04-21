$ErrorActionPreference = "Stop"

$packages = @(
  @{ Id = "GitHub.cli"; Name = "GitHub CLI" },
  @{ Id = "jqlang.jq"; Name = "jq" },
  @{ Id = "Gyan.FFmpeg.Essentials"; Name = "FFmpeg Essentials" },
  @{ Id = "AgileBits.1Password.CLI"; Name = "1Password CLI" }
)

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Error "winget is not available on this machine."
}

foreach ($package in $packages) {
  Write-Host ""
  Write-Host "Installing $($package.Name)..." -ForegroundColor Cyan
  winget install --id $package.Id -e --accept-package-agreements --accept-source-agreements --silent
}

Write-Host ""
Write-Host "OpenClaw Windows skill bootstrap completed." -ForegroundColor Green
Write-Host "Restart Aura Desktop so newly installed tools are detected cleanly."
