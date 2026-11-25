// Proves supabase/migrations/20261121000000_strong_session.sql on a real
// Postgres running in memory (PGlite). Touches no real database.
//
//   PGLITE_DIR=/path/with/node_modules node --experimental-strip-types scripts/test-strong-session.mjs
//   ... --controls     also: break a copy of the migration one way at a time; each break must be caught
//
// It builds the baseline, fills every table with one row, applies the
// migration, and then asks the database the way a browser would: as a
// signed-out caller, as a password-only session, as a session with a one-time
// code, as a passkey session, and as the service. STRONG_SQL points the proof
// at another copy of the migration (the controls use it).
// Needs @electric-sql/pglite 0.5 or later (not a dependency of the app).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { differences, normalize } from "./lib-schema-normalize.mjs";
import { sessionIsStrong } from "../lib/auth-assurance.ts";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const UP = process.env.STRONG_SQL || join(root, "supabase/migrations/20261121000000_strong_session.sql");
const DOWN = join(root, "supabase/rollbacks/20261121000000_strong_session.sql");

// The ways the migration could be wrong. Each is applied to a copy, and the proof must then fail.
const BREAKS = [
  ["the rule is permissive, so it widens instead of narrowing", (s) => s.replace("as restrictive for all", "for all")],
  ["any assurance level counts as strong", (s) => s.replace("(auth.jwt() ->> 'aal') = 'aal2'", "(auth.jwt() ->> 'aal') like 'aal%'")],
  ["a password sign-in counts as a passkey", (s) => s.replace("end = 'passkey'", "end = 'password'")],
  ["a session with no claims counts as strong", (s) => s.replace("    false);\n$fn$;", "    true);\n$fn$;")],
  ["the rule covers reading only", (s) => s.replace("as restrictive for all to anon, authenticated", "as restrictive for select to anon, authenticated")],
  ["the rule skips signed-out callers", (s) => s.replace("for all to anon, authenticated", "for all to authenticated")],
  ["a signed-out caller keeps its table privileges", (s) => s.replace("'revoke all on table public.%I from anon, authenticated'", "'revoke all on table public.%I from authenticated'")],
  ["a signed-in account keeps every privilege, TRUNCATE included", (s) => s.replace("coalesce(browser ->> t.name, 'select')", "'all'")],
  ["the agents' token table opens to signed-in accounts", (s) => s.replace("closed constant text[] := array['server_agent_secrets']", "closed constant text[] := array[]::text[]")],
  ["a read-only table becomes writable", (s) => s.replace('"app_settings":       "select, update",', '"app_settings":       "select, update",\n    "servers":            "select, update",')],
  ["a table the browser only changes may have rows removed too", (s) => s.replace('"ip_blocks":          "select, insert, update"', '"ip_blocks":          "select, insert, update, delete"')],
  ["a signed-in account may reset a sequence", (s) => s.replace("revoke all on all sequences in schema public from anon, authenticated;", "revoke all on all sequences in schema public from anon;")],
  ["a signed-in account cannot draw the next number, so it cannot add a row", (s) => s.replace("'grant usage on sequence public.%I to authenticated'", "'revoke usage on sequence public.%I from authenticated'")],
  ["a table made later is open to signed-in accounts again", (s) => s.replace("alter default privileges in schema public revoke all on tables from anon, authenticated;", "alter default privileges in schema public revoke all on tables from anon;")],
  ["signed-in accounts may still call the agents' functions", (s) => s.replace("'revoke all on function %s from public, authenticated'", "'revoke all on function %s from public'")],
  ["the agents can no longer report", (s) => s.replace("'revoke all on function %s from public, authenticated'", "'revoke all on function %s from public, anon, authenticated'").replace("'grant execute on function %s to anon, service_role'", "'grant execute on function %s to service_role'")],
  ["a table made later is open to signed-out callers again", (s) => s.replace("alter default privileges in schema public revoke all on tables from anon, authenticated;", "alter default privileges in schema public revoke all on tables from authenticated;")],
  ["the file no longer looks at its own result", (s) => s.slice(0, s.indexOf("-- ── 5. check, or change nothing"))],
  ["what a signed-in account holds is no longer checked", (s) => s.replace("  if more is not null then", "  if false then")],
  ["only TRUNCATE, REFERENCES and TRIGGER are looked for", (s) => s.replace("unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'])", "unnest(array['truncate', 'references', 'trigger'])")],
  ["the tables no browser reads are not looked at", (s) => s.replace("and not (c.relname <> all (closed) and c.relname not like 'sso\\_%'\n              and", "and c.relname <> all (closed) and not (")],
  ["a privilege on one column is not looked for", (s) => s.replace("          or (p.name in ('select', 'insert', 'update', 'references') and has_any_column_privilege('authenticated', c.oid, p.name)))", "          )")],
  ["one table is left without the rule", (s) => s.replace("where n.nspname = 'public' and c.relkind = 'r'\n            order by c.relname\n  loop\n    execute format('alter table", "where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'sites'\n            order by c.relname\n  loop\n    execute format('alter table")],
];

