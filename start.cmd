@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo Dependencies are missing. Run deploy.cmd first.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\preflight.ps1" -Profile standalone
if errorlevel 1 (
  echo Startup preflight failed. Review the error above.
  pause
  exit /b 1
)

npm start
set "START_EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %START_EXIT_CODE%
