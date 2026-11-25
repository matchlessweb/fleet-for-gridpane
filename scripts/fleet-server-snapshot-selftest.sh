#!/bin/bash
# ==============================================================================
# Server snapshot and restore — local test. Touches no server.
# ==============================================================================
# Builds a pretend server in a scratch folder, snapshots it (SNAP_ROOT), then
# checks the things that must never go wrong:
#   * no credential leaves the server, and a secret-shaped file is withheld
#   * a cut-off or altered answer is refused
#   * the comparison says "nothing to do" only when that is true, and blocks a
#     restore when a site is missing or nginx is already failing
#   * the restore program installs only missing files in allowed places, never
#     overwrites, and takes out an nginx file that breaks the config test
#
#   bash scripts/fleet-server-snapshot-selftest.sh
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SNAP="$HERE/fleet-server-snapshot.remote.sh"; REST="$HERE/fleet-server-restore.remote.sh"; LIB="$HERE/fleet-server-snapshot-lib.py"
T=$(mktemp -d "${TMPDIR:-/tmp}/fleet-snapshot-selftest.XXXXXX")
trap 'rm -rf "$T"' EXIT
# The two server programs carry placeholders for the names they look for. Fill
# them in as the senders do; the names come from fleet.config.ts, or from the
# environment. The unfilled files are kept to prove they refuse to run.
. "$HERE/lib-fleet-names.sh"
RAW_SNAP="$SNAP"; RAW_REST="$REST"
fleet_names_script "$RAW_SNAP" > "$T/snapshot.remote.sh" || exit 1
fleet_names_script "$RAW_REST" > "$T/restore.remote.sh" || exit 1
SNAP="$T/snapshot.remote.sh"; REST="$T/restore.remote.sh"
pass=0; fail=0
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
no() { fail=$((fail + 1)); echo "  FAIL  $1"; }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }   # check <name> <shell test>

TOKEN="cfut_SELFTESTTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
GLOBALKEY="0a1b2c0a1b2c0a1b2c0a1b2c0a1b2c0a1b2c0"
AGENT="agt_SELFTESTAGENTTOKENBBBBBBBBBBBBBBBBBBBBBB"
STRAY="xyz_STRAYSECRETCCCCCCCCCCCCCCCCCCCCCCCCCC"

build() { # build <root>: a pretend server
    local r="$1"
    mkdir -p "$r/etc/fail2ban/jail.d" "$r/etc/fail2ban/filter.d" "$r/etc/fail2ban/action.d" \
             "$r/etc/nginx/extra.d/_custom" "$r/etc/logrotate.d" "$r/etc/ufw" "$r/etc/php/8.3/fpm/conf.d" "$r/root" \
             "$r/var/www/shop.example/htdocs/wp-content/mu-plugins" "$r/var/www/shop.example/nginx" \
             "$r/var/www/blog.example/htdocs" "$r/var/www/blog.example/nginx" "$r/var/www/22222/htdocs"
    printf '%s\n' "$TOKEN" > "$r/etc/fail2ban/${FLEET_PREFIX}-cloudflare.token"
    printf 'cfuser = someone@example.com\ncftoken = %s\n' "$GLOBALKEY" > "$r/etc/fail2ban/action.d/gpcloudflare.conf"
    printf 'SERVER_ID="12345"\nAGENT_TOKEN="%s"\n' "$AGENT" > "$r/root/telemetry-agent.sh"
    printf '[DEFAULT]\nignoreip = 127.0.0.1/8 203.0.113.9\n' > "$r/etc/fail2ban/jail.d/${FLEET_PREFIX}-allowlist.local"
    printf '[%s-shopexample-ab12-h]\nenabled = true\n' "$FLEET_JAIL_PREFIX" > "$r/etc/fail2ban/jail.d/${FLEET_PREFIX}-cloudflare.local"
    printf '[Definition]\nfailregex = x\n' > "$r/etc/fail2ban/filter.d/${FLEET_JAIL_PREFIX}-shopexample-ab12-h.conf"
    printf '[Definition]\nfailregex = stock\n' > "$r/etc/fail2ban/filter.d/sshd.conf"
    printf 'location = /.well-known/x { try_files $uri /index.php; }\n' > "$r/etc/nginx/extra.d/acme-wellknown-main-context.conf"
    printf 'set $ok 1;\n' > "$r/etc/nginx/extra.d/_custom/note with space.conf"
    printf '# upstream_api_key = %s\n' "$STRAY" > "$r/etc/nginx/extra.d/has-a-key-main-context.conf"
    printf '/var/log/nginx/7g.log { weekly }\n' > "$r/etc/logrotate.d/${FLEET_PREFIX}-7g"
    printf -- '-A ufw-user-input -p tcp --dport 22 -j ACCEPT\n' > "$r/etc/ufw/user.rules"
    printf 'opcache.memory_consumption = 512\nopcache.interned_strings_buffer=64\n' > "$r/etc/php/8.3/fpm/conf.d/10-opcache.ini"
    : > "$r/var/www/shop.example/wp-config.php"; : > "$r/var/www/blog.example/wp-config.php"
    : > "$r/var/www/shop.example/htdocs/wp-content/mu-plugins/wp-fail2ban.php"
    printf 'include x;\n' > "$r/var/www/shop.example/nginx/a-main-context.conf"
}
snap() { SNAP_ROOT="$1" bash "$SNAP" > "$2/raw.txt" 2>/dev/null; python3 "$LIB" unpack "$2/raw.txt" "$2" > "$2/unpack.txt" 2>&1; }

