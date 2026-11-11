@echo off
cd /d "%~dp0"
if exist "LocalWorkspace.exe" (
  start "" "%~dp0LocalWorkspace.exe"
  exit /b
)
if not exist "LocalWorkspace.Windows.exe" (
  echo Download and extract the Windows ZIP from GitHub Releases, or run desktop\build.ps1.
  pause
  exit /b 1
)
where node >nul 2>&1 || (echo Node.js 24 is required. & pause & exit /b 1)
node server.mjs --open
if errorlevel 1 pause
