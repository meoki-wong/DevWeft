Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& pm2 restart awp-host-worker --update-env 2>&1 | Out-String
Start-Sleep 3
& pm2 ls 2>&1 | Out-String
