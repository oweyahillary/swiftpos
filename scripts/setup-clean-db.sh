#!/usr/bin/env bash
# =============================================================================
# setup-clean-db.sh — bring a CLEAN SwiftPOS database up to the current schema.
# =============================================================================
# WHAT IT DOES, IN ORDER
#   1. (optional, --reset) DROP + recreate the public schema for a true clean slate.
#   2. Apply migrations/00_baseline.sql        — full schema as of 2026-07-28.
#   3. Apply migrations/01_schema_migrations.sql — tracking table + backfill of
#      the state the baseline already contains (01-18, 21-38; 19/20 NOT applied).
#   4. Apply every OUTSTANDING numbered migration in numeric order, skipping any
#      whose version is already recorded in public.schema_migrations, and STAMP
#      each one after it succeeds (so the ~11 files that don't self-record still
#      get tracked). This step is idempotent and resumable — re-run it any time.
#   5. (only with --reset) restore the standard Supabase table grants, since
#      dropping public wipes them and the baseline does not re-create them.
#
# WHY A SCRIPT AND NOT "psql -f *.sql"
#   - 00_baseline.sql is a pg_dump, not migration 00; the numbered files ALTER
#     tables it creates. Order and the baseline-vs-forward split matter.
#   - Files 33-38 live in migrations/ but are already IN the baseline. Re-running
#     them is wrong. The schema_migrations check below skips them automatically.
#   - 19 and 20 are the only sub-38 files that must still run.
#   - Tracking is inconsistent across files; this stamps all of them uniformly.
#
# REQUIREMENTS
#   - psql 16.x (the baseline uses the \restrict meta-command; the Supabase SQL
#     editor cannot run it).
#   - DATABASE_URL pointing at the project's DIRECT connection (role = postgres),
#     not a restricted pooler role — RLS/ownership and default grants depend on it.
#       export DATABASE_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres?sslmode=require'
#
# USAGE
#   export DATABASE_URL=...              # required
#   ./scripts/setup-clean-db.sh         # brand-new empty project (non-destructive)
#   ./scripts/setup-clean-db.sh --reset # wipe public first (DESTRUCTIVE, fresh only)
#   ./scripts/setup-clean-db.sh --dry-run   # print the plan, apply nothing
# =============================================================================
set -euo pipefail

MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/migrations"
RESET=0
DRYRUN=0
for arg in "$@"; do
  case "$arg" in
    --reset)   RESET=1 ;;
    --dry-run) DRYRUN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

: "${DATABASE_URL:?set DATABASE_URL to the direct postgres connection string for this project}"

# psql that stops on the first real error and stays quiet otherwise.
# Conn string passed via -d (an OPTION), not positionally: some psql builds stop
# permuting options once they hit a positional operand and silently drop -f/-v.
psql_run() { psql -v ON_ERROR_STOP=1 --quiet -d "$DATABASE_URL" "$@"; }
# scalar query helper (returns empty string if no row)
psql_val() { psql -X -A -t -q -d "$DATABASE_URL" -c "$1" 2>/dev/null | tr -d '[:space:]'; }

# --- preflight: fail fast with actionable guidance if we can't connect --------
if ! psql -X -q -d "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1; then
  cat >&2 <<'MSG'
✗ Cannot connect using DATABASE_URL.

  If the error was "could not translate host name db.<ref>.supabase.co":
  that DIRECT endpoint is IPv6-only and does not resolve on most networks.
  Use the Supabase SESSION POOLER string instead — it connects as the real
  postgres role, so it is fine for migrations.

  Dashboard → Project Settings → Database → Connection string → "Session pooler":
    postgresql://postgres.<ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require

  (Port 5432 = session mode. Do NOT use 6543 / transaction mode for migrations.)
MSG
  exit 1
fi

echo "▸ target: $(psql_val "select current_database()||' @ '||inet_server_addr()") (role $(psql_val 'select current_user'))"

