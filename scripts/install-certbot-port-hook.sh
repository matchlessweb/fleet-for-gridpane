#!/bin/bash
# ==============================================================================
# Certbot renewal window for servers locked to Cloudflare
# ==============================================================================
# A server locked with `gp cloudflare enable` answers ports 80 and 443 only to
# Cloudflare. GridPane's own hostname certificates (<server>.gridpanevps.com for
# phpMyAdmin, <server>stat.gridpanevps.com for Monit) point straight at the
# server and renew with certbot's webroot check: Let's Encrypt fetches
# http://<host>/.well-known/acme-challenge/..., nginx redirects that to https,
# and the file is served on 443. Let's Encrypt publishes no address list, so on
# a locked server both requests are dropped and the renewal fails.
#
# This installs two certbot hooks:
#   renewal-hooks/pre/<prefix>-port-window.sh   opens 80,443/tcp to everyone
#   renewal-hooks/post/<prefix>-port-window.sh  closes it again
# <prefix> is server.prefix in fleet.config.ts (lib-fleet-names.sh). The hooks are
# written to the server with the names already in them.
# Certbot runs pre hooks only when a certificate is actually due, and runs post
# hooks after the renewals whether they worked or not, so the window lasts the
# length of one renewal run, about once every two months.
#
# The pre hook does nothing on a server whose web ports are already open to
# everyone (not locked), and leaves no marker, so the post hook cannot remove a
# rule it did not add. If the window is ever left open (a reboot mid-renewal),
# the Fleet dashboard's Web ports panel shows the server as "Open to everyone",
# and the next renewal's post hook closes it.
#
# Usage:
#   bash scripts/install-certbot-port-hook.sh                    # AUDIT (read-only)
#   bash scripts/install-certbot-port-hook.sh --apply [server]   # install the hooks
#   bash scripts/install-certbot-port-hook.sh --prove [server]   # certbot renew --dry-run
#   bash scripts/install-certbot-port-hook.sh --remove [server]  # delete the hooks
#
# --prove asks Let's Encrypt's STAGING service for a test renewal of every certbot
# certificate on the server: the hooks run for real, nothing is replaced, and the
# script then checks the window is closed again.
# ==============================================================================

set -u

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

# The names this installs under come from fleet.config.ts; this stops here if
# they cannot be read.
# shellcheck source=lib-fleet-names.sh
. "$(cd "$(dirname "$0")" && pwd)/lib-fleet-names.sh"

MODE="audit"; ONLY=""
case "${1:-}" in
    "")                         MODE="audit" ;;
    --apply|--prove|--remove)   MODE="${1#--}"; ONLY="${2:-}" ;;
    *) echo "Use: (no arg) | --apply [server] | --prove [server] | --remove [server]"; exit 2 ;;
esac

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
echo "mode: $MODE"; echo

# The hook bodies, written to the server verbatim once their names are filled in
# (fleet_names_fill_var, below). /bin/sh, absolute paths: the snap-packaged
# certbot runs hooks with a minimal PATH.
IFS='' read -r -d '' PRE_HOOK <<'HOOK' || true
#!/bin/sh
# Managed by __FLEET_NAME__ (scripts/install-certbot-port-hook.sh). Do not edit.
# Opens 80,443/tcp to everyone for the length of a certbot renewal run on a
# server locked to Cloudflare, so Let's Encrypt can reach the webroot check.
UFW=/usr/sbin/ufw
MARK=/var/lib/__FLEET_PREFIX__/certbot-port-window
[ -x "$UFW" ] || exit 0
"$UFW" status | grep -q '^Status: active' || exit 0
# Already open to everyone (not locked): nothing to open, nothing to close later.
if "$UFW" status | sed 's/#.*//' | grep -Eq '^(80|443)(/tcp)?(,(80|443)(/tcp)?)?( \(v6\))?[[:space:]]+ALLOW( IN)?[[:space:]]+Anywhere'; then
    exit 0
fi
mkdir -p /var/lib/__FLEET_PREFIX__
"$UFW" allow proto tcp to any port 80,443 comment 'certbot renewal window (__FLEET_BRAND__)' > /dev/null && touch "$MARK"
logger -t __FLEET_PREFIX__-certbot "opened 80,443/tcp for a certbot renewal" 2>/dev/null || true
exit 0
HOOK

IFS='' read -r -d '' POST_HOOK <<'HOOK' || true
#!/bin/sh
# Managed by __FLEET_NAME__ (scripts/install-certbot-port-hook.sh). Do not edit.
# Closes the window the pre hook opened. Acts only if the pre hook left its marker.
UFW=/usr/sbin/ufw
MARK=/var/lib/__FLEET_PREFIX__/certbot-port-window
[ -f "$MARK" ] || exit 0
"$UFW" delete allow proto tcp to any port 80,443 > /dev/null
rm -f "$MARK"
logger -t __FLEET_PREFIX__-certbot "closed 80,443/tcp after a certbot renewal" 2>/dev/null || true
exit 0
HOOK

