#!/usr/bin/env bash
# =============================================================================
# notify-admin.sh — A589: tell the ZapTill admin from a GitHub workflow, when the server itself cannot (it is down, or
# the nightly backup failed and the server did not take the event). The same channels the server uses
# (apps/server/src/lib/alertNotify.ts): email through Resend (else SendGrid) and Telegram.
#
# A592 (owner, 2026-10-26: "How can we make these messages look better"): laid out like the server's alerts
# (apps/server/src/lib/alertFormat.ts) — a bold headline with its emoji, a summary, "Label: value" facts, one 👉 line of
# what to do, and URL buttons under the Telegram message; the email in the same layout with a plain-text part.
#
#   bash scripts/ops/notify-admin.sh [options] "<headline>" ["<summary>"]
#     --tone critical|warning|resolved|info   the emoji and the colour (🔴 / 🟠 / ✅ / ℹ️); none = no emoji
#     --subject "<text>"                      the email's subject (default: the emoji and the headline)
#     --fact "Label|Value"                    a fact line (repeat)
#     --action "<text>"                       what to do, one line
#     --button "Text|https://…"               a link button (repeat; http(s) only)
#   The old form — notify-admin.sh "<subject>" "<text>" — still works (the text as it is, the subject as given).
#
# Telegram: parse_mode HTML, every value escaped (scripts/ops/alert-format.sh html_escape), sent with curl
# --data-urlencode and a JSON reply_markup. Telegram refuses a message it cannot read (HTTP 400 "can't parse entities",
# or a button it will not take) → sent ONCE MORE as plain text, the links written out: an alert is never lost.
#
# Environment (GitHub repository secrets — none is printed; secrets go to curl on stdin, never on its command line):
#   ADMIN_ALERT_EMAIL      who gets the email (several: comma-separated)
#   RESEND_API_KEY         Resend (the server's primary mail provider)            — either this …
#   SENDGRID_API_KEY       SendGrid (the server's fallback)                       — … or this
#   ALERT_FROM_EMAIL       the sender (default: ZapTill <noreply@zaptill.co.ke> — a domain verified at the provider)
#   TELEGRAM_BOT_TOKEN     the bot's token                                         — optional
#   TELEGRAM_CHAT_ID       the chat / group / channel id (several: comma-separated) — optional
#   ADMIN_PORTAL_URL       the admin portal in the email's footer (default https://admin.zaptill.co.ke)
#
# Exit 0 when at least one channel delivered, 3 when none did (nothing set, or every provider refused).
# =============================================================================
set -euo pipefail
set +x   # never trace: the secrets are in the environment

# shellcheck source=scripts/ops/alert-format.sh
. "$(dirname "$0")/alert-format.sh"

TONE=""; SUBJECT=""; ACTION=""; FACTS=(); BUTTONS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tone) TONE="${2:-}"; shift 2 ;;
    --subject) SUBJECT="${2:-}"; shift 2 ;;
    --fact) FACTS+=("${2:-}"); shift 2 ;;
    --action) ACTION="${2:-}"; shift 2 ;;
    --button) BUTTONS+=("${2:-}"); shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
HEADLINE="${1:?headline}"
SUMMARY="${2:-}"

case "$TONE" in
  critical) EMOJI="🔴"; COLOR="#d92d20"; WORD="Critical" ;;
  warning)  EMOJI="🟠"; COLOR="#dc6803"; WORD="Warning" ;;
  resolved) EMOJI="✅"; COLOR="#079455"; WORD="Resolved" ;;
  info)     EMOJI="ℹ️"; COLOR="#475467"; WORD="Notice" ;;
  *)        EMOJI="";   COLOR="#475467"; WORD="Notice" ;;
