#!/bin/bash
# ==============================================================================
# Site hold: the program that runs ON a server. IT CHANGES THE SERVER.
# ==============================================================================
# Sent over ssh by fleet-site-hold.sh:  bash -s <mode> <site> <this server's IPv4>
#
#   status        read-only
#   hold-jobs     keep the site's scheduled jobs from running (the NEW server,
#                 before the first copy, so the copy sends no email or webhook)
#   release-jobs  stop holding and put the newest held job file back
#   freeze        every request to the site on THIS server gets a short
#                 "back in a few minutes" page (503), and its jobs stop
#                 (the OLD server, for the final copy)
#   unfreeze      undo freeze (only if the move is called off)
#
# How the jobs are held: a GridPane site's jobs run from one file,
# /etc/cron.d/gp-cron-<site with dots as dashes>. A small keeper moves that file
# into /root/__FLEET_PREFIX__-site-hold/<site>/ whenever it appears (GridPane puts it
# back by itself). WordPress's own cron stays off in wp-config, so with the file
# gone nothing scheduled runs. Nothing is deleted. The keeper does not survive a
# reboot: run the same mode again after one.
#
# How the freeze works: one file in the site's own nginx folder,
# __FLEET_PREFIX__-freeze-main-context.conf, holding `return 503`. nginx's config test
# runs before any change and again with the file in place; if that second test
# fails the file is taken out and the jobs are released, so nothing is left
# changed. nginx is reloaded, never restarted: a reload lets a request that is
# already running finish, so a payment in flight completes. The database and
# the site's files are not touched.
#
# Rules it keeps: it refuses to run unless this server has the address it was
# given; it prints status codes before and after; it prints no visitor address
# and no secret. The last line is site_hold_result=ok|check|stop.
#
# SITE_HOLD_ROOT is for the local test only (fleet-site-move-selftest.sh): it
# prefixes every path, and nginx, systemd and curl are stand-ins. There, nginx's
# test fails when a file under the root holds the word BROKEN, the keeper is one
# sweep plus a marker file, and the site answers 503 when the freeze file is
# there. It is empty on a server: ssh does not carry the caller's environment.
#
# The names written __LIKE_THIS__ are filled in by the sender from fleet.config.ts
# before this program is sent (scripts/lib-fleet-names.sh).
# ==============================================================================
set -u
export LC_ALL=C
MODE=${1:-status}; s=${2:-}; IP=${3:-}
R="${SITE_HOLD_ROOT:-}"
stop() { echo "STOP: $*; nothing changed"; echo "site_hold_result=stop"; exit 1; }
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) stop "this program arrived without its names filled in" ;; esac   # names-guard

printf '%s' "$s" | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || stop "\"$s\" is not a site name"
case "$s" in *..*) stop "\"$s\" is not a site name" ;; esac
printf '%s' "$IP" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || stop "\"$IP\" is not an IPv4 address"
case "$MODE" in status|hold-jobs|release-jobs|freeze|unfreeze) ;; *) stop "use: status | hold-jobs | release-jobs | freeze | unfreeze" ;; esac

slug=$(printf '%s' "$s" | tr '.' '-')
d=$R/var/www/$s
N=$d/nginx/__FLEET_PREFIX__-freeze-main-context.conf
F=$R/etc/cron.d/gp-cron-$slug
H=$R/root/__FLEET_PREFIX__-site-hold/$s
U=__FLEET_PREFIX__-site-hold-$slug
W=$H/watch.sh
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
now() { date -u +%Y%m%dT%H%M%SZ; }
newest_held() { ls "$H"/gp-cron-"$slug".* 2>/dev/null | sort | tail -1; }
held_count() { ls "$H" 2>/dev/null | grep -c "^gp-cron-$slug\."; }

if [ -n "$R" ]; then
    WHERE="test root"
    SETTLE=0
    nginx_ok() { ! grep -rqs BROKEN "$R/var/www" "$R/etc/nginx"; }
    nginx_reload() { :; }
    keeper_state() { [ -f "$H/keeper-on" ] && echo active || echo inactive; }
    keeper_start() { : > "$H/keeper-on"; if [ -e "$F" ]; then t=$(now); mv "$F" "$H/gp-cron-$slug.$t" && echo "$t held the job file" >> "$H/log"; fi; }
    keeper_stop() { rm -f "$H/keeper-on"; }
    code() { if [ -f "$N" ]; then printf 503; else printf 200; fi; }
    recent_jobs() { echo 0; }
else
    [ "$(id -u)" = 0 ] || stop "not running as root"
    hostname -I | tr ' ' '\n' | grep -qxF "$IP" || stop "this is $(hostname), which does not have the address $IP"
    WHERE=$(hostname)
    SETTLE=10
    nginx_ok() { nginx -t > /dev/null 2>&1; }
    nginx_reload() { nginx -s reload; sleep 2; }
    keeper_state() { systemctl is-active "$U" 2>/dev/null < /dev/null; }
    keeper_start() {
        cat > "$W" <<EOF
#!/bin/bash
# written by fleet-site-hold.remote.sh; keeps $s's job file out of /etc/cron.d
while :; do
    if [ -e "$F" ]; then t=\$(date -u +%Y%m%dT%H%M%SZ); mv "$F" "$H/gp-cron-$slug.\$t" && echo "\$t held the job file" >> "$H/log"; fi
    sleep 0.3
done
EOF
        chmod 700 "$W"; bash -n "$W" || return 1
        [ "$(keeper_state)" = active ] && return 0
        systemctl reset-failed "$U" 2>/dev/null < /dev/null
        systemd-run --quiet --unit="$U" --description="Hold $s scheduled jobs" --property=Restart=always /bin/bash "$W" < /dev/null || return 1
        sleep 1
    }
    keeper_stop() { systemctl stop "$U" 2>/dev/null < /dev/null; }
    code() { curl -sk -o /dev/null -m 25 -A "$UA" -w '%{http_code}' --resolve "$s:443:$IP" "https://$s$1" < /dev/null; }
    recent_jobs() { journalctl -u cron --since '-10 min' --no-pager 2>/dev/null < /dev/null | grep -cE "CMD .*(gp-cron-$slug|$s)"; }
