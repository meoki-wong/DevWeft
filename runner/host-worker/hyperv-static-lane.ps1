#Requires -RunAsAdministrator
# EN-only
# EN-only

param(
  [Parameter(Mandatory = $true)][string]$VmName,
  [Parameter(Mandatory = $true)][string]$GoldenVhdx,
  [Parameter(Mandatory = $true)][string]$PasswordFile,
  [Parameter(Mandatory = $true)][string]$AttemptDir,
  [Parameter(Mandatory = $true)][string]$ExpectedVhdxSha256,
  [string]$SwitchName = 'awp-isolated',
  [int]$WaitMinutes = 20,
  # EN-only
  [int]$BootReadyMinutes = 5,
  [string]$GuestRunDir = 'C:\awp-run',
  [string]$ProxyIp = '192.168.250.1',
  [string]$GuestIp = '192.168.250.10',
  [int]$ProxyPort = 443,
  [string]$ProxyHostName = 'packages.example.invalid',
  # EN-only
  [string]$Repo = '',
  [string]$RepoRootPath = '',
  # EN-only
  # EN-only
  # 内存默认值（10-10 调参）：主机 31.5GB 物理内存、常驻服务+IDE 后仅 ~7.5GB 可用；
  # 并发 2 × max 8192MB 时 Hyper-V 按上限预留分页资源 → Start-VM 0x8007000E（OutOfMemory）。
  # static/smoke 实测峰值（npm ci + vite build + playwright）< 3.5GB，上限收到 4096MB 足够且双 VM 并发安全。
  # 仍可用 AWP_VM_MEM_MIN_MB / AWP_VM_MEM_START_MB / AWP_VM_MEM_MAX_MB 覆盖。
  [int]$MemoryMinMB = $(if ($env:AWP_VM_MEM_MIN_MB) { [int]$env:AWP_VM_MEM_MIN_MB } else { 2048 }),
  [int]$MemoryStartupMB = $(if ($env:AWP_VM_MEM_START_MB) { [int]$env:AWP_VM_MEM_START_MB } else { 4096 }),
  [int]$MemoryMaxMB = $(if ($env:AWP_VM_MEM_MAX_MB) { [int]$env:AWP_VM_MEM_MAX_MB } else { 4096 })
)

$ErrorActionPreference = 'Stop'
$diffPath = Join-Path $AttemptDir 'diff.vhdx'
$outDir = Join-Path $AttemptDir 'output'
$inputDir = Join-Path $AttemptDir 'input'
$suiteDir = Join-Path $AttemptDir 'suite'
$icFile = Join-Path $AttemptDir 'integration-services.txt'
$ok = $false
$lib = Join-Path $PSScriptRoot '..\..\scripts\windows\isolated-network.ps1'
. $lib

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

function Write-IcDump([string]$Name, [string]$Path) {
  $rows = @(Get-VMIntegrationService -VMName $Name | ForEach-Object {
    '{0}  enabled={1}  status={2}' -f $_.Name, $_.Enabled, $_.PrimaryStatusDescription
  })
  $text = $rows -join "`r`n"
  Write-Host $text
  if ($Path) { Set-Content -LiteralPath $Path -Value $text -Encoding UTF8 }
}

function Get-HeartbeatIc([string]$Name) {
  Get-VMIntegrationService -VMName $Name | Where-Object {
    $_.Name -match 'Heartbeat|心跳|检测信号'
  } | Select-Object -First 1
}

function Enable-GuestFileCopy([string]$Name) {
  $svc = Get-VMIntegrationService -VMName $Name | Where-Object {
    $_.Name -match 'Guest Service|来宾服务'
  } | Select-Object -First 1
  if ($svc -and -not $svc.Enabled) {
    Enable-VMIntegrationService -VMName $Name -Name $svc.Name
  }
}

