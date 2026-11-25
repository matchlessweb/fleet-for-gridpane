// Proves supabase/migrations/20261122000000_authenticator_rule.sql on a real
// Postgres running in memory (PGlite). Touches no real database.
//
//   node --experimental-strip-types scripts/test-authenticator-rule.mjs
//   ... --controls     also: break a copy of the migration one way at a time; each break must be caught
//
// It builds the baseline and every migration before this one, fills every table
// with one row, gives the stand-in sign-in service accounts with every mix of
// second factors, applies the migration, and then asks the database the way a
// browser would. The database's answer is held to the app's own rule (mayUseApp
// in lib/auth-assurance.ts) for every session and every account tried.
// AUTHENTICATOR_SQL points the proof at another copy of the migration (the
// controls use it). PGLITE_DIR points at another install of @electric-sql/pglite.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { differences, normalize } from "./lib-schema-normalize.mjs";
import { mayUseApp } from "../lib/auth-assurance.ts";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const NAME = "20261122000000_authenticator_rule.sql";
const UP = process.env.AUTHENTICATOR_SQL || join(root, "supabase/migrations", NAME);
const DOWN = join(root, "supabase/rollbacks", NAME);

const CHECK_STARTS = "-- ── 3. check, or change nothing";
const noSelfCheck = (s) => s.slice(0, s.indexOf(CHECK_STARTS));
// The ways the migration could be wrong. Each is applied to a copy, and the proof must then fail.
// Where the file's own check would stop a break, the break is also tried with that check cut off:
// the proof must catch it by itself too.
const BREAKS = [
  ["the rule does not ask for an authenticator app", (s) => s.replace("    and public.account_has_authenticator(),\n", "    ,\n")],
  ["the same, with the file's own check cut off", (s) => noSelfCheck(s.replace("    and public.account_has_authenticator(),\n", "    ,\n"))],
  ["either half is enough: a strong session, or an authenticator app", (s) => noSelfCheck(s.replace("    and public.account_has_authenticator(),", "    or public.account_has_authenticator(),"))],
  ["the function runs as its caller, who may not read the factors", (s) => s.replace("stable\nsecurity definer\n", "stable\n")],
  ["the same, with the file's own check cut off", (s) => noSelfCheck(s.replace("stable\nsecurity definer\n", "stable\n"))],
  ["any confirmed factor counts as an authenticator app", (s) => s.replace("       and f.factor_type::text = 'totp'\n       and f.status::text = 'verified');\n$fn$;", "       and f.status::text = 'verified');\n$fn$;")],
  ["an authenticator app never confirmed counts", (s) => s.replace("       and f.factor_type::text = 'totp'\n       and f.status::text = 'verified');\n$fn$;", "       and f.factor_type::text = 'totp');\n$fn$;")],
  ["a security key counts as an authenticator app", (s) => s.replace("       and f.factor_type::text = 'totp'\n       and f.status::text = 'verified');\n$fn$;", "       and f.factor_type::text = 'webauthn'\n       and f.status::text = 'verified');\n$fn$;")],
  ["another account's authenticator app counts", (s) => noSelfCheck(s.replace(/     where f\.user_id = case when[^\n]*\n[^\n]*end\n       and f\.factor_type/, "     where f.factor_type"))],
  ["a token whose account id is not an id stops the query with an error", (s) => s.replace(/case when \(auth\.jwt\(\) ->> 'sub'\) ~ '[^']*'\n\s*then \(auth\.jwt\(\) ->> 'sub'\)::uuid end/, "(auth.jwt() ->> 'sub')::uuid")],
  ["a session with no claims counts", (s) => noSelfCheck(s.replace("    false);\n$fn$;\ncomment on function public.session_is_strong()", "    true);\n$fn$;\ncomment on function public.session_is_strong()"))],
  ["the new function is left for everyone to run", (s) => s.replace("revoke all on function public.account_has_authenticator() from public, anon, authenticated, service_role;\n", "")],
  ["a signed-in account may not run the new function, so every query stops with an error", (s) => noSelfCheck(s.replace("grant execute on function public.account_has_authenticator() to anon, authenticated, service_role;", "grant execute on function public.account_has_authenticator() to service_role;"))],
  ["the new function's search path is not pinned", (s) => s.replace("security definer\nset search_path = ''\n", "security definer\n")],
  ["the new function takes the account to ask about from its caller", (s) => noSelfCheck(s.replace("function public.account_has_authenticator()\nreturns boolean", "function public.account_has_authenticator(p_user uuid default null)\nreturns boolean").replace(/case when \(auth\.jwt\(\) ->> 'sub'\) ~ '[^']*'\n\s*then \(auth\.jwt\(\) ->> 'sub'\)::uuid end/, "coalesce(p_user, case when (auth.jwt() ->> 'sub') ~ '^[0-9a-fA-F-]{36}$' then (auth.jwt() ->> 'sub')::uuid end)").replaceAll("function public.account_has_authenticator() ", "function public.account_has_authenticator(uuid) "))],
  ["the file no longer checks its own result", noSelfCheck],
  ["the file does not notice that it may not read the factors", (s) => s.replace("  if not has_table_privilege(me, 'auth.mfa_factors', 'select') then", "  if false then")],
  ["the file does not notice row security hiding the factors from it", (s) => s.replace("  if row_security_active('auth.mfa_factors') then", "  if false then")],
  ["the file tries the rule as itself, not as a signed-in account", (s) => s.replace("  set local role authenticated;\n", "")],
  ["the file does not try an account that has an authenticator app", (s) => s.replace("  if someone is not null then", "  if false then")],
  ["the file does not try an account that has none", (s) => s.replace("  if public.session_is_strong() then\n    raise exception 'authenticator_rule: the new rule lets in a session whose account has no authenticator app.';", "  if false then\n    raise exception 'authenticator_rule: the new rule lets in a session whose account has no authenticator app.';")],
  ["the file leaves the transaction signed in as an account when it ends", (s) => s.replace("  execute format('set local role %I', me);\n", "")],
  ["the file leaves its own test token set when it ends", (s) => s.replace("  perform set_config('request.jwt.claims', coalesce(claims_were, ''), true);\n", "")],
];

if (process.argv.includes("--controls")) {
  const src = readFileSync(UP, "utf8"), dir = mkdtempSync(join(tmpdir(), "authenticator-controls-"));
  let caught = 0;
  for (const [name, edit] of BREAKS) {
    const broken = edit(src);
    if (broken === src) { console.log(`  MISSED  ${name}  (the break changed nothing: fix this control)`); continue; }
    const file = join(dir, "broken.sql"); writeFileSync(file, broken);
    let out = "", rc = 0;
    try { out = execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, AUTHENTICATOR_SQL: file }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { rc = e.status; out = String(e.stdout || ""); }
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
const check = (name, ok, detail = "") => { ran++; if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n       " + String(detail).slice(0, 500)}`); };
const finish = () => { console.log(`authenticator rule: ${ran} checks, ${failed} failed`); process.exit(failed ? 1 : 0); };

const db = new PGlite({ extensions: { pgcrypto } });
// What every Supabase project has before any migration runs (as in test-baseline-migration.mjs).
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
const dir = join(root, "supabase/migrations");
const files = readdirSync(dir).filter((f) => /\.sql$/.test(f)).sort();
const earlier = [...files.filter((f) => /_baseline\.sql$/.test(f)), ...files.filter((f) => !/_baseline\.sql$/.test(f) && f < NAME)];
for (const f of earlier) await db.exec(readFileSync(join(dir, f), "utf8"));
check(`the baseline and the ${earlier.length - 1} migrations before this one run first (${earlier.slice(1).join(", ")})`, earlier.length >= 3 && files.includes(NAME));
const capture = async () => normalize({ ...(await db.query(readFileSync(join(here, "dump-schema.sql"), "utf8"))).rows[0].dump, cron_jobs: [] });
const before = await capture();
const TABLES = before.tables.map((t) => t.name);

// One row in every table, written as the owner (as in test-strong-session.mjs).
const VALUE = { bigint: "1", integer: "1", smallint: "1", numeric: "1", "double precision": "1", real: "1", text: "'x'", boolean: "false", uuid: "gen_random_uuid()", jsonb: "'{}'::jsonb", "text[]": "'{}'::text[]", inet: "'203.0.113.1'::inet", "timestamp with time zone": "now()", date: "current_date" };
const SPECIAL = { ip_blocks: { server_id: "1" } };
for (const t of before.tables) for (const k of t.constraints.filter((k) => k.type === "c")) {
  const m = /\(\(?"?(\w+)"? = ANY \(ARRAY\['([^']+)'/.exec(k.def) || /\(\(?"?(\w+)"? = '([^']+)'/.exec(k.def);
  if (m) (SPECIAL[t.name] ||= {})[m[1]] = `'${m[2]}'`;
}
await db.exec("set session_replication_role = replica");
const unseeded = [], SEED = {};
for (const t of before.tables) {
  const cols = t.columns.filter((c) => !c.generated && (c.not_null && c.default == null && !c.identity || SPECIAL[t.name]?.[c.name]));
  const vals = cols.map((c) => SPECIAL[t.name]?.[c.name] ?? VALUE[c.type.replace(/\(.*\)$/, "")]);
  try {
    if (vals.some((v) => v === undefined)) throw new Error(`no value for type ${cols[vals.indexOf(undefined)].type}`);
    SEED[t.name] = cols.length ? `insert into public."${t.name}" (${cols.map((c) => `"${c.name}"`).join(", ")}) values (${vals.join(", ")})` : `insert into public."${t.name}" default values`;
    if (!Number((await db.query(`select count(*)::int n from public."${t.name}"`)).rows[0].n)) await db.exec(SEED[t.name]);
  } catch (e) { unseeded.push(`${t.name}: ${e.message.slice(0, 120)}`); }
}
await db.exec("set session_replication_role = origin");
check(`every one of the ${TABLES.length} tables holds a row to look for`, unseeded.length === 0 && TABLES.length >= 20, unseeded.join("\n       "));

/** Run a statement as a role with a session's claims, the way the database's API does. Rolled back unless keep is set. */
const as = async (role, claims, sql, params = [], keep = false) => {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [claims == null ? "" : JSON.stringify(claims)]);
    const r = await db.query(sql, params);
    await db.exec(keep ? "commit" : "rollback");
    return { ok: true, rows: r.rows, n: r.affectedRows ?? 0 };
  } catch (e) { await db.exec("rollback"); return { ok: false, code: e.code, message: e.message }; }
};
const count = async (role, claims, table) => { const r = await as(role, claims, `select count(*)::int as n from public."${table}"`); return r.ok ? r.rows[0].n : r.code; };
const tried = async (sql) => { let said = null; try { await db.exec("begin;\n" + sql + "\ncommit;"); } catch (e) { said = e.message; } await db.exec("rollback").catch(() => {}); return said; };

// Accounts, each with a different mix of second factors. [what it has, its factors, whether that is an authenticator app]
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCOUNTS = [
  ["no second factor at all", [], false],
  ["an authenticator app, confirmed", [["totp", "verified"]], true],
  ["an authenticator app started and never confirmed", [["totp", "unverified"]], false],
  ["a security key only", [["webauthn", "verified"]], false],
  ["a phone number only", [["phone", "verified"]], false],
  ["an authenticator app and a security key", [["totp", "verified"], ["webauthn", "verified"]], true],
  ["a security key, and an authenticator app never confirmed", [["webauthn", "verified"], ["totp", "unverified"]], false],
  ["two authenticator apps, one confirmed", [["totp", "unverified"], ["totp", "verified"]], true],
  ["every kind of factor, none confirmed", [["totp", "unverified"], ["webauthn", "unverified"], ["phone", "unverified"]], false],
].map(([what, factors, has], i) => ({ what, factors, has, id: id(i + 1) }));
const NONE = ACCOUNTS[0], APP = ACCOUNTS[1], HALF = ACCOUNTS[2], KEY_ONLY = ACCOUNTS[3];
const fill = async () => { await db.exec("delete from auth.mfa_factors"); for (const a of ACCOUNTS) for (const [type, status] of a.factors) await db.query("insert into auth.mfa_factors (user_id, factor_type, status) values ($1, $2, $3)", [a.id, type, status]); };
const factorsOf = (sub) => (ACCOUNTS.find((a) => a.id === String(sub).toLowerCase())?.factors || []).map(([factor_type, status]) => ({ factor_type, status }));

const password = (sub) => ({ role: "authenticated", sub, aal: "aal1", amr: [{ method: "password", timestamp: 1 }] });
const code = (sub) => ({ role: "authenticated", sub, aal: "aal2", amr: [{ method: "password", timestamp: 1 }, { method: "totp", timestamp: 2 }] });
const passkey = (sub) => ({ role: "authenticated", sub, aal: "aal1", amr: [{ method: "passkey", timestamp: 1 }] });

// ── before: the gap is real here ──
await fill();
const holeBefore = []; for (const t of TABLES) if ((await count("authenticated", passkey(NONE.id), t)) > 0) holeBefore.push(t);
check(`before the migration, a passkey session for an account with no authenticator app reads tables (${holeBefore.length} of ${TABLES.length}): the gap is real here`, holeBefore.length >= 15);
const wroteBefore = await as("authenticated", passkey(NONE.id), `update public."app_settings" set "id" = "id"`);
check("and changes the settings row", wroteBefore.ok && wroteBefore.n > 0, wroteBefore.message);
const direct = await as("authenticated", code(APP.id), "select count(*) from auth.mfa_factors");
check("control: no signed-in account can read the factors table itself", !direct.ok && direct.code === "42501", direct.message || "it was read");

const up = readFileSync(UP, "utf8");

// ── the file stops itself, changing nothing, when its rule would be wrong here ──
// It is run by a role that is not a superuser, the way a hosted database runs it.
await db.exec(`create role migrator nosuperuser nobypassrls; grant authenticated to migrator; grant usage, create on schema public to migrator; grant usage on schema auth to migrator;
  alter function public.session_is_strong() owner to migrator;`);
const asMigrator = async (sql) => { await db.exec("set role migrator"); const said = await tried(sql); await db.exec("reset role"); return said; };
const structure = async () => JSON.stringify(await capture());
const owned = await structure();
let said = await asMigrator(up);
check("run by a role that may not read the factors table, the file stops and says so", /may not read auth\.mfa_factors/.test(said || ""), said || "it ran to the end");
check("and has changed nothing", (await structure()) === owned);
await db.exec("grant select on auth.mfa_factors to migrator; alter table auth.mfa_factors enable row level security;");
said = await asMigrator(up);
check("run by a role that row security hides the factors from, the file stops and says so (it would have found nobody to try, and passed)", /row security hides auth\.mfa_factors/.test(said || ""), said || "it ran to the end");
check("and has changed nothing", (await structure()) === owned);
await db.exec("alter table auth.mfa_factors disable row level security;");
said = await asMigrator(up.replace("stable\nsecurity definer\n", "stable\n"));
check("a copy whose function runs as its caller stops itself: tried as a signed-in account, the rule cannot read the factors", said !== null && (await structure()) === owned, said || "it ran to the end");
said = await asMigrator(up.replace("    and public.account_has_authenticator(),\n", "    ,\n"));
check("a copy whose rule does not ask for an authenticator app stops itself", /lets in a session whose account has no authenticator app/.test(said || "") && (await structure()) === owned, said || "it ran to the end");
said = await asMigrator(up.replace("       and f.status::text = 'verified');\n$fn$;", "       and f.status::text = 'confirmed');\n$fn$;"));
check("a copy whose rule would turn away an account that has an authenticator app stops itself, before it empties a dashboard", /turns away a session with a one-time code/.test(said || "") && (await structure()) === owned, said || "it ran to the end");
said = await asMigrator(up);
check("with the factors readable, the same role runs the file to the end", said === null, said);
// Put the stand-in back as a hosted database has it, undo that run, and go on as the owner.
await db.exec(readFileSync(DOWN, "utf8"));
await db.exec(`alter function public.session_is_strong() owner to ${(await db.query("select current_user u")).rows[0].u}; revoke all on auth.mfa_factors from migrator; revoke all on schema public from migrator; revoke all on schema auth from migrator; drop role migrator;`);
check("control: with that undone, the structure is as the earlier migrations left it", JSON.stringify(await capture()) === JSON.stringify(before), differences(before.functions, (await capture()).functions, "functions").slice(0, 5).join("\n       "));

// ── a new install: no account has set anything up yet ──
await db.exec("delete from auth.mfa_factors");
said = await tried(up);
check("on a new install, with no account set up yet, the file runs", said === null, said);
const lone = await as("authenticated", code(NONE.id), "select public.session_is_strong() as s");
check("and nobody is let in until an account has an authenticator app", lone.ok && lone.rows[0].s === false, lone.message);
await fill();
// Run inside a transaction that goes on afterwards, the way a tool that records the migration does:
// whatever comes next must not find itself signed in as an account, or holding the file's test token.
const MINE = '{"role":"service_role","note":"set before the file ran"}';
try {
  await db.exec("begin");
  const was = (await db.query("select current_user as u, set_config('request.jwt.claims', $1, true) as c", [MINE])).rows[0];
  await db.exec(up);
  const now = (await db.query("select current_user as u, current_setting('request.jwt.claims', true) as c")).rows[0];
  await db.exec("commit");
  check("it runs again, with accounts to try, without error", true);
  check("and leaves the transaction it ran in as it found it: the same role, the same claims", now.u === was.u && now.c === MINE, JSON.stringify(now));
} catch (e) { await db.exec("rollback").catch(() => {}); check("it runs again, with accounts to try, without error", false, e.message); finish(); }
const after = await capture();

// ── structure ──
const fn = (n) => after.functions.find((f) => f.name === n);
const has = fn("account_has_authenticator");
check("the new function takes no argument: it can only be asked about the caller's own token", !!has && has.args === "" && after.functions.filter((f) => f.name === "account_has_authenticator").length === 1, has ? `args: ${has.args}` : "it is not there");
check("it runs as its owner, with its search path pinned to nothing", has?.security_definer === true && /SET search_path TO ''/.test(has?.def || ""), has?.def);
check("signed-out and signed-in callers and the service may run it, and it is not left open to everyone", has?.may_run.join() === "anon,authenticated,service_role");
check("the rule's own function still runs as its caller, and now asks the new one", fn("session_is_strong")?.security_definer === false && /public\.account_has_authenticator\(\)/.test(fn("session_is_strong").def) && fn("session_is_strong").may_run.join() === "anon,authenticated,service_role");
const open = after.functions.filter((f) => f.may_run.includes("PUBLIC")).map((f) => f.name);
check(`no function is left for everyone to run (${after.functions.length} functions)`, open.length === 0 && after.functions.length === before.functions.length + 1, open.join(", "));
const others = (c) => JSON.stringify({ ...c, functions: c.functions.filter((f) => f.name !== "session_is_strong" && f.name !== "account_has_authenticator") });
check(`nothing else moved: all ${after.tables.length} tables, their rules and privileges, the other ${before.functions.length - 1} functions and the published tables are as they were`, others(after) === others(before), differences(JSON.parse(others(before)), JSON.parse(others(after))).slice(0, 6).join("\n       "));
const ruled = after.tables.filter((t) => t.policies.some((p) => p.name === "strong session only" && p.permissive === false && /session_is_strong/.test(p.using || "") && /session_is_strong/.test(p.check || ""))).length;
check(`every table still carries the restrictive rule that calls it (${ruled} of ${after.tables.length})`, ruled === after.tables.length);

// ── the rule, and the app's copy of it: every session with every account ──
// [what the session is, its claims without the account, whether that session is strong]
const SESSIONS = [
  ["a one-time code was entered (level 2)", { aal: "aal2", amr: [{ method: "password", timestamp: 1 }, { method: "totp", timestamp: 2 }] }, true],
  ["level 2 with no list of methods", { aal: "aal2" }, true],
  ["a passkey sign-in", { aal: "aal1", amr: [{ method: "passkey", timestamp: 1 }] }, true],
  ["a passkey, methods listed as plain words", { aal: "aal1", amr: ["passkey"] }, true],
  ["a passkey among other methods", { aal: "aal1", amr: [{ method: "password", timestamp: 1 }, { method: "passkey", timestamp: 2 }] }, true],
  ["a password only", { aal: "aal1", amr: [{ method: "password", timestamp: 1 }] }, false],
  ["an emailed code or link", { aal: "aal1", amr: [{ method: "otp", timestamp: 1 }] }, false],
  ["a refreshed password session", { aal: "aal1", amr: [{ method: "password", timestamp: 1 }, { method: "token_refresh", timestamp: 2 }] }, false],
  ["a method that only resembles a passkey", { aal: "aal1", amr: [{ method: "passkey2" }, { method: "PASSKEY" }, { name: "passkey" }] }, false],
  ["the level in capitals", { aal: "AAL2" }, false],
  ["no level and no methods", {}, false],
  ["methods that are not a list", { aal: "aal1", amr: "passkey" }, false],
];
const wrongSql = [], wrongApp = [], errored = [];
let asked = 0, yes = 0;
for (const a of ACCOUNTS) for (const [name, claims, strong] of SESSIONS) {
  const token = { role: "authenticated", sub: a.id, ...claims }, want = strong && a.has, label = `${name}, for an account with ${a.what}`;
  const r = await as("authenticated", token, "select public.session_is_strong() as s");
  asked++;
  if (!r.ok) { errored.push(`${label}: ${r.message}`); continue; }
  if (r.rows[0].s) yes++;
  if (r.rows[0].s !== want) wrongSql.push(`${label}: database says ${r.rows[0].s}`);
  const app = mayUseApp({ currentLevel: token.aal ?? null, currentAuthenticationMethods: token.amr }, factorsOf(a.id));
  if (app !== r.rows[0].s) wrongApp.push(`${label}: app ${app}, database ${r.rows[0].s}`);
}
const wantYes = ACCOUNTS.filter((a) => a.has).length * SESSIONS.filter((s) => s[2]).length;
check(`the rule answers without an error for every session with every account (${SESSIONS.length} sessions × ${ACCOUNTS.length} accounts = ${asked})`, errored.length === 0 && asked === SESSIONS.length * ACCOUNTS.length, errored.slice(0, 6).join("\n       "));
check(`it says yes to exactly the ${wantYes} that are a strong session for an account with a confirmed authenticator app, and no to the other ${asked - wantYes}`, wrongSql.length === 0 && yes === wantYes, wrongSql.slice(0, 8).join("\n       "));
check("the app's own rule (mayUseApp in lib/auth-assurance.ts) agrees with the database on every one", wrongApp.length === 0, wrongApp.slice(0, 8).join("\n       "));

// Tokens whose account is missing, odd, or somebody else's. None may be let in, and none may stop the query with an error.
const ODD = [
  ["no account id", { role: "authenticated", aal: "aal2" }],
  ["an empty account id", { role: "authenticated", aal: "aal2", sub: "" }],
  ["an account id that is not an id", { role: "authenticated", aal: "aal2", sub: "not-an-id" }],
  ["an id with something after it", { role: "authenticated", aal: "aal2", sub: `${APP.id}' or true --` }],
  ["an account id that is a number", { role: "authenticated", aal: "aal2", sub: 7 }],
  ["an account id that is a list", { role: "authenticated", aal: "aal2", sub: [APP.id] }],
  ["an account that does not exist", { role: "authenticated", aal: "aal2", sub: id(999) }],
  ["an empty token", {}],
  ["no token at all", null],
];
const oddIn = [], oddErr = [];
for (const [name, token] of ODD) { const r = await as("authenticated", token, "select public.session_is_strong() as s"); if (!r.ok) oddErr.push(`${name}: ${r.message}`); else if (r.rows[0].s !== false) oddIn.push(name); }
check(`a token with no usable account is never let in and never stops the query with an error (${ODD.length} tried)`, oddIn.length === 0 && oddErr.length === 0, [...oddIn, ...oddErr].join("\n       "));
const upper = await as("authenticated", { ...code(APP.id.toUpperCase()) }, "select public.session_is_strong() as s");
check("the account id is read as an id, whatever its letters' case", upper.ok && upper.rows[0].s === true && mayUseApp({ currentLevel: "aal2" }, factorsOf(APP.id.toUpperCase())) === true, upper.message);
const out = await as("anon", { role: "anon" }, "select public.session_is_strong() as s, public.account_has_authenticator() as h");
check("a signed-out caller gets a plain no from both functions", out.ok && out.rows[0].s === false && out.rows[0].h === false, out.message);
const own = await as("authenticated", password(APP.id), "select public.account_has_authenticator() as h"), other = await as("authenticated", password(NONE.id), "select public.account_has_authenticator() as h");
check("asked directly, the new function answers about the caller's own account and nothing else", own.ok && own.rows[0].h === true && other.ok && other.rows[0].h === false, own.message || other.message);
const stillShut = await as("authenticated", code(APP.id), "select count(*) from auth.mfa_factors");
check("the factors table itself is still closed to every signed-in account", !stillShut.ok && stillShut.code === "42501", stillShut.message || "it was read");

// ── reading, table by table ──
const READABLE = TABLES.filter((t) => t !== "server_agent_secrets");
const WHO = [
  ["a passkey session for an account with no authenticator app (the gap)", passkey(NONE.id), false],
  ["a passkey session for an account that only started setting one up", passkey(HALF.id), false],
  ["a one-time code from a security key, with no authenticator app", code(KEY_ONLY.id), false],
  ["a password-only session for an account that has one", password(APP.id), false],
  ["a passkey session for an account that has one", passkey(APP.id), true],
  ["a session with a one-time code for an account that has one", code(APP.id), true],
];
for (const [who, token, mayRead] of WHO) {
  const wrong = [];
  for (const t of TABLES) { const n = await count("authenticated", token, t); if (mayRead ? (READABLE.includes(t) ? !(n > 0) : n !== "42501") : n !== 0 && n !== "42501") wrong.push(`${t}=${n}`); }
  check(mayRead ? `${who} reads the ${READABLE.length} tables the app shows, and is refused the agents' token table` : `${who} reads no row of any table (${TABLES.length} asked)`, wrong.length === 0, wrong.join("  "));
}
const anonIn = [], svcBlind = [];
for (const t of TABLES) { const a = await count("anon", { role: "anon" }, t), s = await count("service_role", { role: "service_role" }, t); if (a !== "42501") anonIn.push(`${t}=${a}`); if (!(s > 0)) svcBlind.push(`${t}=${s}`); }
check(`a signed-out caller is still refused on every table, and the service still reads every one (${TABLES.length} asked each)`, anonIn.length === 0 && svcBlind.length === 0, [...anonIn, ...svcBlind].join("  "));

// ── writing ──
const BROWSER = { app_settings: ["UPDATE"], ip_allowlist: ["INSERT", "UPDATE"], ip_blocks: ["INSERT", "UPDATE"], site_staging_state: ["INSERT", "UPDATE"], system_logs: ["DELETE", "INSERT", "UPDATE"] };
const col = (t) => before.tables.find((x) => x.name === t).columns.find((c) => !c.generated).name;
const attempt = async (t, what, token) => {
  if (what === "UPDATE") return as("authenticated", token, `update public."${t}" set "${col(t)}" = "${col(t)}"`);
  if (what === "DELETE") return as("authenticated", token, `delete from public."${t}"`);
  // INSERT is tried on an emptied table: emptying is the owner's job here, so only the insert itself is the account's.
  await db.exec("begin"); await db.exec(`set local session_replication_role = replica; delete from public."${t}"; set local session_replication_role = origin`);
  try { await db.exec("set local role authenticated"); await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(token)]); const r = await db.query(SEED[t]); await db.exec("rollback"); return { ok: true, n: r.affectedRows ?? 0 }; }
  catch (e) { await db.exec("rollback"); return { ok: false, code: e.code, message: e.message }; }
};
const holeDid = [], goodCould = [];
let holeTries = 0, goodTries = 0;
for (const [t, kinds] of Object.entries(BROWSER)) for (const what of ["INSERT", "UPDATE", "DELETE"]) {
  for (const token of [passkey(NONE.id), passkey(HALF.id), code(KEY_ONLY.id)]) {
    const r = await attempt(t, what, token); holeTries++;
    if (r.ok ? r.n !== 0 : r.code !== "42501") holeDid.push(`${t} ${what}: ${r.ok ? `${r.n} rows` : r.message}`);
  }
  if (kinds.includes(what)) for (const token of [passkey(APP.id), code(APP.id)]) {
    const r = await attempt(t, what, token); goodTries++;
    if (!(r.ok && r.n > 0)) goodCould.push(`${t} ${what}: ${r.ok ? `${r.n} rows` : r.message}`);
  }
}
check(`a strong session for an account with no authenticator app changes nothing in the ${Object.keys(BROWSER).length} tables the browser writes: no row added, changed or removed (${holeTries} tries, the allowlist, the blocks and the settings among them)`, holeDid.length === 0 && holeTries === 45, holeDid.join("\n       "));
check(`an account that has one can still do each of the 10 things the app does from the browser, with a code and with a passkey (${goodTries} tries)`, goodCould.length === 0 && goodTries === 20, goodCould.join("\n       "));

// ── the answer follows the account, not the token ──
await db.query("delete from auth.mfa_factors where user_id = $1", [APP.id]);
const removed = await count("authenticated", code(APP.id), "servers");
check("when an account's authenticator app is removed, a session it already has open is shut out at once", removed === 0, String(removed));
await db.query("insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')", [NONE.id]);
const gained = await count("authenticated", passkey(NONE.id), "servers");
check("and when an account sets one up, its strong session is let in without signing in again", gained > 0, String(gained));
await fill();

// ── undo ──
try {
  await db.exec(readFileSync(DOWN, "utf8")); await db.exec(readFileSync(DOWN, "utf8"));
  const undone = await capture(), diff = ["tables", "functions", "publications"].flatMap((part) => differences(before[part], undone[part], part));
  check("the rollback file puts both functions and everything else back exactly as the earlier migrations left them (run twice)", diff.length === 0, diff.slice(0, 8).join("\n       "));
  check("after the rollback the gap is back (so the rollback really undoes it), and a password-only session is still shut out", (await count("authenticated", passkey(NONE.id), "servers")) > 0 && (await count("authenticated", password(APP.id), "servers")) === 0);
} catch (e) { check("the rollback file runs", false, e.message); }

finish();
