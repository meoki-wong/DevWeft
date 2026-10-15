# Start one standby control-plane process using the local data/node.env configuration.
param(
  [switch]$SkipHealthCheck
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$envFile = Join-Path $Root 'data\node.env'
$lockFile = Join-Path $Root 'package-lock.json'
$stampFile = Join-Path $Root 'data\.npm-ci.sha256'
$appName = 'devweft-standby'

if (-not (Test-Path $envFile)) {
  throw "Missing $envFile. Copy data\node.env.example to data\node.env and configure the primary database and blob-store URL."
}

Get-Content -LiteralPath $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $separator = $line.IndexOf('=')
  if ($separator -lt 1) { return }
  $name = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1).Trim()
  Set-Item -Path "Env:$name" -Value $value
}

if ($env:AWP_DB_DIALECT -ne 'postgres') { throw 'A standby node must use the shared PostgreSQL database: set AWP_DB_DIALECT=postgres.' }
if (-not $env:AWP_PG_URL -or $env:AWP_PG_URL -match 'USER:PASSWORD|PRIMARY_HOST|DATABASE') {
  throw 'Set AWP_PG_URL in data\node.env to the primary PostgreSQL connection string.'
}
if (-not $env:AWP_BLOB_BASE_URL -or $env:AWP_BLOB_BASE_URL -match 'PRIMARY_HOST') {
  throw 'Set AWP_BLOB_BASE_URL in data\node.env to the primary blob-store URL.'
}
$env:AWP_STANDBY = '1'
$env:NODE_ENV = 'production'
$port = 0
if (-not [int]::TryParse($env:PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
  throw 'Set PORT in data\node.env to a valid TCP port.'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22+ is required. Install Node.js, then rerun start-standby.cmd.' }
$nodeVersion = ((& node -v) -replace '^v', '').Split('.')[0]
if ([int]$nodeVersion -lt 22) { throw "Node.js 22+ is required; found node v$(& node -v)." }
if (-not (Test-Path $lockFile)) { throw 'package-lock.json is missing.' }

$lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash
$sqliteMarker = Join-Path $Root 'node_modules\better-sqlite3\package.json'
$needsInstall = -not (Test-Path $sqliteMarker) -or -not (Test-Path $stampFile)
if (-not $needsInstall) { $needsInstall = (Get-Content -LiteralPath $stampFile -Raw).Trim() -ne $lockHash }
if ($needsInstall) {
  if (Get-Command pm2 -ErrorAction SilentlyContinue) { & pm2 stop $appName 2>$null | Out-Null }
  Write-Host 'Installing locked dependencies...'
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
  Set-Content -LiteralPath $stampFile -Value $lockHash -Encoding ascii
}

if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing PM2...'
  & npm install --global pm2
  if ($LASTEXITCODE -ne 0) { throw "Installing PM2 failed with exit code $LASTEXITCODE." }
}

$exists = $false
try {
  $id = (& pm2 id $appName 2>$null | Out-String).Trim()
  $exists = $id -match '^\d+$'
} catch { $exists = $false }
if ($exists) {
  & pm2 restart $appName --update-env
} else {
  & pm2 start (Join-Path $Root 'server.js') --name $appName --update-env
}
if ($LASTEXITCODE -ne 0) { throw "PM2 could not start $appName (exit code $LASTEXITCODE)." }
& pm2 save | Out-Null

if (-not $SkipHealthCheck) {
  $ready = $false
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health/live" -TimeoutSec 2 -UseBasicParsing
      if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) {
    & pm2 logs $appName --lines 40 --nostream 2>&1 | Out-Host
    throw "Standby control plane did not become healthy on port $port. Check the shared database and PM2 logs."
  }
}

Write-Host "Standby control plane is running at http://127.0.0.1:$port"
Write-Host "PM2 process: $appName"
if (-not (Test-Path (Join-Path $Root 'data\bootstrap-admin.token'))) {
  Write-Warning 'Remote artifact uploads also require the primary bootstrap token at data\bootstrap-admin.token.'
}
