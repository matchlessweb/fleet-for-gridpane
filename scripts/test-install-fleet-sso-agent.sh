#!/usr/bin/env bash
# Self-test for install-fleet-sso-agent.sh. Touches no server and no database:
# ssh, curl, systemctl and journalctl are stand-ins on PATH, "the server" is a
# temporary folder, and the service is a stub whose --check passes or fails on
# request.   bash scripts/test-install-fleet-sso-agent.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAKE="$T/server"; LOG="$T/calls.log"
mkdir -p "$T/bin" "$T/keys" "$FAKE/usr/bin" "$FAKE/usr/local/bin" "$T/home"
ran=0; failed=0
check() { ran=$((ran+1)); if [ "$2" = "$3" ]; then echo "  ok   $1"; else failed=$((failed+1)); echo "  FAIL $1"; echo "       got  $2"; echo "       want $3"; fi; }
has() { if grep -qE -- "$2" "$1" 2>/dev/null; then echo yes; else echo no; fi; }

# ---- stand-ins ------------------------------------------------------------------
cat > "$T/bin/ssh" <<STUB
#!/bin/bash
printf 'ssh %s\n' "\$*" >> "$LOG"
[ -e "$T/ssh-down" ] && { echo "ssh: connect to host x port 22: Connection refused" >&2; exit 255; }
SSO_INSTALL_ROOT="$FAKE" bash -s
STUB
cat > "$T/bin/curl" <<STUB
#!/bin/bash
cfg=\$(cat)
method=GET; url=""; data=""
while [ \$# -gt 0 ]; do case "\$1" in -X) method="\$2"; shift ;; --data) data="\$2"; shift ;; -H|--max-time|-w|-K) shift ;; https://*) url="\$1" ;; esac; shift; done
path="\${url#*/rest/v1/}"
printf 'curl %s %s key-on-stdin=%s\n' "\$method" "\$path" "\$(printf '%s' "\$cfg" | grep -c 'apikey: service-role-key-for-the-test')" >> "$LOG"
case "\$method \$path" in
  "GET servers"*)            printf '%s\n200' '[{"id":101,"ip":"203.0.113.11","label":"web1"},{"id":102,"ip":"203.0.113.12","label":"web2"}]' ;;
  "GET sso_state"*)          if [ -e "$T/no-schema" ]; then printf '{"message":"not found"}\n404'; else printf '[{"enabled":false}]\n200'; fi ;;
  "GET sso_agent_secrets"*)  printf '[]\n200' ;;
  "POST sso_agent_secrets")  if [ -e "$T/db-down" ]; then printf '\n503'; else printf '%s' "\$data" > "$T/posted.json"; printf '\n201'; fi ;;
  "DELETE sso_agent_secrets"*) printf '\n204' ;;
  *) printf '\n400' ;;
esac
STUB
cat > "$T/bin/systemctl" <<STUB
#!/bin/bash
printf 'systemctl %s\n' "\$*" >> "$LOG"
case "\$1" in
  is-active)  cat "$T/active" 2>/dev/null || echo inactive ;;
  is-enabled) cat "$T/enabled" 2>/dev/null || echo disabled ;;
  restart)    echo active > "$T/active" ;;
  enable)     echo enabled > "$T/enabled" ;;
  disable)    echo inactive > "$T/active"; echo disabled > "$T/enabled" ;;
esac
exit 0
STUB
printf '#!/bin/bash\nexit 0\n' > "$T/bin/journalctl"
printf '#!/bin/bash\nexit 0\n' > "$T/bin/sleep"
printf '#!/bin/bash\nexit 1\n' > "$T/bin/ssh-add"
command -v sha256sum >/dev/null || printf '#!/bin/bash\nshasum -a 256 "$@"\n' > "$T/bin/sha256sum"
printf '#!/bin/bash\necho "OpenSSL 3.0.2 stand-in"\n' > "$FAKE/usr/bin/openssl"
printf '#!/bin/bash\nexit 0\n' > "$FAKE/usr/local/bin/gp"
chmod +x "$T/bin/"* "$FAKE/usr/bin/openssl" "$FAKE/usr/local/bin/gp"

printf 'import sys\nprint("  ok   stand-in check")\nprint("check_result=ok")\nsys.exit(0)\n' > "$T/agent-ok.py"
printf 'import sys\nprint("  FAIL Fleet\\x27s database accepts this server\\x27s token")\nprint("check_result=stop")\nsys.exit(1)\n' > "$T/agent-bad.py"
printf 'def (:\n' > "$T/agent-broken.py"
printf -- '-----BEGIN PUBLIC KEY-----\nc2lnbg==\n-----END PUBLIC KEY-----\n' > "$T/keys/sign-pub.pem"
printf -- '-----BEGIN PUBLIC KEY-----\nYm94\n-----END PUBLIC KEY-----\n' > "$T/keys/box-pub.pem"
cat > "$T/env" <<'ENVFILE'
NEXT_PUBLIC_SUPABASE_URL=https://db.example.com
NEXT_PUBLIC_SUPABASE_ANON_KEY="anon-key-for-the-test-only"
SUPABASE_SERVICE_ROLE_KEY=service-role-key-for-the-test
ENVFILE

