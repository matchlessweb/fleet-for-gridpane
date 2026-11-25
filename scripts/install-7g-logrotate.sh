#!/bin/bash
# ==============================================================================
# 7G WAF log rotation — audit / clone the rule to the rest of the fleet
# ==============================================================================
# GridPane ships logrotate rules for debug.log and gp-cron.log but none for
# 7g.log, so the WAF log grows until the disk does. The dashboard's "7G log retention" generator writes the missing
# rule one server at a time; this does the rest in one pass.
#
# Modes:
#   bash scripts/install-7g-logrotate.sh           # AUDIT (read-only): who has the
#                                                  #   rule, and current 7g.log footprint
#   bash scripts/install-7g-logrotate.sh --clone   # copy the golden server's rule to every
#                                                  #   server that lacks it, then dry-run it
#   bash scripts/install-7g-logrotate.sh --reclaim # force a rotation now on servers that
#                                                  #   HAVE the rule. NOTE: the rule uses
#                                                  #   delaycompress, so this archives the
#                                                  #   live log but does NOT shrink the
#                                                  #   footprint — log.1 stays uncompressed
#                                                  #   until the NEXT rotation. Disk returns
#                                                  #   on the following daily run.
#   bash scripts/install-7g-logrotate.sh --set     # write the FLEET STANDARD rule below to
#                                                  #   every server, replacing ours and
#                                                  #   deactivating any other rule that
#                                                  #   matches the same logs
#
# The golden server (see lib-fleet-servers.sh) is the source of truth on purpose:
# it holds the cadence/keep/compress/maxsize actually chosen in the UI, so cloning
# cannot drift from that decision.
#
# The rule's file name and its "Managed by" line come from fleet.config.ts
# (lib-fleet-names.sh), the same values the dashboard's generator uses.
#
# --clone is idempotent and never overwrites an existing rule. --reclaim archives
# (compresses) the current log rather than discarding it; nothing is deleted.
# ==============================================================================

set -u

# Shared SSH runner: retries once on a connect-level failure, and quotes
# arguments so the remote shell cannot re-split them.
LIB="$(cd "$(dirname "$0")" && pwd)/lib-fleet-ssh.sh"
[ -r "$LIB" ] || { echo "ABORT: cannot read $LIB (keep it beside this script)"; exit 1; }
# shellcheck source=lib-fleet-ssh.sh
. "$LIB"

# The server list lives in one file outside the repository: see lib-fleet-servers.sh.
SERVERS_LIB="$(cd "$(dirname "$0")" && pwd)/lib-fleet-servers.sh"
[ -r "$SERVERS_LIB" ] || { echo "ABORT: cannot read $SERVERS_LIB (keep it beside this script)"; exit 1; }
# shellcheck source=lib-fleet-servers.sh
. "$SERVERS_LIB"
fleet_servers_load || exit 1

# The names this installs under come from fleet.config.ts; this stops here if
# they cannot be read.
# shellcheck source=lib-fleet-names.sh
. "$(cd "$(dirname "$0")" && pwd)/lib-fleet-names.sh"

GOLDEN_IP="$FLEET_GOLDEN_IP"; GOLDEN_LABEL="$FLEET_GOLDEN_LABEL"   # the server marked |golden in the server list; it already carries the rule
CONFIG_PATH="/etc/logrotate.d/$FLEET_PREFIX-7g-logs"

# Optional 2nd arg: run against ONE server only (IP or label), so a change can be
# proven on a single box before it touches the fleet.
ONLY="${2:-}"

MODE="audit"
case "${1:-}" in
    --clone)   MODE="clone" ;;
    --reclaim) MODE="reclaim" ;;
    --set)     MODE="set" ;;
    "")        MODE="audit" ;;
    *) echo "Unknown option: $1"; echo "Use: (no arg) | --clone | --set | --reclaim"; exit 2 ;;
esac

