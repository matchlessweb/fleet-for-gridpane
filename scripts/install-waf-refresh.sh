#!/bin/bash
# Install (or remove) the macOS job that runs scripts/waf-refresh.sh once a day.
#
#   scripts/install-waf-refresh.sh              # look: say what --apply would do; change nothing
#   scripts/install-waf-refresh.sh --apply      # install or update the job; daily at 06:15
#   scripts/install-waf-refresh.sh --status     # look: is it installed, and its last log lines
#   scripts/install-waf-refresh.sh --remove     # take the job out
#
# With no option it changes nothing: it names the file --apply would write, the
# job it would load and what that job would run. Only --apply and --remove
# change anything, and only on this machine.
#
# Run it from the checkout the job should use: the job points at THIS copy of
# the repository, so install it from the main checkout, not from a worktree
# that will be deleted. If the Mac is asleep at 06:15, macOS runs the job when
# it next wakes.
#
# The job's label is wafRefreshLabel in fleet.config.ts, and its log is named
# after server.prefix there. Both are read through lib-fleet-names.sh, which
# stops this script if it cannot read them: a different label would install a
# second job beside the first.
set -euo pipefail

# shellcheck source=lib-fleet-names.sh
. "$(cd "$(dirname "$0")" && pwd)/lib-fleet-names.sh"
LABEL="$(fleet_waf_refresh_label)" || exit 1
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$FLEET_PREFIX-fleet-waf-refresh.log"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  --status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "installed: $LABEL"
      grep -A1 '<string>/bin/bash</string>' "$PLIST" | tail -1 | sed 's/<[^>]*>//g; s/^[[:space:]]*/runs: /'
      echo "log:  $LOG"
      [ -f "$LOG" ] && tail -3 "$LOG"
    else
      echo "not installed"
    fi
    exit 0 ;;
  --remove)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    exit 0 ;;
  ""|--apply) ;;
  *) echo "unknown option: $1 (use --apply, --status, --remove, or none to look)" >&2; exit 2 ;;
esac

WORKTREE=0
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 &&
   [ "$(git -C "$REPO" rev-parse --git-dir)" != "$(git -C "$REPO" rev-parse --git-common-dir)" ] &&
   [ "${ALLOW_WORKTREE:-}" != "1" ]; then
  WORKTREE=1
fi

# The job's file, as text. A look compares it with the file that is there; --apply writes it.
plist_text() {
  cat <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$REPO/scripts/waf-refresh.sh</string>
	</array>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
	<!-- Daily at 06:15 local time; a run missed while asleep happens at wake. -->
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>6</integer>
		<key>Minute</key>
		<integer>15</integer>
	</dict>
</dict>
</plist>
PLIST_END
}

if [ "${1:-}" != "--apply" ]; then
  echo "Looked only. Nothing was changed."
  LOADED=0; launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && LOADED=1
  if [ "$LOADED" = 1 ]; then echo "now:    the job $LABEL is loaded"
  else echo "now:    the job $LABEL is not loaded"; fi
  echo
  echo "--apply would:"
  if [ ! -e "$PLIST" ]; then echo "  write   $PLIST   (a new file)"
  elif plist_text | cmp -s - "$PLIST"; then echo "  write   $PLIST   (no change: the file there already says the same)"
  else
    echo "  write   $PLIST   (replacing the file there, which differs)"
    echo "          it runs now: $(grep -A1 '<string>/bin/bash</string>' "$PLIST" | tail -1 | sed 's/<[^>]*>//g; s/^[[:space:]]*//')"
  fi
  if [ "$LOADED" = 1 ]; then echo "  reload  the job $LABEL for your login ($DOMAIN): taken out, then loaded again from that file"
  else echo "  load    the job $LABEL for your login ($DOMAIN)"; fi
  echo "  run     /bin/bash $REPO/scripts/waf-refresh.sh   once a day at 06:15"
  echo "  log to  $LOG"
  echo
  if [ "$WORKTREE" = 1 ]; then
    echo "But --apply would stop here: this is a linked worktree ($REPO), and the job would break when it is removed."
    echo "Run it from the main checkout, or set ALLOW_WORKTREE=1 for a short test."
  else
    echo "To do that:"
    echo "  bash scripts/install-waf-refresh.sh --apply"
  fi
  exit 0
fi

if [ "$WORKTREE" = 1 ]; then
  echo "This is a linked worktree ($REPO). The job would break when it is removed." >&2
  echo "Install from the main checkout, or set ALLOW_WORKTREE=1 for a short test." >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
plist_text > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL: daily at 06:15, running $REPO/scripts/waf-refresh.sh"
echo "log: $LOG"
echo "run it now: launchctl kickstart $DOMAIN/$LABEL"
