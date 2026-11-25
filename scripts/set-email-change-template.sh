#!/bin/bash
# Point Supabase's "Change Email Address" message at Fleet's confirm page.
#
#   bash scripts/set-email-change-template.sh            # look: show the settings, change nothing
#   bash scripts/set-email-change-template.sh --apply    # change the one link, then read it back
#   add  --site-url https://fleet.example.com  to either, to set the Site URL as well
#
# Why: Supabase's own link confirms a new address the moment anything fetches
# it, a mail scanner or a link preview included. Fleet's page (/auth/confirm)
# confirms only when the signed-in person presses the button. See
# docs/sign-in-email.md.
#
# What --apply changes: one field, the body of that one message, and in it only
# the link. With --site-url it also sets the Site URL, which a new Supabase
# project leaves at http://localhost:3000 and which the new link is built from.
# It is a partial update: the redirect list, the rate limits and every other
# message are left alone. Nothing else is ever sent.
#
# A person runs this, not an agent: it uses the Supabase CLI's own login, which
# lives in the macOS keychain. The token is read inside the command and never
# printed. It reaches curl on standard input, never as an argument: any program
# on this machine can read another program's arguments while it runs.
#
# Which project: FLEET_SUPABASE_PROJECT_REF if you set it, else the ref the
# Supabase CLI wrote when you linked this checkout, else the one in .env.local.
# With none of those it stops; it never guesses a project.
set -u
finish() { echo "email_template_result=$1"; exit "$2"; }
MODE=""; WANT_SITE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --apply) MODE="--apply" ;;
        --site-url) [ $# -ge 2 ] || { echo "--site-url needs an address, like https://fleet.example.com"; finish stop 2; }; WANT_SITE="${2%/}"; shift ;;
        -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1 (only --apply and --site-url <address>)"; finish stop 2 ;;
    esac
    shift
done
if [ -n "$WANT_SITE" ] && ! printf '%s' "$WANT_SITE" | grep -Eq '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]+)?$'; then
    echo "--site-url takes an https address and nothing after it, like https://fleet.example.com"; finish stop 2
fi

PROJECT_REF="${FLEET_SUPABASE_PROJECT_REF:-}"
if [ -z "$PROJECT_REF" ]; then
    PROJECT_LIB="$(cd "$(dirname "$0")" && pwd)/lib-fleet-project.sh"
    [ -r "$PROJECT_LIB" ] || { echo "ABORT: no project ref. Set FLEET_SUPABASE_PROJECT_REF ($PROJECT_LIB is not here to look it up)."; finish stop 1; }
    # shellcheck source=lib-fleet-project.sh
    . "$PROJECT_LIB"
    PROJECT_REF="$(fleet_supabase_project_ref)" || finish stop 1
fi
printf '%s' "$PROJECT_REF" | grep -Eq '^[a-z0-9]{8,40}$' || { echo "ABORT: the project ref is not a Supabase project ref (8 to 40 lowercase letters and digits)."; finish stop 1; }
API="${FLEET_SUPABASE_API:-https://api.supabase.com}/v1/projects/$PROJECT_REF/config/auth"

RAW="${SUPABASE_ACCESS_TOKEN:-$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null)}"
[ -n "$RAW" ] || { echo "ABORT: no Supabase login found. Run: supabase login (it is kept in the macOS keychain), or set SUPABASE_ACCESS_TOKEN."; finish stop 1; }
token() { case "$RAW" in go-keyring-base64:*) printf '%s' "${RAW#go-keyring-base64:}" | base64 -d ;; *) printf '%s' "$RAW" ;; esac; }
# The login as a header, for curl to read on standard input (-H @-). printf is
# part of bash, so the login is in no program's arguments at any point.
login_header() { printf 'Authorization: Bearer %s\n' "$(token)"; }

WORK=$(mktemp -d) || finish stop 1
trap 'rm -rf "${WORK:?}"' EXIT
NOW="$WORK/now.json"; BODY="$WORK/body.json"; AFTER="$WORK/after.json"

CODE=$(login_header | curl -s -o "$NOW" -w "%{http_code}" "$API" -H @-)
[ "$CODE" = 200 ] || { echo "✗ could not read the settings (HTTP $CODE). Nothing was changed."; head -c 300 "$NOW"; echo; finish stop 1; }

# Decide. Prints the report; writes the one-field body when there is something to change.
python3 - "$NOW" "$BODY" "$WANT_SITE" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
FIELD = "mailer_templates_email_change_content"
OLD = "{{ .ConfirmationURL }}"
NEW = "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change"
DEFAULT = ("<h2>Confirm your new email address</h2>\n\n"
           "<p>Follow the link below to confirm {{ .NewEmail }} as your new email address.</p>\n"
           "<p><a href=\"{{ .ConfirmationURL }}\">Confirm new email address</a></p>\n"
           "<p>If you didn't request this change, you can safely ignore this email.</p>")
yes = lambda v: "yes" if v else "no"
site = (cfg.get("site_url") or "").strip()
want_site = sys.argv[3]
body = {}
print("Supabase settings this feature relies on:")
print(f"  Site URL                         {site or '(not set)'}")
print(f"  Secure email change              {yes(cfg.get('mailer_secure_email_change_enabled'))}   (the old address must confirm too)")
print(f"  An email sender is set up        {yes(cfg.get('smtp_host'))}   (without one, Supabase only writes to its own team)")
print(f"  'Email address changed' notice   {yes(cfg.get('mailer_notifications_email_changed_enabled'))}")

