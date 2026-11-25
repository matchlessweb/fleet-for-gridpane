#!/bin/bash
# ==============================================================================
# Logins and keys reach curl on standard input, never as an argument
# ==============================================================================
#   bash scripts/test-curl-secrets.sh              the checks
#   bash scripts/test-curl-secrets.sh --controls   break a copy of the scripts on purpose, one
#                                                  way at a time, and check this test notices
#
# Any program on a machine can read another program's arguments while it runs,
# so a login handed to curl as `-H "Authorization: Bearer ..."` is readable for
# as long as the request takes. The scripts send those headers on curl's
# standard input instead (`-H @-`), built by the shell's own printf.
#
# NOTHING HERE REACHES SUPABASE OR A SERVER. The scripts are copied to a temp
# folder and run there with stand-ins first on the PATH: `curl` writes down its
# arguments and what it was told to read from standard input, then answers from
# a fixture; `ssh` writes down its arguments and answers "ok"; `security` gives
# a made-up login; an outside `printf` or `echo` writes down what it was handed.
# HOME is a temp folder and the settings file holds made-up keys.
#
# A. dump-schema.sh: the Supabase login (keychain, wrapped keychain, or
#    SUPABASE_ACCESS_TOKEN).
# B. provision-agent-tokens.sh: the service key, in the audit and in --apply.
# C. Controls for the stand-ins themselves.
# D. Every other shell script: no header on a curl command line holds a
#    variable, except the PUBLIC key telemetry-agent.sh sends; and no script
#    that hands curl a secret turns on tracing.
#
# apply-sql.sh and set-email-change-template.sh have the same checks in their
# own tests (test-apply-sql.sh, test-apply-sql-db.mjs,
# test-set-email-change-template.sh).
#
# FLEET_CURL_TREE points the checks at another copy of the repository (the
# controls use it).
# ==============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TREE="${FLEET_CURL_TREE:-$REPO}"
CONTROLS=0; QUIET=0
for a in "$@"; do
    case "$a" in
        --controls) CONTROLS=1 ;; --quiet) QUIET=1 ;;
        -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $a (only --controls)"; exit 2 ;;
    esac
done
command -v python3 >/dev/null || { echo "ABORT: python3 is needed"; exit 1; }

T=$(mktemp -d) || exit 1
T=$(cd "$T" && pwd -P)
trap 'rm -rf "${T:?}"' EXIT
export T

