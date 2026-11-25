#!/bin/bash
# ==============================================================================
# The names this deployment installs under, read from one file
# ==============================================================================
# Sourced by every fleet script that names something it installs on a server.
# Not executable on its own.
#
# ONE SOURCE: fleet.config.ts at the top of the repository, the same file the
# dashboard reads. Sourcing this sets and exports:
#
#   FLEET_PREFIX            server.prefix      files and the Fail2Ban action: <prefix>-cloudflare
#   FLEET_JAIL_PREFIX       server.jailPrefix  Fail2Ban jails and filters: <jailPrefix>-<site>-<hash>-h
#   FLEET_NAME              name               the "Managed by <name>" line in installed files
#   FLEET_BRAND             (worked out)       the prefix with a capital first letter: marks
#                                              firewall rules and comments made for this deployment
#   FLEET_JAIL_SITE_CHARS   (worked out)       how much of a site's name fits in a jail name
#   FLEET_JAIL_UPPER        (worked out)       the jail prefix in capitals: starts the names of the
#                                              settings and variables inside installed programs
#
# A value already set in the environment wins over the file (the self-tests use
# that). Each one is checked before it is used.
#
# IT NEVER FALLS BACK TO A DEFAULT. If the file cannot be read, a key is there
# twice or not at all, or a value has a character it should not, sourcing this
# file STOPS the script that sourced it and says why. A wrong prefix would not
# fail on a server: it would install a second copy of a firewall action beside
# the first one, under another name, and both would run.
#
# HOW THE NAMES REACH A SERVER. A program that runs on a server cannot read the
# config, so its text carries placeholders (__FLEET_PREFIX__, __FLEET_NAME__ and
# so on) and the script that sends it fills them in first:
#
#   REMOTE="$(fleet_names_script "$HERE/some.remote.sh")" || exit 1   # a file
#   fleet_names_fill_var REMOTE_PROGRAM || exit 1                     # text already in a variable
#
# Both refuse to hand back text with a placeholder still in it. Each server
# program also checks its own prefix on its first lines and stops if it was sent
# unfilled. A file that stays on a server (a certbot hook, the telemetry agent)
# is written there with the values already in it.
# ==============================================================================

FLEET_NAMES_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prints the path of the config this run reads (it may not exist).
# FLEET_CONFIG_FILE is for the self-test (scripts/test-fleet-names.sh).
fleet_config_file() {
    if [ -n "${FLEET_CONFIG_FILE:-}" ]; then printf '%s' "$FLEET_CONFIG_FILE"; return 0; fi
    printf '%s' "$(cd "$FLEET_NAMES_HERE/.." && pwd)/fleet.config.ts"
}

# fleet_config_value <key>: prints the value of the ONE line written
#     key: "value",
# in the config. No such line, or more than one, is an error: nothing is guessed.
fleet_config_value() {
    local key="$1" f n line
    f="$(fleet_config_file)"
    if [ ! -r "$f" ]; then
        echo "ABORT: cannot read $f, the file that names this deployment." >&2
        return 1
    fi
    line="^[[:space:]]*$key:[[:space:]]*\"([^\"\\\\]*)\",?[[:space:]]*(//.*)?\$"
    n=$(grep -cE "$line" "$f")
    if [ "$n" != 1 ]; then
        echo "ABORT: $f has $n lines of the form  $key: \"...\"  and exactly one is needed." >&2
        return 1
    fi
    grep -E "$line" "$f" | sed -E "s/^[[:space:]]*$key:[[:space:]]*\"([^\"]*)\".*\$/\\1/"
}

# _fleet_names_check <what> <value> <pattern> <rule in words>
_fleet_names_check() {
    local re="$3"
    if [[ "$2" =~ $re ]]; then return 0; fi
    {
        echo "ABORT: $1 is \"$2\". It must be $4."
        echo "       It comes from $(fleet_config_file), or from the environment when set there."
    } >&2
    return 1
}

