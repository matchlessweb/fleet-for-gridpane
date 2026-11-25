#!/bin/bash
# ==============================================================================
# A Cloudflare API token, looked for in one way by every script that needs one
# ==============================================================================
# Sourced by fleet-fail2ban-apply.sh and fleet-fail2ban-token-proof.sh. Not
# executable on its own. The WAF inventory (waf-inventory.py) looks in the same
# three places, in the same order, with the same checks: change one, change both
# (scripts/test-waf-inventory.py runs the two side by side).
#
#   fleet_cf_token <name> <variable>
#
# puts the token in <variable> and prints nothing on standard output. On failure
# it returns 1 with the reason on standard error, and the variable is left empty.
#
# <name> says which token:
#
#   all-read       the read-only token the WAF inventory uses (it reads zones,
#                  their custom and rate-limit rules, and their DNS records)
#   f2b-<label>    one server's Fail2Ban token, <label> being the server's label
#                  in lower case with _ written as -   (web1 -> f2b-web1)
#
# WHERE IT IS LOOKED FOR, in this order. The first one that is set is the one
# used: if it is set and does not work, the script stops rather than trying the
# next, so you always know which token a run used.
#
#   1. The environment variable FLEET_CF_TOKEN_<NAME>, the name in capitals with
#      every other character written as _ :
#         FLEET_CF_TOKEN_ALL_READ      FLEET_CF_TOKEN_F2B_WEB1
#
#   2. A command of your own, written on one line in
#         ~/.config/fleet/cloudflare-token-command
#      with {name} where the token's name goes. It is run as it is written (no
#      shell: no quotes, pipes or variables) and must print the token and
#      nothing else. This is how a password manager is used:
#         pass show cloudflare/{name}
#         op read op://Private/cloudflare-{name}/credential
#      Blank lines and lines starting with # are ignored. The file must be yours
#      and writable by nobody else.
#
#   3. A file that holds the token and nothing else:
#         ~/.config/fleet/tokens/cloudflare-<name>.token
#      readable by you only (chmod 600). A file anyone else can read is refused.
#
# ~/.config is $XDG_CONFIG_HOME when that is set.
#
# THE TOKEN IS NEVER PRINTED, never placed on a command line (where `ps` shows
# it to every user of the machine) and never written to a file by this code.
# Messages name where a value came from and how long it is, never the value. A
# value with a character no API token has (a space, a quote, a line break) is
# refused: the Fail2Ban scripts put the token inside the text they send down
# ssh's standard input, and a quote there would end that text early.
# ==============================================================================

# Set by a successful fleet_cf_token: where the token came from, in words.
FLEET_CF_TOKEN_SOURCE=""

# The folder the settings live in.
fleet_token_config_dir() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/fleet"; }

# fleet_cf_token_env_name <name>: the environment variable for that token.
fleet_cf_token_env_name() { printf 'FLEET_CF_TOKEN_%s' "$(printf '%s' "$1" | tr 'a-z' 'A-Z' | tr -c 'A-Z0-9' '_')"; }

# _fleet_token_mode <file>: the ten-character mode `ls -l` prints, following a link.
_fleet_token_mode() { ls -Lld "$1" 2>/dev/null | cut -c1-10; }

# What to set, said once, the same way wherever a token is missing.
_fleet_cf_token_help() {
    local name="$1" dir
    dir="$(fleet_token_config_dir)"
    {
        echo "       Set ONE of these (the first one found is used):"
        echo "         1. the environment variable $(fleet_cf_token_env_name "$name")"
        echo "         2. a command that prints the token, on one line in $dir/cloudflare-token-command"
        echo "            with {name} where the token's name goes, for example:  pass show cloudflare/{name}"
        echo "         3. the token alone in the file $dir/tokens/cloudflare-$name.token  (then: chmod 600 that file)"
    } >&2
}