# ------------------------------------------------------------------------------
# --controls: break a copy one way at a time; each break must fail a check
# ------------------------------------------------------------------------------
if [ "$CONTROLS" = 1 ]; then
    n=0; caught=0
    try() { # label, file, perl expression
        local copy out rc; n=$((n+1)); copy="$T/broken-$n"
        mkdir -p "$copy/scripts"
        for f in "$TREE"/scripts/*; do case "$f" in *.local) ;; *) [ -f "$f" ] && cp "$f" "$copy/scripts/" ;; esac; done
        perl -0pi -e "$3" "$copy/scripts/$2"
        if cmp -s "$copy/scripts/$2" "$TREE/scripts/$2"; then echo "  MISSED  $1  (the break did not change $2: fix this control)"; rm -rf "$copy"; return; fi
        if ! /bin/bash -n "$copy/scripts/$2" 2>/dev/null; then echo "  MISSED  $1  (the broken copy is not a program: fix this control)"; rm -rf "$copy"; return; fi
        out=$(FLEET_CURL_TREE="$copy" bash "$0" --quiet 2>&1); rc=$?
        # A run that never reached its last line, or failed no check, is a crash, not a catch.
        if [ "$rc" != 0 ] && printf '%s\n' "$out" | tail -1 | grep -Eq '^curl secrets: [0-9]+ checks, [1-9][0-9]* failed$' && printf '%s\n' "$out" | grep -q '^  FAIL'; then
            caught=$((caught+1)); echo "  caught  $1  ($(printf '%s\n' "$out" | grep -c '^  FAIL') failing)"
        elif [ "$rc" = 0 ]; then echo "  MISSED  $1"
        else echo "  CRASHED $1  (the run did not finish: that is not a catch)"; printf '%s\n' "$out" | tail -3
        fi
        rm -rf "$copy"
    }
    echo "Breaking a copy of the scripts on purpose. Each line is one full run of this test."
    D=dump-schema.sh; P=provision-agent-tokens.sh
    try "the schema dump puts the login on curl's command line as well"  $D 's/-H \@- -H "Content-Type: application\/json" --data-binary \@"\$WORK/-H \@- -H "X-Also: \$(token)" -H "Content-Type: application\/json" --data-binary \@"\$WORK/'
    try "the schema dump sends the login as an argument again"           $D 's/  printf \x27Authorization: Bearer %s\\n\x27 "\$\(token\)" \| curl (.*) -H \@- /  curl $1 -H "Authorization: Bearer \$(token)" /'
    try "the schema dump sends the login under another header name"      $D 's/  printf \x27Authorization: Bearer %s\\n\x27/  printf \x27X-Login: %s\\n\x27/'
    try "the schema dump builds the header with a program outside bash"  $D 's/  printf \x27Authorization: Bearer %s\\n\x27/  env printf \x27Authorization: Bearer %s\\n\x27/'
    try "the schema dump no longer tells curl to read the header"        $D 's/ -H \@- -H "Content-Type/ -H "Content-Type/'
    try "the schema dump sends a wrapped keychain login still wrapped"   $D 's/go-keyring-base64:\*\) printf \x27%s\x27 "\$\{RAW#go-keyring-base64:\}" \| base64 -d ;;/go-keyring-base64:*) printf \x27%s\x27 "\$RAW" ;;/'
    try "the schema dump prints the login"                               $D 's/^CODE="\$\(ask /echo "debug: \$(token)"\nCODE="\$(ask /m'
    try "the schema dump turns tracing on"                               $D 's/^set -u$/set -ux/m'
    try "the audit puts the service key on curl's command line as well"  $P 's/^                -H \@-\)$/                -H \@- -H "apikey: \$SK")/m'
    try "the audit sends the service key as arguments again"             $P 's/REG=\$\(service_headers \| curl /REG=\$(curl /; s/^                -H \@-\)$/                -H "apikey: \$SK" -H "Authorization: Bearer \$SK")/m'
    try "the change puts the service key on curl's command line as well" $P 's/^        -H \@- \\$/        -H \@- -H "Authorization: Bearer \$SK" \\/m'
    try "the change no longer tells curl to read the headers"            $P 's/^        -H \@- \\\n//m'
    try "the apikey header is left out"                                  $P 's/printf \x27apikey: %s\\nAuthorization: Bearer %s\\n\x27 "\$SK" "\$SK"/printf \x27Authorization: Bearer %s\\n\x27 "\$SK"/'
    try "the Authorization header goes out under another name"           $P 's/printf \x27apikey: %s\\nAuthorization: Bearer %s\\n\x27/printf \x27apikey: %s\\nX-Auth: Bearer %s\\n\x27/'
    try "the service key goes out without the word Bearer"               $P 's/\\nAuthorization: Bearer %s\\n\x27 "\$SK" "\$SK"/\\nAuthorization: %s\\n\x27 "\$SK" "\$SK"/'
    try "the two headers are built by a program outside bash"            $P 's/^service_headers\(\) \{ printf /service_headers() { env printf /m'
    try "the service key is also handed to an outside echo"              $P 's/^service_headers\(\) \{ printf /service_headers() { env echo "\$SK" > \/dev\/null; printf /m'
    try "the change prints the service key"                              $P 's/echo "   hash registered \(fp \$\{HASH:0:8\}\)"/echo "   hash registered (fp \${HASH:0:8}) \$SK"/'
    try "the change runs curl with -v"                                   $P 's/curl -s -o \/tmp\/prov\.out/curl -sv -o \/tmp\/prov.out/'
    try "another script gains a curl with a key in a header"             waf-refresh.sh 's/\z/\nplanted() { curl -s -H "Authorization: Bearer \$CF_TOKEN" https:\/\/api.example.com\/; }\n/'
    try "another script gains a curl with --oauth2-bearer and a key"     waf-refresh.sh 's/\z/\nplanted() { curl -s --oauth2-bearer "\$CF_TOKEN" https:\/\/api.example.com\/; }\n/'
    try "the server agent sends another value in its apikey header"      telemetry-agent.sh 's/-H "apikey: \$SUPABASE_KEY"/-H "apikey: \$AGENT_TOKEN"/'
    try "the server agent's key is no longer the public one"             telemetry-agent.sh 's/SUPABASE_KEY="__FLEET_SUPABASE_ANON_KEY__"/SUPABASE_KEY="__FLEET_SERVICE_ROLE_KEY__"/'
    echo
    echo "$n broken copies: $caught caught, $((n-caught)) missed"
    [ "$caught" = "$n" ]; exit $?
fi

fail=0; ran=0; PART=""
ok()   { ran=$((ran+1)); [ "$QUIET" = 1 ] || echo "  ok   $PART  $1"; }
bad()  { ran=$((ran+1)); fail=$((fail+1)); echo "  FAIL $PART  $1${2:+  ($2)}"; }
yes()  { if [ "$2" = 1 ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }       # label, 1|0, detail
same() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got \"$2\", wanted \"$3\""; fi; }
say()  { [ "$QUIET" = 1 ] || echo "$@"; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

# ------------------------------------------------------------------------------
# The stand-ins and the fixtures
# ------------------------------------------------------------------------------
mkdir -p "$T/bin" "$T/home" "$T/tmp" "$T/fx" "$T/out" "$T/cap"
cat > "$T/bin/curl" <<'STANDIN_CURL'
#!/bin/bash
# Stand-in for curl: writes down its arguments, and what it reads from standard
# input when told to (-H @-). Answers from a fixture and reaches nothing.
{ echo "== call"; printf '%s\n' "$@"; } >> "$CAP/curl.args"
out=""; code=0; body=""; url=""; reads=0; prev=""
for a in "$@"; do
    case "$prev" in
        -o) out="$a" ;;
        -w) code=1 ;;
        -H) [ "$a" = "@-" ] && reads=1 ;;
        --data-binary) body="${a#@}" ;;
    esac
    case "$a" in http://*|https://*) url="$a" ;; esac
    prev="$a"
done
echo "== call" >> "$CAP/curl.stdin"
[ "$reads" = 1 ] && cat >> "$CAP/curl.stdin"
reply=""; http=404
case "$url" in
    */database/query) http=200; if grep -q 'cron\.job' "$body" 2>/dev/null; then reply='[{"jobs": []}]'; else reply="$(cat "$FX/schema-reply.json")"; fi ;;
    */rest/v1/server_agent_secrets\?*) http=200; reply='[]' ;;
    */rest/v1/server_agent_secrets) http=201 ;;