function Wait-GuestReady([string]$Name, [pscredential]$Cred, [int]$Minutes, [string]$DumpPath) {
  Write-Host ':'
  Write-IcDump $Name $DumpPath
  $deadline = (Get-Date).AddMinutes($Minutes)
  $lastDirect = ''
  do {
    $vm = Get-VM -Name $Name
    $hb = Get-HeartbeatIc $Name
    $hbText = if ($hb) { '{0}/{1}' -f $hb.Name, $hb.PrimaryStatusDescription } else { 'n/a' }
    Write-Host ("  {0}  state={1} heartbeat={2}" -f (Get-Date -Format 'HH:mm:ss'), $vm.State, $hbText)
    if ($vm.State -eq 'Running') {
      try {
        $probe = Invoke-Command -VMName $Name -Credential $Cred -ScriptBlock { 'direct-ok' } -ErrorAction Stop
        if ($probe -eq 'direct-ok') { return }
      } catch {
        $lastDirect = $_.Exception.Message
        Write-Host ("  PowerShell Direct: {0}" -f $lastDirect)
      }
    }
    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $deadline)
  Write-IcDump $Name $DumpPath
  throw ("GUEST_NOT_READY lastDirect={0}" -f $lastDirect)
}

function Set-GuestFile($Sess, [string]$LocalPath, [string]$GuestPath) {
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($LocalPath))
  Invoke-Command -Session $Sess -ScriptBlock {
    param($p, $payload)
    $dir = Split-Path -Parent $p
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllBytes($p, [Convert]::FromBase64String($payload))
  } -ArgumentList $GuestPath, $b64
}

function Copy-HostToGuest([string]$Name, [string]$LocalPath, [string]$GuestPath) {
  $err = $null
  for ($i = 0; $i -lt 20; $i++) {
    try {
      Copy-VMFile -Name $Name -SourcePath $LocalPath -DestinationPath $GuestPath -FileSource Host -CreateFullPath -Force
      return
    } catch {
      $err = $_
      Start-Sleep -Seconds 2
    }
  }
  throw $err
}

function Publish-GuestFile([string]$Name, [pscredential]$Cred, [string]$LocalPath, [string]$GuestPath) {
  # EN-only
  try {
    Set-GuestFile $Name $Cred $LocalPath $GuestPath
    return
  } catch {
    Write-Host ("  Direct 注入失败，改走 Copy-VMFile: {0}" -f $_.Exception.Message)
  }
  $err = $null
  for ($i = 0; $i -lt 3; $i++) {
    try {
      Copy-VMFile -Name $Name -SourcePath $LocalPath -DestinationPath $GuestPath -FileSource Host -CreateFullPath -Force
      return
    } catch {
      $err = $_
      Start-Sleep -Seconds 2
    }
  }
  throw $err
}

function Get-GuestFile($Sess, [string]$GuestPath, [string]$LocalPath) {
  $b64 = Invoke-Command -Session $Sess -ScriptBlock {
    param($p)
    if (-not (Test-Path -LiteralPath $p)) { throw "missing $p" }
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))
  } -ArgumentList $GuestPath
  $dir = Split-Path -Parent $LocalPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllBytes($LocalPath, [Convert]::FromBase64String([string]$b64))
}