fleet_names_fill_var PRE_HOOK || exit 1
fleet_names_fill_var POST_HOOK || exit 1
PRE_B64=$(printf '%s' "$PRE_HOOK" | base64 | tr -d '\n')
POST_B64=$(printf '%s' "$POST_HOOK" | base64 | tr -d '\n')

IFS='' read -r -d '' REMOTE <<'REMOTE' || true
MODE="$1"; PRE_B64="$2"; POST_B64="$3"
# Sent without its names filled in (see scripts/lib-fleet-names.sh), it stops here.
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) echo "stop=this program arrived without its names filled in; nothing was changed"; exit 1 ;; esac   # names-guard
D=/etc/letsencrypt/renewal-hooks
PRE="$D/pre/__FLEET_PREFIX__-port-window.sh"; POST="$D/post/__FLEET_PREFIX__-port-window.sh"
window_open() {
    ufw status | sed 's/#.*//' | grep -Eq '^80,443/tcp( \(v6\))?[[:space:]]+ALLOW( IN)?[[:space:]]+Anywhere' && echo yes || echo no
}
if ! command -v certbot > /dev/null 2>&1; then echo "certbot=absent"; exit 0; fi
echo "certs=$(ls /etc/letsencrypt/renewal 2>/dev/null | sed 's/\.conf$//' | tr '\n' ' ')"
case "$MODE" in
  (apply)
    mkdir -p "$D/pre" "$D/post"
    echo "$PRE_B64" | base64 -d > "$PRE"; echo "$POST_B64" | base64 -d > "$POST"
    chmod 755 "$PRE" "$POST"
    ;;
  (remove)
    rm -f "$PRE" "$POST"
    ;;
  (prove)
    echo "--- certbot renew --dry-run"
    certbot renew --dry-run --no-random-sleep-on-renew 2>&1 | grep -E 'Simulating|simulated|succeeded|failed|Failed|error|Error|Hook' | sed 's/^/    /'
    echo "--- log"
    journalctl -t __FLEET_PREFIX__-certbot --since "-10 min" --no-pager -o cat 2>/dev/null | sed 's/^/    /'
    ;;
esac
[ -f "$PRE" ] && echo "pre_sha=$(sha256sum "$PRE" | cut -c1-12)" || echo "pre=absent"
[ -f "$POST" ] && echo "post_sha=$(sha256sum "$POST" | cut -c1-12)" || echo "post=absent"
[ -f /var/lib/__FLEET_PREFIX__/certbot-port-window ] && echo "marker=present" || echo "marker=absent"
echo "window_open=$(window_open)"
REMOTE
fleet_names_fill_var REMOTE || exit 1

WANT_PRE=$(printf '%s' "$PRE_HOOK" | shasum -a 256 | cut -c1-12)
WANT_POST=$(printf '%s' "$POST_HOOK" | shasum -a 256 | cut -c1-12)

for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    echo "── $LABEL ($IP)"
    fleet_ssh "$IP" "$REMOTE" "$MODE" "$PRE_B64" "$POST_B64"
    OUT="$FLEET_SSH_OUT"
    if [ -z "$OUT" ]; then fleet_ssh_report_failure; echo; continue; fi
    echo "$OUT" | sed 's/^/   /'
    if echo "$OUT" | grep -q 'certbot=absent'; then echo "   — no certbot here"; echo; continue; fi

    installed=0
    echo "$OUT" | grep -q "pre_sha=$WANT_PRE" && echo "$OUT" | grep -q "post_sha=$WANT_POST" && installed=1
    closed=0
    echo "$OUT" | grep -q 'window_open=no' && echo "$OUT" | grep -q 'marker=absent' && closed=1
    case "$MODE" in
      audit)  [ $installed = 1 ] && echo "   hooks: current" || echo "   hooks: not installed (or not this version)" ;;
      apply)  [ $installed = 1 ] && [ $closed = 1 ] && echo "   ✓ hooks installed and match this script" || echo "   ✗ DID NOT VERIFY" ;;
      remove) echo "$OUT" | grep -q 'pre=absent' && echo "$OUT" | grep -q 'post=absent' && echo "   ✓ hooks removed" || echo "   ✗ DID NOT VERIFY" ;;
      prove)
        ok=1
        echo "$OUT" | grep -q 'all simulated renewals succeeded' || { ok=0; echo "   ✗ a simulated renewal did not succeed"; }
        [ $closed = 1 ] || { ok=0; echo "   ✗ the window is still open"; }
        [ $ok = 1 ] && echo "   ✓ test renewal passed and the window closed again"
        ;;
    esac
    echo
done
echo "Done."
[ -n "$ONLY" ] && echo "(scoped to \"$ONLY\" — the other servers were not touched)"
