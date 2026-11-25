#!/bin/bash
# ==============================================================================
# Install the Fleet sign-in service on a server
# ==============================================================================
# One-click WordPress sign-in needs a small service on each server: it collects
# a signed request from Fleet, runs the command GridPane's own SSO button runs,
# and sends the link back sealed. scripts/fleet-sso-agent.py is that service and
# says at its top exactly what it does and never does.
#
# Usage:
#   bash scripts/install-fleet-sso-agent.sh                     # AUDIT every server (read-only)
#   bash scripts/install-fleet-sso-agent.sh --apply  <server>   # install or update ONE server
#   bash scripts/install-fleet-sso-agent.sh --remove <server>   # take it off ONE server
#
# <server> is a server's label or IPv4 address as Fleet's database has it. The
# list comes from the database, so there is no list in this file to keep up.
#
# WHAT --apply CHANGES
#   in Fleet's database: this server's row in sso_agent_secrets (the SHA-256 of
#     a new random token; the token itself is never stored off the server)
#   on the server: four files and one systemd service, listed at the top of
#     install-fleet-sso-agent.remote.sh. No port is opened and no firewall rule
#     changes: the service only makes outbound calls.
#   Running it again on the same server gives it a new token and the current
#   service file. That is also how a token is rotated.
#
# WHAT --remove CHANGES
#   stops the service, deletes those files, and deletes the server's token row.
#
# ORDER: the token's hash is registered BEFORE the token is written to the
# server. The other way round, a failure in between would leave the service
# presenting a token the database has never seen.
#
# NEEDS, all checked before anything is changed:
#   - sso_schema.sql applied (bash scripts/apply-sql.sh sso_schema.sql)
#   - Fleet's two public keys in ~/.config/fleet/sso/ (bash scripts/sso-make-keys.sh)
#   - .env.local with the Supabase address and keys (this checkout's, or the
#     main checkout's when run from a worktree; or name one with FLEET_ENV_FILE)
#
# The token is never printed, stored on this machine, or put on a command line.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LIB="$HERE/lib-fleet-ssh.sh"
REMOTE_FILE="$HERE/install-fleet-sso-agent.remote.sh"
AGENT_FILE="${SSO_AGENT_FILE:-$HERE/fleet-sso-agent.py}"      # SSO_AGENT_FILE is for the self-test
for f in "$LIB" "$REMOTE_FILE" "$AGENT_FILE"; do [ -r "$f" ] || { echo "ABORT: cannot read $f"; exit 1; }; done
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"

MODE="audit"; ONLY=""
case "${1:-}" in
    "") ;;
    --apply|--remove) MODE="${1#--}"; ONLY="${2:-}"
        [ -n "$ONLY" ] || { echo "Name one server: $0 $1 <label or IPv4>"; exit 2; }
        [ $# -le 2 ] || { echo "One server at a time."; exit 2; } ;;
    *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

# ---- settings -----------------------------------------------------------------
ENV_FILE="${FLEET_ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
    if [ -r "$ROOT/.env.local" ]; then ENV_FILE="$ROOT/.env.local"
    else
        MAIN="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
        [ -n "$MAIN" ] && [ -r "$MAIN/.env.local" ] && ENV_FILE="$MAIN/.env.local"
    fi
fi
[ -r "${ENV_FILE:-/nonexistent}" ] || { echo "ABORT: no .env.local found (looked in $ROOT and the main checkout). Name one with FLEET_ENV_FILE."; exit 1; }
# Read the three values by name. The file is not run as a program.
env_value() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | tr -d '\r\n'; }
SB="$(env_value NEXT_PUBLIC_SUPABASE_URL)"; ANON="$(env_value NEXT_PUBLIC_SUPABASE_ANON_KEY)"; SK="$(env_value SUPABASE_SERVICE_ROLE_KEY)"
printf '%s' "$SB" | grep -qE '^https://[a-z0-9.-]+$' || { echo "ABORT: NEXT_PUBLIC_SUPABASE_URL in $ENV_FILE is not an https address"; exit 1; }
printf '%s' "$ANON" | grep -qE '^[A-Za-z0-9._-]{20,}$' || { echo "ABORT: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing from $ENV_FILE"; exit 1; }
printf '%s' "$SK" | grep -qE '^[A-Za-z0-9._-]{20,}$' || { echo "ABORT: SUPABASE_SERVICE_ROLE_KEY is missing from $ENV_FILE"; exit 1; }

