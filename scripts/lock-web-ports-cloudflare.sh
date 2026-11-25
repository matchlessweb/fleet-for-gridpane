#!/bin/bash
# ==============================================================================
# Lock a server's web ports (80, 443) to Cloudflare — audit, apply, undo
# ==============================================================================
# Uses GridPane's own `gp cloudflare enable`: it downloads Cloudflare's published
# ranges (aborts if either list fails), deletes the open 80/443 rules, and allows
# tcp 80,443 from each range (comment "Cloudflare IP"). `gp cloudflare disable`
# reverses it. SSH and every other port are untouched.
#
# A site whose DNS points straight at the server (grey cloud) stops loading the
# moment its server is locked, so the audit resolves every nginx server_name on
# the server and refuses to lock a server where any name does that.
#
# Usage:
#   bash scripts/lock-web-ports-cloudflare.sh                  # AUDIT every server (read-only)
#   bash scripts/lock-web-ports-cloudflare.sh --audit <server> # audit one server
#   bash scripts/lock-web-ports-cloudflare.sh --apply <server> # back up UFW, lock, verify
#   bash scripts/lock-web-ports-cloudflare.sh --undo  <server> # gp cloudflare disable, verify
#
# --apply checks, from this machine: every name that goes through Cloudflare still
# answers (no 52x), and a request straight to the server's address times out. Run it
# BEFORE adding an operator address (install-operator-allowlist.sh --apply --ufw-web), or the
# direct check passes for the wrong reason. Then install the certbot renewal window
# (install-certbot-port-hook.sh --apply <server>) so the server's own hostname
# certificates keep renewing.
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

MODE="audit"; ONLY=""
case "${1:-}" in
    "")                         MODE="audit" ;;
    --audit|--apply|--undo)     MODE="${1#--}"; ONLY="${2:-}"
                                if [ "$MODE" != audit ] && [ -z "$ONLY" ]; then echo "--$MODE needs one server"; exit 2; fi ;;
    *) echo "Use: (no arg) | --audit <server> | --apply <server> | --undo <server>"; exit 2 ;;
esac
command -v python3 > /dev/null || { echo "ABORT: needs python3 for the address checks"; exit 1; }
command -v dig > /dev/null || { echo "ABORT: needs dig"; exit 1; }

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

