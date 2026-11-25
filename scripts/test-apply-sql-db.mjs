// Proves what scripts/apply-sql.sh really sends, by running it in a Postgres in memory (PGlite).
// The script is run with a stand-in keychain and a stand-in curl that keeps the request, so
// nothing reaches a real database or reads a real login.          npm run sql:test
//
//   node scripts/test-apply-sql-db.mjs              # the checks
//   node scripts/test-apply-sql-db.mjs --controls   # broken copies of the script: each must fail a check
//
// APPLY_SQL points the checks at another copy of the script (the controls use it).
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { differences, normalize } from "./lib-schema-normalize.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const real = join(here, "apply-sql.sh");
const work = mkdtempSync(join(tmpdir(), "apply-sql-db-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

if (process.argv.includes("--controls")) {
  // Each break is one thing the script must not do. The checks run against the copy and must fail.
  const source = readFileSync(real, "utf8");
  const CONTROLS = [
    ["the file is sent as bare statements again", 'run_it = f"do ${mark}_do$ begin execute ${mark}_sql${sql}${mark}_sql$; end ${mark}_do$;"', "run_it = sql"],
    ["a dry run commits", '"\\nrollback;" if', '"\\ncommit;" if'],
    ["a real run is rolled back", 'else "\\ncommit;")', 'else "\\nrollback;")'],
    // Leaving "begin;" out is not here: the request is still one implicit transaction, so nothing a check can see changes.
    ["the login is put on curl's command line as well", "    -H @- \\\n", '    -H @- -H "X-Also: $(token)" \\\n'],
    ["the login is sent under another header name", "printf 'Authorization: Bearer %s\\n'", "printf 'X-Login: %s\\n'"],
    ["curl is not told to read the header", "    -H @- \\\n", ""],
  ];
  copyFileSync(join(here, "lib-fleet-project.sh"), join(work, "lib-fleet-project.sh"));
  let caught = 0;
  for (const [name, from, to] of CONTROLS) {
    if (!source.includes(from)) { console.log(`  MISSED  ${name}  (the line to break was not found: fix the control)`); continue; }
    const copy = join(work, "apply-sql.sh");
    writeFileSync(copy, source.replace(from, to));
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8", env: { ...process.env, APPLY_SQL: copy } });
    const failing = (r.stdout.match(/^  FAIL/gm) || []).length;
    if (r.status !== 0 && failing) caught++;
    console.log(`  ${r.status !== 0 && failing ? "caught" : "MISSED"}  ${name}  (${failing} failing)`);
  }
  console.log(`${CONTROLS.length} broken copies: ${caught} caught, ${CONTROLS.length - caught} missed`);
  process.exit(caught === CONTROLS.length ? 0 : 1);
}

const SCRIPT = process.env.APPLY_SQL ? resolve(process.env.APPLY_SQL) : real;
const bin = join(work, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "security"), `#!/bin/sh\necho "go-keyring-base64:${Buffer.from("made-up-login").toString("base64")}"\n`);
// The stand-in curl keeps the request body, its own arguments, and what it was told to read from standard input (-H @-).
writeFileSync(join(bin, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CURL_ARGS"\nwhile [ $# -gt 0 ]; do\n  case "$1" in --data-binary) cp "${2#@}" "$CURL_BODY";; -o) : > "$2";; -H) [ "$2" = "@-" ] && cat > "$CURL_STDIN";; esac\n  shift\ndone\nprintf 201\n');
chmodSync(join(bin, "security"), 0o755); chmodSync(join(bin, "curl"), 0o755);

let made = 0;
/** What the script would send for this SQL: the query text, or null when it refused before sending. */
function sent(sqlOrFile, dry, isFile = false) {
  const file = isFile ? sqlOrFile : join(work, `f${++made}.sql`);
  if (!isFile) writeFileSync(file, sqlOrFile);
  const body = join(work, `body${++made}.json`), args = join(work, `args${made}.txt`), stdin = join(work, `stdin${made}.txt`);
  const r = spawnSync("bash", [SCRIPT, file, ...(dry ? ["--dry-run"] : [])], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEET_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst", CURL_BODY: body, CURL_ARGS: args, CURL_STDIN: stdin, SUPABASE_ACCESS_TOKEN: "" } });
  let query = null;
  try { query = JSON.parse(readFileSync(body, "utf8")).query; } catch { query = null; }
  const text = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  return { code: r.status, query, args: text(args), stdin: text(stdin), printed: `${r.stdout}${r.stderr}` };
}

// What every Supabase project has before any migration runs (as in test-baseline-migration.mjs).
const PRELUDE = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
  grant usage on schema public, extensions, auth to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
  -- Where the sign-in service keeps each account's second factors. No browser role may read it.
  create type auth.factor_type as enum ('totp', 'webauthn', 'phone'); create type auth.factor_status as enum ('unverified', 'verified');
  create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type auth.factor_type not null, status auth.factor_status not null);
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
`;
const fresh = async (prelude = false) => { const db = new PGlite({ extensions: { pgcrypto } }); if (prelude) await db.exec(PRELUDE); return db; };
/** Run a request the way the database's query endpoint does: the whole text at once. Returns the error, or "". */
async function give(db, query) {
  let err = "";
  try { await db.exec(query); } catch (e) { err = e.message; }
  try { await db.exec("rollback"); } catch { /* no transaction was left open */ }
  return err;
}
const kept = async (db) => (await db.query("select coalesce(string_agg(tablename, ',' order by tablename), '') t from pg_tables where schemaname = 'public'")).rows[0].t;
const capture = async (db) => JSON.stringify(normalize({ ...(await db.query(readFileSync(join(here, "dump-schema.sql"), "utf8"))).rows[0].dump, cron_jobs: [] }));

let ran = 0, failed = 0;
const check = (name, ok, detail = "") => { ran++; if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n       " + detail}`); };

// 1. Files that end the transaction themselves, in the spellings the line check does not name.
const ENDS = {
  "COMMIT TRANSACTION": "create table public.leak (a int);\nCOMMIT TRANSACTION;",
  "END": "create table public.leak (a int);\nEND;",
  "END TRANSACTION": "create table public.leak (a int);\nend transaction;",
  "COMMIT WORK": "create table public.leak (a int);\ncommit work;",
  "COMMIT AND CHAIN": "create table public.leak (a int);\ncommit and chain;",
  "a COMMIT after another statement on its line": "create table public.leak (a int);\nselect 1; commit;",
  "BEGIN WORK ... COMMIT WORK": "BEGIN WORK;\ncreate table public.leak (a int);\nCOMMIT WORK;",
  "START TRANSACTION with a level": "create table public.leak (a int);\nstart transaction isolation level serializable;\ncommit work;",
  "ABORT, then more": "create table public.gone (a int);\nABORT;\ncreate table public.leak (a int);\nend;",
  "ROLLBACK WORK, then more": "create table public.gone (a int);\nrollback work;\ncreate table public.leak (a int);\nend;",
  "a DO block that commits": "create table public.leak (a int);\ndo $$ begin commit; end $$;",
  "a procedure that commits": "create table public.leak (a int);\ncreate procedure public.p() language plpgsql as $$ begin commit; end $$;\ncall public.p();",
};
const dryLeft = [], dryQuiet = [], realLeft = [], notSent = [];
for (const [name, sql] of Object.entries(ENDS)) {
  for (const dry of [true, false]) {
    const s = sent(sql, dry);
    if (s.query === null) { notSent.push(name); continue; } // refused before sending: nothing can be kept
    const db = await fresh(); const err = await give(db, s.query); const left = await kept(db); await db.close();
    if (left) (dry ? dryLeft : realLeft).push(`${name}: ${left}`);
    if (dry && !err) dryQuiet.push(name);
  }
}
const n = Object.keys(ENDS).length;
check(`a dry run of a file that ends the transaction itself keeps nothing (${n} spellings)`, dryLeft.length === 0, dryLeft.join("; "));
check("the database refuses each one, so the script reports a failure and never a clean dry run", dryQuiet.length === 0, dryQuiet.join("; "));
check("a real run of the same files keeps nothing either: all of a file, or none", realLeft.length === 0, realLeft.join("; "));
check("these spellings do reach the database: the line check alone would not have stopped them", notSent.length === 0, notSent.join("; "));

// 2. An ordinary file, with the quoting a migration uses.
const PLAIN = "create table public.t (id int primary key, note text default 'a $ sign; and a semicolon');\ninsert into public.t (id) values (1), (2);\ncreate function public.f() returns int language sql as $fn$ select count(*)::int from public.t $fn$;\ndo $do$\nbegin\n  perform public.f();\nend $do$;\n";
{
  const db = await fresh(); const err = await give(db, sent(PLAIN, true).query);
  check("a dry run of an ordinary file runs without error and keeps nothing", !err && (await kept(db)) === "", err || (await kept(db)));
  const err2 = await give(db, sent(PLAIN, false).query);
  const rows = await db.query("select public.f() n").then((r) => Number(r.rows[0].n), () => -1); // -1: the function is not there
  check("a real run of the same file keeps all of it: the table, its rows and its function", !err2 && rows === 2, err2 || String(rows));
  const err3 = await give(db, sent("create table public.second (a int);\ninsert into public.t (id) values (1);\n", false).query);
  check("a real run that fails on its last statement keeps none of that file", !!err3 && (await kept(db)) === "t", `${err3.slice(0, 80)} | ${await kept(db)}`);
  await db.close();
}

// 3. The project's own migrations, sent the way the script sends them, build what they build when run directly.
{
  const dir = join(root, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => /\.sql$/.test(f)).sort().map((f) => join(dir, f));
  const direct = await fresh(true), through = await fresh(true), stopped = [];
  for (const f of files) {
    try { await direct.exec(readFileSync(f, "utf8")); } catch (e) { stopped.push(`directly, ${f.replace(dir + "/", "")}: ${e.message.slice(0, 120)}`); }
    const dryErr = await give(through, sent(f, true, true).query);
    const before = await kept(through);
    const err = await give(through, sent(f, false, true).query);
    if (dryErr) stopped.push(`dry run, ${f.replace(dir + "/", "")}: ${dryErr.slice(0, 120)}`);
    if (err) stopped.push(`through the script, ${f.replace(dir + "/", "")}: ${err.slice(0, 120)}`);
    if (files.indexOf(f) === 0 && before !== "") stopped.push(`the dry run of the first migration kept tables: ${before}`);
  }
  check(`each of the ${files.length} migrations runs through the script, dry and for real, in order`, stopped.length === 0, stopped.join("\n       "));
  const a = JSON.parse(await capture(direct)), b = JSON.parse(await capture(through));
  const diff = ["tables", "functions", "views", "enums", "sequences", "outside_triggers", "publications"].flatMap((part) => differences(a[part], b[part], part));
  check(`sent through the script they build the same structure as run directly (${a.tables.length} tables, ${a.functions.length} functions)`, a.tables.length > 0 && diff.length === 0, diff.slice(0, 8).join("\n       "));
  const down = join(root, "supabase/rollbacks/20261121000000_strong_session.sql");
  const was = await capture(through);
  const err = await give(through, sent(down, true, true).query);
  check("a dry run of the rollback file on top runs without error and changes nothing", !err && (await capture(through)) === was, err.slice(0, 160));
  await direct.close(); await through.close();
}

// 4. The login: curl is handed it on standard input, never as an argument another program could read.
{
  const LOGIN = "made-up-login";
  for (const dry of [true, false]) {
    const s = sent(PLAIN, dry), how = dry ? "a dry run" : "a real run";
    check(`${how}: the login is in none of curl's arguments (${s.args.split("\n").filter(Boolean).length} looked at)`, s.args.includes("--data-binary") && !s.args.includes(LOGIN), s.args.replace(/\n/g, " ").slice(0, 200));
    check(`${how}: it reaches curl on standard input, as the Authorization header and nothing else`, s.stdin === `Authorization: Bearer ${LOGIN}\n`, JSON.stringify(s.stdin.replace(LOGIN, "<the login>")));
    check(`${how}: curl is told to read a header from standard input, and the login is not printed`, /(^|\n)-H\n@-\n/.test(s.args) && !s.printed.includes(LOGIN));
  }
  const planted = spawnSync(join(bin, "curl"), ["-s", "-H", `Authorization: Bearer ${LOGIN}`, "https://db.example.com/"], { encoding: "utf8", env: { ...process.env, CURL_ARGS: join(work, "control-args.txt"), CURL_BODY: join(work, "control-body"), CURL_STDIN: join(work, "control-stdin") } });
  check("control: the stand-in curl does keep a login put among its arguments", planted.status === 0 && readFileSync(join(work, "control-args.txt"), "utf8").includes(LOGIN));
}

console.log(`apply-sql in a database: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
