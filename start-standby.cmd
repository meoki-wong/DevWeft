@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\preflight.ps1" -Profile standby
if errorlevel 1 (
  echo Standby startup preflight failed. Review the error above.
  pause
  exit /b 1
)

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
