#!/bin/bash
# Checks for scripts/set-email-change-template.sh, against a stand-in for
# Supabase's settings API on this machine and a stand-in keychain. Nothing real
# is contacted.
#
#   bash scripts/test-set-email-change-template.sh              # the checks
#   bash scripts/test-set-email-change-template.sh --controls   # broken copies: each must be caught
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${SCRIPT_UNDER_TEST:-$HERE/set-email-change-template.sh}"
T=$(mktemp -d) || exit 1
SERVER_PID=""
cleanup() { if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi; rm -rf "${T:?}"; }
trap cleanup EXIT

if [ "${1:-}" = "--controls" ]; then
    caught=0; missed=0; n=0
    try() { # label, sed expression
        n=$((n+1)); local copy="$T/broken-$n.sh"
        sed "$2" "$HERE/set-email-change-template.sh" > "$copy"
        if cmp -s "$copy" "$HERE/set-email-change-template.sh"; then echo "  STALE   $1 (the line to break is no longer there)"; missed=$((missed+1)); return; fi
        if SCRIPT_UNDER_TEST="$copy" bash "$0" > "$T/out-$n.txt" 2>&1; then echo "  MISSED  $1"; missed=$((missed+1))
        # A run that never reached its last line, or failed no check, is a crash, not a catch.
        elif tail -1 "$T/out-$n.txt" | grep -Eq '^[0-9]+ checks, [1-9][0-9]* failed$' && grep -q '^  FAIL' "$T/out-$n.txt"; then echo "  caught  $1  ($(grep -c '^  FAIL' "$T/out-$n.txt") checks failed)"; caught=$((caught+1))
        else echo "  CRASHED $1 (the run did not finish: that is not a catch)"; tail -3 "$T/out-$n.txt"; missed=$((missed+1)); fi
    }
    echo "Unbroken script first:"
    if bash "$0" > "$T/clean.txt" 2>&1; then echo "  passes  ($(tail -1 "$T/clean.txt"))"; else echo "  FAILS"; tail -5 "$T/clean.txt"; exit 1; fi
    echo "Broken copies:"
    try "a look changes the message"                 's/^if \[ "\$MODE" != "--apply" \]; then$/if false; then/'
    try "the whole settings file is sent back"       's/^json.dump(body, open(sys.argv\[2\], "w"))$/cfg.update(body); json.dump(cfg, open(sys.argv[2], "w"))/'
    try "the token is printed"                       's/^\[ "\$CODE" = 200 \] || { echo "✗ could not read the settings/echo "debug: $(token)"; [ "$CODE" = 200 ] || { echo "✗ could not read the settings/'
    try "a hand-edited message is overwritten"       's/^elif OLD not in text:$/elif False:/'
    try "an http Site URL is accepted"               's/^elif not site.startswith("https:\/\/"):$/elif False:/'
    try "a refused change reads as done"             's/^\[ "\$CODE" = 200 \] || { echo "✗ the change was refused/[ "$CODE" != x ] || { echo "✗ the change was refused/'
    try "the read-back is not compared"              's/^if wrong:$/if False:/'
    try "other settings moving goes unnoticed"       's/^if moved:$/if False:/'
    try "the wrapped keychain token is sent wrapped" 's/go-keyring-base64:\*) printf .%s. "\${RAW#go-keyring-base64:}" | base64 -d ;;/go-keyring-base64:*) printf "%s" "$RAW" ;;/'
    try "an http --site-url is accepted"             's/\(grep -Eq .\)^https:/\1^https?:/; s/site.startswith("https:\/\/")/site.startswith("http")/'
    try "--site-url is shown but never sent"         's/^    body\["site_url"\] = want_site$/    pass/'
    try "a look with --site-url changes it"          's/^if \[ "\$MODE" != "--apply" \]; then$/if [ "$MODE" != "--apply" ] \&\& [ -z "$WANT_SITE" ]; then/'
    try "a late read-back is given up on at once"    's/^    \[ "\$V" = 3 \] || break$/    break/'
    try "a read-back that never comes right loops on" 's/^    \[ "\$TRIES" -lt "\$MAX_TRIES" \] || break$/    [ "$TRIES" -lt 40 ] || break/'
    try "the Site URL is not read back"              's/^wrong = \[names.get(k, k) for k in want if after.get(k) != want\[k\]\]$/wrong = [names.get(k, k) for k in want if k != "site_url" and after.get(k) != want[k]]/'
    try "the first read puts the login on curl's command line" 's/^CODE=\$(login_header | curl -s -o "\$NOW" -w "%{http_code}" "\$API" -H @-)$/CODE=$(curl -s -o "$NOW" -w "%{http_code}" "$API" -H "Authorization: Bearer $(token)")/'
    try "the change puts the login on curl's command line"     's/^    -H @- -H "Content-Type: application\/json" --data-binary @"\$BODY")$/    -H "Authorization: Bearer $(token)" -H "Content-Type: application\/json" --data-binary @"$BODY")/'
    try "the read-back puts the login on curl's command line"  's/^    CODE=\$(login_header | curl -s -o "\$AFTER" -w "%{http_code}" "\$API" -H @-)$/    CODE=$(curl -s -o "$AFTER" -w "%{http_code}" "$API" -H "Authorization: Bearer $(token)")/'
    try "the login is sent under another header name"          's/^login_header() { printf .Authorization: Bearer %s/login_header() { printf '"'"'X-Login: %s/'
    try "the header is built by a program outside the shell"   's/^login_header() { printf /login_header() { env printf /'
    try "the login is also handed to an outside echo"          's/^login_header() { printf /login_header() { env echo "$(token)" > \/dev\/null; printf /'
    echo; echo "$n broken copies: $caught caught, $missed missed"
    [ "$missed" = 0 ]; exit $?
