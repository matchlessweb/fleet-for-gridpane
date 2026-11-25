#!/usr/bin/env bash
# sso-make-keys.sh — make the two keys one-click WordPress sign-in runs on, and
# give the private halves to the Worker.
#
#   bash scripts/sso-make-keys.sh                    look only: what exists, what it would do
#   bash scripts/sso-make-keys.sh --apply            make the keys (refuses if any already exist)
#   bash scripts/sso-make-keys.sh --apply --rotate   replace the keys
#
# With --apply it can also store who may use one-click sign-in
# (given once the keys exist, and without --rotate, it stores only this):
#   --user-ids <uuid[,uuid...]>            Supabase user ids
#
# Sign-in also needs the two Cloudflare Access settings, CF_ACCESS_TEAM_DOMAIN and
# CF_ACCESS_AUD. They are NOT stored here: with only one of the two on the Worker
# the app refuses every request, so they are written together, in one request, by
#   bash scripts/set-access-check.sh
# This script says whether they are there, and warns when only one is.
#
# Two keys, each with one job:
#   signing key (RSA 3072)    Fleet signs each request; a server acts only on a request it can verify.
#   unsealing key (RSA 4096)  a server seals the sign-in link so only Fleet can open it.
#
# The private halves go straight into the Worker's secrets and nowhere else: they are
# made in a private temporary folder, piped to wrangler, and deleted. They are never
# printed. The public halves are saved to ~/.config/fleet/sso/ (or $FLEET_SSO_KEY_DIR),
# where scripts/install-fleet-sso-agent.sh reads them for each server.
#
# AFTER --rotate: every server still holds the old public keys and will refuse
# requests until you run   bash scripts/install-fleet-sso-agent.sh --apply <server>
# on each one. Sign-in is off on a server between the two steps; nothing else is.
#
# Needs: openssl, and wrangler signed in to the account that owns the Worker
# (npx wrangler login, or CLOUDFLARE_API_TOKEN). Run it from the repository.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."

stop() { echo "ABORT: $1"; echo "sso_keys_result=stop"; exit 1; }

APPLY=0; ROTATE=0; USER_IDS=""
needs_value() { [ $# -ge 2 ] && [ -n "$2" ] || stop "$1 needs a value (see --help)."; }
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --rotate) ROTATE=1 ;;
    --user-ids) needs_value "$@"; USER_IDS="$2"; shift ;;
    --team-domain|--aud) stop "$1 is no longer stored by this script. The two Cloudflare Access settings must reach the Worker together (with only one, the app refuses every request): bash scripts/set-access-check.sh --apply --team-domain <team>.cloudflareaccess.com --aud <64 hex>" ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) stop "unknown option $1 (see --help)." ;;
  esac
  shift
done

UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
[ -z "$USER_IDS" ] || [[ "$USER_IDS" =~ ^$UUID(,$UUID)*$ ]] || stop "--user-ids takes Supabase user ids separated by commas, lowercase, no spaces."
[ "$ROTATE" = 0 ] || [ "$APPLY" = 1 ] || stop "--rotate does nothing without --apply."
if [ "$APPLY" = 0 ] && [ -n "$USER_IDS" ]; then stop "settings are stored only with --apply."; fi

OPENSSL="${OPENSSL:-openssl}"
command -v "$OPENSSL" >/dev/null 2>&1 || stop "openssl was not found."
WR=(npx --no-install wrangler)
KEYDIR="${FLEET_SSO_KEY_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/sso}"
SECRETS="SSO_SIGN_PRIVATE_KEY SSO_BOX_PRIVATE_KEY SSO_ALLOWED_USER_IDS CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD"

