#!/bin/bash
# ==============================================================================
# The fleet's server list, read from one file
# ==============================================================================
# Sourced by every fleet script that needs to know which servers exist. Not
# executable on its own.
#
# The list is NOT in the repository: it names real machines. It is read from the
# first of these that exists:
#
#   1. the file named by $FLEET_SERVERS_FILE
#   2. scripts/servers.local            (gitignored; one checkout)
#   3. ~/.config/fleet/servers          (every checkout and worktree on this machine)
#
# Make it with `npm run servers:export` (writes it from the dashboard's database),
# or copy scripts/servers.example and edit it.
#
# FORMAT, one server per line; blank lines and lines starting with # are ignored:
#
#   <ip address>|<GridPane server id>|<label>
#   <ip address>|<GridPane server id>|<label>|golden
#
# "golden" marks the ONE server whose installed files the install scripts copy to
# the others (fix-telemetry-crontabs.sh, install-7g-logrotate.sh). Move the mark
# before that server is retired.
#
# A script that needs the list and cannot read it stops and says where it looked.
# It never falls back to a built-in list: a stale built-in list is how a server
# gets skipped without anyone noticing.
# ==============================================================================

FLEET_SERVERS_LINE='^[0-9a-fA-F.:]+\|[0-9]+\|[A-Za-z0-9_.-]+(\|golden)?$'
FLEET_SERVERS_LOADED=""
SERVERS=""
FLEET_GOLDEN_LABEL=""
FLEET_GOLDEN_IP=""

# Prints the path of the list this run will use (it may not exist).
fleet_servers_file() {
    if [ -n "${FLEET_SERVERS_FILE:-}" ]; then printf '%s' "$FLEET_SERVERS_FILE"; return 0; fi
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -r "$here/servers.local" ]; then printf '%s' "$here/servers.local"; return 0; fi
    printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/fleet/servers"
}

# Sets SERVERS (one "ip|id|label" per line), FLEET_GOLDEN_LABEL and FLEET_GOLDEN_IP.
# Returns 1, with the reason on stderr, if the list is missing or not right.
fleet_servers_load() {
    local f here bad dup golden
    f="$(fleet_servers_file)"
    if [ ! -r "$f" ]; then
        here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        {
            echo "ABORT: no server list. Looked for: $f"
            [ -n "${FLEET_SERVERS_FILE:-}" ] || echo "       and before that: $here/servers.local"
            echo "       Make one with: npm run servers:export"
            echo "       or copy $here/servers.example to one of those places and edit it."
        } >&2
        return 1
    fi
    bad=$(grep -nvE '^[[:space:]]*(#.*)?$' "$f" | grep -vE "^[0-9]+:${FLEET_SERVERS_LINE#^}" | head -3)
    if [ -n "$bad" ]; then
        { echo "ABORT: $f has a line that is not <ip>|<id>|<label> or <ip>|<id>|<label>|golden:"; printf '%s\n' "$bad" | sed 's/^/       line /'; } >&2
        return 1
    fi
    SERVERS=$(grep -E "$FLEET_SERVERS_LINE" "$f" | sed 's/|golden$//')
    if [ -z "$SERVERS" ]; then echo "ABORT: $f lists no servers." >&2; return 1; fi
    dup=$(printf '%s\n' "$SERVERS" | cut -d'|' -f3 | sort | uniq -d | head -1)
    if [ -n "$dup" ]; then echo "ABORT: $f lists the label \"$dup\" more than once." >&2; return 1; fi
    golden=$(grep -E "$FLEET_SERVERS_LINE" "$f" | grep -E '\|golden$')
    if [ "$(printf '%s' "$golden" | grep -c .)" -gt 1 ]; then echo "ABORT: $f marks more than one server golden." >&2; return 1; fi
    FLEET_GOLDEN_IP=$(printf '%s' "$golden" | cut -d'|' -f1)
    FLEET_GOLDEN_LABEL=$(printf '%s' "$golden" | cut -d'|' -f3)
    FLEET_SERVERS_LOADED=1
    return 0
}

# Prints the IP of the server with exactly this label; prints nothing if there is
# none. Loads the list on first use.
fleet_server_ip() {
    if [ -z "$FLEET_SERVERS_LOADED" ]; then fleet_servers_load || return 1; fi
    printf '%s\n' "$SERVERS" | awk -F'|' -v want="$1" '$3 == want { print $1; exit }'
}

# Stops unless one server is marked golden. Call it only on the path that copies
# from that server.
fleet_require_golden() {
    [ -n "$FLEET_GOLDEN_IP" ] && return 0
    echo "ABORT: no server is marked golden in $(fleet_servers_file). Add |golden to the line of the server to copy from." >&2
    return 1
}
