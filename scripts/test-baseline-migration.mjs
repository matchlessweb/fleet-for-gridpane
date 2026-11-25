// Proves the migrations: run the baseline on an EMPTY Postgres in memory (PGlite),
// capture the structure it built with scripts/dump-schema.sql, and compare that
// with supabase/schema.snapshot.json. Then run every later migration on top, in
// order, the way a new install does. Touches no real database.
//
//   PGLITE_DIR=/path/with/node_modules node scripts/test-baseline-migration.mjs
//   ... --against capture   # (or a file) compare a fresh capture with what ALL the migrations build:
//                           # "capture" is where npm run schema:dump writes: ~/.config/fleet/schema-dump.json, under $XDG_CONFIG_HOME when set
//                                                    # has the live database drifted, or is a migration not applied yet?
//
// One-click sign-in's tables come from sso_schema.sql, an optional file and not a migration (SETUP.md step 11c).
// A capture that holds any table named sso_* is held to the migrations PLUS that file; a capture that holds none
// is held to the migrations alone. Only --against looks: the snapshot is always the baseline alone.
//
// BASELINE_SQL points the proof at another copy of the migration: a broken copy must fail.
// SSO_SQL points it at another copy of sso_schema.sql (scripts/test-schema-drift.mjs uses it).
// Needs @electric-sql/pglite 0.5 or later (not a dependency of the app).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { differences, normalize } from "./lib-schema-normalize.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const from = (p) => (process.env.PGLITE_DIR ? pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist", p)).href : `@electric-sql/pglite${p === "index.js" ? "" : "/" + p.replace(/\.js$/, "")}`);
const { PGlite } = await import(from("index.js"));
const { pgcrypto } = await import(from("contrib/pgcrypto.js"));

const dir = join(root, "supabase/migrations");
const file = process.env.BASELINE_SQL || join(dir, readdirSync(dir).find((f) => /_baseline\.sql$/.test(f)));
const againstArg = process.argv.indexOf("--against") > -1 ? process.argv[process.argv.indexOf("--against") + 1] || "capture" : null;
const against = againstArg === null ? null : againstArg === "capture" ? join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config"), "fleet/schema-dump.json") : resolve(againstArg.replace(/^~/, process.env.HOME));
const wantFile = against || join(root, "supabase/schema.snapshot.json");
if (!existsSync(wantFile)) { console.log(`No ${wantFile} to compare with.`); console.log("baseline: 0 checks, 1 failed"); process.exit(1); }
const want = against ? normalize(JSON.parse(readFileSync(wantFile, "utf8"))) : JSON.parse(readFileSync(wantFile, "utf8"));

