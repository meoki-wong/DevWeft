@echo off
setlocal
cd /d "%~dp0"

fltmc >nul 2>&1
if errorlevel 1 goto elevate
goto run

:elevate
echo Requesting Administrator access for full deployment...
powershell.exe -NoProfile -Command "try { $child = Start-Process -FilePath '%~f0' -Verb RunAs -ArgumentList '%*' -Wait -PassThru -ErrorAction Stop; exit $child.ExitCode } catch { Write-Error $_; exit 1 }"
set "DEPLOY_EXIT_CODE=%ERRORLEVEL%"
echo Deployment finished with exit code %DEPLOY_EXIT_CODE%.
pause
exit /b %DEPLOY_EXIT_CODE%

:run
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
