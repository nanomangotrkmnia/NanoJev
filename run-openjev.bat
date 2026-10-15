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
echo OpenJev is the open, Jev-compatible decision server NanoJev can use as its local agent.
echo Pick a model when prompted. It will be written to .env as OPENJEV_MODEL so the bot uses it.
echo.
node dist\index.js openjev --execute
if errorlevel 1 (
  echo.
  echo OpenJev exited. If it did not start, make sure Docker (NVIDIA GPU) or Python is installed,
  echo then re-run this file. See the README's OpenJev section.
)
pause
endlocal