# --- 1. optional clean slate -------------------------------------------------
if [[ "$RESET" == 1 ]]; then
  echo "⚠  --reset will DROP SCHEMA public CASCADE (all tables + data in public)."
  read -r -p "   Type the database name to confirm: " confirm
  want="$(psql_val 'select current_database()')"
  [[ "$confirm" == "$want" ]] || { echo "   mismatch, aborting."; exit 1; }
  if [[ "$DRYRUN" == 0 ]]; then
    # Drop only. The baseline's own `CREATE SCHEMA public;` recreates it.
    psql_run -c 'DROP SCHEMA IF EXISTS public CASCADE;'
    echo "   public dropped."
  else
    echo "   [dry-run] would DROP SCHEMA public CASCADE"
  fi
fi

# --- 2 & 3. baseline + tracking table ---------------------------------------
apply_baseline() {
  local f="$MIG_DIR/00_baseline.sql"
  if [[ "$RESET" == 1 ]]; then
    # public was dropped; the baseline recreates it, so run it verbatim.
    psql_run -f "$f"
  else
    # Brand-new project: public already exists. Strip the lone redundant
    # `CREATE SCHEMA public;` so ON_ERROR_STOP=1 doesn't trip on it. Everything
    # else in the dump targets an empty public and applies cleanly.
    sed '/^CREATE SCHEMA public;$/d' "$f" | psql_run -f -
  fi
}

if [[ "$(psql_val "select to_regclass('public.schema_migrations')")" == "" ]]; then
  echo "▸ applying 00_baseline.sql (full schema, ~7k lines)…"
  if [[ "$DRYRUN" == 0 ]]; then apply_baseline; else echo "   [dry-run] skip baseline"; fi
  echo "▸ applying 01_schema_migrations.sql (tracking table + backfill)…"
  if [[ "$DRYRUN" == 0 ]]; then psql_run -f "$MIG_DIR/01_schema_migrations.sql"; else echo "   [dry-run] skip tracking"; fi
else
  echo "▸ schema_migrations already present — skipping baseline, resuming forward migrations."
fi

# --- 4. outstanding forward migrations, numeric order ------------------------
# Every numbered file except the two we handled explicitly. The recorded-version
# check skips anything already applied (01-18, 21-38, 31/32-SKIPPED), leaving
# exactly 19, 20, and 39+ on a clean DB.
mapfile -t files < <(
  ls -1 "$MIG_DIR"/[0-9]*.sql \
    | grep -Ev '/(00_baseline|01_schema_migrations)\.sql$' \
    | awk -F/ '{print $NF}' \
    | sort -t_ -k1,1n -k2
)

applied=0; skipped=0
for name in "${files[@]}"; do
  stem="${name%.sql}"
  if [[ "$DRYRUN" == 0 ]]; then
    already="$(psql_val "select 1 from public.schema_migrations where version = '$stem'")"
    if [[ -n "$already" ]]; then skipped=$((skipped+1)); continue; fi
  fi
  echo "  → $stem"
  if [[ "$DRYRUN" == 1 ]]; then applied=$((applied+1)); continue; fi
  psql_run -f "$MIG_DIR/$name"
  # Stamp uniformly. Self-recording files already inserted their row; ON CONFLICT
  # makes this a no-op for them and the source of truth for the ~11 that don't.
  stamp="INSERT INTO public.schema_migrations(version, notes) VALUES ('$stem', 'applied by setup-clean-db.sh') ON CONFLICT (version) DO NOTHING;"
  psql_run -c "$stamp"
  applied=$((applied+1))
done
echo "▸ forward migrations: $applied applied/planned, $skipped already-present."

# --- 5. restore Supabase grants (only meaningful after --reset) -------------
if [[ "$RESET" == 1 && "$DRYRUN" == 0 ]]; then
  echo "▸ restoring Supabase role grants on public…"
  psql_run <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL
fi

# --- verification ------------------------------------------------------------
if [[ "$DRYRUN" == 0 ]]; then
  echo "▸ verification"
  echo "   tables in public : $(psql_val "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
  echo "   RLS-enabled      : $(psql_val "select count(*) from pg_tables where schemaname='public' and rowsecurity")"
  echo "   migrations logged: $(psql_val 'select count(*) from public.schema_migrations')"
  echo "   highest version  : $(psql_val "select version from public.schema_migrations where version ~ '^[0-9]' order by (split_part(version,'_',1))::int desc nulls last limit 1")"
fi
echo "✓ done."