fi

# ── the stand-ins ──────────────────────────────────────────────────────────
mkdir -p "$T/bin"
cat > "$T/bin/security" <<'EOF'
#!/bin/bash
[ -r "$FAKE_KEYCHAIN" ] && cat "$FAKE_KEYCHAIN" || exit 44
EOF
chmod +x "$T/bin/security"
# curl here keeps its arguments, one call per block, then runs the real curl against the stand-in below.
# An outside printf or echo keeps its arguments too: the script must build the header with the shell's own.
REAL_CURL="$(command -v curl)" || { echo "curl is not installed"; exit 1; }
cat > "$T/bin/curl" <<EOF_CURL
#!/bin/bash
{ echo "== call"; printf '%s\n' "\$@"; } >> "\$CURL_ARGS"
exec "$REAL_CURL" "\$@"
EOF_CURL
for tool in printf echo; do
    # The program itself, by its full path: `command -v` would name bash's own, and the stand-in would then run itself.
    REAL_TOOL=""; for d in /usr/bin /bin; do if [ -x "$d/$tool" ]; then REAL_TOOL="$d/$tool"; break; fi; done
    [ -n "$REAL_TOOL" ] || { echo "ABORT: no $tool program in /usr/bin or /bin"; exit 1; }
    printf '#!/bin/bash\n{ echo "== %s"; /usr/bin/printf "%%s\\n" "$@"; } >> "$ARGV_LOG"\nexec %s "$@"\n' "$tool" "$REAL_TOOL" > "$T/bin/$tool"
