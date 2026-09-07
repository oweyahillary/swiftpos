@echo off
REM Removes the SwiftPOS Print Bridge logon startup task (installed by
REM install-startup.bat). Does not delete the .exe or the pairing-token file.
setlocal
set "TASK=SwiftPOS Print Bridge"

echo Removing the "%TASK%" startup task...
schtasks /Delete /TN "%TASK%" /F >nul 2>&1
if errorlevel 1 (
  echo   No startup task was found (nothing to remove).
) else (
  echo   Removed. The print bridge will no longer start automatically at logon.
)

echo   To stop it now, close SwiftPOS-PrintServer.exe from Task Manager.
echo.
pause