if (process.argv.includes("--controls")) {
  const src = readFileSync(UP, "utf8"), dir = mkdtempSync(join(tmpdir(), "strong-controls-"));
  let caught = 0;
  for (const [name, edit] of BREAKS) {
    const broken = edit(src);
    if (broken === src) { console.log(`  MISSED  ${name}  (the break changed nothing: fix this control)`); continue; }
    const file = join(dir, "broken.sql"); writeFileSync(file, broken);
    let out = "", rc = 0;
    try { out = execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, STRONG_SQL: file }, encoding: "utf8" }); } catch (e) { rc = e.status; out = String(e.stdout || ""); }
    const fails = (out.match(/^  FAIL/gm) || []).length;
    if (rc !== 0 && fails > 0) { caught++; console.log(`  caught  ${name}  (${fails} failing)`); } else console.log(`  MISSED  ${name}  (exit ${rc})`);
  }
  console.log(`${BREAKS.length} broken copies: ${caught} caught, ${BREAKS.length - caught} missed`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

const from = (p) => (process.env.PGLITE_DIR ? pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist", p)).href : `@electric-sql/pglite${p === "index.js" ? "" : "/" + p.replace(/\.js$/, "")}`);
const { PGlite } = await import(from("index.js"));
const { pgcrypto } = await import(from("contrib/pgcrypto.js"));

let ran = 0, failed = 0;
const check = (name, ok, detail = "") => { ran++; if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n       " + String(detail).slice(0, 400)}`); };
const finish = () => { console.log(`strong session: ${ran} checks, ${failed} failed`); process.exit(failed ? 1 : 0); };

const db = new PGlite({ extensions: { pgcrypto } });
// What every Supabase project has before any migration runs.
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
  grant usage on schema public, extensions, auth to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
`);
const dir = join(root, "supabase/migrations");
const baseline = readFileSync(join(dir, readdirSync(dir).find((f) => /_baseline\.sql$/.test(f))), "utf8");
await db.exec(baseline);
const capture = async () => normalize({ ...(await db.query(readFileSync(join(here, "dump-schema.sql"), "utf8"))).rows[0].dump, cron_jobs: [] });
const before = await capture();
const TABLES = before.tables.map((t) => t.name);

// One row in every table, written as the owner. Values come from each column's type; links between tables are not enforced while seeding.
const VALUE = { bigint: "1", integer: "1", smallint: "1", numeric: "1", "double precision": "1", real: "1", text: "'x'", boolean: "false", uuid: "gen_random_uuid()", jsonb: "'{}'::jsonb", "text[]": "'{}'::text[]", inet: "'203.0.113.1'::inet", "timestamp with time zone": "now()", date: "current_date" };
const SPECIAL = { ip_blocks: { server_id: "1" } }; // table -> { column: sql value } where a CHECK needs a particular value; the words are filled from the constraints below
for (const t of before.tables) for (const k of t.constraints.filter((k) => k.type === "c")) {
  const m = /\(\(?"?(\w+)"? = ANY \(ARRAY\['([^']+)'/.exec(k.def) || /\(\(?"?(\w+)"? = '([^']+)'/.exec(k.def);
  if (m) (SPECIAL[t.name] ||= {})[m[1]] = `'${m[2]}'`;
}
await db.exec("set session_replication_role = replica");
const seeded = [], unseeded = [], SEED = {};
for (const t of before.tables) {
  const cols = t.columns.filter((c) => !c.generated && (c.not_null && c.default == null && !c.identity || SPECIAL[t.name]?.[c.name]));
  const vals = cols.map((c) => SPECIAL[t.name]?.[c.name] ?? VALUE[c.type.replace(/\(.*\)$/, "")]);
  try {
    if (vals.some((v) => v === undefined)) throw new Error(`no value for type ${cols[vals.indexOf(undefined)].type}`);
    SEED[t.name] = cols.length ? `insert into public."${t.name}" (${cols.map((c) => `"${c.name}"`).join(", ")}) values (${vals.join(", ")})` : `insert into public."${t.name}" default values`;
    await db.exec(SEED[t.name]);
    seeded.push(t.name);
  } catch (e) { unseeded.push(`${t.name}: ${e.message.slice(0, 120)}`); }
}
await db.exec("set session_replication_role = origin");
check(`every one of the ${TABLES.length} tables holds a row to look for`, unseeded.length === 0 && seeded.length >= 20, unseeded.join("\n       "));

// An agent's token, stored the way provisioning stores it.
const TOKEN = "t".repeat(40), SERVER = 1;
await db.query(`update public.server_agent_secrets set token_hash = $2 where server_id = $1`, [SERVER, createHash("sha256").update(TOKEN).digest("hex")]);

/** Run a statement (or several, in one transaction) as a role with a session's claims, the way the database's API does. Rolled back unless keep is set. */
const as = async (role, claims, sql, params = [], keep = false) => {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [claims == null ? "" : JSON.stringify(claims)]);
    let r, first;
    for (const one of [].concat(sql)) { r = await db.query(one, params); first ??= r; }
    await db.exec(keep ? "commit" : "rollback");
    return { ok: true, rows: r.rows, n: r.affectedRows ?? 0, firstN: first.affectedRows ?? 0 };
  } catch (e) { await db.exec("rollback"); return { ok: false, code: e.code, message: e.message }; }
};
const count = async (role, claims, table) => { const r = await as(role, claims, `select count(*)::int as n from public."${table}"`); return r.ok ? r.rows[0].n : r.code; };

const PASSWORD = { role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: 1 }] };
const CODE = { role: "authenticated", aal: "aal2", amr: [{ method: "password", timestamp: 1 }, { method: "totp", timestamp: 2 }] };
const PASSKEY = { role: "authenticated", aal: "aal1", amr: [{ method: "passkey", timestamp: 1 }] };

// Before: what the migration is for.
const weakBefore = []; for (const t of TABLES) if ((await count("authenticated", PASSWORD, t)) > 0) weakBefore.push(t);
check(`before the migration, a password-only session reads tables (${weakBefore.length} of ${TABLES.length}): the gap is real here`, weakBefore.length >= 15);

// A privilege handed out by another role is one this file cannot take back. It must notice, say so, and change nothing.
const up = readFileSync(UP, "utf8");
await db.exec(`create role someone_else nologin; grant select on public.servers to someone_else with grant option; set role someone_else; grant select on public.servers to anon; reset role;`);
const planted = await capture();
let stopped = null;
try { await db.exec("begin;\n" + up + "\ncommit;"); } catch (e) { stopped = e.message; }
await db.exec("rollback").catch(() => {});
const afterStop = await capture();
check("a privilege granted by another role, which a REVOKE here cannot take back, stops the migration with the reason", /still holds a privilege on: servers/.test(stopped || ""), stopped || "it ran to the end");
check("and when it stops it has changed nothing (run as one transaction, the way scripts/apply-sql.sh does)", JSON.stringify(afterStop) === JSON.stringify(planted) && JSON.stringify(planted) !== JSON.stringify(before), differences(planted.tables, afterStop.tables, "tables").slice(0, 5).join("\n       "));
await db.exec(`set role someone_else; revoke select on public.servers from anon; reset role; revoke all on public.servers from someone_else; drop role someone_else;`);
check("control: with that grant taken back, the structure is as the baseline left it", JSON.stringify(await capture()) === JSON.stringify(before));

// The same for a signed-in account: anything beyond what the app uses, left by another role, stops it too.
// [what is planted, the grant, what the migration must name]
const firstColumn = before.tables.find((t) => t.name === "servers").columns[0].name;
const LEFT = [
  ["INSERT on a table the browser only reads", "insert on public.servers", "INSERT on servers"],
  ["DELETE on a table the browser adds to and changes", "delete on public.ip_blocks", "DELETE on ip_blocks"],
  ["SELECT on the agents' token table", "select on public.server_agent_secrets", "SELECT on server_agent_secrets"],
  ["UPDATE on one column of a table the browser only reads", `update ("${firstColumn}") on public.servers`, "UPDATE on servers"],
  ["TRUNCATE on a table the browser writes", "truncate on public.system_logs", "TRUNCATE on system_logs"],
];
const leftMissed = [], leftChanged = [];
for (const [what, grant, named] of LEFT) {
  const table = grant.split(" on ")[1];
  // The other role's grant sits beside whatever the baseline gave: the migration's own REVOKE takes back the baseline's, never this one.
  await db.exec(`create role someone_else nologin; grant all on ${table} to someone_else with grant option; set role someone_else; grant ${grant} to authenticated; reset role;`);
  const was = JSON.stringify(await capture());
  let said = null;
  try { await db.exec("begin;\n" + up + "\ncommit;"); } catch (e) { said = e.message; }
  await db.exec("rollback").catch(() => {});
  if (!(said || "").includes("still holds more than the app uses") || !(said || "").includes(named)) leftMissed.push(`${what}: ${said ? said.slice(0, 160) : "it ran to the end"}`);
  if (JSON.stringify(await capture()) !== was) leftChanged.push(what);
  await db.exec(`set role someone_else; revoke ${grant} from authenticated; reset role; revoke all on ${table} from someone_else; drop role someone_else;`);
}
check(`a privilege another role left a signed-in account stops the migration and is named (${LEFT.length} kinds: ${LEFT.map((l) => l[2]).join("; ")})`, leftMissed.length === 0, leftMissed.join("\n       "));
check("and each time it stops it has changed nothing", leftChanged.length === 0, leftChanged.join(", "));
check("control: with those taken back, the structure is as the baseline left it", JSON.stringify(await capture()) === JSON.stringify(before), differences(before.tables, (await capture()).tables, "tables").slice(0, 5).join("\n       "));

try { await db.exec(up); check("the migration runs on the baseline", true); }
catch (e) { check("the migration runs on the baseline", false, e.message); finish(); }
try { await db.exec(up); check("it runs a second time without error", true); } catch (e) { check("it runs a second time without error", false, e.message); }
const after = await capture();

// ── structure ──
const rule = (t) => t.policies.find((p) => p.name === "strong session only");
const noRule = after.tables.filter((t) => { const p = rule(t); return !(p && p.permissive === false && p.cmd === "*" && p.roles.join() === "anon,authenticated" && /session_is_strong/.test(p.using || "") && /session_is_strong/.test(p.check || "")); }).map((t) => t.name);
check(`every table carries the restrictive rule, for every kind of statement, for signed-out and signed-in callers (${after.tables.length} tables)`, noRule.length === 0 && after.tables.length === TABLES.length, noRule.join(", "));
check("every table still has row security on", after.tables.every((t) => t.rls));
// What the browser does to each table (the inventory of every .from() call in app/, components/ and lib/).
const BROWSER = { app_settings: ["UPDATE"], ip_allowlist: ["INSERT", "UPDATE"], ip_blocks: ["INSERT", "UPDATE"], site_staging_state: ["INSERT", "UPDATE"], system_logs: ["DELETE", "INSERT", "UPDATE"] };
const WRITABLE = Object.keys(BROWSER);
const may = (t, what) => (BROWSER[t] || []).includes(what);
const grantsOf = (t, role) => t.grants.filter((g) => g.startsWith(role + ":")).map((g) => g.split(":")[1]).sort().join(",");
const anonLeft = after.tables.filter((t) => grantsOf(t, "anon") !== "").map((t) => t.name);
check("a signed-out caller holds no privilege on any table", anonLeft.length === 0, anonLeft.join(", "));
const wrongAuth = after.tables.filter((t) => grantsOf(t, "authenticated") !== (t.name === "server_agent_secrets" ? "" : [...(BROWSER[t.name] || []), "SELECT"].sort().join(","))).map((t) => `${t.name}=${grantsOf(t, "authenticated")}`);
check(`a signed-in account holds SELECT, plus exactly what the app uses on the ${WRITABLE.length} tables it writes from the browser, and nothing on the agents' token table`, wrongAuth.length === 0, wrongAuth.join("  "));
check("the service keeps every privilege it had", JSON.stringify(after.tables.map((t) => grantsOf(t, "service_role"))) === JSON.stringify(before.tables.map((t) => grantsOf(t, "service_role"))));
const fn = (n) => after.functions.find((f) => f.name === n);
const reports = after.functions.filter((f) => f.name.startsWith("report_"));
check(`the agents' ${reports.length} report functions may be run by a signed-out caller and the service only`, reports.length >= 6 && reports.every((f) => f.may_run.join() === "anon,service_role"), reports.map((f) => `${f.name}:${f.may_run}`).join(" "));
check("checking a token directly stays with the service", fn("verify_agent").may_run.join() === "service_role" && fn("ingest_cloudflare_waf").may_run.join() === "service_role");
const open = after.functions.filter((f) => f.may_run.includes("PUBLIC")).map((f) => f.name);
check(`no function is left for everyone to run (${after.functions.length} functions)`, open.length === 0 && after.functions.length >= 9, open.join(", "));
check("the rule's function runs as its caller, never as its owner", fn("session_is_strong")?.security_definer === false && fn("session_is_strong").may_run.join() === "anon,authenticated,service_role");
const others = (c) => JSON.stringify({ ...c, tables: c.tables.map((t) => ({ ...t, policies: t.policies.filter((p) => p.name !== "strong session only"), grants: [] })), functions: c.functions.filter((f) => f.name !== "session_is_strong").map((f) => ({ ...f, may_run: [] })) });
check("nothing else moved: columns, keys, indexes, the older rules, function bodies and published tables are as they were", others(after) === others(before), differences(JSON.parse(others(before)), JSON.parse(others(after))).slice(0, 6).join("\n       "));

// ── the rule itself, and the app's copy of it ──
const SESSIONS = [
  ["a one-time code was entered (level 2)", CODE, true],
  ["level 2 with no list of methods", { role: "authenticated", aal: "aal2" }, true],
  ["a passkey sign-in", PASSKEY, true],
  ["a passkey, methods listed as plain words", { role: "authenticated", aal: "aal1", amr: ["passkey"] }, true],
  ["a passkey among other methods", { role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: 1 }, { method: "passkey", timestamp: 2 }] }, true],
  ["a password only", PASSWORD, false],
  ["an emailed code or link", { role: "authenticated", aal: "aal1", amr: [{ method: "otp", timestamp: 1 }] }, false],
  ["a social sign-in", { role: "authenticated", aal: "aal1", amr: [{ method: "oauth", timestamp: 1 }] }, false],
  ["a refreshed password session", { role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: 1 }, { method: "token_refresh", timestamp: 2 }] }, false],
  ["a method that only resembles a passkey", { role: "authenticated", aal: "aal1", amr: [{ method: "passkey2" }, { method: "PASSKEY" }, { name: "passkey" }] }, false],
  ["the level in capitals", { role: "authenticated", aal: "AAL2" }, false],
  ["a level above 2 that does not exist", { role: "authenticated", aal: "aal3" }, false],
  ["no level and no methods", { role: "authenticated" }, false],
  ["methods that are not a list", { role: "authenticated", aal: "aal1", amr: "passkey" }, false],
  ["methods that are an object", { role: "authenticated", aal: "aal1", amr: { method: "passkey" } }, false],
  ["a list of things that are not methods", { role: "authenticated", aal: "aal1", amr: [null, 5, true, [], { method: null }, { method: 7 }] }, false],
  ["an empty token", {}, false],
  ["no token at all", null, false],
];
const wrongSql = [], wrongApp = [], errored = [];
for (const [name, claims, want] of SESSIONS) {
  const r = await as("authenticated", claims, "select public.session_is_strong() as strong");
  if (!r.ok) { errored.push(`${name}: ${r.message}`); continue; }
  if (r.rows[0].strong !== want) wrongSql.push(`${name}: database says ${r.rows[0].strong}`);
  const app = sessionIsStrong(claims == null ? null : { currentLevel: claims.aal ?? null, currentAuthenticationMethods: claims.amr });
  if (app !== r.rows[0].strong) wrongApp.push(`${name}: app ${app}, database ${r.rows[0].strong}`);
}
check(`the rule answers without an error for every shape of token tried (${SESSIONS.length})`, errored.length === 0, errored.join("\n       "));
check(`the rule is right for each of the ${SESSIONS.length} sessions (${SESSIONS.filter((s) => s[2]).length} strong, ${SESSIONS.filter((s) => !s[2]).length} not)`, wrongSql.length === 0, wrongSql.join("\n       "));
check("the app's copy of the rule (lib/auth-assurance.ts) agrees with the database on every one", wrongApp.length === 0, wrongApp.join("\n       "));
check("a signed-out caller is never strong", (await as("anon", { role: "anon" }, "select public.session_is_strong() as s")).rows?.[0]?.s === false);

