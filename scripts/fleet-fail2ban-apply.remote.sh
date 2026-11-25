#!/bin/bash
# ==============================================================================
# Fail2Ban behind Cloudflare — the program that runs ON a server
# ==============================================================================
#   bash -s <dry-run|live> <site|zone-id|zone-name> [...]
#
# WHAT IT SETS UP. For every site, three jails of its own (hard / soft / extra,
# same thresholds as GridPane's) that read only THAT site's lines in auth.log and
# ban in THAT site's Cloudflare zone, plus a local firewall ban for traffic that
# reaches the server directly. A ban on one client's site never writes into
# another client's zone.
#
# WHAT IT WRITES, all under names of its own, so nothing GridPane manages is
# edited and removal is "delete these files, reload":
#   /etc/fail2ban/action.d/__FLEET_PREFIX__-cloudflare.conf   the action; holds NO token
#   /etc/fail2ban/__FLEET_PREFIX__-cloudflare.sh              what the action runs (root-only)
#   /var/lib/fail2ban/__FLEET_PREFIX__-cf/<zone>/<address>    which jails hold each ban
#   /etc/fail2ban/__FLEET_PREFIX__-cloudflare.token           the token, root-only (live only)
#   /etc/fail2ban/filter.d/__FLEET_JAIL_PREFIX__-base-{hard,soft,extra}.conf  the WordPress patterns
#   /etc/fail2ban/filter.d/__FLEET_JAIL_PREFIX__-<site>-{h,s,x}.conf      the same patterns, one site
#   /etc/fail2ban/jail.d/__FLEET_PREFIX__-cloudflare.local    the jails
# GridPane's own wordpress-* jails are left exactly as they are.
# The names written __LIKE_THIS__ are filled in by the sender from fleet.config.ts
# before this program is sent (scripts/lib-fleet-names.sh).
#
# THE PATTERNS ARE CARRIED HERE, not borrowed from GridPane's wordpress-*.conf.
# GridPane copies those files in from the plugin the first time a site on the
# server has the integration switched on, so a server where it has never been on
# has none. With our own copy the jails work on every
# server, plugin on, off or mixed. The dry run compares our copy with GridPane's
# wherever GridPane's exists and fails if they differ, so a plugin update that
# changes the wording is noticed.
#
# THE PLUGIN IS LEFT AS IT IS unless ENABLE_PLUGIN=1 is sent. A site with it off
# gets its jails anyway: they run, see no lines, and start working the moment the
# integration is switched on for that site in GridPane.
#
# EVERY JAIL SETS backend = polling. Ubuntu 24.04's package sets the default to
# systemd, under which logpath is ignored and these jails would read nothing
# (GridPane #2081 fixes the same thing for its own jails).
#
# DRY-RUN (the default) changes nothing in /etc/fail2ban. It copies the config to
# a private temp folder, generates into the copy, asks Fail2Ban to test the copy,
# and runs each new filter over sample lines (this site, its www name, two
# lookalike names and an unrelated site) and over the real auth.log, to prove it
# matches this site's lines and no other site's. The temp folder is removed.
#
# In live mode the token arrives as $CF_TOKEN in this program's own text (ssh
# stdin), never as an argument. It is written to its file and never printed.
# ==============================================================================
set -u
MODE="${1:-dry-run}"; shift || true
R="${F2B_ROOT:-}"                    # local generation test only
ETC="$R/etc/fail2ban"; LOG="$R/var/log/auth.log"
TOKEN_FILE=/etc/fail2ban/__FLEET_PREFIX__-cloudflare.token
HELPER_FILE=/etc/fail2ban/__FLEET_PREFIX__-cloudflare.sh
HOLDERS=/var/lib/fail2ban/__FLEET_PREFIX__-cf
say() { printf '%s\n' "$*"; }
# Sent without its names filled in (see scripts/lib-fleet-names.sh), it stops here.
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) say "stop=this program arrived without its names filled in; nothing was changed"; exit 1 ;; esac   # names-guard

slug() {  # jail names must stay short: iptables chain names cap at 28 with the f2b- prefix
    local h; h=$(printf '%s' "$1" | { md5sum 2>/dev/null || md5; } | cut -c1-4)
    printf '__FLEET_JAIL_PREFIX__-%s-%s' "$(printf '%s' "$1" | tr -cd 'a-z0-9' | cut -c1-__FLEET_JAIL_SITE_CHARS__)" "$h"
}
re_escape() { printf '%s' "$1" | sed 's/\./\\./g'; }

