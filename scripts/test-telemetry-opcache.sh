#!/bin/bash
# Runs the OPcache section of telemetry-agent.sh against a made-up server on
# this machine and checks what it reports. Nothing is sent anywhere: only the
# python part between the "opcache report" markers is run, and its output read.
# Run: bash scripts/test-telemetry-opcache.sh
#
# It needs a local php-fpm (Homebrew's is fine). It starts two of them on unix
# sockets inside a temp folder (no network port) and stops them at the end.
# Every hostname ends in .example.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$HERE/telemetry-agent.sh"
FPM=$(command -v php-fpm || ls /opt/homebrew/sbin/php-fpm /usr/sbin/php-fpm* 2>/dev/null | head -1)
[ -x "${FPM:-}" ] || { echo "SKIP: no php-fpm on this machine, so the live read cannot be tested"; exit 2; }
T=$(mktemp -d /tmp/opc.XXXXXX) || exit 1      # short: a unix socket path has a length limit
T=$(cd "$T" && pwd -P)                        # the real path: PHP caches files under it (macOS: /private/tmp)
cleanup() { for f in "$T"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done; sleep 0.3; rm -rf "${T:?}"; }
trap cleanup EXIT
W="$T/server"
fail=0; ran=0
t() { ran=$((ran + 1)); if [ "$2" = "1" ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }

# The agent in the repository holds placeholders for the names it uses on a
# server. Fill them in as the installer does (lib-fleet-names.sh).
. "$HERE/lib-fleet-names.sh"
fleet_names_fill < "$AGENT" > "$T/agent.sh"; AGENT="$T/agent.sh"

sed -n '/^# --- opcache report: begin/,/^# --- opcache report: end/p' "$AGENT" > "$T/report.py"
[ -s "$T/report.py" ] || { echo "FAIL: could not find the OPcache report section in $AGENT"; exit 1; }

# --- the made-up server -------------------------------------------------------
for s in a.example b.example staging.a.example blocked.example; do mkdir -p "$W/var/www/$s/htdocs"; done
for i in 1 2 3; do echo "<?php function a$i() { return $i; }" > "$W/var/www/a.example/htdocs/a$i.php"; done
for i in 1 2;   do echo "<?php function b$i() { return $i; }" > "$W/var/www/b.example/htdocs/b$i.php"; done
# Loads five site files into the cache before the probe runs, as real traffic would.
cat > "$T/warm.php" <<PHP
<?php foreach (array('a.example/htdocs/a1.php','a.example/htdocs/a2.php','a.example/htdocs/a3.php','b.example/htdocs/b1.php','b.example/htdocs/b2.php') as \$f) { @opcache_compile_file('$W/var/www/' . \$f); }
PHP

pool() { # pool <version> <file> <pool name> <socket> [extra line]
    mkdir -p "$W/etc/php/$1/fpm/pool.d" "$W/etc/php/$1/fpm/conf.d"
    printf '; a comment naming /var/www/b.example/ that must not count\n[%s]\nlisten = %s\npm = static\npm.max_children = 1\nphp_admin_value[error_log] = /var/www/%s/logs/php.log\n%s\n' "$3" "$4" "$3" "${5:-}" > "$W/etc/php/$1/fpm/pool.d/$2.conf"
}
# 8.3: two sites and a staging copy on one running PHP. php.ini says 128, conf.d says 64: conf.d is read last.
pool 8.3 a.example a.example "$T/a.sock"
pool 8.3 b.example b.example "$T/b.sock"
pool 8.3 staging staging.a.example "$T/s.sock"
printf ';opcache.memory_consumption=999\nopcache.enable=1\nopcache.memory_consumption=128\nopcache.interned_strings_buffer=8\nopcache.max_accelerated_files=4000\nopcache.validate_timestamps=1\nopcache.revalidate_freq=60\n' > "$W/etc/php/8.3/fpm/php.ini"
printf 'opcache.memory_consumption = 64\n' > "$W/etc/php/8.3/fpm/conf.d/10-opcache.ini"
# 8.2: a pool that may only open files in its own folder, so the probe is refused.
pool 8.2 blocked.example blocked.example "$T/x.sock" "php_admin_value[open_basedir] = $W/var/www/blocked.example/"
printf 'opcache.enable=1\nopcache.memory_consumption=128\n' > "$W/etc/php/8.2/fpm/php.ini"
# 8.1: the cache switched off.
pool 8.1 off off-pool "$T/o.sock"
printf 'opcache.enable=0\n' > "$W/etc/php/8.1/fpm/php.ini"
# 8.0: settings, no pool.  7.4: a pool whose socket nobody answers.  "extras": not a version.
mkdir -p "$W/etc/php/8.0/fpm/pool.d" "$W/etc/php/extras/fpm"; printf 'opcache.memory_consumption=32\n' > "$W/etc/php/8.0/fpm/php.ini"
pool 7.4 dead dead "$T/dead.sock"; python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "$T/dead.sock"
mkdir -p "$W/etc/php/7.4/fpm"; : > "$W/etc/php/7.4/fpm/php.ini"

# --- two real php-fpm masters: cache on (8.3 and 8.2 pools), cache off (8.1) ---
cat > "$T/on.ini" <<INI
opcache.enable=1
opcache.memory_consumption=64
opcache.interned_strings_buffer=8
opcache.max_accelerated_files=4000
opcache.revalidate_freq=60
opcache.file_update_protection=0
auto_prepend_file=$T/warm.php
INI
printf 'opcache.enable=0\n' > "$T/off.ini"
{ printf '[global]\npid = %s/on.pid\nerror_log = %s/on.log\ndaemonize = yes\n' "$T" "$T"
  sed -n '/^\[/,$p' "$W/etc/php/8.3/fpm/pool.d/a.example.conf" "$W/etc/php/8.3/fpm/pool.d/b.example.conf" "$W/etc/php/8.3/fpm/pool.d/staging.conf" "$W/etc/php/8.2/fpm/pool.d/blocked.example.conf"
} | grep -v error_log\] > "$T/on.conf"
{ printf '[global]\npid = %s/off.pid\nerror_log = %s/off.log\ndaemonize = yes\n' "$T" "$T"
  sed -n '/^\[/,$p' "$W/etc/php/8.1/fpm/pool.d/off.conf"; } | grep -v error_log\] > "$T/off.conf"
