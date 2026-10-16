# 在目标 Windows（含 Hyper-V 的 Worker/控制面机）上一键部署：
# Node 检查、npm ci、PKI、SQLite 引导、PM2、隔离交换机、验收。
# 管理员 PowerShell：
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\scripts\deploy-test-platform.ps1
#   .\scripts\deploy-test-platform.ps1 -GitRemoteUrl <repository-url>

param(
  [int]$ControlPort = 8791,
  [int]$BrokerPort = 8788,
  [string]$GitRemoteUrl = $env:AWP_GIT_REMOTE_URL,
  [string]$RunnerRoot,
  [string]$SwitchName = 'awp-isolated',
  [string]$VmNetworkCidr = $env:AWP_VM_NETWORK_CIDR,
  [switch]$SkipHyperV,
  [switch]$SkipNpmCi,
  [switch]$SkipPm2,
  [switch]$SkipVerify,
  [switch]$ForcePki,
  [switch]$RotateToken,
  [switch]$RunTests,
  [switch]$InstallStartup
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
. (Join-Path $PSScriptRoot 'Deploy.Common.ps1')
. (Join-Path $PSScriptRoot 'windows\isolated-network.ps1')

Import-DevWeftDeploymentEnv -Root $Root -Optional
if (-not $PSBoundParameters.ContainsKey('ControlPort') -and $env:AWP_CONTROL_PORT) {
  Assert-DevWeftPort -Name 'AWP_CONTROL_PORT' -Value $env:AWP_CONTROL_PORT
  $ControlPort = [int]$env:AWP_CONTROL_PORT
}
if (-not $PSBoundParameters.ContainsKey('BrokerPort') -and $env:AWP_BROKER_PORT) {
  Assert-DevWeftPort -Name 'AWP_BROKER_PORT' -Value $env:AWP_BROKER_PORT
  $BrokerPort = [int]$env:AWP_BROKER_PORT
}
if ($env:AWP_GATEWAY_PORT) { Assert-DevWeftPort -Name 'AWP_GATEWAY_PORT' -Value $env:AWP_GATEWAY_PORT; $GatewayPort = [int]$env:AWP_GATEWAY_PORT }
else { $GatewayPort = 8787 }
if ($env:AWP_BLOB_PORT) { Assert-DevWeftPort -Name 'AWP_BLOB_PORT' -Value $env:AWP_BLOB_PORT; $BlobPort = [int]$env:AWP_BLOB_PORT }
else { $BlobPort = 8792 }
if (-not $PSBoundParameters.ContainsKey('SwitchName') -and $env:AWP_VM_SWITCH_NAME) { $SwitchName = $env:AWP_VM_SWITCH_NAME }
if (-not $VmNetworkCidr) { $VmNetworkCidr = if ($env:AWP_VM_NETWORK_CIDR) { $env:AWP_VM_NETWORK_CIDR } else { '192.168.250.0/24' } }
$network = Assert-PrivateIpv4Cidr $VmNetworkCidr
if (-not $RunnerRoot) {
  $RunnerRoot = if ($env:AWP_RUNNER_ROOT) { $env:AWP_RUNNER_ROOT } else { Join-Path $Root 'data\runner' }
}
$env:AWP_RUNNER_ROOT = $RunnerRoot
$BlobRoot = if ($env:AWP_BLOB_ROOT) { $env:AWP_BLOB_ROOT } else { Join-Path $Root 'data\blobs' }
$env:AWP_BLOB_ROOT = $BlobRoot
if (-not $GitRemoteUrl) { $GitRemoteUrl = $env:AWP_GIT_REMOTE_URL }
$dbDialect = if ($env:AWP_DB_DIALECT) { $env:AWP_DB_DIALECT } else { 'sqlite' }
if ($dbDialect -notin @('sqlite', 'postgres')) { throw "Unsupported AWP_DB_DIALECT: $dbDialect" }
$pgMode = if ($env:AWP_PG_MODE) { $env:AWP_PG_MODE } else { 'external' }
if ($pgMode -notin @('external', 'embedded')) { throw "Unsupported AWP_PG_MODE: $pgMode (use external or embedded)." }
if ($dbDialect -eq 'postgres' -and -not $env:AWP_PG_URL -and $pgMode -ne 'embedded') {
  throw 'Set AWP_PG_URL in data\deploy.env or select AWP_PG_MODE=embedded for a local single-host PostgreSQL instance.'
}
$ProxyIp = $network.ProxyIp
$ProxyPort = 443
$GuestCidr = $VmNetworkCidr
$BlockPorts = @($GatewayPort, $BrokerPort, $ControlPort, $BlobPort) | Sort-Object -Unique
$env:AWP_VM_SWITCH_NAME = $SwitchName
$env:AWP_VM_NETWORK_CIDR = $GuestCidr
$env:AWP_DB_DIALECT = $dbDialect
$env:AWP_STANDBY = '0'
$hyperVSetting = if ($env:AWP_HYPERV_ENABLED) { $env:AWP_HYPERV_ENABLED.Trim().ToLowerInvariant() } else { 'false' }
if ($hyperVSetting -notin @('true', 'false')) { throw 'AWP_HYPERV_ENABLED must be true or false.' }
$runnerBackend = if ($env:AWP_RUNNER_BACKEND) { $env:AWP_RUNNER_BACKEND.Trim().ToLowerInvariant() } else { 'hyperv' }
if ($runnerBackend -notin @('hyperv', 'local')) { throw 'AWP_RUNNER_BACKEND must be hyperv or local.' }
$HyperVEnabled = ($hyperVSetting -eq 'true') -and (-not $SkipHyperV)
$SkipHyperV = -not $HyperVEnabled
$env:AWP_HYPERV_ENABLED = $HyperVEnabled.ToString().ToLowerInvariant()

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

function Test-IsAdmin {
  $wid = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($wid)
  return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Native([string]$File, [string[]]$NativeArgs) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $File @NativeArgs | Out-Host
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  if ($null -eq $code) { $code = 0 }
  return [int]$code
}

function Protect-SecretFile([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  icacls $Path /inheritance:r /grant:r "${user}:(R)" | Out-Null
  $ErrorActionPreference = $old
}

function Write-DeployEnv([string]$Path, [string[]]$ManagedLines) {
  $managedNames = @($ManagedLines | ForEach-Object { ($_ -split '=', 2)[0] })
  $preserved = @()
  if (Test-Path $Path) {
    $preserved = @(Get-Content -LiteralPath $Path | Where-Object {
      if ($_ -match '^\s*([^#\s][^=]*)=') { $managedNames -notcontains $Matches[1].Trim() } else { $true }
    })
  }
  Set-Content -LiteralPath $Path -Value (@($preserved) + @($ManagedLines)) -Encoding ascii
}

function Stop-RepoNode {
  Write-Step '释放本仓库 Node 占用（避免 npm ci EPERM）'
  if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    cmd /c "pm2 delete devweft awp-secret-broker awp-host-worker >nul 2>&1" | Out-Null
  }
  $rootNorm = $Root.ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = [string]$_.CommandLine
    $exe = [string]$_.ExecutablePath
    if (($cmd.ToLowerInvariant().Contains($rootNorm) -or $exe.ToLowerInvariant().Contains($rootNorm)) -and $_.ProcessId -ne $PID) {
      Write-Host "stop node pid=$($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 1
}

function Test-TcpListen([string]$TargetHost, [int]$ListenPort, [int]$TimeoutMs = 800) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($TargetHost, $ListenPort, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

$isAdmin = Test-IsAdmin
$startedAt = Get-Date
$preflight = [ordered]@{
  computerName      = $env:COMPUTERNAME
  admin             = $isAdmin
  node              = $null
  git               = $null
  hypervisorPresent = $null
}

Write-Step '预检'
try {
  $preflight.hypervisorPresent = [bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent
} catch {
  $preflight.hypervisorPresent = $false
}
Write-Host "HypervisorPresent=$($preflight.hypervisorPresent)"
if ($HyperVEnabled) {
  if (-not $isAdmin) { throw 'AWP_HYPERV_ENABLED=true requires an elevated PowerShell. Set it to false for a control-plane-only deployment.' }
  if (-not $preflight.hypervisorPresent) { throw 'AWP_HYPERV_ENABLED=true but Hyper-V is not active. Enable Hyper-V, restart Windows, then rerun deployment.' }
  Write-Step 'Hyper-V network read-only preflight'
  $networkArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'windows\ensure-isolated-network.ps1'),
    '-SwitchName', $SwitchName, '-ProxyIp', $ProxyIp, '-ProxyPort', "$ProxyPort",
    '-GuestCidr', $GuestCidr, '-PreflightOnly', '-BlockPorts'
  ) + @($BlockPorts | ForEach-Object { "$_" })
  $code = Invoke-Native 'powershell' $networkArgs
  if ($code -ne 0) { throw "Hyper-V network preflight failed exit $code. Resolve the conflict and retry; no network changes were made." }
} else {
  Write-Host 'Hyper-V worker is disabled (AWP_HYPERV_ENABLED=false). Control-plane services can run without a Windows VM image.' -ForegroundColor Yellow
}

Assert-DevWeftRuntime
$nodeCmd = Get-Command node -ErrorAction Stop
$ver = (& node -p 'process.versions.node').Trim()
$preflight.node = "v$ver"
Write-Host "node v$ver  ($($nodeCmd.Source))"
Invoke-Native 'node' @('.\scripts\ensure-ps1-utf8bom.mjs') | Out-Null

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) { throw '需要 git 在 PATH 中（snapshot / bootstrap remote 探测）' }
$preflight.git = (& git --version).Trim()
Write-Host $preflight.git

if (-not (Test-Path (Join-Path $Root 'package-lock.json'))) {
  throw '缺少 package-lock.json，无法 npm ci'
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\logs') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\blobs') | Out-Null

Stop-RepoNode

$lockFile = Join-Path $Root 'package-lock.json'
$stamp = Join-Path $Root 'data\.npm-ci.sha256'
$sqliteNode = Join-Path $Root 'node_modules\better-sqlite3\package.json'
$embeddedPostgresPackage = Join-Path $Root 'node_modules\@embedded-postgres\windows-x64\package.json'
$lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash
$dependenciesReady = Test-Path $sqliteNode
if ($dbDialect -eq 'postgres' -and $pgMode -eq 'embedded') { $dependenciesReady = $dependenciesReady -and (Test-Path $embeddedPostgresPackage) }
if (-not $SkipNpmCi -and $dependenciesReady -and (Test-Path $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $lockHash)) {
  Write-Step 'npm ci'
  Write-Host 'skip npm ci (lockfile unchanged)'
  $SkipNpmCi = $true
}

if (-not $SkipNpmCi) {
  Write-Step 'npm ci'
  $npmArgs = @('ci')
  if ($dbDialect -eq 'postgres' -and $pgMode -eq 'embedded') { $npmArgs += @('--include=dev') }
  $code = Invoke-Native 'npm' $npmArgs
  if ($code -ne 0) { throw "npm ci failed exit $code。先关掉占用本目录的 node/PM2/MCP client，再重跑。" }
  Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ascii
}

if ($dbDialect -eq 'postgres' -and $pgMode -eq 'embedded') {
  Write-Step '本机 PostgreSQL 初始化（仅单机模式）'
  $setupArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'setup-local-postgres.ps1'),
    '-Root', $Root
  )
  if ($env:AWP_PG_DATA_DIR) { $setupArgs += @('-DataDirectory', $env:AWP_PG_DATA_DIR) }
  if ($env:AWP_PG_PORT) { $setupArgs += @('-Port', $env:AWP_PG_PORT) }
  if ($env:AWP_PG_DATABASE) { $setupArgs += @('-DatabaseName', $env:AWP_PG_DATABASE) }
  $code = Invoke-Native 'powershell' $setupArgs
  if ($code -ne 0) { throw "Local PostgreSQL setup failed exit $code." }
  Import-DevWeftDeploymentEnv -Root $Root -Optional
  $env:AWP_DB_DIALECT = 'postgres'
  $env:AWP_RUNNER_ROOT = $RunnerRoot
}
if ($dbDialect -eq 'postgres') {
  Write-Step 'PostgreSQL schema and permissions preflight'
  $code = Invoke-Native 'node' @('.\scripts\verify-postgres-deploy.mjs', '--schema-only')
  if ($code -ne 0) { throw 'PostgreSQL is not ready for application migrations. Review the preflight message and database setup guide.' }
  Write-Step 'PostgreSQL baseline registration and migrations'
  $code = Invoke-Native 'node' @('.\scripts\init-postgres.mjs')
  if ($code -ne 0) { throw 'PostgreSQL schema initialization failed. Review the error and the database setup guide.' }
  Write-Step 'PostgreSQL final preflight'
  $code = Invoke-Native 'node' @('.\scripts\verify-postgres-deploy.mjs')
  if ($code -ne 0) { throw 'PostgreSQL is not deployment-ready. Review the preflight message and PostgreSQL setup guide.' }
}

