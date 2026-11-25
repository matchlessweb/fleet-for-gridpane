#!/bin/bash
# ==============================================================================
# Site final copy: bring a moved site's copy up to date with the live site
# ==============================================================================
# The second pass of a two-pass move (see the top of fleet-site-hold.sh). The
# first pass (GridPane's own move) copied the site while it was open; this copies what
# changed since. Runs on the Mac and talks to both servers.
#
# Usage:
#   bash scripts/fleet-site-final-copy.sh <site> --from <server> --to <server> \
#        --files-since "2026-01-15 06:20:00" rehearse
#   bash scripts/fleet-site-final-copy.sh <site> --from <server> --to <server> \
#        --files-since "2026-01-15 06:20:00" final
#
#   rehearse  the whole copy now, with the site open. It proves the method and
#             gives the real duration. Safe to repeat.
#   final     the same copy, but it refuses to start unless the old server is
#             frozen (fleet-site-hold.sh <site> <old> freeze --live).
#
# <server> is a label from the server list (see lib-fleet-servers.sh), or
# an IPv4 address. --files-since is a UTC time a little before the first copy
# started: site files changed on the old server after it are sent again.
#
# BOTH MODES REPLACE THE DATABASE OF THE COPY on the --to server. That is the
# point, and it is why the --to server must not be serving the site yet: both
# modes refuse unless the copy's scheduled jobs are held there
# (fleet-site-hold.sh <site> <new> hold-jobs --live).
#
# What it does, in order:
#   1. checks each server has its address and the site, the copy's jobs are
#      held, and (final) the old server is frozen
#   2. new server: saves the copy's current database to a file (the way back)
#   3. old server: exports the database as one consistent snapshot, no locking
#   4. sends that file to the new server through this Mac, checks it arrived
#      intact, takes the old server's DEFINER out of views and triggers (the
#      site's database user may not create them for another account), loads it,
#      and stops if the load fails or a view is missing
#   5. sends site files changed on the old server since --files-since
#      (cache and log folders left out; more than 5000 files stops for a look)
#   6. new server: empties the object cache, then compares row counts on both
#      servers. In final mode they must MATCH before DNS moves.
#
# WHAT IT NEVER DOES: touch wp-config.php, nginx, DNS or Cloudflare, or change
# anything on the old server except writing the export under
# /root/<prefix>-site-copy/<site>. It prints counts only: no names, emails,
# addresses or order details.
#
# WP-CLI note: the export uses --no-tablespaces=true. A bare --no-tablespaces
# reaches mysqldump as --tablespaces= and the export fails.
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LIST_FROM="$HERE/lib-fleet-servers.sh"
[ -r "$LIST_FROM" ] || { echo "ABORT: cannot read $LIST_FROM"; exit 1; }
# shellcheck source=lib-fleet-servers.sh
. "$LIST_FROM"
# <prefix> is server.prefix in fleet.config.ts; this stops if it cannot be read.
# shellcheck source=lib-fleet-names.sh
. "$HERE/lib-fleet-names.sh"
# shellcheck source=lib-sql-definer.sh
. "$HERE/lib-sql-definer.sh"

s=""; FROM=""; TO=""; FILES_SINCE=""; MODE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --from) [ $# -ge 2 ] || { echo "--from needs a server"; exit 2; }; FROM="$2"; shift ;;
        --to) [ $# -ge 2 ] || { echo "--to needs a server"; exit 2; }; TO="$2"; shift ;;
        --files-since) [ $# -ge 2 ] || { echo "--files-since needs a UTC time"; exit 2; }; FILES_SINCE="$2"; shift ;;
        -*) echo "Unknown option: $1"; exit 2 ;;
        *) if [ -z "$s" ]; then s="$1"; elif [ -z "$MODE" ]; then MODE="$1"; else echo "Too many arguments: $1"; exit 2; fi ;;
    esac
    shift
done
if [ -z "$s" ] || [ -z "$FROM" ] || [ -z "$TO" ] || [ -z "$FILES_SINCE" ] || [ -z "$MODE" ]; then sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'; exit 2; fi
case "$MODE" in rehearse|final) ;; *) echo "Unknown mode: $MODE (use rehearse | final)"; exit 2 ;; esac
printf '%s' "$s" | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || { echo "\"$s\" is not a site name (want the folder name under /var/www, like shop.example.com)"; exit 2; }
printf '%s' "$FILES_SINCE" | grep -qE '^20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$' || { echo "--files-since wants a UTC time like \"2026-01-15 06:20:00\""; exit 2; }

