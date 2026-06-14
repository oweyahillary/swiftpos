@echo off
:: SwiftPOS Print Server - Windows Service Installer
:: Run this as Administrator

title SwiftPOS Print Server Setup
color 0A

echo.
echo  ============================================
echo   SwiftPOS Print Server - Windows Installer
echo  ============================================
echo.

:: Check admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo  ERROR: Please run this script as Administrator.
  echo  Right-click the file and select "Run as administrator".
  echo.
  pause
  exit /b 1
)

set SERVICE_NAME=SwiftPOSPrintServer
set EXE_PATH=%~dp0SwiftPOS-PrintServer.exe
set PORT=3001

:: Check if exe exists
if not exist "%EXE_PATH%" (
  echo  ERROR: SwiftPOS-PrintServer.exe not found in this folder.
  echo  Make sure the .exe is in the same folder as this script.
  echo.
  pause
  exit /b 1
)

echo  Installing SwiftPOS Print Server as a Windows service...
echo  This allows it to start automatically when Windows boots.
echo.

:: Remove existing service if present
sc query %SERVICE_NAME% >nul 2>&1
if %errorLevel% equ 0 (
  echo  Removing existing service...
  sc stop %SERVICE_NAME% >nul 2>&1
  sc delete %SERVICE_NAME% >nul 2>&1
  timeout /t 2 /nobreak >nul
)

:: Create Windows service using sc.exe
sc create %SERVICE_NAME% ^
  binPath= "\"%EXE_PATH%\"" ^
  DisplayName= "SwiftPOS Print Server" ^
  Description= "SwiftPOS local print server - enables silent printing from the browser" ^
  start= auto ^
  type= own

if %errorLevel% neq 0 (
  echo.
  echo  ERROR: Failed to create service.
  echo  Please make sure you are running as Administrator.
  pause
  exit /b 1
)

:: Start the service
echo  Starting service...
sc start %SERVICE_NAME%

:: Wait and check status
timeout /t 3 /nobreak >nul
sc query %SERVICE_NAME% | find "RUNNING" >nul
if %errorLevel% equ 0 (
  echo.
  echo  ============================================
  echo   SUCCESS! SwiftPOS Print Server is running.
  echo  ============================================
  echo.
  echo   The print server is now:
  echo    - Running on http://localhost:%PORT%
  echo    - Set to start automatically on Windows boot
  echo    - Running silently in the background
  echo.
  echo   You can now open SwiftPOS in your browser.
  echo   A green "Print Server Connected" indicator
  echo   will appear in the POS printer settings.
  echo.
) else (
  echo.
  echo  WARNING: Service was created but may not have started yet.
  echo  Try starting it manually from Windows Services.
  echo.
)

pause