fleet_cf_token() {
    local __name="${1:-}" __var="${2:-}" __env __dir __cmdfile __file __line __val="" __src="" __mode __rc __w
    local __words __argv
    local __var_re='^[A-Za-z_][A-Za-z0-9_]*$' __name_re='^[a-z0-9][a-z0-9.-]{0,62}$' __token_re='^[A-Za-z0-9._~+/=-]+$'
    FLEET_CF_TOKEN_SOURCE=""
    if [[ ! "$__var" =~ $__var_re ]]; then
        echo "ABORT: fleet_cf_token needs a token name and the name of a variable to put the token in." >&2
        return 1
    fi
    printf -v "$__var" '%s' ""
    if [[ ! "$__name" =~ $__name_re ]]; then
        echo "ABORT: \"$__name\" is not a token name (lower-case letters, digits, dots and hyphens)." >&2
        return 1
    fi
    __env="$(fleet_cf_token_env_name "$__name")"
    __dir="$(fleet_token_config_dir)"
    __cmdfile="$__dir/cloudflare-token-command"
    __file="$__dir/tokens/cloudflare-$__name.token"
    __line=""
    if [ -r "$__cmdfile" ]; then
        __line="$(grep -vE '^[[:space:]]*(#.*)?$' "$__cmdfile" | head -1 | tr -d '\r')"
    fi

    if [ -n "${!__env:-}" ]; then
        __src="the environment variable $__env"
        __val="${!__env}"
    elif [ -n "$__line" ]; then
        __src="the command in $__cmdfile"
        __mode="$(_fleet_token_mode "$__cmdfile")"
        if [ ! -O "$__cmdfile" ] || [ "$(printf '%s' "$__mode" | cut -c6)$(printf '%s' "$__mode" | cut -c9)" != "--" ]; then
            echo "ABORT: $__cmdfile names a command this script would run, and someone else can change it." >&2
            echo "       Make it yours alone: chmod 600 \"$__cmdfile\"" >&2
            return 1
        fi
        # Split on spaces only: nothing in the line is expanded or run by a shell.
        read -r -a __words <<< "$__line"
        __argv=()
        for __w in "${__words[@]}"; do __argv+=("${__w//\{name\}/$__name}"); done
        if ! command -v "${__argv[0]}" >/dev/null 2>&1; then
            echo "ABORT: the token command \"${__argv[0]}\" (from $__cmdfile) is not on the PATH." >&2
            return 1
        fi
        __val="$("${__argv[@]}" </dev/null)"; __rc=$?
        if [ "$__rc" != 0 ]; then
            echo "ABORT: the token command failed (exit $__rc):  ${__argv[*]}" >&2
            echo "       It comes from $__cmdfile. Nothing else was tried." >&2
            return 1
        fi
    elif [ -e "$__file" ]; then
        __src="the file $__file"
        __mode="$(_fleet_token_mode "$__file")"
        if [ ! -f "$__file" ] || [ ! -r "$__file" ] || [ "$(printf '%s' "$__mode" | cut -c5-10)" != "------" ]; then
            echo "ABORT: $__file must be a file only you can read (it is ${__mode:-unreadable})." >&2
            echo "       Fix it with: chmod 600 \"$__file\"" >&2
            return 1
        fi
        __val="$(cat "$__file")"
    else
        echo "ABORT: no Cloudflare token \"$__name\" is set up on this machine." >&2
        _fleet_cf_token_help "$__name"
        return 1
    fi

    __val="${__val%$'\n'}"; __val="${__val%$'\r'}"
    if [[ ! "$__val" =~ $__token_re ]]; then
        if [ -z "$__val" ]; then
            echo "ABORT: $__src gave an empty value, not a token." >&2
        else
            echo "ABORT: $__src gave ${#__val} characters that are not one API token (a space, a quote, a line break or another character no token has)." >&2
        fi
        return 1
    fi
    printf -v "$__var" '%s' "$__val"
    FLEET_CF_TOKEN_SOURCE="$__src"
    return 0
}
