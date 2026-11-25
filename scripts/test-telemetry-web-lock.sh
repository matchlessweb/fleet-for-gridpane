#!/bin/bash
# Runs the "ufw web sources" part of telemetry-agent.sh against made-up `ufw status`
# listings and checks which sources it says can reach ports 80 and 443. Nothing
# is sent anywhere: only the function between the markers is run.
# Run: bash scripts/test-telemetry-web-lock.sh
#
# Addresses are from the documentation ranges (203.0.113.0/24, 198.51.100.0/24,
# 2001:db8::/32), except a few of Cloudflare's published ranges, which are the
# point of the check. The two listings marked "as printed" are the shapes a
# GridPane server printed before and after `gp cloudflare enable`.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$HERE/telemetry-agent.sh"
T=$(mktemp -d) || exit 1
trap 'rm -rf "${T:?}"' EXIT
fail=0; ran=0

sed -n '/^# --- ufw web sources: begin/,/^# --- ufw web sources: end/p' "$AGENT" > "$T/fn.sh"
grep -q 'ufw_web_sources()' "$T/fn.sh" || { echo "FAIL: could not find ufw_web_sources in $AGENT"; exit 1; }

# case NAME EXPECTED(space-separated) <<< listing
# Both lists are compared in one byte order (LC_ALL=C): the agent's own sort follows the
# machine's locale, and the app reads the list as a set, so the order it prints in is not checked.
inorder() { tr ' ' '\n' | grep -v '^$' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'; }
check() {
    local fn="$1" name="$2" want got
    want=$(printf '%s' "$3" | inorder)
    UFW_RAW=$(cat)
    got=$(bash -c ". '$fn'; UFW_RAW=\"\$1\"; ufw_web_sources" _ "$UFW_RAW" | inorder)
    ran=$((ran + 1))
    if [ "$got" = "$want" ]; then
        [ -z "${QUIET:-}" ] && echo "  ok   $name"
        return 0
    fi
    [ -z "${QUIET:-}" ] && echo "  FAIL $name: want [$want] got [$got]"
    return 1
}

run_cases() {
    local fn="$1" bad=0
    check "$fn" "GridPane default, as printed (verbose, ALLOW IN)" "0.0.0.0/0 ::/0" <<'L' || bad=1
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22                         ALLOW IN    Anywhere
80                         ALLOW IN    Anywhere
443                        ALLOW IN    Anywhere
2812                       ALLOW IN    Anywhere
22222                      ALLOW IN    Anywhere
22 (v6)                    ALLOW IN    Anywhere (v6)
80 (v6)                    ALLOW IN    Anywhere (v6)
443 (v6)                   ALLOW IN    Anywhere (v6)
11371                      ALLOW OUT   Anywhere
11371 (v6)                 ALLOW OUT   Anywhere (v6)
L
    check "$fn" "GridPane default, plain status (ALLOW)" "0.0.0.0/0 ::/0" <<'L' || bad=1
Status: active

To                         Action      From
--                         ------      ----
22                         ALLOW       Anywhere
80                         ALLOW       Anywhere
443                        ALLOW       Anywhere
80 (v6)                    ALLOW       Anywhere (v6)
L
    check "$fn" "after gp cloudflare enable, as printed (numbered, comments)" "103.21.244.0/22 173.245.48.0/20 2400:cb00::/32 2606:4700::/32" <<'L' || bad=1
Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 22                         ALLOW IN    Anywhere
[ 2] 2812                       ALLOW IN    Anywhere
[ 3] 22222                      ALLOW IN    Anywhere
[ 4] 11371                      ALLOW OUT   Anywhere                   (out)
[ 5] 80,443/tcp                 ALLOW IN    173.245.48.0/20            # Cloudflare IP
[ 6] 80,443/tcp                 ALLOW IN    103.21.244.0/22            # Cloudflare IP
[20] 22 (v6)                    ALLOW IN    Anywhere (v6)
[24] 80,443/tcp                 ALLOW IN    2400:cb00::/32             # Cloudflare IP
[25] 80,443/tcp                 ALLOW IN    2606:4700::/32             # Cloudflare IP
L
    check "$fn" "an all-ports operator allow reaches the web ports" "173.245.48.0/20 203.0.113.7" <<'L' || bad=1
Status: active
Anywhere                   ALLOW       203.0.113.7                # operator: office
22/tcp                     ALLOW       198.51.100.8
80,443/tcp                 ALLOW       173.245.48.0/20            # Cloudflare IP
L
    check "$fn" "UDP 443 alone is still open to everyone" "0.0.0.0/0" <<'L' || bad=1
Status: active
443/udp                    ALLOW       Anywhere
22                         ALLOW       Anywhere
L
    check "$fn" "web app profiles count, OpenSSH does not" "0.0.0.0/0 ::/0" <<'L' || bad=1
Status: active
OpenSSH                    ALLOW       Anywhere
Nginx Full                 ALLOW       Anywhere
Nginx Full (v6)            ALLOW       Anywhere (v6)
L
    check "$fn" "port ranges: only one that spans 80 or 443" "198.51.100.2" <<'L' || bad=1
Status: active
1000:2000/tcp              ALLOW       198.51.100.1
1:1024/tcp                 ALLOW       198.51.100.2
8000,8443/tcp              ALLOW       198.51.100.5
L
    check "$fn" "interface and destination address forms" "0.0.0.0/0 198.51.100.3" <<'L' || bad=1
Status: active
80/tcp on eth0             ALLOW       Anywhere
203.0.113.200 443/tcp      ALLOW       198.51.100.3
203.0.113.200 22           ALLOW       198.51.100.4
L
    check "$fn" "DENY, OUT and FWD do not open anything; LIMIT does" "198.51.100.9" <<'L' || bad=1
Status: active
80                         DENY        Anywhere
443                        ALLOW OUT   Anywhere
443                        ALLOW FWD   Anywhere
443/tcp                    LIMIT       198.51.100.9
L
    check "$fn" "IPv6 source with a comment" "2001:db8::/32" <<'L' || bad=1
Status: active
80,443/tcp                 ALLOW IN    2001:db8::/32              # Cloudflare IP
L
    check "$fn" "firewall off lists nothing" "" <<'L' || bad=1
Status: inactive
L
    return $bad
}

echo "web sources:"
run_cases "$T/fn.sh" || fail=1

# The 404 fallback: dropping the new argument must leave valid JSON behind.
echo "payload fallback:"
sed -n '/FW_PAYLOAD=\$(cat <<EOF/,/^EOF$/p' "$AGENT" | sed '1d;$d' > "$T/payload.tmpl"
TOKEN_FIELD='"p_token": "x",' SERVER_ID=1 UFW_ENABLED=true UFW_DENIED='[]' NGINX_DENIES='{}' UFW_ALLOWED='[]' \
F2B_IGNOREIP='[]' F2B_BANNED='{}' UFW_WEB='["0.0.0.0/0"]' F2B_PRESENT=true \
    bash -c 'eval "cat <<EOF
$(cat "$1")
EOF"' _ "$T/payload.tmpl" > "$T/payload.json"
ran=$((ran + 1))
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["p_ufw_web_sources"]==["0.0.0.0/0"]' "$T/payload.json" 2>/dev/null; then
    echo "  ok   full payload is valid JSON and carries p_ufw_web_sources"
else
    echo "  FAIL full payload"; fail=1
fi
ran=$((ran + 1))
if grep -v '"p_ufw_web_sources"' "$T/payload.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "p_ufw_web_sources" not in d and d["p_fail2ban_present"] is True' 2>/dev/null; then
    echo "  ok   payload without p_ufw_web_sources is still valid JSON"
else
    echo "  FAIL payload fallback"; fail=1
fi

# A check that cannot fail proves nothing: break the port test and expect failures.
echo "control (a broken copy must fail):"
sed 's/parts\[i\] + 0 == 443/parts[i] + 0 == 444/' "$T/fn.sh" > "$T/broken.sh"
if QUIET=1 run_cases "$T/broken.sh"; then
    echo "  FAIL the broken copy passed every case, so the cases cannot see a port mistake"; fail=1
else
    echo "  ok   the broken copy fails"
fi

echo
[ $fail -eq 0 ] && echo "PASS ($ran checks)" || echo "FAILED"
exit $fail
