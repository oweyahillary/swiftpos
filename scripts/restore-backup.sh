#!/usr/bin/env bash
# =============================================================================
# restore-backup.sh — A589: bring a nightly backup back (scripts/backup/nightly-backup.sh) into a database.
#
#   bash scripts/restore-backup.sh --target <postgres-url> --latest                     # the newest daily backup in R2
#   bash scripts/restore-backup.sh --target <postgres-url> --object daily/2026-10-26/zaptill-2026-10-26T0003EAT.dump.gpg
#   bash scripts/restore-backup.sh --target <postgres-url> --file ./zaptill-….dump.gpg  # a copy already downloaded
#
# Options:
#   --prepare-plain    the target is a plain PostgreSQL (a local Docker postgres:17, a test cluster) — first create what a
#                      Supabase database always has (roles anon / authenticated / service_role, the extensions and auth
#                      schemas, auth.uid()…: scripts/00_prereqs_local.sql), then restore the public schema only.
#   --schema <name>    restore only this schema (repeatable; default: everything in the backup)
#   --list-only        decrypt and list what the backup holds; restore nothing
#   --with-acl         keep the grants (default: --no-owner --no-acl — the target's own roles own everything)
#   --yes              do not ask (the production guard below still applies)
#   --keep-going       report errors and go on (default: stop at the first — e.g. into a Supabase project, where some
#                      Supabase-owned objects already exist)
#   --i-know           allow a target that looks like PRODUCTION. Never for a test. Restoring over production replaces
#                      live client data with the backup's — sales made since the backup are lost.
#
# Environment: BACKUP_PASSPHRASE (asked for when not set), and for --latest / --object: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY, R2_BUCKET. PRODUCTION_DB_MATCH: text that identifies production in a URL (your Supabase project
# ref, e.g. "abcdefghijklmnop") — a target containing it is refused without --i-know; with it unset, ANY supabase.co /
# supabase.com host is treated as production. The how-to and the monthly test: docs/BACKUPS.md.
# =============================================================================
set -Eeuo pipefail
set +x
umask 077

KEEP_GOING=0; TARGET=""; OBJECT=""; FILE=""; LATEST=0; LIST_ONLY=0; WITH_ACL=0; YES=0; I_KNOW=0; PREPARE=0; SCHEMAS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target needs a URL}"; shift 2 ;;
    --object) OBJECT="${2:?--object needs a key}"; shift 2 ;;
    --file) FILE="${2:?--file needs a path}"; shift 2 ;;
    --latest) LATEST=1; shift ;;
    --schema) SCHEMAS+=("${2:?--schema needs a name}"); shift 2 ;;
    --list-only) LIST_ONLY=1; shift ;;
    --with-acl) WITH_ACL=1; shift ;;
    --prepare-plain) PREPARE=1; shift ;;
    --yes) YES=1; shift ;;
    --keep-going) KEEP_GOING=1; shift ;;
    --i-know) I_KNOW=1; shift ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (--help)" >&2; exit 2 ;;
  esac
done
n=0; [ -n "$OBJECT" ] && n=$((n + 1)); [ -n "$FILE" ] && n=$((n + 1)); [ "$LATEST" = 1 ] && n=$((n + 1))
if [ "$n" -ne 1 ]; then echo "Give exactly one of --latest, --object <key>, --file <path>." >&2; exit 2; fi
if [ "$LIST_ONLY" = 0 ] && [ -z "$TARGET" ]; then echo "Give --target <postgres-url> (or --list-only)." >&2; exit 2; fi

