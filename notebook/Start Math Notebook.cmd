@echo off
cd /d "%~dp0"
if not exist "..\recognition-lab\.venv\Scripts\python.exe" (
  echo Math Notebook uses Recognition Lab's Python environment, which is missing.
  echo See README.md in the main folder for setup.
  pause
  exit /b 1
)
if not exist "..\node_modules\electron\dist\electron.exe" (
  echo The desktop window is not installed. In the graphing folder run: npm install
  pause
  exit /b 1
)
start "" "..\node_modules\electron\dist\electron.exe" "desktop\main.cjs"
