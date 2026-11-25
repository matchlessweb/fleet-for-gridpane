#!/bin/bash
# ==============================================================================
# __FLEET_BRAND__ Dashboard - Serverless Telemetry Agent
# ==============================================================================
# 
# INSTALLATION INSTRUCTIONS:
# 1. Place this script on your root server (e.g., /root/telemetry-agent.sh)
# 2. Make it executable: chmod +x /root/telemetry-agent.sh
# 3. Add to root crontab to run every 10 minutes (do NOT
#    install an every-minute entry; it floods the telemetry table 10x):
#    crontab -e
#    */10 * * * * /root/telemetry-agent.sh > /dev/null 2>&1
#    (Ensure there is only ONE telemetry-agent line in the crontab.)
#
# ==============================================================================

# --- CONFIGURATION ---
# Replace these with your actual Supabase configurations and the specific GridPane Server ID.
SUPABASE_URL="__FLEET_SUPABASE_URL__"
SUPABASE_KEY="__FLEET_SUPABASE_ANON_KEY__"
SERVER_ID="CHANGE_ME" # REQUIRED: this server's GridPane numeric id (see dashboard /servers)
# This server's own agent token. SUPABASE_KEY above is public by design (it ships
# in the browser bundle), so it proves nothing about WHO is reporting — without
# this, anyone holding it could forge readings for any server in the fleet.
# Provisioned by scripts/provision-agent-tokens.sh; only its SHA-256 hash is
# stored server-side. Rotate by re-running that script.
AGENT_TOKEN="CHANGE_ME"
# ---------------------

if [ "$SERVER_ID" = "CHANGE_ME" ]; then
    echo "telemetry-agent: SERVER_ID is not set — edit this script before installing." >&2
    exit 1
fi

# Not fatal: during a rollout an un-provisioned agent should keep reporting
# rather than go dark. The server side accepts a null token until the strict
# migration is applied, and this warning is what makes the gap visible.
if [ "$AGENT_TOKEN" = "CHANGE_ME" ]; then
    echo "telemetry-agent: WARNING — AGENT_TOKEN is not provisioned; reporting unauthenticated." >&2
    AGENT_TOKEN=""
fi

# JSON fragment for the token, omitted entirely when unset so the RPC's default
# applies rather than the string "null" being sent as a literal.
if [ -n "$AGENT_TOKEN" ]; then
    TOKEN_FIELD="\"p_token\": \"$AGENT_TOKEN\","
else
    TOKEN_FIELD=""
fi

# OS Detection for Cross-Platform Local Testing (Mac vs Ubuntu)
OS_TYPE=$(uname)

if [ "$OS_TYPE" = "Darwin" ]; then
    # macOS Developer Testing Mode
    IDLE_CPU=$(top -l 2 | grep -E "^CPU" | tail -1 | awk '{print $7}' | sed 's/%//')
    CPU_USAGE=$(awk "BEGIN {printf \"%.2f\", 100 - $IDLE_CPU}")
    
    RAM_TOTAL=$(sysctl -n hw.memsize | awk '{print $1/1048576}')
    RAM_FREE=$(vm_stat | grep free | awk '{print $3}' | sed 's/\.//')
    RAM_USED=$(awk "BEGIN {print $RAM_TOTAL - ($RAM_FREE * 4096 / 1048576)}")
    RAM_PCT=$(awk "BEGIN {printf \"%.2f\", ($RAM_USED/$RAM_TOTAL)*100}")

    # Generate Synthetic Mock Directories for Mac Local Testing
    WWW_MB=24500     # ~24 GB Sites
    MYSQL_MB=4200    # ~4 GB DBs
    BACKUPS_MB=8100  # ~8 GB Backups
    
    # Snapshot top processes strictly configured for Mac
    TOP_B64=$(top -l 1 -n 20 | base64 | tr -d '\n')
    TOP_B64="${TOP_B64}|AGENT_V1"
else
    # Linux (GridPane Ubuntu) Production Mode
    IDLE_CPU=$(top -bn2 | grep "Cpu(s)" | tail -n 1 | awk '{for(i=1;i<=NF;i++) if($i=="id" || $i=="id,") print $(i-1)}')
    CPU_USAGE=$(awk "BEGIN {print 100 - $IDLE_CPU}")
    
    RAM_TOTAL=$(free -m | awk '/Mem:/ {print $2}')
    RAM_USED=$(free -m | awk '/Mem:/ {print $3}')
    RAM_PCT=$(awk "BEGIN {printf \"%.2f\", ($RAM_USED/$RAM_TOTAL)*100}")

    # Scrape actual GridPane Directory Metrics via `du -sm` (Megabytes)
    WWW_MB=$(du -sm /var/www 2>/dev/null | awk '{print $1}')
    MYSQL_MB=$(du -sm /var/lib/mysql 2>/dev/null | awk '{print $1}')
    BACKUPS_MB=$(du -sm /opt/gridpane/backups 2>/dev/null | awk '{print $1}')
    
    # Prevent empty strings from breaking JSON if directories are restricted
    WWW_MB=${WWW_MB:-0}
    MYSQL_MB=${MYSQL_MB:-0}
    BACKUPS_MB=${BACKUPS_MB:-0}
    
    # Snapshot actual top processes native to Linux coreutils
    TOP_B64=$(top -b -n 1 | head -n 25 | base64 -w 0 | tr -d '\n')
    TOP_B64="${TOP_B64}|AGENT_V1"
fi

# 3. Calculate Disk Usage (Root Mount)
RAW_DISK_PCT=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
RAW_DISK_TOTAL=$(df -k / | awk 'NR==2 {printf "%d", $2/1048576}')

DISK_PCT=${RAW_DISK_PCT:-0}
DISK_TOTAL_GB=${RAW_DISK_TOTAL:-0}

