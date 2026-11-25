#!/usr/bin/env bash
# Self-test for sso-make-keys.sh. Nothing here touches Cloudflare: "npx wrangler" is a
# stand-in that keeps secrets in a folder, so the test can read back what the real
# Worker never gives up, and prove the private halves went there and nowhere else.
#   bash scripts/test-sso-make-keys.sh            the checks
#   KEYS_SCRIPT=<path> bash scripts/test-...      run them against another copy (used by the controls below)
#   bash scripts/test-sso-make-keys.sh --controls break the script nine ways; each must fail a named check
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${KEYS_SCRIPT:-$HERE/sso-make-keys.sh}"
OSSL="${OPENSSL:-openssl}"

if [ "${1:-}" = "--controls" ]; then
  W="$(mktemp -d "${TMPDIR:-/tmp}/sso-keys-ctl.XXXXXX")"; trap 'if [ -d "$W" ]; then rm -rf -- "$W"; fi' EXIT
  caught=0; missed=0
  ctl() { # name, python replace-expression over the script text
    python3 - "$HERE/sso-make-keys.sh" "$W/broken.sh" "$2" <<'PY'
import sys
src, out, expr = sys.argv[1:4]
s = open(src).read(); a, b = expr.split(" ==> ", 1)
a = a.replace("\\n", "\n"); b = b.replace("\\n", "\n")
if a not in s: sys.exit("mutation did not apply: " + a[:60])
open(out, "w").write(s.replace(a, b, 1))
PY
    [ $? = 0 ] || { echo "  MISSED  $1  (the break itself did not apply)"; missed=$((missed+1)); return; }
    out="$(KEYS_SCRIPT="$W/broken.sh" bash "$0" 2>&1)"; last="$(printf '%s\n' "$out" | tail -1)"
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
  ctl "a private key is printed" 'make_key sign 3072 ==> make_key sign 3072; cat "$TMP/sign.pem"'
  ctl "the private keys are left on disk" 'trap cleanup EXIT ==> :'
  ctl "the public halves are saved before the Worker has the private ones" 'put SSO_SIGN_PRIVATE_KEY "$TMP/sign.pem" || ==> mkdir -p "$KEYDIR"; cp "$TMP/sign-pub.pem" "$KEYDIR/sign-pub.pem"; cp "$TMP/box-pub.pem" "$KEYDIR/box-pub.pem"\nput SSO_SIGN_PRIVATE_KEY "$TMP/sign.pem" ||'
  ctl "existing keys are replaced without --rotate" '[ -n "$USER_IDS" ] || stop "keys already exist ==> [ -n "$USER_IDS" ] || MAKE=1 || stop "keys already exist'
  ctl "the signing key is 2048 bits" 'make_key sign 3072 ==> make_key sign 2048'
  ctl "the same key is used for both jobs" 'put SSO_BOX_PRIVATE_KEY "$TMP/box.pem" ==> put SSO_BOX_PRIVATE_KEY "$TMP/sign.pem"'
  ctl "a look changes things" 'if [ "$APPLY" = 0 ]; then\n  echo ==> if [ "$APPLY" = 0 ]; then\n  mkdir -p "$KEYDIR"; echo x > "$KEYDIR/sign-pub.pem"\n  echo'
  ctl "one of the two Access settings can be stored here again" '    --team-domain|--aud) stop "$1 is no longer stored by this script. ==>     --aud) needs_value "$@"; printf "%s" "$2" > "${TMPDIR:-/tmp}/aud.$$"; "${WR[@]:-npx --no-install wrangler}" secret put CF_ACCESS_AUD < "${TMPDIR:-/tmp}/aud.$$" > /dev/null 2>&1; rm -f "${TMPDIR:-/tmp}/aud.$$"; shift ;;\n    --team-domain) stop "$1 is no longer stored by this script.'
  ctl "half a set of Access settings gets no warning" '    *)  echo "WARNING: only one of CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD is on the Worker. ==>     *)  echo "Only one of CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD is on the Worker.'
  ctl "missing Access settings are not mentioned" '    00) echo "Not set on the Worker: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD. ==>     00) : "Not set on the Worker: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.'
  ctl "any text is taken as a user id" '[[ "$USER_IDS" =~ ^$UUID(,$UUID)*$ ]] ==> [[ "$USER_IDS" =~ . ]]'
  ctl "half a set of keys is accepted as it is" '[ "$COMPLETE" = 1 ] || stop ==> [ "$COMPLETE" = 1 ] || true || stop'
  echo; echo "$((caught+missed)) broken copies: $caught caught, $missed missed"
  [ "$missed" = 0 ]; exit $?
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/sso-keys-test.XXXXXX")"; trap 'if [ -d "$T" ]; then rm -rf -- "$T"; fi' EXIT
mkdir -p "$T/bin" "$T/tmp" "$T/home"
cat > "$T/bin/npx" <<'FAKE'
#!/usr/bin/env bash
# Stand-in for "npx --no-install wrangler ...": secrets are files under $FAKE_DIR/secrets.
shift 2 # --no-install wrangler
echo "wrangler $*" >> "$FAKE_DIR/log"
[ -z "${FAKE_OFFLINE:-}" ] || { echo "not logged in" >&2; exit 1; }
if [ "$1 $2" = "secret list" ]; then
  printf '['; first=1
  for f in "$FAKE_DIR"/secrets/*; do [ -e "$f" ] || continue; [ $first = 1 ] || printf ','; first=0; printf '\n  {\n    "name": "%s",\n    "type": "secret_text"\n  }' "$(basename "$f")"; done
  printf '\n]\n'; exit 0
fi
if [ "$1 $2" = "secret put" ]; then
  if [ "${FAKE_FAIL_PUT:-}" = "$3" ]; then cat > /dev/null; echo "upload refused" >&2; exit 1; fi
  mkdir -p "$FAKE_DIR/secrets"; cat > "$FAKE_DIR/secrets/$3"; echo "Success! Uploaded secret $3"; exit 0
fi
exit 1
FAKE
chmod +x "$T/bin/npx"

ran=0; failed=0
check() { ran=$((ran+1)); if [ "$2" = "$3" ]; then echo "  ok    $1"; else failed=$((failed+1)); echo "  FAIL  $1"; echo "        got  $2"; echo "        want $3"; fi; }
fresh() { rm -rf -- "$T/fake" "$T/keys" "$T/tmp"; mkdir -p "$T/fake/secrets" "$T/tmp"; : > "$T/fake/log"; }
run() { PATH="$T/bin:$PATH" HOME="$T/home" FAKE_DIR="$T/fake" FLEET_SSO_KEY_DIR="$T/keys" TMPDIR="$T/tmp" bash "$SCRIPT" "$@" > "$T/out.txt" 2>&1 < /dev/null; echo $?; }
puts() { grep -c '^wrangler secret put' "$T/fake/log"; }
last() { tail -1 "$T/out.txt"; }
leaked() { grep -c 'PRIVATE KEY' "$T/out.txt"; }
left() { find "$T/tmp" -mindepth 1 | wc -l | tr -d ' '; }
pub_of() { "$OSSL" pkey -in "$1" -pubout 2>/dev/null | shasum | cut -d' ' -f1; }
sum() { shasum "$1" 2>/dev/null | cut -d' ' -f1; }
bits() { "$OSSL" rsa -in "$1" -noout -text 2>/dev/null | head -1 | grep -oE '[0-9]+ bit'; }
AUD_OK="$(printf 'a%.0s' $(seq 64))"; UID_OK="00000000-0000-4000-8000-000000000001"

echo "A look:"
fresh; rc=$(run)
check "exits clean, says what it would do, and changes nothing" "$rc/$(last)/$(puts)/$([ -e "$T/keys" ] && echo dir || echo none)/$(grep -c 'Would make both keys' "$T/out.txt")" "0/sso_keys_result=look/0/none/1"
check "it lists all five Worker settings as not set" "$(grep -c '  not set$' "$T/out.txt")" "5"

echo "Making the keys:"
fresh; rc=$(run --apply)
check "exits clean" "$rc/$(last)" "0/sso_keys_result=ok"
check "two secrets stored, signing key first" "$(grep '^wrangler secret put' "$T/fake/log" | tr '\n' ';')" "wrangler secret put SSO_SIGN_PRIVATE_KEY;wrangler secret put SSO_BOX_PRIVATE_KEY;"
check "the Worker holds a 3072-bit signing key and a 4096-bit unsealing key, both PKCS#8" "$(bits "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")/$(bits "$T/fake/secrets/SSO_BOX_PRIVATE_KEY")/$(head -1 "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")/$(head -1 "$T/fake/secrets/SSO_BOX_PRIVATE_KEY")" "3072 bit/4096 bit/-----BEGIN PRIVATE KEY-----/-----BEGIN PRIVATE KEY-----"
check "the saved public halves are the halves of those two keys" "$([ "$(pub_of "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")" = "$(sum "$T/keys/sign-pub.pem")" ] && echo same || echo differ)/$([ "$(pub_of "$T/fake/secrets/SSO_BOX_PRIVATE_KEY")" = "$(sum "$T/keys/box-pub.pem")" ] && echo same || echo differ)" "same/same"
check "the two keys are different keys" "$([ "$(sum "$T/keys/sign-pub.pem")" != "$(sum "$T/keys/box-pub.pem")" ] && echo different || echo SAME)" "different"
check "no private key in anything it printed" "$(leaked)" "0"
check "no private key left on disk" "$(left)/$(grep -rl 'PRIVATE KEY' "$T/keys" "$T/home" "$T/tmp" 2>/dev/null | wc -l | tr -d ' ')" "0/0"
check "the public halves are files the installer accepts" "$(grep -c 'BEGIN PUBLIC KEY' "$T/keys/sign-pub.pem")/$(grep -c 'BEGIN PUBLIC KEY' "$T/keys/box-pub.pem")/$(stat -f '%Lp' "$T/keys" 2>/dev/null || stat -c '%a' "$T/keys")" "1/1/700"
check "it says which settings are still missing, and (with the list and again at the end) where the two Access settings are stored" "$(grep -c '^Still not set on the Worker: SSO_ALLOWED_USER_IDS' "$T/out.txt")/$(grep -c '^Not set on the Worker: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD\..*bash scripts/set-access-check.sh$' "$T/out.txt")" "1/2"
# The keys in the form Fleet's own code reads them, when Node and an openssl that can seal are here.
OSSL3="${FLEET_SSO_OPENSSL:-/opt/homebrew/opt/openssl@3/bin/openssl}"
if command -v node >/dev/null 2>&1 && [ -x "$OSSL3" ] && [ -f "$HERE/../lib/sso/crypto.ts" ]; then
  got="$(cd "$HERE/.." && SIGN="$T/fake/secrets/SSO_SIGN_PRIVATE_KEY" BOX="$T/fake/secrets/SSO_BOX_PRIVATE_KEY" SP="$T/keys/sign-pub.pem" BP="$T/keys/box-pub.pem" O="$OSSL3" W="$T/tmp" node --experimental-strip-types --no-warnings --input-type=module -e '
    import { signRequest, unsealLink } from "./lib/sso/crypto.ts";
    import { readFileSync, writeFileSync } from "node:fs"; import { execFileSync } from "node:child_process";
    const e = process.env, id = "11111111-2222-4333-8444-555555555555", now = Math.floor(Date.now() / 1000);
    const signed = await signRequest({ v: 1, id, sid: 7, host: "example.com", iat: now, exp: now + 60 }, readFileSync(e.SIGN, "utf8"));
    const [v, body, sig] = signed.split(".");
    writeFileSync(e.W + "/sig", Buffer.from(sig, "base64url"));
    const ver = execFileSync(e.O, ["dgst", "-sha256", "-verify", e.SP, "-signature", e.W + "/sig"], { input: v + "." + body }).toString().trim();
    const sealed = execFileSync(e.O, ["pkeyutl", "-encrypt", "-pubin", "-inkey", e.BP, "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256", "-pkeyopt", "rsa_mgf1_md:sha256"], { input: id + "\nhttps://example.com/wp-login.php?x=1" }).toString("base64");
    const opened = await unsealLink(sealed, readFileSync(e.BOX, "utf8"), { id, hostname: "example.com" });
    console.log(ver + "/" + (opened.ok ? opened.url : opened.reason));
  ' 2>&1 | tail -1)"; rm -f -- "$T/tmp/sig"
  check "Fleet signs with the stored key and a server verifies with the saved one; a server seals and Fleet opens" "$got" "Verified OK/https://example.com/wp-login.php?x=1"
else
  echo "  skip  the keys in Fleet's own code (needs node and OpenSSL 3)"
fi
before="$(sum "$T/keys/sign-pub.pem")/$(sum "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")"

echo "Keys already there:"
rc=$(run); check "a look says so and offers only --rotate" "$rc/$(last)/$(grep -c 'Keys already exist' "$T/out.txt")/$(grep -c '  set$' "$T/out.txt")" "0/sso_keys_result=look/1/2"
: > "$T/fake/log"; rc=$(run --apply)
check "--apply alone refuses and changes nothing" "$rc/$(last)/$(puts)/$([ "$before" = "$(sum "$T/keys/sign-pub.pem")/$(sum "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")" ] && echo unchanged || echo CHANGED)" "1/sso_keys_result=stop/0/unchanged"
: > "$T/fake/log"; rc=$(run --apply --user-ids "$UID_OK")
check "--apply with --user-ids stores that one setting and leaves the keys alone" "$rc/$(last)/$(grep '^wrangler secret put' "$T/fake/log" | sed 's/.* //' | tr '\n' ' ')/$([ "$before" = "$(sum "$T/keys/sign-pub.pem")/$(sum "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")" ] && echo unchanged || echo CHANGED)" "0/sso_keys_result=ok/SSO_ALLOWED_USER_IDS /unchanged"
check "the setting arrives exactly, with no newline added, and the Access settings are not touched" "$(cat "$T/fake/secrets/SSO_ALLOWED_USER_IDS")|$(wc -l < "$T/fake/secrets/SSO_ALLOWED_USER_IDS" | tr -d ' ')|$(ls "$T/fake/secrets" | grep -c '^CF_ACCESS')|$(grep -c '^Still not set on the Worker' "$T/out.txt")|$(grep -c '^Not set on the Worker: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD' "$T/out.txt")" "$UID_OK|0|0|0|2"
printf 'x' > "$T/fake/secrets/CF_ACCESS_AUD"; rc=$(run)
check "a look at a Worker with only one of the two Access settings warns that the app is refusing every request" "$rc/$(grep -c '^WARNING: only one of CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD is on the Worker\..*refuses EVERY request (503).*bash scripts/set-access-check.sh$' "$T/out.txt")" "0/1"
: > "$T/fake/log"; rc=$(run --apply --user-ids "$UID_OK")
check "and so does --apply, at the end of what it says" "$rc/$(grep -c '^WARNING: only one of' "$T/out.txt")" "0/2"
printf 'y' > "$T/fake/secrets/CF_ACCESS_TEAM_DOMAIN"; rc=$(run)
check "with both there it says nothing about them beyond the list" "$rc/$(grep -c 'WARNING\|^Not set on the Worker' "$T/out.txt")/$(grep -c '  set$' "$T/out.txt")" "0/0/5"
rm -f -- "$T/fake/secrets/CF_ACCESS_AUD" "$T/fake/secrets/CF_ACCESS_TEAM_DOMAIN"
: > "$T/fake/log"; rc=$(run --apply --rotate)
check "--rotate makes a new pair and says every server needs the installer again" "$rc/$(puts)/$([ "$before" != "$(sum "$T/keys/sign-pub.pem")/$(sum "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")" ] && echo new || echo SAME)/$([ "$(pub_of "$T/fake/secrets/SSO_SIGN_PRIVATE_KEY")" = "$(sum "$T/keys/sign-pub.pem")" ] && echo paired || echo UNPAIRED)/$(grep -c 'every server refuses sign-in requests until the installer has run' "$T/out.txt")/$(left)" "0/2/new/paired/1/0"
rm -f -- "$T/keys/box-pub.pem"; : > "$T/fake/log"; rc=$(run --apply --user-ids "$UID_OK")
check "half a set of keys is not left as it is: it stops and asks for a fresh set" "$rc/$(puts)/$(grep -c 'only some of the four key halves exist' "$T/out.txt")" "1/0/1"

echo "When the Worker will not take a key:"
fresh; rc=$(FAKE_FAIL_PUT=SSO_SIGN_PRIVATE_KEY run --apply)
check "the first is refused: it stops, saves no public key, leaves nothing behind" "$rc/$(last)/$(puts)/$(ls "$T/keys" 2>/dev/null | wc -l | tr -d ' ')/$(left)/$(leaked)" "1/sso_keys_result=stop/1/0/0/0"
fresh; rc=$(FAKE_FAIL_PUT=SSO_BOX_PRIVATE_KEY run --apply)
check "the second is refused: no public key is saved, and it says to run --rotate" "$rc/$(puts)/$(ls "$T/keys" 2>/dev/null | wc -l | tr -d ' ')/$(left)/$(grep -c 'apply --rotate' "$T/out.txt")" "1/2/0/0/1"
fresh; rc=$(FAKE_OFFLINE=1 run --apply)
check "wrangler not signed in: nothing is made" "$rc/$(last)/$(puts)/$(ls "$T/keys" 2>/dev/null | wc -l | tr -d ' ')/$(left)" "1/sso_keys_result=stop/0/0/0"
fresh; rc=$(FAKE_OFFLINE=1 run)
check "wrangler not signed in: a look says how to sign in" "$rc/$(grep -c 'npx wrangler login' "$T/out.txt")" "0/1"

echo "Settings that are not what they claim:"
for bad in "--user-ids not-a-uuid" "--user-ids $UID_OK,$UID_OK,x" "--user-ids" "--frobnicate"; do
  fresh; rc=$(run --apply $bad)
  check "refused before anything is made: $bad" "$([ "$rc" != 0 ] && echo stopped || echo RAN)/$(last)/$(puts)/$(ls "$T/keys" 2>/dev/null | wc -l | tr -d ' ')" "stopped/sso_keys_result=stop/0/0"
done
fresh; rc=$(run --user-ids "$UID_OK"); check "a setting without --apply is refused, not ignored" "$rc/$(puts)" "1/0"

echo "The two Cloudflare Access settings are not stored here (one alone takes the app down):"
for moved in "--aud $AUD_OK" "--team-domain team.cloudflareaccess.com" "--team-domain team.cloudflareaccess.com --aud $AUD_OK" "--user-ids $UID_OK --aud $AUD_OK"; do
  fresh; rc=$(run --apply $moved)
  check "refused, nothing made or stored, and it names the script that stores them: $(echo "$moved" | sed "s/$AUD_OK/<tag>/")" "$rc/$(last)/$(grep -c '^wrangler secret put\|^wrangler secret bulk' "$T/fake/log")/$(ls "$T/fake/secrets" | wc -l | tr -d ' ')/$(ls "$T/keys" 2>/dev/null | wc -l | tr -d ' ')/$(grep -c 'no longer stored by this script.*bash scripts/set-access-check.sh --apply' "$T/out.txt")" "1/sso_keys_result=stop/0/0/0/1"
done
fresh; rc=$(run --rotate); check "--rotate without --apply is refused" "$rc/$(puts)" "1/0"

echo; echo "$ran checks, $failed failed"
[ "$failed" = 0 ]
