param(
  [string]$SwitchName = 'awp-isolated',
  [string]$ProxyIp = '192.168.250.1',
  [int]$ProxyPort = 443,
  [string]$GuestCidr = '192.168.250.0/24',
  [int[]]$BlockPorts = @(8787, 8788)
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'isolated-network.ps1')

if (Test-IsolatedNetPresent -SwitchName $SwitchName -ProxyIp $ProxyIp) {
  Write-Host "ISOLATED_NET_OK switch=$SwitchName ip=$ProxyIp port=$ProxyPort (preexisting)"
  exit 0
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'NEEDS_ADMIN: run scripts/windows/ensure-isolated-network.ps1 once from an elevated PowerShell.'
}

Ensure-IsolatedSwitch $SwitchName | Out-Null
Set-IsolatedHostIp -SwitchName $SwitchName -Ip $ProxyIp -Prefix 24 | Out-Null
Set-IsolatedHostFirewall -ProxyIp $ProxyIp -ProxyPort $ProxyPort -GuestCidr $GuestCidr -BlockPorts $BlockPorts
Write-Host "ISOLATED_NET_OK switch=$SwitchName ip=$ProxyIp port=$ProxyPort"
