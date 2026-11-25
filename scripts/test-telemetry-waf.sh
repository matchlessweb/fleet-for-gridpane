#!/bin/bash
# Runs the WAF section of telemetry-agent.sh against a made-up server on this
# machine and checks what it reports. Nothing is sent anywhere: only the python
# part between the "waf report" markers is run, and its output read.
# Run: bash scripts/test-telemetry-waf.sh
#
# Every address below is from the documentation ranges (203.0.113.0/24,
# 2001:db8::/32) and every hostname ends in .example.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$HERE/telemetry-agent.sh"
T=$(mktemp -d) || exit 1
trap 'rm -rf "${T:?}"' EXIT
W="$T/server"
fail=0; ran=0
t() { ran=$((ran + 1)); if [ "$2" = "1" ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }

sed -n '/^# --- waf report: begin/,/^# --- waf report: end/p' "$AGENT" > "$T/report.py"
[ -s "$T/report.py" ] || { echo "FAIL: could not find the WAF report section in $AGENT"; exit 1; }

NOW=1794657600                      # 2026-11-14T12:00:00Z, fixed so the 24 hours are too
iso()  { python3 -c "import datetime,sys;print(datetime.datetime.utcfromtimestamp($NOW-int(sys.argv[1])).strftime('%Y-%m-%dT%H:%M:%S+00:00'))" "$1"; }
ngx()  { python3 -c "import datetime,sys;print(datetime.datetime.utcfromtimestamp($NOW-int(sys.argv[1])).strftime('%d/%b/%Y:%H:%M:%S +0000'))" "$1"; }

site() {  # site <name> <waf value> <bad-request on|off>
    mkdir -p "$W/var/www/$1/nginx" "$W/var/www/$1/logs"
    printf 'waf:%s\n7G-bad-bots:on\n7G-bad-methods:on\n7G-bad-query-string:on\n7G-bad-referer:on\n7G-bad-remote-host:off\n7G-bad-request:%s\nphp-ver:8.3\nsecret-looking:abc def\n' "$2" "$3" > "$W/var/www/$1/logs/$1.env"
}
rules() { # the 8G rule files, as on a real site
    mkdir -p "$W/var/www/$1/nginx/8g"
    printf '# 8G FIREWALL v1.5 20251006\nif ($bad_bot_ng) { return 403; }\n' > "$W/var/www/$1/nginx/8g/8g.conf"
    echo "map \$http_user_agent \$bad_bot_ng { default 0; }" > "$W/var/www/$1/nginx/8g/8g-firewall.conf"
    printf '# loads the rules\ninclude /var/www/%s/nginx/8g/8g-firewall.conf;\nlog_format ng8 x;\n' "$1" > "$W/var/www/$1/nginx/8g-http-context.conf"
}
watch() { printf '# watch mode\nset $ng8_hit "";\naccess_log /var/www/%s/logs/8g.log ng8 if=$ng8_hit;\n' "$1" > "$W/var/www/$1/nginx/8g-watch-main-context.conf"; }

site plain.example 7G on                                   # 7G only
site watch.example 7G off;  rules watch.example; watch watch.example
site force.example 7G on;   rules force.example
printf 'include /var/www/force.example/nginx/8g/8g.conf;\n' > "$W/var/www/force.example/nginx/8g-main-context.conf"
site parked.example 7G on;  rules parked.example           # rules loaded, neither watching nor blocking
site commented.example 7G on; rules commented.example
printf '# include /var/www/commented.example/nginx/8g/8g.conf;\n' > "$W/var/www/commented.example/nginx/8g-main-context.conf"
site nowaf.example off on
mkdir -p "$W/var/www/22222/logs" "$W/var/www/notgridpane.example/htdocs"; echo "waf:7G" > "$W/var/www/22222/logs/22222.env"

L="$W/var/www/watch.example/logs"
{
    echo "$(iso 90000) 200 \"GET /old\" cookie=0 method=0 referer=0 bot=7 querystring=0 request=0 ip=203.0.113.5 ua=\"OldBot/1.0\" ref=\"-\""
    i=0; while [ $i -lt 5 ]; do echo "$(iso $((3600 + i))) 200 \"GET /page-$i?email=someone@example.com\" cookie=0 method=0 referer=0 bot=7 querystring=0 request=0 ip=203.0.113.9 ua=\"ExampleBot/2.0 (+https://bot.example)\" ref=\"https://ref.example/?q=private\""; i=$((i + 1)); done
    echo "$(iso 3000) 200 \"GET /feed\" cookie=0 method=0 referer=0 bot=7 querystring=0 request=0 ip=2001:db8::7 ua=\"OtherBot/1\" ref=\"-\""
    echo "$(iso 2000) 403 \"GET /wp-config.php.bak?x=1\" cookie=0 method=0 referer=0 bot=0 querystring=0 request=31 ip=203.0.113.9 ua=\"curl/8\" ref=\"-\""
    echo "$(iso 1900) 404 \"GET /.env\" cookie=0 method=0 referer=0 bot=0 querystring=0 request=31 ip=203.0.113.9 ua=\"curl/8\" ref=\"-\""
    echo "$(iso 1800) 200 \"GET /?id=1%27\" cookie=0 method=0 referer=0 bot=6 querystring=12 request=0 ip=203.0.113.9 ua=\"sqlmap\" ref=\"-\""
    echo "$(iso 1700) 200 \"GET /clean\" cookie=0 method=0 referer=0 bot=0 querystring=0 request=0 ip=203.0.113.9 ua=\"x\" ref=\"-\""
    echo "not a log line at all"
} > "$L/8g.log"
{
    echo "[$(ngx 90000)] [\":bad_bot_1:\"] 203.0.113.5 watch.example \"GET /old HTTP/2.0\" 403 0.000 \"-\" \"x\""
    echo "[$(ngx 3000)] [\":bad_request_8:\"] 203.0.113.9 watch.example \"GET /a HTTP/2.0\" 403 0.000 \"-\" \"x\""
    echo "[$(ngx 2000)] [\":bad_request_8:\"] 2001:db8::7 watch.example \"GET /b HTTP/2.0\" 403 0.000 \"-\" \"x\""
    echo "[$(ngx 1000)] [\":bad_bot_2::bad_query_string_4:\"] 203.0.113.9 watch.example \"GET /c HTTP/2.0\" 403 0.000 \"-\" \"x\""
} > "$L/7g.log"
echo "[$(ngx 80000)] [\":bad_method_1:\"] 203.0.113.9 watch.example \"TRACE / HTTP/2.0\" 403 0.000 \"-\" \"x\"" > "$L/7g.log.1"
: > "$W/var/www/plain.example/logs/7g.log"

run() { WAF_ROOT="$W" WAF_NOW="$NOW" TZ=UTC python3 "$T/report.py" > "$T/out.json" 2> "$T/err"; echo $? > "$T/rc"; }
# No { } in a q expression: bash 3.2 (macOS) mis-reads braces inside "$(q "...")".
q() {
    Q_EXPR="$1" python3 - "$T/out.json" <<'PY' 2>/dev/null || echo 0
import json, os, sys
d = json.load(open(sys.argv[1])); S = {s["site"]: s for s in d["sites"]}
R8 = {r["rule"]: r for r in (S.get("watch.example", {}).get("g8_day") or {}).get("rules", [])}
R7 = {r["rule"]: r["n"] for r in (S.get("watch.example", {}).get("g7_day") or {}).get("rules", [])}
print(1 if eval(os.environ["Q_EXPR"]) else 0)
PY
}
run
echo "the report"
t "finishes and writes valid JSON"                              "$([ "$(cat "$T/rc")" = 0 ] && q "d['v']==1")"
t "six site folders; 22222 and a folder with no settings skipped" "$(q "sorted(S)==['commented.example','force.example','nowaf.example','parked.example','plain.example','watch.example']")"
t "CONTROL: a false statement about the report fails"            "$([ "$(q "len(S)==99")" = 0 ] && echo 1 || echo 0)"

echo "7G settings"
t "GridPane's WAF setting is read"                               "$(q "S['plain.example']['waf']=='7G' and S['nowaf.example']['waf']=='off'")"
t "each ruleset with its switch"                                 "$(q "sorted(S['plain.example']['rulesets'].items())==[('bad-bots','on'),('bad-methods','on'),('bad-query-string','on'),('bad-referer','on'),('bad-remote-host','off'),('bad-request','on')]")"
t "a ruleset switched off on one site shows off there"           "$(q "S['watch.example']['rulesets']['bad-request']=='off'")"
t "a settings value with a space in it is not carried"           "$(q "'secret-looking' not in json.dumps(d)")"

echo "8G mode"
t "no 8G files = none"                                           "$(q "S['plain.example']['g8']['mode']=='none' and S['plain.example']['g8']['version'] is None")"
t "watch file = observe, rules loaded, version read"             "$(q "(S['watch.example']['g8']['mode'],S['watch.example']['g8']['rules_loaded'],S['watch.example']['g8']['version'])==('observe',True,'1.5')")"
t "8g.conf included = enforce"                                   "$(q "S['force.example']['g8']['mode']=='enforce'")"
t "rules loaded but neither watching nor blocking = installed"   "$(q "S['parked.example']['g8']['mode']=='installed'")"
t "CONTROL: a commented-out include is not enforce"              "$(q "S['commented.example']['g8']['mode']=='installed'")"
t "the 8G log's size and last write are reported"                "$(q "S['watch.example']['g8']['log_bytes']>0 and S['watch.example']['g8']['log_at'].endswith('Z') and S['plain.example']['g8']['log_bytes'] is None")"

echo "the last 24 hours"
t "8G: 9 would-be blocks; the old line, the clean line and the junk line are out" "$(q "S['watch.example']['g8_day']['total']==9")"
t "8G: one of them was refused anyway (403)"                     "$(q "S['watch.example']['g8_day']['already']==1")"
t "8G: counted by rule, most hits first"                         "$(q "[(r['rule'],r['n']) for r in S['watch.example']['g8_day']['rules']]==[('bad_bot_7',6),('bad_request_31',2),('bad_bot_6',1),('bad_querystring_12',1)]")"
t "8G: a line matching two rules counts once in the total"       "$(q "sum(r['n'] for r in S['watch.example']['g8_day']['rules'])==10")"
t "8G: bot rules carry the commonest user agents"                "$(q "[(x['s'],x['n']) for x in R8['bad_bot_7']['samples']]==[('ExampleBot/2.0 (+https://bot.example)',5),('OtherBot/1',1)]")"
t "8G: request rules carry paths with the query string cut off"  "$(q "sorted(x['s'] for x in R8['bad_request_31']['samples'])==['/.env','/wp-config.php.bak'] and R8['bad_request_31']['already']==1")"
t "CONTROL: no address, query string or referrer in the report"  "$(q "not any(x in json.dumps(d) for x in ['203.0.113','2001:db8','someone@','private','id=1','ref.example'])")"
t "7G: 4 blocks in the day, the rotated file included, the old line out" "$(q "S['watch.example']['g7_day']['total']==4")"
t "7G: counted by rule; a line with two rules counts for both"   "$(q "sorted(R7.items())==[('bad_bot_2',1),('bad_method_1',1),('bad_query_string_4',1),('bad_request_8',2)]")"
t "an empty 7G log is zero, not missing"                         "$(q "S['plain.example']['g7_day']['total']==0 and S['plain.example']['g7_day']['complete'] is True")"
t "no log file is null, not zero"                                "$(q "S['plain.example']['g8_day'] is None and S['nowaf.example']['g7_day'] is None")"

echo "a log longer than the read limit"
sed -i.bak 's/^TAIL_MAX = .*/TAIL_MAX = 400/' "$T/report.py"; run
t "the day is marked incomplete rather than shown as whole"      "$(q "S['watch.example']['g8_day']['complete'] is False and S['watch.example']['g8_day']['total']<9")"

echo
if [ "$fail" = 0 ]; then echo "$ran checks, all passed"; else echo "$ran checks, FAILURES above"; cat "$T/err" | head -5; exit 1; fi