done
chmod +x "$T/bin/curl" "$T/bin/printf" "$T/bin/echo"
cat > "$T/server.py" <<'EOF'
import json, sys, http.server
state_path, log_path = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def note(self, body=None):
        with open(log_path, "a") as f: f.write(json.dumps({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"), "body": body}) + "\n")
    def do_GET(self):
        self.note(); st = json.load(open(state_path))
        if st.get("__get_fails"): return self.answer(401, {"message": "Unauthorized"})
        if st.get("__stale_left", 0) > 0:
            st["__stale_left"] -= 1; json.dump(st, open(state_path, "w")); return self.answer(200, st["__old"])
        self.answer(200, st["config"])
    def do_PATCH(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}"); self.note(body)
        st = json.load(open(state_path))
        if st.get("__patch_fails"): return self.answer(500, {"message": "stand-in refuses"})
        if st.get("__site_ignored"): body.pop("site_url", None)
        if st.get("__lag"): st["__old"] = dict(st["config"]); st["__stale_left"] = st["__lag"]
        if not st.get("__patch_ignored"): st["config"].update(body)
        if st.get("__patch_moves_other"): st["config"]["rate_limit_email_sent"] = 999
        json.dump(st, open(state_path, "w")); self.answer(200, st["__old"] if st.get("__reply_old") else st["config"])
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True); srv.serve_forever()
EOF
python3 "$T/server.py" "$T/state.json" "$T/log.jsonl" > "$T/port.txt" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$T/port.txt" ] && break; perl -e 'select(undef,undef,undef,0.1)'; done
PORT=$(cat "$T/port.txt"); [ -n "$PORT" ] || { echo "the stand-in did not start"; exit 1; }

TOKEN="sbp_FAKE-not-a-real-token-0000"
NEWLINK='{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change'
ran=0; failed=0
ok() { ran=$((ran+1)); if [ "$2" = "$3" ]; then echo "  ok   $1"; else failed=$((failed+1)); echo "  FAIL $1"; echo "       got  $2"; echo "       want $3"; fi; }
has() { ran=$((ran+1)); if printf '%s' "$2" | grep -qF -- "$3"; then echo "  ok   $1"; else failed=$((failed+1)); echo "  FAIL $1 (missing: $3)"; fi; }
hasnt() { ran=$((ran+1)); if printf '%s' "$2" | grep -qF -- "$3"; then failed=$((failed+1)); echo "  FAIL $1 (found: $3)"; else echo "  ok   $1"; fi; }
setup() { # template (python literal or None), then extra state as python dict literal
    : > "$T/log.jsonl"; : > "$T/curl-args.log"; : > "$T/argv.log"; printf '%s' "${3:-$TOKEN}" > "$T/keychain"
    local extra="${2:-}"; [ -n "$extra" ] || extra="{}"
    python3 - "$T/state.json" "$1" "$extra" <<'PY'
import json, sys, ast
tpl = ast.literal_eval(sys.argv[2]); extra = ast.literal_eval(sys.argv[3])
cfg = {"site_url": "https://fleet.example.com", "mailer_secure_email_change_enabled": True, "smtp_host": None, "mailer_notifications_email_changed_enabled": False, "rate_limit_email_sent": 2, "mailer_subjects_email_change": "Confirm", "mailer_templates_email_change_content": tpl, "uri_allow_list": "https://fleet.example.com/**"}
cfg.update(extra.pop("config", {}))
json.dump({"config": cfg, **extra}, open(sys.argv[1], "w"))
PY
}
run() { OUT=$(PATH="$T/bin:$PATH" CURL_ARGS="$T/curl-args.log" ARGV_LOG="$T/argv.log" FAKE_KEYCHAIN="$T/keychain" FLEET_SUPABASE_API="http://127.0.0.1:$PORT" FLEET_SUPABASE_PROJECT_REF="standinref" FLEET_READBACK_TRIES=4 FLEET_READBACK_WAIT=0.05 bash "$SCRIPT" "$@" 2>&1); RC=$?; RESULT=$(printf '%s\n' "$OUT" | tail -1); }
patches() { grep -c '"method": "PATCH"' "$T/log.jsonl"; }
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["config"].get(sys.argv[2]))' "$T/state.json" "$1"; }
patch_body() { python3 -c 'import json,sys; rows=[json.loads(l) for l in open(sys.argv[1])]; p=[r for r in rows if r["method"]=="PATCH"]; print(json.dumps(sorted(p[-1]["body"].keys())) if p else "none")' "$T/log.jsonl"; }

echo "Looking:"
setup None; run
ok "a look ends 'look' and exits 0" "$RESULT/$RC" "email_template_result=look/0"
ok "a look sends no change" "$(patches)" "0"
has "it shows the Site URL" "$OUT" "https://fleet.example.com"
has "it says where the link would go" "$OUT" "https://fleet.example.com/auth/confirm?token_hash="
has "it says how to apply" "$OUT" "bash scripts/set-email-change-template.sh --apply"
hasnt "the token is never printed" "$OUT" "$TOKEN"
ok "the request carried the keychain token" "$(grep -c "\"auth\": \"Bearer $TOKEN\"" "$T/log.jsonl")" "1"
ok "it asked the project named in the settings" "$(grep -c '"path": "/v1/projects/standinref/config/auth"' "$T/log.jsonl")" "1"

