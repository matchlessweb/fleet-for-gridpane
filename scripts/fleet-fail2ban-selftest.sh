#!/bin/bash
# Runs the server-side audit program against a made-up server on this machine
# and checks two things: it reads each state correctly, and it never prints a
# token. Run: bash scripts/fleet-fail2ban-selftest.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
TOKEN="cfTESTtoken_0123456789abcdefghijABCDEFGHIJ"   # 42 chars, token-shaped, not real
ZONE="0a1b2c0a1b2c0a1b2c0a1b2c0a1b2c0a"   # zone-id-shaped, not real
# The names under test come from fleet.config.ts, or from the environment.
. "$HERE/lib-fleet-names.sh"
P="$FLEET_PREFIX"; J="$FLEET_JAIL_PREFIX"; B="$FLEET_BRAND"
fail=0; ran=0
t() { ran=$((ran + 1)); if [ "$2" = "1" ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
has() { grep -q -- "$1" "$T/out" && echo 1 || echo 0; }

mkdir -p "$T/etc/fail2ban/action.d" "$T/etc/fail2ban/jail.d" "$T/etc/fail2ban/filter.d" "$T/var/log" "$T/bin"
cat > "$T/etc/fail2ban/action.d/gpcloudflare.conf" <<C
[Definition]
_cf_api_url = https://api.cloudflare.com/client/v4/zones/<cfzone>/firewall/access_rules/rules
_cf_api_prms = -H 'Authorization: Bearer <cftoken>' -H 'Content-Type: application/json'
[Init]
cftoken = $TOKEN
cfzone = $ZONE
C
cat > "$T/etc/fail2ban/jail.local" <<C
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1
[wordpress-hard]
enabled = true
logpath = /var/log/auth.log
action = gpcloudflare[cftoken=$TOKEN]
    iptables-allports
C
printf '[Definition]\nfailregex = ^%%(__prefix_line)sBlocked user enumeration attempt from <HOST>$\n' > "$T/etc/fail2ban/filter.d/wordpress-hard.conf"
printf 'Nov 12 01:02:03 box wordpress(good.example)[123]: Authentication failure for admin from 203.0.113.9\nNov 12 01:02:04 box wordpress(good.example)[124]: Blocked user enumeration attempt from 203.0.113.9\n' > "$T/var/log/auth.log"

mk() { mkdir -p "$T/var/www/$1/htdocs/wp-content/mu-plugins" "$T/var/www/$1/htdocs/wp-content/plugins"; echo "<?php" > "$T/var/www/$1/wp-config.php"; }
mk good.example
mkdir "$T/var/www/good.example/htdocs/wp-content/plugins/wp-fail2ban"; echo "<?php" > "$T/var/www/good.example/htdocs/wp-content/plugins/wp-fail2ban/wp-fail2ban.php"
ln -s "$T/var/www/good.example/htdocs/wp-content/plugins/wp-fail2ban/wp-fail2ban.php" "$T/var/www/good.example/htdocs/wp-content/mu-plugins/wp-fail2ban.php"
echo "<?php define('WP_FAIL2BAN_BLOCK_USER_ENUMERATION', true);" > "$T/var/www/good.example/wp-fail2ban-configs.php"
echo "include __DIR__ . '/wp-fail2ban-configs.php';" >> "$T/var/www/good.example/wp-config.php"
mk off.example
echo "include __DIR__ . '/wp-fail2ban-configs.php';" >> "$T/var/www/off.example/wp-config.php"   # GridPane leaves this line on untouched sites
mk dangling.example      # the rivervalley case: the link is there, the plugin is gone
ln -s "$T/nowhere/wp-fail2ban.php" "$T/var/www/dangling.example/htdocs/wp-content/mu-plugins/wp-fail2ban.php"
mk asplugin.example      # no must-use link; installed as an ordinary plugin
mkdir "$T/var/www/asplugin.example/htdocs/wp-content/plugins/wp-fail2ban"
echo "<?php" > "$T/var/www/asplugin.example/wp-fail2ban-configs.php"
mk orphan.example        # settings file left behind, plugin folder gone
echo "<?php" > "$T/var/www/orphan.example/wp-fail2ban-configs.php"
mkdir -p "$T/var/www/notwordpress.example/htdocs"

# A stand-in fail2ban-client, so the jail section runs here too.
cat > "$T/bin/fail2ban-client" <<'C'
#!/bin/bash
case "$*" in
  version) echo "0.11.2" ;; ping) echo pong ;;
  status) printf 'Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, wordpress-hard\n' ;;
  "status "*) printf '   |- Currently banned:\t3\n' ;;
  "get "*" actions") printf 'The jail has been started with the following actions:\ngpcloudflare, iptables-allports\n' ;;
  "get "*) echo 600 ;;
