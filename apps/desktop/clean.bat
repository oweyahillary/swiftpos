@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem =============================================================================
rem  SwiftPOS Desktop - clean & rebuild helper
rem  Place this file in  apps\desktop  and run it from there (double-click or CLI).
rem
rem  DEFAULT (safe): removes BUILD ARTIFACTS only, so the next run compiles fresh.
rem    The local database is LEFT ALONE on purpose - it self-migrates and may hold
rem    unsynced sales + the install config.
rem
rem  OPTIONAL: reset the local DB (asked explicitly, defaults to NO). DEV ONLY -
rem    this deletes unsynced offline data and forces a re-install.
rem
rem  Flags (skip the prompts):
rem    clean.bat /db          also reset the local database
rem    clean.bat /build       run a full rebuild (npm run build) after cleaning
rem    clean.bat /db /build   both
rem =============================================================================

set "DO_DB=0"
set "DO_BUILD=0"
for %%A in (%*) do (
  if /I "%%~A"=="/db"    set "DO_DB=1"
  if /I "%%~A"=="/build" set "DO_BUILD=1"
)

echo.
echo === SwiftPOS Desktop cleanup ===
echo Working dir: %cd%
echo.

rem --- 1. Build artifacts (always) ---------------------------------------------
echo [1/3] Removing build artifacts (dist, release, Vite cache)...
if exist "dist"               rmdir /s /q "dist"
if exist "release"            rmdir /s /q "release"
if exist "node_modules\.vite" rmdir /s /q "node_modules\.vite"
echo        done.
echo.

rem --- 2. Local DB (opt-in only) -----------------------------------------------
if "%DO_DB%"=="1" goto :resetdb
echo [2/3] Local database reset is OPTIONAL  --  DEV ONLY.
echo        This permanently deletes, on THIS machine:
echo          - unsynced offline sales / shifts / expenses (not yet pushed to cloud)
echo          - the install config (mode, server URL, bound branch) -- reinstall needed
echo        Leave it alone for normal code updates; the DB migrates itself.
echo.
set /p "ANS=       Reset the local database now? [y/N] "
if /I "!ANS!"=="y" goto :resetdb
echo        skipped (database preserved).
goto :afterdb

:resetdb
echo        Deleting swiftpos.db from known locations...
rem  Dev (unpackaged) uses %%APPDATA%%\desktop ; packaged build uses %%APPDATA%%\SwiftPOS.
for %%D in ("%APPDATA%\desktop" "%APPDATA%\SwiftPOS") do (
  if exist "%%~D\swiftpos.db"     del /q "%%~D\swiftpos.db"
  if exist "%%~D\swiftpos.db-wal" del /q "%%~D\swiftpos.db-wal"
  if exist "%%~D\swiftpos.db-shm" del /q "%%~D\swiftpos.db-shm"
)
echo        local database reset.

:afterdb
echo.

rem --- 3. Optional rebuild -----------------------------------------------------
if "%DO_BUILD%"=="1" goto :build
set /p "BANS=       Run a full rebuild now (npm run build)? [y/N] "
if /I "!BANS!"=="y" goto :build
echo [3/3] Skipped rebuild.
echo        Next: run "npm run dev" to iterate, or "npm run build" to package an installer.
goto :done

:build
echo [3/3] Building (npm run build)...
call npm run build

:done
echo.
echo === Cleanup complete ===
pause
endlocal