echo "Applying, Supabase's own default message:"
setup None; run --apply
ok "apply ends 'ok' and exits 0" "$RESULT/$RC" "email_template_result=ok/0"
ok "one change was sent" "$(patches)" "1"
ok "the change holds one field and nothing else" "$(patch_body)" '["mailer_templates_email_change_content"]'
has "the message now links to Fleet's confirm page" "$(field mailer_templates_email_change_content)" "<a href=\"$NEWLINK\">"
hasnt "and no longer to Supabase's own address" "$(field mailer_templates_email_change_content)" "{{ .ConfirmationURL }}"
has "the rest of the message is kept" "$(field mailer_templates_email_change_content)" "confirm {{ .NewEmail }} as your new email address"
ok "the Site URL is untouched" "$(field site_url)" "https://fleet.example.com"
ok "the redirect list is untouched" "$(field uri_allow_list)" "https://fleet.example.com/**"
has "it reports the read-back" "$OUT" "changed and read back"
hasnt "the token is never printed" "$OUT" "$TOKEN"
# The login must reach curl on standard input, never as an argument another program on this machine could read.
calls() { grep -c '^== call$' "$T/curl-args.log"; }
from_stdin() { awk 'BEGIN { n = 0 } /^== call$/ { h = 0; next } h { if ($0 == "@-") n++; h = 0; next } $0 == "-H" { h = 1 } END { print n }' "$T/curl-args.log"; }
login_checks() { # label for the run, the number of requests it must have made
    ok "$1: curl was run $2 times, and each time told to read a header from standard input" "$(calls)/$(from_stdin)" "$2/$2"
    ok "$1: the login is in none of curl's arguments ($(grep -vc '^== call$' "$T/curl-args.log") looked at)" "$(grep -cF -- "$TOKEN" "$T/curl-args.log")" "0"
    ok "$1: every request arrived with the login as its Authorization header" "$(grep -c "\"auth\": \"Bearer $TOKEN\"" "$T/log.jsonl")/$(wc -l < "$T/log.jsonl" | tr -d ' ')" "$2/$2"
    ok "$1: no outside printf or echo was handed the login" "$(grep -cF -- "$TOKEN" "$T/argv.log")" "0"
}
login_checks "an apply (read, change, read-back)" 3
run --apply
ok "a second apply finds nothing to do" "$RESULT/$RC/$(patches)" "email_template_result=ok/0/1"
has "and says so" "$OUT" "already links to Fleet's confirm page"

echo "Applying, a message someone has styled:"
setup "'<p>Hi</p><a href=\"{{ .ConfirmationURL }}\">Confirm</a><p>or paste {{ .ConfirmationURL }}</p>'"; run --apply
ok "both links are replaced, the rest kept" "$(field mailer_templates_email_change_content)" "<p>Hi</p><a href=\"$NEWLINK\">Confirm</a><p>or paste $NEWLINK</p>"
setup None '{}' "go-keyring-base64:$(printf '%s' "$TOKEN" | base64)"; run --apply
ok "a wrapped keychain token is unwrapped before use" "$(grep -c "\"auth\": \"Bearer $TOKEN\"" "$T/log.jsonl")/$RESULT" "3/email_template_result=ok"
login_checks "an apply with a wrapped keychain token" 3
ok "nor is the wrapped form in any of curl's arguments" "$(grep -cF -- "$(printf '%s' "$TOKEN" | base64)" "$T/curl-args.log")" "0"
: > "$T/curl-args.log"; CURL_ARGS="$T/curl-args.log" "$T/bin/curl" -s -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/projects/standinref/config/auth"
ok "control: the stand-in curl does keep a login put among its arguments" "$(grep -cF -- "$TOKEN" "$T/curl-args.log")" "1"
: > "$T/argv.log"; ARGV_LOG="$T/argv.log" "$T/bin/printf" '%s' "$TOKEN" > /dev/null; ARGV_LOG="$T/argv.log" "$T/bin/echo" "$TOKEN" > /dev/null
ok "control: the stand-in printf and echo keep a login handed to them" "$(grep -cF -- "$TOKEN" "$T/argv.log")" "2"

