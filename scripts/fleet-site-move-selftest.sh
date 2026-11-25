#!/bin/bash
# Runs the server-side site-hold program against a made-up server on this
# machine and checks each mode does what it says and undoes cleanly, and that
# the two operator-side scripts refuse bad input before they reach a server.
# Run: bash scripts/fleet-site-move-selftest.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
S=shop.example; SLUG=shop-example; IP=203.0.113.7
# The server program carries placeholders for the names it installs under. Fill
# them in as the sender does; the names come from fleet.config.ts, or from the
# environment.
. "$HERE/lib-fleet-names.sh"
REMOTE="$T/hold.remote.sh"
fleet_names_script "$HERE/fleet-site-hold.remote.sh" > "$REMOTE" || exit 1
# A server list of its own, so the operator-side checks at the end need no real one.
printf '203.0.113.21|10001|web1\n203.0.113.22|10002|web2\n' > "$T/servers"
export FLEET_SERVERS_FILE="$T/servers"
N="$T/var/www/$S/nginx/$FLEET_PREFIX-freeze-main-context.conf"
F="$T/etc/cron.d/gp-cron-$SLUG"
H="$T/root/$FLEET_PREFIX-site-hold/$S"
fail=0; ran=0
t() { ran=$((ran + 1)); if [ "$2" = "1" ]; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
yes() { if "$@" > /dev/null 2>&1; then echo 1; else echo 0; fi; }
no() { if "$@" > /dev/null 2>&1; then echo 0; else echo 1; fi; }
has() { grep -q -- "$1" "$T/out" && echo 1 || echo 0; }
run() { SITE_HOLD_ROOT="$T" bash "$REMOTE" "$@" > "$T/out" 2>&1; echo $? > "$T/rc"; }
rc() { cat "$T/rc"; }
tree() { (cd "$T" && find var etc root -type f 2>/dev/null | sort | while read -r f; do printf '%s %s\n' "$f" "$(cksum < "$f")"; done); }

mkdir -p "$T/var/www/$S/nginx" "$T/etc/cron.d" "$T/etc/nginx" "$T/root"
echo "<?php define('DISABLE_WP_CRON', true);" > "$T/var/www/$S/wp-config.php"
echo "*/5 * * * * root gp-cron $S" > "$F"
echo "0 3 * * * root other" > "$T/etc/cron.d/gp-cron-other-example"

echo "status"
before=$(tree); run status "$S" "$IP"
t "status exits 0 and says ok" "$([ "$(rc)" = 0 ] && has '^site_hold_result=ok$')"
t "status changes nothing" "$([ "$before" = "$(tree)" ] && echo 1 || echo 0)"
t "status reads WordPress cron as off" "$(has 'must be 1 or more): 1$')"

echo "refusals"
before=$(tree)
run freeze "../etc" "$IP";        t "a path as the site name is refused" "$([ "$(rc)" != 0 ] && has '^site_hold_result=stop$')"
run freeze "a..b" "$IP";          t "a name with two dots in a row is refused" "$(has '^site_hold_result=stop$')"
run freeze "$S" "not-an-ip";      t "a bad address is refused" "$(has '^site_hold_result=stop$')"
run explode "$S" "$IP";           t "an unknown mode is refused" "$(has '^site_hold_result=stop$')"
run freeze "missing.example" "$IP"; t "freeze refuses a site that is not on the server" "$(has '^site_hold_result=stop$')"
t "none of the refusals changed anything" "$([ "$before" = "$(tree)" ] && echo 1 || echo 0)"

echo "hold-jobs and release-jobs"
run hold-jobs "$S" "$IP"
t "hold-jobs says ok" "$(has '^site_hold_result=ok$')"
t "the job file left /etc/cron.d" "$(no test -e "$F")"
t "the job file is kept, not deleted" "$([ "$(ls "$H" | grep -c "^gp-cron-$SLUG\.")" = 1 ] && echo 1 || echo 0)"
t "another site's job file is untouched" "$(yes test -f "$T/etc/cron.d/gp-cron-other-example")"
run hold-jobs "missing.example" "$IP"
t "hold-jobs works before the site exists (new server, before the first copy)" "$(has '^site_hold_result=ok$')"
run release-jobs "$S" "$IP"
t "release-jobs says ok" "$(has '^site_hold_result=ok$')"
t "the job file is back with its content" "$(yes grep -q "gp-cron $S" "$F")"

echo "freeze and unfreeze"
run freeze "$S" "$IP"
t "freeze says ok" "$([ "$(rc)" = 0 ] && has '^site_hold_result=ok$')"
t "the freeze file is in the site's nginx folder" "$(yes grep -q 'return 503' "$N")"
t "before shows 200 and after shows 503" "$([ "$(has '^before: home=200')" = 1 ] && [ "$(has '^after:  home=503')" = 1 ] && echo 1 || echo 0)"
t "freeze also stopped the jobs" "$(no test -e "$F")"
run freeze "$S" "$IP"
t "freeze twice is safe" "$([ "$(has 'freeze file already present')" = 1 ] && [ "$(has '^site_hold_result=ok$')" = 1 ] && echo 1 || echo 0)"
run unfreeze "$S" "$IP"
t "unfreeze says ok" "$(has '^site_hold_result=ok$')"
t "the freeze file is gone and kept aside" "$([ ! -e "$N" ] && [ "$(ls "$H" | grep -c 'conf.removed-')" = 1 ] && echo 1 || echo 0)"
t "the job file is back after unfreeze" "$(yes test -f "$F")"

echo "nginx's config test fails"
echo "BROKEN" > "$T/etc/nginx/nginx.conf"; before=$(tree)
run freeze "$S" "$IP"
t "freeze refuses when the test already fails" "$(has '^site_hold_result=stop$')"
t "and changes nothing" "$([ "$before" = "$(tree)" ] && echo 1 || echo 0)"
rm "$T/etc/nginx/nginx.conf"
# A test that passes before and fails with the freeze file: the stand-in fails on the word BROKEN, so make the
# freeze page itself carry it for this one run.
sed "s/$FLEET_BRAND: site frozen/BROKEN $FLEET_BRAND: site frozen/" "$REMOTE" > "$T/broken-remote.sh"
cmp -s "$REMOTE" "$T/broken-remote.sh" && { echo "  FAIL the line to break is no longer in the server program"; fail=1; }
SITE_HOLD_ROOT="$T" bash "$T/broken-remote.sh" freeze "$S" "$IP" > "$T/out" 2>&1; echo $? > "$T/rc"
t "a freeze file that breaks nginx is reported" "$([ "$(rc)" != 0 ] && has '^site_hold_result=stop$')"
t "that freeze file is taken out again" "$(no test -e "$N")"
t "and the jobs are released" "$(yes test -f "$F")"

echo "sent without its names, the server program refuses to run"
SITE_HOLD_ROOT="$T" bash "$HERE/fleet-site-hold.remote.sh" status "$S" "$IP" > "$T/out" 2>&1; echo $? > "$T/rc"
t "it stops and says why" "$([ "$(rc)" != 0 ] && [ "$(has 'arrived without its names filled in')" = 1 ] && has '^site_hold_result=stop$')"

echo "the Mac-side scripts refuse bad input"
bash "$HERE/fleet-site-hold.sh" "bad name" web1 status > "$T/out" 2>&1;          t "hold: a bad site name" "$(has 'is not a site name')"
bash "$HERE/fleet-site-hold.sh" shop.example no-such-server status > "$T/out" 2>&1; t "hold: an unknown server" "$(has 'not in the server list')"
bash "$HERE/fleet-site-hold.sh" shop.example web1 explode > "$T/out" 2>&1;        t "hold: an unknown action" "$(has 'Unknown action')"
bash "$HERE/fleet-site-final-copy.sh" shop.example --from web1 --to web1 --files-since "2026-01-15 06:20:00" rehearse > "$T/out" 2>&1
t "final copy: the same server twice" "$(has 'are the same server')"
bash "$HERE/fleet-site-final-copy.sh" shop.example --from web1 --to web2 --files-since "yesterday" rehearse > "$T/out" 2>&1
t "final copy: a time that is not a UTC time" "$(has 'wants a UTC time')"
bash "$HERE/fleet-site-final-copy.sh" shop.example --from web1 --to web2 --files-since "2026-01-15 06:20:00" explode > "$T/out" 2>&1
t "final copy: an unknown mode" "$(has 'Unknown mode')"
bash "$HERE/fleet-site-final-copy.sh" shop.example --from web1 --to web2 rehearse > "$T/out" 2>&1
t "final copy: no --files-since prints the usage" "$(has 'BOTH MODES REPLACE THE DATABASE')"

echo "final copy: the old server's DEFINER is taken out before the load"
# shellcheck source=lib-sql-definer.sh
. "$HERE/lib-sql-definer.sh"
# The lines mysqldump writes for a view, a trigger and a routine, and a row whose
# data happens to mention DEFINER. Names are made up.
cat > "$T/dump.sql" <<'SQL'
INSERT INTO `wp_posts` VALUES (1,'how to set DEFINER=`x`@`y` in a view');
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`old_user`@`localhost` SQL SECURITY INVOKER */
/*!50001 VIEW `wp_report` AS select 1 AS `a` */;
/*!50013 DEFINER=`old_user`@`%` SQL SECURITY DEFINER */
/*!50003 CREATE*/ /*!50017 DEFINER=`old_user`@`localhost`*/ /*!50003 TRIGGER `t1` BEFORE INSERT ON `wp_x` FOR EACH ROW SET NEW.a = 1 */;;
/*!50003 CREATE*/ /*!50020 DEFINER=`old_user`@`localhost`*/ /*!50003 PROCEDURE `p1`() SELECT 1 */;;
SQL
sed -E "$FLEET_SQL_DEFINER_SED" "$T/dump.sql" > "$T/load.sql"
n=$(grep -cE "$FLEET_SQL_DEFINER_LEFT" "$T/dump.sql"); left=$(grep -cE "$FLEET_SQL_DEFINER_LEFT" "$T/load.sql")
t "the check finds all four in the export (it can see them)" "$([ "$n" = 4 ] && echo 1 || echo 0)"
t "none is left after the sed" "$([ "$left" = 0 ] && echo 1 || echo 0)"
t "a view keeps SQL SECURITY INVOKER" "$(grep -qxF '/*!50013 SQL SECURITY INVOKER */' "$T/load.sql" && echo 1 || echo 0)"
t "a view keeps SQL SECURITY DEFINER" "$(grep -qxF '/*!50013 SQL SECURITY DEFINER */' "$T/load.sql" && echo 1 || echo 0)"
t "a trigger loses only the clause" "$(grep -qF '/*!50003 CREATE*/ /*!50003 TRIGGER `t1` BEFORE' "$T/load.sql" && echo 1 || echo 0)"
t "a routine loses only the clause" "$(grep -qF '/*!50003 CREATE*/ /*!50003 PROCEDURE `p1`()' "$T/load.sql" && echo 1 || echo 0)"
t "row data that mentions DEFINER is untouched" "$([ "$(head -1 "$T/dump.sql")" = "$(head -1 "$T/load.sql")" ] && echo 1 || echo 0)"
t "nothing else changed (same line count)" "$([ "$(wc -l < "$T/dump.sql")" = "$(wc -l < "$T/load.sql")" ] && echo 1 || echo 0)"

echo
if [ "$fail" = 0 ]; then echo "PASS: $ran checks"; else echo "FAILED (of $ran checks)"; fi
exit "$fail"
