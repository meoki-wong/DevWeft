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

function Import-DeployEnv([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { return }
    $name = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    Set-Item -Path "Env:$name" -Value $val
  }
}

Import-DeployEnv (Join-Path $Root 'data\deploy.env')
Import-DeployEnv (Join-Path $Root 'scripts\deploy.env')
if (-not $PSBoundParameters.ContainsKey('SwitchName') -and $env:AWP_VM_SWITCH_NAME) { $SwitchName = $env:AWP_VM_SWITCH_NAME }
if (-not $RunnerRoot) {
  $RunnerRoot = if ($env:AWP_RUNNER_ROOT) { $env:AWP_RUNNER_ROOT } else { Join-Path $Root 'data\runner' }
}
$env:AWP_RUNNER_ROOT = $RunnerRoot
if (-not $GitRemoteUrl) { $GitRemoteUrl = $env:AWP_GIT_REMOTE_URL }
$dbDialect = if ($env:AWP_DB_DIALECT) { $env:AWP_DB_DIALECT } else { 'sqlite' }
if ($dbDialect -notin @('sqlite', 'postgres')) { throw "Unsupported AWP_DB_DIALECT: $dbDialect" }
$pgMode = if ($env:AWP_PG_MODE) { $env:AWP_PG_MODE } else { 'external' }
if ($pgMode -notin @('external', 'embedded')) { throw "Unsupported AWP_PG_MODE: $pgMode (use external or embedded)." }
if ($dbDialect -eq 'postgres' -and -not $env:AWP_PG_URL -and $pgMode -ne 'embedded') {
  throw 'Set AWP_PG_URL in scripts\deploy.env or select AWP_PG_MODE=embedded for a local single-host PostgreSQL instance.'
}
$ProxyIp = '192.168.250.1'
$ProxyPort = 443
$GuestCidr = '192.168.250.0/24'
$BlockPorts = @(8787, 8788, 8791, 8792)
$env:AWP_VM_SWITCH_NAME = $SwitchName
$env:AWP_DB_DIALECT = $dbDialect

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