echo "A new project, Site URL still http://localhost:3000:"
LOCAL='{"config": {"site_url": "http://localhost:3000"}}'
setup None "$LOCAL"; run
ok "without --site-url it stops and changes nothing" "$RESULT/$RC/$(patches)" "email_template_result=stop/1/0"
has "and says how to set it" "$OUT" "bash scripts/set-email-change-template.sh --site-url https://"
setup None "$LOCAL"; run --site-url https://fleet.example.com
ok "a look with --site-url changes nothing" "$RESULT/$RC/$(patches)/$(field site_url)" "email_template_result=look/0/0/http://localhost:3000"
has "it shows the Site URL change" "$OUT" "from http://localhost:3000 to https://fleet.example.com"
has "and where the link would go" "$OUT" "https://fleet.example.com/auth/confirm?token_hash="
has "and the full command to apply" "$OUT" "bash scripts/set-email-change-template.sh --apply --site-url https://fleet.example.com"
setup None "$LOCAL"; run --apply --site-url https://fleet.example.com/
ok "apply with --site-url ends ok, in one change" "$RESULT/$RC/$(patches)" "email_template_result=ok/0/1"
ok "that change holds the two fields and nothing else" "$(patch_body)" '["mailer_templates_email_change_content", "site_url"]'
ok "the Site URL is set, without the trailing slash" "$(field site_url)" "https://fleet.example.com"
has "the message links to Fleet's confirm page" "$(field mailer_templates_email_change_content)" "<a href=\"$NEWLINK\">"
ok "the redirect list is untouched" "$(field uri_allow_list)" "https://fleet.example.com/**"
has "it reports both" "$OUT" "the Site URL is https://fleet.example.com; the message links to Fleet's confirm page"
run --apply --site-url https://fleet.example.com
ok "a second apply finds nothing to do" "$RESULT/$RC/$(patches)" "email_template_result=ok/0/1"
setup "'<p><a href=\"$NEWLINK\">Confirm</a></p>'" "$LOCAL"; run --apply --site-url https://fleet.example.com
ok "with the message already done, only the Site URL is sent" "$RESULT/$(patch_body)/$(field site_url)" 'email_template_result=ok/["site_url"]/https://fleet.example.com'
setup "'<p>Use this code: {{ .Token }}</p>'" "$LOCAL"; run --apply --site-url https://fleet.example.com
ok "control: a hand-edited message stops everything, the Site URL included" "$RESULT/$RC/$(patches)/$(field site_url)" "email_template_result=stop/1/0/http://localhost:3000"
setup None "$LOCAL" ; cp "$T/state.json" "$T/state-ignored.json"
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); s["__site_ignored"]=True; json.dump(s,open(sys.argv[1],"w"))' "$T/state.json"; run --apply --site-url https://fleet.example.com
ok "control: a Site URL that did not take is caught on read-back" "$RESULT/$RC" "email_template_result=stop/1"
has "and it is named" "$OUT" "the Site URL did not come back as sent"
has "with what did come back" "$OUT" "Site URL read back as: http://localhost:3000"
gets() { grep -c '"method": "GET"' "$T/log.jsonl"; }
ok "and it stopped after the set number of read-backs" "$(gets)" "5"

