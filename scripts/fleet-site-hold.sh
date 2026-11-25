#!/bin/bash
# ==============================================================================
# Site hold: stop a site's scheduled jobs, or freeze it, during a server move
# ==============================================================================
# For moving a store, or any site busy enough that an order, signup or form
# entry written during the move must not be lost. The move runs in two passes:
#
#   1. NEW server, before the first copy:   hold-jobs   (the copy stays silent)
#   2. first copy with the site open (GridPane's own move), then check the copy
#   3. scripts/fleet-site-final-copy.sh ... rehearse    (site still open)
#   4. OLD server:                          freeze      (503 page, jobs stop)
#   5. scripts/fleet-site-final-copy.sh ... final       (counts must MATCH)
#   6. NEW server:                          release-jobs, clear the page cache,
#      then move DNS. Leave the OLD server frozen until it is retired.
#
# Usage:
#   bash scripts/fleet-site-hold.sh <site> <server> status
#   bash scripts/fleet-site-hold.sh <site> <server> hold-jobs    [--live]
#   bash scripts/fleet-site-hold.sh <site> <server> release-jobs [--live]
#   bash scripts/fleet-site-hold.sh <site> <server> freeze       [--live]
#   bash scripts/fleet-site-hold.sh <site> <server> unfreeze     [--live]
#
# <site> is the site's folder name under /var/www (shop.example.com). <server> is a
# label from the server list (see lib-fleet-servers.sh), or an IPv4
# address for a server not in the list yet.
#
# WITHOUT --live nothing is changed: it says what the action would do and
# prints the status. status never changes anything.
#
# WHAT --live CHANGES ON THE SERVER is described at the top of
# fleet-site-hold.remote.sh. In short: one job file moved out of /etc/cron.d and
# kept out, and for freeze one small file in the site's nginx folder followed by
# an nginx reload (after nginx's config test passes; never a restart).
#
# WHAT IT NEVER DOES: touch the database or the site's files, change DNS or
# Cloudflare, suspend the site in GridPane, or stop PHP.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/lib-fleet-ssh.sh"
REMOTE="$HERE/fleet-site-hold.remote.sh"
LIST_FROM="$HERE/lib-fleet-servers.sh"
for f in "$LIB" "$REMOTE" "$LIST_FROM"; do [ -r "$f" ] || { echo "ABORT: cannot read $f"; exit 1; }; done
# shellcheck source=lib-fleet-servers.sh
. "$LIST_FROM"
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"
# The names the server program installs under come from fleet.config.ts; this
# stops here if they cannot be read.
# shellcheck source=lib-fleet-names.sh
. "$HERE/lib-fleet-names.sh"
REMOTE_PROGRAM="$(fleet_names_script "$REMOTE")" || exit 1

SITE=""; SERVER=""; ACTION=""; LIVE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --live) LIVE=1 ;;
        -*) echo "Unknown option: $1"; exit 2 ;;
        *) if [ -z "$SITE" ]; then SITE="$1"; elif [ -z "$SERVER" ]; then SERVER="$1"; elif [ -z "$ACTION" ]; then ACTION="$1"; else echo "Too many arguments: $1"; exit 2; fi ;;
    esac
    shift
done
[ -n "$ACTION" ] || { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
printf '%s' "$SITE" | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || { echo "\"$SITE\" is not a site name (want the folder name under /var/www, like shop.example.com)"; exit 2; }

if printf '%s' "$SERVER" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then IP="$SERVER"
else IP=$(fleet_server_ip "$SERVER"); fi
[ -n "$IP" ] || { echo "ABORT: \"$SERVER\" is not in the server list and is not an IPv4 address."; exit 1; }

case "$ACTION" in
    status)       WHAT="read only" ;;
    hold-jobs)    WHAT="keep $SITE's scheduled jobs from running on $SERVER" ;;
    release-jobs) WHAT="let $SITE's scheduled jobs run again on $SERVER" ;;
    freeze)       WHAT="show a 503 maintenance page for every request to $SITE on $SERVER, and stop its jobs" ;;
    unfreeze)     WHAT="take the maintenance page off $SITE on $SERVER and let its jobs run again" ;;
    *) echo "Unknown action: $ACTION (use status | hold-jobs | release-jobs | freeze | unfreeze)"; exit 2 ;;
esac
RUN="$ACTION"
if [ "$ACTION" != status ] && [ "$LIVE" != 1 ]; then RUN=status; fi

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if ! ssh-add -l 2>/dev/null | grep -q "$KEY_FP" && [ -S "$OP_SOCK" ]; then export SSH_AUTH_SOCK="$OP_SOCK"; fi
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
# shellcheck disable=SC2034  # read by fleet_ssh
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

echo "site:    $SITE"
echo "server:  $SERVER ($IP)"
echo "action:  $ACTION: $WHAT"
if [ "$RUN" != "$ACTION" ]; then echo "mode:    dry run. Nothing is changed; the status below is what is there now. Add --live to do it."
elif [ "$ACTION" = status ]; then echo "mode:    read only"
else echo "mode:    LIVE"; fi
echo

fleet_ssh "$IP" "$REMOTE_PROGRAM" "$RUN" "$SITE" "$IP"
if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo "ABORT: no answer from $SERVER. Nothing is known to have changed; run status before trying again."; exit 1; fi
printf '%s\n' "$FLEET_SSH_OUT" | grep -v '^site_hold_result='
RESULT=$(printf '%s\n' "$FLEET_SSH_OUT" | sed -n 's/^site_hold_result=//p' | tail -1)
echo
case "$RESULT" in
    ok) if [ "$RUN" = "$ACTION" ]; then echo "✓ $ACTION: done on $SERVER."; else echo "Dry run complete. Nothing was changed."; fi; exit 0 ;;
    check) echo "✗ $ACTION did not finish cleanly on $SERVER. Read the lines above."; exit 1 ;;
    stop) echo "✗ $ACTION was refused on $SERVER (see STOP above)."; exit 1 ;;
    *) echo "✗ the answer from $SERVER was cut off. Run status to see what is in place."; exit 1 ;;
esac
