#Requires -Version 5.1
<#
.SYNOPSIS
  Restart ONLY the link gateway (awp-gateway) on the Windows main machine, without touching control plane / workers.
  Use after gateway code or route-config changes.
  WARNING: restarting the gateway drops its in-memory external MCP sessions -> connected MCP clients
  must reconnect (re-initialize). Control-plane state, tool_calls ledger and running cloud tests are NOT affected.
  NEVER restarts the control plane and NEVER uses "pm2 restart all".
.EXAMPLE
  .\scripts\restart-gateway.ps1
  .\scripts\restart-gateway.ps1 -GatewayPort 8787
#>
param([int]$GatewayPort = 8787)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$svc = 'awp-gateway'

# -- pm2 availability --
try { $null = pm2 -v 2>&1 } catch {
  Write-Host '[ERROR] pm2 not available. Install first: npm install -g pm2' -ForegroundColor Red
  exit 1
}

# -- exists -> restart ; missing -> start only this app --
$exists = $false
try {
  $id = (pm2 id $svc 2>$null | Out-String).Trim()
  $exists = ($id -match '^\d+$')
} catch { $exists = $false }

Write-Host '[warn] Restarting the link gateway drops connected MCP client sessions (control plane / cloud tests unaffected).' -ForegroundColor Yellow
if ($exists) {
  pm2 restart $svc --silent | Out-Null
  Write-Host ("[restart] {0}" -f $svc) -ForegroundColor Cyan
} else {
  pm2 start (Join-Path $root 'ecosystem.config.cjs') --only $svc | Out-Null
  Write-Host ("[start]   {0} (new)" -f $svc) -ForegroundColor Green
}
pm2 save | Out-Null
Write-Host '[saved]   PM2 process list saved' -ForegroundColor Cyan

# -- health check (gateway self ping: ok + link pool) --
Start-Sleep -Seconds 3
try {
  $g = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/mcp/ping" -TimeoutSec 10
  $linkIds = ($g.links | ForEach-Object { $_.link_id }) -join ','
  Write-Host ("[health]  gateway :{0} ok, links=[{1}]" -f $GatewayPort, $linkIds) -ForegroundColor Green
} catch {
  Write-Warning ("[health]  gateway :{0} not ready yet; check pm2 ls / data/logs/gateway*.log" -f $GatewayPort)
}

Write-Host ''
Write-Host 'Only the link gateway was restarted; control plane / host-worker / secret-broker / scanner untouched.'
pm2 ls
