# Shared, non-destructive Hyper-V network helpers. All checks in Assert-IsolatedNetworkPlan are read-only.

function Assert-NotDefaultSwitch([string]$Name) {
  if ($Name -eq 'Default Switch') { throw 'The Hyper-V Default Switch is not supported for isolated runner networking.' }
}

function ConvertTo-IPv4Number([string]$Address) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "Invalid IPv4 address: $Address"
  }
  $number = [UInt64]0
  foreach ($octet in $parsed.GetAddressBytes()) { $number = ($number * 256) + [UInt64]$octet }
  return $number
}

function Get-IPv4Range([string]$Cidr) {
  $parts = $Cidr.Split('/')
  if ($parts.Count -ne 2) { throw "Invalid IPv4 CIDR: $Cidr" }
  $prefix = 0
  if (-not [int]::TryParse($parts[1], [ref]$prefix) -or $prefix -lt 0 -or $prefix -gt 32) {
    throw "Invalid IPv4 CIDR prefix: $Cidr"
  }
  $address = ConvertTo-IPv4Number $parts[0]
  $size = [UInt64][Math]::Pow(2, 32 - $prefix)
  $start = [UInt64]([Math]::Floor($address / $size) * $size)
  return [pscustomobject]@{ Start = $start; End = ($start + $size - 1); PrefixLength = $prefix }
}

function Assert-PrivateIpv4Cidr([string]$Cidr) {
  if ($Cidr -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/24$') {
    throw 'AWP_VM_NETWORK_CIDR must be an RFC1918 IPv4 /24 network such as 192.168.250.0/24.'
  }
  $octets = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
  if (@($octets | Where-Object { $_ -lt 0 -or $_ -gt 255 }).Count -gt 0 -or $octets[3] -ne 0) {
    throw 'AWP_VM_NETWORK_CIDR must be a valid /24 network address ending in .0.'
  }
  $private = (($octets[0] -eq 10) -or
    ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
    ($octets[0] -eq 192 -and $octets[1] -eq 168))
  if (-not $private) { throw 'AWP_VM_NETWORK_CIDR must be inside RFC1918 private address space.' }
  if ((('{0}.{1}.{2}.0/24' -f $octets[0], $octets[1], $octets[2])) -ne $Cidr) {
    throw 'AWP_VM_NETWORK_CIDR must use canonical decimal octets.'
  }
  return [pscustomobject]@{ Cidr = $Cidr; PrefixLength = 24; ProxyIp = ('{0}.{1}.{2}.1' -f $octets[0], $octets[1], $octets[2]) }
}

function Test-IPv4RangesOverlap($Left, $Right) {
  return ($Left.Start -le $Right.End) -and ($Right.Start -le $Left.End)
}

function Get-IsolatedAdapter([string]$SwitchName) {
  $want = "vEthernet ($SwitchName)"
  $matches = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $want })
  if ($matches.Count -gt 1) { throw "NETWORK_ADAPTER_CONFLICT: multiple adapters have exact name '$want'." }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Get-ExactVMSwitch([string]$Name) {
  $matches = @(Get-VMSwitch -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Name })
  if ($matches.Count -gt 1) { throw "SWITCH_NAME_CONFLICT: multiple switches have exact name '$Name'." }
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}

function Ensure-IsolatedSwitch([string]$Name) {
  Assert-NotDefaultSwitch $Name
  Import-Module Hyper-V -ErrorAction Stop
  $sw = Get-ExactVMSwitch $Name
  if ($sw) {
    if ($sw.SwitchType -ne 'Internal') {
      throw "SWITCH_TYPE_CONFLICT: '$Name' is $($sw.SwitchType); the deployment will not replace or reconfigure an existing switch. Choose a new AWP_VM_SWITCH_NAME or review it manually."
    }
    Write-Host "Reusing Internal switch '$Name'."
    return $sw
  }
  Write-Host "Creating Internal switch '$Name'."
  return New-VMSwitch -Name $Name -SwitchType Internal -ErrorAction Stop
}

function Get-FirewallFilterValues($Value) {
  $parts = @()
  foreach ($item in @($Value)) {
    foreach ($part in ([string]$item).Split(',')) {
      $trimmed = $part.Trim()
      if ($trimmed) { $parts += $trimmed }
    }
  }
  return (@($parts | Sort-Object -Unique) -join ',')
}

function Assert-FirewallRuleCompatible {
  param(
    [string]$Name,
    [string]$Direction,
    [string]$Action,
    [string]$LocalAddress,
    [string[]]$LocalPorts,
    [string[]]$RemoteAddresses
  )
  $rules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Name })
  if ($rules.Count -eq 0) { return $false }
  if ($rules.Count -ne 1) { throw "FIREWALL_RULE_CONFLICT: multiple rules use name '$Name'; review them manually." }
  $rule = $rules[0]
  $port = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
  $address = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule
  $expectedPorts = Get-FirewallFilterValues $LocalPorts
  $actualPorts = Get-FirewallFilterValues $port.LocalPort
  $expectedRemote = Get-FirewallFilterValues $RemoteAddresses
  $actualRemote = Get-FirewallFilterValues $address.RemoteAddress
  $actualLocal = Get-FirewallFilterValues $address.LocalAddress
  if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne $Direction -or
      [string]$rule.Action -ne $Action -or [string]$rule.Profile -ne 'Any' -or
      [string]$port.Protocol -ne 'TCP' -or $actualPorts -ne $expectedPorts -or
      $actualLocal -ne $LocalAddress -or $actualRemote -ne $expectedRemote) {
    throw "FIREWALL_RULE_CONFLICT: rule '$Name' exists with different settings; it was preserved. Review or rename it manually before retrying."
  }
  return $true
}