esac
TITLE="${EMOJI:+$EMOJI }$HEADLINE"
SUBJECT="${SUBJECT:-$TITLE}"
FROM="${ALERT_FROM_EMAIL:-ZapTill <noreply@zaptill.co.ke>}"
ADMIN="${ADMIN_PORTAL_URL:-https://admin.zaptill.co.ke}"; ADMIN="${ADMIN%/}"
# The providers' addresses (overridable only so the tests can point them at a local server).
RESEND_URL="${NOTIFY_RESEND_URL:-https://api.resend.com/emails}"
SENDGRID_URL="${NOTIFY_SENDGRID_URL:-https://api.sendgrid.com/v3/mail/send}"
TELEGRAM_URL="${NOTIFY_TELEGRAM_URL:-https://api.telegram.org}"
# Its own folder for the bodies and the answers (gone at the end).
OUT=$(mktemp -d "${RUNNER_TEMP:-/tmp}/notify-admin.XXXXXX" 2>/dev/null || mktemp -d)
trap 'rm -rf "$OUT"' EXIT
delivered=0

# ── the buttons: "Text|URL", http(s) only ────────────────────────────────────────────────────────────────────────────
BTN_TEXT=(); BTN_URL=()
for b in "${BUTTONS[@]+"${BUTTONS[@]}"}"; do
  t="${b%%|*}"; u="${b#*|}"
  if [ -n "$t" ] && [ "$t" != "$b" ] && [[ "$u" =~ ^https?://[^[:space:]]+$ ]]; then BTN_TEXT+=("${t:0:40}"); BTN_URL+=("$u"); fi
done
# reply_markup: two to a row.
KEYBOARD=""
if [ "${#BTN_TEXT[@]}" -gt 0 ]; then
  KEYBOARD=$(for i in "${!BTN_TEXT[@]}"; do jq -cn --arg t "${BTN_TEXT[$i]}" --arg u "${BTN_URL[$i]}" '{text:$t,url:$u}'; done \
    | jq -sc '[range(0; length; 2) as $i | .[$i:$i+2]] | {inline_keyboard: .}')
fi

# ── the three texts: Telegram HTML, plain text (Telegram's fallback, the email's text part), the email's HTML ──────
TG_HTML="${EMOJI:+$EMOJI }<b>$(html_escape "$HEADLINE")</b>"
PLAIN="$TITLE"
[ -n "$SUMMARY" ] && { TG_HTML+=$'\n'"$(html_escape "$SUMMARY")"; PLAIN+=$'\n'"$SUMMARY"; }
if [ "${#FACTS[@]}" -gt 0 ]; then
  TG_HTML+=$'\n'; PLAIN+=$'\n'
  for f in "${FACTS[@]}"; do
    k="${f%%|*}"; v="${f#*|}"; [ "$k" = "$f" ] && { k=""; v="$f"; }
    if [ -n "$k" ]; then TG_HTML+=$'\n'"<b>$(html_escape "$k"):</b> $(html_escape "$v")"; PLAIN+=$'\n'"$k: $v"
    else TG_HTML+=$'\n'"$(html_escape "$v")"; PLAIN+=$'\n'"$v"; fi
  done
fi
[ -n "$ACTION" ] && { TG_HTML+=$'\n\n'"👉 $(html_escape "$ACTION")"; PLAIN+=$'\n\n'"👉 $ACTION"; }
if [ "${#BTN_TEXT[@]}" -gt 0 ]; then
  PLAIN+=$'\n'
  for i in "${!BTN_TEXT[@]}"; do PLAIN+=$'\n'"${BTN_TEXT[$i]}: ${BTN_URL[$i]}"; done
fi
TG_HTML="${TG_HTML:0:3900}"
PLAIN="${PLAIN:0:4000}"
EMAIL_TEXT="$PLAIN"$'\n\n'"—"$'\n'"Admin portal › Alerts: $ADMIN/?open=alerts"

FONT="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
html_body() {
  local rows="" f k v i
  rows+="<tr><td style=\"height:6px;background:$COLOR;font-size:0;line-height:0;border-radius:12px 12px 0 0\">&nbsp;</td></tr>"
  rows+="<tr><td style=\"padding:22px 28px 6px\"><div style=\"font:600 11px/1.4 $FONT;letter-spacing:.08em;text-transform:uppercase;color:#667085\">ZapTill admin · $WORD</div></td></tr>"
  rows+="<tr><td style=\"padding:0 28px 10px\"><div style=\"font:700 20px/1.3 $FONT;color:#101828\">${EMOJI:+$EMOJI }$(html_escape "$HEADLINE")</div></td></tr>"
  if [ -n "$SUMMARY" ]; then
    rows+="<tr><td style=\"padding:0 28px 14px\"><div style=\"font:15px/1.5 $FONT;color:#344054;white-space:pre-wrap\">$(html_escape "$SUMMARY")</div></td></tr>"
  fi
  if [ "${#FACTS[@]}" -gt 0 ]; then
    rows+="<tr><td style=\"padding:0 28px 14px\"><table cellpadding=\"0\" cellspacing=\"0\" style=\"border-collapse:collapse;width:100%\">"
    for f in "${FACTS[@]}"; do
      k="${f%%|*}"; v="${f#*|}"; [ "$k" = "$f" ] && { k=""; v="$f"; }
      rows+="<tr><td style=\"padding:4px 12px 4px 0;font:13px/1.45 $FONT;color:#667085;white-space:nowrap;vertical-align:top;width:1%\">$(html_escape "$k")</td>"
      rows+="<td style=\"padding:4px 0;font:600 13px/1.45 $FONT;color:#101828;vertical-align:top\">$(html_escape "$v")</td></tr>"
    done
    rows+="</table></td></tr>"
  fi
  if [ -n "$ACTION" ]; then
    rows+="<tr><td style=\"padding:0 28px 14px\"><div style=\"background:#f9fafb;border-left:4px solid $COLOR;border-radius:6px;padding:10px 14px;font:14px/1.5 $FONT;color:#101828\">👉 $(html_escape "$ACTION")</div></td></tr>"
  fi
  if [ "${#BTN_TEXT[@]}" -gt 0 ]; then
    rows+="<tr><td style=\"padding:6px 28px 20px\">"
    for i in "${!BTN_TEXT[@]}"; do
      if [ "$i" = 0 ]; then local bg="$COLOR" fg="#ffffff" bd="$COLOR"; else local bg="#ffffff" fg="#344054" bd="#d0d5dd"; fi
      rows+="<a href=\"$(html_escape "${BTN_URL[$i]}")\" style=\"display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:8px;background:$bg;color:$fg;border:1px solid $bd;font:600 14px/1 $FONT;text-decoration:none\">$(html_escape "${BTN_TEXT[$i]}")</a>"
    done
    rows+="</td></tr>"
  fi
  printf '%s' "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body style=\"margin:0;padding:0;background:#f2f4f7\">"
  printf '%s' "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" style=\"background:#f2f4f7\"><tr><td align=\"center\" style=\"padding:24px 12px\">"
  printf '%s' "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" width=\"100%\" style=\"max-width:680px;background:#ffffff;border:1px solid #eaecf0;border-radius:12px;border-collapse:separate\">$rows</table>"
  printf '%s' "<div style=\"font:12px/1.6 $FONT;color:#667085;padding:14px 8px 0;text-align:center\">Sent from GitHub Actions (the server could not send it). <a href=\"$(html_escape "$ADMIN/?open=alerts")\" style=\"color:#475467\">Admin portal › Alerts</a> · Email settings (which alerts are emailed at once): Alerts › Email settings</div>"
  printf '%s' "</td></tr></table></body></html>"
}

# A file's path as curl takes it after "@" (Git Bash on Windows: C:/…; Linux: as it is).
fpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# "Name <a@b>" → a@b and Name (SendGrid wants them apart).
from_email() { local f="$1"; if [[ "$f" =~ \<([^>]+)\> ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf '%s' "$f"; fi; }
from_name() { local f="$1"; if [[ "$f" =~ ^[[:space:]]*\"?([^\"<]*[^\"<[:space:]])\"?[[:space:]]*\< ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf 'ZapTill'; fi; }

# A JSON array of the addresses.
recipients_json() { printf '%s' "$1" | tr ',;' '\n\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | jq -R . | jq -sc .; }

send_resend() {
  local to; to=$(recipients_json "$ADMIN_ALERT_EMAIL")
  # A592: the body from a file, never a command-line argument (a Windows curl re-encodes its arguments: "🔴" became "??").
  jq -cn --arg from "$FROM" --argjson to "$to" --arg subject "$SUBJECT" --arg text "$EMAIL_TEXT" --arg html "$(html_body)" \
    '{from:$from,to:$to,subject:$subject,text:$text,html:$html}' > "$OUT/notify-resend.json"
  local code
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$RESEND_API_KEY" | curl -sS -o "$OUT/notify-resend.out" -w '%{http_code}' --max-time 30 \
    -K - -H 'Content-Type: application/json' --data-binary @"$(fpath "$OUT/notify-resend.json")" "$RESEND_URL") || code=000
  [[ "$code" == 2* ]] && return 0
  echo "::warning::Resend refused the email (HTTP $code): $(head -c 300 "$OUT/notify-resend.out" 2>/dev/null || true)"
  return 1
}

send_sendgrid() {
  local to; to=$(recipients_json "$ADMIN_ALERT_EMAIL" | jq -c 'map({email:.})')
  jq -cn --arg fe "$(from_email "$FROM")" --arg fn "$(from_name "$FROM")" --argjson to "$to" --arg subject "$SUBJECT" --arg text "$EMAIL_TEXT" --arg html "$(html_body)" \
    '{personalizations:[{to:$to}],from:{email:$fe,name:$fn},subject:$subject,content:[{type:"text/plain",value:$text},{type:"text/html",value:$html}]}' > "$OUT/notify-sendgrid.json"
  local code
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$SENDGRID_API_KEY" | curl -sS -o "$OUT/notify-sendgrid.out" -w '%{http_code}' --max-time 30 \
    -K - -H 'Content-Type: application/json' --data-binary @"$(fpath "$OUT/notify-sendgrid.json")" "$SENDGRID_URL") || code=000
  [[ "$code" == 2* ]] && return 0
  echo "::warning::SendGrid refused the email (HTTP $code): $(head -c 300 "$OUT/notify-sendgrid.out" 2>/dev/null || true)"
  return 1
}

# One sendMessage: the token in the URL from curl's config on stdin (never on the command line), the fields urlencoded.
tg_post() {
  local chat="$1"; shift
  printf 'url = "%s/bot%s/sendMessage"\n' "$TELEGRAM_URL" "$TELEGRAM_BOT_TOKEN" | curl -sS -o "$OUT/notify-tg.out" -w '%{http_code}' --max-time 30 \
    -K - --data-urlencode "chat_id=$chat" --data-urlencode "disable_web_page_preview=true" "$@"
}

send_telegram() {
  local ok=1 chat code markup=()
  # The texts from files (curl --data-urlencode name@file): never re-encoded as command-line arguments.
  printf '%s' "$TG_HTML" > "$OUT/notify-tg-html.txt"; printf '%s' "$PLAIN" > "$OUT/notify-tg-plain.txt"
  if [ -n "$KEYBOARD" ]; then printf '%s' "$KEYBOARD" > "$OUT/notify-tg-markup.json"; markup=(--data-urlencode "reply_markup@$(fpath "$OUT/notify-tg-markup.json")"); fi
  for chat in $(printf '%s' "$TELEGRAM_CHAT_ID" | tr ',;' '  '); do
    if [ -n "$TONE" ] || [ "${#FACTS[@]}" -gt 0 ] || [ -n "$KEYBOARD" ]; then
      code=$(tg_post "$chat" --data-urlencode "text@$(fpath "$OUT/notify-tg-html.txt")" --data-urlencode "parse_mode=HTML" "${markup[@]}") || code=000
      if [ "$code" = "400" ]; then
        # "can't parse entities" or a button Telegram refused: once more, plain — the alert is never lost.
        echo "::warning::Telegram refused the formatted message ($(head -c 200 "$OUT/notify-tg.out" 2>/dev/null || true)) — sending it as plain text"
        code=$(tg_post "$chat" --data-urlencode "text@$(fpath "$OUT/notify-tg-plain.txt")") || code=000
      fi
    else
      code=$(tg_post "$chat" --data-urlencode "text@$(fpath "$OUT/notify-tg-plain.txt")") || code=000
    fi
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
