#!/bin/bash
# ==============================================================================
# Server restore — the program that runs ON the target server. IT WRITES FILES.
# ==============================================================================
# Sent over ssh by fleet-server-restore.sh --live, with the list of files to put
# back filled in as PLAN lines (PLAN|path|mode|owner|sha256|base64 content).
# The list holds only small hand-added files that are MISSING on this server.
#
# Rules it keeps:
#   * It never overwrites. A path that exists by the time it runs is skipped.
#   * Every file is checked against its hash before and after it is written.
#   * An nginx file is tested alone: write it, run `nginx -t`, and if the test
#     fails take that one file out again. One bad file does not stop the others,
#     and nginx is never reloaded on a failed test and never restarted.
#   * nginx is reloaded once at the end, only if a file went in and the final
#     test passes.
#   * Fail2Ban is not reloaded here. fleet-fail2ban-apply.sh does that when it
#     rebuilds the jails.
# Output is key=value lines the caller checks; the last one is restore_complete.
#
# RESTORE_ROOT is for the local test only (fleet-server-snapshot-selftest.sh): it
# prefixes every path written, so the program can run against a scratch folder
# with no root and no nginx. There, the nginx test is a stand-in that fails when
# any file under etc/nginx holds the word BROKEN, and nothing is reloaded. It is
# empty on a server: ssh does not carry the caller's environment across.
#
# The names written __LIKE_THIS__ are filled in by the sender from fleet.config.ts
# before this program is sent (scripts/lib-fleet-names.sh).
# ==============================================================================
set -u
export LC_ALL=C
R="${RESTORE_ROOT:-}"
# Sent without its names filled in, it stops here.
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) echo "abort=this program arrived without its names filled in; nothing was changed"; echo "restore_complete=no"; exit 1 ;; esac   # names-guard
sha() { if command -v sha256sum > /dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1; else shasum -a 256 < "$1" | cut -d' ' -f1; fi; }
if [ -n "$R" ]; then
    nginx_ok() { ! grep -rqs BROKEN "$R/etc/nginx"; }
else
    nginx_ok() { nginx -t > /dev/null 2>&1; }
    [ "$(id -u)" = 0 ] || { echo "abort=not-root"; exit 1; }
fi
if ! nginx_ok; then echo "abort=nginx-test-already-failing"; echo "restore_complete=no"; exit 1; fi

installed=0; skipped=0; failed=0; nginx_added=0
while IFS='|' read -r tag path mode owner want b64; do
    [ "$tag" = PLAN ] || continue
    case "$path" in
        /etc/nginx/extra.d/*|/etc/logrotate.d/__FLEET_PREFIX__-*|/etc/fail2ban/jail.d/__FLEET_PREFIX__-allowlist.local) ;;
        *) echo "refused path=$path reason=not-a-restorable-location"; failed=$((failed + 1)); continue ;;
    esac
    case "$path" in *..*) echo "refused path=$path reason=dots"; failed=$((failed + 1)); continue ;; esac
    real="$R$path"
    if [ -e "$real" ] || [ -L "$real" ]; then echo "skipped path=$path reason=exists-now"; skipped=$((skipped + 1)); continue; fi
    dir=$(dirname "$real")
    [ -d "$dir" ] || mkdir -p "$dir"
    tmp="$real.__FLEET_PREFIX__-restore.$$"
    if ! printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null || [ "$(sha "$tmp")" != "$want" ]; then
        rm -f "$tmp"; echo "failed path=$path reason=content-does-not-match-its-hash"; failed=$((failed + 1)); continue
    fi
    chmod "$mode" "$tmp"
    [ -n "$R" ] || chown "$owner" "$tmp" 2>/dev/null || chown root:root "$tmp"
    mv "$tmp" "$real"
    case "$path" in
        /etc/nginx/*)
            if nginx_ok; then
                echo "installed path=$path nginx_test=ok"; installed=$((installed + 1)); nginx_added=$((nginx_added + 1))
            else
                rm -f "$real"
                echo "failed path=$path reason=nginx-test-failed-with-it removed=yes"; failed=$((failed + 1))
            fi ;;
        *) echo "installed path=$path"; installed=$((installed + 1)) ;;
    esac
done <<'FLEET_RESTORE_PLAN'
__PLAN_LINES__
FLEET_RESTORE_PLAN
# The caller swaps the placeholder line above for the PLAN lines. They travel in
# a here-document because this program itself arrives on standard input, so a
# plain `read` would eat the rest of the program instead of the list.

echo "installed=$installed skipped=$skipped failed=$failed"
if [ "$nginx_added" -gt 0 ]; then
    if nginx_ok; then
        if [ -n "$R" ]; then echo "nginx_reload=skipped-in-test"
        else
            if command -v gp > /dev/null 2>&1; then gp ngx reload > /dev/null 2>&1; else systemctl reload nginx; fi
            echo "nginx_reload=$([ $? = 0 ] && echo done || echo FAILED)"
        fi
    else
        echo "nginx_reload=not-attempted reason=final-test-failed"
    fi
else
    echo "nginx_reload=not-needed"
fi
echo "nginx_test_after=$(nginx_ok && echo ok || echo FAILED)"
echo "restore_complete=yes"
