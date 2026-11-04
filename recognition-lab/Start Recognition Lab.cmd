@echo off
setlocal
set "LAB_DIR=%~dp0"
if not exist "%~dp0.venv\Scripts\python.exe" (
 echo The local Python environment is missing. See README.txt for setup.
 pause
 exit /b 1
)
powershell -NoProfile -Command "$r=$env:LAB_DIR; Start-Process -FilePath (Join-Path $r '.venv\Scripts\python.exe') -ArgumentList @('server.py','--open') -WorkingDirectory $r -WindowStyle Hidden -RedirectStandardError (Join-Path $r 'server-error.log') -RedirectStandardOutput (Join-Path $r 'server.log')"
