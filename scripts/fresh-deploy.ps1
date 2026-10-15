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

$nodeMajor = 0
try {
  $nodeVersionText = ((& node -v) -replace '^v', '')
  $nodeMajor = [int]$nodeVersionText.Split('.')[0]
} catch { }
if ($nodeMajor -lt 22) {
  Write-Host 'Node.js 22+ is missing; installing the current Node.js LTS with winget.'
  Invoke-WingetInstall 'OpenJS.NodeJS.LTS'
  try {
    $nodeVersionText = ((& node -v) -replace '^v', '')
    $nodeMajor = [int]$nodeVersionText.Split('.')[0]
  } catch { $nodeMajor = 0 }
}
if ($nodeMajor -lt 22) { throw 'Node.js 22+ is still unavailable. Restart the terminal or install it from nodejs.org, then rerun deploy.cmd.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is missing from PATH. Repair the Node.js installation, then rerun deploy.cmd.' }

$skipHyperVThisRun = [bool]$SkipHyperV
$hyperVNeedsRestart = $false
if (-not $skipHyperVThisRun) {
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
    Write-Host "Hyper-V is unavailable or could not be enabled on this Windows edition: $($_.Exception.Message)" -ForegroundColor Yellow
    $skipHyperVThisRun = $true
  }
  if ($hyperVNeedsRestart) {
    Write-Host 'Hyper-V has been enabled; restart Windows, then rerun deploy.cmd to configure the isolated switch and worker host.' -ForegroundColor Yellow
    $skipHyperVThisRun = $true
  } elseif (-not $feature -and -not $hyperVNeedsRestart) {
    Write-Host 'Hyper-V management feature was not found. Deploying the control plane without the optional VM worker.' -ForegroundColor Yellow
    $skipHyperVThisRun = $true
  } else {
    Write-Host 'Hyper-V feature is available; the deployment will configure the worker network if the hypervisor is active.' -ForegroundColor Green
  }
}

$deployEnv = Join-Path $Root 'scripts\deploy.env'
if (-not (Test-Path $deployEnv)) {
  Copy-Item -LiteralPath (Join-Path $Root 'scripts\deploy.env.example') -Destination $deployEnv
}

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