# Standard input is closed, as it is when nobody is at the keyboard: a stand-in must never sit waiting on it.
installer() { PATH="$T/bin:$PATH" HOME="$T/home" FLEET_ENV_FILE="$T/env" FLEET_SSO_KEY_DIR="$T/keys" SSO_AGENT_FILE="${AGENT:-$T/agent-ok.py}" bash "$HERE/install-fleet-sso-agent.sh" "$@" < /dev/null; }
reset() { : > "$LOG"; rm -f "$T/posted.json" "$T/out.txt"; }
D="$FAKE/etc/fleet-sso"; BIN="$FAKE/usr/local/sbin/fleet-sso-agent"; UNIT="$FAKE/etc/systemd/system/fleet-sso-agent.service"
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }
token_on_server() { sed -n 's/^AGENT_TOKEN=//p' "$D/agent.conf" 2>/dev/null; }

echo "Audit (no arguments):"
reset; installer > "$T/out.txt" 2>&1; rc=$?
check "exits 0" "$rc" "0"
check "looks at both servers" "$(grep -c '^ssh ' "$LOG")" "2"
check "writes nothing to the database" "$(grep -cE '^curl (POST|DELETE|PATCH)' "$LOG")" "0"
check "leaves the server folder empty" "$(find "$FAKE/etc" -type f 2>/dev/null | wc -l | tr -d ' ')" "0"
check "says nothing is installed" "$(grep -c 'installed=no' "$T/out.txt")" "2"
check "the database key went to curl on its standard input every time" "$(grep -c '^curl ' "$LOG")/$(grep -c 'key-on-stdin=1' "$LOG")" "3/3"

echo "Refusals before anything is touched:"
reset; installer --apply nosuch > "$T/out.txt" 2>&1; rc=$?
check "a server Fleet does not know: refused, no ssh, no write" "$rc/$(grep -c '^ssh ' "$LOG")/$(grep -cE '^curl POST' "$LOG")" "2/0/0"
reset; installer --apply > "$T/out.txt" 2>&1; check "--apply with no server: refused" "$?/$(grep -c '^ssh\|^curl' "$LOG")" "2/0"
reset; installer --apply web1 web2 > "$T/out.txt" 2>&1; check "two servers at once: refused" "$?/$(grep -c '^ssh\|^curl' "$LOG")" "2/0"
reset; touch "$T/no-schema"; installer --apply web1 > "$T/out.txt" 2>&1; rc=$?; rm -f "$T/no-schema"
check "sign-in tables not in the database yet: stops, no ssh, no write" "$rc/$(grep -c '^ssh ' "$LOG")/$(grep -cE '^curl POST' "$LOG")/$(has "$T/out.txt" 'apply-sql.sh sso_schema.sql')" "1/0/0/yes"
reset; mv "$T/keys/box-pub.pem" "$T/keys/box.away"; installer --apply web1 > "$T/out.txt" 2>&1; rc=$?; mv "$T/keys/box.away" "$T/keys/box-pub.pem"
check "a public key missing: stops, no ssh, no write" "$rc/$(grep -c '^ssh ' "$LOG")/$(grep -cE '^curl POST' "$LOG")/$(has "$T/out.txt" 'sso-make-keys.sh')" "1/0/0/yes"
reset; AGENT="$T/agent-broken.py" installer --apply web1 > "$T/out.txt" 2>&1
check "a service file that does not parse: stops, no ssh, no write" "$?/$(grep -c '^ssh ' "$LOG")/$(grep -cE '^curl POST' "$LOG")" "1/0/0"
reset; touch "$T/db-down"; installer --apply web1 > "$T/out.txt" 2>&1; rc=$?; rm -f "$T/db-down"
check "the token hash cannot be registered: the server is not touched" "$rc/$(grep -c '^ssh ' "$LOG")/$(has "$T/out.txt" 'the server was not touched')" "1/0/yes"