# --- the fleet standard -------------------------------------------------------
# Keep in step with the defaults in components/waf/log-retention-generator.tsx
# (daily / rotate 30 / maxsize 50M) so the dashboard generator and this script
# never emit different rules.
#
# Daily beats monthly here for a reason worth remembering: with a monthly
# cadence the 50M ceiling only catches a single runaway log, so a server whose
# volume is spread across many mid-sized files just accumulates, with nothing
# over the ceiling. Thirty compressed dailies cost less disk than one
# un-rotated month.
STANDARD_RULE='# Managed by __FLEET_NAME__ — 7G WAF log rotation.
# GridPane rotates debug.log and gp-cron.log but ships no rule for 7g.log.
/var/www/*/logs/7g.log {
    daily
    rotate 30
    maxsize 50M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}'
fleet_names_fill_var STANDARD_RULE || exit 1      # __FLEET_NAME__ becomes the product name

KEY_FP="${FLEET_SSH_KEY_FP:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/ssh-key-fingerprint" 2>/dev/null)}"; KEY_FP="${KEY_FP:-SHA256:}"   # your key's fingerprint; with none set, any key the agent holds counts
OP_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if ssh-add -l 2>/dev/null | grep -q "$KEY_FP"; then
    echo "using system ssh-agent (fleet key already loaded — no prompts)"
elif [ -S "$OP_SOCK" ]; then
    export SSH_AUTH_SOCK="$OP_SOCK"
    echo "using 1Password SSH agent (approve the Touch ID prompts)"
else
    echo "WARNING: fleet key not found in any agent — ssh will likely fail"
fi

. "$(dirname "$0")/lib-fleet-hostkeys.sh" || exit 1; FLEET_HOSTKEY_OPTS="$(fleet_hostkey_opts)" || exit 1   # the host key a server must answer with
SSH_OPTS="$FLEET_HOSTKEY_OPTS -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3"

echo "mode: $MODE"
echo

STANDARD_B64=""
if [ "$MODE" = "set" ]; then
    STANDARD_B64=$(printf '%s' "$STANDARD_RULE" | base64 | tr -d '\n')
    echo "writing the fleet standard to every server:"
    printf '%s\n' "$STANDARD_RULE" | sed 's/^/   | /'
    echo
    echo "Any OTHER logrotate rule matching the same logs is renamed to .disabled"
    echo "(logrotate's default taboo list skips that suffix) — reversible with mv."
    echo
fi

# --- clone: read the rule off the golden server once, validate, then fan out --
GOLDEN_B64=""
if [ "$MODE" = "clone" ]; then
    fleet_require_golden || exit 1
    echo "Reading the installed rule from $GOLDEN_LABEL ($GOLDEN_IP)..."
    # Retried too: a timeout fetching the source rule aborts the entire run.
    fleet_ssh "$GOLDEN_IP" 'cat "$1"' "$CONFIG_PATH"
    GOLDEN="$FLEET_SSH_OUT"
    if [ -z "$GOLDEN" ]; then
        echo "ABORT: $GOLDEN_LABEL has no rule at $CONFIG_PATH."
        echo "       Install it there first via the dashboard's 7G log retention generator."
        exit 1
    fi
    # Guard against cloning something that isn't the rule we think it is.
    printf '%s' "$GOLDEN" | grep -q '/var/www/\*/logs/7g.log' || { echo "ABORT: rule does not target the 7g.log glob"; exit 1; }
    printf '%s' "$GOLDEN" | grep -q 'copytruncate' || { echo "ABORT: rule is missing copytruncate — it would break per-site log ownership"; exit 1; }
    GOLDEN_B64=$(printf '%s' "$GOLDEN" | base64 | tr -d '\n')
    echo "rule ok — cloning this:"
    printf '%s\n' "$GOLDEN" | sed 's/^/   | /'
    echo
fi

# Remote programs live in variables, not heredocs: a heredoc is consumed once, so
# fleet_ssh could not re-run it after a transient connect failure. Built with
# `read -r -d ''` rather than $(cat <<'X') because bash's $( ) scanner counts
# parentheses and backticks inside heredoc bodies, so a bare `audit)` closes the
# substitution early. `read` involves no substitution at all.
IFS='' read -r -d '' REMOTE_AUDIT <<'REMOTE' || true
CFG="$1"
if [ -f "$CFG" ]; then echo "rule=present"; else echo "rule=MISSING"; fi
echo "current_7g=$(du -ch /var/www/*/logs/7g.log 2>/dev/null | tail -1 | awk '{print $1}')"
echo "rotated_archives=$(ls /var/www/*/logs/7g.log.* 2>/dev/null | wc -l | tr -d ' ')"
echo "biggest=$(du -h /var/www/*/logs/7g.log 2>/dev/null | sort -rh | head -1)"

# Anything ELSE that rotates 7g.log. Two logrotate stanzas matching the same
# path make the daily run emit "duplicate log entry" and skip one of them, so a
# server that already had rotation can silently ignore the rule we installed.
# Files logrotate itself ignores must not be reported as conflicts. Its default
# taboo list covers these extensions, and it announces the skip in -d output:
#   "Ignoring gridpane-7g-waf.disabled.disabled, because of *.disabled pattern match"
# Reporting an inert file as a live rival rule is a false alarm that makes a
# clean server look broken on every future audit.
TABOO='\.(disabled|bak|old|orig|rpmsave|rpmorig|rpmnew|swp|dpkg-old|dpkg-dist|dpkg-new|ucf-old|ucf-dist|ucf-new|cfsaved)$|~$'

