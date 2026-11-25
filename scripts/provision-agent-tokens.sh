#!/bin/bash
# ==============================================================================
# Provision (or rotate) per-server agent tokens
# ==============================================================================
# Each server gets its own random 256-bit token. Only the SHA-256 hash is sent
# to Supabase; the token itself is written straight into that server's
# /root/telemetry-agent.sh and is never stored on this Mac, never printed, and
# never committed. Losing it is not a problem — re-run this script to mint a
# new one.
#
# Usage:
#   bash scripts/provision-agent-tokens.sh                # AUDIT (read-only)
#   bash scripts/provision-agent-tokens.sh --apply        # provision every server
#   bash scripts/provision-agent-tokens.sh --apply web1   # one server first
#
# ORDER MATTERS, and it is not the obvious one. The hash is registered in
# Supabase BEFORE the token is written to the box. Do it the other way round and
# a failure in between leaves the agent presenting a token the database has
# never seen — and the reporters reject a bad token outright, so that server
# would go dark. With this order the worst case is a registered hash nobody
# uses, which is inert.
# ==============================================================================

set -u

LIB="$(cd "$(dirname "$0")" && pwd)/lib-fleet-ssh.sh"
[ -r "$LIB" ] || { echo "ABORT: cannot read $LIB (keep it beside this script)"; exit 1; }
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib-fleet-project.sh
. "$ROOT/scripts/lib-fleet-project.sh"
# The settings file is read as text, one name at a time. It is never run as a
# program: a value with a space, a `$` or a `|` in it would otherwise be executed.
NEXT_PUBLIC_SUPABASE_URL="$(fleet_env_value NEXT_PUBLIC_SUPABASE_URL)"
SUPABASE_SERVICE_ROLE_KEY="$(fleet_env_value SUPABASE_SERVICE_ROLE_KEY)"
[ -n "$NEXT_PUBLIC_SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] || { echo "ABORT: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed in $(_fleet_project_where)"; exit 1; }

# The server list lives in one file outside the repository: see lib-fleet-servers.sh.
SERVERS_LIB="$(cd "$(dirname "$0")" && pwd)/lib-fleet-servers.sh"
[ -r "$SERVERS_LIB" ] || { echo "ABORT: cannot read $SERVERS_LIB (keep it beside this script)"; exit 1; }
# shellcheck source=lib-fleet-servers.sh
. "$SERVERS_LIB"
fleet_servers_load || exit 1

MODE="audit"; ONLY=""
case "${1:-}" in
    "")       MODE="audit" ;;
    --apply)  MODE="apply"; ONLY="${2:-}" ;;
    *) echo "Unknown option: $1"; echo "Use: (no arg) | --apply [server]"; exit 2 ;;
esac

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if ssh-add -l 2>/dev/null | grep -q "$KEY_FP"; then
    echo "using system ssh-agent (fleet key already loaded — no prompts)"
elif [ -S "$OP_SOCK" ]; then
    export SSH_AUTH_SOCK="$OP_SOCK"
    echo "using 1Password SSH agent (approve the Touch ID prompts)"
fi

. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

SB="$NEXT_PUBLIC_SUPABASE_URL"
SK="$SUPABASE_SERVICE_ROLE_KEY"
# The service key as the two headers Supabase wants, for curl to read on its
# standard input (-H @-). It is never an argument: any program on this machine
# can read another program's arguments while it runs. printf is part of bash.
service_headers() { printf 'apikey: %s\nAuthorization: Bearer %s\n' "$SK" "$SK"; }

# Remote program: write the token into the agent and report back WITHOUT ever
# echoing it. The token arrives as an argument, which is visible in that
# server's own process list for the instant the command runs — acceptable,
# since anyone able to read root's process list can read the agent file anyway.
IFS='' read -r -d '' REMOTE_SET_TOKEN <<'REMOTE' || true
TOKEN="$1"
AGENT=/root/telemetry-agent.sh
if [ ! -f "$AGENT" ]; then echo "agent=MISSING"; exit 0; fi
if ! grep -qE '^AGENT_TOKEN=' "$AGENT"; then echo "agent=OLD (no AGENT_TOKEN line — run --update first)"; exit 0; fi
cp "$AGENT" "$AGENT.bak"
sed -i "s|^AGENT_TOKEN=.*|AGENT_TOKEN=\"$TOKEN\"|" "$AGENT"
# Confirm by length and fingerprint, never by value.
NEW=$(grep -E '^AGENT_TOKEN=' "$AGENT" | head -1 | cut -d'"' -f2)
echo "token_len=${#NEW}"
echo "token_fp=$(printf '%s' "$NEW" | sha256sum | cut -c1-8)"
echo "--- verifying against Supabase ---"
"$AGENT" 2>&1 | sed 's/^/run: /'
REMOTE

