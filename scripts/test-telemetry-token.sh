#!/bin/bash
# The agent's token must never be an argument of a command: on the server, any
# user can read another process's arguments while it runs. This runs the three
# short reports of telemetry-agent.sh against a fake curl that records what it
# was given, and checks the rule for the whole file. Contacts nothing.
#   bash scripts/test-telemetry-token.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$HERE/telemetry-agent.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "pass  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }

mkdir -p "$T/bin"
cat > "$T/bin/curl" <<'FAKE'
#!/bin/bash
printf '%s\n' "$@" > "$CURL_ARGS"
cat > "$CURL_STDIN"
printf '204'
FAKE
chmod +x "$T/bin/curl"

TOKEN="tok_selftest_3f9a1c7e5b2d"
PAYLOAD='{ "p_token": "'"$TOKEN"'", "p_server_id": 7, "note": "two  spaces, a \"quote\" and a\nnewline escape" }'

# $1 = name, $2 = first line (fixed text), $3 = last line (fixed text), $4 = how to call it
run_block() {
    awk -v a="$2" -v b="$3" 'index($0,a){on=1} on{print} on&&index($0,b){exit}' "$AGENT" > "$T/block.sh"
    if [ ! -s "$T/block.sh" ] || ! grep -qF -- "$3" "$T/block.sh"; then bad "$1: could not find its lines in the agent"; return; fi
    : > "$T/args"; : > "$T/stdin"
    CODE=$(PATH="$T/bin:$PATH" CURL_ARGS="$T/args" CURL_STDIN="$T/stdin" SUPABASE_URL="https://db.example.com" SUPABASE_KEY="publishable" \
        JSON_PAYLOAD="$PAYLOAD" HW_PAYLOAD="$PAYLOAD" bash -c ". '$T/block.sh'; $4" 2>"$T/err" < /dev/null)
    if grep -qF "$TOKEN" "$T/args"; then bad "$1: the token is in curl's arguments"; else ok "$1: the token is not in curl's arguments"; fi
    if [ "$(cat "$T/stdin")" = "$PAYLOAD" ]; then ok "$1: the report arrives on standard input, byte for byte"; else bad "$1: standard input is not the report"; fi
    if [ "$CODE" = "204" ]; then ok "$1: the status code still comes back"; else bad "$1: status code was \"$CODE\" ($(cat "$T/err"))"; fi
    if grep -qx -- '--data-binary' "$T/args" && grep -qx -- '@-' "$T/args"; then ok "$1: curl is told to read standard input as is"; else bad "$1: curl was not given --data-binary @-"; fi
}
run_block "telemetry report" 'STATUS_CODE=$(printf' '--data-binary @-)' 'printf "%s" "$STATUS_CODE"'
run_block "hardware report"  'HW_CODE=$(printf'     '--data-binary @-)' 'printf "%s" "$HW_CODE"'
run_block "firewall report"  'fw_post() {'          '    }'              'fw_post "$JSON_PAYLOAD"'

# Control: the old form, on the same fake curl, must be caught.
: > "$T/args"
PATH="$T/bin:$PATH" CURL_ARGS="$T/args" CURL_STDIN="$T/stdin" bash -c 'curl -s -X POST https://db.example.com -d "$0"' "$PAYLOAD" > /dev/null < /dev/null
if grep -qF "$TOKEN" "$T/args"; then ok "control: the old form (-d \"\$PAYLOAD\") does put the token in the arguments"; else bad "control: the fake curl cannot see a token in its arguments"; fi

# The whole file: every report to the database goes out on standard input.
# A data argument is a continuation line that starts with -d, or a curl line that
# carries one. ([ -d "$dir" ] is a folder test, not this.)
INLINE='(^[[:space:]]*|curl[[:space:]].*[[:space:]])(-d|--data|--data-raw)[[:space:]]+"'
posts=$(grep -c 'rest/v1/rpc/' "$AGENT")
stdin_posts=$(grep -c -- '--data-binary @-' "$AGENT")
inline=$(grep -cE -- "$INLINE" "$AGENT")
if [ "$posts" -ge 3 ] && [ "$posts" = "$stdin_posts" ]; then ok "all $posts reports in the agent use standard input"; else bad "$posts reports but $stdin_posts use standard input"; fi
if [ "$inline" = "0" ]; then ok "no curl in the agent takes its data as an argument"; else bad "$inline curl call(s) still take data as an argument"; fi
printf '  -d "$JSON_PAYLOAD")\n' > "$T/planted"
if [ "$(grep -cE -- "$INLINE" "$T/planted")" = "1" ]; then ok "control: that search finds a planted -d line"; else bad "control: the search misses a planted -d line"; fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