resolve() {
    if printf '%s' "$1" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then printf '%s' "$1"
    else fleet_server_ip "$1"; fi
}
OLD=$(resolve "$FROM"); NEW=$(resolve "$TO")
[ -n "$OLD" ] || { echo "ABORT: \"$FROM\" is not in the server list and is not an IPv4 address."; exit 1; }
[ -n "$NEW" ] || { echo "ABORT: \"$TO\" is not in the server list and is not an IPv4 address."; exit 1; }
[ "$OLD" != "$NEW" ] || { echo "ABORT: --from and --to are the same server."; exit 1; }

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if ! ssh-add -l 2>/dev/null | grep -q "$KEY_FP" && [ -S "$OP_SOCK" ]; then export SSH_AUTH_SOCK="$OP_SOCK"; fi

slug=$(printf '%s' "$s" | tr '.' '-')
P=/var/www/$s/htdocs
JOBS=/etc/cron.d/gp-cron-$slug
UNIT=$FLEET_PREFIX-site-hold-$slug
D=/root/$FLEET_PREFIX-site-copy/$s
TS=$(date -u +%Y%m%dT%H%M%SZ)
. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSHO="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-fleet-%C -o ControlPersist=300 -o ServerAliveInterval=15"
# shellcheck disable=SC2086,SC2029  # SSHO is word-split on purpose; the commands are meant to expand here
old() { ssh $SSHO "root@$OLD" "$@"; }
# shellcheck disable=SC2086,SC2029
new() { ssh $SSHO "root@$NEW" "$@"; }
WP="wp --path=$P --allow-root --skip-plugins --skip-themes"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
step() { echo; echo "== $(date -u +%T) UTC  $*"; }
die() { echo "STOP: $*"; exit 1; }

echo "site:  $s"
echo "from:  $FROM ($OLD)   the live site"
echo "to:    $TO ($NEW)   the copy; ITS DATABASE IS REPLACED"
echo "mode:  $MODE"

step "1. checks"
# The first connection to each server. What ssh says about it goes to a file, so
# a server that answers with another host key is named in plain words and the
# script stops there. A file and not a pipe: the shared connection ssh leaves
# running for the next commands would hold a pipe open.
SSHERR=$(mktemp "${TMPDIR:-/tmp}/fleet-site-ssh.XXXXXX") || exit 1; trap 'rm -f "$SSHERR"' EXIT
has_ip() {
    local rc
    "$1" "hostname -I" < /dev/null 2>"$SSHERR" | tr ' ' '\n' | grep -qxF "$2"; rc=$?
    cat "$SSHERR" >&2
    if fleet_hostkey_refusal "$SSHERR" "$2"; then exit 1; fi
    return "$rc"
}
has_ip old "$OLD" || die "$FROM did not answer, or does not have the address $OLD"
has_ip new "$NEW" || die "$TO did not answer, or does not have the address $NEW"
old "[ -f /var/www/$s/wp-config.php ]" < /dev/null || die "$s is not on $FROM"
new "[ -f /var/www/$s/wp-config.php ]" < /dev/null || die "$s is not on $TO yet (run the first copy first)"
hold=$(new "systemctl is-active $UNIT; [ -e $JOBS ] && echo present || echo absent" < /dev/null | tr '\n' ' ')
echo "   $TO job hold: $hold"
[ "$hold" = "active absent " ] || die "scheduled jobs are not held on $TO (want: active absent). Run: bash scripts/fleet-site-hold.sh $s $TO hold-jobs --live"
frozen=$(old "curl -sk -o /dev/null -m 25 -A '$UA' -w '%{http_code}' --resolve $s:443:$OLD https://$s/; [ -e $JOBS ] && echo ' jobs-on' || echo ' jobs-off'" < /dev/null)
echo "   $FROM: home answers $frozen"
if [ "$MODE" = final ]; then [ "$frozen" = "503 jobs-off" ] || die "$FROM is not frozen (want: 503 jobs-off). Run: bash scripts/fleet-site-hold.sh $s $FROM freeze --live"; fi
echo "   free disk: $FROM $(old "df -h /root | awk 'NR==2{print \$4}'" < /dev/null), $TO $(new "df -h /root | awk 'NR==2{print \$4}'" < /dev/null)"

CNT=$(mktemp "${TMPDIR:-/tmp}/fleet-site-counts.XXXXXX"); trap 'rm -f "$CNT" "$SSHERR"' EXIT
cat > "$CNT" <<'PHP'
<?php
global $wpdb; $p = $wpdb->prefix; $g = function ($q) use ($wpdb) { return $wpdb->get_var($q); };
$has = function ($t) use ($wpdb) { return $wpdb->get_var($wpdb->prepare('show tables like %s', $wpdb->esc_like($t))) === $t; };
$o = 'users=' . $g("select count(*) from {$wpdb->users}")
   . ' usermeta=' . $g("select count(*) from {$wpdb->usermeta}")
   . ' posts=' . $g("select count(*) from {$p}posts")
   . ' highest_post_id=' . $g("select max(ID) from {$p}posts")
   . ' postmeta=' . $g("select count(*) from {$p}postmeta")
   . ' comments=' . $g("select count(*) from {$p}comments")
   . ' options=' . $g("select count(*) from {$p}options where option_name not like '\_transient\_%' and option_name not like '\_site\_transient\_%'");