esac
C
chmod +x "$T/bin/fail2ban-client"

PATH="$T/bin:$PATH" F2B_AUDIT_ROOT="$T" bash "$HERE/fleet-fail2ban-audit.remote.sh" > "$T/out" 2>&1

echo "reads each state:"
t "finishes (audit_complete=yes is the last line)"  "$([ "$(tail -1 "$T/out")" = "audit_complete=yes" ] && echo 1 || echo 0)"
t "a site with all four pieces is 'on'"             "$(has '^site=good.example verdict=on-mu logged=2 ')"
t "a site with none is 'off'"                       "$(has '^site=off.example verdict=off ')"
t "a dangling plugin link is BROKEN, not on"        "$(has '^site=dangling.example verdict=BROKEN logged=0 mu_plugin=dangling')"
t "no link but plugin + settings is on-plugin"      "$(has '^site=asplugin.example verdict=on-plugin logged=0 ')"
t "settings with no plugin folder is BROKEN"        "$(has '^site=orphan.example verdict=BROKEN ')"
t "a folder without WordPress is not counted"       "$(has '^wordpress_sites=5$')"
t "reads the jail list and its actions"             "$(has '^jail=wordpress-hard .*actions=gpcloudflare,iptables-allports')"
t "sees the token action as bearer + zone endpoint" "$([ "$(has '^gpcloudflare_auth=bearer_token')" = 1 ] && [ "$(has '^gpcloudflare_endpoint=zone')" = 1 ] && echo 1 || echo 0)"
t "names the site a log line is about"              "$(has '^authlog_site wordpress(good.example) lines=2')"
t "blanks addresses in the sample log line"         "$(grep '^authlog_sample' "$T/out" | grep -q '203.0.113' && echo 0 || echo 1)"
t "leaves the timestamp in the sample alone"        "$(has '^authlog_sample Nov 12 01:02:04 ')"

echo "never prints a credential:"
t "the planted token is not in the output"          "$(grep -q "$TOKEN" "$T/out" && echo 0 || echo 1)"
t "the planted zone id is not in the output"        "$(grep -q "$ZONE" "$T/out" && echo 0 || echo 1)"
# Long runs that contain a digit: tokens and ids have one, this script's own
# setting names and WordPress constant names (also 20+ characters) do not.
t "no long run containing a digit survives"         "$(grep -E -o '[A-Za-z0-9_-]{20,}' "$T/out" | grep -q '[0-9]' && echo 0 || echo 1)"
# Control: the same two detectors must FIRE on the fixture's own config file,
# or a pass above means nothing.
t "CONTROL — the detector finds the token in the fixture file" "$(grep -q "$TOKEN" "$T/etc/fail2ban/jail.local" && grep -E -o '[A-Za-z0-9_-]{20,}' "$T/etc/fail2ban/action.d/gpcloudflare.conf" | grep -q '[0-9]' && echo 1 || echo 0)"
t "the jail.local action line was read (masked), so masking had something to do" "$(has '^jail_local \[wordpress-hard\].*gpcloudflare\[cftoken=<masked>\]')"

