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
echo NanoJev setup
echo This reconfigures the decision backend (Jev / OpenJev / Codiv) and the Minecraft server.
echo Existing .env values are kept where you do not change them.
echo.

node dist\index.js setup --force
if errorlevel 1 (
  echo Setup failed.
  pause
  exit /b 1
)

echo.
echo Done. Run start.bat to launch the bot (and run-openjev.bat first if you chose a local server).
pause
endlocal
