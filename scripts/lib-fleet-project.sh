#!/bin/bash
# ==============================================================================
# Which Supabase project this checkout talks to, read from where it already is
# ==============================================================================
# Sourced by the scripts that need the project's address, its public key or its
# project ref. Not executable on its own. Nothing here is a secret, but all of
# it is yours, so none of it is written in the repository.
#
#   fleet_supabase_project_ref   the project ref (the first part of the address)
#       1. $FLEET_SUPABASE_PROJECT_REF
#       2. supabase/.temp/project-ref    (written by `supabase link`)
#       3. NEXT_PUBLIC_SUPABASE_URL in .env.local, when it is <ref>.supabase.co
#   fleet_supabase_url           the project's address
#       1. $FLEET_SUPABASE_URL
#       2. NEXT_PUBLIC_SUPABASE_URL in .env.local
#   fleet_supabase_anon_key      the public (publishable) key
#       1. $FLEET_SUPABASE_ANON_KEY
#       2. NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
#
# .env.local is the one named by $FLEET_ENV_FILE, else the one at the top of this
# checkout, else the main checkout's (a worktree has none of its own). It is read
# by name, a line at a time; it is never run as a program.
#
# Each function prints the value, or prints why not on stderr and returns 1.
# There is no built-in value to fall back to: the wrong project is worse than
# no project.
# ==============================================================================

FLEET_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Prints the .env.local this run reads; prints nothing if there is none.
fleet_env_file() {
    local main
    if [ -n "${FLEET_ENV_FILE:-}" ]; then printf '%s' "$FLEET_ENV_FILE"; return 0; fi
    if [ -r "$FLEET_PROJECT_ROOT/.env.local" ]; then printf '%s' "$FLEET_PROJECT_ROOT/.env.local"; return 0; fi
    main="$(git -C "$FLEET_PROJECT_ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
    if [ -n "$main" ] && [ -r "$main/.env.local" ]; then printf '%s' "$main/.env.local"; fi
    return 0
}

# fleet_env_value <NAME>: that line's value from .env.local, quotes taken off.
fleet_env_value() {
    local f
    f="$(fleet_env_file)"
    [ -n "$f" ] && [ -r "$f" ] || return 0
    grep -E "^$1=" "$f" | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | tr -d '\r\n'
}

_fleet_project_where() {
    local f
    f="$(fleet_env_file)"
    if [ -n "$f" ]; then printf '%s' "$f"; else printf '%s' "$FLEET_PROJECT_ROOT/.env.local (not found; name one with FLEET_ENV_FILE)"; fi
}

fleet_supabase_url() {
    local v="${FLEET_SUPABASE_URL:-}"
    [ -n "$v" ] || v="$(fleet_env_value NEXT_PUBLIC_SUPABASE_URL)"
    if ! printf '%s' "$v" | grep -qE '^https://[a-z0-9.-]+$'; then
        echo "ABORT: no Supabase address. Set FLEET_SUPABASE_URL, or NEXT_PUBLIC_SUPABASE_URL (an https address) in $(_fleet_project_where)." >&2
        return 1
    fi
    printf '%s' "$v"
}

fleet_supabase_anon_key() {
    local v="${FLEET_SUPABASE_ANON_KEY:-}"
    [ -n "$v" ] || v="$(fleet_env_value NEXT_PUBLIC_SUPABASE_ANON_KEY)"
    if ! printf '%s' "$v" | grep -qE '^[A-Za-z0-9._-]{20,}$'; then
        echo "ABORT: no Supabase public key. Set FLEET_SUPABASE_ANON_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY in $(_fleet_project_where)." >&2
        return 1
    fi
    printf '%s' "$v"
}

fleet_supabase_project_ref() {
    local v="${FLEET_SUPABASE_PROJECT_REF:-}" f="$FLEET_PROJECT_ROOT/supabase/.temp/project-ref"
    if [ -z "$v" ] && [ -r "$f" ]; then v="$(tr -d ' \t\r\n' < "$f")"; fi
    if [ -z "$v" ]; then
        v="$(fleet_env_value NEXT_PUBLIC_SUPABASE_URL | sed -n -E 's|^https://([a-z0-9]+)\.supabase\.co$|\1|p')"
    fi
    if ! printf '%s' "$v" | grep -qE '^[a-z0-9]{8,40}$'; then
        {
            echo "ABORT: no Supabase project ref. Looked at, in order:"
            echo "       \$FLEET_SUPABASE_PROJECT_REF, $f,"
            echo "       and NEXT_PUBLIC_SUPABASE_URL in $(_fleet_project_where)."
        } >&2
        return 1
    fi
    printf '%s' "$v"
}
