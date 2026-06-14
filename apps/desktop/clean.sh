#!/usr/bin/env bash
# =============================================================================
#  SwiftPOS Desktop - clean & rebuild helper (Git Bash / MINGW64 version)
#  Run from apps/desktop:
#     ./clean.sh                  clean build artifacts only (safe, every update)
#     ./clean.sh --build          clean + npm run build  (DB preserved)
#     ./clean.sh --db --build     ALSO wipe the local DB  -- DEV ONLY
#
#  If "permission denied": run  chmod +x clean.sh  once, or use  bash clean.sh
#
#  DEFAULT is safe: it removes BUILD ARTIFACTS only. The local DB is left alone -
#  it self-migrates and may hold unsynced sales + the install config. Only pass
#  --db on a dev machine, never on a real terminal.
# =============================================================================
set -e
cd "$(dirname "$0")"

DO_DB=0
DO_BUILD=0
for a in "$@"; do
  case "$a" in
    --db|/db)       DO_DB=1 ;;
    --build|/build) DO_BUILD=1 ;;
    *) echo "Unknown option: $a (use --db and/or --build)";;
  esac
done

echo
echo "=== SwiftPOS Desktop cleanup ==="
echo "Working dir: $(pwd)"
echo

# --- 1. Build artifacts (always) --------------------------------------------
echo "[1/3] Removing build artifacts (dist, release, Vite cache)..."
rm -rf dist release node_modules/.vite
echo "      done."
echo

# --- 2. Local DB (opt-in only) ----------------------------------------------
if [ "$DO_DB" = "1" ]; then
  echo "[2/3] Resetting local database (DEV ONLY)..."
  # Dev (unpackaged) uses %APPDATA%\desktop ; packaged build uses %APPDATA%\SwiftPOS.
  APPDATA_UNIX="$(cygpath "$APPDATA" 2>/dev/null || echo "$HOME/AppData/Roaming")"
  for d in "$APPDATA_UNIX/desktop" "$APPDATA_UNIX/SwiftPOS"; do
    rm -f "$d/swiftpos.db" "$d/swiftpos.db-wal" "$d/swiftpos.db-shm"
  done
  echo "      local database reset."
else
  echo "[2/3] Database preserved (pass --db to reset -- DEV ONLY)."
fi
echo

# --- 3. Optional rebuild ----------------------------------------------------
if [ "$DO_BUILD" = "1" ]; then
  echo "[3/3] Building (npm run build)..."
  npm run build
else
  echo "[3/3] Skipped rebuild. Next: 'npm run dev' to iterate, or 'npm run build' to package."
fi

echo
echo "=== Cleanup complete ==="
