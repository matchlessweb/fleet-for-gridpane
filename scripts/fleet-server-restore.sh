#!/bin/bash
# ==============================================================================
# Server restore — bring a moved server back to its snapshot
# ==============================================================================
# After a server has been moved (GridPane's own move onto a new machine), read
# the new machine, compare it with the snapshot fleet-server-snapshot.sh took of
# the old one, and say what is missing. With --live, put back the small
# hand-added files that are missing. The Fail2Ban jails are not copied: they are
# rebuilt for the sites that are really there by fleet-fail2ban-apply.sh, and
# this script ends by printing those commands.
#
# Usage:
#   bash scripts/fleet-server-restore.sh <label>                    # dry run: compare only
#   bash scripts/fleet-server-restore.sh <label> --target <addr>    # the new machine, before the
#                                                                   #   server list has its address
#   bash scripts/fleet-server-restore.sh <label> --live             # also install missing files
#   bash scripts/fleet-server-restore.sh <label> --snapshot <dir>   # a snapshot other than the latest
#
# <label> is the server's name in the snapshot (and in the server list, see
# lib-fleet-servers.sh). Without --target, the address comes from that
# list, so after a move either pass --target or update the list first.
# Without --snapshot, the latest one for that label is used, from the output
# folder fleet-server-snapshot.sh writes to (FLEET_OUTPUT_DIR, or the full path
# on one line in ~/.config/fleet/output-dir, else ~/.local/state/fleet).
#
# THE DRY RUN ALWAYS RUNS FIRST, even with --live, and --live stops if the dry
# run found a reason not to continue: a WordPress site from the snapshot that is
# not on the target yet, or an nginx config that already fails its own test.
#
# WHAT --live CHANGES ON THE TARGET, and nothing else:
#   /etc/nginx/extra.d/**                             server-wide nginx additions
#   /etc/logrotate.d/<prefix>-*                       the 7G log rotation rule
#   /etc/fail2ban/jail.d/<prefix>-allowlist.local     the operator allowlist
# only where the file is missing, never over an existing file; each nginx file
# is tested on its own and taken out again if nginx's config test fails with it.
# See fleet-server-restore.remote.sh.
#
# WHAT IT NEVER DOES: copy a credential (the Cloudflare token comes from where
# you keep it when the apply script runs), copy per-site nginx files (GridPane
# generates those), change firewall rules, touch Cloudflare, or restart nginx.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/lib-fleet-ssh.sh"
SNAP_REMOTE="$HERE/fleet-server-snapshot.remote.sh"
RESTORE_REMOTE="$HERE/fleet-server-restore.remote.sh"
PYLIB="$HERE/fleet-server-snapshot-lib.py"
LIST_FROM="$HERE/lib-fleet-servers.sh"
for f in "$LIB" "$SNAP_REMOTE" "$RESTORE_REMOTE" "$PYLIB" "$LIST_FROM"; do
    [ -r "$f" ] || { echo "ABORT: cannot read $f"; exit 1; }
done
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"
# <prefix> above is server.prefix in fleet.config.ts. The two server programs
# carry placeholders for it; they are filled in here, and this stops if the
# names cannot be read. It also exports them for the Python half.
# shellcheck source=lib-fleet-names.sh
. "$HERE/lib-fleet-names.sh"
SNAP_PROGRAM="$(fleet_names_script "$SNAP_REMOTE")" || exit 1

LABEL=""; TARGET=""; LIVE=0; SNAP=""
while [ $# -gt 0 ]; do
    case "$1" in
        --live) LIVE=1 ;;
        --target) [ $# -ge 2 ] || { echo "--target needs an address"; exit 2; }; TARGET="$2"; shift ;;
        --snapshot) [ $# -ge 2 ] || { echo "--snapshot needs a folder"; exit 2; }; SNAP="$2"; shift ;;
        -*) echo "Unknown option: $1"; exit 2 ;;
        *) [ -z "$LABEL" ] || { echo "One server at a time (got \"$LABEL\" and \"$1\")"; exit 2; }; LABEL="$1" ;;
    esac
    shift
