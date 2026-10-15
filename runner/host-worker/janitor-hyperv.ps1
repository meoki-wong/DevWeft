#Requires -RunAsAdministrator
# Janitor Hyper-V 残留清理（§21.6）：删除不属于活动 attempt 的 awp-run-* VM 与差分盘。
# 由 runner/host-worker/janitor.mjs --hyperv 调用；只动平台命名前缀，绝不碰其他 VM。

$ErrorActionPreference = 'Continue'
Import-Module Hyper-V -ErrorAction Stop

$active = @()
try {
  $stdout = & node -e "const db=require('better-sqlite3')(process.env.AWP_DB||'data/team.db');const rows=db.prepare(\"SELECT DISTINCT run_id FROM run_attempts WHERE status IN ('reserved','leased','provisioning','running')\").all();process.stdout.write(rows.map(r=>r.run_id).join('\n'))" 2>$null
  if ($stdout) { $active = @($stdout | Where-Object { $_ }) }
} catch {
  Write-Host '无法读取活动 attempt 清单，跳过 Hyper-V 清理以免误删'
  exit 0
}

$removed = 0
foreach ($vm in @(Get-VM | Where-Object { $_.Name -like 'awp-run-*' })) {
  $runId = $vm.Name.Substring('awp-run-'.Length)
  $runId = $runId -replace '-a\d+$', ''
  if ($active -contains $runId) { continue }
  Write-Host "removing residue VM $($vm.Name)"
  if ($vm.State -ne 'Off') { Stop-VM -Name $vm.Name -TurnOff -Force -ErrorAction SilentlyContinue }
  Remove-VM -Name $vm.Name -Force -ErrorAction SilentlyContinue
  $removed++
}
Write-Host "HYPERV_JANITOR_REMOVED=$removed"
exit 0
