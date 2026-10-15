# 生成 secret-broker mTLS 证书。Windows PowerShell 5.1 不能导出 PKCS#8，改走 Node 22。
param(
  [string]$OutDir = ""
)
$ErrorActionPreference = 'Stop'
$mjs = Join-Path $PSScriptRoot 'gen-dev-pki.mjs'
if (-not (Test-Path $mjs)) { throw "missing $mjs" }
if (-not $OutDir) {
  $OutDir = Join-Path $PSScriptRoot '..\secret-broker\dev-certs'
}
$node = Get-Command node -ErrorAction Stop
$p = Start-Process -FilePath $node.Source -ArgumentList @($mjs, $OutDir) -WorkingDirectory (Split-Path $PSScriptRoot -Parent) -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { exit $p.ExitCode }
