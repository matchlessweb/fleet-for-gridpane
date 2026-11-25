#!/usr/bin/env bash
# Checks for scripts/apply-sql.sh, with a stand-in keychain and a stand-in curl:
# nothing here reaches a database or reads a real login.   npm run sql:test
#   --controls   break a copy of the script one way at a time; each break must be caught
# APPLY_SQL points the checks at another copy of the script (the controls use it).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${APPLY_SQL:-$HERE/apply-sql.sh}"

if [ "${1:-}" = "--controls" ]; then
    WORK="$(mktemp -d)"; trap 'rm -rf "${WORK:?}"' EXIT
    cp "$HERE/lib-fleet-project.sh" "$WORK/"
    caught=0; total=0
    control() {  # name, perl edit
        total=$((total + 1))
        perl -0pe "$2" "$HERE/apply-sql.sh" > "$WORK/apply-sql.sh"
        if cmp -s "$HERE/apply-sql.sh" "$WORK/apply-sql.sh"; then echo "  MISSED  $1  (the break changed nothing: fix this control)"; return; fi
        # Caught means a check failed. A copy that only crashes the run is not a catch.
        if APPLY_SQL="$WORK/apply-sql.sh" bash "$0" > "$WORK/out" 2>&1; then echo "  MISSED  $1"
        elif grep -q '^  FAIL' "$WORK/out" && tail -1 "$WORK/out" | grep -q '^apply-sql: [0-9]* checks, [0-9]* failed$'; then caught=$((caught + 1)); echo "  caught  $1  ($(grep -c '^  FAIL' "$WORK/out") failing)"
        else echo "  MISSED  $1  (the run stopped without a failing check)"; fi
    }
    control "a real run is no longer one transaction" 's/\\ncommit;/\\n/'
    control "the login setting is ignored" 's/RAW="\$\{SUPABASE_ACCESS_TOKEN:-\$\(security/RAW="\$\{NO_SUCH_SETTING:-\$(security/'
    control "a dry run commits" 's/"\\nrollback;" if/"\\ncommit;" if/'
    control "a file with its own COMMIT is let through" 's/sys\.exit\(3\)/pass/'
    control "the check for a transaction inside the file misses COMMIT" 's/\|commit\|rollback\)/|rollback)/'
    control "the login goes back on curl's command line" 's/CODE=\$\(printf .Authorization: Bearer %s\\n. "\$\(token\)" \| curl /CODE=\$(curl /; s/    -H \@- \\\n/    -H "Authorization: Bearer \$(token)" \\\n/'
    control "the login is on standard input and on the command line as well" 's/    -H \@- \\\n/    -H \@- -H "X-Also: \$(token)" \\\n/'
    control "the login is sent under another header name" 's/printf .Authorization: Bearer %s\\n. "\$\(token\)"/printf "X-Login: %s\\n" "\$(token)"/'
    control "curl is not told to read the header" 's/    -H \@- \\\n//'
    control "the login is handed to an outside printf on the way" 's/CODE=\$\(printf .Authorization/CODE=\$(env printf \x27Authorization/; s/(env printf .Authorization: Bearer %s\\n). /$1\x27 /'
    echo "$total broken copies: $caught caught, $((total - caught)) missed"
    [ "$caught" = "$total" ]; exit $?
fi

WORK="$(mktemp -d)"; trap 'rm -rf "${WORK:?}"' EXIT
mkdir "$WORK/bin"
# The stand-ins: a keychain that hands back a made-up login, and a curl that keeps what it was asked to send:
# its arguments in one file, and what it was told to read from standard input (-H @-) in another.
printf '#!/bin/sh\n[ -n "$NO_KEYCHAIN" ] && exit 44\necho "go-keyring-base64:%s"\n' "$(printf 'made-up-login' | base64)" > "$WORK/bin/security"
cat > "$WORK/bin/curl" <<'SH'
#!/bin/sh
echo "$*" >> "$CURL_LOG"
while [ $# -gt 0 ]; do
  case "$1" in --data-binary) cp "${2#@}" "$CURL_BODY";; -o) : > "$2";; -H) [ "$2" = "@-" ] && cat > "$CURL_STDIN";; esac
  shift
done
printf '%s' "${CURL_CODE:-201}"
SH
# A printf and an echo that are programs, not part of bash: anything handed to one of these is an argument
# other programs on the machine can read. They write down what they were given, then do the real thing.
printf '#!/bin/sh\nprintf "%%s\\n" "printf $*" >> "$ARGV_LOG"\nexec /usr/bin/printf "$@"\n' > "$WORK/bin/printf"
printf '#!/bin/sh\nprintf "%%s\\n" "echo $*" >> "$ARGV_LOG"\nexec /bin/echo "$@"\n' > "$WORK/bin/echo"
chmod +x "$WORK/bin/security" "$WORK/bin/curl" "$WORK/bin/printf" "$WORK/bin/echo"
export CURL_LOG="$WORK/curl.log" CURL_BODY="$WORK/body.json" CURL_STDIN="$WORK/curl.stdin" ARGV_LOG="$WORK/argv.log"
ran=0; failed=0
check() { ran=$((ran + 1)); if [ "$2" = "$3" ]; then echo "  ok   $1"; else failed=$((failed + 1)); echo "  FAIL $1"; echo "       got  $2"; echo "       want $3"; fi; }
run() { : > "$CURL_LOG"; : > "$CURL_STDIN"; : > "$ARGV_LOG"; rm -f "$CURL_BODY"; PATH="$WORK/bin:$PATH" FLEET_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst bash "$SCRIPT" "$@" > "$WORK/out" 2>&1; echo $?; }
sent() {  # the first and last line of what was sent
    [ -s "$CURL_BODY" ] || { echo "nothing sent"; return; }
    python3 - "$CURL_BODY" <<'PY'
import json, sys
q = json.load(open(sys.argv[1]))["query"].rstrip().split("\n")
print(q[0] + " … " + q[-1])
PY
}
times_sent() {  # how many times a text appears in what was sent
    python3 - "$CURL_BODY" "$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["query"].count(sys.argv[2]))
PY
}

