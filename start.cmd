@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo Dependencies are missing. Run deploy.cmd first.
  pause
  exit /b 1
)

npm start
set "START_EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %START_EXIT_CODE%
