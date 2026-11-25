// Proves the drift check (scripts/test-baseline-migration.mjs --against <capture>) for a database with
// and without one-click sign-in's tables. Those come from sso_schema.sql, an optional file and not a
// migration, so a capture of a database that has them must be held to the migrations PLUS that file,
// and a capture of one that does not must be held to the migrations alone. Touches no real database.
//
//   node scripts/test-schema-drift.mjs
//   ... --controls     also: break a copy of the drift check one way at a time; each break must be caught
//
// How: it builds captures itself, in a Postgres in memory (PGlite), from the baseline, the migrations and
// (for some) sso_schema.sql or a deliberately wrong copy of it, writes each to a temporary folder outside
// the repository, and runs the drift check on it. It then reads which of the check's lines passed.
//
// DRIFT_SCRIPT points the proof at another copy of the drift check (the controls use it).
// PGLITE_DIR points at another install of @electric-sql/pglite.
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalize } from "./lib-schema-normalize.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const REAL = join(here, "test-baseline-migration.mjs");
const SCRIPT = process.env.DRIFT_SCRIPT || REAL;
const MIGRATIONS = join(root, "supabase/migrations");

// The ways the drift check could be wrong. Each is applied to a copy of it, and this proof must then fail.
const BREAKS = [
  ["the optional file is never run, so a database with one-click sign-in always looks drifted", (s) => s.replace('t.name.startsWith("sso_")', 't.name.startsWith("sso_never_")')],
  ["the optional file is run for every capture, so a database without one-click sign-in looks drifted", (s) => s.replace('.filter((t) => t.name.startsWith("sso_"))', ".filter(() => true)")],
  ["the optional file is run once, not twice", (s) => s.replace('else for (const turn of ["", " a second time"]) {', 'else for (const turn of [""]) {')],
  ["a run of the optional file that stops with an error is reported as fine", (s) => s.replace("ssoStopped.length === 0, ssoStopped.join", "true, ssoStopped.join")],
  ["nothing says the optional file was run", (s) => s.replace("  ssoCheck();\n  // A table the optional file adds", "  // A table the optional file adds")],
  ["nothing says the optional file was run when there are no later migrations", (s) => s.replace("\n} else ssoCheck();\n", "\n}\n")],
  ["a table with no access rule passes even when a browser's role holds a privilege on it", (s) => s.replace(" && !t.grants.some(browser)).map", ").map")],
  ["any table may be closed the second way, not only those the optional file adds", (s) => s.replace("ssoAdds.includes(t.name) && t.rls", "t.rls")],
  ["a table with an access rule that does not narrow passes as one with no rule", (s) => s.replace(" && t.policies.length === 0 && !t.grants", " && !t.grants")],
  ["a table with row security off passes as closed", (s) => s.replace("ssoAdds.includes(t.name) && t.rls && ", "ssoAdds.includes(t.name) && ")],
  ["a privilege for everyone is not counted as a browser's", (s) => s.replace("/^(anon|authenticated|PUBLIC):/", "/^(anon|authenticated):/")],
  ["a privilege for a signed-out caller is not counted as a browser's", (s) => s.replace("/^(anon|authenticated|PUBLIC):/", "/^(authenticated|PUBLIC):/")],
  ["a privilege for a signed-in account is not counted as a browser's", (s) => s.replace("/^(anon|authenticated|PUBLIC):/", "/^(anon|PUBLIC):/")],
  ["the tables closed the second way are not named", (s) => s.replace(" instead: ${closed.join(\", \")})", " instead)")],
  ["another copy of the optional file cannot be named, so a wrong copy is never tried", (s) => s.replace('process.env.SSO_SQL || join(root, "sso_schema.sql")', 'join(root, "sso_schema.sql")')],
];

const pgliteDir = () => process.env.PGLITE_DIR || fileURLToPath(import.meta.resolve("@electric-sql/pglite")).split("/node_modules/@electric-sql/pglite/")[0];

