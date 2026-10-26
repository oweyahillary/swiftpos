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
# Reads BACKUP_RESULT (written by scripts/backup/nightly-backup.sh); no result at all = the backup step never finished.
# =============================================================================
set -euo pipefail
set +x

RESULT="${BACKUP_RESULT:-${RUNNER_TEMP:-/tmp}/backup-result.json}"
API="${PROD_URL:-https://api.zaptill.co.ke}"; API="${API%/}"
RUN_URL="${RUN_URL:-}"

if [ -s "$RESULT" ] && jq -e . "$RESULT" >/dev/null 2>&1; then R=$(cat "$RESULT"); else
  R=$(jq -cn '{status:"fail",error:"the backup step did not finish (cancelled, timed out, or the PostgreSQL client did not install)"}')
fi
STATUS=$(jq -r '.status // "fail"' <<<"$R")
EAT=$(date -u -d "@$(( $(date -u +%s) + 10800 ))" '+%d %b %H:%M')   # Nairobi, UTC+3 all year
MB=$(jq -r 'if (.size_bytes // 0) >= 1048576 then ((.size_bytes / 1048576 * 10 | round) / 10 | tostring) + " MB"
  elif .size_bytes then ((.size_bytes / 1024 | round) | tostring) + " KB" else "" end' <<<"$R")

if [ "$STATUS" = "fail" ]; then
  TITLE="Backup FAILED - $(jq -r '.error // "unknown"' <<<"$R")"
elif [ "$STATUS" = "warn" ]; then
  TITLE="Backup OK with a warning - $MB, $(jq -r '.seconds' <<<"$R") s ($(jq -r '.warning' <<<"$R"))"
else
  TITLE="Backup OK - $MB, $(jq -r '.seconds' <<<"$R") s"
fi
echo "$TITLE"

POSTED=0
if [ -n "${OPS_INGEST_TOKEN:-}" ]; then
  EV=$(jq -cn --arg st "$STATUS" --arg t "${TITLE:0:200}" --arg u "$RUN_URL" --argjson r "$R" \
    '{kind:"backup",status:$st,title:$t,details:($r + {run_url:$u}),source:"github"}')
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$OPS_INGEST_TOKEN" | curl -sS -o /tmp/backup-event.out -w '%{http_code}' --max-time 60 -K - \
    -X POST "$API/api/ops/events" -H 'Content-Type: application/json' --data "$EV") || code=000
  if [ "$code" = "201" ]; then POSTED=1; echo "Recorded on the admin portal (System)."
  else echo "::warning::the result was not recorded on the admin portal (HTTP $code)"; fi
else
  echo "::warning::OPS_INGEST_TOKEN is not set — the result is not shown on the admin portal"
fi

if [ "$STATUS" = "fail" ]; then
  if [ "$POSTED" = 0 ]; then
    bash "$(dirname "$0")/../ops/notify-admin.sh" "ZapTill nightly backup FAILED — $EAT" \
      "$(printf '🔴 The nightly backup of the ZapTill database FAILED (%s Nairobi).\n%s\n\nThe previous backups are untouched. Fix it, then GitHub › Actions › Nightly backup › Run workflow.\nRun: %s\ndocs/BACKUPS.md' "$EAT" "$TITLE" "$RUN_URL")" || true
  fi
  exit 1
fi
