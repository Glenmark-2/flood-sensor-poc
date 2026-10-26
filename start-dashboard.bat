@echo off
title Flood Sensor Dashboard
cd /d "%~dp0"

where npm >/dev/null 2>/dev/null || (echo Node.js / npm not found. Install Node.js LTS from nodejs.org, then run this again. & pause & exit /b 1)

if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)

echo.
echo Starting the dashboard at http://127.0.0.1:5173
echo Keep this window open while you use it. Press Ctrl+C to stop.
echo.

rem Open Microsoft Edge (supports Web Serial) once the server has had a few seconds to start.
start "" cmd /c "timeout /t 4 >/dev/null & start msedge http://127.0.0.1:5173"

call npm run dev
pause