// ── reading, table by table ──
const READABLE = TABLES.filter((t) => t !== "server_agent_secrets");
const leak = [], blind = [], anonIn = [], svcBlind = [], passkeyBlind = [];
for (const t of TABLES) {
  const weak = await count("authenticated", PASSWORD, t), strong = await count("authenticated", CODE, t), key = await count("authenticated", PASSKEY, t);
  const anon = await count("anon", { role: "anon" }, t), svc = await count("service_role", { role: "service_role" }, t);
  if (weak !== 0 && weak !== "42501") leak.push(`${t}=${weak}`);
  if (READABLE.includes(t) ? !(strong > 0) : strong !== "42501") blind.push(`${t}=${strong}`);
  if (READABLE.includes(t) ? !(key > 0) : key !== "42501") passkeyBlind.push(`${t}=${key}`);
  if (anon !== "42501") anonIn.push(`${t}=${anon}`);
  if (!(svc > 0)) svcBlind.push(`${t}=${svc}`);
}
check(`a password-only session reads no row of any table (${TABLES.length} asked)`, leak.length === 0, leak.join("  "));
check(`a session with a one-time code reads the ${READABLE.length} tables the app shows, and is refused the agents' token table`, blind.length === 0, blind.join("  "));
check("a passkey session reads the same", passkeyBlind.length === 0, passkeyBlind.join("  "));
check(`a signed-out caller is refused on every table, not merely shown nothing (${TABLES.length} asked)`, anonIn.length === 0, anonIn.join("  "));
check("the service still reads every table", svcBlind.length === 0, svcBlind.join("  "));

