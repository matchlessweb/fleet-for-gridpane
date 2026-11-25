#!/bin/bash
# Self-test for lib-fleet-servers.sh and for the rule that no script carries its
# own server list. Touches no server:  bash scripts/test-fleet-servers.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "pass  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got \"$2\", wanted \"$3\")"; fi; }

# Runs a snippet in a fresh shell with the lib sourced and $1 as the list.
run() { FLEET_SERVERS_FILE="$1" HOME="$T/home" XDG_CONFIG_HOME="" bash -c ". '$HERE/lib-fleet-servers.sh'; $2" 2>"$T/err"; }

cat > "$T/good" <<'LIST'
# a comment

203.0.113.10|10001|web1|golden
203.0.113.11|10002|web10
2001:db8::12|10003|shop.one
203.0.113.13|10004|web_2
LIST

out=$(run "$T/good" 'fleet_servers_load && printf "%s\n" "$SERVERS" | wc -l | tr -d " "');           check "a good list loads: four servers" "$out" "4"
out=$(run "$T/good" 'fleet_servers_load && printf "%s" "$SERVERS" | grep -c golden');               check "the golden mark is not left on the entries" "$out" "0"
out=$(run "$T/good" 'fleet_servers_load && echo "$FLEET_GOLDEN_LABEL $FLEET_GOLDEN_IP"');           check "the golden server is found" "$out" "web1 203.0.113.10"
out=$(run "$T/good" 'fleet_server_ip web1');                                                       check "a label resolves without loading first" "$out" "203.0.113.10"
out=$(run "$T/good" 'fleet_server_ip web10');                                                      check "web10 is not confused with web1" "$out" "203.0.113.11"
out=$(run "$T/good" 'fleet_server_ip shop.one');                                                   check "an IPv6 address and a dotted label work" "$out" "2001:db8::12"
out=$(run "$T/good" 'fleet_server_ip shopXone');                                                   check "a dot in a label is not a wildcard" "$out" ""
out=$(run "$T/good" 'fleet_server_ip web');                                                        check "part of a label matches nothing" "$out" ""
out=$(run "$T/good" 'for e in $SERVERS; do :; done; fleet_servers_load; for e in $SERVERS; do IP="${e%%|*}"; r="${e#*|}"; printf "%s/%s/%s " "$IP" "${r%%|*}" "${r#*|}"; done' | cut -d' ' -f1)
check "an entry splits the way the scripts split it" "$out" "203.0.113.10/10001/web1"

run "$T/missing" 'fleet_servers_load'; rc=$?
check "a missing list stops the script" "$rc" "1"
if grep -q "no server list" "$T/err" && grep -q "servers:export" "$T/err"; then ok "and says where it looked and how to make one"; else bad "the missing-list message is not helpful: $(cat "$T/err")"; fi
out=$(run "$T/missing" 'fleet_server_ip web1'; echo "rc=$?");                                     check "a lookup with no list prints no address" "$out" "rc=1"

printf '203.0.113.10|10001|web1\nnot a server line\n' > "$T/garbled"
run "$T/garbled" 'fleet_servers_load'; rc=$?;                                                      check "a garbled line stops the script" "$rc" "1"
if grep -q "line 2:" "$T/err"; then ok "and names the line"; else bad "the garbled-line message does not name line 2: $(cat "$T/err")"; fi

printf '203.0.113.10|10001|web1\n203.0.113.11|10002|web1\n' > "$T/twice"
run "$T/twice" 'fleet_servers_load'; check "the same label twice stops the script" "$?" "1"
printf '203.0.113.10|10001|web1|golden\n203.0.113.11|10002|web2|golden\n' > "$T/two-golden"
run "$T/two-golden" 'fleet_servers_load'; check "two golden servers stop the script" "$?" "1"
printf '# nothing here\n\n' > "$T/empty"
run "$T/empty" 'fleet_servers_load'; check "an empty list stops the script" "$?" "1"
printf '203.0.113.10|10001|web1\n' > "$T/no-golden"
run "$T/no-golden" 'fleet_servers_load && fleet_require_golden'; check "copying from the golden server stops when none is marked" "$?" "1"
run "$T/good" 'fleet_servers_load && fleet_require_golden';      check "and goes ahead when one is" "$?" "0"

# The example file must itself be a valid list, made only of documentation addresses.
run "$HERE/servers.example" 'fleet_servers_load && fleet_require_golden'; check "servers.example is a valid list with a golden server" "$?" "0"
real=$(grep -vE '^[[:space:]]*(#.*)?$' "$HERE/servers.example" | cut -d'|' -f1 | grep -cvE '^(203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|2001:db8:)')
check "servers.example uses only documentation addresses" "$real" "0"

# No script may carry its own list, or read one out of another script.
# Each pattern is checked against a planted line first, so the search can fail.
embedded='^[0-9a-fA-F.:]+\|[0-9]+\|[A-Za-z0-9_.-]+$'
borrowed="sed -n '/\^SERVERS="
printf '203.0.113.9|10009|planted\n' > "$T/plant1.sh"; printf "IP=\$(sed -n '/^SERVERS=\"/,/^\"/p' x)\n" > "$T/plant2.sh"
if grep -qE "$embedded" "$T/plant1.sh" && grep -q "$borrowed" "$T/plant2.sh"; then ok "the two searches find a planted line"; else bad "a search cannot see its planted line"; fi
n=$(ls "$HERE"/*.sh | wc -l | tr -d ' ')
hits=$({ grep -lE "$embedded" "$HERE"/*.sh 2>/dev/null; grep -l "$borrowed" "$HERE"/*.sh 2>/dev/null; } | grep -v '/test-fleet-servers.sh$')
if [ -z "$hits" ]; then ok "none of the $n scripts carries or borrows a server list"; else bad "these scripts still carry or borrow a list: $hits"; fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
