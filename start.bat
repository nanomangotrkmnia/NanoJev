@echo off
setlocal enableextensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.js" (
  echo Building NanoJev...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo.
  echo First run detected: choosing a decision backend and Minecraft settings.
  echo.
  node dist\index.js setup
  if errorlevel 1 (
    echo Setup failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting NanoJev...
node dist\index.js run
if errorlevel 1 pause
endlocal