# ── the setup program's file generation (no Fail2Ban needed for this part) ──
G="$T/gen"; mkdir -p "$G/etc/fail2ban/action.d" "$G/etc/fail2ban/jail.d" "$G/etc/fail2ban/filter.d"
fleet_names_script "$HERE/fleet-fail2ban-apply.remote.sh" > "$T/apply.remote.sh" || exit 1
F2B_ROOT="$G" bash "$T/apply.remote.sh" generate "shop.example.com|$ZONE|example.com" "other.example|${ZONE}|other.example" > "$T/genout" 2>&1
JL="$G/etc/fail2ban/jail.d/$P-cloudflare.local"; FD="$G/etc/fail2ban/filter.d"
daemon_ok() {  # $1 = filter file, $2 = site. The site and www match; lookalikes and a dot-swapped name do not.
python3 - "$1" "$2" <<'PY'
import re,sys
d=[l.split('=',1)[1].strip() for l in open(sys.argv[1]) if l.startswith('_daemon')][0]; site=sys.argv[2]
r=re.compile(d); f=lambda h: bool(r.fullmatch('wordpress(%s)'%h))
good=f(site) and f('www.'+site) and f(site.upper()) and f(site+':443') and f(site+'.') and f('WWW.'+site+'.:8443')
bad=f('not'+site) or f(site+'.invalid') or f('another-site.invalid') or f(site.replace('.','x')) \
    or f(site+'x') or f(site+':443.invalid') or f(site+':') or f(site+'..') or f('wwwx'+site)
print(1 if good and not bad else 0)
PY
}
echo "writes the right files:"
t "generation finishes"                                     "$(grep -q '^generated=yes$' "$T/genout" && echo 1 || echo 0)"
t "six jails for two sites"                                 "$([ "$(grep -c "^\[$J-" "$JL")" = 6 ] && echo 1 || echo 0)"
t "every jail reads the file (backend = polling)"           "$([ "$(grep -c '^backend = polling$' "$JL")" = 6 ] && echo 1 || echo 0)"
t "every jail bans in a zone and in the local firewall"     "$([ "$(grep -c "$P-cloudflare\[cfzone=$ZONE\]" "$JL")" = 6 ] && [ "$(grep -c "iptables-allports\[name=$J-" "$JL")" = 6 ] && echo 1 || echo 0)"
t "the patterns are carried here (three base files)"        "$([ "$(ls "$FD"/$J-base-*.conf | wc -l | tr -d ' ')" = 3 ] && grep -q 'Blocked user enumeration attempt from <HOST>' "$FD/$J-base-hard.conf" && echo 1 || echo 0)"
t "no site filter depends on a GridPane file"               "$(grep -l 'before = wordpress-' "$FD"/$J-*.conf > /dev/null 2>&1 && echo 0 || echo 1)"
t "every site filter includes our base file"                "$([ "$(grep -l "^before = $J-base-" "$FD"/$J-*-[hsx].conf | wc -l | tr -d ' ')" = 6 ] && echo 1 || echo 0)"
SF=$(grep -l 'shop\\.example\\.com' "$FD"/$J-*-h.conf | head -1)
t "a site filter accepts its own site (www, capitals, port, trailing dot) and no lookalike"         "$(daemon_ok "$SF" shop.example.com)"
printf '[Definition]\n_daemon = (?:wordpress|wp)(?:\\([^\\s)]+\\))?\n' > "$T/loose.conf"
printf '[Definition]\n_daemon = (?:wordpress|wp)\\((?:www\\.)?shop\\.example\\.com\\)\n' > "$T/strict.conf"
t "CONTROL — the same check rejects the old filter, which missed capitals and ports" "$([ "$(daemon_ok "$T/strict.conf" shop.example.com)" = 0 ] && echo 1 || echo 0)"
t "CONTROL — the same check rejects a filter that accepts any site" "$([ "$(daemon_ok "$T/loose.conf" shop.example.com)" = 0 ] && echo 1 || echo 0)"
t "no token-shaped string in any generated file"            "$(grep -r -E -o '[A-Za-z0-9_-]{40,}' "$G/etc/fail2ban" | grep -q . && echo 0 || echo 1)"