Write-Step '开发用 mTLS 证书（secret-broker/dev-certs）'
$trust = Join-Path $Root 'secret-broker\dev-certs\trust.json'
if ($ForcePki -and (Test-Path (Join-Path $Root 'secret-broker\dev-certs'))) {
  Write-Host 'ForcePki：重建证书目录'
  Remove-Item -Recurse -Force (Join-Path $Root 'secret-broker\dev-certs')
}
if (-not (Test-Path $trust)) {
  $mjs = Join-Path $PSScriptRoot 'gen-dev-pki.mjs'
  $node = (Get-Command node).Source
  $p = Start-Process -FilePath $node -ArgumentList @($mjs) -WorkingDirectory $Root -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ne 0) { throw "gen-dev-pki failed exit $($p.ExitCode)" }
} else {
  Write-Host "reuse $trust"
}
Get-ChildItem (Join-Path $Root 'secret-broker\dev-certs\*.key') | ForEach-Object { Protect-SecretFile $_.FullName }

Write-Step 'Database initialization + bootstrap-admin'
$env:AWP_CONTROL_PORT = "$ControlPort"
$env:AWP_BROKER_PORT = "$BrokerPort"
$env:AWP_RUNNER_ROOT = $RunnerRoot
if ($GitRemoteUrl) { $env:AWP_GIT_REMOTE_URL = $GitRemoteUrl }

