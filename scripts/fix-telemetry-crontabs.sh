#!/bin/bash
# ==============================================================================
# Fleet telemetry-agent manager — audit / normalize-cron / install
# ==============================================================================
# Modes:
#   bash scripts/fix-telemetry-crontabs.sh            # AUDIT (read-only): agent id + cron per server
#   bash scripts/fix-telemetry-crontabs.sh --fix      # normalize existing agents to ONE */10 cron
#                                                      # (+ correct SERVER_ID per host)
#   bash scripts/fix-telemetry-crontabs.sh --install  # install the agent on servers that lack one
#                                                      # (clones the golden server's proven agent, per-host
#                                                      #  SERVER_ID, single */10 cron; NEVER clobbers
#                                                      #  a server that already has an agent)
#   bash scripts/fix-telemetry-crontabs.sh --update   # push THIS REPO's agent to every server,
#                                                      # replacing what is there (keeps per-host
#                                                      #  SERVER_ID, backs up the old copy, then runs
#                                                      #  it once so you see the result immediately)
#
# --update fills in the agent before it is sent: the names it looks for on a
# server come from fleet.config.ts (lib-fleet-names.sh), and the Supabase address
# and public key from .env.local (lib-fleet-project.sh). The file in the
# repository holds placeholders for all of them and will not run as it is.
#
# --install vs --update: install refuses to overwrite an existing agent, which is
# the right call for filling gaps and the wrong one for shipping a new version.
# Use --update whenever scripts/telemetry-agent.sh changes in git.
#
# Notes:
#   - Runs from your machine; SSHes to each server as root through an ssh-agent
#     holding your key (on macOS, the 1Password agent is used as a fallback,
#     which prompts once per server — approve each).
#   - ONE ssh connection per server; every mutation is verified by reading state back,
#     so "success" can never be faked.
# ==============================================================================

set -u

# Shared SSH runner: retries once on a connect-level failure, and quotes
# arguments so the remote shell cannot re-split them.
LIB="$(cd "$(dirname "$0")" && pwd)/lib-fleet-ssh.sh"
[ -r "$LIB" ] || { echo "ABORT: cannot read $LIB (keep it beside this script)"; exit 1; }
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"

# The server list lives in one file outside the repository: see lib-fleet-servers.sh.
SERVERS_LIB="$(cd "$(dirname "$0")" && pwd)/lib-fleet-servers.sh"
[ -r "$SERVERS_LIB" ] || { echo "ABORT: cannot read $SERVERS_LIB (keep it beside this script)"; exit 1; }
# shellcheck source=lib-fleet-servers.sh
. "$SERVERS_LIB"
fleet_servers_load || exit 1

# Known-good agent source for --install (a server we've verified runs a clean single-POST agent)
GOLDEN_IP="$FLEET_GOLDEN_IP"; GOLDEN_LABEL="$FLEET_GOLDEN_LABEL"   # the server marked |golden in the server list

# Optional 2nd arg: run against ONE server only (IP or label), so a new mode can
# be proven on a single box before it touches the fleet.
ONLY="${2:-}"

MODE="audit"
case "${1:-}" in
    --fix)     MODE="fix" ;;
    --install) MODE="install" ;;
    --update)  MODE="update" ;;
    "")        MODE="audit" ;;
    *) echo "Unknown option: $1"; echo "Use: (no arg) | --fix | --install | --update"; exit 2 ;;
esac

# Prefer whatever agent already holds the fleet key (KEY_FP, set above).
# If it's loaded in the system ssh-agent (via `ssh-add`), use that — no prompts.
# Otherwise, on macOS, fall back to the 1Password agent socket (Touch ID prompt per connection).
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

# No BatchMode: it disables the 1Password agent prompt and breaks auth.
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

echo "mode: $MODE"
echo

# --- install: fetch + validate the golden agent ONCE, then fan out ------------
GOLDEN_B64=""
if [ "$MODE" = "install" ]; then
    fleet_require_golden || exit 1
    echo "Fetching golden agent from $GOLDEN_LABEL ($GOLDEN_IP)..."
    # Retried too: a timeout fetching the golden agent aborts the entire run.
    fleet_ssh "$GOLDEN_IP" 'cat /root/telemetry-agent.sh'
    GOLDEN="$FLEET_SSH_OUT"
    GBYTES=$(printf '%s' "$GOLDEN" | wc -c | tr -d ' ')
    GPOSTS=$(printf '%s' "$GOLDEN" | grep -c 'rest/v1/rpc/report_telemetry')
    if [ -z "$GOLDEN" ] || [ "$GPOSTS" != "1" ]; then
        echo "ABORT: golden agent invalid (bytes=$GBYTES, posts=$GPOSTS)."
        echo "       Approve the 1Password prompt for $GOLDEN_LABEL and retry, or the source agent isn't clean."
        exit 1
    fi
    GOLDEN_B64=$(printf '%s' "$GOLDEN" | base64 | tr -d '\n')
    echo "golden ok ($GBYTES bytes, single POST)"
    echo
