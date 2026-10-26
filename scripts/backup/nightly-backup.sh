#!/usr/bin/env bash
# =============================================================================
# nightly-backup.sh — A589: back the production database up, owner-controlled, every night at 00:00 Nairobi.
#
# Owner, 2026-10-25: "how can I be doing backups to protect my client data each night at 12am".
# Run by .github/workflows/nightly-backup.yml; the whole design, the setup and the restore: docs/BACKUPS.md.
#
#   1. pg_dump the database (custom format -Fc, compressed) — schemas public, auth (the owners' sign-ins) and storage
#      (file metadata) by default (BACKUP_SCHEMAS).
#   2. CHECK it: pg_restore --list must read it, with table data, including public.businesses.
#   3. ENCRYPT it before it leaves this machine: gpg, symmetric AES-256, the passphrase from BACKUP_PASSPHRASE (the dump
#      holds every client's data) — then decrypt it again and compare the SHA-256 (the file that is uploaded restores).
#   4. UPLOAD to off-site storage — Cloudflare R2 (S3-compatible) with the aws CLI: daily/<YYYY-MM-DD>/…, and on the 1st of
#      the month (Nairobi) also monthly/<YYYY-MM>/…. NEVER a GitHub artifact (the repository is public).
#   5. PRUNE: keep the newest 30 daily and 12 monthly folders; older ones are deleted. Only after a good upload.
#   6. (optional) the Supabase Storage bucket(s) in BACKUP_STORAGE_BUCKETS, encrypted the same way (a failure there is a
#      warning: the database is what matters — product images live on Cloudinary, logos in the database).
#   7. STATUS: status/latest.json and a line in status/history.jsonl in the bucket; the result as JSON in BACKUP_RESULT
#      for the workflow's report step (scripts/backup/report.sh — the admin portal, and the alert on a failure).
#
# Environment (secrets — none is printed; the passphrase goes to gpg on a file descriptor, never the command line):
#   BACKUP_DATABASE_URL   postgresql://… a READ-ONLY role with BYPASSRLS (docs/BACKUPS.md § the role), session pooler
#   BACKUP_PASSPHRASE     the encryption passphrase (at least 20 characters) — keep a copy OFF GitHub, or no restore
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#   optional: BACKUP_SCHEMAS ("public auth storage"), BACKUP_KEEP_DAILY (30), BACKUP_KEEP_MONTHLY (12),
#             BACKUP_STORAGE_BUCKETS ("" = none) with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY,
#             BACKUP_RESULT (where the result JSON goes), BACKUP_LOCAL_DIR (TESTS ONLY: a folder instead of R2)
# =============================================================================
set -Eeuo pipefail   # -E: the failure trap runs inside functions too
set +x   # never trace: the secrets are in the environment
umask 077

STEP="starting"
STARTED=$(date -u +%s)
RESULT="${BACKUP_RESULT:-${RUNNER_TEMP:-/tmp}/backup-result.json}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-30}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"
SCHEMAS="${BACKUP_SCHEMAS:-public auth storage}"
WORK=$(mktemp -d "${RUNNER_TEMP:-/tmp}/zaptill-backup.XXXXXX")
WARN=""

cleanup() {
  # The plain dump never outlives the run (the runner is thrown away too; this is for a local run).
  if [ -d "$WORK" ]; then
    find "$WORK" -type f -exec sh -c 'command -v shred >/dev/null 2>&1 && shred -u "$1" 2>/dev/null || rm -f "$1"' _ {} \; 2>/dev/null || true
    rm -rf "$WORK"
  fi
}
fail() {
  local code=$?
  echo "::error::The backup FAILED while ${STEP} (exit ${code})."
  jq -cn --arg step "$STEP" --argjson code "$code" --argjson s "$(( $(date -u +%s) - STARTED ))" \
    '{status:"fail",error:("failed while " + $step + " (exit " + ($code|tostring) + ")"),seconds:$s}' > "$RESULT" || true
  cleanup
  exit "$code"
}
trap fail ERR
trap cleanup EXIT