printf 'create table public.t (id int);\ndo $do$\nbegin\n  perform 1;\nend $do$;\n' > "$WORK/plain.sql"
printf 'begin;\ncreate table public.t (id int);\ncommit;\n' > "$WORK/own.sql"
printf 'create table public.t (id int);\n  COMMIT ;\n' > "$WORK/own2.sql"

rc=$(run "$WORK/plain.sql" --dry-run)
check "a dry run is sent as one transaction that is rolled back" "$rc $(sent)" "0 begin; … rollback;"
check "and says nothing changed" "$(grep -c 'Nothing changed' "$WORK/out")" "1"
check "the login is in none of curl's arguments (one call looked at)" "$(wc -l < "$CURL_LOG" | tr -d ' ') $(grep -c 'made-up-login' "$CURL_LOG")" "1 0"
check "it reaches curl on standard input, as the Authorization header and nothing else" "$(cat "$CURL_STDIN")" "Authorization: Bearer made-up-login"
check "curl is told to read a header from standard input (-H @-)" "$(grep -c -- ' -H @- ' "$CURL_LOG")" "1"
check "the login is handed to no outside printf or echo on the way" "$(grep -c 'made-up-login' "$ARGV_LOG")" "0"
check "nor is the keychain's wrapped form of it" "$(grep -c "$(printf 'made-up-login' | base64)" "$CURL_LOG" "$ARGV_LOG" | cut -d: -f2 | tr '\n' ' ')" "0 0 "
rc=$(run "$WORK/plain.sql")
check "a real run is sent as one transaction that is committed: all of it, or none" "$rc $(sent)" "0 begin; … commit;"
check "a block of procedure code, where begin has no semicolon, is not mistaken for a transaction" "$(times_sent 'perform 1')" "1"
rc=$(run "$WORK/own.sql" --dry-run)
check "a file with its own BEGIN and COMMIT is refused on a dry run, and nothing is sent" "$rc $(sent) $(wc -l < "$CURL_LOG" | tr -d ' ')" "2 nothing sent 0"
check "and the refusal names the line" "$(grep -c 'line 1: begin;' "$WORK/out")" "1"
rc=$(run "$WORK/own.sql")
check "the same file is refused on a real run" "$rc $(sent)" "2 nothing sent"
rc=$(run "$WORK/own2.sql" --dry-run)
check "a COMMIT in capitals, indented, with a space before the semicolon is seen too" "$rc $(sent)" "2 nothing sent"
export CURL_CODE=400
rc=$(run "$WORK/plain.sql")
check "when the database refuses the file, the script says nothing was applied and fails" "$rc $(grep -c 'Nothing was applied' "$WORK/out")" "1 1"
unset CURL_CODE
check "the login is never printed" "$(grep -c 'made-up-login' "$WORK/out")" "0"
rc=$(run "$WORK/plain.sql")
check "a real run sends the login the same way: on standard input, in no argument" "$rc $(cat "$CURL_STDIN") $(grep -c 'made-up-login' "$CURL_LOG" "$ARGV_LOG" | cut -d: -f2 | tr '\n' ' ')" "0 Authorization: Bearer made-up-login 0 0 "
rc=$(NO_KEYCHAIN=1 SUPABASE_ACCESS_TOKEN=made-up-token-from-a-setting run "$WORK/plain.sql" --dry-run)
check "with no keychain, the login in SUPABASE_ACCESS_TOKEN is the one sent, on standard input" "$rc $(cat "$CURL_STDIN") $(grep -c 'made-up-token-from-a-setting' "$WORK/out")" "0 Authorization: Bearer made-up-token-from-a-setting 0"
check "and it is in none of curl's arguments and no outside program's either" "$(grep -c 'made-up-token-from-a-setting' "$CURL_LOG" "$ARGV_LOG" | cut -d: -f2 | tr '\n' ' ')" "0 0 "
: > "$CURL_LOG"; PATH="$WORK/bin:$PATH" curl -s -o "$WORK/control.out" -H "Authorization: Bearer made-up-login" https://db.example.com/ > /dev/null
check "control: the stand-in curl does write down a login put among its arguments" "$(grep -c 'made-up-login' "$CURL_LOG")" "1"
: > "$ARGV_LOG"; PATH="$WORK/bin:$PATH" env printf 'Authorization: Bearer %s\n' made-up-login > /dev/null
check "control: a login handed to an outside printf is written down" "$(grep -c 'made-up-login' "$ARGV_LOG")" "1"
rc=$(NO_KEYCHAIN=1 run "$WORK/plain.sql" --dry-run)
check "with no keychain and no setting it stops, says both ways in, and sends nothing" "$rc $(grep -c 'SUPABASE_ACCESS_TOKEN' "$WORK/out") $(wc -l < "$CURL_LOG" | tr -d ' ')" "1 1 0"

echo "apply-sql: $ran checks, $failed failed"
[ "$failed" = 0 ]