echo "1. Snapshot of a pretend server"
build "$T/old"; mkdir "$T/s-old"; snap "$T/old" "$T/s-old"; RC=$?
check "unpack succeeds and reports complete" '[ $RC = 0 ] && grep -q "^complete=yes" "$T/s-old/unpack.txt"'
for pair in "Cloudflare token:$TOKEN" "old global key:$GLOBALKEY" "telemetry agent token:$AGENT" "stray key in an nginx file:$STRAY"; do
    name="${pair%%:*}"; val="${pair#*:}"
    B64=$(printf '%s' "$val" | base64 | cut -c1-24)
    check "$name is nowhere in the snapshot folder" '! grep -rqF -e "$val" -e "$B64" "$T/s-old"'
done
check "the secret-shaped nginx file is listed as withheld" 'grep -q "^withheld /etc/nginx/extra.d/has-a-key-main-context.conf (was restore)" "$T/s-old/unpack.txt"'
check "four files are recorded by hash only (three credentials and the withheld one)" 'grep -q "record=4" "$T/s-old/unpack.txt"'
check "a path with a space round-trips" '[ -f "$T/s-old/files/etc/nginx/extra.d/_custom/note with space.conf" ]'
check "saved files are private (600)" '[ "$(stat -f %Lp "$T/s-old/files/etc/logrotate.d/${FLEET_PREFIX}-7g" 2>/dev/null || stat -c %a "$T/s-old/files/etc/logrotate.d/${FLEET_PREFIX}-7g")" = 600 ]'
check "stock Fail2Ban filter is not captured, ours is" '! grep -q "filter.d/sshd.conf" "$T/s-old/raw.txt" && grep -q "filter.d/${FLEET_JAIL_PREFIX}-shopexample-ab12-h.conf" "$T/s-old/raw.txt"'
check "GridPane's own folder is not a WordPress site" 'grep -q "^site name=22222 wordpress=no" "$T/s-old/facts.txt"'
check "PHP tuning is read" 'grep -q "^php version=8.3 opcache_memory=512 interned_strings=64" "$T/s-old/facts.txt"'

check "sent without its names, the snapshot program refuses to run" '[ "$(SNAP_ROOT="$T/old" bash "$RAW_SNAP" 2>&1 | head -1 | grep -c "^abort=this program arrived without its names")" = 1 ]'
check "sent without its names, the restore program refuses to run" '[ "$(RESTORE_ROOT="$T/old" bash "$RAW_REST" 2>&1 | head -1 | grep -c "^abort=this program arrived without its names")" = 1 ]'

