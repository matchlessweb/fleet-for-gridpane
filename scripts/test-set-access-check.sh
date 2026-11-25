#!/usr/bin/env bash
# Self-test for set-access-check.sh. Nothing here touches Cloudflare: "npx wrangler" is a
# stand-in that keeps the Worker's secrets as files in a folder and writes down every
# command it was given, so the test can count the requests and read back what was stored.
#   bash scripts/test-set-access-check.sh             the checks
#   ACCESS_SCRIPT=<path> bash scripts/test-...        run them against another copy (used by the controls)
#   bash scripts/test-set-access-check.sh --controls  break the script one way at a time; each break must fail a check
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${ACCESS_SCRIPT:-$HERE/set-access-check.sh}"

if [ "${1:-}" = "--controls" ]; then
  W="$(mktemp -d "${TMPDIR:-/tmp}/access-check-ctl.XXXXXX")"; trap 'if [ -d "$W" ]; then rm -rf -- "$W"; fi' EXIT
  caught=0; missed=0
  mkdir -p "$W/scripts"
  ctl() { # name, "text ==> replacement" over the script
    python3 - "$HERE/set-access-check.sh" "$W/scripts/broken.sh" "$2" <<'PY'
import sys
src, out, expr = sys.argv[1:4]
s = open(src).read(); a, b = expr.split(" ==> ", 1)
a = a.replace("\\n", "\n"); b = b.replace("\\n", "\n")
if a not in s: sys.exit("mutation did not apply: " + a[:60])
open(out, "w").write(s.replace(a, b, 1))
PY
    [ $? = 0 ] || { echo "  MISSED  $1  (the break itself did not apply)"; missed=$((missed+1)); return; }
    bash -n "$W/scripts/broken.sh" 2>/dev/null || { echo "  MISSED  $1  (the broken copy is not a program: fix this control)"; missed=$((missed+1)); return; }
    out="$(ACCESS_SCRIPT="$W/scripts/broken.sh" bash "$0" 2>&1)"; last="$(printf '%s\n' "$out" | tail -1)"
    n="$(printf '%s\n' "$out" | grep -c '^  FAIL')"
    # A copy that fails every check did not get as far as its work: that is a broken control, not a catch.
    if [ "$n" -ge "$total" ]; then echo "  MISSED  $1  (every check failed: the broken copy did not run at all)"; missed=$((missed+1)); return; fi
    if printf '%s' "$last" | grep -q 'checks, ' && [ "$n" -gt 0 ]; then echo "  caught  $1  ($n checks failed)"; caught=$((caught+1)); else echo "  MISSED  $1  ($last)"; missed=$((missed+1)); fi
  }
  echo "Unbroken script first:"; out="$(bash "$0" 2>&1)"; echo "  $(printf '%s\n' "$out" | tail -1)"
  # With a check already failing, every broken copy would "fail a check" and prove nothing.
  printf '%s\n' "$out" | tail -1 | grep -qE '^[0-9]+ checks, 0 failed$' || { echo "The unbroken script does not pass, so the controls would prove nothing. Fix that first."; exit 1; }
  total="$(printf '%s\n' "$out" | tail -1 | grep -oE '^[0-9]+')"
  echo "Broken copies:"
  ctl "the two settings are written one at a time" 'if ! "${WR[@]}" secret bulk "$TMP/settings.json" > "$TMP/wrangler.out" 2>&1; then ==> if ! { printf "%s" "$TEAM" | "${WR[@]}" secret put CF_ACCESS_TEAM_DOMAIN && printf "%s" "$AUD" | "${WR[@]}" secret put CF_ACCESS_AUD; } > "$TMP/wrangler.out" 2>&1; then'
  ctl "one value without the other is accepted" 'if [ "$OFF" = 0 ] && [ "$TEAM_GIVEN" != "$AUD_GIVEN" ]; then ==> if false; then'
  ctl "a look writes to the Worker" 'if [ "$APPLY" = 0 ]; then\n  echo ==> if false; then\n  echo'
  ctl "--apply with nothing to do goes on" 'if [ "$APPLY" = 1 ] && [ "$OFF" = 0 ] && [ "$TEAM_GIVEN" = 0 ]; then ==> if false; then'
  ctl "the audience tag is printed" 'echo "Sent to the Worker in one request." ==> echo "Sent to the Worker in one request: $AUD"'
  ctl "a look prints the audience tag" 'and CF_ACCESS_AUD (${#AUD} characters) on the Worker ==> and CF_ACCESS_AUD ($AUD) on the Worker'
  ctl "the file with the two values is left on disk" 'trap cleanup EXIT ==> :'
  ctl "the change is not read back" '# Read back, never assumed.\nif ! list_names; then ==> # Read back, never assumed.\nif false; then'
  ctl "the state after the change is taken on trust" 'read_state\necho "On the Worker now:"\nsay_state\nif [ "$STATE" != "$WANT" ]; then ==> STATE="$WANT"\necho "On the Worker now:"\nsay_state\nif [ "$STATE" != "$WANT" ]; then'
  ctl "half a setup is called on" '10) STATE="half-team" ;; ==> 10) STATE="on" ;;'
  ctl "half a setup is called off" '*) STATE="half-aud" ;; ==> *) STATE="off" ;;'
  ctl "half a setup gets no warning" 'half-team) echo "WARNING: only CF_ACCESS_TEAM_DOMAIN is set. ==> half-team) echo "Only CF_ACCESS_TEAM_DOMAIN is set.'
  ctl "any text is taken as an audience tag" '[[ "$AUD" =~ ^[0-9a-f]{64}$ ]] ==> [[ "$AUD" =~ . ]]'
  ctl "any host is taken as a team address" '[[ "$TEAM" =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]] ==> [[ "$TEAM" =~ ^[a-z0-9.-]+$ ]]'
  ctl "a path after the team address is accepted" '[[ "$TEAM" =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]] ==> [[ "$TEAM" =~ ^[a-z0-9-]+\.cloudflareaccess\.com ]]'
  ctl "an address pasted with https:// is refused" "s#^https://##; s#/+\$## ==> s#/+\$##"
  ctl "an address is stored with its capitals" " | tr '[:upper:]' '[:lower:]' | sed -E ==>  | sed -E"
  ctl "--off removes only the team address" 'for s in $PAIR; do if on_worker "$s"; then printf '"'"'%s"%s": null'"'"' ==> for s in CF_ACCESS_TEAM_DOMAIN; do if on_worker "$s"; then printf '"'"'%s"%s": null'"'"''
  ctl "--off names a setting that is not there" 'for s in $PAIR; do if on_worker "$s"; then printf '"'"'%s"%s": null'"'"' "$sep" "$s"; sep='"'"', '"'"'; fi; done ==> for s in $PAIR; do printf '"'"'%s"%s": null'"'"' "$sep" "$s"; sep='"'"', '"'"'; done'
  ctl "--off with nothing set still writes" 'if [ "$WANT" = "off" ] && [ "$STATE" = "off" ]; then ==> if false; then'
  ctl "--off is taken together with values" 'if [ "$OFF" = 1 ] && [ "$TEAM_GIVEN$AUD_GIVEN" != "00" ]; then stop ==> if false; then stop'
  ctl "a refused write is reported as done" '  stop "the Worker did not take the change. ==> echo "the Worker did not take the change. '
  ctl "--apply goes on when wrangler is not signed in" '[ "$LISTED" = 1 ] || stop "wrangler could not reach the Worker ==> [ "$LISTED" = 1 ] || echo "wrangler could not reach the Worker'
  ctl "an unconfirmed change is reported as done" '  echo "access_check_result=unconfirmed"\n  exit 1 ==>   echo "access_check_result=ok"\n  exit 0'
  ctl "an option given with = prints its value" 'stop "unknown option ${BASH_REMATCH[1]}=. ==> stop "unknown option $1. '
  ctl "a stray argument is printed" 'stop "an argument this script does not take (not shown here, in case it is the tag). ==> stop "an argument this script does not take: $1. '
  ctl "with no wrangler.jsonc the script ends without a word" 'wrangler.jsonc 2>/dev/null | head -1 || true)" ==> wrangler.jsonc 2>/dev/null | head -1)"'
  ctl "the name of the Worker is not shown" '[ -z "$WORKER" ] || echo "Worker: ==> [ -z "$WORKER" ] || : "Worker: '
  ctl "a list that fails is blamed on the sign-in alone" "it is not installed here (npm install), ==> it is not signed in,"
  echo; echo "$((caught+missed)) broken copies: $caught caught, $missed missed"
  [ "$missed" = 0 ]; exit $?
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/access-check-test.XXXXXX")"; trap 'if [ -d "$T" ]; then rm -rf -- "$T"; fi' EXIT
mkdir -p "$T/bin" "$T/tmp" "$T/home"
cat > "$T/bin/npx" <<'FAKE'
#!/usr/bin/env bash
# Stand-in for "npx --no-install wrangler ...": the Worker's secrets are files under $FAKE_DIR/secrets.
shift 2 # --no-install wrangler
echo "wrangler $*" | sed "s#$FAKE_TMP/[^ ]*#<file>#" >> "$FAKE_DIR/log"
[ -z "${FAKE_OFFLINE:-}" ] || { echo "not logged in" >&2; exit 1; }
if [ "$1 $2" = "secret list" ]; then
  [ ! -e "$FAKE_DIR/no-more-lists" ] || { echo "not logged in" >&2; exit 1; }
  printf '['; first=1
  for f in "$FAKE_DIR"/secrets/*; do [ -e "$f" ] || continue; [ $first = 1 ] || printf ','; first=0; printf '\n  {\n    "name": "%s",\n    "type": "secret_text"\n  }' "$(basename "$f")"; done
  printf '\n]\n'; exit 0
fi
if [ "$1 $2" = "secret put" ]; then
  mkdir -p "$FAKE_DIR/secrets"; cat > "$FAKE_DIR/secrets/$3"; echo "Success! Uploaded secret $3"; exit 0
fi
if [ "$1 $2" = "secret bulk" ]; then
  # One request: every name in the file is stored, or removed when its value is null. A name to remove that is not there is an error, and then nothing changes.
  [ -z "${FAKE_FAIL_BULK:-}" ] || { echo "upload refused" >&2; exit 1; }
  cp "$3" "$FAKE_DIR/last-bulk.json"
  python3 - "$3" "$FAKE_DIR/secrets" "${FAKE_BULK_HALF:-}" <<'PY' || exit 1
import json, os, sys
doc = json.load(open(sys.argv[1])); folder = sys.argv[2]; half = sys.argv[3]
for name, value in doc.items():
    if value is None and not os.path.exists(os.path.join(folder, name)): sys.exit("no such secret: " + name)
for i, (name, value) in enumerate(doc.items()):
    if half and i > 0: break   # a Worker that took only the first: must be noticed
    path = os.path.join(folder, name)
    if value is None: os.remove(path)
    else: open(path, "w").write(value)
PY
  [ -z "${FAKE_NO_LIST_AFTER:-}" ] || : > "$FAKE_DIR/no-more-lists"
  echo "Finished processing secrets file"; exit 0
fi
exit 1
FAKE
chmod +x "$T/bin/npx"

ran=0; failed=0
check() { ran=$((ran+1)); if [ "$2" = "$3" ]; then echo "  ok    $1"; else failed=$((failed+1)); echo "  FAIL  $1"; echo "        got  $2"; echo "        want $3"; fi; }
fresh() { rm -rf -- "$T/fake" "$T/tmp"; mkdir -p "$T/fake/secrets" "$T/tmp"; : > "$T/fake/log"; }
have() { for n in "$@"; do printf 'held-%s' "$n" > "$T/fake/secrets/$n"; done; }   # the Worker already holds these
run() { PATH="$T/bin:$PATH" HOME="$T/home" FAKE_DIR="$T/fake" FAKE_TMP="$T/tmp" TMPDIR="$T/tmp" bash "${RUN_AS:-$SCRIPT}" "$@" > "$T/out.txt" 2>&1 < /dev/null; echo $?; }
writes() { grep -v '^wrangler secret list' "$T/fake/log" | tr '\n' ';'; }             # every command that could change the Worker
last() { tail -1 "$T/out.txt"; }
said() { grep -c -- "$1" "$T/out.txt"; }
left() { find "$T/tmp" -mindepth 1 | wc -l | tr -d ' '; }
held() { ls "$T/fake/secrets" | tr '\n' ' '; }
val() { cat "$T/fake/secrets/$1" 2>/dev/null; }
AUD_OK="$(printf 'a%.0s' $(seq 64))"; TEAM_OK="team.cloudflareaccess.com"
TD=CF_ACCESS_TEAM_DOMAIN; AU=CF_ACCESS_AUD

echo "A look says which of the three states the Worker is in, and changes nothing:"
fresh; rc=$(run)
check "neither set: off" "$rc/$(last)/$(writes)/$(said '^Cloudflare Access check: off\.')/$(said '  not set$')/$(said '^Looked only. Nothing was changed.$')" "0/access_check_result=look//1/2/1"
fresh; have $TD $AU OTHER_SECRET; rc=$(run)
check "both set: ON, and other secrets are not counted" "$rc/$(last)/$(writes)/$(said '^Cloudflare Access check: ON\.')/$(said '  set$')" "0/access_check_result=look//1/2"
fresh; have $TD; rc=$(run)
check "only the address set: a warning that the app refuses every request, and how to fix it" "$rc/$(writes)/$(said "^WARNING: only $TD is set\..*refuses EVERY request (503)")/$(said 'Cloudflare Access check: O')/$(said '^Finish it, or undo it, in one step:$')" "0//1/0/1"
fresh; have $AU; rc=$(run)
check "only the tag set: the same warning, naming the tag" "$rc/$(writes)/$(said "^WARNING: only $AU is set\..*refuses EVERY request (503)")/$(said 'Cloudflare Access check: O')" "0//1/0"
fresh; rc=$(run --team-domain "$TEAM_OK" --aud "$AUD_OK")
check "with both values and no --apply: says what --apply would do, writes nothing, and does not print the tag" "$rc/$(last)/$(writes)/$(said "^--apply would store $TD ($TEAM_OK) and $AU (64 characters)")/$(said "$AUD_OK")/$(held)" "0/access_check_result=look//1/0/"
fresh; have $TD $AU; rc=$(run --off)
check "--off with no --apply: says what --apply would do and removes nothing" "$rc/$(last)/$(writes)/$(said '^--apply would remove both settings')/$(held)" "0/access_check_result=look//1/$AU $TD "
fresh; rc=$(FAKE_OFFLINE=1 run)
check "wrangler cannot list: a look says so, and names the three causes" "$rc/$(last)/$(said 'npx wrangler login')/$(said 'npm install')/$(said 'no connection')" "0/access_check_result=look/1/1/1"

echo "The Worker it will change is named, and a folder with no wrangler.jsonc does not stop it:"
mkdir -p "$T/tree/scripts" "$T/bare/scripts"; cp "$SCRIPT" "$T/tree/scripts/set.sh"; cp "$SCRIPT" "$T/bare/scripts/set.sh"
printf '{\n  "name": "example-worker",\n  "main": "x.js"\n}\n' > "$T/tree/wrangler.jsonc"
fresh; rc=$(RUN_AS="$T/tree/scripts/set.sh" run)
check "the name in wrangler.jsonc is shown" "$rc/$(last)/$(said '^Worker: example-worker (from wrangler.jsonc)$')" "0/access_check_result=look/1"
fresh; rc=$(RUN_AS="$T/bare/scripts/set.sh" run)
check "with no wrangler.jsonc it still looks, and still ends with its result line" "$rc/$(last)/$(said '^Worker:')/$(said '^Cloudflare Access check: off\.')" "0/access_check_result=look/0/1"

echo "Turning it on:"
fresh; rc=$(run --apply --team-domain "$TEAM_OK" --aud "$AUD_OK")
check "exits clean and says the check is ON" "$rc/$(last)/$(said '^Cloudflare Access check: ON\.')" "0/access_check_result=ok/1"
check "the Worker was changed by ONE request, a bulk write: never one setting at a time" "$(writes)" "wrangler secret bulk <file>;"
check "that one request carried both settings and nothing else" "$(python3 -c 'import json,sys; print(sorted(json.load(open(sys.argv[1])).keys()))' "$T/fake/last-bulk.json")" "['CF_ACCESS_AUD', 'CF_ACCESS_TEAM_DOMAIN']"
check "both arrive exactly, with no newline added" "$(val $TD)|$(val $AU)|$(wc -l < "$T/fake/secrets/$AU" | tr -d ' ')" "$TEAM_OK|$AUD_OK|0"
check "the Worker's list was read again after the write" "$(grep -c '^wrangler secret list' "$T/fake/log")/$(tail -1 "$T/fake/log")" "2/wrangler secret list --format json"
check "the audience tag is in nothing it printed, and the file with the values is gone" "$(said "$AUD_OK")/$(left)" "0/0"
check "it says what to look for next, and how to undo it" "$(said 'x-fleet-access-check: on')/$(said '--apply --off$')" "1/1"
check "it says the values themselves cannot be read back" "$(said 'only the two names were read back')" "1"
fresh; have OTHER_SECRET; rc=$(run --apply --team-domain "https://Team.CloudflareAccess.com/" --aud "$AUD_OK")
check "an address pasted with https://, capitals and a slash is stored as the name alone; other secrets are left alone" "$rc/$(val $TD)/$(val OTHER_SECRET)" "0/$TEAM_OK/held-OTHER_SECRET"
fresh; have $TD $AU; rc=$(run --apply --aud "$AUD_OK" --team-domain "example.cloudflareaccess.com")
check "values already there are replaced, both in the one request" "$rc/$(writes)/$(val $TD)/$(val $AU)" "0/wrangler secret bulk <file>;/example.cloudflareaccess.com/$AUD_OK"
fresh; have $TD; rc=$(run --apply --team-domain "$TEAM_OK" --aud "$AUD_OK")
check "half a setup is finished by the same command" "$rc/$(last)/$(val $TD)/$(val $AU)/$(said '^Cloudflare Access check: ON\.')" "0/access_check_result=ok/$TEAM_OK/$AUD_OK/1"

echo "One value without the other is never written:"
for half in "--team-domain $TEAM_OK" "--aud $AUD_OK"; do
  fresh; rc=$(run --apply $half)
  check "refused, nothing sent: --apply $(echo "$half" | cut -c1-14)..." "$rc/$(last)/$(writes)/$(held)/$(said 'give both --team-domain and --aud')" "1/access_check_result=stop///1"
  fresh; have $TD; rc=$(run --apply $half)
  check "refused even when the Worker already holds the other one: $(echo "$half" | cut -c1-14)..." "$rc/$(writes)/$(val $TD)" "1//held-$TD"
  fresh; rc=$(run $half)
  check "refused on a look too: $(echo "$half" | cut -c1-14)..." "$rc/$(last)/$(writes)" "1/access_check_result=stop/"
done
fresh; rc=$(run --apply)
check "--apply with nothing to do is refused" "$rc/$(last)/$(writes)" "1/access_check_result=stop/"

echo "Values that are not what they claim are refused before anything is sent:"
for bad in "--aud abc --team-domain $TEAM_OK" "--aud ${AUD_OK}0 --team-domain $TEAM_OK" "--aud $(printf 'G%.0s' $(seq 64)) --team-domain $TEAM_OK" "--aud $AUD_OK --team-domain team.example.com" "--aud $AUD_OK --team-domain $TEAM_OK/path" "--aud $AUD_OK --team-domain http://$TEAM_OK" "--aud $AUD_OK --team-domain $TEAM_OK.evil.example" "--aud $AUD_OK --team-domain https://" "--aud $AUD_OK --team-domain" "--team-domain $TEAM_OK --aud" "--frobnicate" "--off --aud $AUD_OK --team-domain $TEAM_OK" "--off --aud $AUD_OK"; do
  fresh; have OTHER_SECRET; rc=$(run --apply $bad)
  check "refused: $(echo "$bad" | sed "s/$AUD_OK/<tag>/")" "$([ "$rc" != 0 ] && echo stopped || echo RAN)/$(last)/$(writes)/$(held)" "stopped/access_check_result=stop//OTHER_SECRET "
done

echo "An argument it does not know is never printed back whole:"
fresh; rc=$(run --apply --team-domain "$TEAM_OK" "--aud=$AUD_OK")
check "--aud=<tag>: refused, the option is named, the tag is not printed" "$rc/$(last)/$(writes)/$(said "$AUD_OK")/$(said '^ABORT: unknown option --aud=\. ')" "1/access_check_result=stop//0/1"
fresh; rc=$(run --apply --team-domain "$TEAM_OK" "$AUD_OK")
check "the tag with no option in front: refused, and not printed" "$rc/$(last)/$(writes)/$(said "$AUD_OK")/$(said 'an argument this script does not take')" "1/access_check_result=stop//0/1"
fresh; rc=$(run --frobnicate)
check "a plain unknown option is named" "$rc/$(said '^ABORT: unknown option --frobnicate (see --help)\.$')" "1/1"

echo "Turning it off:"
fresh; have $TD $AU OTHER_SECRET; rc=$(run --apply --off)
check "both are removed in ONE request, other secrets stay, and it says the check is off" "$rc/$(last)/$(writes)/$(held)/$(said '^Cloudflare Access check: off\.')" "0/access_check_result=ok/wrangler secret bulk <file>;/OTHER_SECRET /1"
check "that request named both, each to be removed" "$(python3 -c 'import json,sys; print(sorted(json.load(open(sys.argv[1])).items()))' "$T/fake/last-bulk.json")" "[('CF_ACCESS_AUD', None), ('CF_ACCESS_TEAM_DOMAIN', None)]"
fresh; have OTHER_SECRET; rc=$(run --apply --off)
check "with neither set there is nothing to remove, and nothing is sent" "$rc/$(last)/$(writes)/$(said 'nothing to remove')/$(held)" "0/access_check_result=ok//1/OTHER_SECRET "
fresh; have $AU; rc=$(run --apply --off)
check "half a setup is undone: the one that is there is removed, and only it is named" "$rc/$(last)/$(held)/$(python3 -c 'import json,sys; print(sorted(json.load(open(sys.argv[1])).items()))' "$T/fake/last-bulk.json")" "0/access_check_result=ok//[('CF_ACCESS_AUD', None)]"

echo "When the change does not go through:"
fresh; have OTHER_SECRET; rc=$(FAKE_FAIL_BULK=1 run --apply --team-domain "$TEAM_OK" --aud "$AUD_OK")
check "the Worker refuses the request: it stops, says nothing was taken, and leaves no file behind" "$rc/$(last)/$(held)/$(said 'the Worker did not take the change')/$(said 'Cloudflare Access check: ON')/$(left)/$(said "$AUD_OK")/$(said '^Sent to the Worker')" "1/access_check_result=stop/OTHER_SECRET /1/0/0/0/0"
fresh; rc=$(FAKE_BULK_HALF=1 run --apply --team-domain "$TEAM_OK" --aud "$AUD_OK")
check "the Worker took only one of the two: the read-back notices, warns, and does not report success" "$rc/$(last)/$(said '^WARNING: only')/$(said 'Cloudflare Access check: ON')/$(said '^Finish it, or undo it, in one step:$')" "1/access_check_result=stop/1/0/1"
fresh; rc=$(FAKE_NO_LIST_AFTER=1 run --apply --team-domain "$TEAM_OK" --aud "$AUD_OK")
check "the list cannot be read back after the write: it says the change is not confirmed, and does not say ON" "$rc/$(last)/$(said 'not confirmed')/$(said 'Cloudflare Access check: ON')" "1/access_check_result=unconfirmed/1/0"
fresh; rc=$(FAKE_OFFLINE=1 run --apply --team-domain "$TEAM_OK" --aud "$AUD_OK")
check "wrangler not signed in: nothing is sent" "$rc/$(last)/$(writes)/$(left)" "1/access_check_result=stop//0"

echo; echo "$ran checks, $failed failed"
[ "$failed" = 0 ]
