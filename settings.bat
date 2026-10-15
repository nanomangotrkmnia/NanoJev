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

echo.
echo NanoJev settings
echo Change the decision backend, keys, server, username, and more.
echo Everything is written back to .env.
echo.

node dist\index.js settings
if errorlevel 1 (
  echo Settings failed.
  pause
  exit /b 1
)

pause
endlocal