function Assert-IsolatedNetworkPlan {
  param(
    [string]$SwitchName,
    [string]$ProxyIp,
    [string]$GuestCidr,
    [string[]]$BlockPorts = @('8787', '8788')
  )
  Assert-NotDefaultSwitch $SwitchName
  $network = Assert-PrivateIpv4Cidr $GuestCidr
  if ($ProxyIp -ne $network.ProxyIp) {
    throw "NETWORK_ADDRESS_MISMATCH: proxy must be $($network.ProxyIp) for $GuestCidr."
  }
  Import-Module Hyper-V -ErrorAction Stop
  $switch = Get-ExactVMSwitch $SwitchName
  if ($switch -and $switch.SwitchType -ne 'Internal') {
    throw "SWITCH_TYPE_CONFLICT: '$SwitchName' is $($switch.SwitchType); existing switches are never removed or converted. Choose a new switch name."
  }
  $adapter = Get-IsolatedAdapter $SwitchName
  if ($switch -and -not $adapter) { throw "NETWORK_ADAPTER_MISSING: switch '$SwitchName' exists but its exact host adapter was not found." }
  if (-not $switch -and $adapter) { throw "NETWORK_ADAPTER_ORPHANED: '$($adapter.Name)' exists without a matching Hyper-V switch; inspect it manually." }
  $targetIndex = if ($adapter) { [int]$adapter.ifIndex } else { -1 }
  $wantedRange = Get-IPv4Range $GuestCidr
  foreach ($ip in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
    if ($ip.IPAddress -eq '127.0.0.1') { continue }
    $range = Get-IPv4Range ("{0}/{1}" -f $ip.IPAddress, $ip.PrefixLength)
    if ([int]$ip.InterfaceIndex -eq $targetIndex) {
      if ($ip.IPAddress -ne $ProxyIp -or [int]$ip.PrefixLength -ne 24) {
        throw "TARGET_ADAPTER_ADDRESS_CONFLICT: '$($adapter.Name)' already has $($ip.IPAddress)/$($ip.PrefixLength); it was preserved. Remove or change it manually after review."
      }
    } elseif (Test-IPv4RangesOverlap $range $wantedRange) {
      throw "SUBNET_OVERLAP: $GuestCidr overlaps host address $($ip.IPAddress)/$($ip.PrefixLength) on interface $($ip.InterfaceAlias) ($($ip.InterfaceIndex)). Choose a different private /24."
    }
  }
  foreach ($route in @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
    if ([int]$route.InterfaceIndex -eq $targetIndex) { continue }
    $routeRange = Get-IPv4Range ([string]$route.DestinationPrefix)
    if ($routeRange.PrefixLength -eq 0) { continue }
    if (Test-IPv4RangesOverlap $routeRange $wantedRange) {
      throw "ROUTE_OVERLAP: $GuestCidr overlaps route $($route.DestinationPrefix) on interface $($route.InterfaceIndex). Choose a different private /24."
    }
  }
  [void](Assert-FirewallRuleCompatible -Name 'awp-npm-proxy-in' -Direction 'Inbound' -Action 'Allow' `
    -LocalAddress $ProxyIp -LocalPorts @('443') -RemoteAddresses @($GuestCidr))
  [void](Assert-FirewallRuleCompatible -Name 'awp-isolated-block-control-plane' -Direction 'Inbound' -Action 'Block' `
    -LocalAddress $ProxyIp -LocalPorts $BlockPorts -RemoteAddresses @('Any'))
  return [pscustomobject]@{ Switch = $switch; Adapter = $adapter; Network = $network }
}

function Set-IsolatedHostIp {
  param([string]$SwitchName, [string]$Ip, [int]$Prefix = 24)
  $adapter = Get-IsolatedAdapter $SwitchName
  if (-not $adapter) { throw "NETWORK_ADAPTER_MISSING: expected exact adapter 'vEthernet ($SwitchName)'." }
  $existing = @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    if ($existing.Count -eq 1 -and $existing[0].IPAddress -eq $Ip -and [int]$existing[0].PrefixLength -eq $Prefix) { return $adapter }
    throw "TARGET_ADAPTER_ADDRESS_CONFLICT: '$($adapter.Name)' has existing IPv4 configuration; it was preserved."
  }
  New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $Ip -PrefixLength $Prefix -ErrorAction Stop | Out-Null
  return $adapter
}

function Set-IsolatedHostFirewall {
  param([string]$ProxyIp, [int]$ProxyPort, [string]$GuestCidr, [int[]]$BlockPorts)
  $rules = @(
    @{ Name = 'awp-npm-proxy-in'; DisplayName = 'DevWeft isolated npm proxy inbound'; Direction = 'Inbound'; Action = 'Allow'; LocalPorts = @("$ProxyPort"); RemoteAddresses = @($GuestCidr) },
    @{ Name = 'awp-isolated-block-control-plane'; DisplayName = 'DevWeft isolated control plane block'; Direction = 'Inbound'; Action = 'Block'; LocalPorts = @($BlockPorts | ForEach-Object { "$_" }); RemoteAddresses = @('Any') }
  )
  foreach ($item in $rules) {
    if (Assert-FirewallRuleCompatible -Name $item.Name -Direction $item.Direction -Action $item.Action `
        -LocalAddress $ProxyIp -LocalPorts $item.LocalPorts -RemoteAddresses $item.RemoteAddresses) {
      Write-Host "Reusing compatible firewall rule '$($item.Name)'."
      continue
    }
    New-NetFirewallRule -Name $item.Name -DisplayName $item.DisplayName -Direction Inbound -Action $item.Action `
      -Protocol TCP -Profile Any -LocalAddress $ProxyIp -LocalPort $item.LocalPorts `
      -RemoteAddress $item.RemoteAddresses -ErrorAction Stop | Out-Null
  }
}