need() { local v; for v in "$@"; do if [ -z "${!v:-}" ]; then echo "::error::$v is not set (docs/BACKUPS.md § the secrets)"; return 1; fi; done; }

# ── where the copies go: R2 (the aws CLI) — or, for a local test, a folder ────────────────────────────────────────────
if [ -n "${BACKUP_LOCAL_DIR:-}" ]; then
  STEP="checking the settings"
  need BACKUP_DATABASE_URL BACKUP_PASSPHRASE
  mkdir -p "$BACKUP_LOCAL_DIR"
  put_object()    { mkdir -p "$(dirname "$BACKUP_LOCAL_DIR/$2")"; cp "$1" "$BACKUP_LOCAL_DIR/$2"; }
  copy_object()   { mkdir -p "$(dirname "$BACKUP_LOCAL_DIR/$2")"; cp "$BACKUP_LOCAL_DIR/$1" "$BACKUP_LOCAL_DIR/$2"; }
  get_object()    { if [ -f "$BACKUP_LOCAL_DIR/$1" ]; then cp "$BACKUP_LOCAL_DIR/$1" "$2"; else return 1; fi; }
  list_folders()  { [ -d "$BACKUP_LOCAL_DIR/$1" ] && ls -1 "$BACKUP_LOCAL_DIR/$1" || true; }
  delete_folder() { rm -rf "${BACKUP_LOCAL_DIR:?}/$1"; }
  object_size()   { wc -c < "$BACKUP_LOCAL_DIR/$1" | tr -d ' '; }
  WHERE="local folder"
else
  STEP="checking the settings"
  need BACKUP_DATABASE_URL BACKUP_PASSPHRASE R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
  # R2 and the newest aws CLI checksums: only when the API requires them.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  EP="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  s3() { aws --endpoint-url "$EP" --only-show-errors "$@"; }
  put_object()    { s3 s3 cp "$1" "s3://$R2_BUCKET/$2"; }
  copy_object()   { s3 s3 cp "s3://$R2_BUCKET/$1" "s3://$R2_BUCKET/$2"; }
  get_object()    { s3 s3 cp "s3://$R2_BUCKET/$1" "$2" 2>/dev/null; }
  list_folders()  { s3 s3 ls "s3://$R2_BUCKET/$1/" | awk '$1 == "PRE" { sub(/\/$/, "", $2); print $2 }'; }
  delete_folder() { s3 s3 rm --recursive "s3://$R2_BUCKET/$1/"; }
  object_size()   { s3 s3api head-object --bucket "$R2_BUCKET" --key "$1" --query ContentLength --output text; }
  WHERE="R2 bucket $R2_BUCKET"
fi
if [ "${#BACKUP_PASSPHRASE}" -lt 20 ]; then STEP="checking the passphrase"; echo "::error::BACKUP_PASSPHRASE is shorter than 20 characters"; false; fi

# ── 1. the dump ───────────────────────────────────────────────────────────────────────────────────────────────────────
STEP="checking the PostgreSQL versions"
SERVER_NUM=$(psql "$BACKUP_DATABASE_URL" -XAtqc 'SHOW server_version_num')
SERVER_MAJOR=$(( SERVER_NUM / 10000 ))
CLIENT_MAJOR=$(pg_dump --version | grep -oE '[0-9]+(\.[0-9]+)+' | head -1 | cut -d. -f1)
echo "Database: PostgreSQL $SERVER_MAJOR (server_version_num $SERVER_NUM); pg_dump $CLIENT_MAJOR."
if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
  echo "::error::pg_dump $CLIENT_MAJOR cannot dump PostgreSQL $SERVER_MAJOR — set the repository variable BACKUP_PG_MAJOR=$SERVER_MAJOR"
  false
fi

# Nairobi time is UTC+3 all year (no daylight saving) — computed, so a machine without the time-zone files agrees.
NOW_EAT=$(( $(date -u +%s) + 3 * 3600 ))
eat() { date -u -d "@$NOW_EAT" "$@"; }
DATE=$(eat +%Y-%m-%d)
MONTH=$(eat +%Y-%m)
DAY=$(eat +%d)
STAMP=$(eat +%Y-%m-%dT%H%M)
NAME="zaptill-${STAMP}EAT.dump.gpg"
DUMP="$WORK/zaptill.dump"
ENC="$WORK/$NAME"

