$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
. (Join-Path $PSScriptRoot 'Deploy.Common.ps1')
Import-DevWeftDeploymentEnv -Root $Root -Optional

$hyperVSetting = if ($env:AWP_HYPERV_ENABLED) { $env:AWP_HYPERV_ENABLED.Trim().ToLowerInvariant() } else { 'false' }
$runnerBackend = if ($env:AWP_RUNNER_BACKEND) { $env:AWP_RUNNER_BACKEND.Trim().ToLowerInvariant() } else { 'hyperv' }
if ($runnerBackend -notin @('hyperv', 'local')) { throw 'AWP_RUNNER_BACKEND must be hyperv or local.' }
if ($runnerBackend -eq 'hyperv' -and $hyperVSetting -ne 'true') { throw 'Enable Hyper-V in data\deploy.env or set AWP_RUNNER_BACKEND=local.' }
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { throw 'PM2 is missing. Run deploy.cmd first.' }
if ($runnerBackend -eq 'hyperv') {
  $runnerRoot = if ($env:AWP_RUNNER_ROOT) { $env:AWP_RUNNER_ROOT } else { Join-Path $Root 'data\runner' }
  $golden = if ($env:AWP_GOLDEN_VHDX) { $env:AWP_GOLDEN_VHDX } else { Join-Path $runnerRoot 'images\golden.vhdx' }
  & node (Join-Path $Root 'scripts\verify-runner-image.mjs') '--vhdx' $golden
  if ($LASTEXITCODE -ne 0) { throw 'Runner image verification failed; worker restart cancelled.' }

  $gatewayPort = if ($env:AWP_GATEWAY_PORT) { $env:AWP_GATEWAY_PORT } else { '8787' }
  $brokerPort = if ($env:AWP_BROKER_PORT) { $env:AWP_BROKER_PORT } else { '8788' }
  $controlPort = if ($env:AWP_CONTROL_PORT) { $env:AWP_CONTROL_PORT } else { '8791' }
  $blobPort = if ($env:AWP_BLOB_PORT) { $env:AWP_BLOB_PORT } else { '8792' }
  $networkArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'windows\ensure-isolated-network.ps1'),
    '-BlockPorts', $gatewayPort, $brokerPort, $controlPort, $blobPort)
  & powershell.exe @networkArgs
  if ($LASTEXITCODE -ne 0) { throw 'Isolated network setup failed; worker restart cancelled.' }
}

$workerId = (& pm2 id awp-host-worker 2>$null | Out-String).Trim()
if ($workerId -match '^\d+$') { & pm2 restart awp-host-worker --update-env }
else { & pm2 start (Join-Path $Root 'ecosystem.config.cjs') --only awp-host-worker --update-env }
if ($LASTEXITCODE -ne 0) { throw "PM2 could not restart awp-host-worker (exit code $LASTEXITCODE)." }
Start-Sleep 3
& pm2 ls
