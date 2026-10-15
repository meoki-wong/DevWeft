@echo off
setlocal
cd /d "%~dp0"

fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator access for full deployment...
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -ArgumentList '%*'"
  exit /b
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fresh-deploy.ps1" %*
set "DEPLOY_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%DEPLOY_EXIT_CODE%"=="0" (
  echo Deployment completed successfully.
) else (
  echo Deployment failed with exit code %DEPLOY_EXIT_CODE%.
)
pause
exit /b %DEPLOY_EXIT_CODE%