fi

# --- update: validate THIS repo's agent once, then push it everywhere ---------
LOCAL_B64=""
if [ "$MODE" = "update" ]; then
    HERE="$(cd "$(dirname "$0")" && pwd)"
    TEMPLATE="$HERE/telemetry-agent.sh"
    if [ ! -r "$TEMPLATE" ]; then echo "ABORT: cannot read $TEMPLATE"; exit 1; fi
    # Fill in the agent: the names from fleet.config.ts, the project from
    # .env.local. Either library stops the run if it cannot read its values, and
    # fleet_names_script refuses to hand back a file with a placeholder left.
    # shellcheck source=lib-fleet-names.sh
    . "$HERE/lib-fleet-names.sh"
    # shellcheck source=lib-fleet-project.sh
    . "$HERE/lib-fleet-project.sh"
    AGENT_URL="$(fleet_supabase_url)" || exit 1
    AGENT_KEY="$(fleet_supabase_anon_key)" || exit 1
    SRC="$(mktemp "${TMPDIR:-/tmp}/fleet-agent.XXXXXX")" || exit 1
    trap 'rm -f "$SRC"' EXIT
    fleet_names_script "$TEMPLATE" -e "s|__FLEET_SUPABASE_URL__|$AGENT_URL|g" -e "s|__FLEET_SUPABASE_ANON_KEY__|$AGENT_KEY|g" > "$SRC" \
        || { echo "ABORT: could not fill in $TEMPLATE"; exit 1; }
    if ! bash -n "$SRC"; then echo "ABORT: $TEMPLATE has a syntax error"; exit 1; fi
    # Telemetry moved from a direct table POST to the report_telemetry RPC so it
    # could be authenticated per server; this guard follows it.
    LPOSTS=$(grep -c 'rest/v1/rpc/report_telemetry' "$SRC")
    LBYTES=$(wc -c < "$SRC" | tr -d ' ')
    # One telemetry POST per run: an agent that posts twice fills the telemetry
    # table many times faster than it should. The other two endpoints are the newer reporters.
    if [ "$LPOSTS" != "1" ]; then echo "ABORT: expected exactly 1 telemetry POST, found $LPOSTS"; exit 1; fi
    grep -q '^AGENT_TOKEN=' "$SRC" || { echo "ABORT: $TEMPLATE has no AGENT_TOKEN line — wrong/old file?"; exit 1; }
    for fn in rpc/report_hardware rpc/report_firewall_state rpc/report_fail2ban rpc/report_waf rpc/report_opcache; do
        grep -q "$fn" "$SRC" || { echo "ABORT: $TEMPLATE is missing $fn — wrong/old file?"; exit 1; }
    done
    LOCAL_B64=$(base64 < "$SRC" | tr -d '\n')
    echo "local agent ok ($LBYTES bytes, 1 telemetry POST, hardware + firewall + Fail2Ban + WAF + OPcache reporters present)"
    echo "source: $TEMPLATE (names and project filled in)"
    echo
fi

# Remote programs live in variables, not heredocs: a heredoc is consumed once, so
# fleet_ssh could not re-run it after a transient connect failure. Built with
# `read -r -d ''` rather than $(cat <<'X') because bash's $( ) scanner counts
# parentheses and backticks inside heredoc bodies regardless of the quoted
# delimiter. `read` involves no substitution at all.

IFS='' read -r -d '' REMOTE_UPDATE <<'REMOTE' || true
ID="$1"; LABEL="$2"; B64="$3"
if [ -f /root/telemetry-agent.sh ]; then cp /root/telemetry-agent.sh /root/telemetry-agent.sh.bak && echo "backup=made"; else echo "backup=none"; fi

# Carry this server's existing agent token across the update. It is a per-server
# secret that exists ONLY here and as a hash in Supabase — nothing on your machine
# holds a copy — so overwriting the file without preserving it would silently
# de-authenticate the box. Read it before the file is replaced.
EXISTING_TOKEN=$(grep -E '^AGENT_TOKEN=' /root/telemetry-agent.sh 2>/dev/null | head -1 | cut -d'"' -f2)

