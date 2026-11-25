#!/usr/bin/env bash
# Proves the proof: breaks sso_schema.sql in one way at a time and checks that
# test-sso-schema.mjs fails each time. A proof that passes a broken file is blind.
#
#   PGLITE_DIR=/path/with/node_modules bash scripts/test-sso-schema-controls.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../sso_schema.sql"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
caught=0; missed=0; n=0

# name | python expression that turns the file's text (s) into a broken copy
run() {
  n=$((n+1))
  python3 - "$SRC" "$TMP/broken.sql" "$2" <<'PY' || { echo "  SETUP FAILED: $1 (the line to break was not found)"; missed=$((missed+1)); return; }
import sys
s = open(sys.argv[1]).read()
t = eval(sys.argv[3], {"s": s})
if t == s: sys.exit(1)
open(sys.argv[2], "w").write(t)
PY
  out="$(SSO_SQL="$TMP/broken.sql" node "$HERE/test-sso-schema.mjs" 2>&1)"
  rc=$?; fails=$(printf '%s\n' "$out" | grep -c '^  FAIL')
  # A crash is not a catch: the proof has to run to the end and name a failed check.
  if [ $rc -ne 0 ] && [ "$fails" -gt 0 ] && printf '%s\n' "$out" | tail -1 | grep -q ' checks, '; then
    caught=$((caught+1)); echo "  caught  $1  ($fails checks failed)"
  elif [ $rc -ne 0 ]; then
    missed=$((missed+1)); echo "  CRASHED $1  (the proof did not finish, so this proves nothing): $(printf '%s\n' "$out" | grep -v '^  ok' | tail -1 | cut -c1-110)"
  else
    missed=$((missed+1)); echo "  MISSED  $1"
  fi
}

echo "Unbroken file first:"
if node "$HERE/test-sso-schema.mjs" > "$TMP/clean.txt" 2>&1; then echo "  passes  ($(tail -1 "$TMP/clean.txt"))"; else echo "  the unbroken file fails; fix that first"; tail -5 "$TMP/clean.txt"; exit 1; fi

echo "Broken copies:"
run "browsers may read the tables"            "s.replace('revoke all on public.sso_state, public.sso_site_policy', '-- revoke all on public.sso_state, public.sso_site_policy', 1).replace('    from public, anon, authenticated;', '--', 1)"
run "anyone may take a link"                  "s.replace('revoke all on function public.sso_request_take(uuid, uuid) from public, anon, authenticated;', '')"
run "anyone may create a request"             "s.replace('revoke all on function public.sso_request_create(uuid, uuid, bigint, text, text, text, text, text, integer) from public, anon, authenticated;', '')"
run "a signed-in browser may collect requests" "s.replace('grant execute on function public.sso_agent_poll(bigint, text) to anon;', 'grant execute on function public.sso_agent_poll(bigint, text) to anon, authenticated;')"
run "any token is accepted"                   "s.replace(\"and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')\", '')"
run "a link is not erased when taken"         "s.replace(\"set status = 'consumed', sealed_link = null, consumed_at = now()\", \"set status = 'consumed', consumed_at = now()\")"
run "anyone signed in may take another person's link" "s.replace('where id = p_request_id and requested_by = p_user', 'where id = p_request_id')"
run "no five-minute limit"                    "s.replace(\"created_at > now() - interval '5 minutes') >= 10\", \"created_at > now() - interval '5 minutes') >= 100000\")"
run "no daily limit"                          "s.replace(\"created_at > now() - interval '1 day') >= 60\", \"created_at > now() - interval '1 day') >= 100000\")"
run "a server collects other servers' requests" "s.replace(\"where server_id = p_server_id and status = 'pending' and expires_at > now()\", \"where status = 'pending' and expires_at > now()\")"
run "a server completes other servers' requests" "s.replace(\"where id = p_request_id and server_id = p_server_id and status = 'claimed' and expires_at > now()\", \"where id = p_request_id and status = 'claimed' and expires_at > now()\")"
run "a late answer is accepted"               "s.replace(\"and server_id = p_server_id and status = 'claimed' and expires_at > now()\", \"and server_id = p_server_id and status = 'claimed'\")"
run "an old unopened link is still handed over" "s.replace(\"v_row.completed_at < now() - interval '45 seconds'\", \"v_row.completed_at < now() - interval '90 days'\")"
run "a link is refused the moment it is ready" "s.replace(\"v_row.completed_at < now() - interval '45 seconds'\", \"v_row.completed_at < now() - interval '1 second'\")"
run "any site name can be turned on"          "s.replace(\"if p_enabled and not exists (\", \"if false and not exists (\")"
run "a site on another server counts"         "s.replace(\"where s.server_id = p_server_id and (s.url = p_hostname\", \"where (s.url = p_hostname\")"
run "browsers may turn sites on"              "s.replace('revoke all on function public.sso_policy_set(uuid, text, text, text, bigint, text, boolean) from public, anon, authenticated;', '')"
run "browsers may move the master switch"     "s.replace('revoke all on function public.sso_switch_set(uuid, text, text, text, boolean) from public, anon, authenticated;', '')"
run "browsers may read which sites are on"    "s.replace('revoke all on function public.sso_state_read() from public, anon, authenticated;', '')"
run "site changes are not written down"       "s.replace(\"insert into public.sso_audit (event, user_id, user_email, access_email, ip, server_id, hostname, detail)\n    values ('policy', p_user, p_user_email, p_access_email, p_ip, p_server_id, p_hostname, case when p_enabled then 'on' else 'off' end);\", '')"
run "switch changes are not written down"     "s.replace(\"insert into public.sso_audit (event, user_id, user_email, access_email, ip, detail)\n    values ('switch', p_user, p_user_email, p_access_email, p_ip, case when p_enabled then 'on' else 'off' end);\", '')"
run "the site name is not returned with the link" "s.replace(\", 'hostname', v_row.hostname);\", \");\")"
run "old requests are never cleared"          "s.replace(\"delete from public.sso_requests where created_at < now() - interval '2 days';\", '')"
run "old record lines are never cleared"      "s.replace(\"delete from public.sso_audit    where at         < now() - interval '1 year';\", '')"
run "arming works while switched off"         "s.replace(\"set armed_until = now() + interval '10 minutes' where id = 1 and enabled\", \"set armed_until = now() + interval '10 minutes' where id = 1\")"

echo
echo "$n broken copies: $caught caught, $missed missed"
[ "$missed" -eq 0 ]
