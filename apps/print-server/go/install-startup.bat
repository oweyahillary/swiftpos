@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM SwiftPOS Print Bridge — install as a per-user startup task.
REM
REM Registers SwiftPOS-PrintServer.exe to launch automatically when THIS Windows
REM user logs in, using Task Scheduler. Runs as the logged-in user (not a system
REM service) on purpose: a service runs in session 0 under a different account and
REM often cannot see printers you installed for your own user. Running as you keeps
REM printer visibility simple. No Administrator rights required.
REM
REM Double-click this file. To remove it later, run uninstall-startup.bat.
REM ─────────────────────────────────────────────────────────────────────────────
setlocal
set "EXE=%~dp0SwiftPOS-PrintServer.exe"
set "TASK=SwiftPOS Print Bridge"

if not exist "%EXE%" (
  echo.
  echo   Could not find SwiftPOS-PrintServer.exe next to this script.
  echo   Put this .bat in the same folder as the .exe and try again.
  echo.
  pause
  exit /b 1
)

echo Registering "%TASK%" to start at logon...
schtasks /Create /TN "%TASK%" /TR "\"%EXE%\"" /SC ONLOGON /RL LIMITED /F >nul
if errorlevel 1 (
  echo.
  echo   Failed to register the startup task.
  echo.
  pause
  exit /b 1
)

echo Starting the print bridge now...
start "" "%EXE%"

echo.
echo   Done. The print bridge is running and will start automatically at logon.
echo   In the dashboard, open Settings ^> Printers and pick your receipt printer.
echo.
pause
