#!/usr/bin/env bash
# Quick-run wrapper — reads credentials from environment or prompts
# Usage: ./tests/run.sh [--stress] [--verbose]

set -e

EMAIL="${SWIFTPOS_EMAIL:-}"
PASSWORD="${SWIFTPOS_PASSWORD:-}"
URL="${SWIFTPOS_URL:-http://localhost:4000}"

if [ -z "$EMAIL" ]; then
  read -p "Owner email: " EMAIL
fi
if [ -z "$PASSWORD" ]; then
  read -s -p "Owner password: " PASSWORD
  echo
fi

node "$(dirname "$0")/runner.mjs" \
  --url "$URL" \
  --email "$EMAIL" \
  --password "$PASSWORD" \
  "$@"
