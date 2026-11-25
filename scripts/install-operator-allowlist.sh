#!/bin/bash
# ==============================================================================
# Operator allowlist — Fail2Ban ignoreip across the fleet
# ==============================================================================
# Writes /etc/fail2ban/jail.d/<prefix>-allowlist.local on every server so the
# addresses you work from can never be banned. Mirrors the rule the dashboard's
# "Allow an IP" generator emits; this just saves an SSH session per server.
# <prefix> and the file's "Managed by" line come from fleet.config.ts
# (lib-fleet-names.sh), the same values the dashboard's generator uses.
#
# Usage:
#   bash scripts/install-operator-allowlist.sh                       # AUDIT (read-only)
#   bash scripts/install-operator-allowlist.sh 203.0.113.50 web1    # LOOK: what --apply would change on web1; changes nothing
#   bash scripts/install-operator-allowlist.sh --apply 203.0.113.50 web1    # apply to one server first
#   bash scripts/install-operator-allowlist.sh --apply 203.0.113.50         # apply to all servers
#   bash scripts/install-operator-allowlist.sh --apply "203.0.113.50 198.51.100.0/24"  # several, quoted
#   bash scripts/install-operator-allowlist.sh --clear web1          # LOOK: would --apply remove the drop-in there
#   bash scripts/install-operator-allowlist.sh --apply --clear web1  # remove the drop-in on one server
#   bash scripts/install-operator-allowlist.sh --apply --clear       # remove it on all servers
#
# NOTHING CHANGES A SERVER WITHOUT --apply. An address, --clear, --ufw-web or
# --ufw-web-clear on its own only reads each server (the audit's read, or a read
# of `ufw status`) and says what the same command with --apply would do there.
# --apply may stand anywhere on the line.
#
# Web ports on a server locked to Cloudflare (`gp cloudflare enable`):
#   bash scripts/install-operator-allowlist.sh --ufw-web 203.0.113.50 web2                 # LOOK
#   bash scripts/install-operator-allowlist.sh --apply --ufw-web 203.0.113.50 web2         # open 80/443 to it
#   bash scripts/install-operator-allowlist.sh --ufw-web-clear 203.0.113.50 web2           # LOOK
#   bash scripts/install-operator-allowlist.sh --apply --ufw-web-clear 203.0.113.50 web2   # close them again
#
#   A locked server answers ports 80 and 443 only to Cloudflare, which also shuts
#   out the tools GridPane serves straight from the server's own hostname
#   (<server>.gridpanevps.com: phpMyAdmin; <server>stat.gridpanevps.com: Monit).
#   --ufw-web adds `allow proto tcp from <ip> to any port 80,443` for each address:
#   ports 80 and 443 only, SSH untouched. GridPane's `gp cloudflare enable|disable`
#   remove only the "Anywhere" rules and the rules tagged "Cloudflare IP", so they
#   leave these alone. The dashboard's Web ports panel names them by their
#   allowlist label. Verified by reading `ufw status` back.
#
# TWO THINGS THIS ENCODES, both of which are easy to get wrong:
#
#   1. ignoreip REPLACES the inherited value, it does not extend it. Writing
#      `ignoreip = <office>` silently drops Fail2Ban's default 127.0.0.1/8 ::1
#      and the server can start banning itself. Loopback is written explicitly,
#      always.
#
#   2. Do NOT allowlist a mobile hotspot or other carrier-NAT address. Those
#      are shared with other subscribers and rotate constantly, so the entry
#      both stops matching you and starts exempting strangers. Residential and
#      static office ranges only.
#
# The file is a .local drop-in because Fail2Ban reads jail.conf → jail.d/*.conf
# → jail.local → jail.d/*.local, so this wins and survives package updates —
# the same reasoning as GridPane's update-safe nginx *-context.conf includes.
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

# The names this installs under come from fleet.config.ts; this stops here if
# they cannot be read.
# shellcheck source=lib-fleet-names.sh
. "$(cd "$(dirname "$0")" && pwd)/lib-fleet-names.sh"

