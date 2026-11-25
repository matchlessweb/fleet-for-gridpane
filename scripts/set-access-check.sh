#!/usr/bin/env bash
# set-access-check.sh — turn the app's own Cloudflare Access check on or off, in one step.
#
#   bash scripts/set-access-check.sh                  look only: what the Worker holds and what that means
#   bash scripts/set-access-check.sh --team-domain <team>.cloudflareaccess.com --aud <64 hex>
#                                                     look only: checks the two values, says what --apply would do
#   bash scripts/set-access-check.sh --apply --team-domain <team>.cloudflareaccess.com --aud <64 hex>
#                                                     turn the check ON
#   bash scripts/set-access-check.sh --apply --off    turn it OFF: remove both settings
#
# The app reads two Worker secrets, CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (lib/access-gate.ts):
#   both set      every request must carry a token Cloudflare Access signed for this application
#   neither set   the app does not check; it trusts that Access is in front of it
#   only one set  the app refuses EVERY request (503), the login page included
# So the two are never written one at a time. This script sends both in ONE
# request (wrangler secret bulk), then reads the Worker's list back and says
# which of the three states it is in. It never accepts one value without the other.
#
# Before you turn it on: the Access application must cover the app's whole
# hostname, with no policy that lets a path through without a sign-in (a Bypass
# policy): a request Access passes without a token is one the app will refuse.
# After: open the app. It should load as before, and every answer carries the
# header x-fleet-access-check: on. If it does not load: --apply --off.
#
# The team address may be pasted as https://<team>.cloudflareaccess.com/ ; the
# name alone is stored. The audience tag is never printed, only its length.
# Nothing on this machine is changed. The two values pass through a private
# temporary file that is deleted.
#
# Needs: wrangler signed in to the account that owns the Worker (npx wrangler
# login, or CLOUDFLARE_API_TOKEN). The last line is always
# access_check_result=look|ok|unconfirmed|stop.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."

stop() { echo "ABORT: $1"; echo "access_check_result=stop"; exit 1; }

APPLY=0; OFF=0; TEAM=""; AUD=""; TEAM_GIVEN=0; AUD_GIVEN=0
needs_value() { [ $# -ge 2 ] && [ -n "$2" ] || stop "$1 needs a value (see --help)."; }
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --off) OFF=1 ;;
    --team-domain) needs_value "$@"; TEAM="$2"; TEAM_GIVEN=1; shift ;;
    --aud) needs_value "$@"; AUD="$2"; AUD_GIVEN=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    # An argument is never echoed whole: "--aud=<the tag>" or a stray value would print the tag.
    *) if [[ "$1" =~ ^--[a-z-]+$ ]]; then stop "unknown option $1 (see --help)."; fi
       if [[ "$1" =~ ^(--[a-z-]+)= ]]; then stop "unknown option ${BASH_REMATCH[1]}=. A value follows its option after a space, not an equals sign (see --help)."; fi
       stop "an argument this script does not take (not shown here, in case it is the tag). Each value follows its option: --team-domain <address> --aud <tag>." ;;
  esac
  shift
done

# The address as the app reads it (lib/sso/access-jwt.ts): lowercase, no https:// in front, no / at the end.
if [ "$TEAM_GIVEN" = 1 ]; then
  TEAM="$(printf '%s' "$TEAM" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https://##; s#/+$##')"
  [[ "$TEAM" =~ ^[a-z0-9-]+\.cloudflareaccess\.com$ ]] || stop "--team-domain looks like yourteam.cloudflareaccess.com (https:// in front is fine; a path after it is not)."
fi
if [ "$AUD_GIVEN" = 1 ]; then
  [[ "$AUD" =~ ^[0-9a-f]{64}$ ]] || stop "--aud is the Access application's audience tag: 64 hex characters (Access, Applications, your application, Overview)."
fi
if [ "$OFF" = 1 ] && [ "$TEAM_GIVEN$AUD_GIVEN" != "00" ]; then stop "--off removes both settings; it takes no --team-domain or --aud."; fi
if [ "$OFF" = 0 ] && [ "$TEAM_GIVEN" != "$AUD_GIVEN" ]; then
  stop "give both --team-domain and --aud, or neither. With only one of the two on the Worker the app refuses every request (503), the login page included."
fi
if [ "$APPLY" = 1 ] && [ "$OFF" = 0 ] && [ "$TEAM_GIVEN" = 0 ]; then
  stop "--apply needs what to do: --team-domain <team>.cloudflareaccess.com --aud <64 hex> to turn the check on, or --off to turn it off."
fi
WANT="look"; [ "$TEAM_GIVEN" = 0 ] || WANT="on"; [ "$OFF" = 0 ] || WANT="off"

WR=(npx --no-install wrangler)
PAIR="CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD"
WORKER="$(sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' wrangler.jsonc 2>/dev/null | head -1 || true)"

