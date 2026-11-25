#!/usr/bin/env bash
# Proves the settings file (.env.local) is only ever read as text, never run as a
# program: a value holding `$( )`, backticks, `;` or `|` must come back as it is
# written, and nothing in it may execute. Touches no real settings file, server
# or service: everything is made up in a temporary folder.
#
#   bash scripts/test-env-file.sh              # the checks
#   bash scripts/test-env-file.sh --controls   # broken copies; each must fail a check
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK:?}"' EXIT

suite() {  # <scripts folder to test>; prints "ran failed" on the last line
    local S="$1" quiet="${2:-}" ran=0 failed=0 T; T="$(mktemp -d "$WORK/run.XXXXXX")"
    check() { ran=$((ran + 1)); if [ "$2" = "$3" ]; then [ -n "$quiet" ] || echo "  ok   $1"; else failed=$((failed + 1)); [ -n "$quiet" ] || { echo "  FAIL $1"; echo "       got  $2"; echo "       want $3"; }; fi; }
    mkdir -p "$T/bin" "$T/home"
    # Stand-ins: nothing here may reach a network or a server. Each records that it was called.
    for tool in ssh ssh-add curl scp; do printf '#!/bin/sh\necho "%s $*" >> "%s/calls"\nexit 1\n' "$tool" "$T" > "$T/bin/$tool"; chmod +x "$T/bin/$tool"; done
    : > "$T/calls"
    # A settings file whose values would do something if it were run.
    cat > "$T/env" <<ENVEOF
NEXT_PUBLIC_SUPABASE_URL=https://db.example.com
SUPABASE_SERVICE_ROLE_KEY="made-up-key-\$(touch $T/ran-substitution)-end"
GRIDPANE_API_TOKEN=made-up; touch $T/ran-semicolon
EXTRA_ONE=\`touch $T/ran-backtick\`
EXTRA_TWO=one | touch $T/ran-pipe
touch $T/ran-bare-line
ENVEOF
    local got
    got="$(FLEET_ENV_FILE="$T/env" bash -c ". '$S/lib-fleet-project.sh'; fleet_env_value SUPABASE_SERVICE_ROLE_KEY" 2>&1)"
    check "the reader hands a value back as it is written, quotes off" "$got" "made-up-key-\$(touch $T/ran-substitution)-end"
    got="$(FLEET_ENV_FILE="$T/env" bash -c ". '$S/lib-fleet-project.sh'; fleet_env_value GRIDPANE_API_TOKEN" 2>&1)"
    check "a value with a semicolon comes back whole" "$got" "made-up; touch $T/ran-semicolon"
    check "reading ran nothing that was in the file" "$(ls "$T" | grep -c '^ran-')" "0"
    # The script that used to run the file: it must stop at the missing server list, having run nothing.
    PATH="$T/bin:$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" FLEET_ENV_FILE="$T/env" FLEET_SERVERS_FILE="$T/no-such-list" \
        bash "$S/provision-agent-tokens.sh" > "$T/out" 2>&1
    check "provision-agent-tokens.sh, given that file, runs nothing that is in it" "$(ls "$T" | grep -c '^ran-')" "0"
    check "and it reached no server and no service on the way" "$(wc -l < "$T/calls" | tr -d ' ')" "0"
    check "and it printed no value from the file" "$(grep -c 'made-up' "$T/out")" "0"
    # No script may run a settings file. Looked for in every shell script but the tests, which hold such lines as samples.
    local n hits
    n="$(ls "$S"/*.sh | grep -vc '/test-[^/]*$')"
    hits="$(grep -lE '(^|[;&|][[:space:]]*)(\.|source)[[:space:]]+("?\$\{?[A-Za-z_]*ENV[A-Za-z_]*\}?"?|[^[:space:]]*\.env[^[:space:]]*|[^[:space:]]*fleet_env_file[^[:space:]]*)' "$S"/*.sh 2>/dev/null | xargs -n1 basename 2>/dev/null | grep -v '^test-' | tr '\n' ' ')"
    check "none of the $n shell scripts (tests aside) runs a settings file" "${hits:-none}" "none"
    printf 'set -a; . "$ENV_FILE"; set +a\n' > "$T/planted.sh"
    check "control: the search sees a planted line that runs one" "$(grep -cE '(^|[;&|][[:space:]]*)(\.|source)[[:space:]]+("?\$\{?[A-Za-z_]*ENV[A-Za-z_]*\}?"?|[^[:space:]]*\.env[^[:space:]]*|[^[:space:]]*fleet_env_file[^[:space:]]*)' "$T/planted.sh")" "1"
    [ "$n" -gt 20 ] || { failed=$((failed + 1)); [ -n "$quiet" ] || echo "  FAIL only $n shell scripts were looked at"; }
    echo "$ran $failed"
}

if [ "${1:-}" != "--controls" ]; then
    out="$(suite "$HERE")"; printf '%s\n' "$out" | sed '$d'
    set -- $(printf '%s\n' "$out" | tail -1)
    echo "settings file: $1 checks, $2 failed"
    [ "$2" = 0 ]; exit $?
fi

caught=0; total=0
control() {  # name, file, perl edit
    total=$((total + 1)); local C="$WORK/copy-$total/scripts"; mkdir -p "$C"; cp "$HERE"/*.sh "$C"/
    perl -0pi -e "$3" "$C/$2"
    if cmp -s "$HERE/$2" "$C/$2"; then echo "  MISSED  $1  (the break changed nothing: fix this control)"; return; fi
    set -- "$1" $(suite "$C" quiet | tail -1)
    if [ "${3:-0}" != 0 ]; then caught=$((caught + 1)); echo "  caught  $1  ($3 failing)"; else echo "  MISSED  $1"; fi
}
control "the token script runs the settings file again" provision-agent-tokens.sh 's/NEXT_PUBLIC_SUPABASE_URL="\$\(fleet_env_value NEXT_PUBLIC_SUPABASE_URL\)"/set -a; . "\$(fleet_env_file)"; set +a/'
control "the reader evaluates what it reads" lib-fleet-project.sh 's/(grep -E "\^\$1=" "\$f" \| head -1 \| cut -d= -f2- \| sed [^\n]*)/eval "echo \\"\$($1)\\""/'
control "another script sources a settings file" fleet-fail2ban.sh 's/\z/\n. "\$ROOT\/.env.local"\n/'
echo "$total broken copies: $caught caught, $((total - caught)) missed"
[ "$caught" = "$total" ]