# ── the ban program, against a stand-in Cloudflare ──────────────────────────
# The stand-in keeps ONE rule per address per zone, as Cloudflare does (a second
# create answers 10009), writes down every command line it was run with, and
# keeps what arrived on stdin apart from that.
HP="$G/etc/fail2ban/$P-cloudflare.sh"; AC="$G/etc/fail2ban/action.d/$P-cloudflare.conf"
t "the action runs the ban program and holds no token logic"  "$(grep -q '^actionban = <cfhelper> ban <cfzone> <cftarget> <ip> <name>$' "$AC" && ! grep -q -e 'Authorization' -e 'cat <' "$AC" && echo 1 || echo 0)"
t "the ban program is written root-only (700)"              "$([ "$(ls -l "$HP" | cut -c1-10)" = "-rwx------" ] && echo 1 || echo 0)"
C="$T/cf"; mkdir -p "$C/bin" "$C/state"; : > "$C/rules"; : > "$C/argv"; : > "$C/stdin"
printf '%s' "$TOKEN" > "$C/token"
cat > "$C/bin/curl" <<'PYCURL'
#!/usr/bin/env python3
import json, os, sys, uuid
C = os.environ["FAKE_CF"]; a = sys.argv[1:]
open(C + "/argv", "a").write(" ".join(a) + "\n")
open(C + "/stdin", "a").write(sys.stdin.read())
method = "GET"; data = None; q = {}; url = ""
i = 0
while i < len(a):
    if a[i] == "-X": method = a[i + 1]; i += 2
    elif a[i] == "--data": data = a[i + 1]; method = "POST" if method == "GET" else method; i += 2
    elif a[i] == "--data-urlencode": k, v = a[i + 1].split("=", 1); q[k] = v; i += 2
    elif a[i] in ("--max-time", "-H"): i += 2
    elif a[i].startswith("http"): url = a[i]; i += 1
    else: i += 1
rules = [l.rstrip("\n").split("|") for l in open(C + "/rules") if l.strip()]   # id|zone|value|note
zone = url.split("/zones/")[1].split("/")[0]
def save(): open(C + "/rules", "w").write("".join("|".join(r) + "\n" for r in rules))
if os.environ.get("FAKE_CF_DOWN"): print("upstream error"); sys.exit()
if method == "POST":
    d = json.loads(data); v = d["configuration"]["value"]
    if any(r[1] == zone and r[2] == v for r in rules): print('{"success": false, "errors": [{"code": 10009}]}')
    else: rules.append([uuid.uuid4().hex, zone, v, d["notes"]]); save(); print('{"success": true, "result": {"id": "%s"}}' % rules[-1][0])
elif method == "DELETE":
    rid = url.rsplit("/", 1)[1]; n = len(rules); rules = [r for r in rules if r[0] != rid]; save()
    print('{"success": %s}' % ("true" if len(rules) < n else "false"))
else:   # list. Deliberately loose on the address (prefix match), so the program's own exact check is what is tested.
    out = [r for r in rules if r[1] == zone and r[2].startswith(q.get("configuration.value", ""))
           and ("notes" not in q or r[3] == q["notes"])]
    print(json.dumps({"success": True, "result": [{"id": r[0], "mode": "block", "notes": r[3], "scope": {"type": "zone"},
          "configuration": {"target": "ip", "value": r[2]}} for r in out]}))
PYCURL
chmod +x "$C/bin/curl"
hp() { PATH="$C/bin:$PATH" env FAKE_CF="$C" "${FLEET_JAIL_UPPER}_CF_TOKEN_FILE=$C/token" "${FLEET_JAIL_UPPER}_CF_STATE=$C/state" bash "$HP" "$@"; }
nrules() { grep -c "|$ZONE|$1|" "$C/rules"; }
HOLD="$C/state/$ZONE/203.0.113.45"
names() { [ -f "$HOLD" ] && awk '{print $1}' "$HOLD" | tr '\n' ' ' || echo absent; }

