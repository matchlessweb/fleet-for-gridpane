#!/bin/bash
# ==============================================================================
# Server snapshot — the program that runs ON a server. READ-ONLY.
# ==============================================================================
# Sent over ssh by fleet-server-snapshot.sh (and by fleet-server-restore.sh, to
# read the server it is about to restore onto). It writes nothing, reloads
# nothing and changes nothing: every command below is a read. Its one network
# call asks Cloudflare's trace page which address this server leaves from.
#
# WHAT IT IS: the small set of server-level settings that were added by hand
# and that a GridPane server move is not documented to carry: the Fail2Ban
# setup, the server-wide nginx additions, the firewall rules, and a few facts
# (outbound address, PHP and MySQL tuning). It is NOT a backup of sites,
# databases or uploads.
#
# EVERY FILE GETS A CLASS, which decides what the restore script may do with it:
#   restore  small hand-added files it may put back where they are missing
#   compare  kept for comparison and reference; never installed automatically
#            (the Fail2Ban jails are rebuilt by fleet-fail2ban-apply.sh for the
#            sites that are really there, and per-site nginx files are GridPane's)
#   record   name, size, mode and hash only. The content never leaves the server.
#
# IT NEVER SENDS A CREDENTIAL. The Cloudflare token file, GridPane's old
# gpcloudflare.conf and the telemetry agent (which carries its own token) are
# always `record`. Any other file with a line that names a token, key, secret or
# password next to a long value is demoted to `record` too, with
# withheld=secret-shaped, so the gap is visible instead of silent.
#
# SNAP_ROOT is for the local test only: it prefixes every path so the script can
# run against a fixture directory. It is empty on a server.
#
# The names written __LIKE_THIS__ are filled in by the sender from fleet.config.ts
# before this program is sent (scripts/lib-fleet-names.sh).
# ==============================================================================
R="${SNAP_ROOT:-}"
export LC_ALL=C
# Sent without its names filled in, it stops here.
case '__FLEET_PREFIX__' in (''|*_*|*[!a-z0-9]*) echo "abort=this program arrived without its names filled in; nothing was read"; exit 1 ;; esac   # names-guard