// ── writing ──
// Each statement runs in a transaction that is then undone, so every try starts from the seeded row.
const col = (t) => before.tables.find((x) => x.name === t).columns.find((c) => !c.generated).name;
const tries = (t) => ({ INSERT: [`delete from public."${t}"`, SEED[t]], UPDATE: `update public."${t}" set "${col(t)}" = "${col(t)}"`, DELETE: `delete from public."${t}"` });
const weakDid = [], strongCould = [], strongOver = [];
let allowed = 0, withheld = 0;
for (const t of READABLE) for (const what of ["INSERT", "UPDATE", "DELETE"]) {
  const sql = tries(t)[what];
  // INSERT is tried on an emptied table: emptying is the owner's job here, so only the insert itself is the account's.
  const run = async (claims) => {
    if (what !== "INSERT") return as("authenticated", claims, sql);
    await db.exec("begin"); await db.exec(`set local session_replication_role = replica; delete from public."${t}"; set local session_replication_role = origin`);
    try { await db.exec("set local role authenticated"); await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]); const r = await db.query(SEED[t]); await db.exec("rollback"); return { ok: true, n: r.affectedRows ?? 0 }; }
    catch (e) { await db.exec("rollback"); return { ok: false, code: e.code, message: e.message }; }
  };
  const w = await run(PASSWORD);
  if (w.ok ? w.n !== 0 : w.code !== "42501") weakDid.push(`${t} ${what}: ${w.ok ? `${w.n} rows` : w.message}`);
  for (const [who, claims] of [["code", CODE], ["passkey", PASSKEY]]) {
    const r = await run(claims);
    if (may(t, what)) { if (who === "code") allowed++; if (!(r.ok && r.n > 0)) strongCould.push(`${t} ${what} (${who}): ${r.ok ? `${r.n} rows` : r.message}`); }
    else { if (who === "code") withheld++; if (r.ok || r.code !== "42501" || !/permission denied/.test(r.message)) strongOver.push(`${t} ${what} (${who}): ${r.ok ? "ran" : r.message}`); }
  }
}
check(`a password-only session changes nothing: no row added, changed or removed in any table (${READABLE.length * 3} tries)`, weakDid.length === 0, weakDid.join("\n       "));
check(`a strong session can do each of the ${allowed} things the app does from the browser (tried with a code, and with a passkey)`, strongCould.length === 0 && allowed === 10, strongCould.join("\n       "));
check(`and is refused each of the other ${withheld}: adding, changing or removing rows where the app never does`, strongOver.length === 0 && withheld === READABLE.length * 3 - 10, strongOver.join("\n       "));
const seqs = (await db.query("select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S' order by 1")).rows.map((r) => r.name);
const reset = []; for (const q of seqs) { const r = await as("authenticated", CODE, `select setval('public."${q}"', 1)`); if (r.ok || r.code !== "42501") reset.push(q); }
check(`no signed-in session can reset a table's numbering (${seqs.length} sequences tried)`, reset.length === 0 && seqs.length >= 5, reset.join(", "));
const drawn = []; for (const q of seqs) { const r = await as("anon", { role: "anon" }, `select nextval('public."${q}"')`); if (r.ok || r.code !== "42501") drawn.push(q); }
check("a signed-out caller cannot touch a sequence at all", drawn.length === 0, drawn.join(", "));
const tr = []; for (const t of TABLES) { const r = await as("authenticated", CODE, `truncate public."${t}" cascade`); if (r.ok || r.code !== "42501") tr.push(t); }
check(`no signed-in session can empty a table with TRUNCATE (${TABLES.length} tried)`, tr.length === 0, tr.join(", "));

