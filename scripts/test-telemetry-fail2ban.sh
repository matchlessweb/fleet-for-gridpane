#!/bin/bash
# Runs the Fail2Ban section of telemetry-agent.sh against a made-up server on
# this machine and checks what it reports. Nothing is sent anywhere: only the
# python part between the "fail2ban report" markers is run, and its output read.
# Run: bash scripts/test-telemetry-fail2ban.sh
#
# Every address below is from the documentation ranges (203.0.113.0/24,
# 198.51.100.0/24, 2001:db8::/32). No real address or log line belongs here.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$HERE/telemetry-agent.sh"
T=$(mktemp -d) || exit 1
trap 'rm -rf "${T:?}"' EXIT
W="$T/server"                                        # the made-up server's root
TOKEN="cfTESTtoken_0123456789abcdefghijABCDEFGHIJ"   # token-shaped, not real
ZONE="0a1b2c0a1b2c0a1b2c0a1b2c0a1b2c0a"                # zone-id-shaped, not real
fail=0; ran=0
t() { ran=$((ran + 1)); if [ "$2" = "1" ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }

# The agent in the repository holds placeholders for the names it looks for on a
# server. Fill them in as the installer does (lib-fleet-names.sh): the names come
# from fleet.config.ts, or from the environment.
. "$HERE/lib-fleet-names.sh"
fleet_names_fill < "$AGENT" > "$T/agent.sh"; AGENT="$T/agent.sh"

sed -n '/^# --- fail2ban report: begin/,/^# --- fail2ban report: end/p' "$AGENT" > "$T/report.py"
[ -s "$T/report.py" ] || { echo "FAIL: could not find the report section in $AGENT"; exit 1; }

slug() { printf '%s-%s-%s' "$FLEET_JAIL_PREFIX" "$(printf '%s' "$1" | tr -cd 'a-z0-9' | cut -c1-"$FLEET_JAIL_SITE_CHARS")" "$(printf '%s' "$1" | { md5sum 2>/dev/null || md5; } | cut -c1-4)"; }
GOOD=$(slug good.example); OFF=$(slug off.example); GONE=$(slug gone.example)

# ── the made-up server ───────────────────────────────────────────────────────
mkdir -p "$W/etc/fail2ban/action.d" "$W/etc/fail2ban/jail.d" "$W/var/log" "$T/bin"
printf '%s' "$TOKEN" > "$W/etc/fail2ban/$FLEET_PREFIX-cloudflare.token"
printf '[Init]\ncftoken = %s\n' "$TOKEN" > "$W/etc/fail2ban/action.d/gpcloudflare.conf"
J="$W/etc/fail2ban/jail.d/$FLEET_PREFIX-cloudflare.local"; : > "$J"
for site in good.example off.example down.example gone.example; do
    for k in h s x; do
        printf '\n[%s-%s]\n# %s — wordpress-x\nenabled = true\nlogpath = /var/log/auth.log\naction = %s-cloudflare[cfzone=%s]\n         iptables-allports[name=x]\n' \
            "$(slug $site)" "$k" "$site" "$FLEET_PREFIX" "$ZONE" >> "$J"
    done
done
mk() { mkdir -p "$W/var/www/$1/htdocs/wp-content/mu-plugins" "$W/var/www/$1/htdocs/wp-content/plugins"; echo "<?php" > "$W/var/www/$1/wp-config.php"; }
on() {
    mkdir -p "$W/var/www/$1/htdocs/wp-content/plugins/wp-fail2ban"
    echo "<?php" > "$W/var/www/$1/htdocs/wp-content/plugins/wp-fail2ban/wp-fail2ban.php"
    ln -s "$W/var/www/$1/htdocs/wp-content/plugins/wp-fail2ban/wp-fail2ban.php" "$W/var/www/$1/htdocs/wp-content/mu-plugins/wp-fail2ban.php"
    echo "<?php" > "$W/var/www/$1/wp-fail2ban-configs.php"
    echo "include __DIR__ . '/wp-fail2ban-configs.php';" >> "$W/var/www/$1/wp-config.php"
}
mk good.example; on good.example
mk off.example; echo "include __DIR__ . '/wp-fail2ban-configs.php';" >> "$W/var/www/off.example/wp-config.php"   # GridPane leaves the line on untouched sites
mk down.example; on down.example            # jails configured, but not running
mk nozone.example; on nozone.example        # plugin on, no jails of its own
mk commented.example; on commented.example
printf '<?php\n// include __DIR__ . "/wp-fail2ban-configs.php";\n' > "$W/var/www/commented.example/wp-config.php"
mkdir -p "$W/var/www/notwordpress.example/htdocs"

NOWS=$(LC_ALL=C date '+%b %e %H:%M:%S'); ISO=$(date -u '+%Y-%m-%dT%H:%M:%S.000000+00:00')
{
    echo "Jan  1 00:00:01 box wordpress(good.example)[1]: Authentication failure for old from 203.0.113.1"
    i=0; while [ $i -lt 60 ]; do echo "$NOWS box wordpress(good.example)[2]: Authentication failure for u$i from 203.0.113.9"; i=$((i + 1)); done
    echo "$NOWS box wordpress(www.good.example)[3]: Accepted password for editor from 203.0.113.50"
    echo "$NOWS box wp(good.example)[4]: Blocked user enumeration attempt from 203.0.113.9"
    printf '%s box wordpress(good.example)[5]: Comment "quoted\\back" tab\there from 203.0.113.9\n' "$ISO"
    echo "$NOWS box wordpress(notgood.example)[6]: Authentication failure for x from 203.0.113.77"
    echo "$NOWS box sshd[7]: Failed password for root from 198.51.100.7 port 22"
} > "$W/var/log/auth.log"

# A stand-in fail2ban-client. Its answers are shaped like the real program's.
status_of() { printf 'Status for the jail: x\n|- Filter\n|  |- Currently failed:\t%s\n|  |- Total failed:\t%s\n|  `- %s\n`- Actions\n   |- Currently banned:\t%s\n   |- Total banned:\t%s\n   `- Banned IP list:\t%s\n' "$@"; }
{
    echo '#!/bin/bash'
    echo "[ -f \"$T/f2b-down\" ] && exit 1"
    echo 'case "$*" in'
    echo '  ping) echo "Server replied: pong" ;; version) echo "0.11.2" ;;'
    echo "  status) printf 'Status\n|- Number of jail:\t9\n\`- Jail list:\t$GOOD-h, $GOOD-s, $GOOD-x, $OFF-h, $OFF-s, $OFF-x, $GONE-h, sshd, wordpress-hard\n' ;;"
    echo "  \"status $GOOD-h\") cat \"$T/st-good-h\" ;;"
    echo "  \"status $GOOD-x\") cat \"$T/st-good-x\" ;;"
    echo "  \"status wordpress-hard\") cat \"$T/st-gp\" ;;"
    echo "  \"status \"*) cat \"$T/st-quiet\" ;;"
    echo "  \"get $GOOD-h banip --with-time\") cat \"$T/bans-good-h\" ;;"
    echo '  "get "*" banip --with-time") exit 1 ;;     # an older Fail2Ban without the option'
    echo "  \"get $GOOD-s actions\") printf 'The jail has been started with the following actions:\niptables-allports\n' ;;"
    echo "  \"get wordpress-hard actions\") printf 'The jail has been started with the following actions:\ngpcloudflare, iptables-allports\n' ;;"
    echo "  \"get sshd actions\") printf 'The jail has been started with the following actions:\niptables-multiport\n' ;;"
    echo "  \"get \"*\" actions\") printf 'The jail has been started with the following actions:\n$FLEET_PREFIX-cloudflare, iptables-allports\n' ;;"
    echo 'esac'
} > "$T/bin/fail2ban-client"
chmod +x "$T/bin/fail2ban-client"
status_of 2 61 "File list:	/var/log/auth.log" 2 7 "203.0.113.45 2001:db8::1" > "$T/st-good-h"
status_of 0 0 "Journal matches:	" 0 0 "" > "$T/st-good-x"
status_of 0 9 "File list:	/var/log/auth.log" 1 3 "198.51.100.20" > "$T/st-gp"
status_of 0 0 "File list:	/var/log/auth.log" 0 0 "" > "$T/st-quiet"
printf '203.0.113.45 \t2026-11-13 10:00:00 + 600 = 2026-11-13 10:10:00\n2001:db8::1 \t2026-11-13 10:01:00 + 600 = 2026-11-13 10:11:00\n' > "$T/bans-good-h"

run() { PATH="$T/bin:$PATH" F2B_ROOT="$W" TZ=UTC python3 "$T/report.py" > "$T/out.json" 2> "$T/err"; echo $? > "$T/rc"; }
# q <python expression>: 1 when it is true of the report, 0 when false or when it errors.
# No {a,b} literals in an expression: bash 3.2 brace-expands them even inside "$( )".
q() {
    Q_EXPR="$1" python3 - "$T/out.json" <<'PY' 2>/dev/null || echo 0
import json, os, re, sys
d = json.load(open(sys.argv[1])); S = {s["site"]: s for s in d["sites"]}
J = lambda site, kind: [j for j in S[site]["jails"] if j["kind"] == kind][0]
print(1 if eval(os.environ["Q_EXPR"]) else 0)
PY
}

run
echo "builds a report:"
t "finishes and writes valid JSON"                        "$([ "$(cat "$T/rc")" = 0 ] && q "True")"
t "five WordPress folders, the non-WordPress one skipped" "$(q "sorted(S)==['commented.example','down.example','good.example','nozone.example','off.example']")"
t "Fail2Ban present, running, version read"               "$(q "(d['fail2ban']['present'], d['fail2ban']['running'], d['fail2ban']['version'])==(True, True, '0.11.2')")"
t "CONTROL: a false statement about the report fails"     "$([ "$(q "len(S)==99")" = 0 ] && echo 1 || echo 0)"

echo "plugin state, as the audit reads it:"
t "must-use link + settings = mu, include live"           "$(q "S['good.example']['plugin']=='mu' and S['good.example']['included'] is True")"
t "no plugin, no settings = off (the include line alone proves nothing)" "$(q "S['off.example']['plugin']=='off' and S['off.example']['configs'] is False and S['off.example']['included'] is True")"
t "a commented-out include is not live"                   "$(q "S['commented.example']['included'] is False and S['commented.example']['plugin']=='mu'")"

echo "jails:"
t "three jails for a set-up site, each with its zone"     "$(q "[j['kind'] for j in S['good.example']['jails']]==['h','s','x'] and all(j['cfzone']=='$ZONE' and j['configured'] for j in S['good.example']['jails'])")"
t "counters read from the jail"                           "$(q "(J('good.example','h')['failed_now'],J('good.example','h')['failed_total'],J('good.example','h')['banned_now'],J('good.example','h')['banned_total'])==(2,61,2,7)")"
t "both actions seen on a healthy jail"                   "$(q "J('good.example','h')['actions']==['$FLEET_PREFIX-cloudflare','iptables-allports']")"
t "a jail missing the Cloudflare action says so"          "$(q "J('good.example','s')['actions']==['iptables-allports']")"
t "a jail reading the journal is not reading auth.log"    "$(q "J('good.example','x')['reads_auth_log'] is False and J('good.example','h')['reads_auth_log'] is True")"
t "configured but not running is reported as not running" "$(q "len(S['down.example']['jails'])==3 and not any(j['running'] for j in S['down.example']['jails']) and all(j['configured'] for j in S['down.example']['jails'])")"
t "a site with no jails of its own has none"              "$(q "S['nozone.example']['jails']==[]")"
t "a plugin-off site still has its three running jails"   "$(q "len(S['off.example']['jails'])==3 and all(j['running'] for j in S['off.example']['jails'])")"

echo "bans:"
t "banned addresses with jail, start and end in UTC"      "$(q "[(b['ip'], b['jail'], b['at'], b['until']) for b in S['good.example']['bans']]==[('203.0.113.45', '$GOOD-h', '2026-11-13T10:00:00Z', '2026-11-13T10:10:00Z'), ('2001:db8::1', '$GOOD-h', '2026-11-13T10:01:00Z', '2026-11-13T10:11:00Z')]")"
t "GridPane's own jails are apart from any site's"        "$(q "sorted(j['name'] for j in d['server_jails'])==['sshd','wordpress-hard'] and not any('wordpress-hard' in str(s['jails']) for s in d['sites'])")"
t "a ban with no time (older Fail2Ban) keeps the address" "$(q "[(b['ip'], b['jail'], b['at'], b['until']) for j in d['server_jails'] if j['name']=='wordpress-hard' for b in j['bans']]==[('198.51.100.20', 'wordpress-hard', None, None)]")"
t "a jail of ours with no site folder is an orphan"       "$(q "[(o['name'], o['running'], o['site']) for o in d['orphan_jails']]==[('$GONE-h', True, 'gone.example'), ('$GONE-s', False, 'gone.example'), ('$GONE-x', False, 'gone.example')]")"

echo "log lines:"
t "at most 50 lines a site, newest first"                 "$(q "len(S['good.example']['log'])==50 and 'quoted' in S['good.example']['log'][0]['m'] and S['good.example']['log'][1]['m'].startswith('Blocked user enumeration')")"
t "www. and the wp() tag count as the site"               "$(q "any(l['m'].startswith('Accepted password') for l in S['good.example']['log']) and any(l['m'].startswith('Blocked user') for l in S['good.example']['log'])")"
t "24-hour count leaves out sign-ins and old lines"       "$(q "S['good.example']['log_24h']==62")"
t "a lookalike site's lines are not this site's"          "$(q "not any('203.0.113.77' in l['m'] for s in d['sites'] for l in s['log'])")"
t "quotes, backslashes and tabs survive as valid JSON"    "$(q "S['good.example']['log'][0]['m']=='Comment \"quoted'+chr(92)+'back\" tab here from 203.0.113.9'")"
t "both timestamp styles give a UTC time"                 "$(q "all(re.match(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\$', l['t']) for l in S['good.example']['log'][:3])")"
t "a quiet site reports no lines, and is not an error"    "$(q "S['nozone.example']['log']==[] and S['nozone.example']['log_24h']==0")"
t "ssh lines are not WordPress lines"                     "$(grep -q '198.51.100.7' "$T/out.json" && echo 0 || echo 1)"

echo "never reads a credential:"
t "token file and the old GridPane file reported present" "$(q "d['token_file'] is True and d['gpcloudflare_conf'] is True")"
t "the planted token is not in the report"                "$(grep -q "$TOKEN" "$T/out.json" && echo 0 || echo 1)"
t "CONTROL: the detector finds the token in the fixture"  "$(grep -rq "$TOKEN" "$W/etc/fail2ban" && echo 1 || echo 0)"
t "the section never opens the token file"                "$(grep "$FLEET_PREFIX-cloudflare.token" "$T/report.py" | grep -q 'open(' && echo 0 || echo 1)"

echo "when things are missing:"
mv "$W/etc/fail2ban/$FLEET_PREFIX-cloudflare.token" "$T/token.aside"; : > "$W/etc/fail2ban/$FLEET_PREFIX-cloudflare.token"
mv "$W/etc/fail2ban/action.d/gpcloudflare.conf" "$T/gp.aside"; run
t "an empty token file counts as missing"                 "$(q "d['token_file'] is False and d['gpcloudflare_conf'] is False")"
touch "$T/f2b-down"; run
t "Fail2Ban stopped: still reports, every jail not running" "$(q "d['fail2ban']['running'] is False and len(S['good.example']['jails'])==3 and not any(j['running'] for j in S['good.example']['jails']) and d['server_jails']==[]")"
mv "$T/f2b-down" "$T/f2b-up"; mv "$W/var/log/auth.log" "$T/auth.aside"; run
t "no auth.log: says unreadable, sites still listed"      "$(q "d['auth_log'] is False and len(S)==5")"

echo "the wrapper in the agent:"
t "one Fail2Ban POST, to report_fail2ban"                 "$([ "$(grep -c 'rest/v1/rpc/report_fail2ban' "$AGENT")" = 1 ] && echo 1 || echo 0)"
t "still exactly one telemetry POST"                      "$([ "$(grep -c 'rest/v1/rpc/report_telemetry' "$AGENT")" = 1 ] && echo 1 || echo 0)"
t "the report goes on stdin, not as an argument"          "$(grep -q -- '--data-binary @-' "$AGENT" && echo 1 || echo 0)"
t "the temp file is removed"                              "$(grep -q 'rm -f "$F2B_TMP"' "$AGENT" && echo 1 || echo 0)"
t "the agent parses under this machine's bash"            "$(bash -n "$AGENT" 2>/dev/null && echo 1 || echo 0)"

echo
[ "$fail" = 0 ] && echo "all $ran checks passed" || { echo "FAILED ($ran checks run). stderr of the last run:"; sed 's/^/    /' "$T/err"; exit 1; }