# ── the production guard ──────────────────────────────────────────────────────────────────────────────────────────────
host_of() { printf '%s' "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#'; }
looks_like_production() {
  local url="$1"
  if [ -n "${PRODUCTION_DB_MATCH:-}" ]; then [[ "$url" == *"$PRODUCTION_DB_MATCH"* ]]; return; fi
  [[ "$(host_of "$url")" =~ (supabase\.co|supabase\.com)$ ]]
}
if [ -n "$TARGET" ] && looks_like_production "$TARGET"; then
  if [ "$I_KNOW" != 1 ]; then
    echo "REFUSED: the target $(host_of "$TARGET") looks like PRODUCTION." >&2
    echo "Test restores go into a local PostgreSQL or a scratch Supabase project (set PRODUCTION_DB_MATCH to your" >&2
    echo "production project ref so a scratch project is allowed). Restoring over production needs --i-know." >&2
    exit 4
  fi
  echo "WARNING: restoring into what looks like PRODUCTION ($(host_of "$TARGET")). Live data will be replaced." >&2
  if [ -t 0 ]; then
    read -r -p "Type the host name to go on: " typed
    [ "$typed" = "$(host_of "$TARGET")" ] || { echo "Not the same — stopped." >&2; exit 4; }
  else
    echo "Refused without a terminal to confirm on." >&2; exit 4
  fi
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/zaptill-restore.XXXXXX")
trap 'find "$WORK" -type f -exec sh -c "command -v shred >/dev/null 2>&1 && shred -u \"\$1\" 2>/dev/null || rm -f \"\$1\"" _ {} \; 2>/dev/null; rm -rf "$WORK"' EXIT

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  if [ -t 0 ]; then read -r -s -p "Backup passphrase: " BACKUP_PASSPHRASE; echo; else echo "BACKUP_PASSPHRASE is not set." >&2; exit 2; fi
fi

# ── get the encrypted file ────────────────────────────────────────────────────────────────────────────────────────────
ENC="$WORK/backup.dump.gpg"
if [ -n "$FILE" ]; then
  cp "$FILE" "$ENC"
else
  for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do [ -n "${!v:-}" ] || { echo "$v is not set." >&2; exit 2; }; done
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  EP="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  if [ "$LATEST" = 1 ]; then
    DAY=$(aws --endpoint-url "$EP" s3 ls "s3://$R2_BUCKET/daily/" | awk '$1 == "PRE" { sub(/\/$/, "", $2); print $2 }' | sort -r | head -1)
    [ -n "$DAY" ] || { echo "No daily backup in the bucket." >&2; exit 5; }
    OBJECT=$(aws --endpoint-url "$EP" s3 ls "s3://$R2_BUCKET/daily/$DAY/" | awk '{ print $4 }' | grep -E '\.dump\.gpg$' | sort -r | head -1)
    OBJECT="daily/$DAY/$OBJECT"
  fi
  echo "Downloading $OBJECT …"
  aws --endpoint-url "$EP" --only-show-errors s3 cp "s3://$R2_BUCKET/$OBJECT" "$ENC"
  if aws --endpoint-url "$EP" --only-show-errors s3 cp "s3://$R2_BUCKET/$OBJECT.json" "$WORK/manifest.json" 2>/dev/null; then
    WANT=$(jq -r .sha256 "$WORK/manifest.json"); GOT=$(sha256sum "$ENC" | cut -d' ' -f1)
    [ "$WANT" = "$GOT" ] || { echo "The download does not match its manifest (sha256) — stopped." >&2; exit 5; }
    echo "Checksum matches the manifest."
  fi
fi

# ── decrypt, check ────────────────────────────────────────────────────────────────────────────────────────────────────
DUMP="$WORK/backup.dump"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt --output "$DUMP" "$ENC" 3<<<"$BACKUP_PASSPHRASE" \
  || { echo "Could not decrypt — the wrong passphrase, or not a ZapTill backup." >&2; exit 6; }
pg_restore --list "$DUMP" > "$WORK/list.txt"
# "123; 0 16385 TABLE DATA public businesses postgres" → "public businesses"
data_tables() { awk '/ TABLE DATA / { for (i = 1; i < NF; i++) if ($i == "DATA") { print $(i+1), $(i+2); break } }' "$WORK/list.txt"; }
echo "The backup holds $(data_tables | wc -l | tr -d ' ') tables with data; schemas: $(data_tables | awk '{print $1}' | sort -u | tr '\n' ' ')"
if [ "$LIST_ONLY" = 1 ]; then data_tables | awk '{ print $1 "." $2 }' | head -400; exit 0; fi

# ── the target: empty, or told what will be replaced ──────────────────────────────────────────────────────────────────
HAS=$(psql "$TARGET" -XAtqc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "?")
echo "Target $(host_of "$TARGET"): $HAS tables in public now."
if [ "$YES" != 1 ]; then
  if [ ! -t 0 ]; then echo "Refused without a terminal (add --yes for a scripted test restore)." >&2; exit 4; fi
  read -r -p "Restore into $(host_of "$TARGET")? Existing objects with the same names are replaced. Type RESTORE: " typed
  [ "$typed" = "RESTORE" ] || { echo "Stopped." >&2; exit 4; }
fi

if [ "$PREPARE" = 1 ]; then
  echo "Preparing a plain PostgreSQL (scripts/00_prereqs_local.sql) …"
  psql "$TARGET" -X -q -v ON_ERROR_STOP=1 -f "$(dirname "$0")/00_prereqs_local.sql" >/dev/null
  # As on Supabase: the extensions' functions found without their schema name.
  psql "$TARGET" -X -q -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN EXECUTE format('ALTER DATABASE %I SET search_path = public, extensions', current_database()); END \$\$" >/dev/null
  [ "${#SCHEMAS[@]}" -eq 0 ] && SCHEMAS=(public)
fi

ARGS=(--dbname="$TARGET" --no-password)
[ "$KEEP_GOING" = 1 ] || ARGS+=(--exit-on-error)
[ "$WITH_ACL" = 1 ] || ARGS+=(--no-owner --no-acl)
[ "$HAS" != "0" ] && [ "$HAS" != "?" ] && ARGS+=(--clean --if-exists)
for s in "${SCHEMAS[@]}"; do ARGS+=("--schema=$s"); done
if [ "$PREPARE" = 1 ]; then
  # The public schema already exists on a plain PostgreSQL; its CREATE SCHEMA entry is left out.
  grep -vE ' SCHEMA - public ' "$WORK/list.txt" > "$WORK/use.txt"
  ARGS+=(--use-list="$WORK/use.txt")
fi
echo "Restoring …"
started=$(date +%s)
# pg_restore 17+ sets transaction_timeout, which an older server (15, 16) does not know: through a script without it.
TARGET_MAJOR=$(( $(psql "$TARGET" -XAtqc 'SHOW server_version_num') / 10000 ))
CLIENT_MAJOR=$(pg_restore --version | grep -oE '[0-9]+(\.[0-9]+)+' | head -1 | cut -d. -f1)
if [ "$CLIENT_MAJOR" -ge 17 ] && [ "$TARGET_MAJOR" -lt 17 ]; then
  echo "pg_restore $CLIENT_MAJOR into PostgreSQL $TARGET_MAJOR: through SQL (transaction_timeout left out)."
  SQL_ARGS=(); for a in "${ARGS[@]}"; do case "$a" in --dbname=*|--no-password|--exit-on-error) ;; *) SQL_ARGS+=("$a") ;; esac; done
  STOP=1; [ "$KEEP_GOING" = 1 ] && STOP=0
  pg_restore "${SQL_ARGS[@]}" --file=- "$DUMP" | sed '/^SET transaction_timeout/d' | psql "$TARGET" -X -q -v ON_ERROR_STOP=$STOP >/dev/null
else
  pg_restore "${ARGS[@]}" "$DUMP"
fi
echo "Restored in $(( $(date +%s) - started )) s."
psql "$TARGET" -XAtqc "SELECT 'businesses: ' || count(*) FROM public.businesses" 2>/dev/null || true