esac
if [ -n "$out" ]; then printf '%s' "$reply" > "$out"; else printf '%s' "$reply"; fi
[ "$code" = 1 ] && printf '%s' "$http"
exit 0
STANDIN_CURL
cat > "$T/bin/ssh" <<'STANDIN_SSH'
#!/bin/bash
# Stand-in for ssh: writes down what it was given and reaches nothing.
{ echo "== call"; printf '%s\n' "$@"; } >> "$CAP/ssh.args"
cat > /dev/null
printf '%s\n' "token=NOT SET" "token_len=64" "run: Telemetry synced successfully" "run: Hardware synced" "run: Firewall state synced" "run: Fail2Ban report synced" "run: WAF report synced" "run: OPcache report synced"
STANDIN_SSH
cat > "$T/bin/security" <<'STANDIN_SECURITY'
#!/bin/bash
[ -r "$FAKE_KEYCHAIN" ] && cat "$FAKE_KEYCHAIN" || exit 44
STANDIN_SECURITY
# An outside printf or echo writes down what it was handed, then does its job.
for tool in printf echo; do
    # The program itself, by its full path: `command -v` would name bash's own, and the stand-in would then run itself.
    real=""; for d in /usr/bin /bin; do if [ -x "$d/$tool" ]; then real="$d/$tool"; break; fi; done
    [ -n "$real" ] || { echo "ABORT: no $tool program in /usr/bin or /bin"; exit 1; }
    printf '#!/bin/bash\n{ echo "== %s"; /usr/bin/printf "%%s\\n" "$@"; } >> "$CAP/argv.log"\nexec %s "$@"\n' "$tool" "$real" > "$T/bin/$tool"