generate() {  # $1 = config dir to write into; remaining = specs
    local dir="$1"; shift
    cat > "$dir/action.d/__FLEET_PREFIX__-cloudflare.conf" <<'ACTION'
# Managed by __FLEET_NAME__ (scripts/fleet-fail2ban-apply.sh). Do not hand-edit.
# Bans in ONE Cloudflare zone, given per jail as __FLEET_PREFIX__-cloudflare[cfzone=...].
# The work is done by <cfhelper>, which keeps count of the jails holding each
# address and reads the token itself; this file holds no secret.
[Definition]
actionstart =
actionstop =
actioncheck =
actionban = <cfhelper> ban <cfzone> <cftarget> <ip> <name>
actionunban = <cfhelper> unban <cfzone> <cftarget> <ip> <name>

[Init]
cfhelper = /etc/fail2ban/__FLEET_PREFIX__-cloudflare.sh
cftarget = ip
cfzone =

[Init?family=inet6]
cftarget = ip6
ACTION
    chmod 644 "$dir/action.d/__FLEET_PREFIX__-cloudflare.conf"

    cat > "$dir/__FLEET_PREFIX__-cloudflare.sh" <<'HELPER'
#!/bin/bash
# Managed by __FLEET_NAME__ (scripts/fleet-fail2ban-apply.sh). Do not hand-edit.
#   __FLEET_PREFIX__-cloudflare.sh ban|unban <zone-id> <ip|ip6> <address> <jail>
#
# WHY THIS IS A PROGRAM AND NOT ONE LINE IN THE ACTION. Cloudflare keeps one
# rule per address per zone, and a site has three jails (and a zone can have
# several sites) banning into the same zone. If each jail deleted "its" rule on
# unban, the 10-minute jail would delete the only rule while the 1-hour or
# 1-day jail still held the address (found 2026-11-18). So this keeps a list of
# HOLDERS per zone and address, and deletes the Cloudflare rule only when the
# last holder lets go.
#
#   holders: <state>/<zone>/<address>, one "jail epoch" line per jail
#   A holder older than MAXAGE is dropped: no ban lasts that long, so it was
#   left by a crash. Fail2Ban re-runs "ban" for restored bans when it starts,
#   which renews them.
#
# THE TOKEN never appears on a command line (other users on the server can read
# those). It goes to curl on stdin, as a header, from a shell builtin.
# Forced onto IPv4 because the token is locked to this server's IPv4 address.
set -u
act="${1:-}"; zone="${2:-}"; target="${3:-}"; ip="${4:-}"; jail="${5:-}"
TOKEN_FILE="${__FLEET_JAIL_UPPER___CF_TOKEN_FILE:-/etc/fail2ban/__FLEET_PREFIX__-cloudflare.token}"
STATE="${__FLEET_JAIL_UPPER___CF_STATE:-/var/lib/fail2ban/__FLEET_PREFIX__-cf}"
MAXAGE=90000      # 25 hours; the longest jail bans for 24
case "$act" in (ban|unban) ;; (*) exit 2 ;; esac
case "$target" in (ip|ip6) ;; (*) exit 2 ;; esac
printf '%s' "$zone" | grep -E -q '^[0-9a-f]{32}$' || exit 2
printf '%s' "$ip" | grep -E -q '^[0-9A-Fa-f:.]{3,45}$' || exit 2
printf '%s' "$jail" | grep -E -q '^[A-Za-z0-9_-]{1,40}$' || exit 2
[ -s "$TOKEN_FILE" ] || exit 1
API="https://api.cloudflare.com/client/v4/zones/$zone/firewall/access_rules/rules"
d="$STATE/$zone"
mkdir -p "$d" && chmod 700 "$STATE" "$d" || exit 1
f="$d/$(printf '%s' "$ip" | tr ':' '_')"

# One at a time per zone. A lock older than two minutes was left by a kill.
lock="$d/.lock"; n=0
until mkdir "$lock" 2>/dev/null; do
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null; continue; fi
    n=$((n + 1)); [ "$n" -le 200 ] || exit 1; sleep 0.2
done
trap 'rmdir "$lock" 2>/dev/null' EXIT; trap 'exit 143' TERM INT HUP

now=$(date +%s)
others() {  # holders still in force, other than this jail
    [ -f "$f" ] && awk -v j="$jail" -v min="$((now - MAXAGE))" '$1 != j && $2 + 0 >= min' "$f"
}
cf() {
    printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" \
        | curl -4 -s --max-time 15 -H @- -H "Content-Type: application/json" "$@"
}

if [ "$act" = ban ]; then
    o=$(others)
    { [ -n "$o" ] && printf '%s\n' "$o"; printf '%s %s\n' "$jail" "$now"; } > "$f.new" && mv "$f.new" "$f" || exit 1
    # 10009 = a rule for this address is already in the zone: banned already.
    cf -X POST "$API" --data "{\"mode\":\"block\",\"configuration\":{\"target\":\"$target\",\"value\":\"$ip\"},\"notes\":\"__FLEET_BRAND__ Fail2Ban $jail\"}" \
        | grep -E -q '"success": ?true|"code": ?10009'
    exit $?
fi

o=$(others)
if [ -n "$o" ]; then printf '%s\n' "$o" > "$f.new" && mv "$f.new" "$f"; exit 0; fi
rm -f "$f"
# The last holder let go. Delete the rule whichever jail's name is on it, but
# only a block rule for exactly this address that Fail2Ban made here: a rule
# somebody made by hand is never touched.
ids=$(cf -G "$API" --data-urlencode "mode=block" --data-urlencode "configuration.target=$target" \
        --data-urlencode "configuration.value=$ip" --data-urlencode "per_page=50" | python3 -c '
import ipaddress, json, sys
try: d = json.load(sys.stdin)
except Exception: print("FAILED"); sys.exit()
if not d.get("success"): print("FAILED"); sys.exit()
def same(a, b):
    try: return ipaddress.ip_address(a) == ipaddress.ip_address(b)
    except ValueError: return a == b
for x in d.get("result") or []:
    c = x.get("configuration") or {}
    if x.get("mode") == "block" and same(str(c.get("value")), sys.argv[1]) \
       and (x.get("notes") or "").startswith("__FLEET_BRAND__ Fail2Ban ") \
       and (x.get("scope") or {}).get("type") == "zone":
        print(x["id"])
' "$ip")
[ "$ids" = FAILED ] && exit 1
rc=0
for id in $ids; do
    printf '%s' "$id" | grep -E -q '^[0-9a-f]{32}$' || continue
    cf -X DELETE "$API/$id" | grep -E -q '"success": ?true' || rc=1
done
exit $rc
HELPER
    chmod 700 "$dir/__FLEET_PREFIX__-cloudflare.sh"

    # The plugin's own patterns (wp-fail2ban filters.d, as GridPane installs them).
    cat > "$dir/filter.d/__FLEET_JAIL_PREFIX__-base-hard.conf" <<'F'
# Managed by __FLEET_NAME__. wp-fail2ban's "hard" patterns, all sites.
[INCLUDES]
before = common.conf
[Definition]
_daemon = (?:wordpress|wp)
failregex = ^%(__prefix_line)sSpam comment \d+ from <HOST>$
            ^%(__prefix_line)sBlocked user enumeration attempt from <HOST>$
            ^%(__prefix_line)sXML-RPC multicall authentication failure from <HOST>$
            ^%(__prefix_line)sPingback error .* generated from <HOST>$
            ^%(__prefix_line)sBlocked authentication attempt for .* from <HOST>$
            ^%(__prefix_line)sAkismet discarded spam comment from <HOST>$
            ^%(__prefix_line)sXML-RPC request blocked from <HOST>$
            ^%(__prefix_line)s.*; Bogus Pingback from <HOST>$
            ^%(__prefix_line)sBlocked access from country '..' from <HOST>$
            ^%(__prefix_line)sImmediately block connections from <HOST>$
            ^%(__prefix_line)sUntrusted X-Forwarded-For header from <HOST>$
            ^%(__prefix_line)sREST authentication attempt for unknown user .* from <HOST>$
            ^%(__prefix_line)sXML-RPC authentication attempt for unknown user .* from <HOST>$
ignoreregex =
F
    cat > "$dir/filter.d/__FLEET_JAIL_PREFIX__-base-soft.conf" <<'F'
# Managed by __FLEET_NAME__. wp-fail2ban's "soft" patterns, all sites.
[INCLUDES]
before = common.conf
[Definition]
_daemon = (?:wordpress|wp)
failregex = ^%(__prefix_line)sPingback requested from <HOST>$
            ^%(__prefix_line)sComment attempt on .* post \d+ from <HOST>$
            ^%(__prefix_line)sBlocked username authentication attempt for .* from <HOST>$
            ^%(__prefix_line)sEmpty username from <HOST>$
            ^%(__prefix_line)sAuthentication failure for .* from <HOST>$
            ^%(__prefix_line)sREST authentication failure for .* from <HOST>$
            ^%(__prefix_line)sXML-RPC authentication failure for .* from <HOST>$
            ^%(__prefix_line)sAuthentication attempt for unknown user .* from <HOST>$
ignoreregex =
F
    cat > "$dir/filter.d/__FLEET_JAIL_PREFIX__-base-extra.conf" <<'F'
# Managed by __FLEET_NAME__. wp-fail2ban's "extra" patterns, all sites.
[INCLUDES]
before = common.conf
[Definition]
_daemon = (?:wordpress|wp)
failregex = ^%(__prefix_line)sPassword reset requested for .* from <HOST>$
            ^%(__prefix_line)sComment \d+ from <HOST>$
ignoreregex =
F
    chmod 644 "$dir"/filter.d/__FLEET_JAIL_PREFIX__-base-*.conf

    local J="$dir/jail.d/__FLEET_PREFIX__-cloudflare.local"
    { say "# Managed by __FLEET_NAME__ (scripts/fleet-fail2ban-apply.sh). Do not hand-edit."
      say "# One set of jails per site; each bans only in that site's Cloudflare zone."; } > "$J"
    local spec site zid s k base retry ban
    for spec in "$@"; do
        site="${spec%%|*}"; zid="${spec#*|}"; zid="${zid%%|*}"; s=$(slug "$site")
        for k in h s x; do
            case "$k" in
              (h) base=hard;  retry=1; ban=600 ;;
              (s) base=soft;  retry=3; ban=3600 ;;
              (x) base=extra; retry=3; ban=86400 ;;
            esac
            # The patterns, narrowed to this site's lines (with or without
            # www.) by overriding the daemon name the patterns expect.
            # The plugin builds the name from the request's Host header
            # (wp-fail2ban lib/syslog.php, getHost), and nginx routes a
            # request to the site whatever the header's capitals, port or
            # trailing dot. So those three are accepted here too, or a
            # request sent as "SHOP.EXAMPLE:443" would be logged under a name
            # no jail of ours reads (2026-11-18). Nothing else is: the
            # closing bracket must follow.
            { say "# Managed by __FLEET_NAME__. wordpress-$base, lines from $site only."
              say "[INCLUDES]"; say "before = __FLEET_JAIL_PREFIX__-base-$base.conf"
              say "[Definition]"
              say "_daemon = (?:wordpress|wp)\\((?i:(?:www\\.)?$(re_escape "$site"))\\.?(?::\\d+)?\\)"; } > "$dir/filter.d/$s-$k.conf"
            { say ""; say "[$s-$k]"; say "# $site — wordpress-$base"
              say "enabled = true"; say "filter = $s-$k"; say "backend = polling"; say "logpath = /var/log/auth.log"
              say "maxretry = $retry"; say "findtime = 600"; say "bantime = $ban"
              say "action = __FLEET_PREFIX__-cloudflare[cfzone=$zid]"
              say "         iptables-allports[name=$s-$k]"; } >> "$J"
        done
    done
}

[ "$#" -ge 1 ] || { say "stop=no sites given"; exit 0; }
say "mode=$MODE"; say "sites=$#"

if [ "$MODE" = generate ]; then      # local test: write into a fixture, run nothing
    generate "$ETC" "$@"; say "generated=yes"; exit 0
fi

command -v fail2ban-client > /dev/null 2>&1 || { say "stop=fail2ban is not installed"; exit 0; }

if [ "$MODE" = dry-run ]; then
    T=$(mktemp -d) && chmod 700 "$T" || { say "stop=could not make a temp folder"; exit 0; }
    trap 'rm -rf "$T"' EXIT
    cp -a /etc/fail2ban/. "$T/"
    for f in action.d/__FLEET_PREFIX__-cloudflare.conf jail.d/__FLEET_PREFIX__-cloudflare.local filter.d/__FLEET_JAIL_PREFIX__-base-hard.conf filter.d/__FLEET_JAIL_PREFIX__-base-soft.conf filter.d/__FLEET_JAIL_PREFIX__-base-extra.conf; do
        [ -e "/etc/fail2ban/$f" ] && say "would_replace=/etc/fail2ban/$f" || say "would_create=/etc/fail2ban/$f"
    done
    [ -e "$TOKEN_FILE" ] && say "would_replace=$TOKEN_FILE (root only, 600)" || say "would_create=$TOKEN_FILE (root only, 600)"
    [ -e "$HELPER_FILE" ] && say "would_replace=$HELPER_FILE (root only, 700)" || say "would_create=$HELPER_FILE (root only, 700)"
    generate "$T" "$@"
    bash -n "$T/__FLEET_PREFIX__-cloudflare.sh" 2> /dev/null && say "helper_syntax=ok" || say "helper_syntax=FAILED"
    say "helper_needs python3=$(command -v python3 > /dev/null 2>&1 && echo yes || echo MISSING) curl=$(curl --version 2>/dev/null | sed -n '1s/^curl \([0-9.]*\).*/\1/p')"
    for spec in "$@"; do
        site="${spec%%|*}"; s=$(slug "$site")
        [ -f "/var/www/$site/wp-fail2ban-configs.php" ] && say "plugin $site already on" \
            || say "plugin $site OFF: its jails are set up anyway and see nothing until the integration is switched on in GridPane (or live is run with --enable-plugin)"
        for k in h s x; do
            [ -e "/etc/fail2ban/filter.d/$s-$k.conf" ] && say "would_replace=/etc/fail2ban/filter.d/$s-$k.conf" || say "would_create=/etc/fail2ban/filter.d/$s-$k.conf"
        done
    done

    say "--- Fail2Ban's own test of the config with the new files added (a copy, not the live config)"
    if fail2ban-client -c "$T" -t > "$T/.test" 2>&1; then say "config_test=ok"; else say "config_test=FAILED"; fi
    sed 's/^/config_test | /' "$T/.test" | tail -8

    m() { fail2ban-regex "$1" "$2" 2>/dev/null | sed -n 's/^Lines:.* \([0-9][0-9]*\) matched.*/\1/p' | head -1; }
    # Sorted, blank lines dropped: newer plugin builds list the same patterns in
    # another order, and order does not matter.
    pats() { sed -n '/^failregex/,/^ignoreregex/p' "$1" | sed 's/^failregex *= *//; s/^ *//' | grep -v -e '^ignoreregex' -e '^$' | LC_ALL=C sort; }

    say "--- our copy of the patterns against GridPane's (where GridPane's is installed)"
    for b in hard soft extra; do
        g="/etc/fail2ban/filter.d/wordpress-$b.conf"
        if [ ! -f "$g" ]; then say "patterns wordpress-$b gridpane_copy=not-installed-here (nothing to compare)"
        elif [ "$(pats "$g")" = "$(pats "$T/filter.d/__FLEET_JAIL_PREFIX__-base-$b.conf")" ]; then say "patterns wordpress-$b same_as_gridpane=yes ($(pats "$g" | wc -l | tr -d ' ') patterns)"
        else say "patterns wordpress-$b same_as_gridpane=NO PATTERNS-DIFFER"; fi
    done

    # SAMPLE LINES. A server where the plugin is off has no real lines to test
    # against, and on a one-site server "matched no other site's lines" is true
    # of any filter. So every filter is run over made-up lines: this site, its
    # www name, the same name in capitals, with a port and with a trailing dot
    # (all of which reach the site), four lookalikes that only a sloppy pattern
    # would accept, and an unrelated site. It must match its own five and none
    # of the other five, while the un-narrowed pattern matches every one.
    say "--- each new filter run over sample lines (own site, www, capitals, port, trailing dot; four lookalikes, another site)"
    stamp=$(LC_ALL=C date '+%b %e %H:%M:%S'); sample_ok=1
    for spec in "$@"; do
        site="${spec%%|*}"; s=$(slug "$site")
        for k in h s x; do
            case "$k" in (h) base=hard;  msg="Blocked user enumeration attempt from 203.0.113.7" ;;
                         (s) base=soft;  msg="Authentication failure for admin from 203.0.113.7" ;;
                         (x) base=extra; msg="Password reset requested for admin from 203.0.113.7" ;; esac
            : > "$T/.own"; : > "$T/.strays"
            UP=$(printf '%s' "$site" | tr 'a-z' 'A-Z')
            for h in "$site" "www.$site" "$UP" "$site:443" "WWW.$site.:8443"; do say "$stamp box wordpress($h)[4242]: $msg" >> "$T/.own"; done
            for h in "not$site" "$site.invalid" "another-site.invalid" "${site}x" "$site:443.invalid"; do say "$stamp box wordpress($h)[4242]: $msg" >> "$T/.strays"; done
            cat "$T/.own" "$T/.strays" > "$T/.sample"
            own=$(m "$T/.own" "$T/filter.d/$s-$k.conf"); stray=$(m "$T/.strays" "$T/filter.d/$s-$k.conf"); wide=$(m "$T/.sample" "$T/filter.d/__FLEET_JAIL_PREFIX__-base-$base.conf")
            if [ "${own:-x}" = 5 ] && [ "${stray:-x}" = 0 ] && [ "${wide:-x}" = 10 ]; then v=ok; else v=MISMATCH; sample_ok=0; fi
            say "sample $s-$k ($site, wordpress-$base) own_lines_matched=${own:-?}/5 other_sites_matched=${stray:-?}/5 unnarrowed_pattern_matched=${wide:-?}/10 $v"
        done
    done
    [ "$sample_ok" = 1 ] && say "control=ok (every filter matched its own site's sample lines and none of the lookalikes, which the un-narrowed pattern does match)" \
                         || say "control=FAILED (a filter missed its own lines or matched another site's: narrowing is NOT working)"

    say "--- each new filter run over the real auth.log"
    for spec in "$@"; do
        site="${spec%%|*}"; s=$(slug "$site"); pat="wordpress(\(www\.\)\?$(re_escape "$site")\.\?\(:[0-9][0-9]*\)\?)"
        grep -a -i "$pat" "$LOG" > "$T/.only"; grep -a -i -v "$pat" "$LOG" > "$T/.others"
        for k in h s x; do
            case "$k" in (h) base=hard ;; (s) base=soft ;; (x) base=extra ;; esac
            mine=$(m "$LOG" "$T/filter.d/$s-$k.conf")              # new filter, whole log
            want=$(m "$T/.only" "$T/filter.d/__FLEET_JAIL_PREFIX__-base-$base.conf")  # un-narrowed pattern, this site's lines only
            stray=$(m "$T/.others" "$T/filter.d/$s-$k.conf")       # new filter, every OTHER line: must be 0
            all=$(m "$LOG" "$T/filter.d/__FLEET_JAIL_PREFIX__-base-$base.conf")       # un-narrowed pattern, whole log
            if [ -n "$mine" ] && [ "$mine" = "$want" ] && [ "${stray:-x}" = 0 ]; then v=ok; else v=MISMATCH; fi
            say "filter $s-$k ($site, wordpress-$base) matched=${mine:-?} expected=${want:-?} other_sites_lines_matched=${stray:-?} all_sites=${all:-?} $v"
        done
        say "real_lines $site in_log=$(wc -l < "$T/.only" | tr -d ' ')"
    done

    say "--- the files, exactly as they would be written"
    for f in "$T/jail.d/__FLEET_PREFIX__-cloudflare.local" "$T"/filter.d/__FLEET_JAIL_PREFIX__-*-h.conf "$T/filter.d/__FLEET_JAIL_PREFIX__-base-extra.conf"; do
        say "### ${f#$T}"; sed 's/^/    /' "$f"
    done
    say "### /action.d/__FLEET_PREFIX__-cloudflare.conf: $(wc -l < "$T/action.d/__FLEET_PREFIX__-cloudflare.conf" | tr -d ' ') lines, no token inside (checked: $(cat "$T/action.d/__FLEET_PREFIX__-cloudflare.conf" "$T/__FLEET_PREFIX__-cloudflare.sh" | grep -c -E '[A-Za-z0-9_-]{40,}') long secret-shaped strings in it or in the program it runs)"
    say "dry_run_complete=yes"
    exit 0
fi

[ "$MODE" = live ] || { say "stop=unknown mode $MODE"; exit 0; }
[ -n "${CF_TOKEN:-}" ] || { say "stop=no token was sent; nothing was changed"; exit 0; }
API=https://api.cloudflare.com/client/v4
# The token goes to curl on stdin, never on its command line.
cf() { printf 'Authorization: Bearer %s\n' "$CF_TOKEN" | curl -4 -s --max-time 15 -H @- -H "Content-Type: application/json" "$@"; }
jq1() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print('unreadable'); sys.exit()
$1"; }

# 1. Before any file is written: the token must reach every zone, and each zone
#    id must really be the zone we think it is.
for spec in "$@"; do
    site="${spec%%|*}"; rest="${spec#*|}"; zid="${rest%%|*}"; zname="${rest#*|}"
    got=$(cf "$API/zones/$zid" | jq1 "print(d.get('result',{}).get('name') if d.get('success') else 'FAILED codes=%s' % [e.get('code') for e in d.get('errors',[])])")
    [ "$got" = "$zname" ] || { say "stop=token cannot read zone $zname for $site (answer: $got); nothing was changed"; exit 0; }
    say "zone_check $site → $zname ok"
done

# 2. Keep a copy of anything about to be replaced.
BK="/root/__FLEET_PREFIX__-f2b-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK" && chmod 700 "$BK"
for f in /etc/fail2ban/action.d/__FLEET_PREFIX__-cloudflare.conf /etc/fail2ban/jail.d/__FLEET_PREFIX__-cloudflare.local "$TOKEN_FILE" "$HELPER_FILE" /etc/fail2ban/filter.d/__FLEET_JAIL_PREFIX__-*.conf; do
    [ -e "$f" ] && cp -a "$f" "$BK/" && say "backed_up=$f"
done
say "backup_dir=$BK"
undo() {
    rm -f /etc/fail2ban/action.d/__FLEET_PREFIX__-cloudflare.conf /etc/fail2ban/jail.d/__FLEET_PREFIX__-cloudflare.local "$TOKEN_FILE" "$HELPER_FILE" /etc/fail2ban/filter.d/__FLEET_JAIL_PREFIX__-*.conf
    for f in "$BK"/*; do
        [ -e "$f" ] || continue
        case "$(basename "$f")" in
          (__FLEET_PREFIX__-cloudflare.conf)  cp -a "$f" /etc/fail2ban/action.d/ ;;
          (__FLEET_PREFIX__-cloudflare.local) cp -a "$f" /etc/fail2ban/jail.d/ ;;
          (__FLEET_PREFIX__-cloudflare.token|__FLEET_PREFIX__-cloudflare.sh) cp -a "$f" /etc/fail2ban/ ;;
          (__FLEET_JAIL_PREFIX__-*.conf)                  cp -a "$f" /etc/fail2ban/filter.d/ ;;
        esac
    done
}

# 3. The plugin. Left as it is unless ENABLE_PLUGIN=1 was sent.
for spec in "$@"; do
    site="${spec%%|*}"
    if [ -f "/var/www/$site/wp-fail2ban-configs.php" ]; then say "plugin $site already on"
    elif [ "${ENABLE_PLUGIN:-0}" != 1 ]; then say "plugin $site OFF, left off: its jails are in place and start working when the integration is switched on in GridPane"
    else
        gp site "$site" -enable-wp-fail2ban > "$BK/gp-$site.log" 2>&1
        [ -f "/var/www/$site/wp-fail2ban-configs.php" ] && say "plugin $site ENABLED" || say "plugin $site ENABLE FAILED (see $BK/gp-$site.log); its jails will simply see no lines"
    fi
done

# 4. Write the files, test, and only then reload.
rm -f /etc/fail2ban/filter.d/__FLEET_JAIL_PREFIX__-*.conf
generate /etc/fail2ban "$@"
chown root:root "$HELPER_FILE"; say "helper_file=$(stat -c '%U:%G %a' "$HELPER_FILE")"
( umask 077; printf '%s' "$CF_TOKEN" > "$TOKEN_FILE" ); chown root:root "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
say "token_file=$(stat -c '%U:%G %a' "$TOKEN_FILE") length=$(wc -c < "$TOKEN_FILE" | tr -d ' ')"
if ! fail2ban-client -t > "$BK/config-test.log" 2>&1; then
    undo; say "config_test=FAILED — every file was put back, Fail2Ban was NOT reloaded"
    tail -5 "$BK/config-test.log" | sed 's/^/config_test | /'; exit 0
fi
say "config_test=ok"
if ! fail2ban-client reload > "$BK/reload.log" 2>&1; then
    undo; fail2ban-client reload > /dev/null 2>&1
    say "reload=FAILED — files put back and Fail2Ban reloaded on the old config"; tail -5 "$BK/reload.log" | sed 's/^/reload | /'; exit 0
fi
say "reload=ok"

# 5. Every jail must be running with both actions.
sleep 3; missing=0; first=""
for spec in "$@"; do
    site="${spec%%|*}"; s=$(slug "$site")
    for k in h s x; do
        acts=$(fail2ban-client get "$s-$k" actions 2>/dev/null | tail -1 | tr -d ' ')
        case "$acts" in (*__FLEET_PREFIX__-cloudflare*iptables-allports*|*iptables-allports*__FLEET_PREFIX__-cloudflare*) say "jail $s-$k running actions=$acts" ;;
          (*) say "jail $s-$k NOT RUNNING AS EXPECTED actions=${acts:-none}"; missing=1 ;; esac
        # It must be reading the FILE. Under the systemd backend logpath is ignored.
        fail2ban-client get "$s-$k" logpath 2>/dev/null | grep -q '/var/log/auth.log' || { say "jail $s-$k IS NOT READING /var/log/auth.log"; missing=1; }
    done
    [ -n "$first" ] || first="$spec"
done
say "gridpane_jails_still_running=$(fail2ban-client status | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' '\n' | grep -c 'wordpress-')"
[ "$missing" = 0 ] && say "jails_reading_auth_log=yes"
[ "$missing" = 0 ] || { say "proof=SKIPPED (a jail is not running, or not reading the log)"; say "live_complete=no"; exit 0; }

# 6. The proof, end to end and with the plugin on or off: write ONE line into
#    the log the way the plugin would (same tag, same wording, a documentation-
#    only address), and watch Fail2Ban read it, ban, and put the rule in THAT
#    site's zone. Then unban and see it gone. If the log line does not trigger
#    the ban within 30 seconds, ban by hand so the Cloudflare half is still
#    tested, and say plainly that the log half failed.
site="${first%%|*}"; rest="${first#*|}"; zid="${rest%%|*}"; J="$(slug "$site")-h"; TEST=203.0.113.45
look() { cf -G "$API/zones/$zid/firewall/access_rules/rules" --data-urlencode "configuration.value=$TEST" --data-urlencode "per_page=20" \
    | jq1 "r=[x for x in (d.get('result') or []) if x['configuration'].get('value')=='$TEST']
o=[x for x in r if (x.get('notes') or '')=='__FLEET_BRAND__ Fail2Ban $J']
print('count=%d scopes=%s other_rules_for_this_address=%d' % (len(o), sorted({x['scope']['type'] for x in o}), len(r)-len(o)))"; }
banned() { fail2ban-client status "$J" 2>/dev/null | grep -c "$TEST"; }
say "proof_before $(look)"
logger -i -p auth.notice -t "wordpress($site)" "Blocked user enumeration attempt from $TEST"
trigger=none; i=0
while [ "$i" -lt 30 ]; do [ "$(banned)" -ge 1 ] && { trigger=log; break; }; sleep 1; i=$((i + 1)); done
say "proof_line_in_auth_log=$(grep -a -c "wordpress($site).*Blocked user enumeration attempt from $TEST" /var/log/auth.log)"
if [ "$trigger" = none ]; then fail2ban-client set "$J" banip "$TEST" > /dev/null 2>&1; trigger=by-hand; fi
say "proof_trigger=$trigger"; sleep 4
say "proof_banned_in_fail2ban=$(banned)"
say "proof_banned_in_local_firewall=$(iptables -S 2>/dev/null | grep -c "$TEST")"
say "proof_after_ban $(look)"
say "proof_also_banned_by=$(for j in $(fail2ban-client status | sed -n 's/.*Jail list:[[:space:]]*//p' | tr -d ','); do [ "$j" != "$J" ] && fail2ban-client status "$j" 2>/dev/null | grep -q "$TEST" && printf '%s ' "$j"; done)"
fail2ban-client unban "$TEST" > /dev/null 2>&1; sleep 4       # every jail, GridPane's too if its own caught the line
say "proof_after_unban $(look)"
say "proof_left_in_fail2ban=$(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr -d ',' | tr ' ' '\n' | while read -r j; do [ -n "$j" ] && fail2ban-client status "$j" | grep -c "$TEST"; done | awk '{n+=$1} END{print n+0}') left_in_local_firewall=$(iptables -S 2>/dev/null | grep -c "$TEST")"

# 6b. The same line again, logged the way it is when the request names the site
#     in capitals and with a port. The site's jail must still read it.
ODD="$(printf '%s' "$site" | tr 'a-z' 'A-Z'):443"
logger -i -p auth.notice -t "wordpress($ODD)" "Blocked user enumeration attempt from $TEST"
i=0; odd=0; while [ "$i" -lt 30 ]; do [ "$(banned)" -ge 1 ] && { odd=1; break; }; sleep 1; i=$((i + 1)); done
say "oddhost_line_banned=$odd"
fail2ban-client unban "$TEST" > /dev/null 2>&1; sleep 4
say "oddhost_after_unban $(look)"

# 7. The overlap proof. Two jails ban the same address into the same zone, then
#    the SHORT one lets go. The rule must stay until the long one lets go too.
#    (Before 2026-11-18 the short jail's unban deleted the only rule.)
S="$(slug "$site")-s"; HF="$HOLDERS/$zid/$TEST"
rules() { cf -G "$API/zones/$zid/firewall/access_rules/rules" --data-urlencode "configuration.value=$TEST" --data-urlencode "per_page=20" \
    | jq1 "print(len([x for x in (d.get('result') or []) if x['configuration'].get('value')=='$TEST' and (x.get('notes') or '').startswith('__FLEET_BRAND__ Fail2Ban ')]))"; }
holders() { [ -f "$HF" ] && awk '{printf "%s%s", s, $1; s=","} END {if (!NR) printf "none"}' "$HF" || printf absent; }
fail2ban-client set "$J" banip "$TEST" > /dev/null 2>&1; sleep 3
fail2ban-client set "$S" banip "$TEST" > /dev/null 2>&1; sleep 3
say "overlap_both_banned rules=$(rules) holders=$(holders)"
fail2ban-client set "$J" unbanip "$TEST" > /dev/null 2>&1; sleep 4
say "overlap_after_short_unban rules=$(rules) holders=$(holders) still_banned_in_long_jail=$(fail2ban-client status "$S" 2>/dev/null | grep -c "$TEST")"
fail2ban-client set "$S" unbanip "$TEST" > /dev/null 2>&1; sleep 4
fail2ban-client unban "$TEST" > /dev/null 2>&1
say "overlap_after_long_unban rules=$(rules) holders=$(holders) left_in_local_firewall=$(iptables -S 2>/dev/null | grep -c "$TEST")"
grep -a "__FLEET_PREFIX__-cloudflare\|$J" /var/log/fail2ban.log 2>/dev/null | grep -E ' (ERROR|WARNING|CRITICAL) ' | tail -3 | sed -E 's/[A-Za-z0-9_-]{40,}/<masked>/g; s/^/f2b_log_error | /'
say "live_complete=yes"
