#!/bin/bash
# ==============================================================================
# Fail2Ban behind Cloudflare — fleet audit
# ==============================================================================
# Asks every server, read-only, what Fail2Ban is doing today: which jails run,
# what they do when they ban, whether the Cloudflare action exists and how it
# authenticates, which sites really have the WP Fail2Ban plugin loaded (all four
# pieces, not GridPane's toggle), and the address Cloudflare sees the server as.
#
# Usage:
#   bash scripts/fleet-fail2ban.sh                 # audit all servers
#   bash scripts/fleet-fail2ban.sh web1            # one server (label or address)
#
# AUDIT IS THE ONLY MODE. This script changes nothing on any server. The apply
# mode comes later, written from what this audit returns rather than from
# GridPane's documentation, and will be dry-run unless told otherwise.
#
# The program that runs on the server is fleet-fail2ban-audit.remote.sh, kept as
# its own file so it can be tested against a fixture (fleet-fail2ban-selftest.sh).
# Raw output is saved per server, outside the repository, in today's folder
# <date>-fail2ban-audit under your output folder: FLEET_OUTPUT_DIR, or the full
# path on one line in ~/.config/fleet/output-dir, else ~/.local/state/fleet.
# F2B_AUDIT_OUT names another folder for one run. The output carries no secrets
# (the remote program masks every config line) but it does describe your
# production servers.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/lib-fleet-ssh.sh"
REMOTE_FILE="$HERE/fleet-fail2ban-audit.remote.sh"
LIST_FROM="$HERE/lib-fleet-servers.sh"
for f in "$LIB" "$REMOTE_FILE" "$LIST_FROM"; do
    [ -r "$f" ] || { echo "ABORT: cannot read $f"; exit 1; }
done
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"

# One server list for the fleet scripts: read it through lib-fleet-servers.sh,
# which refuses to run if the list is missing or stops looking right.
# shellcheck source=lib-fleet-servers.sh
. "$LIST_FROM"
fleet_servers_load || exit 1
COUNT=$(printf '%s\n' "$SERVERS" | grep -c .)
[ "$COUNT" -ge 1 ] || { echo "ABORT: no servers found in $(fleet_servers_file)"; exit 1; }

ONLY="${1:-}"
case "$ONLY" in -*) echo "Unknown option: $ONLY (this script only audits)"; exit 2 ;; esac

. "$(dirname "$0")/lib-fleet-output.sh" || exit 1; FLEET_OUT="$(fleet_output_dir)"   # the folder runs, audits and snapshots are kept in
OUTDIR="${F2B_AUDIT_OUT:-$FLEET_OUT/$(date +%F)-fail2ban-audit}"
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
REMOTE_AUDIT="$(cat "$REMOTE_FILE")"

echo "mode: audit (read-only) — $COUNT servers listed — raw output in $OUTDIR"
echo

val() { sed -n "s/^$1=//p" "$2" | head -1; }
asked=0; complete=0
for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    asked=$((asked + 1))
    echo "── $LABEL ─────────────────────────"
    fleet_ssh "$IP" "$REMOTE_AUDIT"
    if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo; continue; fi
    RAW="$OUTDIR/$LABEL.txt"
    printf '%s\n' "$FLEET_SSH_OUT" > "$RAW"; chmod 600 "$RAW"

    # A cut-off run looks like a short clean one. The remote prints this line
    # last, so its absence means the answer below is partial.
    if ! grep -q '^audit_complete=yes$' "$RAW"; then
        echo "   ✗ INCOMPLETE — the server stopped answering part-way; do not read the lines below as the whole picture"
    else
        complete=$((complete + 1))
    fi
    echo "   fail2ban:      $(val fail2ban "$RAW") $(val fail2ban_version "$RAW") running=$(val fail2ban_running "$RAW")"
    echo "   outbound IPv4: $(val egress_ipv4 "$RAW")   IPv6: $(val egress_ipv6 "$RAW")"
    echo "   jails:         $(val jails "$RAW")"
    grep '^jail=wordpress' "$RAW" | sed 's/^/     /'
    echo "   cf action:     $(val 'file \/etc\/fail2ban\/action.d\/gpcloudflare.conf' "$RAW")  auth=$(val gpcloudflare_auth "$RAW") endpoint=$(val gpcloudflare_endpoint "$RAW")"
    c() { grep -c "^site=.* verdict=$1 " "$RAW"; }
    quiet=$(grep '^site=.* verdict=on-' "$RAW" | grep -c ' logged=0 ')
    echo "   sites:         $(val wordpress_sites "$RAW") WordPress — on as must-use $(c on-mu), on as plugin $(c on-plugin), off $(c off), BROKEN $(c BROKEN); $quiet 'on' site(s) with nothing in the log"
    grep -E '^site=.* verdict=(BROKEN|on-plugin) ' "$RAW" | sed -E 's/ mu_plugin=.*//; s/^/     /'
    echo "   log hosts:     $(grep -c '^authlog_site ' "$RAW") site name(s) seen in auth.log ($(val authlog_wordpress_lines "$RAW") WordPress lines)"
    echo
done

echo "Asked $asked server(s); $complete answered in full."
[ "$asked" -eq "$complete" ] || echo "NOT A FULL PICTURE: $((asked - complete)) server(s) did not answer in full."
[ -n "$ONLY" ] && echo "(scoped to \"$ONLY\" — the other servers were not asked)"
[ "$asked" -ge 1 ] || { echo "No server matched \"$ONLY\"."; exit 1; }
[ "$asked" -eq "$complete" ]
