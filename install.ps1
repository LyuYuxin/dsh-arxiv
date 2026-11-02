# Install dsh-arxiv into a DeepSeek Harness profile.
#
# The plugin is plain source (no build step). This script installs it through
# the bundled DSH CLI and enables it in the profile's bundle list.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName web
#
# Restart the Desktop app (or the `dsh web` process) afterwards: profiles are
# composed at startup.

param(
  [string]$ProfileName = 'desktop',
  [string]$PluginDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$pluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
if (-not (Test-Path (Join-Path $pluginDir 'package.json'))) {
  throw "not a plugin directory: $pluginDir"
}

function Find-DshCli {
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -ne $cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    'D:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw 'cannot find the DSH CLI; add it to PATH or pass -ProfileName with a valid dsh command'
}

function Write-JsonFile([string]$Path, $Value) {
  $json = $Value | ConvertTo-Json -Depth 32
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $utf8)
}

$dsh = Find-DshCli
Write-Host "DSH CLI : $dsh"
Write-Host "profile : $ProfileName"
Write-Host "plugin  : $pluginDir"

# 1) Install the package into the profile (pnpm inside the profile directory).
& $dsh plugin --profile $ProfileName add "file:$pluginDir"
if ($LASTEXITCODE -ne 0) {
  throw "dsh plugin add failed (exit $LASTEXITCODE). If the profile is the desktop one, run this script from the Desktop app's bundled terminal or use the app's plugin manager."
}

# 2) Enable the package as a profile bundle, so its cordis.patch.yml row loads.
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "profile manifest not found: $manifestPath"
}
$backupPath = "$manifestPath.dsh-arxiv.bak"
if (-not (Test-Path -LiteralPath $backupPath)) {
  Copy-Item -LiteralPath $manifestPath -Destination $backupPath
  Write-Host "backed up profile manifest to $backupPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($null -eq $manifest.dependencies -or $null -eq $manifest.dependencies.'dsh-arxiv') {
  Write-Warning 'dsh-arxiv is not listed in the profile dependencies; dsh plugin add may not have completed.'
}
if ($null -eq $manifest.dsh) {
  $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $manifest.dsh.profile) {
  $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $manifest.dsh.profile.bundles) {
  $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-arxiv') {
  $bundles += 'dsh-arxiv'
  $manifest.dsh.profile.bundles = $bundles
  Write-JsonFile $manifestPath $manifest
  Write-Host 'enabled dsh-arxiv in dsh.profile.bundles'
} else {
  Write-Host 'dsh-arxiv already enabled in dsh.profile.bundles'
}

# 3) Verify the package is visible in the profile's node_modules.
$installed = Join-Path $profileDir 'node_modules\dsh-arxiv\package.json'
if (-not (Test-Path -LiteralPath $installed)) {
  Write-Warning "package.json not found under $profileDir\node_modules\dsh-arxiv - the install may be incomplete."
} else {
  Write-Host "installed: $installed"
}

Write-Host ''
Write-Host 'Done. Restart DeepSeek Harness to load the plugin,' -ForegroundColor Green
Write-Host 'then open any session and pick the "arXiv 速读" view tab.'