fi
codes() { printf 'home=%s cart=%s checkout=%s admin-ajax=%s wp-json=%s login=%s' "$(code /)" "$(code /cart/)" "$(code /checkout/)" "$(code /wp-admin/admin-ajax.php)" "$(code /wp-json/)" "$(code /wp-login.php)"; }

status() {
    echo "== $(date -u '+%F %T') UTC on $WHERE, site $s"
    if [ -d "$d" ]; then
        echo "   freeze file in the site's nginx folder: $([ -f "$N" ] && echo present || echo absent)   nginx config test: $(nginx_ok && echo ok || echo FAILS)"
        echo "   the site answers here: $(codes)   (frozen = 503 everywhere)"
        echo "   WordPress cron switched off in wp-config (must be 1 or more): $(cat "$d/wp-config.php" "$d/user-configs.php" 2>/dev/null | grep -cE "DISABLE_WP_CRON'?, *true")"
    else
        echo "   the site is not on this server yet"
    fi
    echo "   job file in /etc/cron.d: $([ -e "$F" ] && echo "present (jobs run)" || echo "absent (held, or not created yet)")   keeper: $(keeper_state)   files held: $(held_count)"
    echo "   every file in /etc/cron.d naming this site: $(ls "$R/etc/cron.d" 2>/dev/null | grep -F -- "$slug" | tr '\n' ' ')"
    echo "   site jobs started by cron in the last 10 minutes: $(recent_jobs)"
}

hold_jobs() {
    mkdir -p "$H" && chmod 700 "$H" || return 1
    keeper_start || return 1
    [ "$(keeper_state)" = active ]
}
release_jobs() {
    L=$(newest_held)
    keeper_stop
    if [ -e "$F" ]; then echo "the job file is already in place; nothing restored"
    elif [ -n "$L" ]; then
        cp -p "$L" "$F" && chmod 644 "$F" && { [ -n "$R" ] || chown root:root "$F"; } && echo "restored $(basename "$L") to /etc/cron.d"
    else echo "CHECK: no held job file to put back. If the site should run jobs here, switch GP cron off and on for it in the GridPane app."; fi
}
finish() { echo "site_hold_result=$1"; [ "$1" = ok ]; exit $?; }

case "$MODE" in
status)
    status; echo "nothing was changed"; finish ok ;;
hold-jobs)
    hold_jobs || { echo "FAILED to start the keeper"; status; finish check; }
    status
    echo "OK: jobs are held for $s. The keeper does not survive a reboot: run hold-jobs again after one. Undo: release-jobs"
    finish ok ;;
release-jobs)
    release_jobs; status
    if [ "$(keeper_state)" != active ] && [ -e "$F" ]; then finish ok; else finish check; fi ;;
freeze)
    [ -d "$d/nginx" ] || stop "$s has no nginx folder on this server"
    nginx_ok || stop "nginx's config test fails before any change"
    echo "before: $(codes)"
    hold_jobs || { echo "FAILED to start the keeper; the freeze page was not added"; release_jobs; finish check; }
    if [ -f "$N" ]; then echo "freeze file already present"
    else
        cat > "$N" <<'EOF'
# __FLEET_BRAND__: site frozen for a move to a new server. Remove this file and reload nginx to undo.
default_type text/html;
add_header Retry-After 600 always;
add_header Cache-Control "no-store" always;
return 503 '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Back in a few minutes</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5"><h1>We will be right back</h1><p>The site is down for a few minutes of scheduled maintenance. Nothing in your account has changed. Please try again shortly.</p></body></html>';
EOF
        chmod 644 "$N"
        if nginx_ok; then nginx_reload
        else
            echo "STOP: nginx's config test failed WITH the freeze file, so it was removed again, nginx was not reloaded and the jobs were released:"
            [ -n "$R" ] || nginx -t 2>&1 | tail -3
            rm -f "$N"; release_jobs
            echo "   nginx config test now: $(nginx_ok && echo ok || echo FAILS)"
            finish stop
        fi
    fi
    sleep "$SETTLE"    # a request that was already running finishes during a reload
    echo "after:  $(codes)"
    status
    if [ "$(code /)" = 503 ] && [ ! -e "$F" ]; then echo "OK: $s is frozen on this server. Undo: unfreeze"; finish ok
    else echo "CHECK: not fully frozen (see above)"; finish check; fi ;;
unfreeze)
    echo "before: $(codes)"
    if [ -f "$N" ]; then
        mkdir -p "$H" && chmod 700 "$H"
        mv "$N" "$H/__FLEET_PREFIX__-freeze-main-context.conf.removed-$(now)"
        if nginx_ok; then nginx_reload; else echo "CHECK: nginx's config test fails after removing the freeze file; nginx NOT reloaded"; [ -n "$R" ] || nginx -t 2>&1 | tail -3; fi
    else echo "no freeze file here"; fi
    release_jobs
    echo "after:  $(codes)"
    status
    if [ ! -f "$N" ] && [ "$(code /)" != 503 ] && [ -e "$F" ]; then finish ok; else finish check; fi ;;
esac
