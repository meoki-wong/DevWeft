# Start or restart the primary host services listed in ecosystem.config.cjs.
param(
  [switch]$SetupAutostart,
  [int]$ControlPort = 8791,
  [int]$GatewayPort = 8787,
  [int]$BlobPort = 8792,
  [int]$BrokerPort = 8788
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { return }
    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    Set-Item -Path "Env:$name" -Value $value
  }
}

Import-EnvFile (Join-Path $Root 'data\deploy.env')
Import-EnvFile (Join-Path $Root 'scripts\deploy.env')
if ($env:AWP_CONTROL_PORT) { $ControlPort = [int]$env:AWP_CONTROL_PORT }
if ($env:AWP_GATEWAY_PORT) { $GatewayPort = [int]$env:AWP_GATEWAY_PORT }
if ($env:AWP_BLOB_PORT) { $BlobPort = [int]$env:AWP_BLOB_PORT }
if ($env:AWP_BROKER_PORT) { $BrokerPort = [int]$env:AWP_BROKER_PORT }
if ($env:AWP_DB_DIALECT -and $env:AWP_DB_DIALECT -notin @('sqlite', 'postgres')) { throw 'AWP_DB_DIALECT must be sqlite or postgres.' }
if ($env:AWP_DB_DIALECT -eq 'postgres' -and -not $env:AWP_PG_URL) { throw 'Set AWP_PG_URL in scripts\deploy.env before starting PostgreSQL-backed services.' }

function Test-TcpListen([string]$HostName, [int]$Port, [int]$TimeoutMs = 1000) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch { return $false } finally { $client.Close() }
}

if ($env:AWP_DB_DIALECT -eq 'postgres') {
  $dbUri = [uri]$env:AWP_PG_URL
  $dbHost = $dbUri.DnsSafeHost
  $dbPort = if ($dbUri.IsDefaultPort) { 5432 } else { $dbUri.Port }
  $isLocalDb = $dbHost -in @('localhost', '127.0.0.1', '::1')
  if ($isLocalDb) {
    $pgData = if ($env:AWP_PG_DATA_DIR) { $env:AWP_PG_DATA_DIR } else { Join-Path $Root 'data\pgdata' }
    $pgCtl = Join-Path $Root 'node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe'
    $pgTask = 'AWP-PostgreSQL'
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\logs') | Out-Null
    $pgReady = Test-TcpListen '127.0.0.1' $dbPort

    if ((Test-Path $pgCtl) -and (Test-Path (Join-Path $pgData 'PG_VERSION'))) {
      if (-not (Get-ScheduledTask -TaskName $pgTask -ErrorAction SilentlyContinue)) {
        $pgLog = Join-Path $Root 'data\logs\postgres.log'
        $action = New-ScheduledTaskAction -Execute $pgCtl -Argument "-D `"$pgData`" -o `"-p $dbPort`" -l `"$pgLog`" start -w -t 60"
        $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        $userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        Register-ScheduledTask -TaskName $pgTask -Action $action -Trigger $triggers -Settings $settings -User $userName -RunLevel Limited -Force | Out-Null
      }
      Enable-ScheduledTask -TaskName $pgTask | Out-Null
      if (-not $pgReady) {
        Start-ScheduledTask -TaskName $pgTask
        for ($attempt = 1; $attempt -le 45 -and -not $pgReady; $attempt++) {
          Start-Sleep -Seconds 2
          $pgReady = Test-TcpListen '127.0.0.1' $dbPort
        }
      }
    }

    if (-not $pgReady) {
      throw "Local PostgreSQL is not listening on $dbHost`:$dbPort. Start PostgreSQL or configure a reachable database in AWP_PG_URL."
    }
    Write-Host "PostgreSQL is ready at $dbHost`:$dbPort"
  }
}

$env:AWP_CONTROL_PORT = "$ControlPort"
$env:AWP_GATEWAY_PORT = "$GatewayPort"
$env:AWP_BLOB_PORT = "$BlobPort"
$env:AWP_BROKER_PORT = "$BrokerPort"
$ecosystem = Join-Path $Root 'ecosystem.config.cjs'
if (-not (Test-Path (Join-Path $Root 'node_modules'))) { throw 'Dependencies are missing. Run deploy.cmd first.' }
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { throw 'PM2 is missing. Run deploy.cmd first.' }

$serviceNames = @(& node -e "for (const app of require('./ecosystem.config.cjs').apps) console.log(app.name)")
if ($LASTEXITCODE -ne 0 -or $serviceNames.Count -eq 0) { throw 'Could not read applications from ecosystem.config.cjs.' }

foreach ($name in $serviceNames) {
  $id = ''
  try { $id = (& pm2 id $name 2>$null | Out-String).Trim() } catch { }
  if ($id -match '^\d+$') {
    & pm2 restart $name --update-env | Out-Null
    Write-Host "restarted $name"
  } else {
    & pm2 start $ecosystem --only $name --update-env | Out-Null
    Write-Host "started $name"
  }
  if ($LASTEXITCODE -ne 0) { throw "PM2 failed to start $name (exit code $LASTEXITCODE)." }
}
& pm2 save | Out-Null

if ($SetupAutostart) {
  $startupPackage = npm ls -g pm2-windows-startup --depth=0 2>$null | Out-String
  if ($startupPackage -notmatch 'pm2-windows-startup') {
    & npm install --global pm2-windows-startup
    if ($LASTEXITCODE -ne 0) { throw 'Could not install pm2-windows-startup.' }
  }
  & pm2-startup install
  if ($LASTEXITCODE -ne 0) { throw 'Could not configure PM2 startup on Windows.' }
}

$healthy = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ControlPort/api/health/live" -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $healthy) {
  & pm2 status
  & pm2 logs devweft --lines 40 --nostream 2>&1 | Out-Host
  throw "Control plane did not become healthy on port $ControlPort. Check the database settings and PM2 logs."
}

Write-Host "Control plane: http://127.0.0.1:$ControlPort/dashboard.html"
Write-Host "Gateway:       http://127.0.0.1:$GatewayPort/mcp"
Write-Host "Blob store:    http://127.0.0.1:$BlobPort"
Write-Host "Broker port:   $BrokerPort"
Write-Host 'Primary host services are running. Use pm2 status to inspect process health.'
