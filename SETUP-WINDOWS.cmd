@echo off
setlocal
cd /d "%~dp0"

echo AUTOBOT v0.11.1 Windows Setup
echo ===============================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the current LTS release from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

echo Installing AUTOBOT files...
call npm install
if errorlevel 1 (
  echo Installation failed. Check the internet connection and try again.
  pause
  exit /b 1
)

echo Open OPEN-FIRST-AUTOBOT-SETUP-GUIDE.pdf for the complete copy-and-paste checklist.

if exist "%LOCALAPPDATA%\AUTOBOT\device.json" goto paired

set /p PAIR_CODE=Enter the enrollment or one-time code: 
set /p DEVICE_NAME=Enter this laptop's name, for example Laptop 01: 
call npm run device:pair -- --controller=https://autobot-command-center.avgschnook.chatgpt.site --code=%PAIR_CODE% --name="%DEVICE_NAME%"
if errorlevel 1 (
  echo Pairing failed. Confirm the code and try again.
  pause
  exit /b 1
)

:paired
call npm run device:install
start "" chrome://extensions
echo.
echo Chrome Extensions is opening. Turn on Developer mode, choose Load unpacked, and select:
echo %~dp0extension
echo.
echo Keep this window open during testing. Press Ctrl+C to stop the bridge.
call npm run device
