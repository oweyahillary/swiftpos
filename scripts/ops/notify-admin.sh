#!/usr/bin/env bash
# =============================================================================
# notify-admin.sh — A589: tell the ZapTill admin from a GitHub workflow, when the server itself cannot (it is down, or
# the nightly backup failed and the server did not take the event). The same channels the server uses
# (apps/server/src/lib/alertNotify.ts): email through Resend (else SendGrid) and Telegram.
#
#   bash scripts/ops/notify-admin.sh "<subject>" "<text>"
#
# Environment (GitHub repository secrets — none is printed; secrets go to curl on stdin, never on its command line):
#   ADMIN_ALERT_EMAIL      who gets the email (several: comma-separated)
#   RESEND_API_KEY         Resend (the server's primary mail provider)            — either this …
#   SENDGRID_API_KEY       SendGrid (the server's fallback)                       — … or this
#   ALERT_FROM_EMAIL       the sender (default: ZapTill <noreply@zaptill.co.ke> — a domain verified at the provider)
#   TELEGRAM_BOT_TOKEN     the bot's token                                         — optional
#   TELEGRAM_CHAT_ID       the chat / group / channel id (several: comma-separated) — optional
#
# Exit 0 when at least one channel delivered, 3 when none did (nothing set, or every provider refused).
# =============================================================================
set -euo pipefail
set +x   # never trace: the secrets are in the environment

SUBJECT="${1:?subject}"
TEXT="${2:?text}"
FROM="${ALERT_FROM_EMAIL:-ZapTill <noreply@zaptill.co.ke>}"
# The providers' addresses (overridable only so tests/nightly-backup-a589.test.mjs can point them at a local server).
RESEND_URL="${NOTIFY_RESEND_URL:-https://api.resend.com/emails}"
SENDGRID_URL="${NOTIFY_SENDGRID_URL:-https://api.sendgrid.com/v3/mail/send}"
TELEGRAM_URL="${NOTIFY_TELEGRAM_URL:-https://api.telegram.org}"
delivered=0

# "Name <a@b>" → a@b and Name (SendGrid wants them apart).
from_email() { local f="$1"; if [[ "$f" =~ \<([^>]+)\> ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf '%s' "$f"; fi; }
from_name() { local f="$1"; if [[ "$f" =~ ^[[:space:]]*\"?([^\"<]*[^\"<[:space:]])\"?[[:space:]]*\< ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf 'ZapTill'; fi; }

# A JSON array of the addresses.
recipients_json() { printf '%s' "$1" | tr ',;' '\n\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | jq -R . | jq -sc .; }

html_body() { printf '%s' "$TEXT" | jq -Rrs '"<div style=\"font-family:system-ui,sans-serif;font-size:14px;white-space:pre-wrap\">" + (gsub("&";"&amp;") | gsub("<";"&lt;") | gsub(">";"&gt;")) + "</div>"'; }

send_resend() {
  local to; to=$(recipients_json "$ADMIN_ALERT_EMAIL")
  local body; body=$(jq -cn --arg from "$FROM" --argjson to "$to" --arg subject "$SUBJECT" --arg text "$TEXT" --arg html "$(html_body)" \
    '{from:$from,to:$to,subject:$subject,text:$text,html:$html}')
  local code
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$RESEND_API_KEY" | curl -sS -o /tmp/notify-resend.out -w '%{http_code}' --max-time 30 \
    -K - -H 'Content-Type: application/json' --data "$body" "$RESEND_URL") || code=000
  [[ "$code" == 2* ]] && return 0
  echo "::warning::Resend refused the email (HTTP $code): $(head -c 300 /tmp/notify-resend.out 2>/dev/null || true)"
  return 1
}

send_sendgrid() {
  local to; to=$(recipients_json "$ADMIN_ALERT_EMAIL" | jq -c 'map({email:.})')
  local body; body=$(jq -cn --arg fe "$(from_email "$FROM")" --arg fn "$(from_name "$FROM")" --argjson to "$to" --arg subject "$SUBJECT" --arg text "$TEXT" --arg html "$(html_body)" \
    '{personalizations:[{to:$to}],from:{email:$fe,name:$fn},subject:$subject,content:[{type:"text/plain",value:$text},{type:"text/html",value:$html}]}')
  local code
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$SENDGRID_API_KEY" | curl -sS -o /tmp/notify-sendgrid.out -w '%{http_code}' --max-time 30 \
    -K - -H 'Content-Type: application/json' --data "$body" "$SENDGRID_URL") || code=000
  [[ "$code" == 2* ]] && return 0
  echo "::warning::SendGrid refused the email (HTTP $code): $(head -c 300 /tmp/notify-sendgrid.out 2>/dev/null || true)"
  return 1
}

send_telegram() {
  local ok=1 chat
  for chat in $(printf '%s' "$TELEGRAM_CHAT_ID" | tr ',;' '  '); do
    local body; body=$(jq -cn --arg chat "$chat" --arg text "$(printf '%s\n%s' "$SUBJECT" "$TEXT" | head -c 4000)" '{chat_id:$chat,text:$text,disable_web_page_preview:true}')
    local code
    code=$(printf 'url = "%s/bot%s/sendMessage"\n' "$TELEGRAM_URL" "$TELEGRAM_BOT_TOKEN" | curl -sS -o /tmp/notify-tg.out -w '%{http_code}' --max-time 30 \
      -K - -H 'Content-Type: application/json' --data "$body") || code=000
    if [[ "$code" == 2* ]]; then ok=0; else echo "::warning::Telegram refused the message for one chat (HTTP $code)"; fi
  done
  return $ok
}

if [ -n "${ADMIN_ALERT_EMAIL:-}" ]; then
  if [ -n "${RESEND_API_KEY:-}" ] && send_resend; then delivered=1; echo "Email sent (Resend)."
  elif [ -n "${SENDGRID_API_KEY:-}" ] && send_sendgrid; then delivered=1; echo "Email sent (SendGrid)."
  elif [ -z "${RESEND_API_KEY:-}" ] && [ -z "${SENDGRID_API_KEY:-}" ]; then echo "::warning::No mail provider secret (RESEND_API_KEY or SENDGRID_API_KEY) — no email."
  fi
else
  echo "::warning::ADMIN_ALERT_EMAIL is not set — no email."
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  if send_telegram; then delivered=1; echo "Telegram sent."; fi
fi

if [ "$delivered" = 1 ]; then exit 0; fi
echo "::error::The admin could not be told by any channel: $SUBJECT"
exit 3