if (process.argv.includes("--controls")) {
  const self = fileURLToPath(import.meta.url);
  const runSelf = (env) => { try { return { rc: 0, out: execFileSync(process.execPath, [self], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { return { rc: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; } };
  // The controls mean nothing unless the proof passes on the drift check as it is.
  const base = runSelf({ DRIFT_SCRIPT: "" });
  if (base.rc !== 0) { console.log("The proof does not pass on the drift check as it is, so no control was run:"); console.log(base.out.split("\n").filter((l) => /^  FAIL|^drift:/.test(l)).join("\n")); process.exit(1); }
  // A broken copy needs the files it reads beside it, laid out as in the repository.
  const mirror = mkdtempSync(join(tmpdir(), "drift-controls-"));
  mkdirSync(join(mirror, "scripts")); mkdirSync(join(mirror, "supabase/migrations"), { recursive: true });
  for (const f of ["lib-schema-normalize.mjs", "dump-schema.sql"]) copyFileSync(join(here, f), join(mirror, "scripts", f));
  for (const f of readdirSync(MIGRATIONS)) copyFileSync(join(MIGRATIONS, f), join(mirror, "supabase/migrations", f));
  copyFileSync(join(root, "supabase/schema.snapshot.json"), join(mirror, "supabase/schema.snapshot.json"));
  copyFileSync(join(root, "sso_schema.sql"), join(mirror, "sso_schema.sql"));
  const src = readFileSync(REAL, "utf8"), copy = join(mirror, "scripts/test-baseline-migration.mjs");
  let caught = 0;
  for (const [name, edit] of BREAKS) {
    const broken = edit(src);
    if (broken === src) { console.log(`  MISSED  ${name}  (the break changed nothing: fix this control)`); continue; }
    writeFileSync(copy, broken);
    const { rc, out } = runSelf({ DRIFT_SCRIPT: copy, PGLITE_DIR: pgliteDir() });
    const fails = (out.match(/^  FAIL/gm) || []).length, total = Number((/^drift: (\d+) checks/m.exec(out) || [])[1] || 0);
    // A copy that fails every check did not run at all: that is not a catch.
    if (rc !== 0 && fails > 0 && total > 0 && fails < total) { caught++; console.log(`  caught  ${name}  (${fails} of ${total} failing)`); }
    else console.log(`  MISSED  ${name}  (exit ${rc}, ${fails} of ${total} failing)`);
  }
  if (mirror.startsWith(tmpdir())) rmSync(mirror, { recursive: true, force: true });
  console.log(`${BREAKS.length} broken copies: ${caught} caught, ${BREAKS.length - caught} missed`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

const from = (p) => (process.env.PGLITE_DIR ? pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist", p)).href : `@electric-sql/pglite${p === "index.js" ? "" : "/" + p.replace(/\.js$/, "")}`);
const { PGlite } = await import(from("index.js"));
const { pgcrypto } = await import(from("contrib/pgcrypto.js"));

let ran = 0, failed = 0;
const check = (name, got, want) => {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

const DUMP = readFileSync(join(here, "dump-schema.sql"), "utf8");
const SSO = readFileSync(join(root, "sso_schema.sql"), "utf8");
const JOBS = JSON.parse(readFileSync(join(root, "supabase/schema.snapshot.json"), "utf8")).cron_jobs;
/** A capture as `npm run schema:dump` writes it, of a database built here: the migrations, then `sso` if given. */
async function build(sso = null) {
  const db = new PGlite({ extensions: { pgcrypto } });
  // What every Supabase project has before any migration runs (as in test-baseline-migration.mjs).
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema extensions; create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
    grant usage on schema public, extensions, auth to anon, authenticated, service_role;
    grant execute on function auth.jwt() to anon, authenticated, service_role;
    create type auth.factor_type as enum ('totp', 'webauthn', 'phone'); create type auth.factor_status as enum ('unverified', 'verified');
    create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type auth.factor_type not null, status auth.factor_status not null);
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  for (const f of readdirSync(MIGRATIONS).filter((f) => /\.sql$/.test(f)).sort()) await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  if (sso !== null) await db.exec(sso);
  const dump = (await db.query(DUMP)).rows[0].dump;
  await db.close();
  return { ...dump, cron_jobs: JOBS };
}

const work = mkdtempSync(join(tmpdir(), "drift-proof-"));
let files = 0;
/** Run the drift check on a capture. Gives its exit code and, for each of its lines, whether it passed. */
function drift(capture, env = {}) {
  const file = join(work, `capture-${++files}.json`);
  writeFileSync(file, JSON.stringify(capture), { mode: 0o600 });
  return new Promise((done) => execFile(process.execPath, [SCRIPT, "--against", file], { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
    const out = `${stdout || ""}${stderr || ""}`, lines = out.split("\n");
    const at = (re) => lines.findIndex((l) => /^  (ok  |FAIL) /.test(l) && re.test(l));
    const detail = (re) => { const i = at(re); if (i < 0) return ""; const d = []; for (let j = i + 1; j < lines.length && /^ {7}/.test(lines[j]); j++) d.push(lines[j].trim()); return d.join("\n"); };
    const sum = /^baseline: (\d+) checks, (\d+) failed/m.exec(out);
    done({
      rc: err ? (typeof err.code === "number" ? err.code : 1) : 0, out,
      is: (re) => { const i = at(re); return i < 0 ? "absent" : lines[i].slice(2, 6).trim(); },
      text: (re) => { const i = at(re); return i < 0 ? "" : lines[i]; },
      detail,
      failing: () => LINES.filter(([, re]) => at(re) >= 0 && lines[at(re)].startsWith("  FAIL")).map(([key]) => key),
      checks: sum ? Number(sum[1]) : -1, failed: sum ? Number(sum[2]) : -1,
    });
  }));
}
// The drift check's lines this proof reads, by a short name.
const TABLES = /tables are the same/, FUNCTIONS = /functions are the same/, SEQUENCES = /sequences are the same/, RLS = /every table has row security on/;
const NARROW = /a rule that narrows it/, SIGNED_OUT = /a signed-out caller holds no privilege/, EVERYONE = /no function is left for everyone/, RAN = /sso_schema\.sql was run on top/;
const LINES = [["tables", TABLES], ["functions", FUNCTIONS], ["sequences", SEQUENCES], ["row security", RLS], ["narrows", NARROW], ["signed-out", SIGNED_OUT], ["everyone", EVERYONE], ["optional file", RAN],
  ["starts empty", /starts with no tables/], ["baseline runs", /the baseline runs/], ["jobs", /scheduled jobs/], ["views", /views are the same/], ["enums", /enums are the same/], ["outside triggers", /outside_triggers are the same/], ["publications", /publications are the same/], ["migrations", /later migrations run on top/], ["settings row", /settings row/]];
const FIVE = ["sso_agent_secrets", "sso_audit", "sso_requests", "sso_site_policy", "sso_state"];
const size = (r, re, unit) => Number((new RegExp(`\\((\\d+)${unit}`).exec(r.text(re)) || [])[1] ?? -1);

// A wrong copy of the optional file, to prove the drift check's own rules look at what the file builds.
const wrong = (name, extra) => { const file = join(work, `sso-${name}.sql`), sql = `${SSO}\n${extra}\n`; writeFileSync(file, sql); return { file, sql }; };
const COPIES = {
  signedIn: wrong("signed-in", "grant select on public.sso_audit to authenticated;"),
  signedOut: wrong("signed-out", "grant select on public.sso_audit to anon;"),
  everyone: wrong("everyone", "grant select on public.sso_audit to public;"),
  rlsOff: wrong("rls-off", "alter table public.sso_state disable row level security;"),
  openRule: wrong("open-rule", "drop policy if exists wide_open on public.sso_requests;\ncreate policy wide_open on public.sso_requests for select to authenticated using (true);"),
  publicFunction: wrong("public-function", "grant execute on function public.sso_state_read() to public;"),
  // Leaves no trace in the structure: only the session remembers that it ran.
  onceOnly: wrong("once-only", "do $do$ begin\n  if current_setting('fleet.sso_ran', true) = 'yes' then raise exception 'this copy is not safe to run again'; end if;\n  perform set_config('fleet.sso_ran', 'yes', false);\nend $do$;"),
  // An app table left with row security on, no access rule and no browser privilege. The file did not add it.
  strippedAppTable: wrong("stripped", "do $do$ declare p record; begin\n  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'ip_blocks' loop\n    execute format('drop policy %I on public.ip_blocks', p.policyname);\n  end loop;\nend $do$;\nrevoke all on public.ip_blocks from public, anon, authenticated;"),
};

const [plain, withSso, built] = await Promise.all([build(), build(SSO), Promise.all(Object.entries(COPIES).map(async ([k, c]) => [k, await build(c.sql)])).then(Object.fromEntries)]);
const table = (c, name) => c.tables.find((t) => t.name === name), fn = (c, name) => c.functions.find((f) => f.name === name);
const changed = (edit) => { const c = structuredClone(withSso); edit(c); return c; };
check("the capture built here with the optional file holds its five tables, and the one without holds none",
  [normalize(withSso).tables.map((t) => t.name).filter((n) => n.startsWith("sso_")), normalize(plain).tables.filter((t) => t.name.startsWith("sso_")).length], [FIVE, 0]);

const [without, withIt, snapshot, missingTable, extraColumn, signedOutGrant, publicFunction, missingFunction, halfApplied, noLater,
  signedIn, signedOut, everyone, rlsOff, openRule, publicFn, onceOnly, noFile, stripped, plainWithWrongCopy] = await Promise.all([
  drift(plain), drift(withSso),
  new Promise((done) => execFile(process.execPath, [SCRIPT], { env: process.env, encoding: "utf8" }, (err, stdout) => done({ rc: err ? 1 : 0, out: stdout || "", checks: Number((/^baseline: (\d+) checks/m.exec(stdout || "") || [])[1] ?? -1) }))),
  drift(changed((c) => { c.tables = c.tables.filter((t) => t.name !== "sso_audit"); })),
  drift(changed((c) => { table(c, "sso_requests").columns.push({ ...table(c, "sso_requests").columns[0], name: "added_by_hand" }); })),
  drift(changed((c) => { table(c, "sso_state").grants.push({ role: "anon", privilege: "SELECT" }); })),
  drift(changed((c) => { fn(c, "sso_request_take").acl = fn(c, "sso_request_take").acl.replace(/\}$/, ",=X/postgres}"); })),
  drift(changed((c) => { c.functions = c.functions.filter((f) => f.name !== "sso_agent_poll"); })),
  drift(changed((c) => { c.tables = c.tables.filter((t) => !t.name.startsWith("sso_") || t.name === "sso_state"); })),
  drift(withSso, { BASELINE_SQL: join(MIGRATIONS, readdirSync(MIGRATIONS).find((f) => /_baseline\.sql$/.test(f))) }),
  drift(built.signedIn, { SSO_SQL: COPIES.signedIn.file }), drift(built.signedOut, { SSO_SQL: COPIES.signedOut.file }), drift(built.everyone, { SSO_SQL: COPIES.everyone.file }),
  drift(built.rlsOff, { SSO_SQL: COPIES.rlsOff.file }), drift(built.openRule, { SSO_SQL: COPIES.openRule.file }), drift(built.publicFunction, { SSO_SQL: COPIES.publicFunction.file }),
  drift(withSso, { SSO_SQL: COPIES.onceOnly.file }), drift(withSso, { SSO_SQL: join(work, "no-such-file.sql") }),
  drift(built.strippedAppTable, { SSO_SQL: COPIES.strippedAppTable.file }), drift(plain, { SSO_SQL: COPIES.rlsOff.file }),
]);

console.log("A database without one-click sign-in, as before:");
check("its capture passes", [without.rc, without.failed], [0, 0]);
check("the optional file is not mentioned", without.is(RAN), "absent");
check("it is held to as many checks as the snapshot is", [without.checks, snapshot.rc], [snapshot.checks, 0]);
check("the check on access rules reads as it always has", / a rule that narrows it$/.test(without.text(NARROW)), true);
check("a wrong copy of the optional file changes nothing, because the file is not run", [plainWithWrongCopy.rc, plainWithWrongCopy.failed, plainWithWrongCopy.checks], [0, 0, without.checks]);

console.log("A database with one-click sign-in:");
check("its capture passes", [withIt.rc, withIt.failed], [0, 0]);
check("a line says the optional file was run on top of the migrations, twice", [withIt.is(RAN), /holds 5 of one-click sign-in's tables/.test(withIt.text(RAN)), /run again without error/.test(withIt.text(RAN))], ["ok", true, true]);
check("that is the one check more", withIt.checks, without.checks + 1);
check("five more tables are compared", size(withIt, TABLES, " tables"), size(without, TABLES, " tables") + 5);
check("the file's nine functions are compared", [size(withIt, FUNCTIONS, ""), normalize(withSso).functions.filter((f) => f.name.startsWith("sso_")).length], [size(without, FUNCTIONS, "") + 9, 9]);
check("the five tables are named as closed with no access rule and no privilege for a browser", [withIt.is(NARROW), FIVE.filter((n) => withIt.text(NARROW).includes(n)), /the 5 that sso_schema\.sql adds/.test(withIt.text(NARROW))], ["ok", FIVE, true]);

console.log("A database with one-click sign-in that has drifted is still caught:");
check("one of the five tables is gone", [missingTable.rc, missingTable.failing(), /\/sso_audit: extra/.test(missingTable.detail(TABLES))], [1, ["tables"], true]);
check("a column was added by hand", [extraColumn.rc, extraColumn.failing(), /sso_requests.*added_by_hand: missing/.test(extraColumn.detail(TABLES))], [1, ["tables"], true]);
check("a signed-out caller was given a table", [signedOutGrant.rc, signedOutGrant.failing(), /sso_state\.grants/.test(signedOutGrant.detail(TABLES))], [1, ["tables"], true]);
check("a function was opened to everyone", [publicFunction.rc, publicFunction.failing(), /sso_request_take.*may_run/.test(publicFunction.detail(FUNCTIONS))], [1, ["functions"], true]);
check("a function is gone", [missingFunction.rc, missingFunction.failing(), /sso_agent_poll.*: extra/.test(missingFunction.detail(FUNCTIONS))], [1, ["functions"], true]);
check("the file was only half applied: the tables that are missing are named", [halfApplied.rc, halfApplied.is(RAN), ["sso_agent_secrets", "sso_audit", "sso_requests", "sso_site_policy"].filter((n) => new RegExp(`/${n}: extra`).test(halfApplied.detail(TABLES)))], [1, "ok", ["sso_agent_secrets", "sso_audit", "sso_requests", "sso_site_policy"]]);
check("with no later migrations to run, the line about the optional file is still there", noLater.is(RAN), "ok");

console.log("The drift check's own rules look at what the optional file builds (a wrong copy, and a capture that matches it):");
check("a table of the file's with a privilege for a signed-in account is not passed as closed", [signedIn.rc, signedIn.failing(), signedIn.detail(NARROW)], [1, ["narrows"], "sso_audit"]);
check("nor with a privilege for a signed-out caller", [signedOut.rc, signedOut.failing(), signedOut.detail(NARROW), signedOut.detail(SIGNED_OUT)], [1, ["narrows", "signed-out"], "sso_audit", "sso_audit"]);
check("nor with a privilege for everyone", [everyone.rc, everyone.failing(), everyone.detail(NARROW)], [1, ["narrows"], "sso_audit"]);
check("nor with row security off", [rlsOff.rc, rlsOff.failing(), rlsOff.detail(RLS), rlsOff.detail(NARROW)], [1, ["row security", "narrows"], "sso_state", "sso_state"]);
check("nor with an access rule that does not narrow", [openRule.rc, openRule.failing(), openRule.detail(NARROW)], [1, ["narrows"], "sso_requests"]);
check("a function of the file's left for everyone to run is named", [publicFn.rc, publicFn.failing(), publicFn.detail(EVERYONE)], [1, ["everyone"], "sso_state_read"]);
check("an app table with no access rule is not passed as closed: only the file's own tables may be", [stripped.rc, stripped.failing(), stripped.detail(NARROW)], [1, ["narrows"], "ip_blocks"]);
check("a copy that cannot be run a second time is reported", [onceOnly.rc, onceOnly.failing(), /sso_schema\.sql a second time: .*not safe to run again/.test(onceOnly.detail(RAN))], [1, ["optional file"], true]);
check("a missing file is reported, and the tables it would have built are named", [noFile.rc, noFile.is(RAN), /there is no .*no-such-file\.sql to run/.test(noFile.detail(RAN)), FIVE.filter((n) => new RegExp(`/${n}: missing`).test(noFile.detail(TABLES)))], [1, "FAIL", true, FIVE]);

if (work.startsWith(tmpdir())) rmSync(work, { recursive: true, force: true });
console.log(`drift: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
