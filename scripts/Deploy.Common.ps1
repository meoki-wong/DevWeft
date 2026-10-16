function Import-DevWeftEnvFile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Optional
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    if ($Optional) { return }
    throw "Environment file is missing: $Path"
  }

  $lineNumber = 0
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $lineNumber++
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    if ($line -notmatch '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      throw "Invalid environment entry at $Path line $lineNumber. Use NAME=value."
    }

    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:$name" -Value $value
  }
}

function Import-DevWeftDeploymentEnv {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$Optional
  )

  $current = Join-Path $Root 'data\deploy.env'
  $legacy = Join-Path $Root 'scripts\deploy.env'
  if (-not (Test-Path -LiteralPath $current) -and (Test-Path -LiteralPath $legacy)) {
    Copy-Item -LiteralPath $legacy -Destination $current
    Write-Warning 'Migrated scripts\deploy.env to data\deploy.env. The data path is now canonical.'
  }
  if (-not (Test-Path -LiteralPath $current) -and $Optional) { return }
  Import-DevWeftEnvFile -Path $current
}

function Assert-DevWeftRuntime {
  [CmdletBinding()]
  param([switch]$RequireGit)

  $node = Get-Command node -ErrorAction Stop
  $versionText = (& node -p 'process.versions.node').Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    throw 'Could not read the installed Node.js version.'
  }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  $supported = ($major -eq 22 -and $minor -ge 12) -or $major -eq 24 -or $major -ge 26
  if (-not $supported) { throw "Node.js 22.12+, 24+, or 26+ is required; found v$versionText at $($node.Source)." }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is missing from PATH. Repair the Node.js installation, then retry.' }
  if ($RequireGit -and -not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is missing from PATH.' }
  Write-Host "Node.js v$versionText and npm are available."
  if ($RequireGit) { Write-Host ((& git --version).Trim()) }
}

function Assert-DevWeftPort {
  param([string]$Name, [string]$Value)
  if (-not $Value) { return }
  $port = 0
  if (-not [int]::TryParse($Value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "$Name must be a TCP port from 1 through 65535."
  }
}