if want_site and want_site != site.rstrip("/"):
    print(f"\nThe Site URL would change from {site or '(not set)'} to {want_site}")
    body["site_url"] = want_site
    site = want_site

current = cfg.get(FIELD)
text = current if isinstance(current, str) and current.strip() else DEFAULT
if NEW in text:
    print("\nThe message already links to Fleet's confirm page.")
    if not body:
        print("Nothing to change.")
        sys.exit(10)
elif OLD not in text:
    print("\nSTOP: the message has been edited and has no {{ .ConfirmationURL }} link to replace.")
    print("Edit it by hand: the link should be")
    print("  " + NEW)
    sys.exit(11)
elif not site.startswith("https://"):
    print("\nSTOP: the Site URL is not an https address, and the new link is built from it.")
    print("Run this again with this Fleet's own address:")
    print("  bash scripts/set-email-change-template.sh --site-url https://<this Fleet's address>")
    sys.exit(11)
else:
    body[FIELD] = text.replace(OLD, NEW)
    print(f"\nThe message now links to Supabase's own confirm address ({text.count(OLD)} place).")
    print("It would link to:")
    print("  " + site.rstrip("/") + "/auth/confirm?token_hash=…&type=email_change")
json.dump(body, open(sys.argv[2], "w"))
PY
DECIDED=$?
[ "$DECIDED" = 10 ] && finish ok 0
[ "$DECIDED" = 0 ] || finish stop 1

if [ "$MODE" != "--apply" ]; then
    echo; echo "Looked only. Nothing was changed. To make the change:"
    echo "  bash scripts/set-email-change-template.sh --apply${WANT_SITE:+ --site-url $WANT_SITE}"
    finish look 0
fi

REPLY="$WORK/reply.json"; CHECK="$WORK/check.py"; VERDICT="$WORK/verdict.txt"
CODE=$(login_header | curl -s -o "$REPLY" -w "%{http_code}" -X PATCH "$API" \
    -H @- -H "Content-Type: application/json" --data-binary @"$BODY")
[ "$CODE" = 200 ] || { echo "✗ the change was refused (HTTP $CODE). Supabase said:"; head -c 300 "$REPLY"; echo; finish stop 1; }

# Read it back. Supabase can answer with the old settings for a few seconds
# after a change, so a read-back that is not yet right is tried again.
cat > "$CHECK" <<'PY'
import json, sys
want = json.load(open(sys.argv[1])); after = json.load(open(sys.argv[2])); before = json.load(open(sys.argv[3]))
tries = int(sys.argv[5])
try: reply = json.load(open(sys.argv[4]))
except Exception: reply = {}
FIELD = "mailer_templates_email_change_content"
names = {"site_url": "the Site URL", FIELD: "the message"}
wrong = [names.get(k, k) for k in want if after.get(k) != want[k]]
if wrong:
    print(f"✗ read back {tries} time(s), and " + " and ".join(wrong) + " did not come back as sent.")
    if "site_url" in want and after.get("site_url") != want["site_url"]:
        print(f"  Site URL read back as: {after.get('site_url') or '(not set)'}")
    if FIELD in want and after.get(FIELD) != want[FIELD]:
        got = after.get(FIELD) or ""
        state = ("links to Fleet's confirm page, but differs elsewhere" if "/auth/confirm?token_hash=" in got
                 else "still links to Supabase's own address" if "{{ .ConfirmationURL }}" in got
                 else "still Supabase's built-in message" if not got.strip() else "something else")
        print(f"  The message read back as: {state}")
    took = isinstance(reply, dict) and all(reply.get(k) == want[k] for k in want)
    print("  Supabase's own reply to the change " + ("showed it applied, so the read-back may just be behind." if took else "did not show it applied."))
    print("  Run the same command again in a minute: it says \"Nothing to change\" once the change is in.")
    sys.exit(3)
moved = sorted(k for k in before if k not in want and before.get(k) != after.get(k))
if moved:
    print("✗ the change is made, but other settings differ from a minute ago: " + ", ".join(moved)); sys.exit(1)
done = []
if "site_url" in want: done.append("the Site URL is " + want["site_url"])
if FIELD in want: done.append("the message links to Fleet's confirm page")
late = f" (on read-back {tries})" if tries > 1 else ""
print(f"\n✓ changed and read back{late}: {'; '.join(done)}. {len(before) - len(want)} other settings unchanged.")
PY
TRIES=0; MAX_TRIES="${FLEET_READBACK_TRIES:-6}"
while :; do
    TRIES=$((TRIES+1))
    CODE=$(login_header | curl -s -o "$AFTER" -w "%{http_code}" "$API" -H @-)
    [ "$CODE" = 200 ] || { echo "✗ changed, but could not read it back (HTTP $CODE). Run this again without --apply to check."; finish stop 1; }
    python3 "$CHECK" "$BODY" "$AFTER" "$NOW" "$REPLY" "$TRIES" > "$VERDICT"; V=$?
    [ "$V" = 3 ] || break
    [ "$TRIES" -lt "$MAX_TRIES" ] || break
    perl -e 'select(undef,undef,undef,$ARGV[0])' "${FLEET_READBACK_WAIT:-4}"
done
cat "$VERDICT"
[ "$V" = 0 ] || finish stop 1
finish ok 0