STEP="dumping the database"
SCHEMA_ARGS=()
for s in $SCHEMAS; do SCHEMA_ARGS+=("--schema=$s"); done
pg_dump --dbname="$BACKUP_DATABASE_URL" --format=custom --compress=6 --no-password "${SCHEMA_ARGS[@]}" --file="$DUMP"
DUMP_BYTES=$(wc -c < "$DUMP" | tr -d ' ')
echo "Dumped ${SCHEMAS}: $DUMP_BYTES bytes."

# ── 2. the check: readable, with data, the main table there ───────────────────────────────────────────────────────────
STEP="checking the dump (pg_restore --list)"
pg_restore --list "$DUMP" > "$WORK/list.txt"
TABLES=$(grep -c ' TABLE DATA ' "$WORK/list.txt" || true)
if [ "${TABLES:-0}" -lt 1 ]; then echo "::error::the dump has no table data"; false; fi
if ! grep -qE ' TABLE DATA public businesses ' "$WORK/list.txt"; then echo "::error::the dump has no public.businesses data"; false; fi
echo "pg_restore reads it: $TABLES tables with data."

# ── 3. encrypt, then prove it decrypts to the same bytes ──────────────────────────────────────────────────────────────
STEP="encrypting the dump"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
  --s2k-digest-algo SHA512 --s2k-count 65011712 --output "$ENC" "$DUMP" 3<<<"$BACKUP_PASSPHRASE"
