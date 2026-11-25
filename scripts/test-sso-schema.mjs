// Proves sso_schema.sql on a real Postgres running in memory (PGlite): who can
// call what, that a link is handed over once, limits, expiry and housekeeping.
// Touches no real database.
//
//   node scripts/test-sso-schema.mjs
//
// Needs @electric-sql/pglite 0.5 or later. It is not a dependency of the app:
// install it anywhere and point PGLITE_DIR at that folder, e.g.
//   PGLITE_DIR=/path/with/node_modules node scripts/test-sso-schema.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = (p) => (process.env.PGLITE_DIR ? pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist", p)).href : `@electric-sql/pglite${p === "index.js" ? "" : "/contrib/pgcrypto"}`);
const { PGlite } = await import(from("index.js"));
const { pgcrypto } = await import(from("contrib/pgcrypto.js"));

// SSO_SQL points the proof at another copy of the file: the controls use it to prove a broken copy fails.
const SQL = readFileSync(process.env.SSO_SQL || join(here, "../sso_schema.sql"), "utf8");
const db = new PGlite({ extensions: { pgcrypto } });

let ran = 0, failed = 0;
// Postgres returns an object's fields in its own order, so compare with the fields sorted.
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const check = (name, got, want) => {
  ran++;
  const ok = canon(got) === canon(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const val = async (sql, params = []) => Object.values(await one(sql, params))[0];
// Runs a statement as a role and reports "ok" or the reason it was refused.
const as = async (role, sql, params = []) => {
  await db.exec(`set role ${role}`);
  try { await db.query(sql, params); return "ok"; }
  catch (e) { return /permission denied/.test(e.message) ? "permission denied" : `error: ${e.message.slice(0, 70)}`; }
  finally { await db.exec("reset role"); }
};
const raises = async (sql, params = []) => { try { await db.query(sql, params); return "no error"; } catch (e) { return e.code || e.message.slice(0, 60); } };

// What Supabase provides before this file runs.
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create extension pgcrypto with schema extensions;
  grant usage on schema public, extensions to anon, authenticated, service_role;
  -- Supabase hands new tables and functions to every role by default; the file must undo that itself.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);

// Fleet's own sites table exists already in production; the proof needs only these columns.
await db.exec("create table public.sites (id bigint primary key, server_id bigint, url text not null); insert into public.sites values (1, 7, 'example.com'), (2, 8, 'example.com'), (3, 7, 'other.example.com')");

console.log("Installing:");
await db.exec(SQL);
check("the file runs", true, true);
check("it runs a second time without error", await db.exec(SQL).then(() => "ok", (e) => e.message), "ok");
check("one-click sign-in starts switched off", await val("select enabled from sso_state"), false);

const TABLES = ["sso_state", "sso_site_policy", "sso_agent_secrets", "sso_requests", "sso_audit"];
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const TOK7 = "t7".repeat(20), TOK8 = "t8".repeat(20);
const SIGNED = "signed-request-" + "x".repeat(60);
const SEALED = "U0VBTEVEbGluaw" + "A".repeat(40) + "==";
let n = 0;
const uuid = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const create = async (user = U1, server = 7, host = "example.com", extra = "") => {
  const id = uuid();
  const r = await val(`select sso_request_create($1,$2,$3,$4,$5 ${extra})`, [id, user, server, host, SIGNED]);
  return { id, ...r };
};
await db.query("insert into sso_agent_secrets (server_id, token_hash) values (7, encode(extensions.digest($1,'sha256'),'hex')), (8, encode(extensions.digest($2,'sha256'),'hex'))", [TOK7, TOK8]);

console.log("Who can read the tables:");
for (const role of ["anon", "authenticated"]) {
  const denied = [];
  for (const t of TABLES) if ((await as(role, `select * from ${t}`)) === "permission denied") denied.push(t);
  check(`${role} is refused on all five tables`, denied.length, 5);
  check(`${role} cannot write a request row`, await as(role, "insert into sso_requests (id, server_id, hostname, requested_by, signed_request, expires_at) values (gen_random_uuid(), 7, 'example.com', gen_random_uuid(), repeat('x',50), now())"), "permission denied");
}
check("control: the dashboard's server role can read them", await as("service_role", "select * from sso_requests"), "ok");

console.log("Who can call the functions:");
const CALLS = {
  sso_request_create: [`select sso_request_create($1,$2,7,'example.com',$3)`, [uuid(), U1, SIGNED]],
  sso_request_take: [`select sso_request_take($1,$2)`, [uuid(), U1]],
  sso_arm: [`select sso_arm()`, []],
  sso_verify_agent: [`select sso_verify_agent(7,$1)`, [TOK7]],
  sso_state_read: [`select sso_state_read()`, []],
  sso_policy_set: [`select sso_policy_set($1,null,null,null,7,'example.com',true)`, [U1]],
  sso_switch_set: [`select sso_switch_set($1,null,null,null,true)`, [U1]],
};
for (const role of ["anon", "authenticated"]) {
  const denied = [];
  for (const [fn, [sql, p]] of Object.entries(CALLS)) if ((await as(role, sql, p)) === "permission denied") denied.push(fn);
  check(`${role} cannot call the seven dashboard-only functions`, denied.length, 7);
}
check("a signed-in browser cannot collect requests either", await as("authenticated", "select sso_agent_poll(7,$1)", [TOK7]), "permission denied");
check("control: a server service (anon key + its token) can", await as("anon", "select sso_agent_poll(7,$1)", [TOK7]), "ok");
check("control: the dashboard's server role can create", await as("service_role", CALLS.sso_request_create[0], [uuid(), U1, SIGNED]), "ok");

console.log("Server tokens:");
check("a wrong token is refused", await raises("select sso_agent_poll(7,$1)", ["z".repeat(40)]), "42501");
check("a short token is refused", await raises("select sso_agent_poll(7,$1)", ["short"]), "42501");
check("server 8's token does not work for server 7", await raises("select sso_agent_poll(7,$1)", [TOK8]), "42501");
check("a wrong token cannot complete a request", await raises("select sso_agent_complete(7,$1,$2,$3)", ["z".repeat(40), uuid(), SEALED]), "42501");
check("the right token is accepted; switched off means no work", await val("select sso_agent_poll(7,$1)", [TOK7]), { armed: false, enabled: false, requests: [] });

console.log("Switches:");
check("refused while switched off", (await create()).reason, "switched-off");
await db.exec("update sso_state set enabled = true");
check("refused for a site that has not opted in", (await create()).reason, "site-not-enabled");
await db.exec("insert into sso_site_policy (server_id, hostname, enabled) values (7,'example.com',true), (7,'off.example.com',false), (8,'example.com',true) on conflict (server_id, hostname) do update set enabled = excluded.enabled");
check("a site with the box unticked is refused", (await create(U1, 7, "off.example.com")).reason, "site-not-enabled");
check("opting in on server 8 does not opt in the same name on server 9", (await create(U1, 9, "example.com")).reason, "site-not-enabled");
const r1 = await create();
check("an opted-in site is accepted", r1.ok, true);
check("every refusal so far is in the record", Number(await val("select count(*) from sso_audit where event='refused'")), 5);

console.log("One request, start to finish:");
check("another server sees none of server 7's requests", (await val("select sso_agent_poll(8,$1)", [TOK8])).requests, []);
const polled = await val("select sso_agent_poll(7,$1)", [TOK7]);
check("server 7 collects it, with the signed request intact", polled.requests, [{ id: r1.id, signed_request: SIGNED }]);
check("it is handed out once: a second poll is empty", (await val("select sso_agent_poll(7,$1)", [TOK7])).requests, []);
check("the person who asked sees it is in progress, no link", await val("select sso_request_take($1,$2)", [r1.id, U1]), { error: null, status: "claimed" });
check("another server cannot complete it", await val("select sso_agent_complete(8,$1,$2,$3)", [TOK8, r1.id, SEALED]), false);
check("a link and an error together are refused", await raises("select sso_agent_complete(7,$1,$2,$3,$4)", [TOK7, r1.id, SEALED, "x"]), "22023");
check("neither is refused too", await raises("select sso_agent_complete(7,$1,$2)", [TOK7, r1.id]), "22023");
check("something that is not sealed text is refused", await raises("select sso_agent_complete(7,$1,$2,$3)", [TOK7, r1.id, "https://example.com/abc/token"]), "23514");
check("server 7 completes it", await val("select sso_agent_complete(7,$1,$2,$3)", [TOK7, r1.id, SEALED]), true);
check("and cannot complete it twice", await val("select sso_agent_complete(7,$1,$2,$3)", [TOK7, r1.id, SEALED]), false);
check("control: the sealed link is in the row before it is taken", await val("select sealed_link from sso_requests where id=$1", [r1.id]), SEALED);
check("a different person cannot take it", await val("select sso_request_take($1,$2)", [r1.id, U2]), { status: "unknown" });
check("the person who asked takes it, with the site name from the row", await val("select sso_request_take($1,$2)", [r1.id, U1]), { sealed_link: SEALED, status: "ready", hostname: "example.com" });
check("taking it erased it", await one("select status, sealed_link from sso_requests where id=$1", [r1.id]), { status: "consumed", sealed_link: null });
check("a second take gets no link", await val("select sso_request_take($1,$2)", [r1.id, U1]), { error: null, status: "consumed" });
check("the record shows requested, minted, opened", (await db.query("select event from sso_audit where request_id=$1 order by id", [r1.id])).rows.map((r) => r.event), ["requested", "minted", "opened"]);

console.log("When things go wrong:");
const r2 = await create();
await db.query("update sso_requests set expires_at = now() - interval '1 second' where id=$1", [r2.id]);
check("a request past its time is not handed to the server", (await val("select sso_agent_poll(7,$1)", [TOK7])).requests, []);
check("the person is told the server never collected it", await val("select sso_request_take($1,$2)", [r2.id, U1]), { collected: false, status: "expired" });
const r3 = await create();
await db.query("select sso_agent_poll(7,$1)", [TOK7]);
await db.query("update sso_requests set expires_at = now() - interval '1 second' where id=$1", [r3.id]);
check("a late answer from the server is not accepted", await val("select sso_agent_complete(7,$1,$2,$3)", [TOK7, r3.id, SEALED]), false);
check("the person is told the server collected it and went quiet", await val("select sso_request_take($1,$2)", [r3.id, U1]), { collected: true, status: "expired" });
const r4 = await create();
await db.query("select sso_agent_poll(7,$1)", [TOK7]);
await db.query("select sso_agent_complete(7,$1,$2,$3)", [TOK7, r4.id, SEALED]);
await db.query("update sso_requests set completed_at = now() - interval '2 minutes' where id=$1", [r4.id]);
check("control: 30 seconds after the server answered, the link is still handed over", await (async () => { const r = await create(U2); await db.query("select sso_agent_poll(7,$1)", [TOK7]); await db.query("select sso_agent_complete(7,$1,$2,$3)", [TOK7, r.id, SEALED]); await db.query("update sso_requests set completed_at = now() - interval '30 seconds' where id=$1", [r.id]); return (await val("select sso_request_take($1,$2)", [r.id, U2])).status; })(), "ready");
check("a link left unopened for two minutes is not handed over", await val("select sso_request_take($1,$2)", [r4.id, U1]), { collected: true, status: "expired" });
check("and is erased", await val("select sealed_link from sso_requests where id=$1", [r4.id]), null);
const r5 = await create();
await db.query("select sso_agent_poll(7,$1)", [TOK7]);
await db.query("select sso_agent_complete(7,$1,$2,null,$3)", [TOK7, r5.id, "the site is frozen for a move"]);
check("a server-side failure reaches the person with its reason", await val("select sso_request_take($1,$2)", [r5.id, U1]), { error: "the site is frozen for a move", status: "failed" });
check("an id that was never created", await val("select sso_request_take($1,$2)", [uuid(), U1]), { status: "unknown" });

console.log("Bad input:");
await db.exec("insert into sso_site_policy (server_id, hostname, enabled) values (7,'ok.example.com',true)");
check("a hostname with a capital letter cannot opt in", await raises("insert into sso_site_policy (server_id, hostname, enabled) values (7,'Example.com',true)"), "23514");
check("a hostname with a slash cannot opt in", await raises("insert into sso_site_policy (server_id, hostname, enabled) values (7,'example.com/x',true)"), "23514");
check("a hostname with a space or quote cannot opt in", await raises(`insert into sso_site_policy (server_id, hostname, enabled) values (7,'a b''c',true)`), "23514");
check("a lifetime of an hour is refused", (await create(U1, 7, "example.com", ", null, null, null, 3600")).reason, "bad-request");
check("a signed request that is too short is refused", await raises("select sso_request_create($1,$2,7,'example.com','tiny')", [uuid(), U1]), "23514");
const dupe = await create(U2);
check("the same id cannot be created twice", await raises("select sso_request_create($1,$2,7,'example.com',$3)", [dupe.id, U2, SIGNED]), "23505");

console.log("Limits:");
await db.exec("delete from sso_requests");
for (let i = 0; i < 10; i++) await create();
check("ten in five minutes are accepted", Number(await val("select count(*) from sso_requests where requested_by=$1", [U1])), 10);
check("the eleventh is refused", (await create()).reason, "too-many-5m");
check("control: a different person is not held back by it", (await create(U2)).ok, true);
await db.exec("update sso_requests set created_at = now() - interval '10 minutes'");
check("ten minutes later the same person may ask again", (await create()).ok, true);
await db.exec("delete from sso_requests");
await db.query("insert into sso_requests (id, server_id, hostname, requested_by, signed_request, expires_at, created_at) select gen_random_uuid(), 7, 'example.com', $1, repeat('x',50), now(), now() - interval '2 hours' from generate_series(1,60)", [U1]);
check("after sixty in a day the next is refused", (await create()).reason, "too-many-day");

console.log("Polling speed and the off switch:");
check("arming gives a time ten minutes ahead", Math.round((new Date(await val("select sso_arm()")) - Date.now()) / 60000), 10);
check("the server is told to poll quickly", (await val("select sso_agent_poll(7,$1)", [TOK7])).armed, true);
await db.exec("update sso_state set armed_until = now() - interval '1 second'");
check("and to slow down once the ten minutes pass", (await val("select sso_agent_poll(7,$1)", [TOK7])).armed, false);
await db.exec("delete from sso_requests");
const r6 = await create(U2);
await db.exec("update sso_state set enabled = false");
check("switched off: a waiting request is not handed out", await val("select sso_agent_poll(7,$1)", [TOK7]), { armed: false, enabled: false, requests: [] });
check("switched off: arming does nothing", await val("select sso_arm()"), null);
check("switched off: new requests are refused", (await create(U2)).reason, "switched-off");
await db.exec("update sso_state set enabled = true");
check("control: switched back on, the waiting request is handed out", (await val("select sso_agent_poll(7,$1)", [TOK7])).requests.map((r) => r.id), [r6.id]);

console.log("Turning it on: sites and the master switch:");
await db.exec("delete from sso_site_policy; delete from sso_requests; update sso_state set enabled = false");
check("starts with nothing turned on", await val("select sso_state_read()"), { enabled: false, sites: [] });
check("a site Fleet knows on that server can be turned on", await val("select sso_policy_set($1,'me@example.com','me@example.com','203.0.113.9',7,'example.com',true)", [U1]), { ok: true, enabled: true });
check("its staging copy can be turned on", await val("select sso_policy_set($1,null,null,null,7,'staging.example.com',true)", [U1]), { ok: true, enabled: true });
check("a site Fleet does not know cannot", await val("select sso_policy_set($1,null,null,null,7,'stranger.example',true)", [U1]), { ok: false, reason: "unknown-site" });
check("a known site cannot be turned on for a server it is not on", await val("select sso_policy_set($1,null,null,null,9,'example.com',true)", [U1]), { ok: false, reason: "unknown-site" });
check("a hostname with a slash is refused", await val("select sso_policy_set($1,null,null,null,7,'example.com/x',true)", [U1]), { ok: false, reason: "bad-request" });
check("the buttons are told which sites, by server and name", await val("select sso_state_read()"), { enabled: false, sites: [{ server_id: 7, hostname: "example.com" }, { server_id: 7, hostname: "staging.example.com" }] });
check("turned on for a site but the master switch is off: still refused", (await create(U1)).reason, "switched-off");
check("the master switch goes on", await val("select sso_switch_set($1,'me@example.com','me@example.com','203.0.113.9',true)", [U1]), { ok: true, enabled: true });
check("now a request for that site is accepted", (await create(U1)).ok, true);
check("and one for the same name on another server is not", (await create(U1, 8, "example.com")).reason, "site-not-enabled");
check("turning a site off always works, even one Fleet no longer knows", [await val("select sso_policy_set($1,null,null,null,7,'example.com',false)", [U1]), await val("select sso_policy_set($1,null,null,null,7,'gone.example',false)", [U1])], [{ ok: true, enabled: false }, { ok: true, enabled: false }]);
check("a site turned off is refused again", (await create(U1)).reason, "site-not-enabled");
check("and is gone from what the buttons are told", (await val("select sso_state_read()")).sites, [{ server_id: 7, hostname: "staging.example.com" }]);
await db.exec("select sso_arm()");
check("the master switch goes off, and the servers stop being hurried", [await val("select sso_switch_set($1,null,null,null,false)", [U1]), await val("select armed_until from sso_state")], [{ ok: true, enabled: false }, null]);
check("every change is in the record, with who and from where", (await db.query("select event, detail, hostname, user_email, ip from sso_audit where event in ('policy','switch') order by id limit 2")).rows, [{ event: "policy", detail: "on", hostname: "example.com", user_email: "me@example.com", ip: "203.0.113.9" }, { event: "policy", detail: "on", hostname: "staging.example.com", user_email: null, ip: null }]);
check("the four site changes that went through and the two switch changes were written down; refusals were not", (await db.query("select event, count(*)::int as n from sso_audit where event in ('policy','switch') group by event order by event")).rows, [{ event: "policy", n: 4 }, { event: "switch", n: 2 }]);
await db.exec("insert into sso_site_policy (server_id, hostname, enabled) values (7,'example.com',true) on conflict (server_id, hostname) do update set enabled = true; update sso_state set enabled = true");

console.log("The record:");
const cols = ["event", "user_email", "access_email", "ip", "hostname", "detail"];
const leak = await val(`select count(*) from sso_audit where ${cols.map((c) => `coalesce(${c},'') like '%' || $1 || '%' or coalesce(${c},'') like '%http%'`).join(" or ")}`, [SEALED]);
check("no row of the record holds a link, sealed or not", Number(leak), 0);
check("control: the record is not empty", Number(await val("select count(*) from sso_audit")) > 30, true);
const who = uuid();
await db.query(`select sso_request_create($1,$2,7,'example.com',$3,'owner@example.com','owner@example.com','203.0.113.5')`, [who, U2, SIGNED]);
check("who, from where and which site are written down", await one("select event, user_email, access_email, ip, server_id::int as server_id, hostname from sso_audit where request_id=$1", [who]), { event: "requested", user_email: "owner@example.com", access_email: "owner@example.com", ip: "203.0.113.5", server_id: 7, hostname: "example.com" });

console.log("Housekeeping:");
await db.query("insert into sso_requests (id, server_id, hostname, requested_by, signed_request, expires_at, created_at) values ($1, 7, 'example.com', $2, repeat('x',50), now(), now() - interval '3 days')", [uuid(), U2]);
await db.exec("insert into sso_audit (event, at) values ('requested', now() - interval '13 months'), ('requested', now() - interval '11 months')");
await create(U2);
check("a request three days old is cleared on the next use", Number(await val("select count(*) from sso_requests where created_at < now() - interval '2 days'")), 0);
check("a record line 13 months old is cleared", Number(await val("select count(*) from sso_audit where at < now() - interval '1 year'")), 0);
check("control: one 11 months old is kept", Number(await val("select count(*) from sso_audit where at < now() - interval '10 months'")), 1);

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
