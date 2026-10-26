#!/usr/bin/env bash
# =============================================================================
# report.sh — A589: after the nightly backup (.github/workflows/nightly-backup.yml, `if: always()`), say how it went.
#
#   • the admin portal's System page: POST <PROD_URL>/api/ops/events, kind 'backup' (OPS_INGEST_TOKEN) — "Last nightly
#     backup: 00:03, 48.2 MB, OK". A FAILED backup there is the server's instant alert (email + Telegram + the bell).
#   • when the server did not take the event (it is down, or the token is not set) and the backup FAILED: the admin is
#     told from here (scripts/ops/notify-admin.sh) — a failed backup is never silent.
#   • the job ends red on a failure (GitHub e-mails too).
#
# A592 (owner, 2026-10-26: "How can we make these messages look better"): the alert reads
#   🔴 Backup failed — Mon 26 Oct 13:07 EAT
#   Step: checking the upload (exit 252 — the storage command was given an option it does not know)
#   Last good backup: Sun 25 Oct (1 day ago)            ← status/latest.json in the bucket, read best effort
#   👉 The earlier backups are untouched. Fix the cause, then run it again …
#   [Open run] [Guide] [Open in admin]
# and the last good backup goes to the server with the event, so its alert says the same.
#
# Reads BACKUP_RESULT (written by scripts/backup/nightly-backup.sh); no result at all = the backup step never finished.
# =============================================================================
set -euo pipefail
set +x

# shellcheck source=scripts/ops/alert-format.sh
. "$(dirname "$0")/../ops/alert-format.sh"

RESULT="${BACKUP_RESULT:-${RUNNER_TEMP:-/tmp}/backup-result.json}"
API="${PROD_URL:-https://api.zaptill.co.ke}"; API="${API%/}"
RUN_URL="${RUN_URL:-}"
ADMIN="${ADMIN_PORTAL_URL:-https://admin.zaptill.co.ke}"; ADMIN="${ADMIN%/}"
GUIDE="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-oweyahillary/swiftpos}/blob/main/docs/BACKUPS.md"

if [ -s "$RESULT" ] && jq -e . "$RESULT" >/dev/null 2>&1; then R=$(cat "$RESULT"); else
  R=$(jq -cn '{status:"fail",step:"the backup step (it did not finish: cancelled, timed out, or the PostgreSQL client did not install)",error:"the backup step did not finish (cancelled, timed out, or the PostgreSQL client did not install)"}')
fi
STATUS=$(jq -r '.status // "fail"' <<<"$R")
MB=$(jq -r 'if (.size_bytes // 0) >= 1048576 then ((.size_bytes / 1048576 * 10 | round) / 10 | tostring) + " MB"
  elif .size_bytes then ((.size_bytes / 1024 | round) | tostring) + " KB" else "" end' <<<"$R")

# The last good backup: status/latest.json (written only after a good run) — best effort, never fails the report.
LAST_AT=""; LAST_NEVER=0
if [ -n "${BACKUP_LOCAL_DIR:-}" ]; then
  if [ -f "$BACKUP_LOCAL_DIR/status/latest.json" ]; then LAST_AT=$(jq -r '.at // empty' "$BACKUP_LOCAL_DIR/status/latest.json" 2>/dev/null || true); else LAST_NEVER=1; fi
elif [ -n "${R2_BUCKET:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && command -v aws >/dev/null 2>&1; then
  EP="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" AWS_DEFAULT_REGION=auto
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  if J=$(timeout 60 aws --endpoint-url "$EP" s3 cp "s3://$R2_BUCKET/status/latest.json" - 2>/dev/null); then
    LAST_AT=$(jq -r '.at // empty' <<<"$J" 2>/dev/null || true)
  elif [ "$(timeout 60 aws --endpoint-url "$EP" s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix status/latest.json --query KeyCount --output text 2>/dev/null || true)" = "0" ]; then
    LAST_NEVER=1
  fi
fi
if [ -n "$LAST_AT" ]; then LAST=$(day_ago "$LAST_AT"); elif [ "$LAST_NEVER" = 1 ]; then LAST="never"; else LAST=""; fi

if [ "$STATUS" = "fail" ]; then
  STEP=$(jq -r '.step // empty' <<<"$R"); CODE=$(jq -r '.exit // empty' <<<"$R")
  if [ -z "$STEP" ]; then   # an older result: "failed while <step> (exit <n>)"
    STEP=$(jq -r '.error // ""' <<<"$R" | sed -n 's/^failed while \(.*\) (exit \([0-9]*\))$/\1/p')
    CODE=$(jq -r '.error // ""' <<<"$R" | sed -n 's/^failed while .* (exit \([0-9]*\))$/\1/p')
  fi
  WORDS=$(backup_step_words "$STEP" "$CODE")
  TITLE="Backup failed - $WORDS"
elif [ "$STATUS" = "warn" ]; then
  TITLE="Backup OK with a warning - $MB, $(jq -r '.seconds' <<<"$R") s ($(jq -r '.warning' <<<"$R"))"
else
  TITLE="Backup OK - $MB, $(jq -r '.seconds' <<<"$R") s"
fi
echo "$TITLE"

POSTED=0
if [ -n "${OPS_INGEST_TOKEN:-}" ]; then
  # A592: the body from a file (a Windows curl re-encodes its arguments — "—" in the step words).
  EVF=$(mktemp "${TMPDIR:-/tmp}/backup-event.XXXXXX")
  jq -cn --arg st "$STATUS" --arg t "${TITLE:0:200}" --arg u "$RUN_URL" --arg la "$LAST_AT" --argjson ln "$LAST_NEVER" --argjson r "$R" \
    '{kind:"backup",status:$st,title:$t,details:($r + {run_url:$u} + (if $la != "" then {last_good_at:$la} elif $ln == 1 then {last_good:"never"} else {} end)),source:"github"}' > "$EVF"
  EVP="$EVF"; command -v cygpath >/dev/null 2>&1 && EVP=$(cygpath -m "$EVF")
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$OPS_INGEST_TOKEN" | curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -K - \
    -X POST "$API/api/ops/events" -H 'Content-Type: application/json' --data-binary @"$EVP") || code=000
  rm -f "$EVF"
  if [ "$code" = "201" ]; then POSTED=1; echo "Recorded on the admin portal (System)."
  else echo "::warning::the result was not recorded on the admin portal (HTTP $code)"; fi
else
  echo "::warning::OPS_INGEST_TOKEN is not set — the result is not shown on the admin portal"
fi

if [ "$STATUS" = "fail" ]; then
  if [ "$POSTED" = 0 ]; then
    FACTS=(--fact "Step|$WORDS")
    [ -n "$LAST" ] && FACTS+=(--fact "Last good backup|$LAST")
    BTNS=()
    [ -n "$RUN_URL" ] && BTNS+=(--button "Open run|$RUN_URL")
    BTNS+=(--button "Guide|$GUIDE" --button "Open in admin|$ADMIN/?open=system")
    bash "$(dirname "$0")/../ops/notify-admin.sh" --tone critical --subject "🔴 Backup failed · $(eat_day)" "${FACTS[@]}" \
      --action "The earlier backups are untouched. Fix the cause, then run it again: GitHub › Actions › Nightly backup › Run workflow." \
      "${BTNS[@]}" \
      "Backup failed — $(eat_stamp)" \
      "Told from GitHub: the server did not take the result (it is down, or OPS_INGEST_TOKEN is not set)." || true
  fi
  exit 1
fi
