@echo off
setlocal
set "GTOOL_LAB=%~dp0"
if not exist "%~dp0.venv\Scripts\python.exe" (
 echo The local Python environment is missing. See README.txt for setup.
 pause
 exit /b 1
)
powershell -NoProfile -Command "$r=$env:GTOOL_LAB; Start-Process -FilePath (Join-Path $r '.venv\Scripts\python.exe') -ArgumentList @('server.py','--open') -WorkingDirectory $r -WindowStyle Hidden -RedirectStandardError (Join-Path $r 'server-error.log') -RedirectStandardOutput (Join-Path $r 'server.log')"