# Only rules for the per-site logs this script rotates (/var/www/<site>/logs/7g.log).
# GridPane's own /etc/logrotate.d/nginx (build #2258 and later) names the server-wide
# /var/log/nginx/7g.log: a different file, not a conflict, and it also rotates every
# nginx access and error log, so it must never be counted or renamed here.
OTHERS=$(grep -lsE '/var/www/[^[:space:]]*7g\.log' /etc/logrotate.d/* 2>/dev/null | grep -vE "$TABOO" | grep -v "$(basename "$CFG")" | tr '\n' ' ')
echo "other_rules_matching_7g=${OTHERS:-none}"
if [ -n "$OTHERS" ]; then
    for f in $OTHERS; do
        echo "  --- $f ---"
        grep -vE '^\s*#' "$f" | grep -vE '^\s*$' | sed 's/^/    | /'
    done
    # Does the real daily run actually accept both? -d touches nothing.
    echo "  duplicate_check:"
    logrotate -d /etc/logrotate.conf 2>&1 | grep -iE 'duplicate|error' | head -5 | sed 's/^/    /'
fi
ARCH=$(ls -t /var/www/*/logs/7g.log.* 2>/dev/null | head -3 | tr '\n' ' ')
[ -n "$ARCH" ] && echo "archive_sample=$ARCH"