# Posted through the report_telemetry RPC rather than straight into the table.
# A direct INSERT cannot be authenticated: RLS has no way to check a shared
# secret carried in the row, so the anon INSERT policy had to allow anyone
# holding the (public) publishable key to write telemetry for any server. The
# SECURITY DEFINER function verifies this server's own token first.
JSON_PAYLOAD=$(cat <<EOF
{
  $TOKEN_FIELD
  "p_server_id": $SERVER_ID,
  "p_cpu_usage": $CPU_USAGE,
  "p_ram_usage": $RAM_PCT,
  "p_disk_usage": $DISK_PCT,
  "p_disk_total_gb": $DISK_TOTAL_GB,
  "p_disk_www_mb": $WWW_MB,
  "p_disk_mysql_mb": $MYSQL_MB,
  "p_disk_backups_mb": $BACKUPS_MB,
  "p_top_processes_b64": "$TOP_B64",
  "p_timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
)

# Transmit to Supabase REST Edge.
# The report goes to curl on its standard input, never as an argument: it holds
# this server's agent token, and every user on the server can read another
# process's arguments (ps) for as long as the request runs.
STATUS_CODE=$(printf '%s' "$JSON_PAYLOAD" | curl -s -o /dev/null -w "%{http_code}" -X POST "$SUPABASE_URL/rest/v1/rpc/report_telemetry" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  --data-binary @-)

# An RPC returns 204/200, not the 201 a table INSERT gave.
if [ "$STATUS_CODE" -eq 204 ] || [ "$STATUS_CODE" -eq 200 ]; then
    echo "Telemetry synced successfully: CPU $CPU_USAGE% | RAM $RAM_PCT%"
else
    echo "Failed to sync telemetry. HTTP Code: $STATUS_CODE"
fi

# ==============================================================================
# Hardware — what this box ACTUALLY has
# ==============================================================================
# GridPane only knows cpu/ram for servers it provisioned through an integrated
# provider; anything added as a "Custom" VPS returns null forever, which is why
# those nodes read "spec sync pending" in the dashboard. Disk already comes from
# here, so specs come from here too: measured beats both the API and hand entry,
# and it stays correct through a resize.
#
# Vendor is read, not inferred. /sys/class/dmi/id/sys_vendor is what the
# hypervisor reports (Hetzner, Vultr, DigitalOcean…). Some hosts leave it
# generic (QEMU/Bochs) — in that case we send it as-is and the dashboard falls
# back to GridPane's own provider label rather than guessing.
#
# Upserts ONE row per server, same as the firewall reporter below.
if [ "$OS_TYPE" != "Darwin" ]; then
    CPU_CORES=$(nproc 2>/dev/null)
    CPU_CORES=${CPU_CORES:-null}
    RAM_TOTAL_MB=${RAM_TOTAL:-null}

    # Strip anything that would break the JSON string, and cap the length.
    read_dmi() {
        [ -r "$1" ] || return 0
        tr -d '"\\\n\r\t' < "$1" | cut -c1-64
    }
    HW_VENDOR=$(read_dmi /sys/class/dmi/id/sys_vendor)
    HW_PRODUCT=$(read_dmi /sys/class/dmi/id/product_name)

    HW_PAYLOAD=$(cat <<EOF
{
  $TOKEN_FIELD
  "p_server_id": $SERVER_ID,
  "p_cpu_cores": $CPU_CORES,
  "p_ram_total_mb": $RAM_TOTAL_MB,
  "p_vendor": "$HW_VENDOR",
  "p_product": "$HW_PRODUCT"
}
EOF
)

    # On standard input, not as an argument: the payload holds the agent token.
    HW_CODE=$(printf '%s' "$HW_PAYLOAD" | curl -s -o /dev/null -w "%{http_code}" -X POST \
      "$SUPABASE_URL/rest/v1/rpc/report_hardware" \
      -H "apikey: $SUPABASE_KEY" \
      -H "Authorization: Bearer $SUPABASE_KEY" \
      -H "Content-Type: application/json" \
      --data-binary @-)

    if [ "$HW_CODE" -eq 204 ] || [ "$HW_CODE" -eq 200 ]; then
        echo "Hardware synced: ${CPU_CORES} cores | ${RAM_TOTAL_MB} MB | ${HW_VENDOR:-unknown vendor}"
    else
        echo "Failed to sync hardware. HTTP Code: $HW_CODE"
    fi
fi

# ==============================================================================
# Firewall state — what is ACTUALLY blocked on this box
# ==============================================================================
# Read-only, like everything else here: the agent reports local state and never
# accepts instructions from the cloud. Upserts ONE row per server (no history),
# so this table cannot grow the way server_telemetry once did.
#
# Two independent layers are reported, because they stop different traffic:
#   ufw            — packet level, server-wide. Does NOT see Cloudflare-proxied
#                    visitors (packets arrive from Cloudflare edge IPs).
#   nginx deny     — per site, and DOES see the real visitor IP because
#                    GridPane restores it.
# Linux only; the macOS test path above has no ufw, so skip it there.
if [ "$OS_TYPE" != "Darwin" ]; then
    # Newline-separated stdin -> JSON array. Quotes and backslashes are stripped
    # rather than escaped; nothing here should ever contain them.
    json_array() {
        awk 'BEGIN{printf "["} {gsub(/["\\]/,""); printf "%s\"%s\"", (NR>1?",":""), $0} END{printf "]"}'
    }

    # Source addresses for one action out of `ufw status`.
    #
    # This reads the field AFTER the action word, not $NF. The previous $NF
    # version silently missed any rule carrying a comment — and the dashboard's
    # own block generator adds `comment '...'`, which ufw appends to the status
    # line as `# text`. So the exact rules this fleet creates were the ones that
    # would not be reported back. Comments are stripped first; a direction word
    # (IN/OUT/FWD, shown by `ufw status verbose`) is skipped when present.
    ufw_sources() {
        printf '%s\n' "$UFW_RAW" \
            | sed 's/#.*$//' \
            | awk -v act="$1" '{
                  for (i = 1; i <= NF; i++) {
                      if ($i == act) {
                          j = i + 1
                          if ($j == "IN" || $j == "OUT" || $j == "FWD") j++
                          print $j
                          break
                      }
                  }
              }' \
            | grep -Eo '^[0-9a-fA-F:.]+(/[0-9]+)?$' \
            | sort -u
    }

# --- ufw web sources: begin
    # Every source an ALLOW (or LIMIT) rule lets reach port 80 or 443, one per line.
    #
    # ufw_sources cannot answer "are the web ports locked to Cloudflare?": it keeps
    # no ports, and it drops "Anywhere", which is exactly the rule that says the
    # web ports are open to everyone. This keeps both. "Anywhere" is written as
    # 0.0.0.0/0 or ::/0 so the dashboard can treat every entry as a range.
    #
    # A rule reaches the web ports when its destination is 80 or 443 (alone, in a
    # list such as 80,443/tcp, or inside a range such as 1:1000), when it names no
    # port at all ("ufw allow from X", shown as "Anywhere ALLOW X"), or when it is
    # one of the web app profiles. OUT and FWD rules are skipped; a numbered
    # listing's "[ 1]" prefix is stripped so either form of `ufw status` works.
    ufw_web_sources() {
        printf '%s\n' "$UFW_RAW" \
            | sed -e 's/#.*$//' -e 's/^\[ *[0-9]*\] *//' \
            | awk '
                function is_port(t) {
                    return t ~ /^[0-9]+(:[0-9]+)?(,[0-9]+(:[0-9]+)?)*(\/(tcp|udp))?$/
                }
                function covers_web(spec,   n, parts, i, r) {
                    sub(/\/(tcp|udp)$/, "", spec)
                    n = split(spec, parts, ",")
                    for (i = 1; i <= n; i++) {
                        if (parts[i] ~ /:/) {
                            split(parts[i], r, ":")
                            if ((80 >= r[1] + 0 && 80 <= r[2] + 0) || (443 >= r[1] + 0 && 443 <= r[2] + 0)) return 1
                        } else if (parts[i] + 0 == 80 || parts[i] + 0 == 443) return 1
                    }
                    return 0
                }
                {
                    act = 0
                    for (i = 1; i <= NF; i++) if ($i == "ALLOW" || $i == "LIMIT") { act = i; break }
                    if (act < 2) next
                    j = act + 1
                    if ($j == "OUT" || $j == "FWD") next
                    if ($j == "IN") j++
                    if (j > NF) next

                    # Destination: the words before the action, without "(v6)" or "on <iface>".
                    dest = ""; port = ""
                    for (i = 1; i < act; i++) {
                        if ($i == "on") break
                        if ($i == "(v6)") continue
                        if (is_port($i)) port = $i
                        dest = dest (dest == "" ? "" : " ") $i
                    }
                    if (port != "") web = covers_web(port)
                    else if (dest ~ /^(Anywhere|[0-9a-fA-F:.]+(\/[0-9]+)?)$/) web = 1
                    else web = (dest ~ /^(Nginx (Full|HTTP|HTTPS)|Apache( Full| Secure)?|WWW( Full| Secure)?)$/)
                    if (!web) next

                    src = $j
                    if (src == "Anywhere") src = ($(j + 1) == "(v6)") ? "::/0" : "0.0.0.0/0"
                    if (src ~ /^[0-9a-fA-F:.]+(\/[0-9]+)?$/) print src
                }' \
            | sort -u
    }
