# Provision the optional single-host PostgreSQL instance bundled with the Windows npm dependency.
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$DataDirectory = '',
  [int]$Port = 5432,
  [string]$DatabaseName = 'awp_platform'
)

$ErrorActionPreference = 'Stop'
Set-Location $Root
if (-not $DataDirectory) { $DataDirectory = Join-Path $Root 'data\pgdata' }
$bin = Join-Path $Root 'node_modules\@embedded-postgres\windows-x64\native\bin'
$initdb = Join-Path $bin 'initdb.exe'
$pgCtl = Join-Path $bin 'pg_ctl.exe'
foreach ($path in @($initdb, $pgCtl)) {
  if (-not (Test-Path $path)) { throw "Bundled PostgreSQL utility is missing: $path. Rerun npm ci on Windows." }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DataDirectory), (Join-Path $Root 'data\logs') | Out-Null
$isNewCluster = -not (Test-Path (Join-Path $DataDirectory 'PG_VERSION'))
$username = 'awp_admin'
$passwordFile = Join-Path $Root 'data\.pg-init-password.tmp'
$password = $null

function Save-ConnectionConfig([string]$ConnectionString) {
  $configFiles = @((Join-Path $Root 'data\deploy.env'), (Join-Path $Root 'scripts\deploy.env'))
  foreach ($configPath in $configFiles) {
    $lines = @()
    if (Test-Path $configPath) { $lines = @(Get-Content -LiteralPath $configPath | Where-Object { $_ -notmatch '^\s*AWP_(DB_DIALECT|PG_MODE|PG_URL|PG_DATA_DIR)=' }) }
    $lines += @('AWP_DB_DIALECT=postgres', 'AWP_PG_MODE=embedded', "AWP_PG_URL=$ConnectionString", "AWP_PG_DATA_DIR=$DataDirectory")
    Set-Content -LiteralPath $configPath -Value $lines -Encoding ascii
    $configUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    icacls $configPath /inheritance:r /grant:r "${configUser}:(M)" | Out-Null
  }
}

try {
  if ($isNewCluster) {
    $random = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $randomBytes = [byte[]]::new(36)
    $random.GetBytes($randomBytes)
    $random.Dispose()
    $password = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', 'A').Replace('/', 'B')
    Set-Content -LiteralPath $passwordFile -Value $password -NoNewline -Encoding ascii
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    icacls $passwordFile /inheritance:r /grant:r "${user}:(M)" | Out-Null
    & $initdb -D $DataDirectory -U $username --pwfile=$passwordFile --auth-host=scram-sha-256 --auth-local=trust --encoding=UTF8
    if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE." }
  } else {
    $existingUrl = $env:AWP_PG_URL
    if (-not $existingUrl) { throw 'Local PostgreSQL data already exists but AWP_PG_URL is not configured. Set the matching connection string in scripts\deploy.env.' }
    $existingUri = [uri]$existingUrl
    $username = [uri]::UnescapeDataString($existingUri.UserInfo.Split(':')[0])
    $password = [uri]::UnescapeDataString(($existingUri.UserInfo -split ':', 2)[1])
    $Port = if ($existingUri.IsDefaultPort) { 5432 } else { $existingUri.Port }
    $DatabaseName = [uri]::UnescapeDataString($existingUri.AbsolutePath.TrimStart('/'))
  }
  if ($DatabaseName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'AWP_PG_DATABASE must use letters, digits, and underscores, and cannot start with a digit.' }
  $escapedPassword = [uri]::EscapeDataString($password)
  $connectionString = "postgresql://${username}:${escapedPassword}@127.0.0.1:${Port}/${DatabaseName}"
  Save-ConnectionConfig $connectionString

  $log = Join-Path $Root 'data\logs\postgres.log'
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) {
    & $pgCtl -D $DataDirectory -o "-p $Port -h 127.0.0.1" -l $log start -w -t 60
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL did not start (pg_ctl exit code $LASTEXITCODE). See $log." }
  }

  $env:AWP_PG_URL = $connectionString
  $env:AWP_PG_DATABASE = $DatabaseName
  & node (Join-Path $Root 'scripts\provision-local-postgres.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Creating the local PostgreSQL database or applying baseline/RLS failed.' }

  $taskName = 'AWP-PostgreSQL'
  $taskLog = Join-Path $Root 'data\logs\postgres.log'
  $action = New-ScheduledTaskAction -Execute $pgCtl -Argument "-D `"$DataDirectory`" -o `"-p $Port`" -l `"$taskLog`" start -w -t 60" -WorkingDirectory $Root
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
  Enable-ScheduledTask -TaskName $taskName | Out-Null

  Write-Host "Local PostgreSQL is ready: 127.0.0.1:$Port/$DatabaseName"
  Write-Host "Data directory: $DataDirectory"
} finally {
  Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:AWP_PG_DATABASE -ErrorAction SilentlyContinue
}
