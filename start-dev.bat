@echo off
rem prompt-forge dev launcher -- works from anywhere (desktop shortcut ok)
cd /d "D:\Projects\Others\prompt-forge"
title prompt-forge dev

if not exist "node_modules\concurrently" (
  echo [!] Dependencies missing or incomplete.
  echo     Run this first:  pnpm install
  echo.
  pause
  exit /b 1
)

echo Starting prompt-forge ...
echo   api : http://localhost:3200
echo   web : http://localhost:5273
echo Close this window to stop.
echo.

rem open the browser ~7s later, once vite is up
start "" /min cmd /c "timeout /t 7 >nul & explorer http://localhost:5273"

call pnpm run dev

echo.
echo [dev exited]
pause