printf '%s' "$B64" | base64 -d \
  | sed "s|^SERVER_ID=.*|SERVER_ID=\"$ID\" # Node Label: $LABEL|" > /root/telemetry-agent.sh

if [ -n "$EXISTING_TOKEN" ] && [ "$EXISTING_TOKEN" != "CHANGE_ME" ]; then
    sed -i "s|^AGENT_TOKEN=.*|AGENT_TOKEN=\"$EXISTING_TOKEN\"|" /root/telemetry-agent.sh
    echo "token=preserved"
else
    echo "token=ABSENT (run scripts/provision-agent-tokens.sh)"
fi
chmod +x /root/telemetry-agent.sh
TMP="/tmp/ct.$$"
crontab -l 2>/dev/null | grep -v telemetry-agent > "$TMP"
echo '*/10 * * * * /root/telemetry-agent.sh > /dev/null 2>&1' >> "$TMP"
crontab "$TMP" && rm -f "$TMP"
echo "installed_id=$(grep -E '^SERVER_ID=' /root/telemetry-agent.sh | head -1 | cut -d'"' -f2)"
echo "posts=$(grep -c rest/v1/rpc/report_telemetry /root/telemetry-agent.sh)"
echo "cron=$(crontab -l 2>/dev/null | grep -c telemetry-agent)"
# Run it once now: no waiting for the next */10, and any failure surfaces here
# rather than silently in cron.
echo "--- first run ---"
/root/telemetry-agent.sh 2>&1 | sed 's/^/run: /'
REMOTE

IFS='' read -r -d '' REMOTE_INSTALL <<'REMOTE' || true
ID="$1"; LABEL="$2"; B64="$3"
# Never clobber a server that already has an agent
if grep -qE '^SERVER_ID=' /root/telemetry-agent.sh 2>/dev/null; then echo "STATUS=already-installed"; exit 0; fi
printf '%s' "$B64" | base64 -d | sed "s|^SERVER_ID=.*|SERVER_ID=\"$ID\" # Node Label: $LABEL|" > /root/telemetry-agent.sh
# The golden agent is a copy of the golden server's file, INCLUDING its private token.
# Blank it: a token is per-server, and cloning one would let this box report as
# the golden server (and would survive every later --update, which preserves what it finds).
sed -i "s|^AGENT_TOKEN=.*|AGENT_TOKEN=\"CHANGE_ME\"|" /root/telemetry-agent.sh
chmod +x /root/telemetry-agent.sh
TMP="/tmp/ct.$$"
crontab -l 2>/dev/null | grep -v telemetry-agent > "$TMP"
echo '*/10 * * * * /root/telemetry-agent.sh > /dev/null 2>&1' >> "$TMP"
crontab "$TMP" && rm -f "$TMP"
echo "STATUS=installed"
echo "installed_id=$(grep -E '^SERVER_ID=' /root/telemetry-agent.sh | head -1 | cut -d'"' -f2)"
echo "posts=$(grep -c rest/v1/rpc/report_telemetry /root/telemetry-agent.sh)"
echo "cron=$(crontab -l 2>/dev/null | grep -c telemetry-agent)"
REMOTE

IFS='' read -r -d '' REMOTE_AUDITFIX <<'REMOTE' || true
MODE="$1"; WANT="$2"; LABEL="$3"
AID=$(grep -E '^SERVER_ID=' /root/telemetry-agent.sh 2>/dev/null | head -1 | cut -d'"' -f2)
if [ -z "$AID" ]; then echo "STATUS=no-agent"; exit 0; fi
echo "STATUS=ok"
echo "agent_id=$AID"
echo "before=$(crontab -l 2>/dev/null | grep telemetry-agent | tr '\n' ';')"
if [ "$MODE" = "fix" ]; then
    if [ "$AID" != "$WANT" ]; then
        sed -i "s/^SERVER_ID=.*/SERVER_ID=\"$WANT\" # Node Label: $LABEL/" /root/telemetry-agent.sh
        echo "server_id_fixed=$WANT"
    fi
    TMP="/tmp/ct.$$"
    crontab -l 2>/dev/null | grep -v telemetry-agent > "$TMP"
    echo '*/10 * * * * /root/telemetry-agent.sh > /dev/null 2>&1' >> "$TMP"
    crontab "$TMP" && rm -f "$TMP"
    echo "after=$(crontab -l 2>/dev/null | grep telemetry-agent | tr '\n' ';')"
    echo "count=$(crontab -l 2>/dev/null | grep -c telemetry-agent)"
