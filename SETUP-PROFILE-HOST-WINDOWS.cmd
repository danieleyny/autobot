@echo off
setlocal
cd /d "%~dp0"

echo AUTOBOT v0.13.0 Multi-Profile Host Setup
echo ========================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the current LTS release from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

call npm install
if errorlevel 1 (
  echo Installation failed. Check the computer clock and internet connection, then try again.
  pause
  exit /b 1
)

if exist "%LOCALAPPDATA%\AUTOBOT\profile-host.json" (
  echo Existing profile-host pairings found. Updating the worker extensions without changing them.
  call npm run profiles:setup
) else (
  set /p PAIR_CODE=Enter the 48-hour enrollment code: 
  set /p HOST_NAME=Enter this computer's name, for example Studio PC 1: 
  set /p WORKER_COUNT=How many Chrome workers on this computer? Enter 1-4: 
  call npm run profiles:setup -- --controller=https://autobot-profile-host-beta.avgschnook.chatgpt.site --code=%PAIR_CODE% --name="%HOST_NAME%" --workers=%WORKER_COUNT%
)
if errorlevel 1 (
  echo Profile-host setup failed. Confirm the enrollment code and try again.
  pause
  exit /b 1
)

call npm run profiles:install
echo.
echo In each numbered Chrome window, load the matching numbered extension folder shown above.
echo Sign each profile into its own POSH account once. Keep this window open during the first session.
call npm run profiles:host
