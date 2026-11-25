#!/bin/bash
# ==============================================================================
# Fail2Ban behind Cloudflare — set up one server
# ==============================================================================
#   bash scripts/fleet-fail2ban-apply.sh <server-label>          # DRY RUN (default)
#   bash scripts/fleet-fail2ban-apply.sh <server-label> --live   # write, reload, prove
#   bash scripts/fleet-fail2ban-apply.sh <server-label> --live --enable-plugin
#
# The plugin is left as it is on every site unless --enable-plugin is given
# (which runs GridPane's own command where it is off). A site with the plugin
# off still gets its jails; they start working when it is switched on.
#
# Works out which sites on the server sit in which Cloudflare zone (the audit's
# site list joined to the Cloudflare inventory), then sends
# fleet-fail2ban-apply.remote.sh to the server. See that file for what it sets up.
#
# The dry run changes nothing in /etc/fail2ban: it tests a private copy. Live
# refuses to start unless a dry run would pass, sends the server's token down
# ssh's stdin (never as an argument), and ends with a ban/unban proof.
#
# Needs: a fresh audit (scripts/fleet-fail2ban.sh) and the Cloudflare inventory
# (scripts/waf-refresh.sh, or scripts/waf-inventory.py --out). The latest of
# each is taken from your output folder: FLEET_OUTPUT_DIR, or the full path on
# one line in ~/.config/fleet/output-dir, else ~/.local/state/fleet.
# F2B_AUDIT_OUT (a folder) and WAF_REPORT (a report.json) name others.
#
# --live also needs this server's own Cloudflare token, the one named
# f2b-<label> (the label in lower case, _ written as -). Where it is looked for
# is at the top of scripts/lib-fleet-token.sh: the environment variable
# FLEET_CF_TOKEN_F2B_<LABEL>, a command of your own, or a file only you can read.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-fleet-ssh.sh"
# The names the server program installs under come from fleet.config.ts; this
# stops here if they cannot be read.
. "$HERE/lib-fleet-names.sh"
. "$HERE/lib-fleet-token.sh"
REMOTE="$(fleet_names_script "$HERE/fleet-fail2ban-apply.remote.sh")" || exit 1
LABEL="${1:-}"; [ -n "$LABEL" ] || { echo "Use: $0 <server-label>"; exit 2; }
MODE=dry-run; ENABLE_PLUGIN=0
for o in "${@:2}"; do
    case "$o" in --live) MODE=live ;; --enable-plugin) ENABLE_PLUGIN=1 ;; *) echo "Unknown option: $o (only --live, --enable-plugin)"; exit 2 ;; esac
done
. "$(dirname "$0")/lib-fleet-output.sh" || exit 1; FLEET_OUT="$(fleet_output_dir)"   # the folder runs, audits and snapshots are kept in
AUDIT_DIR="${F2B_AUDIT_OUT:-$(ls -d "$FLEET_OUT"/*-fail2ban-audit 2>/dev/null | tail -1)}"
INV="${WAF_REPORT:-$(ls "$FLEET_OUT"/*/waf-inventory/report.json 2>/dev/null | tail -1)}"
# Nothing found does not mean nothing was ever run: earlier audits and
# inventories may be kept in another folder. Say where this looked.
if [ -z "$AUDIT_DIR" ]; then
    echo "ABORT: no Fail2Ban audit found."
    fleet_output_dir_hint
    echo "       Or name one audit's folder for this run with F2B_AUDIT_OUT."
    echo "       To take a new audit: bash scripts/fleet-fail2ban.sh $LABEL"
    exit 1
fi
AUDIT="$AUDIT_DIR/$LABEL.txt"
[ -r "$AUDIT" ] || { echo "ABORT: no audit for $LABEL ($AUDIT). Run scripts/fleet-fail2ban.sh first."; exit 1; }
if [ -z "$INV" ]; then
    echo "ABORT: no Cloudflare inventory (report.json) found."
    fleet_output_dir_hint
    echo "       Or name one report.json for this run with WAF_REPORT."
    echo "       To take a new inventory: bash scripts/waf-refresh.sh  (add --dry-run to leave the database alone)"
    exit 1
fi
[ -r "$INV" ] || { echo "ABORT: cannot read the Cloudflare inventory $INV"; exit 1; }
grep -q '^audit_complete=yes$' "$AUDIT" || { echo "ABORT: the audit for $LABEL is incomplete."; exit 1; }
. "$HERE/lib-fleet-servers.sh"
IP=$(fleet_server_ip "$LABEL")
[ -n "$IP" ] || { echo "ABORT: no server labelled $LABEL"; exit 1; }

# site|zone-id for every WordPress site in a zone we can see. Longest zone name
# wins, so shop.example.com lands in example.com and not in a shorter lookalike.
SPECS=$(python3 - "$AUDIT" "$INV" <<'PY'
import json,re,sys
raw=open(sys.argv[1]).read(); rep=json.load(open(sys.argv[2]))
for site in re.findall(r'^site=(\S+) ',raw,re.M):
    z=sorted([z for z in rep if site==z or site.endswith('.'+z)],key=len)
    if z: print(f"{site}|{rep[z[-1]]['zone_id']}|{z[-1]}|{rep[z[-1]].get('reach',{}).get('reach')}")
    else: print(f"{site}||NO-ZONE|")
PY
)
echo "── $LABEL — $MODE ─────────────────────────"
echo "audit: $AUDIT"
echo "inventory: $INV"
ARGS=()
while IFS='|' read -r site zid zone reach; do
    [ -n "$site" ] || continue
    if [ -z "$zid" ]; then echo "   skipped: $site is in no Cloudflare zone this account can read"; continue; fi
    echo "   $site → zone $zone ($reach)"
    ARGS+=("$site|$zid|$zone")
