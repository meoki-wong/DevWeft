@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-node.ps1" %*
set "START_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%START_EXIT_CODE%"=="0" (
  echo Standby control plane started.
) else (
  echo Standby startup failed with exit code %START_EXIT_CODE%.
)
pause
exit /b %START_EXIT_CODE%