# Sets and exports the five values. Returns 1, with the reason on stderr, if any
# of them cannot be read or is not valid.
fleet_names_load() {
    local v first
    if [ -z "${FLEET_PREFIX:-}" ]; then v=$(fleet_config_value prefix) || return 1; FLEET_PREFIX="$v"; fi
    if [ -z "${FLEET_JAIL_PREFIX:-}" ]; then v=$(fleet_config_value jailPrefix) || return 1; FLEET_JAIL_PREFIX="$v"; fi
    if [ -z "${FLEET_NAME:-}" ]; then v=$(fleet_config_value name) || return 1; FLEET_NAME="$v"; fi
    _fleet_names_check "the server prefix (server.prefix, FLEET_PREFIX)" "$FLEET_PREFIX" '^[a-z][a-z0-9]{1,14}$' \
        "2 to 15 lowercase letters and digits, starting with a letter" || return 1
    _fleet_names_check "the jail prefix (server.jailPrefix, FLEET_JAIL_PREFIX)" "$FLEET_JAIL_PREFIX" '^[a-z][a-z0-9]{1,14}$' \
        "2 to 15 lowercase letters and digits, starting with a letter" || return 1
    _fleet_names_check "the product name (name, FLEET_NAME)" "$FLEET_NAME" '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$' \
        "1 to 40 letters, digits, spaces, dots, hyphens and underscores" || return 1
    first=$(printf '%s' "$FLEET_PREFIX" | cut -c1 | tr 'a-z' 'A-Z')
    FLEET_BRAND="$first${FLEET_PREFIX#?}"
    # A jail's firewall chain is named f2b-<jail>, and iptables stops at 28
    # characters:  f2b- + <jail prefix> + - + <site> + - + <four hex> + -h.
    # Up to 12 characters of the site's name are used, fewer under a long prefix.
    FLEET_JAIL_SITE_CHARS=$((16 - ${#FLEET_JAIL_PREFIX}))
    [ "$FLEET_JAIL_SITE_CHARS" -le 12 ] || FLEET_JAIL_SITE_CHARS=12
    if [ "$FLEET_JAIL_SITE_CHARS" -lt 1 ]; then
        echo "ABORT: the jail prefix \"$FLEET_JAIL_PREFIX\" leaves no room for a site's name in a jail name (iptables allows 28 characters). Use 15 characters or fewer." >&2
        return 1
    fi
    FLEET_JAIL_UPPER=$(printf '%s' "$FLEET_JAIL_PREFIX" | tr 'a-z' 'A-Z')
    export FLEET_PREFIX FLEET_JAIL_PREFIX FLEET_NAME FLEET_BRAND FLEET_JAIL_SITE_CHARS FLEET_JAIL_UPPER
    return 0
}

# Fills the placeholders in the text on standard input. Extra sed arguments are
# added after the names (a sender with a value of its own: -e 's|__X__|...|g').
# The values were checked above, so none of them can break out of the pattern.
fleet_names_fill() {
    LC_ALL=C sed \
        -e "s/__FLEET_PREFIX__/$FLEET_PREFIX/g" \
        -e "s/__FLEET_JAIL_PREFIX__/$FLEET_JAIL_PREFIX/g" \
        -e "s/__FLEET_JAIL_SITE_CHARS__/$FLEET_JAIL_SITE_CHARS/g" \
        -e "s/__FLEET_JAIL_UPPER__/$FLEET_JAIL_UPPER/g" \
        -e "s/__FLEET_BRAND__/$FLEET_BRAND/g" \
        -e "s/__FLEET_NAME__/$FLEET_NAME/g" "$@"
}

# Succeeds when the text on standard input has no placeholder left in it.
fleet_names_all_filled() {
    local left
    left=$(LC_ALL=C grep -oE '__FLEET_[A-Z_]+__' | sort -u | tr '\n' ' ')
    [ -z "$left" ] && return 0
    echo "ABORT: a placeholder was not filled in: $left" >&2
    return 1
}

# fleet_names_script <file> [extra sed arguments]: prints the file with the
# placeholders filled in. Fails, printing nothing, if the file cannot be read or
# a placeholder is left.
fleet_names_script() {
    local f="$1" out; shift
    if [ ! -r "$f" ]; then echo "ABORT: cannot read $f" >&2; return 1; fi
    # The X keeps the file's last newlines through $( ), which drops them.
    out=$(fleet_names_fill "$@" < "$f"; printf X) || return 1
    out="${out%X}"
    printf '%s' "$out" | fleet_names_all_filled || return 1
    printf '%s' "$out"
}

# fleet_names_fill_var <variable name> [extra sed arguments]: fills the
# placeholders in that variable, in place, byte for byte otherwise (a last
# newline, or the lack of one, is kept: a hook's checksum depends on it).
fleet_names_fill_var() {
    local __name="$1" __out; shift
    # The X is the last line for sed, so sed's own newline lands after it and
    # $( ) takes it off again; then the X goes.
    __out=$(printf '%sX' "${!__name}" | fleet_names_fill "$@") || return 1
    __out="${__out%X}"
    printf '%s' "$__out" | fleet_names_all_filled || return 1
    printf -v "$__name" '%s' "$__out"
}

# server.repoUrl-style values a single sender needs. Each: the environment wins,
# else the config's one line; checked; never a default.
#
# Where this deployment's code lives. Written into the Documentation= line of
# the sign-in service installed on servers.
fleet_repo_url() {
    local v="${FLEET_REPO_URL:-}"
    if [ -z "$v" ]; then v=$(fleet_config_value repoUrl) || return 1; fi
    _fleet_names_check "the repository address (repoUrl, FLEET_REPO_URL)" "$v" '^https://[A-Za-z0-9][A-Za-z0-9._/-]{3,199}$' \
        "an https address with no query, spaces or quotes" || return 1
    printf '%s' "$v"
}
# The launchd label of the daily WAF refresh job on this Mac.
fleet_waf_refresh_label() {
    local v="${FLEET_WAF_REFRESH_LABEL:-}"
    if [ -z "$v" ]; then v=$(fleet_config_value wafRefreshLabel) || return 1; fi
    _fleet_names_check "the WAF refresh job's label (wafRefreshLabel, FLEET_WAF_REFRESH_LABEL)" "$v" '^[A-Za-z0-9]+(\.[A-Za-z0-9-]+)+$' \
        "a reverse-DNS name such as com.example.fleet-waf-refresh" || return 1
    printf '%s' "$v"
}

# Sourcing this file loads the names, or stops the script that sourced it.
fleet_names_load || exit 1
