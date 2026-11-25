#!/usr/bin/env bash
# Self-test for sso-staging-probe.remote.sh: runs it against a fake site folder with fake `gp`
# and `curl`, and proves (1) no login token ever reaches the output, (2) it reports side-by-side
# links, a dead used link and an expired link correctly, (3) it stops when no link comes back.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/site/htdocs/wp-content/mu-plugins" "$T/site/logs" "$T/state"
echo 7 > "$T/site/logs/wpadmin_id.env"; : > "$T/site/logs/7g.log"; touch "$T/site/htdocs/wp-content/mu-plugins/wp-cli-login-server.php"
cat > "$T/bin/timeout" <<'S'
#!/usr/bin/env bash
shift; exec "$@"
S
cat > "$T/bin/lsb_release" <<'S'
#!/usr/bin/env bash
echo "Fake Linux"
S
# Fake gp: `help` lists the options; `eval` names a user; `login create` prints a link whose
# token is recorded with its expiry so the fake curl can judge it.
cat > "$T/bin/gp" <<S
#!/usr/bin/env bash
[ -n "\${FAKE_NO_LINK:-}" ] && [ "\$4" = "create" ] && { echo "Error: This site is not ready for magic links."; exit 1; }
case "\$3 \$4" in
  "help login") echo "wp login create <user> [--expires=<seconds>] [--url-only]";;
  "eval "*) echo "site_user";;
  "login create")
    tok="TOKENsecret\$(date +%s)\$RANDOM\$RANDOM"; exp=120
    for a in "\$@"; do case "\$a" in --expires=*) exp=\${a#--expires=};; esac; done
    echo "\$(( \$(date +%s) + exp ))" > "$T/state/\$tok"
    echo "Success: link made"; echo "https://\$2/abc123/\$tok";;
esac
S
cat > "$T/bin/curl" <<S
#!/usr/bin/env bash
url="\${@: -1}"; tok="\${url##*/}"; f="$T/state/\$tok"
if [ -f "\$f" ] && [ "\$(date +%s)" -le "\$(cat "\$f")" ]; then rm -f "\$f"; printf '302 -> https://staging.example.com/wp-admin/'; else printf '404 -> '; fi
S
chmod +x "$T/bin/"*
fail=0; ok() { echo "pass  $1"; }; bad() { echo "FAIL  $1"; fail=1; }

OUT=$(PATH="$T/bin:$PATH" PROBE_ROOT="$T/site" PROBE_WAIT=7 bash "$HERE/sso-staging-probe.remote.sh" staging.example.com 2>&1); RC=$?
echo "$OUT" | grep -q 'TOKENsecret' && bad "a login token reached the output" || ok "no login token in the output ($(echo "$OUT" | grep -c 'chars>') masked places)"
echo "$OUT" | grep -q 'wordpress user id used: 7' && ok "reads the user id from wpadmin_id.env" || bad "user id not read"
echo "$OUT" | grep -q -- '--url-only: yes' && echo "$OUT" | grep -q -- '--expires: yes' && ok "finds both options" || bad "options not found"
[ "$(echo "$OUT" | grep -c '^\(first\|second\) link: *302')" = "2" ] && ok "two links side by side both answer 302" || bad "side-by-side links misreported"
echo "$OUT" | grep -q '^first link again: 404' && ok "a used link is reported dead" || bad "used link not reported dead"
echo "$OUT" | grep -q 'opened after 10: 404' && ok "an expired link is reported dead" || bad "expired link not reported dead"
[ "$RC" = "0" ] && ok "exits 0 on a full run" || bad "exit $RC on a full run"

OUT2=$(PATH="$T/bin:$PATH" PROBE_ROOT="$T/site" FAKE_NO_LINK=1 bash "$HERE/sso-staging-probe.remote.sh" staging.example.com 2>&1); RC2=$?
echo "$OUT2" | grep -q 'NO LINK CAME BACK' && [ "$RC2" = "1" ] && ok "stops with exit 1 when no link comes back" || bad "did not stop when no link came back (exit $RC2)"
bash "$HERE/sso-staging-probe.remote.sh" 'bad;name' >/dev/null 2>&1; [ "$?" = "2" ] && ok "refuses a hostname with odd characters" || bad "accepted a bad hostname"
PATH="$T/bin:$PATH" PROBE_ROOT="$T/nowhere" bash "$HERE/sso-staging-probe.remote.sh" staging.example.com >/dev/null 2>&1; [ "$?" = "2" ] && ok "refuses a site with no folder" || bad "ran without a site folder"

HOLD=$(PATH="$T/bin:$PATH" PROBE_ROOT="$T/site" bash "$HERE/sso-staging-probe.remote.sh" staging.example.com --hold 2>&1)
[ "$(echo "$HOLD" | grep -c '^https://')" = "1" ] && ok "--hold prints exactly one link" || bad "--hold printed $(echo "$HOLD" | grep -c '^https://') links"
echo "$HOLD" | grep -q 'TOKENsecret' && ok "control: the token check sees a token when one is printed (--hold)" || bad "the token check cannot see a token"

# --trace: reads an access log, shows the login-link and login-page requests, never a token.
cat > "$T/access.log" <<'LOG'
203.0.113.77 - - [20/Nov/2026:01:06:10 +0000] "GET /9c195f0a/TOKENsecretTOKENsecret12 HTTP/2.0" 302 0 "-" "Mozilla/5.0 (Macintosh) Safari/605.1.15"
203.0.113.77 - - [20/Nov/2026:01:06:11 +0000] "GET /wp-admin/ HTTP/2.0" 200 5120 "-" "Mozilla/5.0 (Macintosh) Safari/605.1.15"
203.0.113.77 - - [20/Nov/2026:01:06:12 +0000] "GET /wp-content/themes/x/style.css HTTP/2.0" 200 900 "-" "Mozilla/5.0"
203.0.113.78 - - [20/Nov/2026:01:06:15 +0000] "GET /9c195f0a/TOKENsecretTOKENsecret12 HTTP/2.0" 410 300 "-" "Mozilla/5.0 Chrome/140.0"
203.0.113.78 - - [20/Nov/2026:01:06:25 +0000] "GET /wp-login.php?redirect_to=https%3A%2F%2Fstaging.example.com%2F HTTP/2.0" 200 4000 "-" "Mozilla/5.0 Chrome/140.0"
LOG
TRACE=$(PATH="$T/bin:$PATH" PROBE_ROOT="$T/site" PROBE_LOG="$T/access.log" bash "$HERE/sso-staging-probe.remote.sh" staging.example.com --trace 2>&1)
[ "$(echo "$TRACE" | grep -c '"GET ')" = "4" ] && ok "--trace shows the four login-related requests and skips the stylesheet" || bad "--trace showed $(echo "$TRACE" | grep -c '"GET ') requests, wanted 4"
echo "$TRACE" | grep -q 'TOKENsecret' && bad "--trace printed a login token" || ok "--trace prints no login token"
echo "$TRACE" | grep -q '/9c195f0a/<24 chars> HTTP/2.0" 410' && ok "--trace keeps the status code beside the masked link" || bad "--trace lost the status code or the link shape"
echo "$TRACE" | grep -q 'redirect_to' && bad "--trace printed a query string" || ok "--trace drops query strings"
echo "$TRACE" | grep -q '203\.0\.113\.7' && bad "--trace printed a full address" || ok "--trace shortens addresses"
grep -q 'TOKENsecret' "$T/access.log" && ok "control: the fake log does hold a token for --trace to hide" || bad "the fake log holds no token"
TRACE2=$(PATH="$T/bin:$PATH" PROBE_ROOT="$T/site" PROBE_LOG="$T/nope.log" bash "$HERE/sso-staging-probe.remote.sh" staging.example.com --trace 2>&1)
echo "$TRACE2" | grep -q 'no access log found' && ok "--trace says so when there is no log" || bad "--trace was silent about a missing log"
[ "$fail" = "0" ] && echo "all passed" || echo "FAILURES"
exit "$fail"