# One call to Fleet's database. The key goes to curl on its standard input, so
# it is on no command line. Prints the body, then the HTTP code on its own line.
api() {
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$SK" "$SK" | curl -sS --max-time 25 -K - -X "$method" "$SB/rest/v1/$path" \
            -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates,return=minimal" --data "$body" -w '\n%{http_code}'
    else
        printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$SK" "$SK" | curl -sS --max-time 25 -K - -X "$method" "$SB/rest/v1/$path" -w '\n%{http_code}'
    fi
}
code_of() { printf '%s' "$1" | tail -1; }
body_of() { printf '%s' "$1" | sed '$d'; }

# ---- the server list, from the database ----------------------------------------
ANS="$(api GET 'servers?select=id,ip,label&order=label')"
[ "$(code_of "$ANS")" = "200" ] || { echo "ABORT: could not read the server list from Fleet's database (HTTP $(code_of "$ANS"))"; exit 1; }
SERVERS="$(body_of "$ANS" | python3 -c '
import json, re, sys
for s in json.load(sys.stdin):
    ip, sid, label = str(s.get("ip") or ""), s.get("id"), str(s.get("label") or "")
    if re.match(r"^[0-9]{1,3}(\.[0-9]{1,3}){3}$", ip) and isinstance(sid, int) and re.match(r"^[A-Za-z0-9._-]+$", label):
        print("%s|%d|%s" % (ip, sid, label))
')"
[ -n "$SERVERS" ] || { echo "ABORT: Fleet's database lists no servers"; exit 1; }

if [ -n "$ONLY" ]; then
    MATCH="$(printf '%s\n' "$SERVERS" | awk -F'|' -v w="$ONLY" '$1 == w || $3 == w')"
    [ "$(printf '%s\n' "$MATCH" | grep -c .)" = "1" ] || { echo "\"$ONLY\" is not exactly one server in Fleet's database. The servers are:"; printf '%s\n' "$SERVERS" | awk -F'|' '{print "  " $3 "  (" $1 ")"}'; exit 2; }
    SERVERS="$MATCH"
fi

# ---- what --apply needs, checked before anything is changed --------------------
KEYDIR="${FLEET_SSO_KEY_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/sso}"
if [ "$MODE" = "apply" ]; then
    for k in sign-pub.pem box-pub.pem; do
        grep -q 'BEGIN PUBLIC KEY' "$KEYDIR/$k" 2>/dev/null || { echo "ABORT: $KEYDIR/$k is missing. Run: bash scripts/sso-make-keys.sh"; exit 1; }
    done
    ANS="$(api GET 'sso_state?select=enabled')"
    [ "$(code_of "$ANS")" = "200" ] || { echo "ABORT: Fleet's database has no sign-in tables yet (HTTP $(code_of "$ANS")). Apply sso_schema.sql first: bash scripts/apply-sql.sh sso_schema.sql"; exit 1; }
    python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$AGENT_FILE" || { echo "ABORT: $AGENT_FILE does not parse"; exit 1; }
fi

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if ssh-add -l 2>/dev/null | grep -q "$KEY_FP"; then echo "using system ssh-agent (fleet key already loaded: no prompts)"
elif [ -S "$OP_SOCK" ]; then export SSH_AUTH_SOCK="$OP_SOCK"; echo "using 1Password SSH agent (approve the Touch ID prompts)"; fi
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"
# The server program carries a placeholder for the address of this deployment's
# code (the unit's Documentation= line). It comes from fleet.config.ts; this
# stops here if it cannot be read.
# shellcheck source=lib-fleet-names.sh
. "$HERE/lib-fleet-names.sh"
DOCS_URL="$(fleet_repo_url)" || exit 1
REMOTE="$(fleet_names_script "$REMOTE_FILE" -e "s|__FLEET_REPO_URL__|$DOCS_URL|g")" || exit 1
b64() { base64 < "$1" | tr -d '\n'; }