let ran = 0, failed = 0;
const check = (name, ok, detail = "") => { ran++; if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n       " + detail}`); };

const db = new PGlite({ extensions: { pgcrypto } });
// What every Supabase project has before any migration runs.
await db.exec(`
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
`);
check("the database starts with no tables of its own", Number((await db.query("select count(*) n from pg_tables where schemaname = 'public'")).rows[0].n) === 0);

const sql = readFileSync(file, "utf8");
let ranOk = true;
try { await db.exec(sql); } catch (e) { ranOk = false; check("the baseline runs on an empty database", false, e.message.slice(0, 300)); }
if (!ranOk) { console.log(`baseline: ${ran} checks, ${failed} failed`); process.exit(1); }
check("the baseline runs on an empty database", true);

const capture = async () => normalize({ ...(await db.query(readFileSync(join(here, "dump-schema.sql"), "utf8"))).rows[0].dump, cron_jobs: [] });
const built = await capture();
// Every later migration, in the order of its name, each run twice: a migration must be safe to run again.
const later = process.env.BASELINE_SQL ? [] : readdirSync(dir).filter((f) => /\.sql$/.test(f) && !/_baseline\.sql$/.test(f)).sort();
const stopped = [];
for (const f of later) for (const turn of ["", " a second time"]) {
  try { await db.exec(readFileSync(join(dir, f), "utf8")); } catch (e) { stopped.push(`${f}${turn}: ${e.message.slice(0, 200)}`); }
}
// The optional file, when the capture holds its tables: run on top of the migrations, twice, as they are.
const ssoFile = process.env.SSO_SQL || join(root, "sso_schema.sql");
const ssoIn = against ? want.tables.filter((t) => t.name.startsWith("sso_")).map((t) => t.name) : [];
const ssoStopped = [], ssoAdds = [];
if (ssoIn.length) {
  const before = new Set((await capture()).tables.map((t) => t.name));
  if (!existsSync(ssoFile)) ssoStopped.push(`there is no ${ssoFile} to run`);
  else for (const turn of ["", " a second time"]) {
    try { await db.exec(readFileSync(ssoFile, "utf8")); } catch (e) { ssoStopped.push(`sso_schema.sql${turn}: ${e.message.slice(0, 200)}`); }
  }
  ssoAdds.push(...(await capture()).tables.map((t) => t.name).filter((name) => !before.has(name)));
}
const ssoCheck = () => { if (ssoIn.length) check(`the capture holds ${ssoIn.length} of one-click sign-in's tables, so sso_schema.sql was run on top of the migrations, and run again without error`, ssoStopped.length === 0, ssoStopped.join("\n       ")); };
// With --against, the capture is held to everything the migrations build; without it, the snapshot is held to the baseline alone.
const got = against ? await capture() : built;
// pg_cron is not offered here, so the jobs are compared as text: each one is in the file as captured.
const jobs = want.cron_jobs || [];
check(`each of the ${jobs.length} scheduled jobs is in the file, name, schedule and command`, jobs.every((j) => sql.includes(`'${j.name}', '${j.schedule}', $job$`) && sql.includes(j.command)));

const total = (n, key) => n.tables.reduce((a, t) => a + t[key].length, 0);
for (const part of ["tables", "functions", "views", "enums", "sequences", "outside_triggers", "publications"]) {
  const diff = differences(want[part], got[part], part);
  const size = part === "tables" ? `${want.tables.length} tables, ${total(want, "columns")} columns, ${total(want, "constraints")} constraints, ${total(want, "indexes")} indexes, ${total(want, "policies")} access rules, ${total(want, "grants")} grants` : `${want[part].length}`;
  check(`${part} are the same (${size})`, diff.length === 0, diff.slice(0, 12).join("\n       ") + (diff.length > 12 ? `\n       … and ${diff.length - 12} more` : ""));
}
check("every table has row security on", got.tables.every((t) => t.rls), got.tables.filter((t) => !t.rls).map((t) => t.name).join(", "));
if (later.length) {
  const end = against ? got : await capture();
  check(`the ${later.length} later migrations run on top, in order, and run again without error (${later.join(", ")})`, stopped.length === 0, stopped.join("\n       "));
  ssoCheck();
  // A table the optional file adds may be closed the other way: row security on, no access rule at all (so no row is
  // ever shown) and no privilege for a browser's role or for everyone. Every other table needs a rule that narrows it.
  const browser = (g) => /^(anon|authenticated|PUBLIC):/.test(g);
  const closed = end.tables.filter((t) => ssoAdds.includes(t.name) && t.rls && t.policies.length === 0 && !t.grants.some(browser)).map((t) => t.name);
  const bare = end.tables.filter((t) => !closed.includes(t.name) && (!t.rls || !t.policies.some((p) => p.permissive === false))).map((t) => t.name);
  check(`after them, every one of the ${end.tables.length} tables has row security on and a rule that narrows it${closed.length ? ` (the ${closed.length} that sso_schema.sql adds have no access rule and no privilege for a browser instead: ${closed.join(", ")})` : ""}`, bare.length === 0, bare.join(", "));
  const anon = end.tables.filter((t) => t.grants.some((g) => g.startsWith("anon:"))).map((t) => t.name);
  check("after them, a signed-out caller holds no privilege on any table", anon.length === 0, anon.join(", "));
  const everyone = end.functions.filter((f) => f.may_run.includes("PUBLIC")).map((f) => f.name);
  check(`after them, no function is left for everyone to run (${end.functions.length} functions)`, everyone.length === 0, everyone.join(", "));
  check("after them, the settings row the dashboard needs exists, once", Number((await db.query("select count(*) n from public.app_settings")).rows[0].n) === 1);
} else ssoCheck();

console.log(`baseline: ${ran} checks, ${failed} failed${against ? "  (compared with a capture, not the snapshot)" : ""}`);
process.exit(failed ? 1 : 0);
