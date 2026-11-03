@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Sound Lab needs Node.js. Install Node.js, then run this file again.
  pause
  exit /b 1
)
node server.mjs --open
pause
