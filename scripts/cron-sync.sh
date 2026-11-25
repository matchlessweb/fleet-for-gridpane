#!/bin/bash
# The GridPane sync, for a scheduler (cron, launchd): no terminal, almost no PATH.
#
#   0 * * * * /full/path/to/this/checkout/scripts/cron-sync.sh     # an example: once an hour
#
# It runs `npm run sync`, the command you run by hand, so the two cannot drift
# apart. Everything the sync prints is added to a log: the file $FLEET_SYNC_LOG
# names, else ~/.local/state/fleet/gridpane-sync.log (under $XDG_STATE_HOME when
# that is set), in a folder only you can read: the log holds your site names.
# The exit code is the sync's own.
#
# The sync reads .env.local in this checkout and takes about six seconds a site
# (it paces itself under GridPane's limits), so leave it room to finish before
# the next run starts.
set -u

if [ -n "${FLEET_SYNC_LOG:-}" ]; then LOG="$FLEET_SYNC_LOG"
else
    LOGDIR="${XDG_STATE_HOME:-$HOME/.local/state}/fleet"
    mkdir -p "$LOGDIR" && chmod 700 "$LOGDIR" || exit 1
    LOG="$LOGDIR/gridpane-sync.log"
fi

# A scheduled job starts with almost no PATH: add the usual places for npm, and
# node via nvm when that is how it is installed. What is already on the PATH wins.
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

# The checkout is found from this file's own place, so moving the project does
# not quietly break the scheduled sync.
cd "$(cd "$(dirname "$0")/.." && pwd)" || exit 1
if ! command -v npm >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S')  cron-sync: cannot find npm on the PATH; nothing was synced." >> "$LOG"
    exit 1
fi
npm run -s sync >> "$LOG" 2>&1