echo "2. A damaged answer is refused"
mkdir "$T/cut"; sed '$d' "$T/s-old/raw.txt" > "$T/cut/raw.txt"
python3 "$LIB" unpack "$T/cut/raw.txt" "$T/cut" > "$T/cut/unpack.txt" 2>&1; RC=$?
check "a cut-off answer fails" '[ $RC != 0 ] && grep -q "^complete=NO" "$T/cut/unpack.txt"'
mkdir "$T/alt"; python3 - "$T/s-old/raw.txt" "$T/alt/raw.txt" <<'PY'
import base64, os, sys
L = open(sys.argv[1]).read().split("\n")
i = next(n for n, l in enumerate(L) if l == "data path=/etc/logrotate.d/%s-7g" % os.environ["FLEET_PREFIX"])
L[i + 1] = base64.b64encode(b"changed in transit\n").decode()
open(sys.argv[2], "w").write("\n".join(L))
PY
python3 "$LIB" unpack "$T/alt/raw.txt" "$T/alt" > "$T/alt/unpack.txt" 2>&1; RC=$?
check "altered content fails its hash" '[ $RC != 0 ] && grep -q "^BAD /etc/logrotate.d/${FLEET_PREFIX}-7g" "$T/alt/unpack.txt"'

echo "3. Comparison"
python3 "$LIB" compare "$T/s-old" "$T/s-old" --plan "$T/p0.json" > "$T/c0.txt"; RC=$?
check "a server compared with itself: nothing to do (exit 0)" '[ $RC = 0 ] && grep -q "nothing to do" "$T/c0.txt"'

build "$T/new"                                   # the moved server: three hand-added files did not come across
rm "$T/new/etc/nginx/extra.d/acme-wellknown-main-context.conf" "$T/new/etc/logrotate.d/${FLEET_PREFIX}-7g" \
   "$T/new/etc/nginx/extra.d/_custom/note with space.conf" "$T/new/etc/nginx/extra.d/has-a-key-main-context.conf"
printf '[DEFAULT]\nignoreip = 127.0.0.1/8\n' > "$T/new/etc/fail2ban/jail.d/${FLEET_PREFIX}-allowlist.local"
mkdir "$T/s-new"; snap "$T/new" "$T/s-new"
python3 "$LIB" compare "$T/s-old" "$T/s-new" --plan "$T/p1.json" > "$T/c1.txt"; RC=$?
check "missing files: exit 10 and three files planned" '[ $RC = 10 ] && [ "$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))[\"install\"]))" "$T/p1.json")" = 3 ]'
check "a different file is left alone, not planned" 'grep -q "DIFFERS, left alone: /etc/fail2ban/jail.d/${FLEET_PREFIX}-allowlist.local" "$T/c1.txt" && ! grep -q "${FLEET_PREFIX}-allowlist" "$T/p1.json"'
check "the withheld file is named as a hand copy" 'grep -q "CANNOT RESTORE /etc/nginx/extra.d/has-a-key-main-context.conf" "$T/c1.txt"'
check "the comparison prints no file content" '! grep -qF -e "try_files" -e "ignoreip" "$T/c1.txt"'

rm -rf "$T/new/var/www/blog.example"; mkdir "$T/s-gone"; snap "$T/new" "$T/s-gone"
python3 "$LIB" compare "$T/s-old" "$T/s-gone" > "$T/c2.txt"; RC=$?
check "a WordPress site missing on the target blocks (exit 20)" '[ $RC = 20 ] && grep -q "BLOCKED: 1 site" "$T/c2.txt"'
mkdir "$T/s-ngx"; cp "$T/s-new/manifest.json" "$T/s-ngx/"; { cat "$T/s-new/facts.txt"; echo "nginx_config_test=FAILED"; } > "$T/s-ngx/facts.txt"
python3 "$LIB" compare "$T/s-old" "$T/s-ngx" > "$T/c3.txt"; RC=$?
check "a target whose nginx test already fails blocks (exit 20)" '[ $RC = 20 ] && grep -q "BLOCKED: nginx" "$T/c3.txt"'