echo "a short ban ending does not lift a longer one:"
hp ban "$ZONE" ip 203.0.113.45 $J-a-h; r1=$?
t "the first jail's ban makes one rule, in its name"        "$([ "$r1" = 0 ] && [ "$(nrules 203.0.113.45)" = 1 ] && grep -q "$B Fail2Ban $J-a-h\$" "$C/rules" && echo 1 || echo 0)"
hp ban "$ZONE" ip 203.0.113.45 $J-a-s; r2=$?
t "a second jail's ban succeeds and there is still one rule" "$([ "$r2" = 0 ] && [ "$(nrules 203.0.113.45)" = 1 ] && [ "$(names)" = "$J-a-h $J-a-s " ] && echo 1 || echo 0)"
hp ban "$ZONE" ip 203.0.113.45 $J-a-s
t "banning twice does not list a jail twice"                "$([ "$(names)" = "$J-a-h $J-a-s " ] && echo 1 || echo 0)"
hp unban "$ZONE" ip 203.0.113.45 $J-a-h; r3=$?
t "the SHORT jail's unban leaves the rule in place"         "$([ "$r3" = 0 ] && [ "$(nrules 203.0.113.45)" = 1 ] && [ "$(names)" = "$J-a-s " ] && echo 1 || echo 0)"
hp unban "$ZONE" ip 203.0.113.45 $J-a-s; r4=$?
t "the last jail's unban deletes it, under another jail's name" "$([ "$r4" = 0 ] && [ "$(nrules 203.0.113.45)" = 0 ] && [ "$(names)" = absent ] && echo 1 || echo 0)"
t "the lock is released"                                    "$([ -e "$C/state/$ZONE/.lock" ] && echo 0 || echo 1)"

# CONTROL: the action as it was before this fix, against the same stand-in,
# must show the fault. Otherwise the checks above prove nothing.
ob() { PATH="$C/bin:$PATH" FAKE_CF="$C" sh -c 'curl -4 -s --max-time 15 -X POST "$0" --data "{\"mode\":\"block\",\"configuration\":{\"target\":\"ip\",\"value\":\"$1\"},\"notes\":\"$3 Fail2Ban $2\"}" | grep -E -q "\"success\": ?true|\"code\": ?10009"' "https://api.cloudflare.com/client/v4/zones/$ZONE/firewall/access_rules/rules" "$1" "$2" "$B" < /dev/null; }
ou() { PATH="$C/bin:$PATH" FAKE_CF="$C" sh -c 'id=$(curl -4 -s -G "$0" --data-urlencode "configuration.value=$1" --data-urlencode "notes=$3 Fail2Ban $2" | tr -d "\n" | sed -n "s/.*\"result\": *\[ *{ *\"id\": *\"\([0-9a-f]*\)\".*/\1/p"); [ -n "$id" ] || exit 0; curl -4 -s -X DELETE "$0/$id" | grep -q true' "https://api.cloudflare.com/client/v4/zones/$ZONE/firewall/access_rules/rules" "$1" "$2" "$B" < /dev/null; }
ob 203.0.113.46 $J-a-h; ob 203.0.113.46 $J-a-s; ou 203.0.113.46 $J-a-h
t "CONTROL — the old action deletes the rule while the long jail still holds it" "$([ "$(nrules 203.0.113.46)" = 0 ] && echo 1 || echo 0)"

echo "touches only its own rule for exactly that address:"
printf 'aaaa1111aaaa1111aaaa1111aaaa1111|%s|203.0.113.4|%s Fail2Ban %s-b-x\n' "$ZONE" "$B" "$J" >> "$C/rules"     # another address our rule covers; a loose lookup returns it for .4 and .45
printf 'bbbb2222bbbb2222bbbb2222bbbb2222|%s|203.0.113.47|Blocked by hand\n' "$ZONE" >> "$C/rules"
hp ban "$ZONE" ip 203.0.113.45 $J-a-h; hp unban "$ZONE" ip 203.0.113.45 $J-a-h
hp ban "$ZONE" ip 203.0.113.47 $J-a-h; r5=$?; hp unban "$ZONE" ip 203.0.113.47 $J-a-h
t "a lookalike address's rule is left alone"                "$([ "$(nrules 203.0.113.4)" = 1 ] && [ "$(nrules 203.0.113.45)" = 0 ] && echo 1 || echo 0)"
t "a rule somebody made by hand is left alone"              "$([ "$r5" = 0 ] && grep -q '|203.0.113.47|Blocked by hand$' "$C/rules" && echo 1 || echo 0)"
hp ban "$ZONE" ip6 2001:db8::45 $J-a-h; hp ban "$ZONE" ip6 2001:db8::45 $J-c-x; hp unban "$ZONE" ip6 2001:db8::45 $J-a-h
t "an IPv6 address is held across two sites in one zone"    "$([ "$(nrules 2001:db8::45)" = 1 ] && [ -f "$C/state/$ZONE/2001_db8__45" ] && echo 1 || echo 0)"
hp unban "$ZONE" ip6 2001:db8::45 $J-c-x
t "and released by the last of them"                        "$([ "$(nrules 2001:db8::45)" = 0 ] && echo 1 || echo 0)"