# --- ufw web sources: end

    UFW_ENABLED=false
    UFW_DENIED="[]"
    UFW_ALLOWED="[]"
    UFW_WEB="[]"
    if command -v ufw > /dev/null 2>&1; then
        UFW_RAW=$(ufw status 2>/dev/null)
        case "$UFW_RAW" in
            "Status: active"*) UFW_ENABLED=true ;;
        esac
        UFW_DENIED=$(ufw_sources DENY | json_array)
        # Allows FROM a specific source only. GridPane's blanket port allows have
        # "Anywhere" as their source, which the IP-shape filter drops. What survives
        # is the operator allowlist, plus Cloudflare's ranges on a server locked
        # with `gp cloudflare enable`.
        UFW_ALLOWED=$(ufw_sources ALLOW | json_array)
        # Who can reach 80/443 at all — the dashboard's Cloudflare-only check.
        UFW_WEB=$(ufw_web_sources | json_array)
        [ -z "$UFW_DENIED" ] && UFW_DENIED="[]"
        [ -z "$UFW_ALLOWED" ] && UFW_ALLOWED="[]"
        [ -z "$UFW_WEB" ] && UFW_WEB="[]"
    fi

    # Per-site nginx deny directives from GridPane's update-safe include dir.
    NGINX_DENIES=$(
        {
            printf '{'
            first=1
            for dir in /var/www/*/nginx; do
                [ -d "$dir" ] || continue
                site=$(basename "$(dirname "$dir")")
                # Keep only IP-shaped arguments. `deny all;` is a normal nginx
                # directive scoped to a location block (protecting .ht* and the
                # like) — it is not an IP block, and reporting it as one would
                # misstate the site's firewall.
                ips=$(grep -rhoE '^[[:space:]]*deny[[:space:]]+[^;]+;' "$dir" 2>/dev/null \
                    | sed -E 's/^[[:space:]]*deny[[:space:]]+//; s/;$//' \
                    | tr -d ' ' \
                    | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$|^[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(/[0-9]{1,3})?$' \
                    | sort -u \
                    | awk 'BEGIN{printf "["} {printf "%s\"%s\"", (NR>1?",":""), $0} END{printf "]"}')
                [ -z "$ips" ] || [ "$ips" = "[]" ] && continue
                [ $first -eq 0 ] && printf ','
                printf '"%s":%s' "$site" "$ips"
                first=0
            done
            printf '}'
        }
    )
    [ -z "$NGINX_DENIES" ] && NGINX_DENIES="{}"

    # ------------------------------------------------------------------
    # Fail2Ban — the allowlist that matters most, and the bans that expire
    # ------------------------------------------------------------------
    # Two different kinds of fact, deliberately kept apart:
    #
    #   ignoreip  static config. Does not expire, does not rotate. Reading it is
    #             as cheap and as stable as `ufw status`, and it is what proves
    #             an operator allowlist is genuinely in force.
    #   banned    a snapshot of who is blocked RIGHT NOW. Expires on bantime and
    #             is lost entirely on a fail2ban restart, so the dashboard must
    #             show it stamped with its age and never as settled state.
    #
    # /var/log/fail2ban.log is never read. fail2ban-client answers both questions
    # directly, so log rotation is irrelevant here.
    F2B_PRESENT=false
    F2B_IGNOREIP="[]"
    F2B_BANNED="{}"
    if command -v fail2ban-client > /dev/null 2>&1 && fail2ban-client ping > /dev/null 2>&1; then
        F2B_PRESENT=true
        F2B_JAILS=$(fail2ban-client status 2>/dev/null \
            | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' ')

        # ignoreip is inherited from [DEFAULT] by every jail, so one jail's
        # effective value is the allowlist. Read the first jail that answers.
        for jail in $F2B_JAILS; do
            RAW_IGNORE=$(fail2ban-client get "$jail" ignoreip 2>/dev/null \
                | sed -n 's/^[[:space:]]*[|`][[:space:]]*-[[:space:]]*//p' \
                | sed 's/[[:space:]]*$//' \
                | grep -v '^$')
            if [ -n "$RAW_IGNORE" ]; then
                # Entries are kept verbatim rather than filtered to IP shape:
                # ignoreip legitimately accepts hostnames, and silently dropping
                # them would misreport what the server is actually honouring.
                F2B_IGNOREIP=$(printf '%s\n' "$RAW_IGNORE" | sort -u | json_array)
                break
            fi
        done

        F2B_BANNED=$(
            {
                printf '{'
                first=1
                for jail in $F2B_JAILS; do
                    banned=$(fail2ban-client status "$jail" 2>/dev/null \
                        | sed -n 's/.*Banned IP list:[[:space:]]*//p' \
                        | tr ' ' '\n' | grep -v '^$' | sort -u | json_array)
                    [ -z "$banned" ] || [ "$banned" = "[]" ] && continue
                    [ $first -eq 0 ] && printf ','
                    printf '"%s":%s' "$jail" "$banned"
                    first=0
                done
                printf '}'
            }
        )
        [ -z "$F2B_BANNED" ] && F2B_BANNED="{}"
    fi

    # The four allowlist arguments were added 2026-08-13 and carry SQL DEFAULTs,
    # so an older agent that omits them still upserts correctly. Their absence is
    # stored as NULL, which the dashboard reads as "this agent does not report
    # allowlist state" — distinct from an empty array meaning "reports, found
    # none". Sending them here is what flips a server from unreported to known.
    FW_PAYLOAD=$(cat <<EOF
{
  $TOKEN_FIELD
  "p_server_id": $SERVER_ID,
  "p_ufw_enabled": $UFW_ENABLED,
  "p_ufw_denied_ips": $UFW_DENIED,
  "p_nginx_denies": $NGINX_DENIES,
  "p_ufw_allowed_ips": $UFW_ALLOWED,
  "p_fail2ban_ignoreip": $F2B_IGNOREIP,
  "p_fail2ban_banned": $F2B_BANNED,
  "p_ufw_web_sources": $UFW_WEB,
  "p_fail2ban_present": $F2B_PRESENT
}
EOF
)

    # Reported through a SECURITY DEFINER function, not the table: the agent
    # can upsert its own row and cannot read any server's firewall posture
    # back out. (A direct upsert would have needed public SELECT, because
    # ON CONFLICT DO UPDATE must read the conflicting row.)
    # On standard input, not as an argument: the payload holds the agent token.
    fw_post() {
        printf '%s' "$1" | curl -s -o /dev/null -w "%{http_code}" -X POST \
          "$SUPABASE_URL/rest/v1/rpc/report_firewall_state" \
          -H "apikey: $SUPABASE_KEY" \
          -H "Authorization: Bearer $SUPABASE_KEY" \
          -H "Content-Type: application/json" \
          --data-binary @-
    }
    FW_CODE=$(fw_post "$FW_PAYLOAD")
    # p_ufw_web_sources arrived 2026-11-19 (ufw_web_sources_schema.sql). Until that
    # file is applied, PostgREST knows no function with this argument and answers
    # 404, which would stop the whole firewall report. Send the report without it.
    if [ "$FW_CODE" = "404" ]; then
        FW_CODE=$(fw_post "$(printf '%s\n' "$FW_PAYLOAD" | grep -v '"p_ufw_web_sources"')")
    fi

    if [ "$FW_CODE" -eq 204 ] || [ "$FW_CODE" -eq 200 ]; then
        echo "Firewall state synced: ufw_enabled=$UFW_ENABLED | fail2ban=$F2B_PRESENT"
    else
        echo "Failed to sync firewall state. HTTP Code: $FW_CODE"
    fi
fi

# ==============================================================================
# Fail2Ban behind Cloudflare — is every site's own set of jails really working
# ==============================================================================
# Read-only, like everything else here. Each WordPress site has three jails of
# its own (__FLEET_JAIL_PREFIX__-<site>-h / -s / -x, set up by scripts/fleet-fail2ban-apply.sh) that
# ban in that site's Cloudflare zone and in the local firewall. This reports, per
# site: how the WP fail2ban plugin is installed, whether wp-config.php includes
# its settings, the three jails with their counters and actions, who is banned
# right now (with the time the ban started and ends), and the newest lines the
# site wrote to auth.log. Per server: Fail2Ban itself, GridPane's own jails, and
# whether the token file and the old gpcloudflare.conf are present.
#
# The dashboard works out "properly working behind Cloudflare" from these facts;
# nothing is judged here. It follows the same checks as
# scripts/fleet-fail2ban-audit.remote.sh, so the two agree by construction.
#
# IT NEVER READS A CREDENTIAL. The token file is checked for existence and size
# only, and gpcloudflare.conf for existence only. No config file is printed.
#
# Banned addresses and log lines are personal data. They go to the database
# through report_fail2ban (which checks this server's own token) and are never
# written to a log here: the report lives in a root-only temp file for the length
# of the POST and is then removed.
#
# python3, because log lines must be escaped into JSON correctly and ban times
# converted from the server's local time; awk could do neither safely. Every
# GridPane server has it. Without it this section is skipped and the dashboard
# shows the server as "not reported" rather than guessing.
#
# One POST per run, and only this script's existing cron line runs it.
if [ "$OS_TYPE" != "Darwin" ] && command -v python3 > /dev/null 2>&1; then
    F2B_TMP=$(mktemp /tmp/__FLEET_JAIL_PREFIX__-f2b-report.XXXXXX) && chmod 600 "$F2B_TMP"
    python3 - > "$F2B_TMP" 2> /dev/null <<'F2B_PY'
# --- fail2ban report: begin (scripts/test-telemetry-fail2ban.sh runs this part) ---
import collections, datetime, hashlib, json, os, re, shutil, subprocess, sys, time

R = os.environ.get("F2B_ROOT", "")      # the local test only; empty on a server
ETC = R + "/etc/fail2ban"
START = time.time()
BUDGET = 100          # seconds for all fail2ban-client calls together
LOG_KEEP = 50         # newest lines kept per site
LINE_MAX = 300
BAN_MAX = 200         # per jail
NOW = time.time()

def fc(*args):
    # A report cut short would show jails as missing, so past the budget nothing
    # is sent at all and the dashboard says "not reported".
    if time.time() - START > BUDGET:
        sys.exit(3)
    try:
        p = subprocess.run(["fail2ban-client"] + list(args), stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=15, universal_newlines=True)
    except Exception:
        return None
    return p.stdout if p.returncode == 0 else None

def num(text, label):
    m = re.search(re.escape(label) + r":\s*(\d+)", text or "")
    return int(m.group(1)) if m else None

def utc(epoch):
    return datetime.datetime.utcfromtimestamp(epoch).strftime("%Y-%m-%dT%H:%M:%SZ")

def local_to_utc(text):
    # fail2ban-client prints ban times in the server's own time zone.
    try:
        return utc(time.mktime(time.strptime(text, "%Y-%m-%d %H:%M:%S")))
    except Exception:
        return None

IP = re.compile(r"^[0-9A-Fa-f:.]+(/\d+)?$")

def bans_of(name, status):
    m = re.search(r"Banned IP list:[ \t]*(.*)", status or "")
    ips = [x for x in (m.group(1).split() if m else []) if IP.match(x)][:BAN_MAX]
    if not ips:
        return []
    times = {}
    for line in (fc("get", name, "banip", "--with-time") or "").splitlines():
        t = re.match(r"\s*(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \+ -?\d+ = (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)", line)
        if t:
            times[t.group(1)] = (local_to_utc(t.group(2)), local_to_utc(t.group(3)))
    return [{"ip": ip, "jail": name, "at": times.get(ip, (None, None))[0],
             "until": times.get(ip, (None, None))[1]} for ip in ips]

def jail_facts(name, running):
    status = fc("status", name) if running else None
    acts = fc("get", name, "actions") if running else None
    last = (acts or "").strip().splitlines()[-1:] or [""]
    actions = [a.strip() for a in last[0].split(",") if re.match(r"^[A-Za-z0-9_.-]+$", a.strip())]
    files = re.search(r"File list:[ \t]*(.*)", status or "")
    return {
        "name": name, "running": running, "actions": actions,
        "reads_auth_log": bool(files and "/var/log/auth.log" in files.group(1).split()),
        "failed_now": num(status, "Currently failed"), "failed_total": num(status, "Total failed"),
        "banned_now": num(status, "Currently banned"), "banned_total": num(status, "Total banned"),
    }, bans_of(name, status)

def slug(site):
    # The same name scripts/fleet-fail2ban-apply.remote.sh gives a site's jails.
    keep = "".join(c for c in site if c in "abcdefghijklmnopqrstuvwxyz0123456789")[:__FLEET_JAIL_SITE_CHARS__]
    return "__FLEET_JAIL_PREFIX__-%s-%s" % (keep, hashlib.md5(site.encode()).hexdigest()[:4])

__FLEET_JAIL_UPPER__ = re.compile(r"^__FLEET_JAIL_PREFIX__-[a-z0-9]*-[0-9a-f]{4}-[hsx]$")

def jail_file():
    # Which jails the server is configured with, and the zone each bans in.
    out, cur = {}, None
    try:
        lines = open(ETC + "/jail.d/__FLEET_PREFIX__-cloudflare.local", errors="replace").read().splitlines()
    except Exception:
        return out
    for line in lines:
        h = re.match(r"\[([^\]]+)\]\s*$", line)
        if h:
            cur = h.group(1) if __FLEET_JAIL_UPPER__.match(h.group(1)) else None
            if cur:
                out[cur] = {"cfzone": None, "site": None}
            continue
        if cur is None:
            continue
        c = re.match(r"#\s*(\S+)\s+\S+\s+wordpress-", line)
        if c:
            out[cur]["site"] = c.group(1)
        z = re.search(r"__FLEET_PREFIX__-cloudflare\[cfzone=([0-9a-f]{32})\]", line)
        if z:
            out[cur]["cfzone"] = z.group(1)
    return out

def plugin_facts(d):
    cfg = d + "/wp-config.php"
    if not os.path.isfile(cfg):
        cfg = d + "/htdocs/wp-config.php"
    mu = d + "/htdocs/wp-content/mu-plugins/wp-fail2ban.php"
    mustate = "dangling" if (os.path.islink(mu) and not os.path.exists(mu)) else ("ok" if os.path.exists(mu) else "absent")
    plug = os.path.isdir(d + "/htdocs/wp-content/plugins/wp-fail2ban")
    conf = os.path.isfile(d + "/wp-fail2ban-configs.php")
    included = False
    try:
        for line in open(cfg, errors="replace"):
            if "wp-fail2ban-configs" in line and not line.lstrip().startswith(("//", "#", "*", "/*")):
                included = True
                break
    except Exception:
        pass
    # Same verdicts as the audit (fleet-fail2ban-audit.remote.sh).
    if mustate == "dangling" or (conf and not plug):
        plugin = "broken"
    elif mustate == "ok" and conf:
        plugin = "mu"
    elif mustate == "absent" and conf:
        plugin = "plugin"
    elif mustate == "absent" and not conf:
        plugin = "off"
    else:
        plugin = "broken"
    return {"plugin": plugin, "mu_plugin": mustate, "plugin_dir": plug, "configs": conf, "included": included}

LINE = re.compile(r"^([A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d|\d{4}-\d\d-\d\dT\S+) \S+ (?:wordpress|wp)\(([^)\s]+)\)(?:\[\d+\])?: (.*)$")

def line_time(stamp):
    try:
        if stamp[:1].isdigit():
            return datetime.datetime.fromisoformat(stamp).timestamp()
        year = time.localtime(NOW).tm_year
        t = time.mktime(time.strptime("%d %s" % (year, stamp), "%Y %b %d %H:%M:%S"))
        if t > NOW + 86400:      # a December line read in January
            t = time.mktime(time.strptime("%d %s" % (year - 1, stamp), "%Y %b %d %H:%M:%S"))
        return t
    except Exception:
        return None

def read_log():
    recent = collections.defaultdict(lambda: collections.deque(maxlen=LOG_KEEP))
    day = collections.Counter()
    for path in (R + "/var/log/auth.log.1", R + "/var/log/auth.log"):   # older first
        try:
            f = open(path, "rb")
        except Exception:
            continue
        with f:
            size = os.fstat(f.fileno()).st_size
            if size > 200 * 1024 * 1024:
                f.seek(size - 200 * 1024 * 1024)
                f.readline()
            for raw in f:
                if b"wordpress(" not in raw and b"wp(" not in raw:
                    continue
                m = LINE.match(raw.decode("utf-8", "replace").rstrip("\r\n"))
                if not m:
                    continue
                host = m.group(2).lower()
                if host.startswith("www."):
                    host = host[4:]
                when = line_time(m.group(1))
                text = re.sub(r"[\x00-\x1f\x7f]", " ", m.group(3))[:LINE_MAX]
                recent[host].append({"t": utc(when) if when else None, "m": text})
                # Sign-ins that worked are logged too; they are not failures.
                if when and when >= NOW - 86400 and not text.startswith("Accepted password"):
                    day[host] += 1
    return recent, day

present = shutil.which("fail2ban-client") is not None
running = bool(present and fc("ping") is not None)
version = ((fc("version") or "").strip().splitlines() or [""])[0][:40] if present else ""
listed = []
if running:
    m = re.search(r"Jail list:[ \t]*(.*)", fc("status") or "")
    listed = [j.strip() for j in (m.group(1).split(",") if m else []) if j.strip()]
configured = jail_file()
recent, day = read_log()

sites, claimed = [], set()
try:
    folders = sorted(os.listdir(R + "/var/www"))
except Exception:
    folders = []
for site in folders:
    d = R + "/var/www/" + site
    if not os.path.isdir(d + "/htdocs"):
        continue
    if not (os.path.isfile(d + "/wp-config.php") or os.path.isfile(d + "/htdocs/wp-config.php")):
        continue
    row = {"site": site}
    row.update(plugin_facts(d))
    jails, bans = [], []
    for kind in "hsx":
        name = "%s-%s" % (slug(site), kind)
        if name not in configured and name not in listed:
            continue
        claimed.add(name)
        facts, banned = jail_facts(name, name in listed)
        facts["kind"] = kind
        facts["configured"] = name in configured
        facts["cfzone"] = configured.get(name, {}).get("cfzone")
        jails.append(facts)
        bans.extend(banned)
    row["jails"], row["bans"] = jails, bans
    row["log"] = list(reversed(recent.get(site.lower(), [])))
    row["log_24h"] = day.get(site.lower(), 0)
    sites.append(row)

server_jails, orphans = [], []
for name in listed:
    if name in claimed:
        continue
    if __FLEET_JAIL_UPPER__.match(name):
        orphans.append({"name": name, "running": True, "site": configured.get(name, {}).get("site")})
        continue
    facts, banned = jail_facts(name, True)
    facts["bans"] = banned
    server_jails.append(facts)
for name in sorted(configured):
    if name not in claimed and name not in listed:
        orphans.append({"name": name, "running": False, "site": configured[name].get("site")})

token = ETC + "/__FLEET_PREFIX__-cloudflare.token"
report = {
    "v": 1,
    "fail2ban": {"present": present, "running": running, "version": version},
    # Existence and size only. The token itself is never opened.
    "token_file": os.path.isfile(token) and os.path.getsize(token) > 0,
    "gpcloudflare_conf": os.path.isfile(ETC + "/action.d/gpcloudflare.conf"),
    "auth_log": os.access(R + "/var/log/auth.log", os.R_OK),
    "sites": sites, "server_jails": server_jails, "orphan_jails": orphans,
}
sys.stdout.write(json.dumps(report, separators=(",", ":")))
# --- fail2ban report: end ---
F2B_PY
    F2B_RC=$?
    if [ "$F2B_RC" -eq 0 ] && [ -s "$F2B_TMP" ]; then
        # The report is sent on curl's stdin: with 50 log lines a site it can pass
        # the size the kernel allows for one command-line argument.
        F2B_CODE=$( { printf '{ %s "p_server_id": %s, "p_report": ' "$TOKEN_FIELD" "$SERVER_ID"; cat "$F2B_TMP"; printf ' }'; } \
          | curl -s -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
              "$SUPABASE_URL/rest/v1/rpc/report_fail2ban" \
              -H "apikey: $SUPABASE_KEY" \
              -H "Authorization: Bearer $SUPABASE_KEY" \
              -H "Content-Type: application/json" \
              --data-binary @-)
        if [ "$F2B_CODE" = 204 ] || [ "$F2B_CODE" = 200 ]; then
            echo "Fail2Ban report synced: $(grep -o '"plugin":"' "$F2B_TMP" | wc -l | tr -d ' ') site(s)"
        else
            echo "Failed to sync Fail2Ban report. HTTP Code: $F2B_CODE"
        fi
    else
        echo "Fail2Ban report not built (python3 exit $F2B_RC); nothing sent"
    fi
    rm -f "$F2B_TMP"
fi

# ==============================================================================
# WAF status — which firewall each site runs, and what 8G would have blocked
# ==============================================================================
# Read-only, like everything else here. Per site folder it reports:
#   - GridPane's own WAF setting and which 7G rulesets are on, read from the
#     site's settings file (/var/www/<site>/logs/<site>.env)
#   - whether the 8G firewall is installed for the site and in which mode,
#     worked out from the nginx files that are really there: "observe" when a
#     watch file only logs what 8G would block, "enforce" when 8g.conf (the file
#     that returns 403) is included
#   - the last 24 hours of 7g.log (what 7G blocked) and 8g.log (what 8G would
#     have blocked), counted by rule
#
# The dashboard decides what to call each state; nothing is judged here.
#
# What leaves the server: counts by rule, and for each 8G rule the three most
# common user agents (bot rules) or request paths with the query string cut off
# (request and query rules). No visitor address, no query string, no cookie and
# no referrer is ever read into the report.
#
# Logs are read from the end, at most 16 MB each, so a 7g.log nobody rotates
# cannot stall the run. When that limit cut the 24 hours short the report says
# so ("complete": false) instead of showing a low number as the whole day.
if [ "$OS_TYPE" != "Darwin" ] && command -v python3 > /dev/null 2>&1; then
    WAF_TMP=$(mktemp /tmp/__FLEET_JAIL_PREFIX__-waf-report.XXXXXX) && chmod 600 "$WAF_TMP"
    python3 - > "$WAF_TMP" 2> /dev/null <<'WAF_PY'
# --- waf report: begin (scripts/test-telemetry-waf.sh runs this part) ---
import collections, datetime, json, os, re, sys, time

R = os.environ.get("WAF_ROOT", "")      # the local test only; empty on a server
WWW = R + "/var/www"
START = time.time()
BUDGET = 60                 # seconds for the whole section
NOW = float(os.environ.get("WAF_NOW", time.time()))
DAY = NOW - 86400
TAIL_MAX = 16 * 1024 * 1024 # bytes read from the end of one log
RULE_MAX = 40               # rules kept per site and firewall
SAMPLE_MAX = 3
SAMPLE_LEN = 120
SKIP = {"22222", "default", "html"}
EPOCH = datetime.datetime(1970, 1, 1)

def utc(epoch):
    return datetime.datetime.utcfromtimestamp(epoch).strftime("%Y-%m-%dT%H:%M:%SZ")

def offset_seconds(text):
    m = re.match(r"^([+-])(\d\d):?(\d\d)$", text or "")
    if not m:
        return 0
    return (1 if m.group(1) == "+" else -1) * (int(m.group(2)) * 3600 + int(m.group(3)) * 60)

MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}

