@echo off
setlocal
cd /d "%~dp0"
call npm run profiles:launch
if errorlevel 1 (
  echo.
  echo AUTOBOT could not start. Review the message above.
  pause
)