# ── What the Worker holds now ────────────────────────────────────────────────
NAMES=""
list_names() { # fills NAMES with the secret names on the Worker; fails when wrangler cannot ask
  local raw
  raw="$("${WR[@]}" secret list --format json 2>/dev/null)" || return 1
  NAMES="$(printf '%s' "$raw" | grep -oE '"name": *"[A-Z0-9_]+"' | sed -E 's/.*"([A-Z0-9_]+)"$/\1/' || true)"
}
on_worker() { printf '%s\n' "$NAMES" | grep -qx "$1"; }
STATE=""
read_state() { # STATE = on | off | half-team (only the address is set) | half-aud (only the tag is set)
  local t=0 a=0
  if on_worker CF_ACCESS_TEAM_DOMAIN; then t=1; fi
  if on_worker CF_ACCESS_AUD; then a=1; fi
  case "$t$a" in 11) STATE="on" ;; 00) STATE="off" ;; 10) STATE="half-team" ;; *) STATE="half-aud" ;; esac
}
say_state() {
  for s in $PAIR; do if on_worker "$s"; then echo "  $s  set"; else echo "  $s  not set"; fi; done
  case "$STATE" in
    on)  echo "Cloudflare Access check: ON. The app refuses every request that does not carry a token Access signed for this application." ;;
    off) echo "Cloudflare Access check: off. The app does not check; it trusts that Access is in front of it." ;;
    half-team) echo "WARNING: only CF_ACCESS_TEAM_DOMAIN is set. With one of the two missing the app refuses EVERY request (503), the login page included." ;;
    *)         echo "WARNING: only CF_ACCESS_AUD is set. With one of the two missing the app refuses EVERY request (503), the login page included." ;;
  esac
}
fix_half() {
  echo "Finish it, or undo it, in one step:"
  echo "  bash scripts/set-access-check.sh --apply --team-domain <team>.cloudflareaccess.com --aud <64 hex>"
  echo "  bash scripts/set-access-check.sh --apply --off"
}

LISTED=1; list_names || LISTED=0
[ -z "$WORKER" ] || echo "Worker: $WORKER (from wrangler.jsonc)"
if [ "$LISTED" = 1 ]; then
  read_state
  echo "On the Worker now:"
  say_state
  case "$STATE" in half-*) fix_half ;; esac
else
  echo "On the Worker now: could not ask Cloudflare. wrangler did not list the Worker's settings: it is not installed here (npm install),"
  echo "  not signed in (npx wrangler login), or there is no connection."
fi

if [ "$APPLY" = 0 ]; then
  echo
  case "$WANT" in
    on)  echo "--apply would store CF_ACCESS_TEAM_DOMAIN ($TEAM) and CF_ACCESS_AUD (${#AUD} characters) on the Worker, both in one request, and turn the check on."
         echo "  bash scripts/set-access-check.sh --apply --team-domain $TEAM --aud <the same 64 hex>" ;;
    off) echo "--apply would remove both settings from the Worker in one request and turn the check off."
         echo "  bash scripts/set-access-check.sh --apply --off" ;;
    *)   # Offer only the change that would do something: "to turn it on" under a check that is already on reads as if it were off.
         if [ "$STATE" = "on" ]; then
           echo "To change the two settings: bash scripts/set-access-check.sh --apply --team-domain <team>.cloudflareaccess.com --aud <64 hex>"
         else
           echo "To turn the check on:   bash scripts/set-access-check.sh --apply --team-domain <team>.cloudflareaccess.com --aud <64 hex>"
         fi
         [ "$STATE" = "off" ] || echo "To turn the check off:  bash scripts/set-access-check.sh --apply --off" ;;
  esac
  echo "Looked only. Nothing was changed."
  echo "access_check_result=look"
  exit 0
fi

# ── --apply ──────────────────────────────────────────────────────────────────
[ "$LISTED" = 1 ] || stop "wrangler could not reach the Worker, so nothing was changed. Run: npx wrangler login"

if [ "$WANT" = "off" ] && [ "$STATE" = "off" ]; then
  echo
  echo "Neither setting is on the Worker, so there is nothing to remove. Nothing was changed."
  echo "access_check_result=ok"
  exit 0
fi

umask 077
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-access-check.XXXXXX")"
cleanup() { if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then rm -rf -- "$TMP"; fi; }
trap cleanup EXIT

# One file, one request. Both values were checked above, so neither can break out of the JSON.
if [ "$WANT" = "on" ]; then
  printf '{"CF_ACCESS_TEAM_DOMAIN": "%s", "CF_ACCESS_AUD": "%s"}\n' "$TEAM" "$AUD" > "$TMP/settings.json"
else
  # null removes a secret. Only the names that are there are named.
  { printf '{'; sep=''; for s in $PAIR; do if on_worker "$s"; then printf '%s"%s": null' "$sep" "$s"; sep=', '; fi; done; printf '}\n'; } > "$TMP/settings.json"
fi
echo
if ! "${WR[@]}" secret bulk "$TMP/settings.json" > "$TMP/wrangler.out" 2>&1; then
  sed 's/^/  wrangler: /' "$TMP/wrangler.out" | tail -5
  stop "the Worker did not take the change. Both settings go in one request, so it should hold what it held before: run this script with no option to see."
fi
rm -f -- "$TMP/settings.json"
echo "Sent to the Worker in one request."

# Read back, never assumed.
if ! list_names; then
  echo "The change was sent, but the Worker's list could not be read back, so it is not confirmed."
  echo "Run this script with no option to see what the Worker holds."
  echo "access_check_result=unconfirmed"
  exit 1
fi
read_state
echo "On the Worker now:"
say_state
if [ "$STATE" != "$WANT" ]; then
  case "$STATE" in half-*) fix_half ;; esac
  stop "the Worker is not in the state asked for (see above)."
fi
echo
if [ "$WANT" = "on" ]; then
  echo "Cloudflare never shows a stored value, so only the two names were read back. The app loading is the proof of the values."
  echo "Next: open the app. It should load as before, and each answer carries the header x-fleet-access-check: on."
  echo "If it does not load:  bash scripts/set-access-check.sh --apply --off"
else
  echo "The app no longer checks Access itself. One-click sign-in to WordPress needs both settings, so it is off too."
fi
echo "access_check_result=ok"