def nginx_time(text):
    # 14/Nov/2026:05:04:45 +0000
    m = re.match(r"^(\d\d)/(\w{3})/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d{4})$", text)
    if not m or m.group(2) not in MONTHS:
        return None
    d = datetime.datetime(int(m.group(3)), MONTHS[m.group(2)], int(m.group(1)),
                          int(m.group(4)), int(m.group(5)), int(m.group(6)))
    return (d - EPOCH).total_seconds() - offset_seconds(m.group(7))

def iso_time(text):
    # 2026-11-14T14:06:37+00:00
    m = re.match(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(Z|[+-]\d\d:?\d\d)?$", text)
    if not m:
        return None
    d = datetime.datetime(*[int(m.group(i)) for i in range(1, 7)])
    off = 0 if m.group(7) in (None, "Z") else offset_seconds(m.group(7))
    return (d - EPOCH).total_seconds() - off

def tail_lines(path):
    """Lines from the end of a log, and whether the read reached the file's start."""
    if time.time() - START > BUDGET:
        sys.exit(3)
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            cut = size > TAIL_MAX
            if cut:
                f.seek(size - TAIL_MAX)
            data = f.read()
    except Exception:
        return [], True
    lines = data.decode("utf-8", "replace").splitlines()
    if cut and lines:
        lines = lines[1:]           # the first one is almost certainly partial
    return lines, not cut

def day_lines(logs, name, stamp):
    """The last 24 hours of <name> and, when it was rotated inside them, <name>.1."""
    out, complete = [], True
    for path in (logs + "/" + name + ".1", logs + "/" + name):
        try:
            if not os.path.isfile(path) or os.path.getmtime(path) < DAY:
                continue
        except Exception:
            continue
        lines, whole = tail_lines(path)
        kept = []
        for line in lines:
            t = stamp(line)
            if t is not None and t >= DAY and t <= NOW + 300:
                kept.append(line)
        # Cut short and still inside the day at the cut: the day is not all here.
        if not whole and lines:
            first = next((stamp(l) for l in lines if stamp(l) is not None), None)
            if first is not None and first >= DAY:
                complete = False
        out.extend(kept)
    return out, complete

G7_LINE = re.compile(r'^\[([^\]]+)\] \["([^"]*)"\]')
G7_RULE = re.compile(r":([a-z_]+_\d+):")

def seven_day(logs):
    lines, complete = day_lines(logs, "7g.log", lambda l: nginx_time(G7_LINE.match(l).group(1)) if G7_LINE.match(l) else None)
    rules = collections.Counter()
    for line in lines:
        for rule in set(G7_RULE.findall(G7_LINE.match(line).group(2))):
            rules[rule] += 1
    return {"total": len(lines), "complete": complete,
            "rules": [{"rule": r, "n": n} for r, n in rules.most_common(RULE_MAX)]}

G8_LINE = re.compile(r'^(\S+) (\d{3}) "(\S+) (.*?)" cookie=(\S*) method=(\S*) referer=(\S*) '
                     r'bot=(\S*) querystring=(\S*) request=(\S*) ip=\S* ua="(.*)" ref="')
# The names 8G's own 8g.conf gives each reason.
G8_FIELDS = ["bad_cookie", "not_allowed_method", "bad_referer", "bad_bot", "bad_querystring", "bad_request"]
STOPPED = {"403", "405", "444"}     # the request was refused anyway, by 7G or something else

def clean(text):
    return re.sub(r"[\x00-\x1f\x7f]", " ", text)[:SAMPLE_LEN]

def eight_day(logs):
    lines, complete = day_lines(logs, "8g.log", lambda l: iso_time(l.split(" ", 1)[0]))
    n, stopped = collections.Counter(), collections.Counter()
    samples = collections.defaultdict(collections.Counter)
    total = already = 0
    for line in lines:
        m = G8_LINE.match(line)
        if not m:
            continue
        hits = [(G8_FIELDS[i], m.group(5 + i)) for i in range(6) if m.group(5 + i) not in ("", "0", "-")]
        if not hits:
            continue
        total += 1
        was_stopped = m.group(2) in STOPPED
        already += 1 if was_stopped else 0
        for field, value in hits:
            if not re.match(r"^[A-Za-z0-9_]{1,24}$", value):
                value = "x"
            rule = "%s_%s" % (field, value)
            n[rule] += 1
            stopped[rule] += 1 if was_stopped else 0
            if field == "bad_bot":
                samples[rule][clean(m.group(11))] += 1
            elif field in ("bad_request", "bad_querystring"):
                samples[rule][clean(m.group(4).split("?", 1)[0])] += 1
            elif field == "not_allowed_method":
                samples[rule][clean(m.group(3))] += 1
    return {"total": total, "already": already, "complete": complete,
            "rules": [{"rule": r, "n": c, "already": stopped[r],
                       "samples": [{"s": s, "n": k} for s, k in samples[r].most_common(SAMPLE_MAX)]}
                      for r, c in n.most_common(RULE_MAX)]}

def settings(path):
    """GridPane's per-site settings file: one key:value a line."""
    out = {}
    try:
        with open(path, errors="replace") as f:
            for line in f:
                k, sep, v = line.strip().partition(":")
                if sep and re.match(r"^[A-Za-z0-9_-]{1,40}$", k) and re.match(r"^[A-Za-z0-9_.-]{0,40}$", v):
                    out[k] = v
    except Exception:
        return None
    return out

def live(path):
    """A config file with its comment lines removed."""
    try:
        with open(path, errors="replace") as f:
            return "\n".join(l for l in f.read().splitlines() if not l.lstrip().startswith("#"))
    except Exception:
        return ""

def eight(d):
    ngx = d + "/nginx"
    folder = os.path.isdir(ngx + "/8g")
    text = ""
    try:
        names = sorted(n for n in os.listdir(ngx) if n.endswith(".conf") and os.path.isfile(ngx + "/" + n))
    except Exception:
        names = []
    for n in names:
        text += live(ngx + "/" + n) + "\n"
    loaded = bool(re.search(r"include\s+\S*8g-firewall\.conf\s*;", text))
    watch = bool(re.search(r"access_log\s+\S*8g\.log\b", text))
    enforce = bool(re.search(r"include\s+\S*/8g\.conf\s*;", text))
    if enforce:
        mode = "enforce"
    elif watch:
        mode = "observe"
    elif folder or loaded:
        mode = "installed"
    else:
        mode = "none"
    version = None
    if folder:
        try:
            with open(ngx + "/8g/8g.conf", errors="replace") as f:
                v = re.search(r"8G FIREWALL v([0-9.]{1,12})", f.read(400))
                version = v.group(1) if v else None
        except Exception:
            pass
    log = d + "/logs/8g.log"
    has_log = os.path.isfile(log)
    return {"mode": mode, "rules_loaded": loaded, "version": version,
            "log_bytes": os.path.getsize(log) if has_log else None,
            "log_at": utc(os.path.getmtime(log)) if has_log else None}

sites = []
try:
    folders = sorted(os.listdir(WWW))
except Exception:
    folders = []
for site in folders:
    d = WWW + "/" + site
    if site in SKIP or site.endswith(".gridpanevps.com") or not os.path.isdir(d):
        continue
    env = settings(d + "/logs/" + site + ".env")
    if env is None:
        continue                    # not a GridPane site folder
    g8 = eight(d)
    row = {
        "site": site,
        "waf": env.get("waf"),
        "rulesets": {k[3:]: v for k, v in sorted(env.items()) if k.startswith("7G-")},
        "g8": g8,
        "g7_day": seven_day(d + "/logs") if os.path.isfile(d + "/logs/7g.log") else None,
        "g8_day": eight_day(d + "/logs") if g8["log_bytes"] is not None else None,
    }
    sites.append(row)

sys.stdout.write(json.dumps({"v": 1, "sites": sites}, separators=(",", ":")))
# --- waf report: end ---
WAF_PY
    WAF_RC=$?
    if [ "$WAF_RC" -eq 0 ] && [ -s "$WAF_TMP" ]; then
        WAF_CODE=$( { printf '{ %s "p_server_id": %s, "p_report": ' "$TOKEN_FIELD" "$SERVER_ID"; cat "$WAF_TMP"; printf ' }'; } \
          | curl -s -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
              "$SUPABASE_URL/rest/v1/rpc/report_waf" \
              -H "apikey: $SUPABASE_KEY" \
              -H "Authorization: Bearer $SUPABASE_KEY" \
              -H "Content-Type: application/json" \
              --data-binary @-)
        if [ "$WAF_CODE" = 204 ] || [ "$WAF_CODE" = 200 ]; then
            echo "WAF report synced: $(grep -o '"waf":' "$WAF_TMP" | wc -l | tr -d ' ') site(s)"
        else
            echo "Failed to sync WAF report. HTTP Code: $WAF_CODE"
        fi
    else
        echo "WAF report not built (python3 exit $WAF_RC); nothing sent"
    fi
    rm -f "$WAF_TMP"
fi

# ==============================================================================
# PHP code cache (OPcache) — one cache per PHP version, shared by its sites
# ==============================================================================
# Every site on one PHP version shares that version's code cache. Per version
# this reports:
#   - the settings in /etc/php/<ver>/fpm/php.ini (and conf.d), as written
#   - which site folders have a pool on that version
#   - the live numbers, asked of that version's running PHP: memory used, free
#     and wasted, the text buffer ("interned strings"), files cached against the
#     limit, hits and misses, restarts, and how much of the cache each site's
#     code holds
#
# The live numbers can only be read from inside the running PHP, not from the
# command line (the command line has a separate, empty cache). So this section
# keeps one small PHP file, root-owned, OUTSIDE every web root, and asks one of
# the version's own pool sockets to run it. The file only reads and prints
# numbers. It cannot be reached from the web. That file is the one thing this
# agent leaves on the server; nothing in PHP's or GridPane's settings is changed.
#
# When the live read fails the report says why ("live_error") and still carries
# the settings. The dashboard treats that as "cannot see", never as "fine".
#
# What leaves the server: sizes, counts, times and site folder names.
if [ "$OS_TYPE" != "Darwin" ] && command -v python3 > /dev/null 2>&1; then
    OPC_TMP=$(mktemp /tmp/__FLEET_JAIL_PREFIX__-opcache-report.XXXXXX) && chmod 600 "$OPC_TMP"
    python3 - > "$OPC_TMP" 2> /dev/null <<'OPC_PY'
# --- opcache report: begin (scripts/test-telemetry-opcache.sh runs this part) ---
import collections, datetime, glob, json, os, re, socket, struct, sys, time

R = os.environ.get("OPC_ROOT", "")      # the local test only; empty on a server
ETC = R + "/etc/php"
WWW = R + "/var/www"
PROBE_DIR = os.environ.get("OPC_PROBE_DIR", "/var/lib/__FLEET_PREFIX__-fleet")
PROBE = PROBE_DIR + "/opcache-probe.php"
START = time.time()
BUDGET = 40                 # seconds for the whole section
TIMEOUT = 5                 # seconds for one question to PHP
SOCKETS_TRIED = 4           # per PHP version
SITES_MAX = 80
KEYS = ("opcache.enable", "opcache.memory_consumption", "opcache.interned_strings_buffer",
        "opcache.max_accelerated_files", "opcache.validate_timestamps", "opcache.revalidate_freq")

PROBE_PHP = r"""<?php
// __FLEET_NAME__ telemetry agent: read-only. Prints this PHP version's code
// cache numbers for the agent. Written by telemetry-agent.sh. Safe to delete:
// the agent writes it again on its next run.
header('Content-Type: application/json');
$out = array('php' => PHP_VERSION);
if (!function_exists('opcache_get_status')) { $out['err'] = 'not_loaded'; echo json_encode($out); return; }
$s = @opcache_get_status(true);
if (!is_array($s)) { $out['err'] = ini_get('opcache.enable') ? 'refused' : 'off'; echo json_encode($out); return; }
$www = rtrim(isset($_SERVER['FLEET_WWW']) ? $_SERVER['FLEET_WWW'] : '/var/www', '/') . '/';
$n = strlen($www);
$by = array();
foreach ((isset($s['scripts']) ? $s['scripts'] : array()) as $path => $x) {
    $site = '';
    if (strncmp($path, $www, $n) === 0) {
        $e = strpos($path, '/', $n);
        if ($e !== false) { $site = substr($path, $n, $e - $n); }
    }
    if (!isset($by[$site])) { $by[$site] = array(0, 0); }
    $by[$site][0]++;
    $by[$site][1] += isset($x['memory_consumption']) ? (int) $x['memory_consumption'] : 0;
}
$m = isset($s['memory_usage']) ? $s['memory_usage'] : array();
$i = isset($s['interned_strings_usage']) ? $s['interned_strings_usage'] : array();
$t = isset($s['opcache_statistics']) ? $s['opcache_statistics'] : array();
$g = function ($a, $k) { return isset($a[$k]) ? (int) $a[$k] : null; };
$out += array(
    'enabled' => !empty($s['opcache_enabled']),
    'full' => !empty($s['cache_full']),
    'mem' => array('used' => $g($m, 'used_memory'), 'free' => $g($m, 'free_memory'), 'wasted' => $g($m, 'wasted_memory')),
    'str' => array('size' => $g($i, 'buffer_size'), 'used' => $g($i, 'used_memory'), 'free' => $g($i, 'free_memory'), 'n' => $g($i, 'number_of_strings')),
    'scripts' => $g($t, 'num_cached_scripts'), 'keys' => $g($t, 'num_cached_keys'), 'max_keys' => $g($t, 'max_cached_keys'),
    'hits' => $g($t, 'hits'), 'misses' => $g($t, 'misses'),
    'oom' => $g($t, 'oom_restarts'), 'hash' => $g($t, 'hash_restarts'), 'manual' => $g($t, 'manual_restarts'),
    'start' => $g($t, 'start_time'), 'last_restart' => $g($t, 'last_restart_time'),
    'cfg' => array(
        'memory_mb' => (int) ini_get('opcache.memory_consumption'),
        'interned_mb' => (int) ini_get('opcache.interned_strings_buffer'),
        'max_files' => (int) ini_get('opcache.max_accelerated_files'),
        'validate' => (int) ini_get('opcache.validate_timestamps'),
        'reval' => (int) ini_get('opcache.revalidate_freq'),
        'max_wasted' => (int) ini_get('opcache.max_wasted_percentage'),
        'jit' => (string) ini_get('opcache.jit_buffer_size'),
    ),
    'by' => $by,
);
echo json_encode($out);
"""

def utc(epoch):
    if not epoch:
        return None
    return datetime.datetime.utcfromtimestamp(int(epoch)).strftime("%Y-%m-%dT%H:%M:%SZ")

def ini_settings(ver):
    """The opcache lines as written in php.ini and conf.d; the last one read wins, as in PHP."""
    found = {}
    files = [ETC + "/" + ver + "/fpm/php.ini"] + sorted(glob.glob(ETC + "/" + ver + "/fpm/conf.d/*.ini"))
    for path in files:
        try:
            with open(path, errors="replace") as f:
                for line in f:
                    m = re.match(r"^\s*(opcache\.[a-z_]+)\s*=\s*\"?([^\";\s]*)", line)
                    if m and m.group(1) in KEYS:
                        found[m.group(1)] = m.group(2)
        except Exception:
            pass
    if not found:
        return None
    def num(key):
        v = found.get(key)
        if v is None:
            return None
        if v.lower() in ("on", "true", "yes"):
            return 1
        if v.lower() in ("off", "false", "no", "none"):
            return 0
        try:
            return int(v)
        except Exception:
            return None
    return {"enable": num(KEYS[0]), "memory_mb": num(KEYS[1]), "interned_mb": num(KEYS[2]),
            "max_files": num(KEYS[3]), "validate": num(KEYS[4]), "reval": num(KEYS[5])}

def site_folders():
    try:
        return set(n for n in os.listdir(WWW) if os.path.isdir(WWW + "/" + n))
    except Exception:
        return set()

def pools(ver, folders):
    """Each pool on this PHP version: its socket and the site folder it serves."""
    out = []
    for path in sorted(glob.glob(ETC + "/" + ver + "/fpm/pool.d/*.conf")):
        try:
            with open(path, errors="replace") as f:
                text = "\n".join(l for l in f.read().splitlines() if not re.match(r"^\s*[;#]", l))
        except Exception:
            continue
        name = re.search(r"^\s*\[([^\]]+)\]", text, re.M)
        listen = re.search(r"^\s*listen\s*=\s*(\S+)", text, re.M)
        seen = collections.Counter(s for s in re.findall(r"/var/www/([A-Za-z0-9._-]+)/", text) if s in folders)
        site = seen.most_common(1)[0][0] if seen else None
        if site is None:
            for guess in (name.group(1) if name else "", os.path.basename(path)[:-5]):
                if guess in folders:
                    site = guess
                    break
        out.append({"listen": listen.group(1) if listen else None, "site": site})
    return out

def ensure_probe():
    try:
        if not os.path.isdir(PROBE_DIR):
            os.makedirs(PROBE_DIR)
            os.chmod(PROBE_DIR, 0o755)
        current = None
        if os.path.isfile(PROBE):
            with open(PROBE) as f:
                current = f.read()
        if current != PROBE_PHP:
            with open(PROBE + ".new", "w") as f:
                f.write(PROBE_PHP)
            os.chmod(PROBE + ".new", 0o644)
            os.rename(PROBE + ".new", PROBE)
        return True
    except Exception:
        return False

def ask(listen):
    """Run the probe through one FastCGI socket. Returns (dict, None) or (None, why)."""
    def rec(kind, body):
        return struct.pack("!BBHHBx", 1, kind, 1, len(body), 0) + body
    def pair(k, v):
        k, v = k.encode(), v.encode()
        head = b""
        for n in (len(k), len(v)):
            head += struct.pack("!B", n) if n < 128 else struct.pack("!I", n | 0x80000000)
        return head + k + v
    params = b"".join(pair(k, v) for k, v in (
        ("SCRIPT_FILENAME", PROBE), ("SCRIPT_NAME", "/opcache-probe.php"),
        ("REQUEST_URI", "/opcache-probe.php"), ("DOCUMENT_ROOT", PROBE_DIR),
        ("REQUEST_METHOD", "GET"), ("QUERY_STRING", ""), ("SERVER_PROTOCOL", "HTTP/1.1"),
        ("GATEWAY_INTERFACE", "CGI/1.1"), ("SERVER_SOFTWARE", "__FLEET_PREFIX__-fleet-agent"),
        ("REMOTE_ADDR", "127.0.0.1"), ("SERVER_NAME", "localhost"), ("SERVER_PORT", "0"),
        ("FLEET_WWW", WWW)))
    try:
        if listen.startswith("/"):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            target = listen
        else:
            host, _, port = listen.rpartition(":")
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            target = (host or "127.0.0.1", int(port))
        s.settimeout(TIMEOUT)
        s.connect(target)
        s.sendall(rec(1, struct.pack("!HB5x", 1, 0)) + rec(4, params) + rec(4, b"") + rec(5, b""))
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > 8 * 1024 * 1024:
                break
        s.close()
    except Exception as e:
        return None, "no_answer: " + type(e).__name__
    out, err, i = b"", b"", 0
    while i + 8 <= len(buf):
        _, kind, _, length, pad = struct.unpack("!BBHHB", buf[i:i + 7])
        body = buf[i + 8:i + 8 + length]
        i += 8 + length + pad
        if kind == 6:
            out += body
        elif kind == 7:
            err += body
    head, _, body = out.partition(b"\r\n\r\n")
    try:
        data = json.loads(body.decode("utf-8", "replace"))
        if isinstance(data, dict) and "php" in data:
            return data, None
    except Exception:
        pass
    said = (err or body or head).decode("utf-8", "replace").strip().replace("\n", " ")
    return None, "blocked: " + re.sub(r"\s+", " ", said)[:120]

def live(found):
    by = []
    for site, pair_ in (found.get("by") or {}).items():
        by.append({"site": site or "other", "scripts": int(pair_[0]), "bytes": int(pair_[1])})
    by.sort(key=lambda r: (-r["bytes"], r["site"]))
    keep = ("enabled", "full", "mem", "str", "scripts", "keys", "max_keys", "hits", "misses",
            "oom", "hash", "manual", "cfg", "php")
    row = {k: found.get(k) for k in keep}
    row["start"] = utc(found.get("start"))
    row["last_restart"] = utc(found.get("last_restart"))
    row["by_site"] = by[:SITES_MAX]
    row["sites_cut"] = len(by) > SITES_MAX
    return row

versions = []
try:
    names = sorted(n for n in os.listdir(ETC) if re.match(r"^\d+\.\d+$", n) and os.path.isdir(ETC + "/" + n + "/fpm"))
except Exception:
    names = []
folders = site_folders()
probe_ok = ensure_probe() if names else False
for ver in names:
    p = pools(ver, folders)
    row = {"version": ver, "pools": len(p),
           "sites": sorted(set(x["site"] for x in p if x["site"])),
           "ini": ini_settings(ver), "live": None, "live_error": None}
    sockets = [x["listen"] for x in p if x["listen"] and (not x["listen"].startswith("/") or os.path.exists(x["listen"]))]
    # A site's own pool first: "www" is the stock pool and may not be running.
    sockets.sort(key=lambda l: 0 if any(x["listen"] == l and x["site"] for x in p) else 1)
    if not probe_ok:
        row["live_error"] = "probe_not_written"
    elif not sockets:
        row["live_error"] = "no_pool"
    else:
        why = None
        for listen in sockets[:SOCKETS_TRIED]:
            if time.time() - START > BUDGET:
                why = why or "out_of_time"
                break
            found, why = ask(listen)
            if found is not None:
                if found.get("err"):
                    row["live_error"] = found["err"]
                    row["php"] = found.get("php")
                else:
                    row["live"] = live(found)
                why = None
                break
        if why:
            row["live_error"] = why
    versions.append(row)

sys.stdout.write(json.dumps({"v": 1, "versions": versions}, separators=(",", ":")))
# --- opcache report: end ---
OPC_PY
    OPC_RC=$?
    if [ "$OPC_RC" -eq 0 ] && [ -s "$OPC_TMP" ]; then
        OPC_CODE=$( { printf '{ %s "p_server_id": %s, "p_report": ' "$TOKEN_FIELD" "$SERVER_ID"; cat "$OPC_TMP"; printf ' }'; } \
          | curl -s -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
              "$SUPABASE_URL/rest/v1/rpc/report_opcache" \
              -H "apikey: $SUPABASE_KEY" \
              -H "Authorization: Bearer $SUPABASE_KEY" \
              -H "Content-Type: application/json" \
              --data-binary @-)
        if [ "$OPC_CODE" = 204 ] || [ "$OPC_CODE" = 200 ]; then
            echo "OPcache report synced: $(grep -o '"version":' "$OPC_TMP" | wc -l | tr -d ' ') PHP version(s)"
        else
            echo "Failed to sync OPcache report. HTTP Code: $OPC_CODE"
        fi
    else
        echo "OPcache report not built (python3 exit $OPC_RC); nothing sent"
    fi
    rm -f "$OPC_TMP"
fi