kv() { printf '%s=%s\n' "$1" "$2"; }
sha() { if command -v sha256sum > /dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1; else shasum -a 256 < "$1" | cut -d' ' -f1; fi; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
owner_of() { stat -c '%U:%G' "$1" 2>/dev/null || stat -f '%Su:%Sg' "$1" 2>/dev/null; }
size_of() { wc -c < "$1" | tr -d ' '; }
# A line that names a credential and carries a long value. Zone ids and hashes
# on lines that name none of these words are not counted.
SECRET_RE='(token|secret|passw|api[_-]?key|authorization|cfkey|cfuser|cfemail)[^=:]*[=:].*[A-Za-z0-9_+/-]{20,}'
secret_lines() { grep -c -i -E "$SECRET_RE" "$1" 2>/dev/null; }

# emit <class> <real path> [<name to report instead of the path>]
emit() {
    local class="$1" f="$2" name="${3:-}" n withheld=""
    [ -f "$f" ] || return 0
    [ -n "$name" ] || name="${f#"$R"}"
    if [ "$class" != record ]; then
        n=$(secret_lines "$f"); n=${n:-0}
        if [ "$n" -gt 0 ]; then withheld=" withheld=secret-shaped was=$class"; class=record; fi
    fi
    printf 'file class=%s mode=%s owner=%s size=%s sha256=%s%s path=%s\n' \
        "$class" "$(mode_of "$f")" "$(owner_of "$f")" "$(size_of "$f")" "$(sha "$f")" "$withheld" "$name"
    if [ "$class" != record ]; then
        printf 'data path=%s\n' "$name"
        base64 < "$f" | tr -d '\n'; printf '\n'
        printf 'enddata\n'
    fi
}
emit_tree() { # emit_tree <class> <dir>: every regular file below it, in a stable order
    local class="$1" d="$2" f
    [ -d "$d" ] || return 0
    find "$d" -type f 2>/dev/null | sort | while IFS= read -r f; do emit "$class" "$f"; done
}

kv snapshot_format 1
kv host "$(hostname 2>/dev/null)"
kv taken_utc "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# ---- facts ------------------------------------------------------------------
if [ -z "$R" ]; then
    kv os "$(. /etc/os-release 2>/dev/null; printf '%s %s' "${NAME:-?}" "${VERSION_ID:-?}")"
    kv egress_ipv4 "$(curl -4 -s --max-time 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')"
    kv egress_ipv6 "$(curl -6 -s --max-time 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')"
    kv nginx_version "$(nginx -v 2>&1 | sed 's/.*nginx\///')"
    nginx -t > /dev/null 2>&1 && kv nginx_config_test ok || kv nginx_config_test FAILED
    kv gp_cli "$(command -v gp > /dev/null 2>&1 && echo present || echo absent)"
    if command -v fail2ban-client > /dev/null 2>&1; then
        kv fail2ban_version "$(fail2ban-client version 2>/dev/null | head -1)"
        jails=$(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' ')
        kv jails_running "$(echo $jails | wc -w | tr -d ' ')"
        kv jails___FLEET_PREFIX__ "$(echo $jails | tr ' ' '\n' | grep -c '^__FLEET_JAIL_PREFIX__-')"
        kv jails_other "$(echo $jails | tr ' ' '\n' | grep -v '^__FLEET_JAIL_PREFIX__-' | sort | tr '\n' ' ' | sed 's/ $//')"
    else
        kv fail2ban_version absent
    fi
    kv ufw_status "$(ufw status 2>/dev/null | sed -n 's/^Status: //p')"
    kv mysql_innodb_buffer_pool_size "$(grep -rhs -E '^\s*innodb_buffer_pool_size' /etc/mysql 2>/dev/null | tail -1 | tr -d ' ' | cut -d= -f2)"
    kv mysql_max_connections "$(grep -rhs -E '^\s*max_connections' /etc/mysql 2>/dev/null | tail -1 | tr -d ' ' | cut -d= -f2)"
    kv root_crontab_telemetry_lines "$(crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep -c 'telemetry-agent')"
fi
kv ufw_user_rules "$(grep -c '^-A ufw-user-input' "$R/etc/ufw/user.rules" 2>/dev/null || echo 0)"
kv telemetry_agent "$([ -f "$R/root/telemetry-agent.sh" ] && echo present || echo absent)"
kv telemetry_server_id "$(sed -n 's/^SERVER_ID="\([0-9A-Za-z_]*\)".*/\1/p' "$R/root/telemetry-agent.sh" 2>/dev/null | head -1)"
kv cloudflare_token_file "$([ -f "$R/etc/fail2ban/__FLEET_PREFIX__-cloudflare.token" ] && echo present || echo absent)"
kv old_global_key_file "$([ -f "$R/etc/fail2ban/action.d/gpcloudflare.conf" ] && echo present || echo absent)"

for v in "$R"/etc/php/*/fpm; do
    [ -d "$v" ] || continue
    ver=$(basename "$(dirname "$v")")
    printf 'php version=%s opcache_memory=%s interned_strings=%s\n' "$ver" \
        "$(grep -rhs -E '^\s*opcache.memory_consumption' "$v" | tail -1 | tr -d ' ' | cut -d= -f2)" \
        "$(grep -rhs -E '^\s*opcache.interned_strings_buffer' "$v" | tail -1 | tr -d ' ' | cut -d= -f2)"
done

# ---- sites ------------------------------------------------------------------
for d in "$R"/var/www/*/; do
    [ -d "${d}htdocs" ] || continue
    s=$(basename "$d")
    wp=no; { [ -f "${d}wp-config.php" ] || [ -f "${d}htdocs/wp-config.php" ]; } && wp=yes
    f2b=off
    if [ -e "${d}htdocs/wp-content/mu-plugins/wp-fail2ban.php" ]; then f2b=must-use
    elif [ -f "${d}htdocs/wp-content/plugins/wp-fail2ban/wp-fail2ban.php" ]; then f2b=plugin-folder; fi
    printf 'site name=%s wordpress=%s wp_fail2ban=%s nginx_files=%s nginx_subdirs=%s\n' "$s" "$wp" "$f2b" \
        "$(find "${d}nginx" -type f 2>/dev/null | wc -l | tr -d ' ')" \
        "$(find "${d}nginx" -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
done

# ---- files ------------------------------------------------------------------
# Never sent, whatever is in them.
emit record "$R/etc/fail2ban/__FLEET_PREFIX__-cloudflare.token"
emit record "$R/etc/fail2ban/action.d/gpcloudflare.conf"
emit record "$R/root/telemetry-agent.sh"

# Hand-added, server-wide, safe to put back where missing.
emit_tree restore "$R/etc/nginx/extra.d"
for f in "$R"/etc/logrotate.d/__FLEET_PREFIX__-*; do emit restore "$f"; done
emit restore "$R/etc/fail2ban/jail.d/__FLEET_PREFIX__-allowlist.local"

# Kept for comparison. The apply script rebuilds the Fail2Ban ones.
emit compare "$R/etc/fail2ban/jail.local"
for f in "$R"/etc/fail2ban/jail.d/*; do
    case "$f" in */__FLEET_PREFIX__-allowlist.local) continue ;; esac
    emit compare "$f"
done
# Filters and actions that no package owns: ours (__FLEET_JAIL_PREFIX__-*, __FLEET_PREFIX__-*), GridPane's
# copies, and any jail made by hand (one server has a shop's own three). Stock
# Fail2Ban files are skipped; the new server has its own.
unowned() { ! dpkg-query -S "$1" > /dev/null 2>&1; }
for f in "$R"/etc/fail2ban/filter.d/* "$R"/etc/fail2ban/action.d/*; do
    [ -f "$f" ] || continue
    case "$f" in */action.d/gpcloudflare.conf) continue ;; esac     # already listed, as record
    if [ -n "$R" ]; then
        case "$(basename "$f")" in __FLEET_JAIL_PREFIX__-*|__FLEET_PREFIX__-*|*.local) emit compare "$f" ;; esac
    elif unowned "$f"; then
        emit compare "$f"
    fi
done
emit compare "$R/etc/ufw/user.rules"
emit compare "$R/etc/ufw/user6.rules"
for d in "$R"/var/www/*/nginx; do emit_tree compare "$d"; done
# root's crontab, held in memory so nothing is written on the server. A crontab
# line that carries a credential withholds the whole crontab.
if [ -z "$R" ]; then
    C=$(crontab -l 2>/dev/null)
    if [ -n "$C" ]; then
        csha=$(printf '%s\n' "$C" | { if command -v sha256sum > /dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1)
        csize=$(printf '%s\n' "$C" | wc -c | tr -d ' ')
        if printf '%s\n' "$C" | grep -q -i -E "$SECRET_RE"; then
            printf 'file class=record mode=600 owner=root:root size=%s sha256=%s withheld=secret-shaped was=compare path=crontab:root\n' "$csize" "$csha"
        else
            printf 'file class=compare mode=600 owner=root:root size=%s sha256=%s path=crontab:root\n' "$csize" "$csha"
            printf 'data path=crontab:root\n'; printf '%s\n' "$C" | base64 | tr -d '\n'; printf '\nenddata\n'
        fi
    fi
fi

# Printed last, so a cut-off run cannot pass for a short complete one.
kv snapshot_complete yes