CONFIG_PATH="/etc/fail2ban/jail.d/$FLEET_PREFIX-allowlist.local"

MODE="audit"
IPS=""
ONLY=""
# --apply is taken out of the arguments wherever it stands, so it may come first or last.
APPLY=0; n=$#
while [ "$n" -gt 0 ]; do
    a="$1"; shift; n=$((n - 1))
    if [ "$a" = "--apply" ]; then APPLY=1; else set -- "$@" "$a"; fi
done
case "${1:-}" in
    "")       MODE="audit"
              [ "$APPLY" = 0 ] || { echo "ABORT: --apply needs the address(es), e.g. --apply 203.0.113.50 web1"; exit 2; } ;;
    --clear)  ONLY="${2:-}"
              # --clear alone only looks. The change needs --apply.
              if [ "$APPLY" = 1 ]; then MODE="clear"; else MODE="look-clear"; fi ;;
    --ufw-web|--ufw-web-clear)
              IPS="${2:-}"; ONLY="${3:-}"
              [ -n "$IPS" ] || { echo "ABORT: $1 needs the address(es), e.g. $1 203.0.113.50 web2"; exit 2; }
              # The same: without --apply it reads the firewall and changes nothing.
              if [ "$APPLY" = 1 ]; then MODE="${1#--}"; else MODE="look-${1#--}"; fi ;;
    -*)       echo "Unknown option: $1"; echo "Use: (no arg) | \"<ip> [ip...]\" [server] | --clear [server] | --ufw-web[-clear] \"<ip> [ip...]\" [server]   (each only looks; add --apply to make the change)"; exit 2 ;;
    *)        IPS="$1"; ONLY="${2:-}"
              # An address alone only looks. The change needs --apply.
              if [ "$APPLY" = 1 ]; then MODE="apply"; else MODE="look"; fi ;;
esac

# Refuse obviously wrong input before it reaches every server as root.
if [ "$MODE" = "apply" ] || [ "$MODE" = "look" ] || [ "$MODE" = "ufw-web" ] || [ "$MODE" = "ufw-web-clear" ] || [ "$MODE" = "look-ufw-web" ] || [ "$MODE" = "look-ufw-web-clear" ]; then
    for ip in $IPS; do
        case "$ip" in
            *[!0-9./a-fA-F:]*) echo "ABORT: '$ip' is not an address or CIDR."; exit 1 ;;
        esac
        case "$ip" in
            100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
                echo "ABORT: $ip is carrier-grade NAT (100.64.0.0/10)."
                echo "       That address is shared with other subscribers — allowlisting it"
                echo "       would exempt them too. Use a residential or static office range."
                exit 1 ;;
        esac
    done
fi

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

# IPv4 CIDR -> network address, matching how fail2ban stores it. Uses modulo
# rather than bitwise and(), which is gawk-only and absent from Ubuntu's mawk.
# Anything that is not an IPv4 CIDR passes through untouched.
normalize_cidr() {
    printf '%s' "$1" | awk -F/ '
        NF == 2 && $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {
            split($1, o, ".")
            ip = o[1] * 16777216 + o[2] * 65536 + o[3] * 256 + o[4]
            p = $2 + 0
            if (p < 0 || p > 32) { print $0; exit }
            block = 2 ^ (32 - p)
            net = ip - (ip % block)
            a = int(net / 16777216); net -= a * 16777216
            b = int(net / 65536);    net -= b * 65536
            c = int(net / 256);      d = net - c * 256
            printf "%d.%d.%d.%d/%d", a, b, c, d, p
            exit
        }
        { print $0 }
    '
}

. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

# How to say the same addresses and server again on a command line.
again() { case "$IPS" in *" "*) printf '"%s"' "$IPS" ;; *) printf '%s' "$IPS" ;; esac; [ -z "$ONLY" ] || printf ' %s' "$ONLY"; }