$code = Invoke-Native 'node' @('db.js')
if ($code -ne 0) { throw "initDB failed exit $code" }

$bootArgs = @('.\scripts\bootstrap-test-platform.mjs')
if ($RotateToken) { $bootArgs += '--rotate' }
$code = Invoke-Native 'node' $bootArgs
if ($code -ne 0) { throw "bootstrap failed exit $code" }
Protect-SecretFile (Join-Path $Root 'data\bootstrap-admin.token')
$envLines = @(
  "AWP_DB_DIALECT=$dbDialect",
  "AWP_PG_MODE=$pgMode",
  "AWP_CONTROL_PORT=$ControlPort",
  "AWP_GATEWAY_PORT=$GatewayPort",
  "AWP_BLOB_PORT=$BlobPort",
  "AWP_BLOB_ROOT=$BlobRoot",
  "AWP_BROKER_PORT=$BrokerPort",
  "AWP_RUNNER_ROOT=$RunnerRoot",
  "AWP_VM_SWITCH_NAME=$SwitchName",
  "AWP_VM_NETWORK_CIDR=$GuestCidr",
  "AWP_HYPERV_ENABLED=$hyperVSetting",
  "AWP_RUNNER_BACKEND=$runnerBackend"
)
if ($dbDialect -eq 'postgres') { $envLines += "AWP_PG_URL=$env:AWP_PG_URL" }
if ($env:AWP_PG_DATA_DIR) { $envLines += "AWP_PG_DATA_DIR=$env:AWP_PG_DATA_DIR" }
if ($env:AWP_PG_PORT) { $envLines += "AWP_PG_PORT=$env:AWP_PG_PORT" }
if ($env:AWP_PG_DATABASE) { $envLines += "AWP_PG_DATABASE=$env:AWP_PG_DATABASE" }
if ($GitRemoteUrl) { $envLines += "AWP_GIT_REMOTE_URL=$GitRemoteUrl" }
Write-DeployEnv (Join-Path $Root 'data\deploy.env') $envLines
if ($dbDialect -eq 'postgres') {
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $configPath = Join-Path $Root 'data\deploy.env'
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  icacls $configPath /inheritance:r /grant:r "${user}:(M)" | Out-Null
  $ErrorActionPreference = $old
}

