#!/bin/bash
# ==============================================================================
# Prove a server's Fail2Ban Cloudflare token, from that server
# ==============================================================================
#   bash scripts/fleet-fail2ban-token-proof.sh <server-label> <zone-name> <zone-id>
#
# The token is locked to the server's outbound address, so it can only be proved
# from there. Three steps: the token verifies as active;
# it can create a block on a documentation-only address (203.0.113.45 routes
# nowhere) in that zone; it can delete that block again. The rule exists for
# about a second.
#
# THIS WRITES TO CLOUDFLARE: one rule made and removed. It touches no file on
# the server and does not install the token there.
#
# The token is this server's own, the one named f2b-<label> (the label in lower
# case, _ written as -). Where it is looked for is at the top of
# scripts/lib-fleet-token.sh: the environment variable
# FLEET_CF_TOKEN_F2B_<LABEL>, a command of your own, or a file only you can read.
#
# The token never appears in a command line, in ssh's arguments or in output:
# it is read into a variable of this shell and from there into the text sent
# down ssh's stdin, and the remote prints only yes/no answers and Cloudflare's
# error codes.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-fleet-ssh.sh"
. "$HERE/lib-fleet-token.sh"
LABEL="${1:-}"; ZONE="${2:-}"; ZID="${3:-}"
[ -n "$LABEL" ] && [ -n "$ZONE" ] && [ -n "$ZID" ] || { echo "Use: $0 <server-label> <zone-name> <zone-id>"; exit 2; }
case "$ZID" in *[!0-9a-f]*|"") echo "ABORT: zone id is not 32 hex characters"; exit 1 ;; esac
fleet_cf_token "f2b-$(printf '%s' "$LABEL" | tr 'A-Z_' 'a-z-')" SERVER_TOKEN || exit 1
. "$HERE/lib-fleet-servers.sh"
IP=$(fleet_server_ip "$LABEL")
[ -n "$IP" ] || { echo "ABORT: no server labelled $LABEL"; exit 1; }

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
ssh-add -l 2>/dev/null | grep -q "$KEY_FP" || { [ -S "$OP_SOCK" ] && export SSH_AUTH_SOCK="$OP_SOCK"; }
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

read -r -d '' BODY <<'REMOTE'
API=https://api.cloudflare.com/client/v4
j() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print('unreadable'); sys.exit()
$1"; }
# The token goes to curl on stdin, never on its command line.
cfc() { printf 'Authorization: Bearer %s\n' "$CF_TOKEN" | curl -4 -s --max-time 15 -H @- -H "Content-Type: application/json" "$@"; }
echo "verify=$(cfc "$API/user/tokens/verify" | j "print(d.get('result',{}).get('status') if d.get('success') else 'FAILED codes=%s' % [e.get('code') for e in d.get('errors',[])])")"
echo "zone_name=$(cfc "$API/zones/$2" | j "print(d.get('result',{}).get('name') if d.get('success') else 'FAILED codes=%s' % [e.get('code') for e in d.get('errors',[])])")"
[ "$(cfc "$API/zones/$2" | j "print(d.get('result',{}).get('name'))")" = "$1" ] || { echo "stop=zone id does not belong to $1; nothing was written"; echo proof_complete=no; exit 0; }
RID=$(cfc -X POST "$API/zones/$2/firewall/access_rules/rules" \
  --data '{"mode":"block","configuration":{"target":"ip","value":"203.0.113.45"},"notes":"Fail2Ban token proof - safe to delete"}' \
  | j "print(d['result']['id'] if d.get('success') else 'FAILED codes=%s' % [e.get('code') for e in d.get('errors',[])])")
case "$RID" in
  FAILED*|unreadable|"") echo "create=$RID"; echo proof_complete=no; exit 0 ;;
esac
echo "create=ok"
echo "delete=$(cfc -X DELETE "$API/zones/$2/firewall/access_rules/rules/$RID" | j "print('ok' if d.get('success') else 'FAILED codes=%s' % [e.get('code') for e in d.get('errors',[])])")"
echo "proof_complete=yes"
REMOTE

echo "── $LABEL → $ZONE ─────────────────────────"
# The token rides in stdin with the program, never in the argument list.
fleet_ssh "$IP" "CF_TOKEN='$SERVER_TOKEN'
$BODY" "$ZONE" "$ZID"
SERVER_TOKEN=""
[ -n "$FLEET_SSH_OUT" ] || { fleet_ssh_report_failure; exit 1; }
printf '%s\n' "$FLEET_SSH_OUT" | sed 's/^/   /'
printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^verify=active$' \
  && printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^create=ok$' \
  && printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^delete=ok$' \
  && { echo "   ✓ token verified, can create and remove a block in this zone"; exit 0; }
echo "   ✗ NOT PROVEN"; exit 1