# Rules for site logs that GridPane did not generate. Its own per-site configs
# are debug-log-<site>, gp-cron-logs-<site> and fortress-logs-<site> (Fortress
# auto-creates that last one — an earlier version of this audit reported them as
# hand-added on six servers, which was wrong and noisy).
HAND=$(grep -ls '/var/www' /etc/logrotate.d/* 2>/dev/null \
        | grep -vE '/(debug-log-|gp-cron-logs-|fortress-logs-)' \
        | grep -vE "$TABOO" \
        | grep -v "$(basename "$CFG")" | tr '\n' ' ')
echo "non_gridpane_site_log_rules=${HAND:-none}"
for f in $HAND; do
    echo "  --- $f ---"
    grep -vE '^\s*#' "$f" | grep -vE '^\s*$' | head -20 | sed 's/^/    | /'
done

# Print the actual schedule where a rule exists, so the rule about to be cloned
# can be read before anything is written anywhere.
if [ -f "$CFG" ]; then
    echo "schedule:"
    grep -vE '^\s*#' "$CFG" | grep -vE '^\s*$' | sed 's/^/  | /'
fi
REMOTE

IFS='' read -r -d '' REMOTE_CLONE <<'REMOTE' || true
CFG="$1"; B64="$2"
if [ -f "$CFG" ]; then echo "rule=already-present"; echo "skipped=1"; exit 0; fi
printf '%s' "$B64" | base64 -d > "$CFG"
chmod 644 "$CFG"
echo "rule=written"
echo "targets=$(grep -c '/var/www/\*/logs/7g.log' "$CFG")"
# Dry run proves logrotate parses it and sees real logs; changes nothing.
echo "--- dry run ---"
logrotate -d "$CFG" 2>&1 | grep -E 'considering log|error|does not need|log needs' | head -20 | sed 's/^/dry: /'
REMOTE

IFS='' read -r -d '' REMOTE_SET <<'REMOTE' || true
CFG="$1"; B64="$2"
# Deactivate anything else claiming the same glob. Two stanzas for one path make
# logrotate print "duplicate log entry" and skip one of them entirely, which
# can silently discard the rule just installed.
# Skip files logrotate ALREADY ignores. Its default taboo list includes
# *.disabled, so a second --set run was appending another suffix to a file that
# was already inert, making gridpane-7g-waf.disabled.disabled (a third run
# would have added another). Renaming an
# ignored file achieves nothing and makes the audit look like a live conflict.
# Same narrow match as the audit: a rule naming /var/www/.../7g.log. A bare "7g.log"
# also matched GridPane's /etc/logrotate.d/nginx, and renaming that file stops the
# rotation of every nginx access and error log on the server.
for f in $(grep -lsE '/var/www/[^[:space:]]*7g\.log' /etc/logrotate.d/* 2>/dev/null | grep -v "$(basename "$CFG")"); do
    case "$f" in
        (*.disabled) echo "already_inactive=$f"; continue ;;
    esac
    mv "$f" "$f.disabled" && echo "deactivated=$f -> $f.disabled"
done
printf '%s' "$B64" | base64 -d > "$CFG"
chmod 644 "$CFG"
echo "rule=written"
echo "cadence=$(grep -oE '^\s+(daily|weekly|monthly)' "$CFG" | tr -d ' ') rotate=$(grep -oE 'rotate [0-9]+' "$CFG" | awk '{print $2}')"
# Verify against the REAL daily run, not just our file: this is what catches a
# duplicate, and it also proves the .disabled rename actually took it out of play.
echo "dupes=$(logrotate -d /etc/logrotate.conf 2>&1 | grep -ciE 'duplicate log entry|error in file')"
echo "--- dry run ---"
logrotate -d "$CFG" 2>&1 | grep -E 'needs rotating|does not need|error' | sort | uniq -c | head -6 | sed 's/^/dry: /'
REMOTE

IFS='' read -r -d '' REMOTE_RECLAIM <<'REMOTE' || true
CFG="$1"
if [ ! -f "$CFG" ]; then echo "rule=MISSING"; echo "skipped=1"; exit 0; fi
echo "before=$(du -ch /var/www/*/logs/7g.log* 2>/dev/null | tail -1 | awk '{print $1}')"
logrotate -f "$CFG" 2>&1 | sed 's/^/logrotate: /'
echo "after=$(du -ch /var/www/*/logs/7g.log* 2>/dev/null | tail -1 | awk '{print $1}')"
echo "archives=$(ls /var/www/*/logs/7g.log.* 2>/dev/null | wc -l | tr -d ' ')"
REMOTE

for entry in $SERVERS; do
    IP="${entry%%|*}"; rest="${entry#*|}"
    ID="${rest%%|*}"; LABEL="${rest#*|}"
    if [ -n "$ONLY" ] && [ "$ONLY" != "$IP" ] && [ "$ONLY" != "$LABEL" ]; then continue; fi
    echo "── $LABEL ($IP) ─────────────────────────"

    # fleet_ssh must NOT be wrapped in $( ): it returns its results in globals,
    # which a subshell would discard — the caller would then report the PREVIOUS
    # server's exit code on a failure.
    case "$MODE" in
        (audit)   fleet_ssh "$IP" "$REMOTE_AUDIT"   "$CONFIG_PATH" ;;
        (clone)   fleet_ssh "$IP" "$REMOTE_CLONE"   "$CONFIG_PATH" "$GOLDEN_B64" ;;
        (set)     fleet_ssh "$IP" "$REMOTE_SET"     "$CONFIG_PATH" "$STANDARD_B64" ;;
        (reclaim) fleet_ssh "$IP" "$REMOTE_RECLAIM" "$CONFIG_PATH" ;;
    esac
    OUT="$FLEET_SSH_OUT"

    if [ -z "$OUT" ]; then
        fleet_ssh_report_failure
        echo; continue
    fi
    echo "$OUT" | sed 's/^/   /'

    case "$MODE" in
        set)
            if echo "$OUT" | grep -q 'rule=written' && echo "$OUT" | grep -q 'dupes=0'; then
                echo "   ✓ standard rule active, no duplicate entries"
            else
                echo "   ✗ SET DID NOT VERIFY — a duplicate may still be shadowing it"
            fi
            ;;
        clone)
            if echo "$OUT" | grep -q 'rule=already-present'; then
                echo "   — already had the rule, left alone"
            elif echo "$OUT" | grep -q 'rule=written' && echo "$OUT" | grep -q 'targets=1'; then
                echo "   ✓ rule installed (system logrotate picks it up on its next daily run)"
            else
                echo "   ✗ CLONE DID NOT VERIFY — check the output above"
            fi
            ;;
        reclaim)
            if echo "$OUT" | grep -q 'rule=MISSING'; then
                echo "   — no rule here yet; run --clone first"
            elif echo "$OUT" | grep -q '^   *archives=[1-9]'; then
                echo "   ✓ rotated (history archived, live log restarted empty)"
            fi
            ;;
    esac
    echo
done

echo "Done."
# Never describe a scoped run as if it covered the fleet — a summary that
# overstates what happened is how a half-applied change gets called finished.
[ -n "$ONLY" ] && echo "(scoped to \"$ONLY\" — the other servers were not touched)"
case "$MODE" in
    set)     [ -n "$ONLY" ] \
               && echo "Re-run without an argument to apply the standard to the rest of the fleet." \
               || echo "Every server is on daily/rotate 30. Tonight's run rotates the backlog on its own." ;;
    clone)   echo "Next: --reclaim rotates now, but delaycompress means the disk only returns on the following run." ;;
    reclaim) echo "before == after is EXPECTED: delaycompress leaves log.1 uncompressed until the next"
             echo "rotation, so the bytes moved filename rather than shrinking. Disk returns on tonight's"
             echo "daily run. Re-run the audit tomorrow to see the real figure." ;;
    audit)   echo "Servers showing rule=MISSING need --clone, which copies the golden server's rule to them."
             # On a new fleet the golden server has no rule either, and --clone has nothing to copy.
             [ -n "$GOLDEN_LABEL" ] && echo "If the golden server ($GOLDEN_LABEL) shows rule=MISSING too, give it the standard rule first: --set $GOLDEN_LABEL" ;;
esac
