# 停止本仓库 PM2 进程（不删数据、不删证书、不删交换机）。
param([switch]$Delete)

$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
$pm2 = Get-Command pm2 -ErrorAction Stop
$services = @(& node -e "for (const app of require('./ecosystem.config.cjs').apps) console.log(app.name)")
if ($LASTEXITCODE -ne 0 -or $services.Count -eq 0) { throw 'Could not read applications from ecosystem.config.cjs.' }
if ($Delete) {
  & pm2 delete @services
} else {
  & pm2 stop @services
}
Write-Host 'Stopped all PM2 services declared in ecosystem.config.cjs. Runtime data and certificates were kept.'