if ($HyperVEnabled) {
  Write-Step 'Verify signed Golden runner image before host changes'
  $goldenPath = Join-Path $RunnerRoot 'images\golden.vhdx'
  $code = Invoke-Native 'node' @('.\scripts\verify-runner-image.mjs', '--vhdx', $goldenPath)
  if ($code -ne 0) { throw 'Runner image validation failed. Publish and activate a signed VHDX/SBOM before enabling the Hyper-V worker.' }

  Write-Step 'Hyper-V runner files and isolated network'
  foreach ($p in @("$RunnerRoot\images", "$RunnerRoot\attempts", "$RunnerRoot\scratch", "$RunnerRoot\certs")) {
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    Write-Host "OK $p"
  }
  $srcCerts = Join-Path $Root 'secret-broker\dev-certs'
  foreach ($n in @('ca.crt', 'worker.crt', 'worker.key', 'worker-id.txt', 'trust.json')) {
    $src = Join-Path $srcCerts $n
    $dst = Join-Path "$RunnerRoot\certs" $n
    if (-not (Test-Path $src)) { throw "Missing runner certificate source: $src" }
    if (Test-Path $dst) {
      $sourceHash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
      $targetHash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
      if ($sourceHash -ne $targetHash) { throw "RUNNER_CERT_CONFLICT: $dst already contains different data and was preserved. Back it up and reconcile certificates manually before retrying." }
      Write-Host "reuse $dst"
    } else {
      Copy-Item -LiteralPath $src -Destination $dst
      Write-Host "created $dst"
    }
  }
  Protect-SecretFile (Join-Path $RunnerRoot 'certs\worker.key')

  Write-Host "Configure isolated network: switch=$SwitchName host=$ProxyIp guest=$GuestCidr proxyPort=$ProxyPort"
  $networkArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'windows\ensure-isolated-network.ps1'),
    '-SwitchName', $SwitchName, '-ProxyIp', $ProxyIp, '-ProxyPort', "$ProxyPort",
    '-GuestCidr', $GuestCidr, '-BlockPorts'
  ) + @($BlockPorts | ForEach-Object { "$_" })
  $code = Invoke-Native 'powershell' $networkArgs
  if ($code -ne 0) { throw "Isolated Hyper-V network setup failed exit $code." }
}