function Set-GuestIsolatedNet($Sess, [string]$GuestAddr, [string]$ProxyAddr, [string]$HostName, [int]$Port) {
  Invoke-Command -Session $Sess -ScriptBlock {
    param($guestIp, $proxyIp, $proxyHost, $proxyPort)
    $if = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
    if (-not $if) { throw 'Guest' }
    Disable-NetAdapterBinding -Name $if.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
    Get-NetIPAddress -InterfaceIndex $if.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      ForEach-Object {
        Remove-NetIPAddress -InterfaceIndex $_.InterfaceIndex -IPAddress $_.IPAddress -Confirm:$false -ErrorAction SilentlyContinue
      }
    Get-NetRoute -InterfaceIndex $if.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
      Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
    New-NetIPAddress -InterfaceIndex $if.ifIndex -IPAddress $guestIp -PrefixLength 24 | Out-Null
    $hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $line = '{0} {1}' -f $proxyIp, $proxyHost
    $cur = @(Get-Content -LiteralPath $hostsFile -ErrorAction SilentlyContinue)
    if ($cur -notcontains $line) { Add-Content -LiteralPath $hostsFile -Value $line -Encoding ASCII }
    Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultInboundAction Block -DefaultOutboundAction Block
    Get-NetFirewallRule -DisplayName 'awp-npm-proxy' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName 'awp-npm-proxy' -Direction Outbound -Action Allow -Protocol TCP `
      -RemoteAddress $proxyIp -RemotePort $proxyPort | Out-Null
  } -ArgumentList $GuestAddr, $ProxyAddr, $HostName, $Port
}

if (-not (Test-Path $GoldenVhdx)) { throw "Golden: $GoldenVhdx" }
if (-not (Test-Path $PasswordFile)) { throw "$PasswordFile" }
$actual = (Get-FileHash -LiteralPath $GoldenVhdx -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $ExpectedVhdxSha256.ToLowerInvariant()) {
  throw "IMAGE_CHANGED actual=$actual expected=$ExpectedVhdxSha256"
}

$plain = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
$cred = New-Object System.Management.Automation.PSCredential (
  'Administrator',
  (ConvertTo-SecureString $plain -AsPlainText -Force)
)

Import-Module Hyper-V -ErrorAction Stop
New-Item -ItemType Directory -Force -Path $AttemptDir, $outDir | Out-Null

try {
  $sw = Ensure-IsolatedSwitch $SwitchName
  if ($sw.Name -eq 'Default Switch') { throw 'Default Switch' }

  Write-Step "差分盘 $diffPath"
  attrib +R $GoldenVhdx | Out-Null
  # EN-only
  # EN-only
  # EN-only
  # EN-only
  $parentForRun = $GoldenVhdx
  $depCacheEnabled = $false
  if ($Repo -and $RepoRootPath -and (Test-Path (Join-Path $RepoRootPath 'data\team.db'))) {
    try {
      $settingsRow = & node -e "const db=require('better-sqlite3')(process.argv[1]+'\\data\\team.db',{readonly:true});const r=db.prepare(`"SELECT value FROM platform_settings WHERE key='dep_cache'`").get();console.log(r?r.value:'off')" $RepoRootPath 2>$null
      if ($settingsRow -eq 'on') { $depCacheEnabled = $true }
    } catch { }
  }
  if ($depCacheEnabled -and $Repo -and (Test-Path (Join-Path $inputDir 'dep-cache-lockhash'))) {
    $lockHash = (Get-Content (Join-Path $inputDir 'dep-cache-lockhash') -Raw).Trim()
    if ($lockHash -match '^[a-f0-9]{16}$') {
      $cacheDir = 'C:\awp-runner\dep-cache'
      New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
      $cacheLayer = Join-Path $cacheDir ("dep-{0}-{1}.avhdx" -f $Repo, $lockHash)
      if (-not (Test-Path $cacheLayer)) {
        # EN-only
        Write-Host "dep-cache miss: $cacheLayer （ run npm ci， ）"
        $null = Join-Path $cacheDir ('.pending-{0}-{1}' -f $Repo, $lockHash) | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ }
      } else {
        $parentForRun = $cacheLayer
        Write-Host "dep-cache HIT: $cacheLayer（ npm ci）"
      }
    }
  }
  # 0x80070050: leftover diff vhd — dismount + remove before New-VHD
  try {
    if (Test-Path $diffPath) {
      Dismount-VHD -Path $diffPath -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
      Remove-Item -LiteralPath $diffPath -Force -ErrorAction Stop
      Write-Host "  cleaned leftover diff vhd: $diffPath"
    }
  } catch {
    throw "DIFF_VHD_BUSY: cannot remove existing $diffPath — $($_.Exception.Message)"
  }
  New-VHD -Path $diffPath -ParentPath $parentForRun -Differencing | Out-Null

  # EN-only
  # EN-only
  Write-Step 'Guest'
  Mount-VHD -Path $diffPath
  $offlineWin = $null
  try {
    $diskNumber = (Get-VHD -Path $diffPath).DiskNumber
    $part = Get-Partition -DiskNumber $diskNumber | Where-Object { $_.Size -gt 1GB } | Select-Object -First 1
    $offlineWin = $part.DriveLetter
    if (-not $offlineWin) { $offlineWin = ($part | Add-PartitionAccessPath -AssignDriveLetter -PassThru).DriveLetter }
    $guestRun = Join-Path "${offlineWin}:" 'awp-run'
    New-Item -ItemType Directory -Force -Path @(
      (Join-Path $guestRun 'input'),
      (Join-Path $guestRun 'output'),
      (Join-Path $guestRun 'workspace'),
      (Join-Path $guestRun 'suite\fixtures'),
      (Join-Path $guestRun 'run-local')
    ) | Out-Null
    Get-ChildItem -LiteralPath $inputDir -File | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $guestRun ('input\' + $_.Name)) -Force
    }
    if (Test-Path (Join-Path $inputDir 'test-specs')) {
      # EN-only
      Copy-Item (Join-Path $inputDir 'test-specs') (Join-Path $guestRun 'input\test-specs') -Recurse -Force
      Write-Host '  test-specs dir injected (E2E specs)'
    }
    if (Test-Path $suiteDir) {
      Get-ChildItem -LiteralPath $suiteDir -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring((Resolve-Path $suiteDir).Path.Length).TrimStart('\')
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $guestRun ("suite\" + $rel)) -Force
      }
    }
    # EN-only
    # EN-only
    # EN-only
    $setupNet = Join-Path "${offlineWin}:" 'awp-golden\setup-network.cmd'
    if (Test-Path -LiteralPath $setupNet) {
      $setupNetPatch = @'
@echo off
setlocal
set GUEST_IP=@@GUEST_IP@@
set GATEWAY=@@GW@@
set PROXY_IP=@@PROXY_IP@@
set PROXY_HOST=@@PROXY_HOST@@
set PROXY_PORT=@@PROXY_PORT@@
rem worker-patched: probe interface name dynamically (locale-independent)
for /f "usebackq delims=" %%i in (`powershell.exe -NoProfile -Command "(Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1).Name"`) do set IFACE=%%i
if "%IFACE%"=="" set IFACE=Ethernet
netsh interface ipv4 set address name="%IFACE%" static %GUEST_IP% 255.255.255.0 %GATEWAY% 1
if exist C:\Windows\System32\drivers\etc\hosts (
  findstr /C:%PROXY_HOST% C:\Windows\System32\drivers\etc\hosts >NUL 2>&1
  if errorlevel 1 echo %PROXY_IP% %PROXY_HOST%>>C:\Windows\System32\drivers\etc\hosts
) else (
  echo %PROXY_IP% %PROXY_HOST%>C:\Windows\System32\drivers\etc\hosts
)
netsh advfirewall set allprofiles firewallpolicy blockinbound,allowoutbound
netsh advfirewall firewall delete rule name=awp-npm-proxy >NUL 2>&1
netsh advfirewall firewall add rule name=awp-npm-proxy dir=out action=allow protocol=TCP remoteip=%PROXY_IP% remoteport=%PROXY_PORT%
'@
      $setupNetPatch = $setupNetPatch.Replace('@@GUEST_IP@@', $GuestIp).Replace('@@GW@@', $ProxyIp).Replace('@@PROXY_IP@@', $ProxyIp).Replace('@@PROXY_HOST@@', $ProxyHostName).Replace('@@PROXY_PORT@@', [string]$ProxyPort)
      Set-Content -LiteralPath $setupNet -Value $setupNetPatch -Encoding ascii
      Write-Host '  setup-network.cmd patched (dynamic interface name)'
    }
    # EN-only
    # EN-only
    $pwSrc = 'C:\awp-runner\pw-bundle\node_modules'
    if (Test-Path (Join-Path $pwSrc 'playwright')) {
      # 官方 expect 位于 playwright/test；不需要也不伪造 @playwright/test 包。
      # 两个包必须来自同一离线 bundle，避免浏览器和 locator 断言跨版本。
      $pwPackage = Get-Content -LiteralPath (Join-Path $pwSrc 'playwright\package.json') -Raw | ConvertFrom-Json
      $corePackage = Get-Content -LiteralPath (Join-Path $pwSrc 'playwright-core\package.json') -Raw | ConvertFrom-Json
      if (-not $pwPackage.exports.'./test' -or $pwPackage.dependencies.'playwright-core' -ne $corePackage.version) {
        throw 'PLAYWRIGHT_RUNTIME_INVALID: playwright/test export missing or playwright-core version mismatch'
      }
      foreach ($entry in @('playwright\test.js', 'playwright\test.mjs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $pwSrc $entry))) {
          throw "PLAYWRIGHT_RUNTIME_INVALID: missing $entry"
        }
      }
      New-Item -ItemType Directory -Force -Path (Join-Path $guestRun 'input\node_modules') | Out-Null
      Copy-Item (Join-Path $pwSrc 'playwright') (Join-Path $guestRun 'input\node_modules\playwright') -Recurse -Force
      Copy-Item (Join-Path $pwSrc 'playwright-core') (Join-Path $guestRun 'input\node_modules\playwright-core') -Recurse -Force
      Write-Host '  playwright + playwright/test official expect -> input\node_modules'
    } else {
      Write-Host 'WARN: pw-bundle missing, smoke will report PLAYWRIGHT_UNAVAILABLE'
    }
    # EN-only
    # EN-only
    $autorunFile = Join-Path "${offlineWin}:" 'awp-golden\autorun.cmd'
    if (Test-Path -LiteralPath $autorunFile) {
      $a = Get-Content -LiteralPath $autorunFile -Raw
      $a = $a.Replace('-RunDir C:\awp-run', '-RunDir C:\awp-run >C:\awp-run\output\agent.log 2>&1')
      # EN-only
      # EN-only
      $bootLog = 'C:\awp-run\output\boot.log'
      $a = $a.Replace('@echo off', ('@echo off' + "`r`n" + 'if not exist C:\awp-run\output mkdir C:\awp-run\output 2>NUL' + "`r`n" + ('echo [%DATE% %TIME%] autorun-start>>' + $bootLog + ' 2>NUL')))
      $a = $a.Replace('call C:\awp-golden\setup-network.cmd >C:\awp-run\setup-network.log 2>&1', ('call C:\awp-golden\setup-network.cmd >C:\awp-run\setup-network.log 2>&1' + "`r`n" + ('echo [%DATE% %TIME%] network-done>>' + $bootLog + ' 2>NUL')))
      $jobCall = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\awp-run\input\job-object.ps1'
      $a = $a.Replace($jobCall, (('echo [%DATE% %TIME%] agent-launch>>' + $bootLog + ' 2>NUL' + "`r`n") + $jobCall))
      $a = $a.Replace('>C:\awp-run\output\agent.log 2>&1', ('>C:\awp-run\output\agent.log 2>&1' + "`r`n" + ('echo [%DATE% %TIME%] agent-exit-%ERRORLEVEL%>>' + $bootLog + ' 2>NUL')))
      Set-Content -LiteralPath $autorunFile -Value $a -Encoding ascii
      Write-Host '  autorun.cmd patched (agent.log + boot.log)'
    }
    Write-Host ("  offline inject: {0} files -> {1}:" -f (Get-ChildItem (Join-Path $guestRun 'input') -File).Count, $offlineWin)
  } finally {
    Dismount-VHD -Path $diffPath -ErrorAction SilentlyContinue
  }

  Write-Step "创建 VM $VmName"
  # EN-only
  # EN-only
  if ($MemoryMinMB -gt $MemoryStartupMB) { $MemoryMinMB = $MemoryStartupMB }
  if ($MemoryMaxMB -lt $MemoryStartupMB) { $MemoryMaxMB = $MemoryStartupMB }
  Write-Host ("  memory dynamic: min={0}MB start={1}MB max={2}MB" -f $MemoryMinMB, $MemoryStartupMB, $MemoryMaxMB)
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($MemoryStartupMB * 1MB) -VHDPath $diffPath -SwitchName $SwitchName | Out-Null
  Set-VM -Name $VmName -DynamicMemory `
    -MemoryMinimumBytes ($MemoryMinMB * 1MB) `
    -MemoryStartupBytes ($MemoryStartupMB * 1MB) `
    -MemoryMaximumBytes ($MemoryMaxMB * 1MB) `
    -CheckpointType Disabled -AutomaticStartAction Nothing -AutomaticStopAction TurnOff
  Set-VMProcessor -VMName $VmName -Count 4
  Set-VMFirmware -VMName $VmName -EnableSecureBoot On
  Get-VMIntegrationService -VMName $VmName | ForEach-Object {
    Enable-VMIntegrationService -VMName $VmName -Name $_.Name -ErrorAction SilentlyContinue
  }
  # EN-only
  try {
    $hostAdapter = Get-IsolatedAdapter $SwitchName
    if ($hostAdapter) {
      Get-NetNeighbor -InterfaceIndex $hostAdapter.ifIndex -AddressFamily IPv4 -IPAddress $GuestIp -ErrorAction SilentlyContinue |
        Remove-NetNeighbor -Confirm:$false -ErrorAction SilentlyContinue
      Write-Host "  flushed ARP for guest $GuestIp on $($hostAdapter.Name)"
    }
  } catch {
    Write-Host "  ARP flush skip: $($_.Exception.Message)"
  }
  Start-VM -Name $VmName

  Write-Step 'PowerShell Direct（ ， ）'
  # EN-only
  # EN-only
  $bootMinutes = [Math]::Min($BootReadyMinutes, $WaitMinutes)
  if ($bootMinutes -lt 1) { $bootMinutes = 1 }
  try {
    Wait-GuestReady $VmName $cred $bootMinutes $icFile
  } catch {
    Write-Host "GUEST_BOOT_TIMEOUT after ${bootMinutes}min — destroying VM for retry"
    try {
      $v = Get-VM -Name $VmName -ErrorAction SilentlyContinue
      if ($v -and $v.State -ne 'Off') { Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue }
      if ($v) { Remove-VM -Name $VmName -Force -ErrorAction SilentlyContinue }
    } catch { }
    throw ("PROVISIONING_TIMEOUT boot_ready>{0}min {1}" -f $bootMinutes, $_.Exception.Message)
  }
  Enable-GuestFileCopy $VmName
  # EN-only
  # EN-only
  # EN-only

  Write-Step 'Guest （ Hyper-V WMI， Direct）'
  # EN-only
  $tunnelTest = $false
  try {
    $req = [System.Net.HttpWebRequest]::Create("https://$($ProxyHostName):$ProxyPort/-/ping")
    $req.ServerCertificateValidationCallback = { $true }
    $req.Timeout = 5000
    $resp = $req.GetResponse()
    $tunnelTest = ($resp.StatusCode -eq 200)
    $resp.Close()
  } catch { $tunnelTest = $false }
  Write-Host ("  proxy [-/ping] from host: {0}" -f $tunnelTest)
  if (-not $tunnelTest) { throw 'PROXY_NOT_REACHABLE' }

  Write-Step 'secret-grants.json diff （autorun.cmd agent Guest run-local）'
  $grantsFile = Join-Path $AttemptDir 'secret-grants.json'
  if (Test-Path -LiteralPath $grantsFile) {
    Write-Host ("  grants file size: {0} bytes" -f ((Get-Item $grantsFile).Length))
  }

  Write-Step 'Guest Agent（ ，WMI ）'
  # EN-only
  # EN-only
  # EN-only
  $heartbeatIc = $null
  $deadline = (Get-Date).AddMinutes($WaitMinutes)
  $agentDone = $false
  do {
    Start-Sleep -Seconds 5
    $vmState = (Get-VM -Name $VmName -ErrorAction SilentlyContinue).State
    if ($heartbeatIc) {
      try {
        $hb = Get-HeartbeatIc $VmName
        $hbText = if ($hb) { '{0}/{1}' -f $hb.Name, $hb.PrimaryStatusDescription } else { 'n/a' }
      } catch { $hbText = 'n/a' }
    } else { $hbText = 'init' }
    Write-Host ("  {0} state={1} heartbeat={2}" -f (Get-Date -Format 'HH:mm:ss'), $vmState, $hbText)
    if ($vmState -eq 'Off') { break }
  } while ((Get-Date) -lt $deadline)
  if ($vmState -ne 'Off') {
    Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue
    throw 'GUEST_AGENT_TIMEOUT'
  }
  # EN-only
  # EN-only
  # EN-only

  Write-Step 'sidecar artifact（ diff ）'
  Mount-VHD -Path $diffPath
  try {
    $diskNumber = (Get-VHD -Path $diffPath).DiskNumber
    $part = Get-Partition -DiskNumber $diskNumber | Where-Object { $_.Size -gt 1GB } | Select-Object -First 1
    $pullDrive = $part.DriveLetter
    if (-not $pullDrive) { $pullDrive = ($part | Add-PartitionAccessPath -AssignDriveLetter -PassThru).DriveLetter }
    $guestOutput = Join-Path "${pullDrive}:" 'awp-run\output'
    # EN-only
    # EN-only
    foreach ($name in @('boot.log', 'agent.log', 'install.log', 'result.json', 'result.sig', 'manifest.json', 'manifest.sig', 'artifact.zip')) {
      try {
        $src = Join-Path $guestOutput $name
        if (Test-Path -LiteralPath $src) {
          Copy-Item -LiteralPath $src -Destination (Join-Path $outDir $name) -Force
          Write-Host ("  pulled {0}" -f $name)
        } elseif ($name -ne 'install.log' -and $name -ne 'agent.log' -and $name -ne 'boot.log') {
          throw "missing $name"
        }
      } catch {
        if ($name -ne 'install.log' -and $name -ne 'agent.log' -and $name -ne 'boot.log') { throw }
      }
    }
  } finally {
    Dismount-VHD -Path $diffPath -ErrorAction SilentlyContinue
  }
  $ok = $true
}
finally {
  Write-Step 'attempt VM'
  $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if ($vm) {
    # Stop-VM -TurnOff 是异步的：VM 仍在 Running/TurningOff 时立刻 Remove-VM 会报 InvalidState
    # （对象在当前状态时无法执行此操作）→ 污染错误日志。改为轮询等到 Off 再删，并对删除做重试。
    if ($vm.State -ne 'Off') {
      Stop-VM -Name $VmName -TurnOff -Force -ErrorAction SilentlyContinue
    }
    $waited = 0
    while ($waited -lt 30) {
      $st = (Get-VM -Name $VmName -ErrorAction SilentlyContinue).State
      if ($st -eq 'Off') { break }
      Start-Sleep -Seconds 1
      $waited += 1
    }
    $removed = $false
    for ($i = 0; $i -lt 3 -and -not $removed; $i++) {
      try {
        Remove-VM -Name $VmName -Force -ErrorAction Stop
        $removed = $true
      } catch {
        Write-Host "  Remove-VM retry $($i + 1) failed: $($_.Exception.Message)"
        Start-Sleep -Seconds 2
      }
    }
    if (-not $removed) { Write-Host "  WARN: could not remove VM $VmName (left for janitor)" }
  }
  if (Test-Path $diffPath) { Remove-Item -LiteralPath $diffPath -Force -ErrorAction SilentlyContinue }
  Write-Host "Destroyed $VmName"
}

if (-not $ok) { throw 'STATIC_LANE_FAILED' }
Write-Host 'STATIC_LANE_VM_OK'
exit 0
