@echo off
:: SwiftPOS Print Server - Uninstaller
:: Run as Administrator

title SwiftPOS Print Server Uninstall
color 0C

echo.
echo  ============================================
echo   SwiftPOS Print Server - Uninstaller
echo  ============================================
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo  ERROR: Please run as Administrator.
  pause
  exit /b 1
)

set SERVICE_NAME=SwiftPOSPrintServer

sc query %SERVICE_NAME% >nul 2>&1
if %errorLevel% neq 0 (
  echo  Service is not installed. Nothing to remove.
  pause
  exit /b 0
)

echo  Stopping service...
sc stop %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Removing service...
sc delete %SERVICE_NAME%

echo.
echo  Done. SwiftPOS Print Server has been removed.
echo.
pause