# ── What exists now ──────────────────────────────────────────────────────────
have_pub() { grep -q 'BEGIN PUBLIC KEY' "$KEYDIR/$1" 2>/dev/null; }
LISTED=1
RAW="$("${WR[@]}" secret list --format json 2>/dev/null)" || LISTED=0
NAMES="$(printf '%s' "$RAW" | grep -oE '"name": *"[A-Z0-9_]+"' | sed -E 's/.*"([A-Z0-9_]+)"$/\1/' || true)"
on_worker() { printf '%s\n' "$NAMES" | grep -qx "$1"; }
access_note() { # the two Cloudflare Access settings: not stored here, but a half-set pair takes the whole app down
  local t=0 a=0
  if on_worker CF_ACCESS_TEAM_DOMAIN; then t=1; fi
  if on_worker CF_ACCESS_AUD; then a=1; fi
  case "$t$a" in
    11) ;;
    00) echo "Not set on the Worker: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD. One-click sign-in stays off until both are. They are stored together, by: bash scripts/set-access-check.sh" ;;
    *)  echo "WARNING: only one of CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD is on the Worker. With one missing the app refuses EVERY request (503), the login page included. Fix it now: bash scripts/set-access-check.sh" ;;
  esac
}

echo "Public keys in $KEYDIR:"
for k in sign-pub.pem box-pub.pem; do have_pub "$k" && echo "  $k  present" || echo "  $k  missing"; done
if [ "$LISTED" = 1 ]; then
  echo "On the Worker:"
  for s in $SECRETS; do on_worker "$s" && echo "  $s  set" || echo "  $s  not set"; done
  access_note
else
  echo "On the Worker: could not ask Cloudflare. Sign wrangler in first: npx wrangler login"
fi

EXISTING=0
if have_pub sign-pub.pem || have_pub box-pub.pem; then EXISTING=1; fi
if [ "$LISTED" = 1 ] && { on_worker SSO_SIGN_PRIVATE_KEY || on_worker SSO_BOX_PRIVATE_KEY; }; then EXISTING=1; fi

if [ "$APPLY" = 0 ]; then
  echo
  if [ "$EXISTING" = 1 ]; then
    echo "Keys already exist. Nothing to do unless you mean to replace them:"
    echo "  bash scripts/sso-make-keys.sh --apply --rotate"
    echo "  (then the installer on every server; sign-in is off on a server until it has the new keys)"
  else
    echo "Would make both keys, store the private halves on the Worker, and save the public halves to $KEYDIR."
    echo "  bash scripts/sso-make-keys.sh --apply"
  fi
  echo "A key's two halves cannot be compared from here: a Worker secret can be set but never read back."
  echo "sso_keys_result=look"
  exit 0
fi

# ── --apply ──────────────────────────────────────────────────────────────────
[ "$LISTED" = 1 ] || stop "wrangler could not reach the Worker, so nothing was made. Run: npx wrangler login"
MAKE=1
COMPLETE=0
if have_pub sign-pub.pem && have_pub box-pub.pem && on_worker SSO_SIGN_PRIVATE_KEY && on_worker SSO_BOX_PRIVATE_KEY; then COMPLETE=1; fi
if [ "$EXISTING" = 1 ] && [ "$ROTATE" = 0 ]; then
  [ "$COMPLETE" = 1 ] || stop "only some of the four key halves exist (see the list above), so sign-in cannot work as it is. Make a fresh set: bash scripts/sso-make-keys.sh --apply --rotate"
  [ -n "$USER_IDS" ] || stop "keys already exist. To replace them (every server then needs the installer run again): bash scripts/sso-make-keys.sh --apply --rotate"
  MAKE=0 # the keys stay as they are; only the setting given is stored
fi

umask 077
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-sso-keys.XXXXXX")"
cleanup() { if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then rm -rf -- "$TMP"; fi; }
trap cleanup EXIT

put() { # secret-name file
  "${WR[@]}" secret put "$1" < "$2" > "$TMP/wrangler.out" 2>&1
}