IFS='' read -r -d '' REMOTE_AUDIT_TOKEN <<'REMOTE' || true
AGENT=/root/telemetry-agent.sh
if [ ! -f "$AGENT" ]; then echo "agent=MISSING"; exit 0; fi
if ! grep -qE '^AGENT_TOKEN=' "$AGENT"; then echo "token=UNSUPPORTED (agent predates tokens)"; exit 0; fi
T=$(grep -E '^AGENT_TOKEN=' "$AGENT" | head -1 | cut -d'"' -f2)
if [ -z "$T" ] || [ "$T" = "CHANGE_ME" ]; then echo "token=NOT SET"; else
    echo "token=set (len ${#T}, fp $(printf '%s' "$T" | sha256sum | cut -c1-8))"
fi
REMOTE

echo "mode: $MODE"
echo

for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"
    ID="${rest%%|*}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    echo "── $LABEL ($IP → server_id $ID) ─────────────────────────"

    if [ "$MODE" = "audit" ]; then
        fleet_ssh "$IP" "$REMOTE_AUDIT_TOKEN"
        if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo; continue; fi
        echo "$FLEET_SSH_OUT" | sed 's/^/   /'
        REG=$(service_headers | curl -s --max-time 20 "$SB/rest/v1/server_agent_secrets?select=server_id,created_at,last_used_at&server_id=eq.$ID" \
                -H @-)
        case "$REG" in
            "[]") echo "   registered=NO" ;;
            *)    echo "   registered=yes  $(printf '%s' "$REG" | tr -d '[]{}"' )" ;;
        esac
        echo; continue
    fi

    # --- mint -----------------------------------------------------------------
    TOKEN=$(openssl rand -hex 32)
    HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)

    # --- register the hash FIRST (see header) --------------------------------
    CODE=$(service_headers | curl -s -o /tmp/prov.out -w '%{http_code}' --max-time 25 \
        -X POST "$SB/rest/v1/server_agent_secrets" \
        -H @- \
        -H "Content-Type: application/json" \
        -H "Prefer: resolution=merge-duplicates,return=minimal" \
        -d "{\"server_id\":$ID,\"token_hash\":\"$HASH\",\"rotated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")
    if [ "$CODE" != "201" ] && [ "$CODE" != "200" ] && [ "$CODE" != "204" ]; then
        echo "   ✗ could not register hash (HTTP $CODE): $(head -c 200 /tmp/prov.out)"
        rm -f /tmp/prov.out; TOKEN=""; echo; continue
    fi
    rm -f /tmp/prov.out
    echo "   hash registered (fp ${HASH:0:8})"

    # --- then install the token on the box ------------------------------------
    fleet_ssh "$IP" "$REMOTE_SET_TOKEN" "$TOKEN"
    TOKEN=""   # drop it from this shell as soon as it is delivered
    if [ -z "$FLEET_SSH_OUT" ]; then fleet_ssh_report_failure; echo; continue; fi
    echo "$FLEET_SSH_OUT" | sed 's/^/   /'

    # Verified by what the agent's own run reported, not by the file write:
    # a token the database rejects makes the reporters raise, and that shows up
    # here as a failed sync rather than a silent misconfiguration.
    if echo "$FLEET_SSH_OUT" | grep -q 'run: Telemetry synced successfully' \
       && echo "$FLEET_SSH_OUT" | grep -q 'run: Hardware synced' \
       && echo "$FLEET_SSH_OUT" | grep -q 'run: Firewall state synced' \
       && echo "$FLEET_SSH_OUT" | grep -q 'run: Fail2Ban report synced' \
       && echo "$FLEET_SSH_OUT" | grep -q 'run: WAF report synced' \
       && echo "$FLEET_SSH_OUT" | grep -q 'run: OPcache report synced'; then
        echo "   ✓ token active — all six reporters authenticated (telemetry, hardware, firewall, Fail2Ban, WAF, OPcache)"
    else
        echo "   ✗ TOKEN DID NOT VERIFY — previous agent saved at /root/telemetry-agent.sh.bak"
    fi
    echo
done

echo "Done."
[ -n "$ONLY" ] && echo "(scoped to \"$ONLY\" — the other servers were not touched)"
case "$MODE" in
    audit) echo "Run with --apply to provision. Prove one server first: --apply web1" ;;
    apply) echo "Every server should now show a recent last_used_at. The database refuses reports without a token." ;;
esac