"$FPM" -n -c "$T/on.ini"  -y "$T/on.conf"  -d "zend_extension=opcache" 2>>"$T/start.log" || "$FPM" -n -c "$T/on.ini" -y "$T/on.conf" 2>>"$T/start.log"
"$FPM" -n -c "$T/off.ini" -y "$T/off.conf" -d "zend_extension=opcache" 2>>"$T/start.log" || "$FPM" -n -c "$T/off.ini" -y "$T/off.conf" 2>>"$T/start.log"
i=0; while [ $i -lt 30 ] && { [ ! -S "$T/a.sock" ] || [ ! -S "$T/o.sock" ]; }; do sleep 0.1; i=$((i + 1)); done
[ -S "$T/a.sock" ] && [ -S "$T/o.sock" ] || { echo "FAIL: php-fpm did not start:"; cat "$T/start.log" "$T"/*.log 2>/dev/null | tail -20; exit 1; }

run() { OPC_ROOT="$W" OPC_PROBE_DIR="$T/probe" python3 "$T/report.py"; }
run > "$T/out.json"; RC=$?
t "the section exits 0" "$([ $RC -eq 0 ] && echo 1)"
q() { python3 - "$T/out.json" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
V = {v["version"]: v for v in d["versions"]}
try:
    print(1 if eval(sys.argv[2]) else 0)
except Exception as e:
    print("0 (%s: %s)" % (type(e).__name__, e))
PY
}
c() { t "$1" "$(q "$2")"; }

echo "8.3: a running cache shared by three pools"
c "versions are 7.4, 8.0, 8.1, 8.2, 8.3 and 'extras' is not one"  "sorted(V) == ['7.4','8.0','8.1','8.2','8.3']"
c "three pools, and their folders, with the commented path ignored" "V['8.3']['pools'] == 3 and V['8.3']['sites'] == ['a.example','b.example','staging.a.example']"
c "settings as written: conf.d (64) beats php.ini (128), a commented line is not read" "V['8.3']['ini']['memory_mb'] == 64 and V['8.3']['ini']['interned_mb'] == 8 and V['8.3']['ini']['max_files'] == 4000"
c "the live read worked"                                   "V['8.3']['live'] is not None and V['8.3']['live_error'] is None"
c "live settings come from the running PHP"                "V['8.3']['live']['cfg']['memory_mb'] == 64 and V['8.3']['live']['cfg']['max_files'] == 4000"
c "memory adds up to the configured 64 MB"                 "sum(V['8.3']['live']['mem'].values()) == 64 * 1048576 and V['8.3']['live']['mem']['used'] > 0"
c "text buffer is 8 MB and partly used"                    "V['8.3']['live']['str']['size'] == 8 * 1048576 and 0 < V['8.3']['live']['str']['used'] < 8 * 1048576"
c "a.example holds 3 cached files, b.example 2"            "{r['site']: r['scripts'] for r in V['8.3']['live']['by_site']}.get('a.example') == 3 and {r['site']: r['scripts'] for r in V['8.3']['live']['by_site']}.get('b.example') == 2"
c "each site's cached code has a size"                     "all(r['bytes'] > 0 for r in V['8.3']['live']['by_site'])"
c "files outside the site folders are counted as 'other'"  "{r['site']: r['scripts'] for r in V['8.3']['live']['by_site']}.get('other', 0) >= 1"
c "the per-site counts add up to the cache's own count"    "sum(r['scripts'] for r in V['8.3']['live']['by_site']) == V['8.3']['live']['scripts']"
c "a start time, as a UTC timestamp"                       "__import__('re').match(r'^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ$', V['8.3']['live']['start'] or '') is not None"
c "limits are reported (keys in use against the ceiling)"  "0 < V['8.3']['live']['keys'] < V['8.3']['live']['max_keys']"
echo "what must not read as fine"
c "8.2: a pool that refuses the probe says so, with the settings kept" "V['8.2']['live'] is None and V['8.2']['live_error'].startswith('blocked') and V['8.2']['ini']['memory_mb'] == 128"
c "8.1: cache switched off is reported as off, not as empty"           "V['8.1']['live'] is None and V['8.1']['live_error'] == 'off'"
c "8.0: no pool to ask, settings only"                                 "V['8.0']['live'] is None and V['8.0']['live_error'] == 'no_pool' and V['8.0']['ini']['memory_mb'] == 32 and V['8.0']['sites'] == []"
c "7.4: a socket nobody answers"                                       "V['7.4']['live'] is None and V['7.4']['live_error'].startswith('no_answer') and V['7.4']['ini'] is None"
echo "the probe file"
t "written once, readable, outside the site folders" "$([ "$(stat -f %Lp "$T/probe/opcache-probe.php" 2>/dev/null || stat -c %a "$T/probe/opcache-probe.php")" = 644 ] && echo 1)"
B=$(ls -l -T "$T/probe/opcache-probe.php" 2>/dev/null || ls -l --time-style=full-iso "$T/probe/opcache-probe.php"); sleep 1.1; run > "$T/out2.json"
A=$(ls -l -T "$T/probe/opcache-probe.php" 2>/dev/null || ls -l --time-style=full-iso "$T/probe/opcache-probe.php")
t "not rewritten on the next run" "$([ "$A" = "$B" ] && echo 1)"
t "a second run reports more hits than the first (the counters are live)" "$(python3 -c "
import json,sys
a=json.load(open('$T/out.json'));b=json.load(open('$T/out2.json'))
g=lambda d:[v for v in d['versions'] if v['version']=='8.3'][0]['live']
print(1 if g(b)['hits']+g(b)['misses'] > g(a)['hits']+g(a)['misses'] else 0)")"
t "the report holds no address and no path into a site" "$(grep -cE '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|htdocs' "$T/out.json" | grep -qx 0 && echo 1)"
OPC_ROOT="$T/nothing" OPC_PROBE_DIR="$T/probe2" python3 "$T/report.py" > "$T/empty.json"
t "a machine with no PHP reports an empty list and writes no probe file" "$([ "$(cat "$T/empty.json")" = '{"v":1,"versions":[]}' ] && [ ! -e "$T/probe2" ] && echo 1)"

echo
if [ $fail -eq 0 ]; then echo "$ran checks passed"; else echo "FAILED ($ran checks run)"; python3 -c "import json;d=json.load(open(\"$T/out.json\"));print(json.dumps([v for v in d[\"versions\"] if v[\"live\"]],indent=1)[:2500])"; fi
exit $fail