if ($RunTests) {
  Write-Step 'vitest'
  $code = Invoke-Native 'npx' @('vitest', 'run')
  if ($code -ne 0) { throw "vitest failed exit $code" }
}

if (-not $SkipPm2) {
  Write-Step 'PM2 启动控制面 + secret broker'
  $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
  if (-not $pm2) {
    $code = Invoke-Native 'npm' @('install', '-g', 'pm2')
    if ($code -ne 0) { throw "npm install -g pm2 failed exit $code" }
    $pm2 = Get-Command pm2 -ErrorAction Stop
  }
  $env:AWP_CONTROL_PORT = "$ControlPort"
  $env:AWP_GATEWAY_PORT = "$GatewayPort"
  $env:AWP_BLOB_PORT = "$BlobPort"
  $env:AWP_BLOB_ROOT = $BlobRoot
  $env:AWP_BROKER_PORT = "$BrokerPort"
  $env:AWP_BROKER_DB = Join-Path $Root 'data\secret-broker.db'
  $env:AWP_BROKER_TLS_CERT = Join-Path $Root 'secret-broker\dev-certs\broker.crt'
  $env:AWP_BROKER_TLS_KEY = Join-Path $Root 'secret-broker\dev-certs\broker.key'
  $env:AWP_BROKER_TLS_CA = Join-Path $Root 'secret-broker\dev-certs\ca.crt'
  $env:AWP_BROKER_TRUST_FILE = Join-Path $Root 'secret-broker\dev-certs\trust.json'

  Invoke-Native 'pm2' @('delete', 'devweft') | Out-Null
  Invoke-Native 'pm2' @('delete', 'awp-secret-broker') | Out-Null
  if (-not $HyperVEnabled) { Invoke-Native 'pm2' @('delete', 'awp-host-worker') | Out-Null }
  $code = Invoke-Native 'pm2' @('start', (Join-Path $Root 'ecosystem.config.cjs'), '--update-env')
  if ($code -ne 0) { throw "pm2 start failed exit $code" }
  Invoke-Native 'pm2' @('save') | Out-Null

  if ($InstallStartup -and $isAdmin) {
    Write-Host '注册开机任务 AWP-PM2-Resurrect'
    $pm2Path = (Get-Command pm2).Source
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$pm2Path`" resurrect" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName 'AWP-PM2-Resurrect' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
  }
}

Write-Step '等待服务就绪'
$ok = $false
$lastHealth = $null
$lastBroker = $false
for ($i = 1; $i -le 45; $i++) {
  Start-Sleep -Seconds 1
  $lastBroker = Test-TcpListen '127.0.0.1' $BrokerPort
  try {
    $lastHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$ControlPort/api/health" -TimeoutSec 2
  } catch {
    $lastHealth = $null
  }
  if ($lastHealth -and $lastHealth.ok -and $lastBroker) {
    Write-Host ($lastHealth | ConvertTo-Json -Compress)
    $ok = $true
    break
  }
  Write-Host ("  … 未就绪 ($i/45) health={0} broker:{1}={2}" -f $(if ($lastHealth -and $lastHealth.ok) { 'ok' } else { 'down' }), $BrokerPort, $lastBroker)
}
if (-not $ok -and -not $SkipPm2) {
  Write-Host 'pm2 status:' ; Invoke-Native 'pm2' @('status') | Out-Null
  Write-Host 'broker error log (tail):'
  $brokerLog = Join-Path $Root 'data\logs\broker-error.log'
  $brokerOut = Join-Path $Root 'data\logs\broker-out.log'
  if (Test-Path $brokerLog) { Get-Content $brokerLog -Tail 30 }
  if (Test-Path $brokerOut) { Get-Content $brokerOut -Tail 30 }
  throw "服务未就绪。health=$([bool]($lastHealth -and $lastHealth.ok)) broker=$lastBroker 。查看 data\logs 或 pm2 logs"
}

$reportedPgMode = if ($dbDialect -eq 'postgres') { $pgMode } else { $null }
$hyperVConfigured = $HyperVEnabled
$goldenImagePresent = Test-Path (Join-Path $RunnerRoot 'images\golden.vhdx')
$status = [ordered]@{
  ok           = $true
  at           = (Get-Date).ToString('o')
  elapsedSec   = [int]((Get-Date) - $startedAt).TotalSeconds
  preflight    = $preflight
  database     = @{ dialect = $dbDialect; postgresMode = $reportedPgMode }
  port         = $ControlPort
  brokerPort   = $BrokerPort
  runnerRoot   = $RunnerRoot
  switchName   = $SwitchName
  hyperVWorker = @{ configured = $hyperVConfigured; goldenImagePresent = $goldenImagePresent }
  gitRemoteUrl = $GitRemoteUrl
}
$statusPath = Join-Path $Root 'data\deploy-status.json'
($status | ConvertTo-Json -Depth 6) | Set-Content -Path $statusPath -Encoding utf8

if (-not $SkipVerify -and -not $SkipPm2) {
  Write-Step '部署验收'
  $verifyArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'verify-test-platform.ps1'),
    '-Port', "$ControlPort", '-BrokerPort', "$BrokerPort", '-GatewayPort', "$GatewayPort", '-BlobPort', "$BlobPort",
    '-RunnerRoot', $RunnerRoot, '-SwitchName', $SwitchName
  )
  if (-not $HyperVEnabled) { $verifyArgs += '-SkipHyperV' }
  $code = Invoke-Native 'powershell' $verifyArgs
  if ($code -ne 0) { throw "verify-test-platform failed exit $code" }
}

$tokenFile = Join-Path $Root 'data\bootstrap-admin.token'
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  DEPLOY OK" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "看板:     http://127.0.0.1:$ControlPort/dashboard.html"
Write-Host "健康:     http://127.0.0.1:$ControlPort/api/health"
Write-Host "测试 API: http://127.0.0.1:$ControlPort/v1/git-contexts:resolve"
Write-Host "Broker:   https://127.0.0.1:$BrokerPort  (mTLS, localhost only)"
Write-Host "Status:   $statusPath"
if (Test-Path $tokenFile) { Write-Host "Admin token file: $tokenFile  (do not commit)" }
Write-Host ''
Write-Host 'Optional next steps:'
Write-Host "  验收复查:       .\scripts\verify-test-platform.ps1"
Write-Host "  Golden VHDX:    $RunnerRoot\images\golden.vhdx"