done <<EOF2
$SPECS
EOF2
[ "${#ARGS[@]}" -ge 1 ] || { echo "ABORT: no site on $LABEL is in a known zone."; exit 1; }

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
ssh-add -l 2>/dev/null | grep -q "$KEY_FP" || { [ -S "$OP_SOCK" ] && export SSH_AUTH_SOCK="$OP_SOCK"; }
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

fleet_ssh "$IP" "$REMOTE" dry-run "${ARGS[@]}"
[ -n "$FLEET_SSH_OUT" ] || { fleet_ssh_report_failure; exit 1; }
printf '%s\n' "$FLEET_SSH_OUT" | sed 's/^/   /'
echo
ok=1
printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^dry_run_complete=yes$' || { ok=0; echo "✗ the dry run did not finish"; }
printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^config_test=ok$' || { ok=0; echo "✗ Fail2Ban rejected the config"; }
printf '%s\n' "$FLEET_SSH_OUT" | grep -q ' MISMATCH$' && { ok=0; echo "✗ a filter did not match exactly its own site's lines"; }
printf '%s\n' "$FLEET_SSH_OUT" | grep -q 'PATTERNS-DIFFER$' && { ok=0; echo "✗ our copy of the WordPress patterns differs from the one GridPane installed here: update the copy in fleet-fail2ban-apply.remote.sh"; }
printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^helper_syntax=ok$' || { ok=0; echo "✗ the ban program did not pass a syntax check on this server"; }
printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^helper_needs python3=yes ' || { ok=0; echo "✗ python3 is missing on this server; the ban program needs it"; }
printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^control=ok' || { ok=0; echo "✗ the narrowing control did not pass: $(printf '%s\n' "$FLEET_SSH_OUT" | grep '^control=')"; }
n=$(printf '%s\n' "$FLEET_SSH_OUT" | grep -c '^sample .* ok$')
[ "$n" -ge 3 ] || { ok=0; echo "✗ no filter was tested against sample lines"; }
[ "$ok" = 1 ] || exit 1
off=$(printf '%s\n' "$FLEET_SSH_OUT" | grep -c '^plugin .* OFF')
echo "✓ dry run clean: config accepted, $n filter(s) proven on sample lines and checked against the real log. Plugin off on $off site(s). Nothing was changed by the dry run."

[ "$MODE" = live ] || exit 0
# The token is read into a variable of this shell and from there into the text
# sent down ssh's stdin. It is never an argument of any command, and never printed.
fleet_cf_token "f2b-$(printf '%s' "$LABEL" | tr 'A-Z_' 'a-z-')" SERVER_TOKEN || exit 1
echo
echo "── $LABEL — LIVE ─────────────────────────"
fleet_ssh "$IP" "ENABLE_PLUGIN=$ENABLE_PLUGIN
CF_TOKEN='$SERVER_TOKEN'
$REMOTE" live "${ARGS[@]}"
SERVER_TOKEN=""
[ -n "$FLEET_SSH_OUT" ] || { fleet_ssh_report_failure; exit 1; }
printf '%s\n' "$FLEET_SSH_OUT" | sed 's/^/   /'
echo
g() { printf '%s\n' "$FLEET_SSH_OUT" | grep -q "$1"; }
ok=1
g '^live_complete=yes$' || { ok=0; echo "✗ live did not complete"; }
g '^jails_reading_auth_log=yes$' || { ok=0; echo "✗ a jail is not reading /var/log/auth.log"; }
g '^proof_trigger=log$' || { ok=0; echo "✗ a line written to the log did NOT trigger the ban (it was banned by hand instead)"; }
g '^proof_banned_in_fail2ban=1$' || { ok=0; echo "✗ the test ban did not register in Fail2Ban"; }
g "^proof_after_ban count=1 scopes=\\['zone'\\]" || { ok=0; echo "✗ the test ban did not appear as ONE ZONE-level rule at Cloudflare"; }
g '^proof_after_unban count=0 ' || { ok=0; echo "✗ the test rule was not removed at Cloudflare on unban"; }
g '^proof_left_in_fail2ban=0 left_in_local_firewall=0$' || { ok=0; echo "✗ the test address was left behind locally"; }
g '^oddhost_line_banned=1$' || { ok=0; echo "✗ a line logged under the site's name in capitals with a port did NOT trigger the ban"; }
g '^oddhost_after_unban count=0 ' || { ok=0; echo "✗ the rule from the capitals-and-port test was not removed"; }
g '^helper_file=root:root 700$' || { ok=0; echo "✗ the ban program is not root-only"; }
g '^overlap_both_banned rules=1 ' || { ok=0; echo "✗ two jails banning one address did not leave exactly ONE rule at Cloudflare"; }
g '^overlap_after_short_unban rules=1 .* still_banned_in_long_jail=1$' || { ok=0; echo "✗ the SHORT jail's unban removed the rule while the long jail still held the address"; }
g '^overlap_after_long_unban rules=0 holders=absent left_in_local_firewall=0$' || { ok=0; echo "✗ the rule or its holder list was left behind after the last jail let go"; }
[ "$ok" = 1 ] || exit 1
echo "✓ live and proven: a line in the log is read, the ban reaches the site's own zone and the local firewall, an unban removes both, and a short ban ending does not lift a longer one."
printf '%s\n' "$FLEET_SSH_OUT" | grep '^plugin .* OFF' | sed 's/^/  note: /' 