done
[ -n "$LABEL" ] || { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

. "$(dirname "$0")/lib-fleet-output.sh" || exit 1; FLEET_OUT="$(fleet_output_dir)"   # the folder runs, audits and snapshots are kept in
if [ -z "$SNAP" ]; then
    SNAP=$(ls -d "$FLEET_OUT"/*-server-snapshots/"$LABEL" 2>/dev/null | tail -1)
    if [ -z "$SNAP" ]; then
        # Nothing there does not mean no snapshot was ever taken: it may be kept
        # in another folder, and the old server may no longer be there to ask.
        echo "ABORT: no snapshot found for $LABEL."
        fleet_output_dir_hint
        echo "       Or name one snapshot's folder for this run: --snapshot <path>"
        echo "       If no snapshot of $LABEL was ever taken and the old server still answers, take one now:"
        echo "       bash scripts/fleet-server-snapshot.sh $LABEL"
        exit 1
    fi
fi
[ -r "$SNAP/manifest.json" ] || { echo "ABORT: $SNAP holds no whole snapshot: there is no manifest.json in it."; exit 1; }

# shellcheck source=lib-fleet-servers.sh
. "$LIST_FROM"
LISTED_IP=$(fleet_server_ip "$LABEL")
[ -n "$TARGET" ] || TARGET="$LISTED_IP"
[ -n "$TARGET" ] || { echo "ABORT: $LABEL is not in the server list and no --target was given."; exit 1; }

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if ! ssh-add -l 2>/dev/null | grep -q "$KEY_FP" && [ -S "$OP_SOCK" ]; then export SSH_AUTH_SOCK="$OP_SOCK"; fi
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/fleet-restore.XXXXXX"); chmod 700 "$WORK"
echo "server:   $LABEL"
echo "snapshot: $SNAP  (taken $(sed -n 's/^taken_utc=//p' "$SNAP/facts.txt"))"
echo "target:   $TARGET$([ "$TARGET" = "$LISTED_IP" ] && echo '  (the address in the server list)')"
echo "mode:     $([ "$LIVE" = 1 ] && echo 'LIVE: missing files will be installed after the dry run' || echo 'dry run: nothing on the target is changed')"
echo

# ---- 1. read the target as it is now (read-only) ----------------------------
fleet_ssh "$TARGET" "$SNAP_PROGRAM"
if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo "ABORT: could not read the target."; exit 1; fi
mkdir -p "$WORK/target"; printf '%s\n' "$FLEET_SSH_OUT" > "$WORK/target/raw.txt"
python3 "$PYLIB" unpack "$WORK/target/raw.txt" "$WORK/target" > "$WORK/unpack.txt" 2>&1 \
    || { echo "ABORT: the read of the target was cut off or did not match its hashes."; grep -E '^(complete|BAD)' "$WORK/unpack.txt"; exit 1; }

# ---- 2. compare --------------------------------------------------------------
python3 "$PYLIB" compare "$SNAP" "$WORK/target" --plan "$WORK/plan.json"
RC=$?
echo
case "$RC" in
    0) echo "✓ dry run: the target already matches the snapshot. Nothing to restore."; exit 0 ;;
    10) ;;
    20) echo "✗ dry run: not ready for a live restore (see BLOCKED above). Nothing was changed."; exit 1 ;;
    *) echo "✗ the comparison could not run. Nothing was changed."; exit 1 ;;
esac
N=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["install"]))' "$WORK/plan.json")

fail2ban_next() {
    echo "Fail2Ban is rebuilt, not copied. In this order:"
    if [ "$TARGET" != "$LISTED_IP" ]; then
        echo "  0. Put the new address in the server list ($(fleet_servers_file)), the line for $LABEL"
    fi
    echo "  1. In Cloudflare, set the IP lock on this server's Fail2Ban token (the one you keep as f2b-$(printf '%s' "$LABEL" | tr 'A-Z_' 'a-z-')) to the target's outbound address (shown above)"
    echo "  2. bash scripts/fleet-fail2ban.sh $LABEL                 # fresh audit of the new machine"
    echo "  3. bash scripts/fleet-fail2ban-apply.sh $LABEL           # dry run"
    echo "  4. bash scripts/fleet-fail2ban-apply.sh $LABEL --live    # jails, then the ban-and-unban proof"
}

if [ "$LIVE" != 1 ]; then
    echo "Dry run complete: there is work to do (see \"to do\" above); $N file(s) would be installed by --live. Nothing was changed."
    echo; fail2ban_next
    exit 0
fi

# ---- 3. live: install the missing files --------------------------------------
if [ "$N" -gt 0 ]; then
    fleet_names_script "$RESTORE_REMOTE" > "$WORK/restore.remote.sh" || { echo "ABORT: could not build the restore program. Nothing was changed."; exit 1; }
    python3 "$PYLIB" program "$WORK/plan.json" "$WORK/restore.remote.sh" > "$WORK/restore.sh"
    [ $? = 0 ] || { echo "ABORT: could not build the restore program. Nothing was changed."; exit 1; }
    echo "Installing $N missing file(s) on $TARGET ..."
    fleet_ssh "$TARGET" "$(cat "$WORK/restore.sh")"
    printf '%s\n' "$FLEET_SSH_OUT" | sed 's/^/   /'
    printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^restore_complete=yes$' || { echo "✗ the restore did not finish. Read the lines above; run the dry run again to see what is in place."; exit 1; }
    printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^nginx_test_after=ok$' || { echo "✗ nginx's config test fails after the restore. nginx was not reloaded; fix this before anything else."; exit 1; }
else
    echo "No file needs installing."
fi

# ---- 4. read the target again and compare, so the result is measured ---------
echo; echo "Reading the target again ..."
fleet_ssh "$TARGET" "$SNAP_PROGRAM"
mkdir -p "$WORK/after"; printf '%s\n' "$FLEET_SSH_OUT" > "$WORK/after/raw.txt"
python3 "$PYLIB" unpack "$WORK/after/raw.txt" "$WORK/after" > /dev/null 2>&1 || { echo "✗ could not read the target after the restore."; exit 1; }
python3 "$PYLIB" compare "$SNAP" "$WORK/after" --plan "$WORK/plan-after.json" | sed -n '/^== Files a restore/,/^== Fail2Ban/p;/^== Result/,$p'
LEFT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["install"]))' "$WORK/plan-after.json")
echo
if [ "$LEFT" = 0 ]; then echo "✓ files restored: none of the snapshot's restorable files is missing now."
else echo "✗ $LEFT file(s) are still missing (each one's reason is in the lines above)."; fi
echo; fail2ban_next
[ "$LEFT" = 0 ]
