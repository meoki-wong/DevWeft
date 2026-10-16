# Prepare a Windows host and run the platform deployment without application-specific repositories.
param(
  [string]$GitRemoteUrl = $env:AWP_GIT_REMOTE_URL,
  [switch]$SkipHyperV,
  [switch]$InstallStartup,
  [switch]$RunTests
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
. (Join-Path $PSScriptRoot 'Deploy.Common.ps1')
Import-DevWeftDeploymentEnv -Root $Root -Optional
if (-not $GitRemoteUrl) { $GitRemoteUrl = $env:AWP_GIT_REMOTE_URL }

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
}

function Invoke-WingetInstall([string]$PackageId) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is unavailable. Install $PackageId manually, then rerun deploy.cmd."
  }
  & winget install --id $PackageId --exact --upgrade --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget could not install or upgrade $PackageId." }
  Refresh-Path
}

Write-Host 'Checking prerequisites...'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'Git is missing; installing Git for Windows with winget.'
  Invoke-WingetInstall 'Git.Git'
}

$nodeReady = $false
try { Assert-DevWeftRuntime; $nodeReady = $true } catch { }
if (-not $nodeReady) {
  Write-Host 'A supported Node.js/npm installation is missing; installing the current Node.js LTS with winget.'
  Invoke-WingetInstall 'OpenJS.NodeJS.LTS'
  Assert-DevWeftRuntime
}
Assert-DevWeftRuntime -RequireGit

$hyperVSetting = if ($env:AWP_HYPERV_ENABLED) { $env:AWP_HYPERV_ENABLED.Trim().ToLowerInvariant() } else { 'false' }
if ($hyperVSetting -notin @('true', 'false')) { throw 'AWP_HYPERV_ENABLED must be true or false.' }
$hyperVEnabled = ($hyperVSetting -eq 'true') -and (-not $SkipHyperV)
$skipHyperVThisRun = -not $hyperVEnabled
$hyperVNeedsRestart = $false
if ($hyperVEnabled) {
  Write-Host 'Checking optional Hyper-V worker prerequisites...'
  $os = Get-CimInstance Win32_OperatingSystem
  $feature = $null
  try {
    if ($os.Caption -match 'Server') {
      if (Get-Command Get-WindowsFeature -ErrorAction SilentlyContinue) {
        $feature = Get-WindowsFeature -Name Hyper-V -ErrorAction Stop
        if ($feature.InstallState -ne 'Installed') {
          $result = Install-WindowsFeature -Name Hyper-V -IncludeManagementTools -ErrorAction Stop
          $hyperVNeedsRestart = $true
        }
      }
    } else {
      $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction Stop
      if ($feature.State -ne 'Enabled') {
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart -ErrorAction Stop | Out-Null
        $hyperVNeedsRestart = $true
      }
    }
  } catch {
    throw "AWP_HYPERV_ENABLED=true but Hyper-V is unavailable or could not be enabled on this Windows edition: $($_.Exception.Message). Set AWP_HYPERV_ENABLED=false for control-plane-only deployment."
  }
  if ($hyperVNeedsRestart) {
    Write-Host 'Hyper-V has been enabled; restart Windows, then rerun deploy.cmd to configure the isolated switch and worker host.' -ForegroundColor Yellow
    $skipHyperVThisRun = $true
  } elseif (-not $feature -and -not $hyperVNeedsRestart) {
    throw 'AWP_HYPERV_ENABLED=true but the Hyper-V management feature was not found. Set AWP_HYPERV_ENABLED=false for control-plane-only deployment.'
  } else {
    Write-Host 'Hyper-V feature is available; the deployment will configure the worker network if the hypervisor is active.' -ForegroundColor Green
  }
} else {
  Write-Host 'Hyper-V is optional and disabled. Set AWP_HYPERV_ENABLED=true after preparing a signed runner image to enable the VM worker.'
}

$deployEnv = Join-Path $Root 'data\deploy.env'
if (-not (Test-Path $deployEnv)) {
  Copy-Item -LiteralPath (Join-Path $Root 'data\deploy.env.example') -Destination $deployEnv
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'preflight.ps1') -Profile deploy
if ($LASTEXITCODE -ne 0) { throw 'Deployment preflight failed. Review the profile and prerequisite errors above.' }

$deployArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'deploy-test-platform.ps1'))
if ($GitRemoteUrl) { $deployArgs += @('-GitRemoteUrl', $GitRemoteUrl) }
if ($skipHyperVThisRun) { $deployArgs += '-SkipHyperV' }
if ($InstallStartup) { $deployArgs += '-InstallStartup' }
if ($RunTests) { $deployArgs += '-RunTests' }

Write-Host 'Starting full platform deployment...'
& powershell.exe @deployArgs
if ($LASTEXITCODE -ne 0) { throw "Platform deployment failed with exit code $LASTEXITCODE." }
if ($hyperVNeedsRestart) { Write-Host 'Control plane deployed. Restart Windows and run deploy.cmd again to finish Hyper-V worker setup.' -ForegroundColor Yellow }
Write-Host 'First deployment completed.' -ForegroundColor Green
