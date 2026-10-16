param(
  [ValidateSet('deploy', 'standalone', 'primary', 'standby')]
  [string]$Profile = 'standalone'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
. (Join-Path $PSScriptRoot 'Deploy.Common.ps1')

$standbyPath = Join-Path $Root 'data\node.env'
switch ($Profile) {
  'standby' { Import-DevWeftEnvFile -Path $standbyPath }
  default { Import-DevWeftDeploymentEnv -Root $Root -Optional }
}

if ($Profile -eq 'deploy') { Assert-DevWeftRuntime -RequireGit } else { Assert-DevWeftRuntime }

$dialect = if ($env:AWP_DB_DIALECT) { $env:AWP_DB_DIALECT } else { 'sqlite' }
if ($dialect -notin @('sqlite', 'postgres')) { throw 'AWP_DB_DIALECT must be sqlite or postgres.' }
if ($dialect -eq 'postgres' -and -not $env:AWP_PG_URL -and ($Profile -ne 'deploy' -or $env:AWP_PG_MODE -ne 'embedded')) {
  throw 'AWP_DB_DIALECT=postgres requires AWP_PG_URL in data\deploy.env (or select embedded PostgreSQL for a single host).'
}

foreach ($name in @('AWP_CONTROL_PORT', 'AWP_GATEWAY_PORT', 'AWP_BLOB_PORT', 'AWP_BROKER_PORT', 'PORT')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  Assert-DevWeftPort -Name $name -Value $value
}

if ($Profile -eq 'standby') {
  if ($dialect -ne 'postgres') { throw 'Standby profile requires AWP_DB_DIALECT=postgres.' }
  if (-not $env:AWP_PG_URL -or $env:AWP_PG_URL -match 'USER:PASSWORD|PRIMARY_HOST|DATABASE') {
    throw 'Set AWP_PG_URL in data\node.env to the primary PostgreSQL connection string.'
  }
  if ($env:AWP_BLOB_BASE_URL -match 'PRIMARY_HOST') { $env:AWP_BLOB_BASE_URL = '' }
  if (-not $env:PORT) { throw 'Set PORT in data\node.env to the standby control-plane port.' }
  if ($env:AWP_BLOB_BASE_URL) {
    Write-Host 'Standby profile: shared PostgreSQL and explicit remote blob-store URL are present.'
  } else {
    Write-Host 'Standby profile: blob URL will resolve from the shared database primary link; startup readiness will verify it.'
  }
} elseif ($Profile -eq 'primary') {
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) { throw 'Dependencies are missing. Run deploy.cmd first.' }
  if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { throw 'PM2 is missing. Run deploy.cmd first.' }
  Write-Host "Primary profile: database dialect=$dialect."
} elseif ($Profile -eq 'deploy') {
  if (-not (Test-Path (Join-Path $Root 'package-lock.json'))) { throw 'package-lock.json is missing.' }
  Write-Host "Full deployment profile: database dialect=$dialect."
} else {
  Write-Host "Standalone profile: database dialect=$dialect."
}