STEP="checking the encrypted file decrypts"
PLAIN_SHA=$(sha256sum "$DUMP" | cut -d' ' -f1)
ROUND_SHA=$(gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$ENC" 3<<<"$BACKUP_PASSPHRASE" | sha256sum | cut -d' ' -f1)
if [ "$PLAIN_SHA" != "$ROUND_SHA" ]; then echo "::error::the encrypted file does not decrypt to the dump"; false; fi
ENC_SHA=$(sha256sum "$ENC" | cut -d' ' -f1)
ENC_BYTES=$(wc -c < "$ENC" | tr -d ' ')
# The plain dump is not needed any more: gone before anything is uploaded.
rm -f "$DUMP"

# ── 4. upload (the encrypted file only) ───────────────────────────────────────────────────────────────────────────────
STEP="uploading to $WHERE"
OBJECT="daily/$DATE/$NAME"
put_object "$ENC" "$OBJECT"
STEP="checking the upload"
UP_BYTES=$(object_size "$OBJECT")
if [ "$UP_BYTES" != "$ENC_BYTES" ]; then echo "::error::the uploaded object is $UP_BYTES bytes, not $ENC_BYTES"; false; fi
jq -cn --arg o "$OBJECT" --arg sha "$ENC_SHA" --argjson b "$ENC_BYTES" --argjson t "$TABLES" --arg pg "$SERVER_MAJOR" --arg s "$SCHEMAS" \
  '{object:$o,sha256:$sha,bytes:$b,tables:$t,postgres:$pg,schemas:$s,cipher:"gpg symmetric AES256"}' > "$WORK/manifest.json"
put_object "$WORK/manifest.json" "$OBJECT.json"
if [ "$DAY" = "01" ]; then
  STEP="keeping the monthly copy"
  copy_object "$OBJECT" "monthly/$MONTH/$NAME"
  copy_object "$OBJECT.json" "monthly/$MONTH/$NAME.json"
fi
echo "Uploaded $OBJECT ($ENC_BYTES bytes, sha256 $ENC_SHA)."

# ── 5. retention: 30 daily, 12 monthly ────────────────────────────────────────────────────────────────────────────────
prune() {
  local prefix="$1" keep="$2" pattern="$3" f
  mapfile -t all < <(list_folders "$prefix" | grep -E "$pattern" | sort -r)
  if [ "${#all[@]}" -le "$keep" ]; then return 0; fi
  for f in "${all[@]:$keep}"; do echo "Pruning $prefix/$f"; delete_folder "$prefix/$f"; done
}
STEP="pruning old backups"
prune daily "$KEEP_DAILY" '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
prune monthly "$KEEP_MONTHLY" '^[0-9]{4}-[0-9]{2}$'

# ── 6. (optional) Supabase Storage buckets ────────────────────────────────────────────────────────────────────────────
backup_bucket() {
  local bucket="$1" dir="$WORK/storage/$1" n=0
  mkdir -p "$dir"
  # Every object, folders walked (the Storage API lists one level at a time).
  walk() {
    local prefix="$1" body list
    body=$(jq -cn --arg p "$prefix" '{prefix:$p,limit:1000,offset:0,sortBy:{column:"name",order:"asc"}}')
    list=$(printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' "$SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_SERVICE_ROLE_KEY" \
      | curl -sS --fail --max-time 60 -K - -H 'Content-Type: application/json' --data "$body" "$SUPABASE_URL/storage/v1/object/list/$bucket")
    local name id
    while IFS=$'\t' read -r name id; do
      [ -z "$name" ] && continue
      if [ "$id" = "null" ]; then walk "${prefix:+$prefix/}$name"; continue; fi
      local key="${prefix:+$prefix/}$name"
      mkdir -p "$dir/$(dirname "$key")"
      printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_SERVICE_ROLE_KEY" \
        | curl -sS --fail --max-time 120 -K - -o "$dir/$key" "$SUPABASE_URL/storage/v1/object/$bucket/$key"
      n=$((n + 1))
    done < <(jq -r '.[] | [.name, (.id // "null")] | @tsv' <<<"$list")
  }
  walk ""
  tar -C "$WORK/storage" -cf "$WORK/storage-$bucket.tar" "$bucket"
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
    --output "$WORK/storage-$bucket.tar.gpg" "$WORK/storage-$bucket.tar" 3<<<"$BACKUP_PASSPHRASE"
  rm -f "$WORK/storage-$bucket.tar"; rm -rf "$dir"
  put_object "$WORK/storage-$bucket.tar.gpg" "daily/$DATE/storage-$bucket.tar.gpg"
  echo "Storage bucket $bucket: $n files."
}
if [ -n "${BACKUP_STORAGE_BUCKETS:-}" ]; then
  if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    WARN="storage buckets not backed up: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"
    echo "::warning::$WARN"
  else
    for b in $BACKUP_STORAGE_BUCKETS; do
      if ! (set -e; trap - ERR; backup_bucket "$b"); then WARN="${WARN:+$WARN; }storage bucket $b not backed up"; echo "::warning::storage bucket $b was not backed up"; fi
    done
  fi
fi

# ── 7. the status ─────────────────────────────────────────────────────────────────────────────────────────────────────
STEP="writing the status"
SECONDS_TAKEN=$(( $(date -u +%s) - STARTED ))
STATUS=ok; [ -n "$WARN" ] && STATUS=warn
jq -cn --arg st "$STATUS" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg o "$OBJECT" --argjson b "$ENC_BYTES" --argjson s "$SECONDS_TAKEN" \
  --argjson t "$TABLES" --arg w "$WARN" --arg sha "$ENC_SHA" \
  '{status:$st,at:$at,object:$o,size_bytes:$b,seconds:$s,tables:$t,sha256:$sha} + (if $w == "" then {} else {warning:$w} end)' > "$RESULT"
cp "$RESULT" "$WORK/latest.json"
put_object "$WORK/latest.json" "status/latest.json"
get_object "status/history.jsonl" "$WORK/history.jsonl" || : > "$WORK/history.jsonl"
cat "$RESULT" >> "$WORK/history.jsonl"
tail -n 400 "$WORK/history.jsonl" > "$WORK/history.trim" && mv "$WORK/history.trim" "$WORK/history.jsonl"
put_object "$WORK/history.jsonl" "status/history.jsonl"

echo "Backup $STATUS: $OBJECT, $ENC_BYTES bytes, ${SECONDS_TAKEN} s."
