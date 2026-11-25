#!/usr/bin/env bash
# Proves the end-to-end test: breaks the server service one way at a time and
# checks that test-sso-end-to-end.ts fails each time.
#
#   PGLITE_DIR=/path/with/node_modules bash scripts/test-sso-end-to-end-controls.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/fleet-sso-agent.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
caught=0; missed=0; n=0
t() { node --experimental-strip-types --no-warnings "$HERE/test-sso-end-to-end.ts" 2>&1; }

run() {
  n=$((n+1))
  python3 - "$SRC" "$TMP/agent.py" "$2" "$3" <<'PY' || { echo "  SETUP FAILED: $1 (the text to break was not found)"; missed=$((missed+1)); return; }
import sys
s = open(sys.argv[1]).read()
if sys.argv[3] not in s: sys.exit(1)
open(sys.argv[2], "w").write(s.replace(sys.argv[3], sys.argv[4], 1))
PY
  out="$(SSO_AGENT="$TMP/agent.py" t)"
  rc=$?; fails=$(printf '%s\n' "$out" | grep -c '^  FAIL')
  # A crash is not a catch: the test has to run to the end and name a failed check.
  if [ $rc -ne 0 ] && [ "$fails" -gt 0 ] && printf '%s\n' "$out" | tail -1 | grep -q ' checks, '; then caught=$((caught+1)); echo "  caught  $1  ($fails checks failed)"
  elif [ $rc -ne 0 ]; then missed=$((missed+1)); echo "  CRASHED $1  (the test did not finish, so this proves nothing): $(printf '%s\n' "$out" | grep -v '^  ok' | tail -1 | cut -c1-110)"
  else missed=$((missed+1)); echo "  MISSED  $1"; fi
}

echo "Unbroken service first:"
if t > "$TMP/clean.txt"; then echo "  passes  ($(tail -1 "$TMP/clean.txt"))"; else echo "  the unbroken service fails; fix that first"; grep -A3 '^  FAIL' "$TMP/clean.txt" | head -20; exit 1; fi

echo "Broken copies:"
run "any signature is accepted"             'return p.returncode == 0 and b"Verified OK" in p.stdout' 'return True'
run "requests for other servers are run"    'or p["sid"] != conf["SERVER_ID"]' ''
run "a signed request works under any row"  'if p.get("id") != request_id:' 'if False:'
run "any text is taken as a site name"      'if not isinstance(site, str) or not HOST_RE.match(site) or ".." in site:' 'if False:'
run "expired requests are run"              'if exp < now - SKEW:' 'if False:'
run "an hour-long request is accepted"      ' or exp - iat > MAX_REQUEST_LIFE' ''
run "unknown versions are accepted"         'or p.get("v") != 1' ''
run "a request can be used twice"           'if request_id in seen:' 'if False:'
run "frozen sites are signed in to"         'if frozen:' 'if False:'
run "no limit of six a minute"              'if len(recent) >= MAX_PER_MINUTE:' 'if False:'
run "a link to another site is accepted"    'if host == site or host == "www." + site or "www." + host == site:' 'if True:'
run "a plain http link is accepted"         'LINK_RE = re.compile(r"^https://' 'LINK_RE = re.compile(r"^https?://'
run "the link is written to the log"        'sealed = seal(request_id, mint(site))' 'link_for_log = mint(site); log("minted " + link_for_log); sealed = seal(request_id, link_for_log)'
run "the link is sent unsealed"             'return base64.b64encode(p.stdout).decode("ascii")' 'return base64.b64encode((request_id + "\n" + link).encode() * 4).decode("ascii")'
run "settings readable by anyone are used"  'if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):' 'if False:'
# Not in this list on purpose: removing the service's own "switched off" check. The database
# is what withholds requests when one-click sign-in is off (test-sso-schema.mjs proves that);
# the service's check only makes it ask once a minute instead of every ten seconds.
run "the wpadmin id is used unchecked"      'if re.match(r"^[1-9][0-9]{0,9}$", value):' 'if value:'
run "gp is given no time limit"             'timeout=GP_TIMEOUT,' 'timeout=60,'

echo
echo "$n broken copies: $caught caught, $missed missed"
[ "$missed" -eq 0 ]
