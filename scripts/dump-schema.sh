#!/usr/bin/env bash
# Saves the STRUCTURE of the dashboard's database (tables, columns, rules,
# functions, triggers; no rows) to a file outside the repository, so the
# numbered migrations can be written from what is really there.
#
#   bash scripts/dump-schema.sh              # -> ~/.config/fleet/schema-dump.json
#   bash scripts/dump-schema.sh <file>       # -> a file you name (must be outside the repository)
#
# A person runs this, not an agent: it uses the Supabase CLI's own login from
# the macOS keychain (or SUPABASE_ACCESS_TOKEN if you set it). The token is
# read inside the command and never printed. It reaches curl on standard input,
# never as an argument: any program on this machine can read another program's
# arguments while it runs.
#
# It sends two read-only SELECTs through the Management API's query endpoint:
# scripts/dump-schema.sql, and the list of scheduled jobs. Nothing is changed.
# The file can hold what a scheduled job's command holds (an address, a key),
# so it is written with owner-only permissions and its contents are not shown:
# this prints counts only.
#
# The project comes from $FLEET_SUPABASE_PROJECT_REF, else supabase/.temp/project-ref,
# else NEXT_PUBLIC_SUPABASE_URL in .env.local.
# The last line is always schema_dump=ok|stop.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
finish() { echo "schema_dump=$1"; exit "$2"; }
OUT="${1:-${XDG_CONFIG_HOME:-$HOME/.config}/fleet/schema-dump.json}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT";; esac
case "$OUT" in "$ROOT"/*) echo "STOP: write it outside the repository ($ROOT), so it cannot be committed."; finish stop 2;; esac

REF="${FLEET_SUPABASE_PROJECT_REF:-}"
[ -n "$REF" ] || { [ -r "$ROOT/supabase/.temp/project-ref" ] && REF="$(tr -d '[:space:]' < "$ROOT/supabase/.temp/project-ref")"; }
[ -n "$REF" ] || { [ -r "$ROOT/.env.local" ] && REF="$(sed -n 's#^NEXT_PUBLIC_SUPABASE_URL=["'"'"']\{0,1\}https://\([a-z0-9]\{20\}\)\.supabase\.co.*#\1#p' "$ROOT/.env.local" | head -1)"; }
case "$REF" in *[!a-z0-9]*|"") echo "STOP: could not tell which Supabase project to read. Set FLEET_SUPABASE_PROJECT_REF, or put NEXT_PUBLIC_SUPABASE_URL in .env.local."; finish stop 1;; esac
API="${FLEET_SUPABASE_API:-https://api.supabase.com}/v1/projects/$REF/database/query"

RAW="${SUPABASE_ACCESS_TOKEN:-$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null)}"
[ -n "$RAW" ] || { echo "STOP: no Supabase login found. Run: supabase login"; finish stop 1; }
token() { case "$RAW" in go-keyring-base64:*) printf '%s' "${RAW#go-keyring-base64:}" | base64 -d ;; *) printf '%s' "$RAW" ;; esac; }

WORK="$(mktemp -d)"; trap 'rm -rf "${WORK:?}"' EXIT
ask() {  # sql file -> reply file; prints the HTTP code
  python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' "$1" > "$WORK/body.json"
  # The login is a header on curl's standard input (-H @-); printf is part of bash.
  printf 'Authorization: Bearer %s\n' "$(token)" | curl -s -o "$2" -w "%{http_code}" -X POST "$API" -H @- -H "Content-Type: application/json" --data-binary @"$WORK/body.json"
}

CODE="$(ask "$HERE/dump-schema.sql" "$WORK/schema.json")"
case "$CODE" in 200|201) ;; *) echo "STOP: the database did not answer the structure query (HTTP $CODE):"; head -c 300 "$WORK/schema.json"; echo; finish stop 1;; esac
# Scheduled jobs live in pg_cron's own table, which is absent when pg_cron is off: asked separately so that is not an error.
echo "select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'command', command, 'active', active) order by jobname), '[]'::jsonb) as jobs from cron.job" > "$WORK/cron.sql"
CRON="$(ask "$WORK/cron.sql" "$WORK/cron.json")"

mkdir -p "$(dirname "$OUT")" || finish stop 1
python3 - "$WORK/schema.json" "$WORK/cron.json" "$CRON" "$OUT" <<'PY'
import json, os, sys
schema_file, cron_file, cron_code, out = sys.argv[1:5]
try:
    rows = json.load(open(schema_file))
    dump = rows[0]["dump"] if isinstance(rows, list) else rows["dump"]
    if isinstance(dump, str): dump = json.loads(dump)
    assert isinstance(dump.get("tables"), list)
except Exception as e:
    print(f"STOP: the reply was not the document expected ({type(e).__name__}). Nothing was written."); sys.exit(1)
jobs, cron_note = None, "pg_cron is not installed, or its table could not be read"
if cron_code in ("200", "201"):
    try:
        rows = json.load(open(cron_file)); jobs = rows[0]["jobs"] if isinstance(rows, list) else rows["jobs"]
        if isinstance(jobs, str): jobs = json.loads(jobs)
        cron_note = f"{len(jobs)} scheduled jobs"
    except Exception: jobs = None
dump["cron_jobs"] = jobs
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(dump, f, indent=1)
os.chmod(out, 0o600)
t = dump["tables"]
print(f"Wrote {out}")
print(f"  {len(t)} tables, {sum(len(x['columns']) for x in t)} columns, {sum(len(x['constraints']) for x in t)} constraints, "
      f"{sum(len(x['indexes']) for x in t)} indexes, {sum(len(x['policies']) for x in t)} access rules on {sum(1 for x in t if x['rls'])} tables with row security")
print(f"  {len(dump['functions'])} functions, {sum(len(x['triggers']) for x in t)} triggers (+{len(dump['outside_triggers'])} on other schemas), "
      f"{len(dump['views'])} views, {len(dump['enums'])} enums, {len(dump['extensions'])} extensions, {len(dump['publications'])} tables published for live updates")
print(f"  {cron_note}; Postgres {dump.get('server_version')}")
print("  No rows were read. The file is yours alone to read (mode 600); do not commit it.")
PY
[ $? = 0 ] || finish stop 1
finish ok 0
