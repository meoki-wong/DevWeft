# Provision the optional single-host PostgreSQL instance bundled with the Windows npm dependency.
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$DataDirectory = '',
  [int]$Port = 5432,
  [string]$DatabaseName = 'awp_platform',
  [ValidateRange(1, 1024)][int]$WarnBelowFreeSpaceGB = 5
)

$ErrorActionPreference = 'Stop'
Set-Location $Root
if (-not $DataDirectory) { $DataDirectory = Join-Path $Root 'data\pgdata' }
$DataDirectory = [System.IO.Path]::GetFullPath($DataDirectory)
$bin = Join-Path $Root 'node_modules\@embedded-postgres\windows-x64\native\bin'
$initdb = Join-Path $bin 'initdb.exe'
$pgCtl = Join-Path $bin 'pg_ctl.exe'
foreach ($path in @($initdb, $pgCtl)) {
  if (-not (Test-Path $path)) { throw "Bundled PostgreSQL utility is missing: $path. Rerun npm ci on Windows." }
}

$versionFile = Join-Path $DataDirectory 'PG_VERSION'
$isNewCluster = -not (Test-Path -LiteralPath $versionFile)
if ($isNewCluster -and $env:AWP_PG_URL) {
  throw "AWP_PG_URL is configured but this data directory has no PG_VERSION: $DataDirectory. Refusing to replace the configured database URL or initialize over an unknown cluster; verify the selected embedded mode and data path first."
}
if ($env:AWP_PG_PORT) {
  $configuredPort = 0
  if (-not [int]::TryParse($env:AWP_PG_PORT, [ref]$configuredPort)) { throw 'AWP_PG_PORT must be a TCP port from 1 through 65535.' }
  $Port = $configuredPort
} elseif (-not $isNewCluster -and $env:AWP_PG_URL) {
  try { $configuredUrl = [uri]$env:AWP_PG_URL } catch { throw 'AWP_PG_URL is not a valid PostgreSQL URL for the existing embedded cluster.' }
  if ($configuredUrl.Scheme -notin @('postgres', 'postgresql') -or $configuredUrl.DnsSafeHost -notin @('localhost', '127.0.0.1', '::1')) {
    throw 'Embedded PostgreSQL must use a loopback AWP_PG_URL. This setup never rewrites an external database URL.'
  }
  $Port = if ($configuredUrl.IsDefaultPort) { 5432 } else { $configuredUrl.Port }
}
if ($Port -lt 1 -or $Port -gt 65535) { throw 'PostgreSQL port must be from 1 through 65535.' }
if ($DatabaseName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'AWP_PG_DATABASE must use letters, digits, and underscores, and cannot start with a digit.' }
if ($isNewCluster -and (Test-Path -LiteralPath $DataDirectory)) {
  $existingItem = Get-ChildItem -LiteralPath $DataDirectory -Force -ErrorAction Stop | Select-Object -First 1
  if ($existingItem) {
    throw "PostgreSQL data directory is not empty but has no PG_VERSION. Nothing was changed: $DataDirectory. Inspect or move the directory yourself before retrying."
  }
}

$driveRoot = [System.IO.Path]::GetPathRoot($DataDirectory)
$drive = [System.IO.DriveInfo]::new($driveRoot)
$availableGB = [math]::Floor($drive.AvailableFreeSpace / 1GB)
if ($availableGB -lt $WarnBelowFreeSpaceGB) {
  Write-Warning "Only ${availableGB}GB is free on $driveRoot (recommended: at least ${WarnBelowFreeSpaceGB}GB for a new PostgreSQL data directory). The database can grow and consume additional space."
}

$probeDirectory = if (Test-Path -LiteralPath $DataDirectory) { $DataDirectory } else { Split-Path -Parent $DataDirectory }
while ($probeDirectory -and -not (Test-Path -LiteralPath $probeDirectory)) { $probeDirectory = Split-Path -Parent $probeDirectory }
if (-not $probeDirectory) { throw "Cannot find an existing parent directory to check write access for $DataDirectory." }
$permissionProbe = Join-Path $probeDirectory ('.devweft-pg-write-' + [guid]::NewGuid().ToString('N'))
try {
  [System.IO.File]::WriteAllText($permissionProbe, 'preflight')
} catch {
  throw "The current user cannot write to the PostgreSQL data path or its parent ($probeDirectory). Choose a writable AWP_PG_DATA_DIR or fix its ACLs before retrying."
} finally {
  Remove-Item -LiteralPath $permissionProbe -Force -ErrorAction SilentlyContinue
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  if ($isNewCluster) {
    throw "TCP port $Port is already in use by PID $($listener.OwningProcess). The new PostgreSQL cluster was not initialized. Set AWP_PG_PORT to a free port or stop the owning service yourself."
  }
  & $pgCtl -D $DataDirectory status *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "TCP port $Port is in use by PID $($listener.OwningProcess), but this data directory is not running there. Existing data was left untouched; choose another AWP_PG_PORT or inspect the listener."
  }
}

Write-Host "PostgreSQL preflight: data directory=$DataDirectory; port=$Port; free space=${availableGB}GB."
if (-not $isNewCluster) { Write-Host 'Existing PostgreSQL cluster detected. Its data directory will be preserved; setup will not run initdb or delete database files.' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DataDirectory), (Join-Path $Root 'data\logs') | Out-Null
$username = 'awp_admin'
$passwordFile = Join-Path $Root 'data\.pg-init-password.tmp'
$password = $null

function Save-ConnectionConfig([string]$ConnectionString) {
  $configFiles = @((Join-Path $Root 'data\deploy.env'))
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
    if (-not $existingUrl) { throw 'Local PostgreSQL data already exists but AWP_PG_URL is not configured. Set the matching connection string in data\deploy.env.' }
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
