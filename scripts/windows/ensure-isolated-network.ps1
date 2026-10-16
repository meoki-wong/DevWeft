param(
  [string]$SwitchName = $(if ($env:AWP_VM_SWITCH_NAME) { $env:AWP_VM_SWITCH_NAME } else { 'awp-isolated' }),
  [string]$GuestCidr = $(if ($env:AWP_VM_NETWORK_CIDR) { $env:AWP_VM_NETWORK_CIDR } else { '192.168.250.0/24' }),
  [string]$ProxyIp,
  [int]$ProxyPort = 443,
  [int[]]$BlockPorts = @(8787, 8788, 8791, 8792),
  [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot '..\Deploy.Common.ps1')
Import-DevWeftDeploymentEnv -Root $Root -Optional
. (Join-Path $PSScriptRoot 'isolated-network.ps1')
if (-not $PSBoundParameters.ContainsKey('SwitchName') -and $env:AWP_VM_SWITCH_NAME) { $SwitchName = $env:AWP_VM_SWITCH_NAME }
if (-not $PSBoundParameters.ContainsKey('GuestCidr') -and $env:AWP_VM_NETWORK_CIDR) { $GuestCidr = $env:AWP_VM_NETWORK_CIDR }
if ($ProxyPort -ne 443) { throw 'ProxyPort is fixed at 443 by the runner network policy.' }

$network = Assert-PrivateIpv4Cidr $GuestCidr
if (-not $ProxyIp) { $ProxyIp = $network.ProxyIp }
$plan = Assert-IsolatedNetworkPlan -SwitchName $SwitchName -ProxyIp $ProxyIp -GuestCidr $GuestCidr `
  -BlockPorts @($BlockPorts | ForEach-Object { "$_" })

if ($PreflightOnly) {
  Write-Host "ISOLATED_NET_PREFLIGHT_OK switch=$SwitchName cidr=$GuestCidr proxy=$ProxyIp (read-only; no changes made)"
  exit 0
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'NEEDS_ADMIN: run scripts/windows/ensure-isolated-network.ps1 once from an elevated PowerShell.'
}

Ensure-IsolatedSwitch $SwitchName | Out-Null
$adapter = $null
for ($attempt = 0; $attempt -lt 30 -and -not $adapter; $attempt++) {
  $adapter = Get-IsolatedAdapter $SwitchName
  if (-not $adapter) { Start-Sleep -Milliseconds 500 }
}
if (-not $adapter) { throw "NETWORK_ADAPTER_MISSING: Hyper-V did not create 'vEthernet ($SwitchName)'." }
Assert-IsolatedNetworkPlan -SwitchName $SwitchName -ProxyIp $ProxyIp -GuestCidr $GuestCidr `
  -BlockPorts @($BlockPorts | ForEach-Object { "$_" }) | Out-Null
Set-IsolatedHostIp -SwitchName $SwitchName -Ip $ProxyIp -Prefix 24 | Out-Null
Set-IsolatedHostFirewall -ProxyIp $ProxyIp -ProxyPort $ProxyPort -GuestCidr $GuestCidr -BlockPorts $BlockPorts

# Recheck the final settings. Existing resources are only reused when they exactly match this policy.
Assert-IsolatedNetworkPlan -SwitchName $SwitchName -ProxyIp $ProxyIp -GuestCidr $GuestCidr `
  -BlockPorts @($BlockPorts | ForEach-Object { "$_" }) | Out-Null
Write-Host "ISOLATED_NET_OK switch=$SwitchName cidr=$GuestCidr ip=$ProxyIp port=$ProxyPort"