fi
REMOTE

for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"
    ID="${rest%%|*}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    echo "── $LABEL ($IP → server_id $ID) ─────────────────────────"

    # ---------------- UPDATE ----------------
    if [ "$MODE" = "update" ]; then
        # Not wrapped in $( ): fleet_ssh returns its results in globals, which a
        # subshell would discard, leaving the failure branch to print the
        # PREVIOUS server's exit code.
        fleet_ssh "$IP" "$REMOTE_UPDATE" "$ID" "$LABEL" "$LOCAL_B64"
        OUT="$FLEET_SSH_OUT"
        if [ -z "$OUT" ]; then
            fleet_ssh_report_failure
            echo; continue
        fi
        echo "$OUT" | sed 's/^/   /'
        if echo "$OUT" | grep -q "installed_id=$ID$" \
           && echo "$OUT" | grep -q 'posts=1' \
           && echo "$OUT" | grep -q 'cron=1' \
           && echo "$OUT" | grep -q 'run: Telemetry synced successfully' \
           && echo "$OUT" | grep -q 'run: Hardware synced' \
           && echo "$OUT" | grep -q 'run: Firewall state synced' \
           && echo "$OUT" | grep -q 'run: Fail2Ban report synced' \
           && echo "$OUT" | grep -q 'run: WAF report synced' \
           && echo "$OUT" | grep -q 'run: OPcache report synced'; then
            echo "   ✓ updated and reporting: telemetry + hardware + firewall + Fail2Ban + WAF + OPcache"
        else
            if echo "$OUT" | grep -q 'backup=made'; then
                echo "   ✗ UPDATE DID NOT VERIFY — old copy is at /root/telemetry-agent.sh.bak"
            else
                echo "   ✗ UPDATE DID NOT VERIFY — no agent was here before, so there is no old copy."
                echo "     On a new server that is expected: it has no token yet. Next: bash scripts/provision-agent-tokens.sh --apply $LABEL"
            fi
        fi
        echo
        continue
    fi

    # ---------------- INSTALL ----------------
    if [ "$MODE" = "install" ]; then
        fleet_ssh "$IP" "$REMOTE_INSTALL" "$ID" "$LABEL" "$GOLDEN_B64"
        OUT="$FLEET_SSH_OUT"
        if [ -z "$OUT" ]; then fleet_ssh_report_failure; echo; continue; fi
        case "$OUT" in
            *STATUS=already-installed*) echo "   already has an agent — skipped (use --fix to normalize its cron)"; echo; continue ;;
        esac
        echo "$OUT" | grep -v '^STATUS=' | sed 's/^/   /'
        if echo "$OUT" | grep -q "installed_id=$ID$" && echo "$OUT" | grep -q 'posts=1' && echo "$OUT" | grep -q 'cron=1'; then
            echo "   ✓ installed: SERVER_ID=$ID, single POST, */10 cron"
        else
            echo "   ✗ INSTALL DID NOT VERIFY — check the output above"
        fi
        echo
        continue
    fi

    # ---------------- AUDIT / FIX ----------------
    # Single ssh connection; remote reports real state (and, in FIX mode, the
    # crontab AFTER writing) so success can never be faked.
    fleet_ssh "$IP" "$REMOTE_AUDITFIX" "$MODE" "$ID" "$LABEL"
    OUT="$FLEET_SSH_OUT"

    if [ -z "$OUT" ]; then
        fleet_ssh_report_failure; echo; continue
    fi
    case "$OUT" in
        *STATUS=no-agent*) echo "   no agent installed  (run with --install to add one)"; echo; continue ;;
    esac
    echo "$OUT" | grep -v '^STATUS=' | sed 's/^/   /'
    if [ "$MODE" = "fix" ]; then
        if echo "$OUT" | grep -q 'after=\*/10 .*;$' && echo "$OUT" | grep -q 'count=1'; then
            echo "   ✓ verified: single */10 entry"
        else
            echo "   ✗ FIX DID NOT VERIFY — crontab unchanged (approve the 1Password prompt and re-run)"
        fi
    fi
    echo
done

echo "Done."
case "$MODE" in
    install) echo "Verify in ~15 min: newly-installed servers should begin posting ~6 rows/hr." ;;
    fix)     echo "Verify in ~15 min: each fixed server's rows/hr should drop from ~60 to ~6." ;;
esac