if ($has("{$p}woocommerce_order_items")) {
    $o .= ' order_posts=' . $g("select count(*) from {$p}posts where post_type='shop_order'")
        . ' highest_order_post_id=' . $g("select coalesce(max(ID),0) from {$p}posts where post_type='shop_order'")
        . ' order_items=' . $g("select count(*) from {$p}woocommerce_order_items");
}
if ($has("{$p}wc_orders")) {
    $o .= ' wc_orders=' . $g("select count(*) from {$p}wc_orders") . ' highest_wc_order_id=' . $g("select coalesce(max(id),0) from {$p}wc_orders");
}
echo $o . ' tables=' . count($wpdb->get_col('show tables'))
   . ' last_post_change=' . str_replace(' ', '_', (string) $g("select max(post_modified_gmt) from {$p}posts"));
PHP
counts() { "$1" "$WP eval-file - 2>/dev/null" < "$CNT"; }
step "   counts before"
echo "   old: $(counts old)"
echo "   new: $(counts new)"

step "2. $TO: save the copy's current database first"
new "mkdir -p $D && chmod 700 $D && $WP db export - --single-transaction --quick --no-tablespaces=true 2>$D/before-$TS.err | gzip -1 > $D/before-import-$TS.sql.gz; echo \"   exit \${PIPESTATUS[0]}  size \$(du -h $D/before-import-$TS.sql.gz | cut -f1)  dump ends properly: \$(gunzip -c $D/before-import-$TS.sql.gz | tail -c 200 | grep -c 'Dump completed')\"" < /dev/null
new "gunzip -c $D/before-import-$TS.sql.gz | tail -c 200 | grep -q 'Dump completed'" < /dev/null || { new "head -5 $D/before-$TS.err | cut -c1-300 | sed 's/^/   error: /'" < /dev/null; die "could not save the copy's current database; nothing was loaded"; }

step "3. $FROM: export the database (one consistent snapshot, no locking)"
old "mkdir -p $D && chmod 700 $D && $WP db export - --single-transaction --quick --no-tablespaces=true 2>$D/final-$TS.err | gzip -1 > $D/final-$TS.sql.gz; echo \"   exit \${PIPESTATUS[0]}  size \$(du -h $D/final-$TS.sql.gz | cut -f1)  dump ends properly: \$(gunzip -c $D/final-$TS.sql.gz | tail -c 200 | grep -c 'Dump completed')  tables in it: \$(gunzip -c $D/final-$TS.sql.gz | grep -c '^CREATE TABLE')  drop-before-create lines: \$(gunzip -c $D/final-$TS.sql.gz | grep -c '^DROP TABLE IF EXISTS')\"" < /dev/null
old "gunzip -c $D/final-$TS.sql.gz | tail -c 200 | grep -q 'Dump completed' && [ \$(gunzip -c $D/final-$TS.sql.gz | grep -c '^DROP TABLE IF EXISTS') -ge 10 ]" < /dev/null || { old "head -5 $D/final-$TS.err | cut -c1-300 | sed 's/^/   error: /'" < /dev/null; die "the export on $FROM did not finish; nothing was loaded on $TO"; }
SNAP=$(date -u '+%F %T')

step "4. send it to $TO through this Mac, then load it"
old "cat $D/final-$TS.sql.gz" < /dev/null | new "cat > $D/final-$TS.sql.gz"
a=$(old "md5sum $D/final-$TS.sql.gz | cut -c1-32" < /dev/null); b=$(new "md5sum $D/final-$TS.sql.gz | cut -c1-32" < /dev/null)
[ -n "$a" ] && [ "$a" = "$b" ] || die "the file did not arrive intact on $TO (fingerprints differ); nothing was loaded"
echo "   arrived intact (fingerprints match)"
# Views, triggers and routines name the old server's database user as DEFINER, and
# the site's own user may not create them for another account (ERROR 1227). Take
# that clause out first, and load nothing if one is left. See lib-sql-definer.sh.
new "gunzip -c $D/final-$TS.sql.gz | sed -E $(printf %q "$FLEET_SQL_DEFINER_SED") | gzip -1 > $D/load-$TS.sql.gz && chmod 600 $D/load-$TS.sql.gz" < /dev/null || die "could not prepare the file to load on $TO; nothing was loaded"
dump=$(new "gunzip -c $D/load-$TS.sql.gz | grep -cE $(printf %q "$FLEET_SQL_DEFINER_LEFT"); gunzip -c $D/load-$TS.sql.gz | grep -c '^/\*!50001 VIEW '; gunzip -c $D/load-$TS.sql.gz | grep -c '/\*!50003 TRIGGER '" < /dev/null | tr '\n' ' ')
read -r left views triggers <<< "$dump"
echo "   in the export: ${views:-?} views, ${triggers:-?} triggers; DEFINER clauses left after removing them: ${left:-?}"
[ "${left:-x}" = 0 ] || die "a DEFINER clause is still in the file to load on $TO; nothing was loaded"
new "gunzip -c $D/load-$TS.sql.gz | $WP db import - 2>&1 | tail -3 | cut -c1-200; exit \${PIPESTATUS[1]}" < /dev/null \
    || die "the load on $TO stopped with an error (above). The copy may be part-loaded; it is not serving the site. The way back: gunzip -c $D/before-import-$TS.sql.gz | $WP db import -"