function Unlock-SecretFile([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  icacls $Path /grant "${user}:(F)" | Out-Null
  attrib -R $Path | Out-Null
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  $ErrorActionPreference = $old
}

function Stop-RepoNode {
  Write-Step '释放本仓库 Node 占用（避免 npm ci EPERM）'
  if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    cmd /c "pm2 delete devweft awp-secret-broker >nul 2>&1" | Out-Null
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
if (-not $isAdmin) {
  Write-Host '当前非管理员：控制面仍可部署；交换机 / 防火墙 / VM PoC 将跳过。建议右键「以管理员身份运行」。' -ForegroundColor Yellow
  $SkipHyperV = $true
}
if (-not $SkipHyperV -and -not $preflight.hypervisorPresent) {
  Write-Host '未检测到可用 Hyper-V：部署控制面和基础服务，跳过隔离 worker 主机配置。' -ForegroundColor Yellow
  $SkipHyperV = $true
}

$nodeCmd = Get-Command node -ErrorAction Stop
$ver = (& node -v).TrimStart('v')
$major = [int]($ver.Split('.')[0])
if ($major -lt 22) { throw "需要 Node 22+，当前 v$ver" }
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
  Import-DeployEnv (Join-Path $Root 'data\deploy.env')
  Import-DeployEnv (Join-Path $Root 'scripts\deploy.env')
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

if (-not $SkipHyperV) {
  Write-Step 'Hyper-V 工作目录与隔离交换机'
  foreach ($p in @("$RunnerRoot\images", "$RunnerRoot\attempts", "$RunnerRoot\scratch", "$RunnerRoot\certs")) {
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    Write-Host "OK $p"
  }
  $srcCerts = Join-Path $Root 'secret-broker\dev-certs'
  foreach ($n in @('ca.crt', 'worker.crt', 'worker.key', 'worker-id.txt', 'trust.json')) {
    $src = Join-Path $srcCerts $n
    $dst = Join-Path "$RunnerRoot\certs" $n
    if (Test-Path $src) {
      Unlock-SecretFile $dst
      Copy-Item -Force $src $dst
    }
  }
  Protect-SecretFile (Join-Path $RunnerRoot 'certs\worker.key')

  if (-not $isAdmin) { throw 'Hyper-V worker host configuration requires an elevated shell.' }
  Write-Host "配置隔离网络：switch=$SwitchName host=$ProxyIp guest=$GuestCidr proxyPort=$ProxyPort"
  $networkArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'windows\ensure-isolated-network.ps1'),
    '-SwitchName', $SwitchName, '-ProxyIp', $ProxyIp, '-ProxyPort', "$ProxyPort",
    '-GuestCidr', $GuestCidr, '-BlockPorts'
  ) + @($BlockPorts | ForEach-Object { "$_" })
  $code = Invoke-Native 'powershell' $networkArgs
  if ($code -ne 0) { throw "Isolated Hyper-V network setup failed exit $code." }
}

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
$gatewayPort = if ($env:AWP_GATEWAY_PORT) { $env:AWP_GATEWAY_PORT } else { '8787' }
$blobPort = if ($env:AWP_BLOB_PORT) { $env:AWP_BLOB_PORT } else { '8792' }
$envLines = @(
  "AWP_DB_DIALECT=$dbDialect",
  "AWP_PG_MODE=$pgMode",
  "AWP_CONTROL_PORT=$ControlPort",
  "AWP_GATEWAY_PORT=$gatewayPort",
  "AWP_BLOB_PORT=$blobPort",
  "AWP_BROKER_PORT=$BrokerPort",
  "AWP_RUNNER_ROOT=$RunnerRoot",
  "AWP_VM_SWITCH_NAME=$SwitchName"
)
if ($dbDialect -eq 'postgres') { $envLines += "AWP_PG_URL=$env:AWP_PG_URL" }
if ($env:AWP_PG_DATA_DIR) { $envLines += "AWP_PG_DATA_DIR=$env:AWP_PG_DATA_DIR" }
if ($env:AWP_PG_PORT) { $envLines += "AWP_PG_PORT=$env:AWP_PG_PORT" }
if ($env:AWP_PG_DATABASE) { $envLines += "AWP_PG_DATABASE=$env:AWP_PG_DATABASE" }
if ($GitRemoteUrl) { $envLines += "AWP_GIT_REMOTE_URL=$GitRemoteUrl" }
Write-DeployEnv (Join-Path $Root 'data\deploy.env') $envLines
Write-DeployEnv (Join-Path $Root 'scripts\deploy.env') $envLines
if ($dbDialect -eq 'postgres') {
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($configPath in @((Join-Path $Root 'data\deploy.env'), (Join-Path $Root 'scripts\deploy.env'))) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    icacls $configPath /inheritance:r /grant:r "${user}:(M)" | Out-Null
    $ErrorActionPreference = $old
  }
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
  $env:AWP_BROKER_PORT = "$BrokerPort"
  $env:AWP_BROKER_DB = Join-Path $Root 'data\secret-broker.db'
  $env:AWP_BROKER_TLS_CERT = Join-Path $Root 'secret-broker\dev-certs\broker.crt'
  $env:AWP_BROKER_TLS_KEY = Join-Path $Root 'secret-broker\dev-certs\broker.key'
  $env:AWP_BROKER_TLS_CA = Join-Path $Root 'secret-broker\dev-certs\ca.crt'
  $env:AWP_BROKER_TRUST_FILE = Join-Path $Root 'secret-broker\dev-certs\trust.json'

  Invoke-Native 'pm2' @('delete', 'devweft') | Out-Null
  Invoke-Native 'pm2' @('delete', 'awp-secret-broker') | Out-Null
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
$hyperVConfigured = -not $SkipHyperV
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
    '-Port', "$ControlPort", '-BrokerPort', "$BrokerPort",
    '-RunnerRoot', $RunnerRoot, '-SwitchName', $SwitchName
  )
  if ($SkipHyperV) { $verifyArgs += '-SkipHyperV' }
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
