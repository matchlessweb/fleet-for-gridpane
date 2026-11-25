#!/bin/bash
# ==============================================================================
# Server snapshot — the hand-added server settings, saved per server
# ==============================================================================
# Before a server is moved (to a new machine, a new Ubuntu release), save the
# small set of server-level settings that the move is not documented to carry:
# the Fail2Ban setup, the server-wide nginx additions, firewall rules, and facts
# such as the outbound address and PHP/MySQL tuning. fleet-server-restore.sh
# reads a snapshot back and says, or does, what the new server needs.
#
# THIS IS NOT A BACKUP of sites, databases or uploads. It is a few dozen small
# text files per server.
#
# Usage:
#   bash scripts/fleet-server-snapshot.sh              # every server
#   bash scripts/fleet-server-snapshot.sh web1         # one server (label or address)
#
# READ-ONLY on every server. The program that runs there is
# fleet-server-snapshot.remote.sh; it sends no credential (see its header).
# Snapshots are written outside the repository, in a folder only you can read:
#   <output folder>/<date>-server-snapshots/<label>/
#     facts.txt  manifest.json  files/<the server's own paths>  raw.txt
# The output folder is FLEET_OUTPUT_DIR, or the full path on one line in
# ~/.config/fleet/output-dir, else ~/.local/state/fleet. SERVER_SNAPSHOT_OUT
# names another folder for one run.
# Run it again on the same day and that day's folder is replaced per server.
# Nothing here prints a file's content.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/lib-fleet-ssh.sh"
REMOTE_FILE="$HERE/fleet-server-snapshot.remote.sh"
PYLIB="$HERE/fleet-server-snapshot-lib.py"
LIST_FROM="$HERE/lib-fleet-servers.sh"
for f in "$LIB" "$REMOTE_FILE" "$PYLIB" "$LIST_FROM"; do
    [ -r "$f" ] || { echo "ABORT: cannot read $f"; exit 1; }
done
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"
# The names the server program looks for come from fleet.config.ts; this stops
# here if they cannot be read. It also exports them for the Python half.
# shellcheck source=lib-fleet-names.sh
. "$HERE/lib-fleet-names.sh"

# shellcheck source=lib-fleet-servers.sh
. "$LIST_FROM"
fleet_servers_load || exit 1
COUNT=$(printf '%s\n' "$SERVERS" | grep -c .)
[ "$COUNT" -ge 1 ] || { echo "ABORT: no servers found in $(fleet_servers_file)"; exit 1; }

ONLY="${1:-}"
case "$ONLY" in -*) echo "Unknown option: $ONLY (this script only reads)"; exit 2 ;; esac

. "$(dirname "$0")/lib-fleet-output.sh" || exit 1; FLEET_OUT="$(fleet_output_dir)"   # the folder runs, audits and snapshots are kept in
OUTDIR="${SERVER_SNAPSHOT_OUT:-$FLEET_OUT/$(date +%F)-server-snapshots}"
mkdir -p "$OUTDIR" && chmod 700 "$OUTDIR"

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if ssh-add -l 2>/dev/null | grep -q "$KEY_FP"; then
    echo "using system ssh-agent (fleet key already loaded — no prompts)"
elif [ -S "$OP_SOCK" ]; then
    export SSH_AUTH_SOCK="$OP_SOCK"
    echo "using 1Password SSH agent (approve the Touch ID prompts)"
else
    echo "WARNING: fleet key not found in any agent — ssh will likely fail"
fi
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"
REMOTE="$(fleet_names_script "$REMOTE_FILE")" || exit 1

echo "mode: snapshot (read-only) — $COUNT servers listed — saved in $OUTDIR"
echo

val() { sed -n "s/^$1=//p" "$2" | head -1; }
asked=0; good=0
for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    asked=$((asked + 1))
    echo "── $LABEL ─────────────────────────"
    fleet_ssh "$IP" "$REMOTE"
    if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo; continue; fi

    # Build beside the final folder and swap in only when the unpack is good, so
    # a failed run never replaces a good snapshot with half of one.
    NEW="$OUTDIR/.$LABEL.new"; DEST="$OUTDIR/$LABEL"
    case "$NEW" in "$OUTDIR"/.*.new) ;; *) echo "ABORT: unexpected path $NEW"; exit 1 ;; esac
    if [ -e "$NEW" ]; then mv "$NEW" "$OUTDIR/.$LABEL.failed-$(date +%H%M%S)"; fi
    mkdir -p "$NEW" && chmod 700 "$NEW"
    printf '%s\n' "$FLEET_SSH_OUT" > "$NEW/raw.txt"; chmod 600 "$NEW/raw.txt"
    if SUMMARY=$(python3 "$PYLIB" unpack "$NEW/raw.txt" "$NEW" 2>&1); then
        if [ -e "$DEST" ]; then mv "$DEST" "$OUTDIR/.$LABEL.previous-$(date +%H%M%S)"; fi
        mv "$NEW" "$DEST"
        good=$((good + 1))
        F="$DEST/facts.txt"
        echo "   ✓ saved: $(printf '%s\n' "$SUMMARY" | sed -n 's/^files //p'), $(printf '%s\n' "$SUMMARY" | sed -n 's/^sites=//p') site(s)"
        echo "   outbound IPv4: $(val egress_ipv4 "$F")   $(val os "$F")   per-site jails: $(val "jails_$FLEET_PREFIX" "$F")   nginx test: $(val nginx_config_test "$F")"
        printf '%s\n' "$SUMMARY" | grep '^withheld ' | sed 's/^/   ! /'
    else
        echo "   ✗ NOT SAVED — the answer was cut off or did not match its hashes; any earlier snapshot is untouched"
        printf '%s\n' "$SUMMARY" | grep -E '^(complete|BAD|Traceback|ValueError)' | sed 's/^/     /'
    fi
    echo
done

echo "Asked $asked server(s); $good saved in full."
[ "$asked" -eq "$good" ] || echo "NOT A FULL SET: $((asked - good)) server(s) were not saved."
[ -n "$ONLY" ] && echo "(scoped to \"$ONLY\" — the other servers were not asked)"
[ "$asked" -ge 1 ] || { echo "No server matched \"$ONLY\"."; exit 1; }
[ "$asked" -eq "$good" ]