if [ "$MODE" = "look" ]; then
    echo "mode: look (this shows what --apply would change, and changes nothing)"
    echo "--apply would allowlist: 127.0.0.0/8 ::1 $IPS"
    echo "(loopback is always included — ignoreip replaces rather than extends)"
elif [ "$MODE" = "look-clear" ]; then
    echo "mode: look (this shows what --apply --clear would change, and changes nothing)"
elif [ "$MODE" = "look-ufw-web" ] || [ "$MODE" = "look-ufw-web-clear" ]; then
    echo "mode: look (this shows what --apply --${MODE#look-} would change, and changes nothing)"
    echo "addresses: $IPS"
else
    echo "mode: $MODE"
fi
if [ "$MODE" = "apply" ]; then
    echo "allowlisting: 127.0.0.0/8 ::1 $IPS"
    echo "(loopback is always included — ignoreip replaces rather than extends)"
fi
echo

# The remote program lives in a variable, not a heredoc, because a heredoc is
# consumed once and fleet_ssh may need to run it a second time after a transient
# connect failure. Built with `read -r -d ''` rather than $(cat <<'X') on
# purpose: bash's $( ) scanner counts parentheses and backticks inside heredoc
# bodies, and this script's remote block contains both — a bare `audit)` closes
# the substitution early, and there is a literal backtick in the
# fail2ban list-marker comment below. `read` involves no substitution at all.
IFS='' read -r -d '' REMOTE_ALLOWLIST <<'REMOTE' || true
# `shift 2` + "$*", NOT "$3". ssh joins its arguments into ONE command string and
# the REMOTE shell re-splits it on whitespace, so a quoted multi-address argument
# arrives as several positional parameters — "$3" would silently capture only the
# first and drop the rest: the script would report
# `allowlisting: ... 203.0.113.50 2001:db8:1234:5678::/64` from the local side
# while writing only the IPv4 to the file. A single address hides the problem
# completely. "$*" rejoins whatever arrived.
MODE="$1"; CFG="$2"; shift 2; IPS="$*"
# Sent without its names filled in (see scripts/lib-fleet-names.sh), it stops here.
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) echo "stop=this program arrived without its names filled in; nothing was changed"; exit 1 ;; esac   # names-guard

if ! command -v fail2ban-client > /dev/null 2>&1; then
    echo "fail2ban=absent"
    exit 0
fi

# Every jail, not just the first: ignoreip normally comes from [DEFAULT] and is
# inherited, but it can be set on one jail alone, and reading only jail #1 would
# report an allowlist that exists as absent.
all_jails=$(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' ')

# fail2ban prints list items as "|- item" for all but the last and "`- item" for
# the last, so BOTH markers must be matched or the final entry is lost. A literal
# backtick in a character class inside $( ) breaks bash's parser, so the marker is
# normalised with tr (octal 140 = backtick) before matching.
show_effective() {
    [ -n "$all_jails" ] || { echo "effective: (no jails)"; return; }
    echo "effective: $(for j in $all_jails; do
            fail2ban-client get "$j" ignoreip 2>/dev/null \
              | tr '\140' '|' \
              | sed -n 's/^[[:space:]]*|[[:space:]]*-[[:space:]]*//p'
        done | sed 's/[[:space:]]*$//' | grep -v '^$' | sort -u | tr '\n' ' ')"
}

