# 清理 vitest 残留的 team.db 副本（曾把 C 盘 Temp 灌到 200GB+）
# 安全：只删 awp-testdb-* 目录；不影响生产 data/team.db 与 Hyper-V 镜像

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temp = [System.IO.Path]::GetTempPath()
$projectTmp = Join-Path $root 'data\.testdb-tmp'
$roots = @($temp, $projectTmp) | Where-Object { $_ -and (Test-Path $_) }

$freed = 0
$count = 0
foreach ($base in $roots) {
  Get-ChildItem $base -Directory -Filter 'awp-testdb-*' -ErrorAction SilentlyContinue | ForEach-Object {
    $size = 0
    try {
      $size = (Get-ChildItem $_.FullName -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
    } catch { $size = 0 }
    try {
      Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop
      $count++
      if ($size) { $freed += $size }
      Write-Output ("deleted {0}" -f $_.FullName)
    } catch {
      Write-Output ("skip (locked) {0} : {1}" -f $_.Name, $_.Exception.Message)
    }
  }
}

# 可选：runner attempts 残留（需 DB 中无活动 lease）
$runnerRoot = if ($env:AWP_RUNNER_ROOT) { $env:AWP_RUNNER_ROOT } else { Join-Path $root 'data\runner' }
$attempts = Join-Path $runnerRoot 'attempts'
if ($env:AWP_CLEAN_ATTEMPTS -eq '1' -and (Test-Path $attempts)) {
  Write-Output '--- cleaning inactive runner attempts (AWP_CLEAN_ATTEMPTS=1) ---'
  Push-Location $root
  try {
    & node runner/host-worker/janitor.mjs
  } catch {
    Write-Output ("janitor failed: {0}" -f $_.Exception.Message)
  }
  Pop-Location
}

Write-Output ("`n=== Done: removed {0} dirs, freed ~{1} GB ===" -f $count, [math]::Round($freed/1GB, 2))
$drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($root).Substring(0, 1))
Write-Output ("Drive free now: {0} GB" -f [math]::Round($drive.Free/1GB, 1))