if [ "$MAKE" = 1 ]; then
make_key() { # name bits
  "$OPENSSL" genpkey -algorithm RSA -pkeyopt "rsa_keygen_bits:$2" -out "$TMP/$1.pem" >/dev/null 2>&1 || stop "openssl could not make the $1 key."
  grep -q 'BEGIN PRIVATE KEY' "$TMP/$1.pem" || stop "openssl made the $1 key in a form the Worker cannot read (it needs PKCS#8)."
  "$OPENSSL" pkey -in "$TMP/$1.pem" -pubout -out "$TMP/$1-pub.pem" >/dev/null 2>&1 || stop "openssl could not write the $1 public key."
  "$OPENSSL" rsa -in "$TMP/$1.pem" -noout -text 2>/dev/null | head -1 | grep -q "($2 bit" || stop "the $1 key is not $2 bits."
}
echo
echo "Making the signing key (3072 bits) and the unsealing key (4096 bits)..."
make_key sign 3072
make_key box 4096
# Each pair is tried once before it goes anywhere: sign and verify, seal and open.
printf 'fleet' > "$TMP/msg"
"$OPENSSL" dgst -sha256 -sign "$TMP/sign.pem" -out "$TMP/sig" "$TMP/msg" 2>/dev/null && "$OPENSSL" dgst -sha256 -verify "$TMP/sign-pub.pem" -signature "$TMP/sig" "$TMP/msg" >/dev/null 2>&1 || stop "the new signing key failed its own check."
"$OPENSSL" pkeyutl -encrypt -pubin -inkey "$TMP/box-pub.pem" -pkeyopt rsa_padding_mode:oaep -in "$TMP/msg" -out "$TMP/sealed" 2>/dev/null && [ "$("$OPENSSL" pkeyutl -decrypt -inkey "$TMP/box.pem" -pkeyopt rsa_padding_mode:oaep -in "$TMP/sealed" 2>/dev/null)" = "fleet" ] || stop "the new unsealing key failed its own check."

put SSO_SIGN_PRIVATE_KEY "$TMP/sign.pem" || { sed 's/^/  wrangler: /' "$TMP/wrangler.out" | tail -5; stop "the Worker did not take the signing key. Nothing changed here."; }
echo "  SSO_SIGN_PRIVATE_KEY  stored on the Worker"
put SSO_BOX_PRIVATE_KEY "$TMP/box.pem" || {
  sed 's/^/  wrangler: /' "$TMP/wrangler.out" | tail -5
  stop "the Worker took the new signing key but not the unsealing key, so the two no longer match what the servers hold. Nothing was saved to $KEYDIR. Run again: bash scripts/sso-make-keys.sh --apply --rotate"
}
echo "  SSO_BOX_PRIVATE_KEY   stored on the Worker"

# Only now, with both private halves on the Worker, do the public halves replace the old ones.
mkdir -p "$KEYDIR"; chmod 700 "$KEYDIR"
for k in sign box; do
  cp "$TMP/$k-pub.pem" "$KEYDIR/.$k-pub.pem.new"; chmod 644 "$KEYDIR/.$k-pub.pem.new"; mv -f "$KEYDIR/.$k-pub.pem.new" "$KEYDIR/$k-pub.pem"
done
echo "  public halves saved to $KEYDIR"
else
  echo
  echo "The keys stay as they are."
fi

setting() { # secret-name value
  [ -n "$2" ] || return 0
  printf '%s' "$2" > "$TMP/value"
  put "$1" "$TMP/value" || { sed 's/^/  wrangler: /' "$TMP/wrangler.out" | tail -5; stop "the Worker did not take $1. The keys are in place and are not made again: run the same command once wrangler works."; }
  echo "  $1  stored on the Worker"
}
setting SSO_ALLOWED_USER_IDS "$USER_IDS"

echo
[ "$MAKE" = 0 ] || echo "Done. Next: bash scripts/install-fleet-sso-agent.sh   (look first, then --apply <server> for each server)"
[ "$MAKE" = 0 ] || [ "$EXISTING" = 0 ] || echo "The keys were replaced: every server refuses sign-in requests until the installer has run on it again."
[ -n "$USER_IDS" ] || on_worker SSO_ALLOWED_USER_IDS || echo "Still not set on the Worker: SSO_ALLOWED_USER_IDS (one-click sign-in stays off until it is)."
access_note
echo "sso_keys_result=ok"