// ── the agents ──
const hw = (role, claims, token, keep = false) => as(role, claims, "select public.report_hardware($1, 4, 8000, 'maker', 'model', $2)", [SERVER, token], keep);
const good = await hw("anon", { role: "anon" }, TOKEN, true);
const landed = Number((await db.query("select count(*)::int n from public.server_hardware where server_id = $1 and vendor = 'maker'", [SERVER])).rows[0].n);
check("a server's agent, signed out but holding its token, can still report", good.ok && landed === 1, good.message);
const bad = await hw("anon", { role: "anon" }, "w".repeat(40));
check("an agent with the wrong token is refused", !bad.ok && bad.code === "42501" && /agent token/.test(bad.message), bad.message);
const user = await hw("authenticated", CODE, TOKEN);
check("a signed-in account cannot call an agent's function, even with a token", !user.ok && user.code === "42501" && /permission denied/.test(user.message), user.message || "it ran");
const probe = await as("anon", { role: "anon" }, "select public.verify_agent($1, $2)", [SERVER, TOKEN]);
check("a signed-out caller cannot test tokens directly", !probe.ok && probe.code === "42501", probe.message || "it ran");

// ── a table made later ──
await db.exec("create table public.made_later (id bigint primary key)");
await db.exec("create function public.made_later_fn() returns int language sql as 'select 1'");
const later = (await db.query("select has_table_privilege('anon', 'public.made_later', 'select') a, has_table_privilege('authenticated', 'public.made_later', 'select') u, has_table_privilege('service_role', 'public.made_later', 'select') s, (select proacl::text from pg_proc where proname = 'made_later_fn') f")).rows[0];
check("a table made after the migration starts closed to signed-out and signed-in callers, open to the service", later.a === false && later.u === false && later.s === true);
check("a function made later is not handed to signed-out or signed-in callers by name", !/anon=|authenticated=/.test(later.f || ""), later.f);
await db.exec("drop function public.made_later_fn()");
await db.exec("drop table public.made_later");

// ── undo ──
try {
  await db.exec(readFileSync(DOWN, "utf8")); await db.exec(readFileSync(DOWN, "utf8"));
  const undone = await capture(), diff = ["tables", "functions", "publications"].flatMap((part) => differences(before[part], undone[part], part));
  check("the rollback file puts every rule, privilege and function back exactly as it was (run twice)", diff.length === 0, diff.slice(0, 8).join("\n       "));
  check("after the rollback, the gap is back (so the rollback really undoes it)", (await count("authenticated", PASSWORD, "servers")) > 0);
} catch (e) { check("the rollback file runs", false, e.message); }

finish();
