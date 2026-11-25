#!/usr/bin/env bash
# sso-staging-probe.remote.sh — answers the questions a Fleet single sign-on build depends on,
# on ONE site, without changing anything.
#
# Runs ON a GridPane server as root:
#   ssh root@<server> 'bash -s -- staging.example.com' < scripts/sso-staging-probe.remote.sh
#   ssh root@<server> 'bash -s -- staging.example.com --hold' < scripts/sso-staging-probe.remote.sh
#   ssh root@<server> 'bash -s -- staging.example.com --trace' < scripts/sso-staging-probe.remote.sh   (reads the access log)
#
# What it does: reads files, and asks WP-CLI for one-use login links with GridPane's own
# `login create` command (the command GridPane's panel runs for its SSO button). Each link is
# a short-lived record on that site; nothing is installed, switched or invalidated. Every link
# it makes is either used up by its own request or left to expire in 2 minutes.
#
# Links are never printed whole, except in --hold mode, which prints ONE link for you to open
# in a browser (see the end). Do not paste a --hold link anywhere.
set -u

SITE="${1:-}"; MODE="${2:-}"
case "$SITE" in
  ""|*[!a-z0-9.-]*|.*|*..*) echo "usage: bash -s -- <site hostname> [--hold | --trace]"; exit 2 ;;
esac
# PROBE_ROOT is for the self-test only (scripts/sso-staging-probe-selftest.sh): it points at a fake site folder.
ROOT="${PROBE_ROOT:-/var/www/$SITE}"
[ -d "$ROOT/htdocs" ] || { echo "no folder $ROOT/htdocs on this server"; exit 2; }
[ -n "${PROBE_ROOT:-}" ] || [ "$(id -u)" = "0" ] || { echo "run as root"; exit 2; }

say()  { printf '\n== %s\n' "$1"; }
# A link with every long token-like part replaced by its length.
mask() { sed -E 's/[A-Za-z0-9_-]{16,}/<&>/g' | perl -pe 's/<([A-Za-z0-9_-]{16,})>/"<".length($1)." chars>"/ge'; }
# Ask for a link. Prints only the link line (the last line that starts with http).
mint() { timeout 40 gp wp "$SITE" login create "$UID_WP" --url-only "$@" 2>&1 | grep -E '^https?://' | tail -1; }
# Open a link once without following the redirect: status code and where it points (masked).
hit()  { curl -s -o /dev/null -m 20 -w '%{http_code} -> %{redirect_url}' "$1" | mask; }

UID_WP=1
if [ -f "$ROOT/logs/wpadmin_id.env" ]; then
  v=$(tr -d '[:space:]' < "$ROOT/logs/wpadmin_id.env")
  case "$v" in ""|*[!0-9]*) echo "wpadmin_id.env is not a plain number; using 1" ;; *) UID_WP="$v" ;; esac
fi

if [ "$MODE" = "--hold" ]; then
  say "One link, good for 5 minutes, for the GridPane test"
  L=$(mint --expires=300)
  [ -n "$L" ] || { echo "no link came back"; exit 1; }
  echo "$L"
  cat <<'TXT'

Now, in this order:
  1. In GridPane, click the SSO (WordPress) button for this site. Confirm it logs you in.
  2. Sign out of WordPress (or use a private window) and open the link above.
  3. Note two things: whether GridPane's button worked, and whether the link worked.
Do not paste the link itself.
TXT
  exit 0
fi

if [ "$MODE" = "--trace" ]; then
  # Read-only: what this site's access log saw of one-use login links, so a link that
  # "expired or was already used" can be explained (who opened it first, and when).
  say "Login-link, wp-admin and wp-login requests in the access log (oldest first, tokens masked)"
  found=0
  for f in "${PROBE_LOG:-/var/log/nginx/$SITE.access.log}" "$ROOT/logs/access.log" "$ROOT/logs/$SITE.access.log"; do
    [ -r "$f" ] || continue
    found=1; echo "log: $f    server time now: $(date -u '+%d/%b/%Y:%H:%M:%S') UTC"
    tail -n 20000 "$f" \
      | grep -E '"(GET|POST|HEAD) (/[0-9a-f]{8}/[A-Za-z0-9_-]{16,}|/wp-login\.php|/wp-admin/( |\?))' \
      | tail -n 40 | sed -E 's/\?[^ "]*/?…/g; s/([0-9]+\.[0-9]+)\.[0-9]+\.[0-9]+/\1.x.x/g' | mask | cut -c1-240
  done
  if [ "$found" = 0 ]; then
    echo "no access log found. Files that might be it:"
    ls /var/log/nginx 2>/dev/null | grep -F "$SITE" | head -5
    ls "$ROOT/logs" 2>/dev/null | head -20
  fi
  exit 0