echo "Supabase answering with the old settings for a moment after a change:"
LAG2='{"config": {"site_url": "http://localhost:3000"}, "__lag": 2}'
LAG99='{"config": {"site_url": "http://localhost:3000"}, "__lag": 99}'
LAG99OLD='{"config": {"site_url": "http://localhost:3000"}, "__lag": 99, "__reply_old": True}'
setup None "$LAG2"; run --apply --site-url https://fleet.example.com
ok "two stale read-backs, then right: ends ok" "$RESULT/$RC/$(patches)" "email_template_result=ok/0/1"
has "and says which read-back it was" "$OUT" "changed and read back (on read-back 3)"
hasnt "and prints no failure on the way" "$OUT" "did not come back as sent"
setup None "$LAG99"; run --apply --site-url https://fleet.example.com
ok "control: read-backs that stay stale end in stop, never ok" "$RESULT/$RC/$(patches)" "email_template_result=stop/1/1"
has "it says Supabase's reply showed the change" "$OUT" "showed it applied, so the read-back may just be behind"
has "and what the message read back as" "$OUT" "The message read back as: still Supabase's built-in message"
has "and to run the same command again" "$OUT" "Run the same command again in a minute"
ok "after exactly the set number of read-backs" "$(gets)" "5"
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); s["__stale_left"]=0; json.dump(s,open(sys.argv[1],"w"))' "$T/state.json"; : > "$T/log.jsonl"; run --apply --site-url https://fleet.example.com
ok "the same command again, once Supabase has caught up: nothing to do" "$RESULT/$RC/$(patches)" "email_template_result=ok/0/0"
setup None "$LAG99OLD"; run --apply --site-url https://fleet.example.com
has "control: a reply that did not show the change is reported as such" "$OUT" "did not show it applied"
for bad in http://fleet.example.com https://fleet.example.com/path "https://fleet.example.com?x=1" fleet.example.com "https://"; do
    setup None "$LOCAL"; run --apply --site-url "$bad"
    ok "control: --site-url $bad is refused before any request" "$RESULT/$RC/$(wc -l < "$T/log.jsonl" | tr -d ' ')" "email_template_result=stop/2/0"
done
setup None "$LOCAL"; run --apply --site-url
ok "control: --site-url with no address is refused before any request" "$RESULT/$RC/$(wc -l < "$T/log.jsonl" | tr -d ' ')" "email_template_result=stop/2/0"

echo "Stopping:"
setup "'<p>Use this code: {{ .Token }}</p>'"; run --apply
ok "control: a message with no link to replace is left alone" "$RESULT/$RC/$(patches)" "email_template_result=stop/1/0"
has "and the link to put in by hand is shown" "$OUT" "$NEWLINK"
setup None '{"config": {"site_url": "http://localhost:3000"}}'; run --apply
ok "control: a Site URL that is not https stops it" "$RESULT/$RC/$(patches)" "email_template_result=stop/1/0"
setup None '{"__patch_fails": True}'; run --apply
ok "control: a refused change is reported, not claimed" "$RESULT/$RC" "email_template_result=stop/1"
hasnt "and it does not say changed" "$OUT" "changed and read back"
has "and it says Supabase refused it" "$OUT" "the change was refused (HTTP 500)"
setup None '{"__patch_ignored": True}'; run --apply
ok "control: a change that did not take is caught on read-back" "$RESULT/$RC" "email_template_result=stop/1"
setup None '{"__patch_moves_other": True}'; run --apply
ok "control: another setting moving is caught on read-back" "$RESULT/$RC" "email_template_result=stop/1"
has "and the setting is named" "$OUT" "rate_limit_email_sent"
setup None '{"__get_fails": True}'; run --apply
ok "control: settings that cannot be read stop it before any change" "$RESULT/$RC/$(patches)" "email_template_result=stop/1/0"
setup None; rm -f "$T/keychain"; run --apply
ok "control: no keychain login stops it before any request" "$RESULT/$RC/$(wc -l < "$T/log.jsonl" | tr -d ' ')" "email_template_result=stop/1/0"
setup None; run --force
ok "control: an unknown option changes nothing" "$RESULT/$RC/$(wc -l < "$T/log.jsonl" | tr -d ' ')" "email_template_result=stop/2/0"

echo; echo "$ran checks, $failed failed"
[ "$failed" = 0 ]
