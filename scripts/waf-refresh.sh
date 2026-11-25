#!/bin/bash
# Daily Cloudflare WAF refresh:  inventory -> report.json -> Supabase.
#
#   scripts/waf-refresh.sh              # run now
#   scripts/waf-refresh.sh --dry-run    # inventory and validate, write nothing to the database
#
# Started once a day by the macOS job that scripts/install-waf-refresh.sh sets
# up. It runs on your Mac on purpose: the read-only Cloudflare token stays
# there, and is never copied into the app, the database or a hosted runner.
#
# WHAT IT NEEDS ON THIS MACHINE
#   - python3, node and curl on the PATH (the PATH a scheduled job gets is set
#     below).
#   - A Cloudflare API token that can read zones, WAF rulesets and DNS, where
#     the inventory looks for it: the environment variable
#     FLEET_CF_TOKEN_ALL_READ, or a command of your own named in
#     ~/.config/fleet/cloudflare-token-command, or the file
#     ~/.config/fleet/tokens/cloudflare-all-read.token (chmod 600). The details
#     are at the top of scripts/lib-fleet-token.sh. A scheduled job has no
#     environment of yours, so use the command or the file for the daily run.
#   - .env.local in this checkout, for the database (the ingest reads it).
#
# OPTIONAL
#   - Your written standard, so zones are compared and not only listed: its
#     path in WAF_STANDARD or on one line in ~/.config/fleet/waf-standard (see
#     docs/cloudflare-waf-standard.md).
#   - Where runs are kept: FLEET_OUTPUT_DIR, or one line (a full path) in
#     ~/.config/fleet/output-dir. Default: ~/.local/state/fleet (or under
#     $XDG_STATE_HOME). Each day's run is the folder <date>-waf-daily there.
#   - Another inventory script: WAF_INVENTORY=/path/to/script. It must take
#     --out DIR and write DIR/report.json in the same shape.
#
# One generator: this runs scripts/waf-inventory.py unchanged. If you gave it a
# page template it also writes that page into the run folder; this script does
# NOT publish that page anywhere. The app is what stays current.
#
# It never forces anything. A failed inventory, a report that fails validation,
# or a change an unattended run should not accept on its own (a zone gone, a
# zone that lost every rule) is tried once more a minute later; if it fails
# again, nothing is written, and the run date shown on every WAF view simply
# gets older until a person looks.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GENERATOR="${WAF_INVENTORY:-$REPO/scripts/waf-inventory.py}"
. "$(dirname "$0")/lib-fleet-output.sh" || exit 1; FLEET_OUT="$(fleet_output_dir)"   # the folder runs, audits and snapshots are kept in
BACKUPS="$FLEET_OUT"
KEEP_DAYS=30
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

# A scheduled job starts with almost no PATH: add the usual places for your own
# tools (a token command of yours, Homebrew), and node via nvm.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

say() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*"; }
stop() { say "STOPPED: $*"; say "nothing written to the database."; exit 1; }

say "---- WAF refresh starting (repo: $REPO)"
for tool in python3 node curl; do
  command -v "$tool" >/dev/null 2>&1 || stop "cannot find \`$tool\` on PATH"
done
[ -f "$GENERATOR" ] || stop "inventory script not found: $GENERATOR"
[ -f "$REPO/scripts/ingest-waf-report.ts" ] || stop "ingest script not found in $REPO"

# After a wake from sleep the network can take a while. Wait up to 5 minutes.
tries=0
until curl -s -o /dev/null --max-time 10 https://api.cloudflare.com/client/v4/; do
  tries=$((tries + 1))
  [ "$tries" -ge 30 ] && stop "Cloudflare's API was unreachable for 5 minutes"
  sleep 10
done

RUN="$BACKUPS/$(date '+%Y-%m-%d')-waf-daily"
OUT="$RUN/waf-inventory"
mkdir -p "$RUN" && chmod 700 "$RUN" || stop "cannot create $RUN"

# The generator's own output is already masked; it never prints an expression.
#
# Two attempts, 60 seconds apart. Either half can fail on a blip at Cloudflare:
# the inventory stops with no report when one read fails (a zone that could not
# be read is never written down as a zone with no rules), and the unattended
# ingest refuses a report it should not accept on its own. A failed request
# rarely hits the same zone twice, so the whole inventory is taken once more a
# minute later, whichever half failed. What fails both times is real, and is
# left for a person.
#
# WAF_REFRESH_RETRY_SECONDS is that wait, for tests; leave it unset otherwise.
cd "$REPO" || stop "cannot enter $REPO"
PAUSE="${WAF_REFRESH_RETRY_SECONDS:-60}"
case "$PAUSE" in ''|*[!0-9]*) stop "WAF_REFRESH_RETRY_SECONDS must be a whole number of seconds" ;; esac
attempt=1
while :; do
  if ! python3 "$GENERATOR" --out "$OUT"; then
    why="the inventory script failed"
  elif [ ! -s "$OUT/report.json" ]; then
    stop "the inventory wrote no report.json"
  elif node --experimental-strip-types --no-warnings scripts/ingest-waf-report.ts "$RUN" --unattended $DRY; then
    break
  else
    why="the ingest refused this run"
  fi
  [ "$attempt" -ge 2 ] && stop "$why twice (reason above). Run folder kept: $RUN"
  attempt=$((attempt + 1))
  say "$why; taking the inventory once more in $PAUSE seconds"
  sleep "$PAUSE"
done

# Keep a month of daily runs. Only folders this job made (…-waf-daily) are
# touched; a run folder you made by hand under another name is never removed.
find "$BACKUPS" -maxdepth 1 -type d -name '20??-??-??-waf-daily' -mtime +"$KEEP_DAYS" -print0 2>/dev/null |
  while IFS= read -r -d '' old; do
    say "removing run older than $KEEP_DAYS days: $(basename "$old")"
    rm -rf "$old"
  done

say "---- WAF refresh finished"