fi

say "Site, server, tools"
echo "site: $SITE    wordpress user id used: $UID_WP    $(lsb_release -ds 2>/dev/null)"
echo "openssl: $(openssl version 2>/dev/null)    python3: $(python3 --version 2>&1)"

say "Does the command have the options Fleet needs?"
H=$(timeout 40 gp wp "$SITE" help login create 2>&1)
for opt in url-only expires; do
  if printf '%s' "$H" | grep -q -- "--$opt"; then echo "--$opt: yes"; else echo "--$opt: NOT FOUND"; fi
done
printf '%s\n' "$H" | grep -ci 'login' | sed 's/^/help lines mentioning login: /'

say "Which Unix user does WordPress run as under gp wp?"
timeout 40 gp wp "$SITE" eval 'echo posix_getpwuid(posix_geteuid())["name"] . "\n";' 2>&1 | grep . | tail -1

say "Files GridPane keeps for SSO"
ls -l "$ROOT/logs/wpadmin_id.env" 2>&1 | awk '{print $1, $3, $4, $NF}'
echo "settings files that mention sso (names and matching keys only):"
grep -il 'sso' "$ROOT"/logs/*.env 2>/dev/null | while read -r f; do echo "  $f: $(grep -io '^[a-z_-]*sso[a-z_-]*' "$f" | tr '\n' ' ')"; done
echo "must-use plugins:"; ls -1 "$ROOT/htdocs/wp-content/mu-plugins/" 2>/dev/null | sed 's/^/  /'

say "How long does one link take, and what does it look like?"
T0=$(date +%s.%N); L1=$(mint --expires=120); T1=$(date +%s.%N)
if [ -z "$L1" ]; then
  echo "NO LINK CAME BACK. Raw answer (first lines):"; timeout 40 gp wp "$SITE" login create "$UID_WP" --url-only 2>&1 | head -5 | mask
  echo; echo "Stopping here: the rest needs a link."; exit 1
fi
printf 'seconds: %.1f\n' "$(echo "$T1 - $T0" | bc)"
echo "shape: $(printf '%s' "$L1" | mask)"
echo "host matches the site: $([ "$(printf '%s' "$L1" | awk -F/ '{print $3}' | sed 's/^www\.//')" = "${SITE#www.}" ] && echo yes || echo "NO: $(printf '%s' "$L1" | awk -F/ '{print $3}')")"

say "Do two links work side by side? (a second link must not cancel the first)"
G7=$(wc -l < "$ROOT/logs/7g.log" 2>/dev/null || echo 0)
L2=$(mint --expires=120)
echo "first link:  $(hit "$L1")"
echo "second link: $(hit "$L2")"
echo "(302 to wp-admin on both = they live side by side. 403 = a firewall stopped the request. Anything else = read it.)"

say "Is a used link dead?"
echo "first link again: $(hit "$L1")"

say "Does a link expire?"
L3=$(mint --expires=5); sleep "${PROBE_WAIT:-10}"
echo "5-second link, opened after 10: $(hit "$L3")"

say "Did the 7G firewall log anything during these requests?"
G7b=$(wc -l < "$ROOT/logs/7g.log" 2>/dev/null || echo 0)
echo "new 7g.log lines: $((G7b - G7))"
[ "$G7b" -gt "$G7" ] && tail -n "$((G7b - G7))" "$ROOT/logs/7g.log" | mask | cut -c1-220

say "Done"
echo "Nothing was installed or changed. Everything above is safe to share with whoever is helping you; it holds no working link."
echo "These requests came from the server itself, so a Cloudflare rule that only stops browsers or only stops servers may answer differently for you. The --hold run checks a real browser."