echo "mode: $MODE"
echo
WORST=0
while IFS='|' read -r IP ID LABEL <&3; do
    [ -n "$IP" ] || continue
    echo "── $LABEL ($IP, server id $ID) ─────────────────────────"

    if [ "$MODE" = "audit" ]; then
        fleet_ssh "$IP" "MODE=audit
$REMOTE"
        if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo; continue; fi
        printf '%s\n' "$FLEET_SSH_OUT" | sed 's/^/   /'
        ANS="$(api GET "sso_agent_secrets?select=created_at,rotated_at,last_used_at&server_id=eq.$ID")"
        case "$(code_of "$ANS")" in
            200) case "$(body_of "$ANS")" in "[]") echo "   token registered in Fleet: no" ;; *) echo "   token registered in Fleet: yes  $(body_of "$ANS" | tr -d '[]{}"')" ;; esac ;;
            *)   echo "   token registered in Fleet: cannot tell (HTTP $(code_of "$ANS"); is sso_schema.sql applied?)" ;;
        esac
        echo; continue
    fi

    if [ "$MODE" = "remove" ]; then
        fleet_ssh "$IP" "MODE=remove
$REMOTE"
        if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; WORST=1; echo; continue; fi
        printf '%s\n' "$FLEET_SSH_OUT" | sed 's/^/   /'
        if printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^sso_install_result=ok$'; then
            ANS="$(api DELETE "sso_agent_secrets?server_id=eq.$ID")"
            case "$(code_of "$ANS")" in 200|204) echo "   ✓ removed from the server, and its token no longer works" ;; *) echo "   ✗ removed from the server, but the token row is still in Fleet's database (HTTP $(code_of "$ANS"))"; WORST=1 ;; esac
        else
            echo "   ✗ not removed cleanly; the token row was left alone"; WORST=1
        fi
        echo; continue
    fi

    # ---- apply ---------------------------------------------------------------
    TOKEN="$(openssl rand -hex 32)"
    HASH="$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
    printf '%s' "$TOKEN" | grep -qE '^[0-9a-f]{64}$' || { echo "   ✗ could not make a token"; WORST=1; TOKEN=""; echo; continue; }

    # Register the hash FIRST (see the header).
    ANS="$(api POST 'sso_agent_secrets' "{\"server_id\":$ID,\"token_hash\":\"$HASH\",\"rotated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")"
    case "$(code_of "$ANS")" in
        200|201|204) echo "   token hash registered (fp ${HASH:0:8})" ;;
        *) echo "   ✗ could not register the token hash (HTTP $(code_of "$ANS")); the server was not touched"; WORST=1; TOKEN=""; echo; continue ;;
    esac

    # The values ride inside the program text, which ssh carries on its standard input.
    fleet_ssh "$IP" "MODE=apply
SERVER_ID='$ID'
TOKEN='$TOKEN'
SUPABASE_URL='$SB'
ANON_KEY='$ANON'
AGENT_B64='$(b64 "$AGENT_FILE")'
SIGN_PUB_B64='$(b64 "$KEYDIR/sign-pub.pem")'
BOX_PUB_B64='$(b64 "$KEYDIR/box-pub.pem")'
$REMOTE"
    TOKEN=""
    if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo "   The new token hash is registered but may not be on the server. Run --apply again."; WORST=1; echo; continue; fi
    printf '%s\n' "$FLEET_SSH_OUT" | sed 's/^/   /'
    if printf '%s\n' "$FLEET_SSH_OUT" | grep -q '^sso_install_result=ok$'; then
        echo "   ✓ installed and running; Fleet's database accepted its token"
    else
        echo "   ✗ NOT RUNNING on $LABEL. Read the lines above; fix, then run --apply again."; WORST=1
    fi
    echo
done 3<<LIST
$SERVERS
LIST

case "$MODE" in
    audit)  echo "Nothing was changed. Install on one server: bash scripts/install-fleet-sso-agent.sh --apply <server>" ;;
    apply)  echo "Only \"$ONLY\" was touched." ;;
    remove) echo "Only \"$ONLY\" was touched." ;;
esac
exit $WORST
