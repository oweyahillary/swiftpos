#!/usr/bin/env bash
# =============================================================================
# alert-format.sh — A592: the words of the admin's alerts from the GitHub workflows, the same as the server's
# (apps/server/src/lib/alertFormat.ts): Nairobi times ("Mon 26 Oct 13:07 EAT"), short durations ("just now", "45 min",
# "3 h 15 min", "1 day", "16 days"), HTML escaping for Telegram and the email, and a backup step in plain words.
#
# Owner, 2026-10-26, on "ZapTill nightly backup FAILED — 26 Oct 13:07 … failed while checking the upload (exit 252)":
# "How can we make these messages look better".
#
#   . scripts/ops/alert-format.sh      # sourced by scripts/ops/notify-admin.sh, scripts/backup/report.sh and
#                                      # .github/workflows/uptime-check.yml; defines functions only
# =============================================================================

# & < > " → entities (Telegram's HTML parser refuses the whole message over one stray "<" or "&").
html_escape() {
  if [ "$#" -gt 0 ]; then printf '%s' "$1" | html_escape; return; fi
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

# Nairobi is UTC+3 all year (no daylight saving) — computed, so a runner without the time-zone files agrees.
_eat() { local e="${1:-$(date -u +%s)}"; shift; printf '%s' "$(date -u -d "@$(( e + 10800 ))" "$@")"; }
eat_day()   { _eat "${1:-}" '+%a %-d %b'; }            # Mon 26 Oct
eat_time()  { _eat "${1:-}" '+%H:%M EAT'; }            # 13:07 EAT
eat_stamp() { _eat "${1:-}" '+%a %-d %b %H:%M EAT'; }  # Mon 26 Oct 13:07 EAT

# Minutes → "just now" / "45 min" / "3 h 15 min" / "1 day" / "16 days" (lib/watchdogRules.ts shortDuration).
human_minutes() {
  local m="${1:-}"; m="${m%%.*}"
  if ! [[ "$m" =~ ^[0-9]+$ ]]; then printf 'a while'; return; fi
  if (( m < 1 )); then printf 'just now'
  elif (( m < 60 )); then printf '%d min' "$m"
  else
    local h=$(( m / 60 )) r=$(( m % 60 ))
    if (( h < 24 )); then if (( r )); then printf '%d h %d min' "$h" "$r"; else printf '%d h' "$h"; fi
    elif (( h < 48 )); then printf '1 day'
    else printf '%d days' $(( h / 24 )); fi
  fi
}

# An ISO time → "Sun 25 Oct (1 day ago)"; nothing when it cannot be read.
day_ago() {
  local t; t=$(date -u -d "${1:-}" +%s 2>/dev/null) || return 0
  local m=$(( ( $(date -u +%s) - t ) / 60 )) h
  h=$(human_minutes "$m")
  if [ "$h" = "just now" ]; then printf '%s (just now)' "$(eat_day "$t")"; else printf '%s (%s ago)' "$(eat_day "$t")" "$h"; fi
}

# A backup step (scripts/backup/nightly-backup.sh STEP) and its exit code in plain words — the aws CLI's codes:
# 252 a command it could not read, 253 the settings or keys, 254 the storage refused, 255 any other failure.
# The server says the same (apps/server/src/lib/opsEvents.ts backupStepWords).
backup_step_words() {
  local s="${1:-}" code="${2:-}" why=""
  [ -n "$s" ] || s="an unknown step"
  case "$s" in
    "checking the dump"*) s="checking the dump can be read" ;;
    "checking the PostgreSQL versions"*) s="connecting to the database" ;;
    "checking the settings"*) s="checking the settings (a secret is missing)" ;;
    "uploading to "*) s="uploading to the storage (R2)" ;;
  esac
  case "$s" in
    *upload*|*storage*|*R2*|*pruning*|*"monthly copy"*|*status*)
      case "$code" in
        252) why="the storage command was given an option it does not know" ;;
        253) why="the storage settings or keys are wrong" ;;
        254) why="the storage refused the request" ;;
        255) why="the storage command failed" ;;
      esac ;;
  esac
  case "$code" in
    124) printf '%s — timed out' "$s"; return ;;
    130|143) printf '%s — cancelled' "$s"; return ;;
    ""|0) printf '%s' "$s"; return ;;
  esac
  if [ -n "$why" ]; then printf '%s (exit %s — %s)' "$s" "$code" "$why"; else printf '%s (exit %s)' "$s" "$code"; fi
}
