#!/bin/bash
# Run one .sql file against the dashboard's Supabase database.
#
#   bash scripts/apply-sql.sh supabase/migrations/20261121000000_strong_session.sql --dry-run   # run it, then roll it all back
#   bash scripts/apply-sql.sh supabase/migrations/20261121000000_strong_session.sql             # apply it
#
# A person runs this, not an agent: it uses the Supabase CLI's own login, which
# lives in the macOS keychain, or SUPABASE_ACCESS_TOKEN if you set it (the way
# in on a machine with no keychain). The token is read inside the command and
# never printed. It reaches curl on standard input, never as an argument: any
# program on this machine can read another program's arguments while it runs.
# PostgREST cannot run DDL and psql may not be installed, so the
# Management API's query endpoint is the one way in.
#
# --dry-run wraps the whole file in BEGIN ... ROLLBACK, so a mistake in the SQL
# is reported and nothing is changed. Do that first.
#
# A real run wraps the file in BEGIN ... COMMIT: it is applied whole, or, if any
# statement fails, not at all. For both to be true the file must not open or
# close a transaction of its own: a COMMIT inside it would make a dry run real.
#
# So the file is not sent as bare statements. It is handed to the database as
# one piece of text to run inside the transaction (a DO block that EXECUTEs
# it), where Postgres itself refuses every statement that opens or closes a
# transaction, however it is written (COMMIT, END, ABORT, BEGIN WORK, a
# procedure that commits). The file then fails as a whole and nothing is kept.
# The plain spellings are also refused before anything is sent, only so the
# message can name the line. scripts/test-apply-sql-db.mjs runs what this
# script sends in a database in memory and proves both.
#
# Which project: FLEET_SUPABASE_PROJECT_REF if you set it, else the ref the
# Supabase CLI wrote when you linked this checkout, else the one in .env.local.
# With none of those it stops; it never guesses a project.
set -u
# shellcheck source=lib-fleet-project.sh
. "$(cd "$(dirname "$0")" && pwd)/lib-fleet-project.sh"
PROJECT_REF="$(fleet_supabase_project_ref)" || exit 1
FILE="${1:-}"; MODE="${2:-}"
[ -r "$FILE" ] || { echo "Use: $0 <file.sql> [--dry-run]"; exit 2; }
case "$MODE" in ""|--dry-run) ;; *) echo "Unknown option: $MODE (only --dry-run)"; exit 2 ;; esac

RAW="${SUPABASE_ACCESS_TOKEN:-$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null)}"
[ -n "$RAW" ] || { echo "ABORT: no Supabase login found. Run: supabase login (it is kept in the macOS keychain), or set SUPABASE_ACCESS_TOKEN."; exit 1; }
# The keychain keeps it encoded behind a prefix; a token you set yourself is used as it is.
token() { case "$RAW" in go-keyring-base64:*) printf '%s' "${RAW#go-keyring-base64:}" | base64 -d ;; *) printf '%s' "$RAW" ;; esac; }

BODY=$(mktemp) && OUT=$(mktemp) || exit 1
trap 'rm -f "${BODY:?}" "${OUT:?}"' EXIT
python3 - "$FILE" "$MODE" > "$BODY" <<'PY'
import json, re, secrets, sys
sql = open(sys.argv[1]).read()
own = re.search(r"^[ \t]*(begin|start[ \t]+transaction|commit|rollback)[ \t]*;", sql, re.I | re.M)
if own:
    print(f"line {sql[:own.start()].count(chr(10)) + 1}: {own.group(0).strip()}", file=sys.stderr); sys.exit(3)
# The file travels as text between two marks that appear nowhere in it.
while True:
    mark = "fleet_" + secrets.token_hex(8)
    if mark not in sql: break
run_it = f"do ${mark}_do$ begin execute ${mark}_sql${sql}${mark}_sql$; end ${mark}_do$;"
print(json.dumps({"query": "begin;\n" + run_it + ("\nrollback;" if sys.argv[2] == "--dry-run" else "\ncommit;")}))
PY
[ $? = 0 ] || { echo "ABORT: $FILE opens or closes a transaction itself (above). This script wraps the whole file in one, so that a dry run changes nothing and a real run is all or nothing. Take those lines out and run it again."; exit 2; }

# The login goes to curl as a header on standard input (-H @-). printf is part
# of bash, so the login is in no program's arguments at any point.
CODE=$(printf 'Authorization: Bearer %s\n' "$(token)" | curl -s -o "$OUT" -w "%{http_code}" -X POST \
    "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
    -H @- \
    -H "Content-Type: application/json" --data-binary @"$BODY")

if [ "$CODE" = 200 ] || [ "$CODE" = 201 ]; then
    if [ "$MODE" = "--dry-run" ]; then echo "✓ dry run clean: $FILE ran without error and was rolled back. Nothing changed."
    else echo "✓ applied: $FILE"; fi
else
    echo "✗ HTTP $CODE. Nothing was applied$([ "$MODE" = "--dry-run" ] && echo " (dry run)"). The database said:"
    head -c 2000 "$OUT"; echo
    if grep -qi 'transaction commands\|transaction termination' "$OUT"; then
        echo "That means $FILE opens or closes a transaction itself (COMMIT, END, ABORT, BEGIN or the like, perhaps inside a procedure it calls). This script runs the whole file as one transaction, so take those statements out and run it again."
    fi
    exit 1
fi
