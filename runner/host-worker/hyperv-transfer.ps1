#Requires -RunAsAdministrator
# Host Worker 用 PowerShell Direct 注入输入、拉回 sidecar。禁止 Default Switch。
# Copy-VMFile 在本机 Hyper-V 只有 Host->Guest；Guest->Host 走 Direct Base64。

param(
  [Parameter(Mandatory = $true)][string]$VmName,
  [Parameter(Mandatory = $true)][string]$AdminPassword,
  [Parameter(Mandatory = $true)][string]$HostInputDir,
  [Parameter(Mandatory = $true)][string]$HostOutputDir,
  [string]$GuestRunDir = 'C:\awp-run'
)

$ErrorActionPreference = 'Stop'
$cred = New-Object System.Management.Automation.PSCredential (
  'Administrator',
  (ConvertTo-SecureString $AdminPassword -AsPlainText -Force)
)

function Copy-HostToGuest([string]$LocalPath, [string]$GuestPath) {
  Copy-VMFile -Name $VmName -SourcePath $LocalPath -DestinationPath $GuestPath -FileSource Host -CreateFullPath -Force
}

function Get-GuestFile([string]$GuestPath, [string]$LocalPath) {
  $b64 = Invoke-Command -VMName $VmName -Credential $cred -ScriptBlock {
    param($p)
    if (-not (Test-Path -LiteralPath $p)) { throw "missing $p" }
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))
  } -ArgumentList $GuestPath
  $dir = Split-Path -Parent $LocalPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllBytes($LocalPath, [Convert]::FromBase64String([string]$b64))
}

Invoke-Command -VMName $VmName -Credential $cred -ScriptBlock {
  param($d)
  New-Item -ItemType Directory -Force -Path (Join-Path $d 'input'), (Join-Path $d 'output'), (Join-Path $d 'workspace'), (Join-Path $d 'suite') | Out-Null
} -ArgumentList $GuestRunDir

Get-ChildItem -LiteralPath $HostInputDir -File | ForEach-Object {
  Copy-HostToGuest $_.FullName (Join-Path $GuestRunDir ("input\" + $_.Name))
}

$suiteDir = Join-Path $HostInputDir '..\suite'
if (Test-Path $suiteDir) {
  Get-ChildItem -LiteralPath $suiteDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring((Resolve-Path $suiteDir).Path.Length).TrimStart('\')
    Copy-HostToGuest $_.FullName (Join-Path $GuestRunDir ("suite\" + $rel))
  }
}

Invoke-Command -VMName $VmName -Credential $cred -ScriptBlock {
  param($d)
  $env:AWP_RUN_DIR = $d
  & node (Join-Path $d 'input\guest-agent.mjs')
  if ($LASTEXITCODE -ne 0) { throw "guest-agent exit $LASTEXITCODE" }
} -ArgumentList $GuestRunDir

New-Item -ItemType Directory -Force -Path $HostOutputDir | Out-Null
foreach ($name in @('result.json', 'manifest.json', 'junit.xml')) {
  Get-GuestFile (Join-Path $GuestRunDir ("output\" + $name)) (Join-Path $HostOutputDir $name)
}