# The leading "(" on each pattern is required, not stylistic: this case sits in a
# heredoc inside $( ), and bash counts parentheses there — a bare `audit)` closes
# the command substitution early and the whole script fails to parse.
case "$MODE" in
  (audit)
    [ -f "$CFG" ] && echo "dropin=present" || echo "dropin=absent"
    show_effective
    ;;
  (clear)
    if [ -f "$CFG" ]; then rm -f "$CFG"; echo "dropin=removed"; else echo "dropin=absent"; fi
    fail2ban-client reload > /dev/null 2>&1 && echo "reload=ok" || echo "reload=FAILED"
    show_effective
    ;;
  (apply)
    umask 022
    {
      echo "# Managed by __FLEET_NAME__ — operator allowlist."
      echo "# A .local drop-in wins over jail.local and survives package updates."
      echo "# NOTE: ignoreip REPLACES the inherited value rather than extending it, so"
      echo "# loopback is listed explicitly — without it the server can ban itself."
      echo ""
      echo "[DEFAULT]"
      echo "ignoreip = 127.0.0.0/8 ::1 $IPS"
    } > "$CFG"
    echo "dropin=written"
    fail2ban-client reload > /dev/null 2>&1 && echo "reload=ok" || echo "reload=FAILED"
    show_effective
    ;;
esac
REMOTE
fleet_names_fill_var REMOTE_ALLOWLIST || exit 1

# --ufw-web / --ufw-web-clear. `prepend` rather than `insert 1`: insert 1 refuses an
# IPv6 rule when rule 1 is IPv4, and prepend puts each rule at the top of its own
# family. Prints every source a "80,443/tcp" ALLOW rule names, which the local side
# checks against what it asked for.
IFS='' read -r -d '' REMOTE_UFW_WEB <<'REMOTE' || true
MODE="$1"; shift; IPS="$*"
# Sent without its names filled in (see scripts/lib-fleet-names.sh), it stops here.
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) echo "stop=this program arrived without its names filled in; nothing was changed"; exit 1 ;; esac   # names-guard
if ! command -v ufw > /dev/null 2>&1; then
    echo "ufw=absent"
    exit 0
fi
for ip in $IPS; do
    if [ "$MODE" = "ufw-web" ]; then
        res=$(ufw prepend allow proto tcp from "$ip" to any port 80,443 comment '__FLEET_BRAND__ operator allowlist' 2>&1 | tail -n 1)
    else
        res=$(ufw delete allow proto tcp from "$ip" to any port 80,443 2>&1 | tail -n 1)
    fi
    echo "rule $ip: $res"
done
ufw status | sed 's/#.*$//' | awk '$1 == "80,443/tcp" { for (i = 2; i <= NF; i++) if ($i == "ALLOW") { j = i + 1; if ($j == "IN") j++; print "web80443 " $j; break } }'
REMOTE
fleet_names_fill_var REMOTE_UFW_WEB || exit 1

# What --ufw-web and --ufw-web-clear send WITHOUT --apply. It reads only: every
# source a "80,443/tcp" ALLOW rule names, the same read-back as the program above,
# and no `ufw` command that changes a rule.
IFS='' read -r -d '' REMOTE_UFW_LOOK <<'REMOTE' || true
# Sent without its names filled in (see scripts/lib-fleet-names.sh), it stops here.
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) echo "stop=this program arrived without its names filled in; nothing was changed"; exit 1 ;; esac   # names-guard
if ! command -v ufw > /dev/null 2>&1; then
    echo "ufw=absent"
    exit 0
fi
echo "ufw=read"
ufw status | sed 's/#.*$//' | awk '$1 == "80,443/tcp" { for (i = 2; i <= NF; i++) if ($i == "ALLOW") { j = i + 1; if ($j == "IN") j++; print "web80443 " $j; break } }'
REMOTE
fleet_names_fill_var REMOTE_UFW_LOOK || exit 1