echo "Install on one server:"
reset; installer --apply web1 > "$T/out.txt" 2>&1; rc=$?
check "exits 0 and says it is running" "$rc/$(has "$T/out.txt" 'installed and running')" "0/yes"
check "only web1 was contacted" "$(grep '^ssh ' "$LOG" | grep -c '203.0.113.11')/$(grep '^ssh ' "$LOG" | grep -c '203.0.113.12')" "1/0"
check "the hash was registered before the server was contacted" "$(grep -nE '^curl POST sso_agent_secrets|^ssh ' "$LOG" | head -2 | cut -d: -f2 | cut -d' ' -f1 | tr '\n' ' ')" "curl ssh "
TOK="$(token_on_server)"
check "the server holds a 64-character token" "${#TOK}" "64"
check "and its SHA-256 is what was registered, for the right server" "$(cat "$T/posted.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["server_id"], d["token_hash"])')" "101 $(printf '%s' "$TOK" | shasum -a 256 | cut -d' ' -f1)"
check "the token itself was not sent to the database" "$(has "$T/posted.json" "$TOK")" "no"
check "the token is on no command line (ssh or curl)" "$(has "$LOG" "$TOK")" "no"
check "the token is not in anything the installer printed" "$(has "$T/out.txt" "$TOK")" "no"
check "control: its fingerprint is printed, so the two ends can be compared" "$(has "$T/out.txt" "token_fp=$(printf '%s' "$TOK" | shasum -a 256 | cut -c1-8)")" "yes"
check "settings file: root only" "$(mode_of "$D/agent.conf")/$(mode_of "$D")" "600/700"
check "settings name the server and the database" "$(grep -c -E '^(SERVER_ID=101|SUPABASE_URL=https://db.example.com|SUPABASE_ANON_KEY=anon-key-for-the-test-only)$' "$D/agent.conf")" "3"
check "the service file and both keys arrived byte for byte" "$(cmp -s "$BIN" "$T/agent-ok.py" && cmp -s "$D/sign-pub.pem" "$T/keys/sign-pub.pem" && cmp -s "$D/box-pub.pem" "$T/keys/box-pub.pem" && echo same)" "same"
check "the systemd unit runs it and restarts it" "$(grep -c -E '^(ExecStart=/usr/bin/env python3 /usr/local/sbin/fleet-sso-agent|Restart=always)$' "$UNIT")" "2"
check "the unit's Documentation line is the config's repository address" "$(sed -n 's/^Documentation=//p' "$UNIT")" "$(bash -c ". '$HERE/lib-fleet-names.sh'; fleet_repo_url")"
check "the check ran before the service was started" "$(has "$T/out.txt" 'stand-in check')/$(grep -c '^systemctl restart fleet-sso-agent' "$LOG")/$(grep -c '^systemctl enable fleet-sso-agent' "$LOG")" "yes/1/1"
check "no work folder left behind" "$(find "$D" -name '.new.*' | wc -l | tr -d ' ')" "0"

echo "Install again (how a token is rotated):"
reset; installer --apply 203.0.113.11 > "$T/out.txt" 2>&1; rc=$?
TOK2="$(token_on_server)"
check "by address works too, and the token is a new one" "$rc/$([ "$TOK2" != "$TOK" ] && [ ${#TOK2} = 64 ] && echo new)" "0/new"
check "the new hash replaced the old in the database" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token_hash"])' "$T/posted.json")" "$(printf '%s' "$TOK2" | shasum -a 256 | cut -d' ' -f1)"

echo "When the service's own check fails:"
reset; AGENT="$T/agent-bad.py" installer --apply web1 > "$T/out.txt" 2>&1; rc=$?
check "exits 1 and says it is not running" "$rc/$(has "$T/out.txt" 'NOT RUNNING on web1')" "1/yes"
check "the service was stopped, not started" "$(grep -c '^systemctl disable --now fleet-sso-agent' "$LOG")/$(grep -c '^systemctl restart' "$LOG")/$(cat "$T/active")" "1/0/inactive"

echo "When the server cannot be reached:"
reset; touch "$T/ssh-down"; installer --apply web1 > "$T/out.txt" 2>&1; rc=$?; rm -f "$T/ssh-down"
check "exits 1 and says to run it again" "$rc/$(has "$T/out.txt" 'Run --apply again')" "1/yes"

echo "Remove:"
installer --apply web1 > /dev/null 2>&1
reset; installer --remove web1 > "$T/out.txt" 2>&1; rc=$?
check "exits 0" "$rc" "0"
check "every file is gone from the server" "$( [ -e "$BIN" ] || [ -e "$UNIT" ] || [ -e "$D" ] && echo left || echo gone)" "gone"
check "the service was stopped and its token row deleted, in that order" "$(grep -nE '^systemctl disable --now|^curl DELETE sso_agent_secrets\?server_id=eq\.101' "$LOG" | cut -d: -f2 | cut -d' ' -f1 | tr '\n' ' ')" "systemctl curl "
check "control: gp and openssl on the server were left alone" "$([ -x "$FAKE/usr/local/bin/gp" ] && [ -x "$FAKE/usr/bin/openssl" ] && echo there)" "there"
reset; installer --remove web1 > "$T/out.txt" 2>&1
check "removing twice is harmless" "$?/$(has "$T/out.txt" 'removed=yes')" "0/yes"

echo
echo "$ran checks, $failed failed"
[ "$failed" -eq 0 ]