echo "survives a crash and a Cloudflare outage:"
mkdir -p "$C/state/$ZONE"; printf '%s-dead-x 1000\n' "$J" > "$C/state/$ZONE/203.0.113.48"     # a holder from 1970: left by a crash
hp ban "$ZONE" ip 203.0.113.48 $J-a-h; hp unban "$ZONE" ip 203.0.113.48 $J-a-h
t "a holder older than any ban does not pin the rule forever" "$([ "$(nrules 203.0.113.48)" = 0 ] && [ ! -e "$C/state/$ZONE/203.0.113.48" ] && echo 1 || echo 0)"
FAKE_CF_DOWN=1 hp ban "$ZONE" ip 203.0.113.49 $J-a-h; r6=$?
t "a failed ban reports failure, and still records the holder" "$([ "$r6" != 0 ] && grep -q "^$J-a-h " "$C/state/$ZONE/203.0.113.49" && echo 1 || echo 0)"
hp ban "$ZONE" ip 203.0.113.49 $J-a-h; FAKE_CF_DOWN=1 hp unban "$ZONE" ip 203.0.113.49 $J-a-h; r7=$?
t "a failed unban reports failure"                          "$([ "$r7" != 0 ] && echo 1 || echo 0)"
mkdir "$C/state/$ZONE/.lock"; touch -t 202001010000 "$C/state/$ZONE/.lock"
hp ban "$ZONE" ip 203.0.113.50 $J-a-h; r8=$?
t "a lock left by a killed run is broken, not waited on forever" "$([ "$r8" = 0 ] && [ ! -e "$C/state/$ZONE/.lock" ] && echo 1 || echo 0)"
hp ban "$ZONE; id" ip 203.0.113.51 $J-a-h; r9=$?; hp ban "$ZONE" ip '203.0.113.51"x' $J-a-h; r10=$?; hp wipe "$ZONE" ip 203.0.113.51 $J-a-h; r11=$?
t "a malformed zone, address or verb is refused"            "$([ "$r9" = 2 ] && [ "$r10" = 2 ] && [ "$r11" = 2 ] && [ "$(nrules 203.0.113.51)" = 0 ] && echo 1 || echo 0)"

echo "never puts the token on a command line:"
calls=$(wc -l < "$C/argv" | tr -d ' ')
t "the stand-in was really called ($calls command lines recorded)" "$([ "$calls" -ge 20 ] && echo 1 || echo 0)"
t "the token is in none of them"                            "$(grep -q "$TOKEN" "$C/argv" && echo 0 || echo 1)"
t "every call but the 4 from the old-action control passed the header on stdin (-H @-)" "$([ "$(grep -c -- '-H @-' "$C/argv")" = "$((calls - 4))" ] && echo 1 || echo 0)"
t "CONTROL — the token did arrive, on stdin"                "$(grep -q "^Authorization: Bearer $TOKEN\$" "$C/stdin" && echo 1 || echo 0)"
t "the setup program's own calls no longer put it on the command line" "$(grep -n 'curl' "$HERE/fleet-fail2ban-apply.remote.sh" "$HERE/fleet-fail2ban-token-proof.sh" | grep -q 'Bearer \$CF_TOKEN" -H\|-H "Authorization' && echo 0 || echo 1)"

echo
[ "$fail" = 0 ] && echo "all $ran checks passed" || { echo "FAILED — output was:"; sed 's/^/    /' "$T/out"; exit 1; }