for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"
    ID="${rest%%|*}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    echo "── $LABEL ($IP) ─────────────────────────"

    # No command substitution here: fleet_ssh returns its results in globals, and
    # wrapping it in $( ) would run it in a subshell where every one of them is
    # discarded — the caller would then report a stale exit code from the
    # PREVIOUS server.
    case "$MODE" in
      ufw-web|ufw-web-clear) fleet_ssh "$IP" "$REMOTE_UFW_WEB" "$MODE" "$IPS" ;;
      # A look sends the audit, word for word: the read-only program, with no address.
      look|look-clear)       fleet_ssh "$IP" "$REMOTE_ALLOWLIST" audit "$CONFIG_PATH" "" ;;
      # A look at the web ports sends the program that only reads the firewall.
      look-ufw-web|look-ufw-web-clear) fleet_ssh "$IP" "$REMOTE_UFW_LOOK" look ;;
      *)                     fleet_ssh "$IP" "$REMOTE_ALLOWLIST" "$MODE" "$CONFIG_PATH" "$IPS" ;;
    esac
    OUT="$FLEET_SSH_OUT"

    if [ -z "$OUT" ]; then
        fleet_ssh_report_failure
        echo; continue
    fi
    echo "$OUT" | sed 's/^/   /'

    case "$MODE" in
      look)
        # What --apply would do here, worked out from what the server just said.
        # Compared on the network address, as the apply check below does.
        if echo "$OUT" | grep -q 'fail2ban=absent'; then
            echo "   --apply would change nothing here: Fail2Ban is not installed"
        else
            EFFECTIVE=$(echo "$OUT" | grep "^ *effective:" | sed 's/.*effective://')
            case "$EFFECTIVE" in *"(no jails)"*) EFFECTIVE="" ;; esac
            added=""; kept=""; dropped=""
            for ip in 127.0.0.0/8 ::1 $IPS; do
                want=$(normalize_cidr "$ip"); found=0
                for got in $EFFECTIVE; do [ "$(normalize_cidr "$got")" = "$want" ] && { found=1; break; }; done
                if [ "$found" = 1 ]; then kept="$kept $ip"; else added="$added $ip"; fi
            done
            for got in $EFFECTIVE; do
                have=$(normalize_cidr "$got"); found=0
                for ip in 127.0.0.0/8 ::1 $IPS; do [ "$(normalize_cidr "$ip")" = "$have" ] && { found=1; break; }; done
                [ "$found" = 1 ] || dropped="$dropped $got"
            done
            if echo "$OUT" | grep -q 'dropin=present'; then echo "   --apply would replace $CONFIG_PATH with:"
            else echo "   --apply would write a new file, $CONFIG_PATH, with:"; fi
            echo "       ignoreip = 127.0.0.0/8 ::1 $IPS"
            echo "   and reload Fail2Ban, then read the list back."
            echo "   added to the list:   ${added:- none}"
            echo "   already in the list: ${kept:- none}"
            echo "   no longer in it:     ${dropped:- none}"
            [ -z "$dropped" ] || echo "   (the new line replaces the whole list. A jail that sets a list of its own keeps it.)"
        fi
        ;;
      look-clear)
        if echo "$OUT" | grep -q 'fail2ban=absent'; then
            echo "   --apply would change nothing here: Fail2Ban is not installed"
        elif echo "$OUT" | grep -q 'dropin=present'; then
            echo "   --apply would remove $CONFIG_PATH and reload Fail2Ban."
            echo "   An address only that file allows could then be banned again."
        else
            echo "   --apply would remove nothing here: $CONFIG_PATH is not there. It would still reload Fail2Ban."
        fi
        ;;
      look-ufw-web|look-ufw-web-clear)
        # What --apply would do here, worked out from the rules the server just listed.
        # Compared on the network address, as the read-back after a change is.
        if echo "$OUT" | grep -q 'ufw=absent'; then
            echo "   --apply would change nothing here: UFW is not installed"
        else
            LIVE=$(echo "$OUT" | sed -n 's/^web80443 //p')
            there=""; absent=""
            for ip in $IPS; do
                want=$(normalize_cidr "$ip"); found=0
                for got in $LIVE; do [ "$(normalize_cidr "$got")" = "$want" ] && { found=1; break; }; done
                if [ "$found" = 1 ]; then there="$there $ip"; else absent="$absent $ip"; fi
            done
            if [ "$MODE" = "look-ufw-web" ]; then
                echo "   --apply would open ports 80 and 443 to:${absent:- none}"
                echo "   already open to:${there:- none}"
            else
                echo "   --apply would close ports 80 and 443 to:${there:- none}"
                echo "   not open to them now, so nothing to remove:${absent:- none}"
            fi
        fi
        ;;
      apply)
        # Verified by reading Fail2Ban's own effective value back, not by trusting
        # that the file was written: a reload failure would leave the old value live.
        #
        # Comparison is on the NETWORK address, because fail2ban canonicalises a
        # CIDR when it stores it — write 127.0.0.1/8 and it reports 127.0.0.0/8.
        # A literal string match called that a failure on a rule that was live and
        # correct, and would have done the same to any range entered with host
        # bits set (198.51.100.5/24 -> 198.51.100.0/24).
        ok=1
        echo "$OUT" | grep -q 'dropin=written' || ok=0
        echo "$OUT" | grep -q 'reload=ok' || ok=0
        EFFECTIVE=$(echo "$OUT" | grep "^ *effective:" | sed 's/.*effective://')
        for ip in $IPS 127.0.0.0/8; do
            want=$(normalize_cidr "$ip")
            found=0
            for got in $EFFECTIVE; do
                [ "$(normalize_cidr "$got")" = "$want" ] && { found=1; break; }
            done
            [ "$found" = "1" ] || { ok=0; echo "   missing from effective list: $ip"; }
        done
        if [ "$ok" = "1" ]; then
            echo "   ✓ allowlist active and confirmed by fail2ban-client"
        elif echo "$OUT" | grep -q 'fail2ban=absent'; then
            echo "   — Fail2Ban is not installed here; nothing to allowlist"
        else
            echo "   ✗ DID NOT VERIFY — the effective list above does not contain every address"
        fi
        ;;
      clear)
        echo "$OUT" | grep -q 'reload=ok' && echo "   ✓ drop-in removed, Fail2Ban reloaded"
        ;;
      ufw-web|ufw-web-clear)
        # Read back, never trusted: each address must (or must no longer) appear as the
        # source of an "80,443/tcp" ALLOW rule. Compared on the network address, as above.
        if echo "$OUT" | grep -q 'ufw=absent'; then
            echo "   — UFW is not installed here; nothing to change"
        else
            ok=1
            LIVE=$(echo "$OUT" | sed -n 's/^web80443 //p')
            for ip in $IPS; do
                want=$(normalize_cidr "$ip"); found=0
                for got in $LIVE; do [ "$(normalize_cidr "$got")" = "$want" ] && { found=1; break; }; done
                if [ "$MODE" = "ufw-web" ] && [ "$found" = "0" ]; then ok=0; echo "   missing: $ip"; fi
                if [ "$MODE" = "ufw-web-clear" ] && [ "$found" = "1" ]; then ok=0; echo "   still present: $ip"; fi
            done
            if [ "$ok" = "1" ]; then
                [ "$MODE" = "ufw-web" ] && echo "   ✓ ports 80/443 open to these addresses, confirmed by ufw status" \
                                        || echo "   ✓ removed, confirmed by ufw status"
            else
                echo "   ✗ DID NOT VERIFY — see the lines above"
            fi
        fi
        ;;
    esac
    echo
done

echo "Done."
[ -n "$ONLY" ] && echo "(scoped to \"$ONLY\" — the other servers were not touched)"
case "$MODE" in
    audit) echo "Pass an address to see what applying it would change, e.g.: bash $0 203.0.113.50 web1" ;;
    look)  echo "Looked only. Nothing was changed. To make the change:"
           echo "  bash $0 --apply $(again)" ;;
    look-clear)
           echo "Looked only. Nothing was changed. To make the change:"
           echo "  bash $0 --apply --clear${ONLY:+ $ONLY}" ;;
    look-ufw-web|look-ufw-web-clear)
           echo "Looked only. Nothing was changed. To make the change:"
           echo "  bash $0 --apply --${MODE#look-} $(again)" ;;
    apply) echo "The dashboard's Firewall panel will show these as verified on the next agent cycle (~10 min)." ;;
esac
