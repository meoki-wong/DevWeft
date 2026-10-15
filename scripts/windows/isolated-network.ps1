# EN-only
# EN-only

function Assert-NotDefaultSwitch([string]$name) {
  if ($name -eq 'Default Switch') { throw 'Default Switch' }
}

function Ensure-IsolatedSwitch([string]$name) {
  Assert-NotDefaultSwitch $name
  Import-Module Hyper-V -ErrorAction Stop
  $sw = Get-VMSwitch -Name $name -ErrorAction SilentlyContinue
  if (-not $sw) {
    Write-Host "Internal $name"
    return New-VMSwitch -Name $name -SwitchType Internal
  }
  if ($sw.Name -eq 'Default Switch') { throw 'Default Switch' }
  if ($sw.SwitchType -eq 'External') { throw "$name External" }
  if ($sw.SwitchType -eq 'Private') {
    $vms = @(Get-VM | Where-Object { $_.NetworkAdapters.SwitchName -eq $name })
    if ($vms.Count -gt 0) {
      throw ("无法把 $name 从 Private 改为 Internal，仍被 VM 占用: " + ($vms.Name -join ', '))
    }
    Write-Host "$name Private Internal（Guest npm ）"
    Remove-VMSwitch -Name $name -Force
    return New-VMSwitch -Name $name -SwitchType Internal
  }
  return $sw
}

function Get-IsolatedAdapter([string]$switchName) {
  $want = "vEthernet ($switchName)"
  $a = Get-NetAdapter -Name $want -ErrorAction SilentlyContinue
  if ($a) { return $a }
  return Get-NetAdapter | Where-Object { $_.Name -like "*${switchName}*" } | Select-Object -First 1
}

function Set-IsolatedHostIp {
  param(
    [string]$SwitchName,
    [string]$Ip,
    [int]$Prefix = 24
  )
  $adapter = Get-IsolatedAdapter $SwitchName
  if (-not $adapter) { throw "$SwitchName" }
  Disable-NetAdapterBinding -Name $adapter.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
  $hit = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $Ip }
  if ($hit) { return $adapter }
  Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' } |
    ForEach-Object {
      Remove-NetIPAddress -InterfaceIndex $_.InterfaceIndex -IPAddress $_.IPAddress -Confirm:$false
    }
  New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $Ip -PrefixLength $Prefix | Out-Null
  return $adapter
}

function Set-IsolatedHostFirewall {
  param(
    [string]$ProxyIp,
    [int]$ProxyPort,
    [string]$GuestCidr,
    [int[]]$BlockPorts
  )
  # EN-only Idempotent: if both rules already exist, skip (avoid admin churn every lane).
  $names = @('awp-npm-proxy-in', 'awp-isolated-block-control-plane')
  $allExist = $true
  foreach ($id in $names) { if (-not (Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue)) { $allExist = $false } }
  if ($allExist) { Write-Host 'firewall rules already present; skip'; return }
  foreach ($id in $names) {
    try {
      if (Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -Name $id -ErrorAction SilentlyContinue -Confirm:$false
      }
    } catch {
      Write-Host "  firewall remove skip ${id}: $($_.Exception.Message)"
    }
  }
  try {
    New-NetFirewallRule -Name 'awp-npm-proxy-in' -DisplayName 'agent platform npm proxy inbound' `
      -Direction Inbound -Action Allow -Protocol TCP `
      -LocalAddress $ProxyIp -LocalPort $ProxyPort -RemoteAddress $GuestCidr -ErrorAction Stop | Out-Null
  } catch {
    # EN-only
    if (-not (Get-NetFirewallRule -Name 'awp-npm-proxy-in' -ErrorAction SilentlyContinue)) { throw }
  }
  try {
    New-NetFirewallRule -Name 'awp-isolated-block-control-plane' -DisplayName 'agent platform isolated block control plane' `
      -Direction Inbound -Action Block -Protocol TCP `
      -LocalAddress $ProxyIp -LocalPort $BlockPorts -ErrorAction Stop | Out-Null
  } catch {
    if (-not (Get-NetFirewallRule -Name 'awp-isolated-block-control-plane' -ErrorAction SilentlyContinue)) { throw }
  }
}

# EN-only Read-only presence probe (no admin / no Hyper-V cmdlet needed): host adapter + proxy IP + both firewall rules.
# Uses Get-NetAdapter (adapter 'vEthernet (<switch>)' exists iff the vSwitch exists), so a fully-provisioned host can
# be verified by a non-elevated host-worker. Returns $true only when nothing needs to be created.
function Test-IsolatedNetPresent {
  param([string]$SwitchName, [string]$ProxyIp)
  $a = Get-IsolatedAdapter $SwitchName
  if (-not $a) { return $false }
  $ip = Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $ProxyIp }
  if (-not $ip) { return $false }
  foreach ($id in @('awp-npm-proxy-in', 'awp-isolated-block-control-plane')) {
    if (-not (Get-NetFirewallRule -Name $id -ErrorAction SilentlyContinue)) { return $false }
  }
  return $true
}
