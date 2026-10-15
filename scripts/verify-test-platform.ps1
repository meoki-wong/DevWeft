# 部署验收：控制面健康、broker 端口、bootstrap 产物、Hyper-V 目录/交换机、PKI。
# 不启动服务。由 deploy-test-platform.ps1 在末尾调用，也可单独执行。

param(
  [int]$Port = 8787,
  [int]$BrokerPort = 8788,
  [string]$RunnerRoot,
  [string]$SwitchName = 'awp-isolated',
  [switch]$SkipHyperV,
  [switch]$SkipApiSmoke
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $RunnerRoot) { $RunnerRoot = Join-Path $Root 'data\runner' }
$failed = New-Object System.Collections.Generic.List[string]
$warned = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

function Test-TcpListen([string]$TargetHost, [int]$ListenPort, [int]$TimeoutMs = 1000) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($TargetHost, $ListenPort, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Add-Fail([string]$msg) {
  $failed.Add($msg) | Out-Null
  Write-Host "FAIL  $msg" -ForegroundColor Red
}

function Add-Warn([string]$msg) {
  $warned.Add($msg) | Out-Null
  Write-Host "WARN  $msg" -ForegroundColor Yellow
}

function Add-Ok([string]$msg) {
  Write-Host "OK    $msg" -ForegroundColor Green
}

Write-Step '控制面 /api/health'
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
  if (-not $health.ok) { Add-Fail "health.ok != true" }
  else { Add-Ok ("health ok  contract={0} schema={1}" -f $health.testing.contractVersion, $health.testing.schemaVersion) }
  if (-not $health.testing -or -not $health.testing.contractVersion -or -not $health.testing.migrationChecksum) {
    Add-Fail 'health.testing 缺少 contractVersion / schemaVersion / migrationChecksum'
  }
} catch {
  Add-Fail "无法访问 http://127.0.0.1:$Port/api/health : $($_.Exception.Message)"
}

Write-Step 'secret broker 监听'
if (Test-TcpListen '127.0.0.1' $BrokerPort) {
  Add-Ok "127.0.0.1:$BrokerPort 已监听（mTLS，不走明文 HTTP）"
} else {
  Add-Fail "127.0.0.1:$BrokerPort 未监听"
}

Write-Step 'bootstrap 产物'
$tokenFile = Join-Path $Root 'data\bootstrap-admin.token'
$summaryFile = Join-Path $Root 'data\bootstrap-admin.json'
if (Test-Path $tokenFile) {
  $tok = (Get-Content $tokenFile -Raw).Trim()
  if ($tok.Length -lt 32) { Add-Fail 'bootstrap-admin.token 过短' } else { Add-Ok "token 文件 $tokenFile" }
} else {
  Add-Fail "缺少 $tokenFile"
}
if (Test-Path $summaryFile) {
  $sum = Get-Content $summaryFile -Raw | ConvertFrom-Json
  Add-Ok ("principal={0} repo={1} slug={2}" -f $sum.principalId, $sum.repoId, $sum.slug)
  if (-not $sum.canonicalUrl) {
    Add-Warn '未登记 git remote。部署时加 -GitRemoteUrl，或把 demo-app 放在本仓同级目录。'
  } else {
    Add-Ok "remote $($sum.canonicalUrl)"
  }
} else {
  Add-Fail "缺少 $summaryFile"
}

Write-Step 'PKI'
$certDir = Join-Path $Root 'secret-broker\dev-certs'
foreach ($n in @('ca.crt', 'broker.crt', 'broker.key', 'control-plane.crt', 'control-plane.key', 'worker.crt', 'worker.key', 'trust.json')) {
  $p = Join-Path $certDir $n
  if (Test-Path $p) { Add-Ok $n } else { Add-Fail "缺少 $p" }
}

if (-not $SkipApiSmoke -and (Test-Path $tokenFile) -and (Test-Path $summaryFile)) {
  Write-Step 'API 冒烟 POST /v1/git-contexts:resolve'
  $sum = Get-Content $summaryFile -Raw | ConvertFrom-Json
  $tok = (Get-Content $tokenFile -Raw).Trim()
  if ($sum.canonicalUrl) {
    $oid = '0' * 40
    $bodyObj = @{
      remotes        = @(@{ name = 'origin'; url = [string]$sum.canonicalUrl })
      sourceRef      = 'refs/heads/deploy-smoke'
      headCommitOid  = $oid
      objectFormat   = 'sha1'
    }
    $json = $bodyObj | ConvertTo-Json -Compress
    try {
      $resp = Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:$Port/v1/git-contexts:resolve" `
        -ContentType 'application/json' -Body $json -TimeoutSec 10 -Headers @{
          Authorization        = "Bearer $tok"
          'Idempotency-Key'    = "deploy-smoke-$([guid]::NewGuid())"
          'X-Client-Version'   = '1.0.0'
        }
      if ($resp.error) {
        Add-Fail ("resolve error {0}" -f ($resp.error | ConvertTo-Json -Compress))
      } elseif ($resp.data.repoId -ne $sum.repoId) {
        Add-Fail "resolve repoId 不匹配"
      } else {
        Add-Ok ("resolved repoId={0}" -f $resp.data.repoId)
      }
    } catch {
      Add-Fail "git-contexts:resolve 失败: $($_.Exception.Message)"
    }
  } else {
    Add-Warn '跳过 resolve 冒烟（无 canonicalUrl）'
  }
}

if (-not $SkipHyperV) {
  Write-Step 'Hyper-V 工作目录'
  foreach ($p in @("$RunnerRoot\images", "$RunnerRoot\attempts", "$RunnerRoot\scratch", "$RunnerRoot\certs")) {
    if (Test-Path $p) { Add-Ok $p } else { Add-Warn "缺少 $p" }
  }
  $golden = Join-Path $RunnerRoot 'images\golden.vhdx'
  if (Test-Path $golden) { Add-Ok "Golden $golden" } else { Add-Warn "尚无 Golden VHDX（放到 $golden 后可跑完整 VM PoC）" }

  try {
    Import-Module Hyper-V -ErrorAction Stop
    $sw = Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue
    if (-not $sw) {
      Add-Warn "交换机 $SwitchName 不存在（管理员重新跑部署脚本可创建）"
    } elseif ($sw.Name -eq 'Default Switch') {
      Add-Fail '禁止使用 Default Switch'
    } else {
      Add-Ok ("switch {0} ({1})" -f $sw.Name, $sw.SwitchType)
    }
  } catch {
    Add-Warn "无法查询 Hyper-V：$($_.Exception.Message)"
  }
}

Write-Host ''
if ($failed.Count) {
  Write-Host ("verify failed: {0} item(s)." -f $failed.Count) -ForegroundColor Red
  $failed | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
if ($warned.Count) {
  Write-Host ("verify passed with {0} warning(s)." -f $warned.Count) -ForegroundColor Yellow
} else {
  Write-Host 'verify passed.' -ForegroundColor Green
}
exit 0
