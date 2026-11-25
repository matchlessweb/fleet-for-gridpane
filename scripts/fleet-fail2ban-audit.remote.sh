#!/bin/bash
# ==============================================================================
# Fail2Ban audit — the program that runs ON a server. READ-ONLY.
# ==============================================================================
# Sent over ssh by fleet-fail2ban.sh. It writes nothing, reloads nothing and
# changes nothing: every command below is a read. Its one network call is an
# outbound request to Cloudflare's trace page, to learn the address Cloudflare
# sees this server as (a token gets locked to that address).
#
# IT NEVER PRINTS A CREDENTIAL. /etc/fail2ban/action.d/gpcloudflare.conf holds a
# Cloudflare token in plain text, and jail files can carry one inline
# (`gpcloudflare[cftoken=...]`). So nothing read from a config file is printed
# raw: every such line goes through mask(), which replaces any run of 20 or more
# token-shaped characters with its length. Zone ids (32 hex) are masked too;
# that is fine, the zone list comes from the Cloudflare inventory, not from here.
#
# F2B_AUDIT_ROOT is for the local test only: it prefixes every path so the
# script can be run against a fixture directory. It is empty on a server.
# ==============================================================================
R="${F2B_AUDIT_ROOT:-}"

mask() { sed -E 's/[A-Za-z0-9_-]{20,}/<masked>/g'; }
perms() { stat -c '%U:%G %a' "$1" 2>/dev/null || stat -f '%Su:%Sg %Lp' "$1" 2>/dev/null; }
kv() { printf '%s=%s\n' "$1" "$2"; }

kv audit_format 1
kv host "$(hostname 2>/dev/null)"

# ---- outbound address, as Cloudflare sees it --------------------------------
if [ -z "$R" ]; then
    kv egress_ipv4 "$(curl -4 -s --max-time 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')"
    kv egress_ipv6 "$(curl -6 -s --max-time 8 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')"
fi

# ---- Fail2Ban itself --------------------------------------------------------
if ! command -v fail2ban-client > /dev/null 2>&1; then
    kv fail2ban absent
else
    kv fail2ban present
    kv fail2ban_version "$(fail2ban-client version 2>/dev/null | head -1)"
    fail2ban-client ping > /dev/null 2>&1 && kv fail2ban_running yes || kv fail2ban_running no
    jails=$(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' ')
    kv jails "$(echo $jails)"
    for j in $jails; do
        banned=$(fail2ban-client status "$j" 2>/dev/null | sed -n 's/.*Currently banned:[[:space:]]*//p')
        # `get <jail> actions` answers on two lines; the names are on the last.
        acts=$(fail2ban-client get "$j" actions 2>/dev/null | tail -1 | tr -d ' ' | mask)
        printf 'jail=%s maxretry=%s findtime=%s bantime=%s banned_now=%s actions=%s\n' "$j" \
            "$(fail2ban-client get "$j" maxretry 2>/dev/null)" \
            "$(fail2ban-client get "$j" findtime 2>/dev/null)" \
            "$(fail2ban-client get "$j" bantime 2>/dev/null)" \
            "${banned:-?}" "${acts:-?}"
    done
fi

# ---- config files: what exists, who can read it, never the secrets ----------
F="$R/etc/fail2ban"
for f in "$F/jail.local" "$F/action.d/gpcloudflare.conf" "$F/action.d/cloudflare.conf"; do
    if [ -f "$f" ]; then kv "file ${f#$R}" "present $(perms "$f")"; else kv "file ${f#$R}" absent; fi
done
kv jail_d "$(ls "$F/jail.d" 2>/dev/null | tr '\n' ' ')"
kv wordpress_filters "$(ls "$F/filter.d" 2>/dev/null | grep -i -E 'wordpress|wp-' | tr '\n' ' ')"

CF="$F/action.d/gpcloudflare.conf"
if [ -f "$CF" ]; then
    grep -q "Authorization: Bearer" "$CF" && kv gpcloudflare_auth bearer_token || kv gpcloudflare_auth legacy_key_or_unknown
    if grep -q '/zones/' "$CF"; then kv gpcloudflare_endpoint zone
    elif grep -q '/user/firewall' "$CF"; then kv gpcloudflare_endpoint user
    else kv gpcloudflare_endpoint unknown; fi
    # Names of the settings in [Init], never their values.
    kv gpcloudflare_init_keys "$(sed -n '/^\[Init\]/,$p' "$CF" | sed -n 's/^[[:space:]]*\([a-z_]*\)[[:space:]]*=.*/\1/p' | tr '\n' ' ')"
fi