# Cloudflare's current ranges (public, no key).
CF_RANGES=$(curl -s --max-time 15 https://api.cloudflare.com/client/v4/ips \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(" ".join(r["ipv4_cidrs"]+r["ipv6_cidrs"]))' 2>/dev/null)
[ -n "$CF_RANGES" ] || { echo "ABORT: could not fetch Cloudflare's ranges"; exit 1; }
CF_COUNT=$(echo "$CF_RANGES" | wc -w | tr -d ' ')
echo "mode: $MODE · Cloudflare publishes $CF_COUNT ranges"; echo

IFS='' read -r -d '' REMOTE <<'REMOTE' || true
MODE="$1"
web_state() {
    echo "ufw=$(ufw status | head -1 | awk '{print $2}')"
    echo "cf_rules=$(ufw status | grep -c '# Cloudflare IP')"
    if ufw status | sed 's/#.*//' | grep -Eq '^(80|443)(/tcp)?(,(80|443)(/tcp)?)?( \(v6\))?[[:space:]]+ALLOW( IN)?[[:space:]]+Anywhere'; then
        echo "open_to_anywhere=yes"; else echo "open_to_anywhere=no"; fi
}
case "$MODE" in
  (apply)
    command -v gp > /dev/null || { echo "gp=absent"; exit 0; }
    B="/root/ufw-backup-$(date -u +%F)-cloudflare-lock"
    [ -e "$B" ] && B="$B-$(date -u +%H%M%S)"
    mkdir -p "$B" && cp /etc/ufw/user.rules /etc/ufw/user6.rules "$B/" && ufw status numbered > "$B/status-before.txt" \
        || { echo "backup=failed"; exit 0; }
    echo "backup=$B"
    gp cloudflare enable > "$B/gp-cloudflare-enable.log" 2>&1; echo "gp_rc=$?"
    ufw status numbered > "$B/status-after.txt"
    ;;
  (undo)
    gp cloudflare disable > /root/gp-cloudflare-disable-$(date -u +%F-%H%M%S).log 2>&1; echo "gp_rc=$?"
    ;;
esac
web_state
echo "ip4=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"
echo "ip6=$(ip -6 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"
echo "names=$(nginx -T 2>/dev/null | sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^;]*\);.*/\1/p' | tr ' \t' '\n\n' | grep -v '^$' | sort -u | tr '\n' ' ')"
REMOTE

# For each name: where does it resolve? cf | this | elsewhere | none | skip
# Prints "verdict name addrs" lines.
classify_names() {   # $1 names, $2 server addrs
    NAMES="$1" SELF="$2" CF="$CF_RANGES" python3 - <<'PY'
import ipaddress, os, random, subprocess
cf = [ipaddress.ip_network(r) for r in os.environ["CF"].split()]
self_ = {ipaddress.ip_address(a) for a in os.environ["SELF"].split()}
def resolve(n):
    out = []
    for t in ("A", "AAAA"):
        r = subprocess.run(["dig", "+short", "+time=3", "+tries=2", t, n, "@1.1.1.1"], capture_output=True, text=True).stdout
        for line in r.split():
            try: out.append(ipaddress.ip_address(line))
            except ValueError: pass   # CNAME targets
    return out
for n in os.environ["NAMES"].split():
    if n in ("_", "localhost") or n.startswith("~") or n.endswith(".gridpanevps.com"):
        print("skip", n, "-"); continue
    try:
        ipaddress.ip_address(n); print("skip", n, "-"); continue
    except ValueError: pass
    probe = n.replace("*", "fleet-probe-%d" % random.randint(1000, 9999)) if "*" in n else n
    addrs = resolve(probe)
    if not addrs: v = "none"
    elif any(a in self_ for a in addrs): v = "this"
    elif all(any(a in net for net in cf) for a in addrs): v = "cf"
    else: v = "elsewhere"
    print(v, n, ",".join(map(str, addrs)) or "-")
PY
}

field() { echo "$OUT" | sed -n "s/^$1=//p" | head -1; }

for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    echo "── $LABEL ($IP)"

    # Apply refuses unless a fresh audit is clean.
    if [ "$MODE" = apply ]; then
        fleet_ssh "$IP" "$REMOTE" audit; OUT="$FLEET_SSH_OUT"
        [ -n "$OUT" ] || { fleet_ssh_report_failure; echo; continue; }
        CLASSES=$(classify_names "$(field names)" "$(field ip4) $(field ip6)")
        if echo "$CLASSES" | grep -q '^this '; then
            echo "   ✗ NOT LOCKED: these names point straight at the server:"
            echo "$CLASSES" | grep '^this ' | sed 's/^this /     /'
            echo; continue
        fi
        [ "$(field ufw)" = active ] || { echo "   ✗ NOT LOCKED: UFW is $(field ufw)"; echo; continue; }
    fi

    fleet_ssh "$IP" "$REMOTE" "$MODE"; OUT="$FLEET_SSH_OUT"
    [ -n "$OUT" ] || { fleet_ssh_report_failure; echo; continue; }
    echo "$OUT" | grep -Ev '^(names|ip4|ip6)=' | sed 's/^/   /'
    CLASSES=$(classify_names "$(field names)" "$(field ip4) $(field ip6)")
    for v in this elsewhere none cf; do
        list=$(echo "$CLASSES" | awk -v v="$v" '$1==v {print $2}' | tr '\n' ' ')
        [ -n "$list" ] || continue
        case "$v" in
            this)      echo "   ✗ straight to this server: $list" ;;
            elsewhere) echo "   ? resolves elsewhere (not this server, not Cloudflare):"
                       echo "$CLASSES" | awk '$1=="elsewhere" {print "       " $2 "  " $3}' ;;
            none)      echo "   · no DNS: $list" ;;
            cf)        echo "   ✓ through Cloudflare ($(echo $list | wc -w | tr -d ' ')): $list" ;;
        esac
    done

    LOCKED=0
    [ "$(field cf_rules)" = "$CF_COUNT" ] && [ "$(field open_to_anywhere)" = no ] && LOCKED=1
    case "$MODE" in
      audit)
        if [ $LOCKED = 1 ]; then echo "   state: locked to Cloudflare"
        elif echo "$CLASSES" | grep -q '^this '; then echo "   state: open · NOT READY (fix the names above first)"
        else echo "   state: open · ready to lock"; fi
        ;;
      apply)
        [ "$(field gp_rc)" = 0 ] || echo "   ✗ gp cloudflare enable exited $(field gp_rc) (log in $(field backup))"
        if [ $LOCKED = 1 ]; then echo "   ✓ UFW: $CF_COUNT Cloudflare ranges, nothing open to everyone"
        else echo "   ✗ UFW DID NOT VERIFY — undo with: --undo $LABEL"; echo; continue; fi
        # Through Cloudflare: every proxied name still answers.
        bad=0
        for n in $(echo "$CLASSES" | awk '$1=="cf" && $2 !~ /\*/ {print $2}'); do
            code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "https://$n/")
            case "$code" in 52[0-9]|000)   # one retry: an uncached first page can outlast 25s
                sleep 5; first=$code
                code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 45 "https://$n/")
                case "$code" in 52[0-9]|000) bad=1; echo "   ✗ $n → $first, then $code through Cloudflare" ;;
                                *) echo "   · $n → $first, then $code on retry" ;; esac ;;
            esac
        done
        [ $bad = 0 ] && echo "   ✓ every Cloudflare name answers through Cloudflare (no 52x)"
        # Straight to the server: the connection itself must time out from here
        # (curl exit 28). Not the HTTP code: GridPane's default server answers a bare
        # address by closing the connection (444), which also reads as 000.
        curl -s -o /dev/null --connect-timeout 6 "http://$IP/"; d80=$?
        curl -sk -o /dev/null --connect-timeout 6 "https://$IP/"; d443=$?
        if [ "$d80" = 28 ] && [ "$d443" = 28 ]; then echo "   ✓ $IP:80 and :443 time out from this machine"
        else echo "   ✗ $IP still accepts connections from here (curl exit 80 → $d80, 443 → $d443): is this machine's address already allowed?"; fi
        ;;
      undo)
        [ "$(field open_to_anywhere)" = yes ] && [ "$(field cf_rules)" = 0 ] && echo "   ✓ unlocked: 80/443 open to everyone again" || echo "   ✗ UNDO DID NOT VERIFY"
        ;;
    esac
    echo
done
echo "Done."
[ -n "$ONLY" ] && echo "(scoped to \"$ONLY\" — the other servers were not touched)"
