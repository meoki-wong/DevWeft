@echo off
setlocal
cd /d "%~dp0"

fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator access for the primary worker host...
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -ArgumentList '%*'"
  exit /b
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-platform.ps1" %*
set "START_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%START_EXIT_CODE%"=="0" (
  echo Primary host services started.
) else (
  echo Primary host startup failed with exit code %START_EXIT_CODE%.
)
pause
exit /b %START_EXIT_CODE%