done
for c in scp rsync sftp sleep; do printf '#!/bin/bash\nexit 0\n' > "$T/bin/$c"; done
printf '#!/bin/bash\nexit 1\n' > "$T/bin/ssh-add"
chmod +x "$T/bin"/*

LOGIN="made-up-login-0000000000000000"                 # a Supabase login, made up
SKEY="stand-in-service-key-00000000000"                # a service key, made up
PKEY="stand-in-public-key-000000000000"
printf '%s' "$LOGIN" > "$T/fx/keychain"
printf 'go-keyring-base64:%s' "$(printf '%s' "$LOGIN" | base64)" > "$T/fx/keychain-wrapped"
WRAPPED="$(printf '%s' "$LOGIN" | base64)"
printf 'NEXT_PUBLIC_SUPABASE_URL=https://db.example.com\nNEXT_PUBLIC_SUPABASE_ANON_KEY=%s\nSUPABASE_SERVICE_ROLE_KEY=%s\n' "$PKEY" "$SKEY" > "$T/fx/env"
printf '203.0.113.21|101|web1\n203.0.113.22|102|web2\n' > "$T/fx/servers"
printf '%s\n' '[{"dump": {"tables": [], "functions": [], "outside_triggers": [], "views": [], "enums": [], "extensions": [], "publications": [], "server_version": "17.0"}}]' > "$T/fx/schema-reply.json"
RUNPATH="$T/bin:$(dirname "$(command -v python3)"):/usr/bin:/bin:/usr/sbin:/sbin"

# The scripts under test, copied so nothing they write lands in the repository.
# A server list kept beside them (*.local) is left behind.
NEW="$T/new"; mkdir -p "$NEW/scripts"
for f in "$TREE"/scripts/*; do case "$f" in *.local) ;; *) [ -f "$f" ] && cp "$f" "$NEW/scripts/" ;; esac; done
# provision-agent-tokens.sh keeps Supabase's reply in a fixed file, /tmp/prov.out. In this copy it is moved into the temp folder.
perl -pi -e 's{/tmp/prov\.out}{$ENV{T}/tmp/prov.out}g' "$NEW/scripts/provision-agent-tokens.sh"

NAMES=("FLEET_PREFIX=acme" "FLEET_JAIL_PREFIX=zq" "FLEET_NAME=Acme Ops" "FLEET_REPO_URL=https://example.com/fleet" "FLEET_SUPABASE_URL=https://db.example.com" "FLEET_SUPABASE_ANON_KEY=$PKEY")
MORE_ENV=("FLEET_CURL_TEST=1")                    # one more setting for the next run
# run <case> <script> [args]: run one script with the stand-ins, keep what it sent and said.
run() {
    local cap="$T/cap/$1" script="$2"; shift 2
    rm -rf "$cap"; mkdir -p "$cap"; : > "$cap/curl.args"; : > "$cap/curl.stdin"; : > "$cap/argv.log"; : > "$cap/ssh.args"
    ( cd "$NEW" && env -i PATH="$RUNPATH" HOME="$T/home" TMPDIR="$T/tmp" CAP="$cap" FX="$T/fx" FAKE_KEYCHAIN="$T/fx/keychain" \
        FLEET_SERVERS_FILE="$T/fx/servers" FLEET_ENV_FILE="$T/fx/env" FLEET_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst \
        FLEET_SUPABASE_API=https://api.example.com "${NAMES[@]}" "${MORE_ENV[@]}" /bin/bash "scripts/$script" "$@" </dev/null >"$cap/stdout" 2>&1 )
    echo $? > "$cap/rc"
}
rc_of()      { cat "$T/cap/$1/rc"; }
ncalls()     { grep -c '^== call$' "$T/cap/$1/curl.args"; }
nargs()      { grep -vc '^== call$' "$T/cap/$1/curl.args"; }
from_stdin() { awk 'BEGIN { n = 0 } /^== call$/ { h = 0; next } h { if ($0 == "@-") n++; h = 0; next } $0 == "-H" { h = 1 } END { print n }' "$T/cap/$1/curl.args"; }
count_in()   { grep -cF -- "$2" "$T/cap/$1/$3"; }                           # case, text, file
has_arg()    { grep -cxF -- "$2" "$T/cap/$1/curl.args"; }                    # case, one whole argument
# read_as <case> <calls> <line>...: what curl read on standard input must be exactly these lines, once per call.
read_as() {
    local c="$1" k="$2" i; shift 2
    : > "$T/want.txt"; i=0
    while [ "$i" -lt "$k" ]; do { echo "== call"; printf '%s\n' "$@"; } >> "$T/want.txt"; i=$((i+1)); done
    cmp -s "$T/want.txt" "$T/cap/$c/curl.stdin" && echo 1 || echo 0
}
# secret_checks <case> <what it is> <the secret> <calls> <header line>...
secret_checks() {
    local c="$1" what="$2" s="$3" k="$4"; shift 4
    same "$c: curl was run $k times, and each time told to read a header from standard input" "$(ncalls "$c")/$(from_stdin "$c")" "$k/$k"
    same "$c: $what is in none of curl's arguments ($(nargs "$c") looked at)" "$(count_in "$c" "$s" curl.args)" "0"
    yes  "$c: what curl read on standard input is exactly the header, each time" "$(read_as "$c" "$k" "$@")" "$(sed "s/$s/<the secret>/g" "$T/cap/$c/curl.stdin" | tr '\n' '~' | cut -c1-160)"
    same "$c: $what is not printed" "$(count_in "$c" "$s" stdout)" "0"
    same "$c: no outside printf or echo was handed $what" "$(count_in "$c" "$s" argv.log)" "0"
    same "$c: $what is in none of ssh's arguments" "$(count_in "$c" "$s" ssh.args)" "0"
}

# ==============================================================================
# A. dump-schema.sh
# ==============================================================================
PART=A; say "A. dump-schema.sh: the Supabase login"
run dump dump-schema.sh "$T/out/schema.json"
same "the dump ends ok and writes its file for you alone" "$(tail -1 "$T/cap/dump/stdout")/$(rc_of dump)/$(mode_of "$T/out/schema.json")" "schema_dump=ok/0/600"
secret_checks dump "the login" "$LOGIN" 2 "Authorization: Bearer $LOGIN"
same "dump: both requests went to the project's query address, as a POST" "$(has_arg dump "https://api.example.com/v1/projects/abcdefghijklmnopqrst/database/query")/$(has_arg dump POST)" "2/2"
MORE_ENV=("FAKE_KEYCHAIN=$T/fx/keychain-wrapped")
run dump-wrapped dump-schema.sh "$T/out/schema-wrapped.json"
same "a wrapped keychain login: the dump ends ok" "$(tail -1 "$T/cap/dump-wrapped/stdout")/$(rc_of dump-wrapped)" "schema_dump=ok/0"
secret_checks dump-wrapped "the login" "$LOGIN" 2 "Authorization: Bearer $LOGIN"
same "dump-wrapped: the wrapped form is in none of curl's arguments, and is not what curl read" "$(count_in dump-wrapped "$WRAPPED" curl.args)/$(count_in dump-wrapped "$WRAPPED" curl.stdin)" "0/0"
ENVLOGIN="made-up-login-from-the-setting-1"
MORE_ENV=("SUPABASE_ACCESS_TOKEN=$ENVLOGIN" "FAKE_KEYCHAIN=$T/fx/none")
run dump-env dump-schema.sh "$T/out/schema-env.json"
same "a login from SUPABASE_ACCESS_TOKEN: the dump ends ok" "$(tail -1 "$T/cap/dump-env/stdout")/$(rc_of dump-env)" "schema_dump=ok/0"
secret_checks dump-env "the login" "$ENVLOGIN" 2 "Authorization: Bearer $ENVLOGIN"
MORE_ENV=("FLEET_CURL_TEST=1")

# ==============================================================================
# B. provision-agent-tokens.sh
# ==============================================================================
PART=B; say "B. provision-agent-tokens.sh: the service key"
run audit provision-agent-tokens.sh
same "the audit ends 0 and finds neither server registered" "$(rc_of audit)/$(grep -c 'registered=NO' "$T/cap/audit/stdout")" "0/2"
secret_checks audit "the service key" "$SKEY" 2 "apikey: $SKEY" "Authorization: Bearer $SKEY"
same "audit: it asked about each server by its number" "$(grep -c 'server_agent_secrets?select=.*server_id=eq\.101$' "$T/cap/audit/curl.args")/$(grep -c 'server_agent_secrets?select=.*server_id=eq\.102$' "$T/cap/audit/curl.args")" "1/1"
run apply provision-agent-tokens.sh --apply web1
same "--apply web1 ends 0, registers the hash and reports the token active" "$(rc_of apply)/$(grep -c 'hash registered' "$T/cap/apply/stdout")/$(grep -c 'token active' "$T/cap/apply/stdout")" "0/1/1"
secret_checks apply "the service key" "$SKEY" 1 "apikey: $SKEY" "Authorization: Bearer $SKEY"
same "apply: the request is a POST to the table, with its other two headers still arguments" "$(has_arg apply POST)/$(has_arg apply "https://db.example.com/rest/v1/server_agent_secrets")/$(has_arg apply "Content-Type: application/json")/$(has_arg apply "Prefer: resolution=merge-duplicates,return=minimal")" "1/1/1/1"
same "apply: one server was contacted, and the reply file in the temp folder is gone" "$(grep -c '^== call$' "$T/cap/apply/ssh.args")/$(ls "$T/tmp/prov.out" 2>/dev/null | wc -l | tr -d ' ')" "1/0"

# ==============================================================================
# C. The stand-ins themselves
# ==============================================================================
PART=C; say "C. controls for the stand-ins"
mkdir -p "$T/cap/planted"; : > "$T/cap/planted/curl.args"; : > "$T/cap/planted/curl.stdin"; : > "$T/cap/planted/argv.log"
printf 'X-Other: 1\n' | CAP="$T/cap/planted" FX="$T/fx" "$T/bin/curl" -s -H "Authorization: Bearer $LOGIN" https://api.example.com/ > /dev/null
same "control: the stand-in curl keeps a login put among its arguments, and reads nothing it was not told to" "$(count_in planted "$LOGIN" curl.args)/$(grep -vc '^== call$' "$T/cap/planted/curl.stdin")" "1/0"
CAP="$T/cap/planted" "$T/bin/printf" '%s' "$LOGIN" > /dev/null; CAP="$T/cap/planted" "$T/bin/echo" "$LOGIN" > /dev/null
same "control: the stand-in printf and echo keep a login handed to them" "$(count_in planted "$LOGIN" argv.log)" "2"
yes "control: a header under another name is not taken for the right one" "$([ "$(read_as dump 2 "X-Login: $LOGIN")" = 0 ] && echo 1 || echo 0)"

# ==============================================================================
# D. Every other shell script
# ==============================================================================
PART=D; say "D. no other curl command line holds a secret"
# Lines in <dir>'s shell scripts (not the tests) where a curl option that carries a credential holds a variable.
secret_options() {
    local f b
    for f in "$1"/*.sh; do
        b="$(basename "$f")"
        case "$b" in test-*|*-selftest.sh) continue ;; esac
        grep -nE -- "(-H|--header)[ =]*[\"'][^\"']*\\\$|--oauth2-bearer[ =]+[\"']?[^ ]*\\\$|curl .*(--user|-u)[ =]+[\"']?[^ ]*\\\$" "$f" | grep -vE '^[0-9]+:[[:space:]]*#' | sed "s|^|$b:|"
    done
}
# not_tests <file>...: the files that are scripts, not tests of them.
not_tests() { local f; for f in "$@"; do case "$(basename "$f")" in test-*|*-selftest.sh) ;; *) echo "$f" ;; esac; done; }
NSH=$(not_tests "$NEW"/scripts/*.sh | grep -c .)
secret_options "$NEW/scripts" > "$T/options.txt"
same "outside telemetry-agent.sh, no curl option holds a variable ($NSH shell scripts read)" "$(grep -vc '^telemetry-agent\.sh:' "$T/options.txt")" "0"
AG=$(grep -c '^telemetry-agent\.sh:' "$T/options.txt")
same "telemetry-agent.sh sends one value that way, \$SUPABASE_KEY, and nothing else ($AG lines read)" "$([ "$AG" -gt 0 ] && echo some)/$(grep '^telemetry-agent\.sh:' "$T/options.txt" | grep -vcE '"(apikey: |Authorization: Bearer )\$SUPABASE_KEY"')" "some/0"
same "and that value is the PUBLIC key, filled in when the agent is installed" "$(grep -c '^SUPABASE_KEY="__FLEET_SUPABASE_ANON_KEY__"' "$NEW/scripts/telemetry-agent.sh")/$(grep -cE '^SUPABASE_KEY=' "$NEW/scripts/telemetry-agent.sh")" "1/1"
# The scripts that hand curl a secret on standard input must not echo their own commands.
HANDS=$(not_tests $(grep -lE -- '-H @-|-K -' "$NEW"/scripts/*.sh))
NHANDS=$(printf '%s\n' "$HANDS" | grep -c .)
TRACE=$(for f in $HANDS; do grep -nE '(^|[;&|[:space:]])set +-[A-Za-z]*x|bash +-[A-Za-z]*x|curl( +[^ |;]+)* +(-[A-Za-z]*v[A-Za-z]*|--verbose|--trace[a-z-]*)( |$)' "$f" | grep -vE '^[0-9]+:[[:space:]]*#' | sed "s|^|$(basename "$f"):|"; done)
same "no script that hands curl a secret turns on tracing or curl -v ($NHANDS scripts read)" "$([ "$NHANDS" -ge 6 ] && echo enough)/$(printf '%s' "$TRACE" | grep -c .)" "enough/0"
mkdir -p "$T/planted"; cp "$NEW/scripts/apply-sql.sh" "$T/planted/"; printf '\ncurl -s -H "Authorization: Bearer $(token)" https://api.example.com/\n' >> "$T/planted/apply-sql.sh"
same "control: a login planted on a curl command line is found" "$(secret_options "$T/planted" | grep -c .)" "1"

echo "curl secrets: $ran checks, $fail failed"
[ "$fail" = 0 ]