# Section headers and their action / enabled / logpath lines from jail.local,
# masked. This is what shows which jails are wired to the Cloudflare action.
if [ -f "$F/jail.local" ]; then
    awk '/^\[/{s=$0} /^[[:space:]]*(action|enabled|logpath|filter|ignoreip)[[:space:]]*=/{print "jail_local " s " " $0}
         /^[[:space:]]+[a-z].*$/ && !/=/{print "jail_local " s " (cont) " $0}' "$F/jail.local" | mask
fi

# The failure patterns of the WordPress filters. Needed to write a filter that
# also captures WHICH SITE a line is about. Patterns are not secret; masked anyway.
for flt in wordpress-hard wordpress-soft wordpress-extra; do
    [ -f "$F/filter.d/$flt.conf" ] || continue
    grep -v -E '^[[:space:]]*(#|$)' "$F/filter.d/$flt.conf" | head -40 | sed "s/^/filter $flt | /" | mask
done

# ---- what the log line looks like, and which sites are writing to it --------
LOG="$R/var/log/auth.log"
if [ -r "$LOG" ]; then
    kv authlog_wordpress_lines "$(grep -a -c 'wordpress(' "$LOG" 2>/dev/null)"
    grep -a -o 'wordpress([^)]*)' "$LOG" "$LOG.1" 2>/dev/null | sed 's/^[^:]*://' | sort | uniq -c | sort -rn | head -60 \
        | awk '{print "authlog_site " $2 " lines=" $1}'
    # One real line, with every address blanked, so the shape can be read.
    grep -a 'wordpress(' "$LOG" 2>/dev/null | tail -1 \
        | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<ip>/g; s/([0-9a-fA-F]{1,4}:){3,}[0-9a-fA-F:]*/<ip6>/g' | sed 's/^/authlog_sample /' | mask
else
    kv authlog unreadable
fi

# ---- every WordPress site on the box ----------------------------------------
command -v gp > /dev/null 2>&1 && kv gp_cli present || kv gp_cli absent
n=0
for d in "$R"/var/www/*/; do
    site=$(basename "$d")
    [ -d "$d/htdocs" ] || continue
    cfg="$d/wp-config.php"; [ -f "$cfg" ] || cfg="$d/htdocs/wp-config.php"
    [ -f "$cfg" ] || continue
    n=$((n + 1))
    mu="$d/htdocs/wp-content/mu-plugins/wp-fail2ban.php"
    if [ -L "$mu" ] && [ ! -e "$mu" ]; then mustate=dangling
    elif [ -e "$mu" ]; then mustate=ok
    else mustate=absent; fi
    [ -d "$d/htdocs/wp-content/plugins/wp-fail2ban" ] && plug=yes || plug=no
    [ -f "$d/wp-fail2ban-configs.php" ] && conf=yes || conf=no
    grep -q 'wp-fail2ban-configs' "$cfg" 2>/dev/null && inc=yes || inc=no
    consts=""
    [ "$conf" = yes ] && consts=$(grep -o "WP_FAIL2BAN_[A-Z_]*" "$d/wp-fail2ban-configs.php" | sort -u | sed 's/WP_FAIL2BAN_//' | tr '\n' ',')
    # Files cannot prove a plugin is ACTIVE, so the verdict says how it would load
    # and the log says whether it does. Some sites have no
    # must-use link yet write to auth.log: GridPane has
    # installed it both ways over the years, as a must-use link and as an
    # ordinary plugin, so "no link" is not "broken".
    #   on-mu      must-use link resolves, plugin folder and settings file present
    #   on-plugin  no must-use link, but plugin folder and settings file present:
    #              runs only if activated as an ordinary plugin; trust logging=
    #   off        no link and no settings file
    #   BROKEN     a dangling link, or settings with no plugin folder: PHP is
    #              being asked to load something that is not there
    if [ "$mustate" = dangling ]; then verdict=BROKEN
    elif [ "$conf" = yes ] && [ "$plug" = no ]; then verdict=BROKEN
    elif [ "$mustate" = ok ] && [ "$conf" = yes ]; then verdict=on-mu
    elif [ "$mustate" = absent ] && [ "$conf" = yes ]; then verdict=on-plugin
    elif [ "$conf" = no ] && [ "$mustate" = absent ]; then verdict=off
    else verdict=BROKEN; fi
    # Lines this site (or its www. form) wrote to auth.log: the only evidence here
    # that the plugin really runs. 0 on a quiet site proves nothing either way.
    logged=$(grep -a -c -E "wordpress\\((www\\.)?$(printf '%s' "$site" | sed 's/\./\\./g')\\)" "$LOG" 2>/dev/null); logged=${logged:-0}
    printf 'site=%s verdict=%s logged=%s mu_plugin=%s plugin_dir=%s configs=%s included=%s consts=%s\n' \
        "$site" "$verdict" "$logged" "$mustate" "$plug" "$conf" "$inc" "${consts:--}"
done
kv wordpress_sites "$n"
kv audit_complete yes