echo "4. The restore program (run against a scratch folder)"
python3 "$LIB" program "$T/p1.json" "$REST" > "$T/restore.sh"; RC=$?
check "the program is built and is valid bash" '[ $RC = 0 ] && bash -n "$T/restore.sh" && [ "$(grep -c "^PLAN|" "$T/restore.sh")" = 3 ]'
check "the unfilled program installs nothing" '[ "$(RESTORE_ROOT="$T/empty" bash "$REST" 2>&1 | grep -c "^installed=0 skipped=0 failed=0")" = 1 ]'
# fed on standard input, exactly as ssh delivers it
RESTORE_ROOT="$T/new" bash -s < "$T/restore.sh" > "$T/r1.txt" 2>&1
check "three files installed, run complete" 'grep -q "^installed=3 skipped=0 failed=0" "$T/r1.txt" && grep -q "^restore_complete=yes" "$T/r1.txt"'
check "installed content is identical to the original" 'cmp -s "$T/old/etc/nginx/extra.d/_custom/note with space.conf" "$T/new/etc/nginx/extra.d/_custom/note with space.conf" && cmp -s "$T/old/etc/logrotate.d/${FLEET_PREFIX}-7g" "$T/new/etc/logrotate.d/${FLEET_PREFIX}-7g"'
check "the different file was not overwritten" '! grep -q 203.0.113.9 "$T/new/etc/fail2ban/jail.d/${FLEET_PREFIX}-allowlist.local"'
mkdir "$T/s-after"; snap "$T/new" "$T/s-after"
python3 "$LIB" compare "$T/s-old" "$T/s-after" --plan "$T/p2.json" > /dev/null
check "a second comparison plans nothing more" '[ "$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))[\"install\"]))" "$T/p2.json")" = 0 ]'
RESTORE_ROOT="$T/new" bash -s < "$T/restore.sh" > "$T/r2.txt" 2>&1
check "running it again skips all three (never overwrites)" 'grep -q "^installed=0 skipped=3 failed=0" "$T/r2.txt"'

mkdir -p "$T/bad"; B=$(printf 'BROKEN directive;\n' | base64); H=$(printf 'BROKEN directive;\n' | shasum -a 256 | cut -d' ' -f1)
G=$(printf 'fine;\n' | base64); GH=$(printf 'fine;\n' | shasum -a 256 | cut -d' ' -f1)
{
    echo "PLAN|/etc/nginx/extra.d/bad-main-context.conf|644|root:root|$H|$B"
    echo "PLAN|/etc/nginx/extra.d/good-main-context.conf|644|root:root|$GH|$G"
    echo "PLAN|/etc/cron.d/evil|644|root:root|$GH|$G"
    echo "PLAN|/etc/nginx/extra.d/../../passwd|644|root:root|$GH|$G"
    echo "PLAN|/etc/nginx/extra.d/wrong-hash.conf|644|root:root|$H|$G"
} > "$T/planlines"
python3 - "$REST" "$T/planlines" > "$T/restore-bad.sh" <<'PY'
import sys
sys.stdout.write(open(sys.argv[1]).read().replace("\n__PLAN_LINES__\n", "\n" + open(sys.argv[2]).read()))
PY
RESTORE_ROOT="$T/bad" bash -s < "$T/restore-bad.sh" > "$T/r3.txt" 2>&1
check "an nginx file that breaks the config test is taken out again" 'grep -q "bad-main-context.conf reason=nginx-test-failed-with-it removed=yes" "$T/r3.txt" && [ ! -e "$T/bad/etc/nginx/extra.d/bad-main-context.conf" ]'
check "the good file after it still goes in" '[ -f "$T/bad/etc/nginx/extra.d/good-main-context.conf" ]'
check "a path outside the allowed places is refused" 'grep -q "refused path=/etc/cron.d/evil" "$T/r3.txt" && [ ! -e "$T/bad/etc/cron.d" ]'
check "a path with .. is refused" 'grep -q "refused path=/etc/nginx/extra.d/../../passwd" "$T/r3.txt" && [ ! -e "$T/bad/etc/passwd" ]'
check "content that does not match its hash is not written" 'grep -q "wrong-hash.conf reason=content-does-not-match-its-hash" "$T/r3.txt" && [ ! -e "$T/bad/etc/nginx/extra.d/wrong-hash.conf" ]'
check "counts add up: 1 installed, 4 failed" 'grep -q "^installed=1 skipped=0 failed=4" "$T/r3.txt"'
check "no temporary file is left behind" '[ -z "$(find "$T/bad" "$T/new" -name "*.${FLEET_PREFIX}-restore.*")" ]'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
