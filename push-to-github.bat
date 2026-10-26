@echo off
title Push Flood Sensor PoC to GitHub
cd /d "%~dp0"
set REPO=https://github.com/Glenmark-2/flood-sensor-poc.git

where git >nul 2>nul || (echo Git is not installed. Get it from https://git-scm.com/download/win then run this again. & pause & exit /b 1)

rem --- who the commits are from (asked only once) ---
git config --global user.name >nul 2>nul || (set /p GN=Your name for Git commits: & call git config --global user.name "%%GN%%")
git config --global user.email >nul 2>nul || (set /p GE=Your GitHub email: & call git config --global user.email "%%GE%%")

if not exist .git git init -b main
git checkout -B main >nul 2>nul
git remote get-url origin >nul 2>nul || git remote add origin %REPO%

echo.
echo Adding files (node_modules and dist are skipped by .gitignore)...
git add -A
git commit -m "Flood sensor PoC: firmware, dashboard and wiring guides" || echo (nothing new to commit)

rem --- if the GitHub repo already has files (e.g. a README), merge them in; local files win ---
git fetch origin >nul 2>nul
git ls-remote --exit-code --heads origin main >nul 2>nul && git merge origin/main --allow-unrelated-histories -X ours -m "Merge existing GitHub content"

echo.
echo Uploading to %REPO%
echo (a GitHub sign-in window may open the first time)
git push -u origin main
if errorlevel 1 (echo. & echo Push failed - see the message above. & pause & exit /b 1)
echo.
echo Done: https://github.com/Glenmark-2/flood-sensor-poc
pause