got=$(new "$WP db query 'select count(*) from information_schema.views where table_schema=database()' --skip-column-names 2>/dev/null" < /dev/null | tr -d '[:space:]')
echo "   views on the copy: ${got:-?} (the export has ${views:-?})"
[ "${got:-x}" = "${views:-y}" ] || die "the copy does not have every view in the export; look before going on"
new "$WP db check 2>&1 | grep -c 'OK\$' | sed 's/^/   tables that check OK on the copy: /'" < /dev/null

step "5. site files changed on $FROM since $FILES_SINCE UTC (cache and log folders left out)"
LIST="cd $P && find . -type f -newermt '$FILES_SINCE' ! -path './wp-content/cache/*' ! -path './wp-content/uploads/cache/*' ! -path './wp-content/uploads/wc-logs/*' ! -path './wp-content/uploads/fatal-error-notify/*' ! -name '*.log' -print0"
n=$(old "$LIST | tr -cd '\0' | wc -c" < /dev/null | tr -d ' ')
echo "   files to send: ${n:-unknown}"
old "$LIST | sed -z 's#^\./##' | xargs -0 -r -n1 dirname | sort | uniq -c | sort -rn | head -12 | sed 's/^/      /'" < /dev/null
case "${n:-x}" in
    ''|*[!0-9]*) echo "   CHECK: could not count the changed files; nothing sent." ;;
    0) echo "   nothing to send" ;;
    *) if [ "$n" -lt 5000 ]; then
           old "$LIST | tar -C $P --null -T - -czf -" < /dev/null | new "tar -C $P -xzf - --same-owner && echo '   unpacked on the copy'"
       else echo "   CHECK: that is more than expected; nothing sent. Look at the folders above before going on."; fi ;;
esac
new "echo \"   owner of htdocs: \$(stat -c %U $P)   files there not owned by the site user: \$(find $P -newermt '$FILES_SINCE' ! -user \$(stat -c %U $P) 2>/dev/null | wc -l)\"" < /dev/null

step "6. $TO: empty the object cache, then compare"
new "$WP cache flush 2>&1 | grep -iE 'success|error' | head -2 | sed 's/^/   object cache flush: /'; echo \"   object cache: \$(timeout 60 gp wp $s redis status 2>&1 | grep -iE '^(Status|Drop-in)' | tr '\n' ';')\"" < /dev/null
o=$(counts old); w=$(counts new)
echo "   old: $o"
echo "   new: $w"
RESULT=0
if [ -z "$o" ]; then echo "   CHECK: could not read the counts. Do NOT move DNS."; RESULT=1
elif [ "$o" = "$w" ]; then echo "   MATCH: the copy has exactly what $FROM had"
elif [ "$MODE" = rehearse ]; then echo "   DIFFERENT, which is normal in a rehearsal if the open site changed after the snapshot at $SNAP UTC. Compare the numbers: only small, later changes should differ."
else echo "   CHECK: counts differ with the site frozen. Do NOT move DNS."; RESULT=1; fi
PATHS="/ /wp-login.php /wp-json/"
case "$o" in *order_items=*) PATHS="/ /shop/ /cart/ /checkout/ /my-account/ /wp-json/" ;; esac
CHK=""
for p in $PATHS; do CHK="$CHK $p=\$(curl -sk -o /dev/null -m 40 -A '$UA' -w '%{http_code}' --resolve $s:443:$NEW https://$s$p)"; done
new "echo \"   page checks on the copy:$CHK   jobs still held: \$(systemctl is-active $UNIT) / \$([ -e $JOBS ] && echo PRESENT || echo absent)\"" < /dev/null
step "done ($MODE). Snapshot taken at about $SNAP UTC. Way back on $TO: $D/before-import-$TS.sql.gz"
echo "   Still to do by hand: clear the page cache for $s on $TO in the GridPane app."
[ "$MODE" = final ] && [ "$RESULT" = 0 ] && echo "   Then: bash scripts/fleet-site-hold.sh $s $TO release-jobs --live, and move DNS. Leave $FROM frozen."
exit "$RESULT"
