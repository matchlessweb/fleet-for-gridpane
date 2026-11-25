/**
 * One-click sign-in, end to end, with nothing real touched.   npm run sso:e2e
 *
 * Real parts: sso_schema.sql on an in-memory Postgres (PGlite), the real server
 * service (scripts/fleet-sso-agent.py), real openssl, and the code Fleet's own
 * routes call (lib/sso/service.ts and lib/sso/crypto.ts).
 * Stand-ins: a tiny local web server in front of the database (where Supabase
 * would be), a folder standing in for the server's disk, and a fake `gp` that
 * records how it was called and prints whatever the test tells it to.
 *
 *   PGLITE_DIR=/path/with/node_modules node --experimental-strip-types scripts/test-sso-end-to-end.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- PGlite is loaded from wherever PGLITE_DIR points, so it has no types here */
import { spawn, execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fleetConfig } from "../fleet.config.ts";
import { signRequest, unsealLink } from "../lib/sso/crypto.ts";
import { collectSignIn, readSsoState, requestSignIn, setSitePolicy, setSsoSwitch, type Rpc, type SsoWho } from "../lib/sso/service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pg = (p: string) => (process.env.PGLITE_DIR ? pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist", p)).href : p === "index.js" ? "@electric-sql/pglite" : "@electric-sql/pglite/contrib/pgcrypto");
const { PGlite } = await import(pg("index.js"));
const { pgcrypto } = await import(pg("contrib/pgcrypto.js"));
const OPENSSL = process.env.OPENSSL || ["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl", "/usr/bin/openssl"].find(existsSync)!;
// SSO_AGENT points the test at another copy of the service: the controls use it to prove a broken copy fails.
const AGENT = process.env.SSO_AGENT || join(here, "fleet-sso-agent.py");

let ran = 0, failed = 0;
const canon = (v: unknown) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = canon(got) === canon(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the database, with the real schema --------------------------------------
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create extension pgcrypto with schema extensions;
  grant usage on schema public, extensions to anon, authenticated, service_role;
`);
await db.exec("create table public.sites (id bigint primary key, server_id bigint, url text not null); insert into public.sites values (1,7,'example.com'),(2,7,'frozen.example.com'),(3,7,'gone.example.com'),(4,7,'quiet.example.com')");
await db.exec(readFileSync(join(here, "../sso_schema.sql"), "utf8"));
let queue: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
const q = (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => serial(() => db.query(sql, params));
const val = async (sql: string, params: unknown[] = []) => Object.values((await q(sql, params)).rows[0] as object)[0] as any;
const named = (fn: string, args: Record<string, unknown>) => { const keys = Object.keys(args); return { sql: `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, params: keys.map((k) => args[k]) }; };
const asRole = (role: string, fn: string, args: Record<string, unknown>) => serial(async () => {
  await db.exec(`set role ${role}`);
  try { const c = named(fn, args); return ((await db.query(c.sql, c.params)).rows[0] as any).r; }
  finally { await db.exec("reset role"); }
});
// Fleet's server code calls the database with the server key: role service_role.
const rpc: Rpc = async (fn, args = {}) => {
  try { return { data: await asRole("service_role", fn, args), error: null }; }
  catch (e: any) { return { data: null, error: { code: e.code, message: String(e.message) } }; }
};

// ---- where Supabase would be: only the two functions a server may call --------
const ANON = "anon-key-for-the-local-test-only";
const FNS: Record<string, string[]> = {
  sso_agent_poll: ["p_server_id", "p_token"],
  sso_agent_complete: ["p_server_id", "p_token", "p_request_id", "p_sealed_link", "p_error"],
};
const calls: { fn: string; body: string }[] = [];
const web = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const fn = (req.url || "").replace("/rest/v1/rpc/", "");
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST" || !FNS[fn] || req.headers.apikey !== ANON) return send(404, { message: "not found" });
    calls.push({ fn, body });
    try {
      const args = JSON.parse(body);
      // A server reaches the database with the public key: role anon.
      send(200, await asRole("anon", fn, Object.fromEntries(Object.entries(args).filter(([k]) => FNS[fn].includes(k)))));
    } catch (e: any) {
      send(e.code === "42501" ? 403 : 400, { code: e.code, message: String(e.message).slice(0, 200) });
    }
  });
});
await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
const PORT = (web.address() as any).port;

// ---- a folder standing in for the server -------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), "sso-e2e-"));
const f = (p: string) => join(ROOT, p);
for (const d of ["etc/fleet-sso", "usr/local/bin", "var/www/example.com/htdocs", "var/www/example.com/logs", "var/www/example.com/nginx", "var/www/frozen.example.com/htdocs", "var/www/frozen.example.com/nginx", "keys"]) mkdirSync(f(d), { recursive: true });
writeFileSync(f(`var/www/frozen.example.com/nginx/${fleetConfig.server.prefix}-freeze-main-context.conf`), "return 503;\n");
const ossl = (args: string[], input?: string | Buffer) => execFileSync(OPENSSL, args, { input, stdio: ["pipe", "pipe", "pipe"] });
for (const [name, bits] of [["sign", "3072"], ["box", "4096"], ["stranger", "3072"], ["strangerbox", "4096"]] as const) {
  ossl(["genpkey", "-algorithm", "RSA", "-pkeyopt", `rsa_keygen_bits:${bits}`, "-out", f(`keys/${name}.pem`)]);
  ossl(["pkey", "-in", f(`keys/${name}.pem`), "-pubout", "-out", f(`keys/${name}.pub`)]);
}
const SIGN = readFileSync(f("keys/sign.pem"), "utf8"), BOX = readFileSync(f("keys/box.pem"), "utf8"), STRANGER = readFileSync(f("keys/stranger.pem"), "utf8");
writeFileSync(f("etc/fleet-sso/sign-pub.pem"), readFileSync(f("keys/sign.pub")));
writeFileSync(f("etc/fleet-sso/box-pub.pem"), readFileSync(f("keys/box.pub")));
const TOKEN = "ab12".repeat(16), SERVER = 7;
const writeConf = (token = TOKEN, mode = 0o600) => { writeFileSync(f("etc/fleet-sso/agent.conf"), `# test\nSUPABASE_URL=http://127.0.0.1:${PORT}\nSUPABASE_ANON_KEY=${ANON}\nSERVER_ID=${SERVER}\nAGENT_TOKEN=${token}\n`); chmodSync(f("etc/fleet-sso/agent.conf"), mode); };
writeConf();
// The fake gp: writes down its arguments, then does what gp.mode says.
const SECRET = "ToKeN0123456789abcdefghi";
writeFileSync(f("usr/local/bin/gp"), `#!/bin/bash
printf '%s\\n' "$*" >> "${ROOT}/gp.log"
case "$(cat "${ROOT}/gp.mode" 2>/dev/null)" in
  fail)      echo "Error: This command requires the companion plugin." >&2; exit 1 ;;
  garbage)   echo "Success: something that is not a link" ;;
  othersite) echo "https://evil.example/9c195f0a/${SECRET}" ;;
  http)      echo "http://$2/9c195f0a/${SECRET}" ;;
  slow)      sleep 5; echo "https://$2/9c195f0a/${SECRET}" ;;
  *)         echo "Warning: a line of noise first"; echo "https://$2/9c195f0a/${SECRET}" ;;
esac
`);
chmodSync(f("usr/local/bin/gp"), 0o755);
const gpMode = (m: string) => writeFileSync(f("gp.mode"), m);
const gpLog = () => (existsSync(f("gp.log")) ? readFileSync(f("gp.log"), "utf8").trim().split("\n").filter(Boolean) : []);
const gpClear = () => rmSync(f("gp.log"), { force: true });

let allOutput = "";
const ENV = { PATH: process.env.PATH || "", FLEET_SSO_ROOT: ROOT, FLEET_SSO_OPENSSL: OPENSSL, FLEET_SSO_GP_TIMEOUT: "2", PYTHONDONTWRITEBYTECODE: "1" } as unknown as NodeJS.ProcessEnv;
function agent(args: string[] = []) {
  const child = spawn("python3", [AGENT, ...args], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (c: Buffer) => (out += c));
  child.stderr!.on("data", (c: Buffer) => (out += c));
  const done = new Promise<{ code: number | null; out: string }>((r) => child.on("close", (code) => { allOutput += out; r({ code, out }); }));
  return { child, done, text: () => out };
}
const once = () => agent(["--once"]).done;

await q("insert into sso_agent_secrets (server_id, token_hash) values ($1, encode(extensions.digest($2,'sha256'),'hex'))", [SERVER, TOKEN]);
const KEYS = { SSO_SIGN_PRIVATE_KEY: SIGN, SSO_BOX_PRIVATE_KEY: BOX };
const whoIs = (userId: string): SsoWho => ({ userId, userEmail: "owner@example.com", accessEmail: "owner@example.com", ip: "203.0.113.7" });
const ADMIN = whoIs("cccccccc-0000-4000-8000-999999999999");

let n = 0;
const uuid = () => `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const user = () => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rawSign = (payload: unknown, key = SIGN) => {
  const head = `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(key).toString("base64url")}`;
};
// Fleet's half. Without `signed`, this is exactly what the route does. With it, the
// request is planted in the database directly: what someone holding the database key could do.
async function ask(host = "example.com", opts: { signed?: (id: string, now: number) => string | Promise<string> } = {}) {
  const id = uuid(), who = user(), now = Math.floor(Date.now() / 1000);
  if (!opts.signed) {
    const r = await requestSignIn(rpc, KEYS, whoIs(who), { serverId: SERVER, hostname: host }, { newId: () => id });
    if (r.body.state !== "waiting") throw new Error(`Fleet refused: ${JSON.stringify(r.body)}`);
    return { id, who, host };
  }
  const made = await val("select sso_request_create($1,$2,$3,$4,$5)", [id, who, SERVER, host, await opts.signed(id, now)]);
  if (!made.ok) throw new Error(`create refused: ${made.reason}`);
  return { id, who, host };
}
const take = async (r: { id: string; who: string }) => (await collectSignIn(rpc, KEYS, whoIs(r.who), r.id)).body;
const Sentence = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
const until = async (fn: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await pause(100); } return false; };

try {
  console.log("Turning it on, through Fleet's own code:");
  check("nothing is on to begin with", await readSsoState(rpc), { enabled: false, sites: [] });
  check("a request before anything is turned on is refused", (await requestSignIn(rpc, KEYS, ADMIN, { serverId: SERVER, hostname: "example.com" })).body.reason, "switched-off");
  for (const h of ["example.com", "frozen.example.com", "gone.example.com", "quiet.example.com"]) await setSitePolicy(rpc, ADMIN, { serverId: SERVER, hostname: h, enabled: true });
  check("a site Fleet does not know cannot be turned on", (await setSitePolicy(rpc, ADMIN, { serverId: SERVER, hostname: "stranger.example", enabled: true })).status, 404);
  check("the master switch goes on", (await setSsoSwitch(rpc, ADMIN, true)).body, { ok: true, enabled: true });
  check("the buttons are told which sites", await readSsoState(rpc), { enabled: true, sites: ["7|example.com", "7|frozen.example.com", "7|gone.example.com", "7|quiet.example.com"] });
  check("a site that is not turned on is refused", [(await requestSignIn(rpc, KEYS, ADMIN, { serverId: SERVER, hostname: "other.example.com" })).status, (await requestSignIn(rpc, KEYS, ADMIN, { serverId: 8, hostname: "example.com" })).body.reason], [409, "site-not-enabled"]);
  check("something that is not a site name is refused before the database is asked", await requestSignIn(rpc, KEYS, ADMIN, { serverId: SERVER, hostname: "example.com/../x" }).then((r) => r.status, () => "threw"), 400);
  check("so is a server id that is not a number", await requestSignIn(rpc, KEYS, ADMIN, { serverId: "7; drop table", hostname: "example.com" }).then((r) => r.status, () => "threw"), 400);
  check("with no signing key Fleet says it is not set up", (await requestSignIn(rpc, { ...KEYS, SSO_SIGN_PRIVATE_KEY: "" }, ADMIN, { serverId: SERVER, hostname: "example.com" })).body.reason, "not-configured");
  check("none of those refusals reached a server", Number(await val("select count(*) from sso_requests")), 0);

  console.log("A sign-in, start to finish:");
  gpMode("ok");
  const a = await ask();
  const run = await once();
  check("the service exits cleanly", run.code, 0);
  check("it ran exactly one command, GridPane's, with these arguments", gpLog(), ["wp example.com login create 1 --url-only --expires=60"]);
  const row = (await q("select status, sealed_link from sso_requests where id=$1", [a.id])).rows[0] as any;
  check("the request is ready", row.status, "ready");
  check("what sits in the database is not readable as a link", /https?:|example|9c195f0a/.test(row.sealed_link) || Buffer.from(row.sealed_link, "base64").includes(SECRET), false);
  check("control: a stranger's key cannot open what is in the database", await unsealLink(row.sealed_link, readFileSync(f("keys/strangerbox.pem"), "utf8"), { id: a.id, hostname: "example.com" }), { ok: false, reason: "cannot-open" });
  check("someone else signed in to Fleet cannot collect it", (await collectSignIn(rpc, KEYS, ADMIN, a.id)).body.state, "unknown");
  check("Fleet opens it for the person who asked and gets the link gp printed", await take(a), { state: "ready", url: `https://example.com/9c195f0a/${SECRET}` });
  check("it is handed over once: asking again gets no link", await take(a), { state: "used", message: "That sign-in link was already opened." });
  check("the record says who, from where, and that it was opened", (await q("select event, user_email, ip from sso_audit where request_id=$1 order by id", [a.id])).rows, [{ event: "requested", user_email: "owner@example.com", ip: "203.0.113.7" }, { event: "minted", user_email: null, ip: null }, { event: "opened", user_email: null, ip: null }]);
  check("the service's own log names the request and site", run.out.includes(a.id) && run.out.includes("example.com"), true);

  console.log("Which WordPress user:");
  gpClear(); writeFileSync(f("var/www/example.com/logs/wpadmin_id.env"), " 7\n");
  await ask(); await once();
  check("the id in the site's wpadmin_id.env is used", gpLog(), ["wp example.com login create 7 --url-only --expires=60"]);
  gpClear(); writeFileSync(f("var/www/example.com/logs/wpadmin_id.env"), "7; touch /tmp/x\n");
  await ask(); await once();
  check("a file that is not a plain number falls back to user 1", gpLog(), ["wp example.com login create 1 --url-only --expires=60"]);
  rmSync(f("var/www/example.com/logs/wpadmin_id.env"));

  console.log("Requests the service must refuse (gp must not run):");
  const refused = async (name: string, host: string, signed: (id: string, now: number) => string | Promise<string>, error: string) => {
    gpClear();
    const r = await ask(host, { signed });
    await once();
    check(`${name}: gp was not run`, gpLog(), []);
    check(`${name}: the person is told`, await take(r), { state: "failed", message: Sentence(error) });
  };
  const NOPE = "the server did not accept the request";
  await refused("signed by someone else's key", "example.com", (id, now) => rawSign({ v: 1, id, sid: SERVER, host: "example.com", iat: now, exp: now + 60 }, STRANGER), NOPE);
  await refused("Fleet's signature on a different payload", "example.com", async (id, now) => { const s = (await signRequest({ v: 1, id, sid: SERVER, host: "example.com", iat: now, exp: now + 60 }, SIGN)).split("."); return `${s[0]}.${Buffer.from(JSON.stringify({ v: 1, id, sid: SERVER, host: "frozen.example.com", iat: now, exp: now + 60 })).toString("base64url")}.${s[2]}`; }, NOPE);
  await refused("signed for another server", "example.com", (id, now) => rawSign({ v: 1, id, sid: 8, host: "example.com", iat: now, exp: now + 60 }), "the request was for a different server");
  await refused("a signed request copied into a new row", "example.com", (_id, now) => rawSign({ v: 1, id: "dddddddd-0000-4000-8000-000000000001", sid: SERVER, host: "example.com", iat: now, exp: now + 60 }), NOPE);
  await refused("signed, but already out of time", "example.com", (id, now) => rawSign({ v: 1, id, sid: SERVER, host: "example.com", iat: now - 200, exp: now - 140 }), "the request ran out of time; try again");
  await refused("signed, claiming an hour of life", "example.com", (id, now) => rawSign({ v: 1, id, sid: SERVER, host: "example.com", iat: now, exp: now + 3600 }), NOPE);
  await refused("signed, with a path in place of a site name", "example.com", (id, now) => rawSign({ v: 1, id, sid: SERVER, host: "../../etc", iat: now, exp: now + 60 }), NOPE);
  await refused("signed, with a command in place of a site name", "example.com", (id, now) => rawSign({ v: 1, id, sid: SERVER, host: "example.com; id", iat: now, exp: now + 60 }), NOPE);
  await refused("signed, version 2", "example.com", (id, now) => rawSign({ v: 2, id, sid: SERVER, host: "example.com", iat: now, exp: now + 60 }), NOPE);
  await refused("a site with no folder on this server", "gone.example.com", (id, now) => signRequest({ v: 1, id, sid: SERVER, host: "gone.example.com", iat: now, exp: now + 60 }, SIGN), "this site is not on this server");
  await refused("a site frozen for a move", "frozen.example.com", (id, now) => signRequest({ v: 1, id, sid: SERVER, host: "frozen.example.com", iat: now, exp: now + 60 }, SIGN), "the site is frozen for a move");

  console.log("When gp does not give a link:");
  for (const [mode, name, error] of [["fail", "gp fails", "the server could not create a sign-in link"], ["garbage", "gp prints no link", "the server could not create a sign-in link"], ["othersite", "gp prints a link to another site", "the server could not create a sign-in link"], ["http", "gp prints a plain http link", "the server could not create a sign-in link"], ["slow", "gp takes too long", "the server took too long to create a sign-in link"]] as const) {
    gpMode(mode); gpClear();
    const r = await ask(); await once();
    check(`${name}: nothing is sealed, and the person is told`, [await take(r), (await q("select sealed_link from sso_requests where id=$1", [r.id])).rows[0]], [{ state: "failed", message: Sentence(error) }, { sealed_link: null }]);
  }
  gpMode("ok");

  console.log("Running continuously:");
  await q("select sso_arm()");
  gpClear();
  const live = agent();
  check("it starts", await until(async () => live.text().includes("started for server 7")), true);
  const b = await ask();
  check("a new request is ready within a few seconds", await until(async () => (await val("select status from sso_requests where id=$1", [b.id])) === "ready"), true);
  // What someone holding the database key could try: hand the same signed request out again.
  await q("update sso_requests set status='pending', sealed_link=null, claimed_at=null, completed_at=null where id=$1", [b.id]);
  check("the same request handed out again is refused", await until(async () => (await val("select status from sso_requests where id=$1", [b.id])) === "failed"), true);
  check("and gp ran once, not twice", gpLog().length, 1);
  check("the person is told why", await take(b), { state: "failed", message: "The request was already used; try again." });
  // The service's own limit: six a minute, whatever Fleet asks. One is used; ask for seven more.
  const many: { id: string; who: string; host: string }[] = [];
  for (let i = 0; i < 7; i++) many.push(await ask());
  check("seven more requests all get an answer", await until(async () => Number(await val("select count(*) from sso_requests where id = any($1) and status in ('ready','failed')", [many.map((m) => m.id)])) === 7, 15000), true);
  check("gp ran six times in the minute, no more", gpLog().length, 6);
  const overLimit = (await q("select error from sso_requests where id = any($1) and status='failed'", [many.map((m) => m.id)])).rows.map((r: any) => r.error);
  check("the two over the limit are told to wait", overLimit, Array(2).fill("too many sign-ins on this server in a minute; wait and try again"));
  // Switched off in Fleet while a request waits.
  await q("update sso_state set enabled=false");
  await pause(2500);
  const before = gpLog().length;
  await q("insert into sso_requests (id, server_id, hostname, requested_by, signed_request, expires_at) values ($1,7,'example.com',$2,$3, now() + interval '60 seconds')", [uuid(), user(), "x".repeat(50)]);
  await pause(2500);
  check("switched off in Fleet: a waiting request is left alone", gpLog().length, before);
  await q("update sso_state set enabled=true");
  live.child.kill("SIGTERM");
  const ended = await live.done;
  check("it stops cleanly when told to", [ended.code, ended.out.trim().endsWith("stopped")], [0, true]);

  console.log("Settings and the self-check:");
  gpClear();
  const chk = await agent(["--check"]).done;
  check("--check passes", [chk.code, /check_result=ok/.test(chk.out), (chk.out.match(/^  ok  /gm) || []).length], [0, true, 5]);
  check("--check runs no gp command", gpLog(), []);
  writeConf("f".repeat(64));
  check("a token Fleet does not know: --once exits 1 and says so", await once().then((r) => [r.code, /rejected this server's token/.test(r.out)]), [1, true]);
  const chkBad = await agent(["--check"]).done;
  check("--check fails on that token", [chkBad.code, /FAIL Fleet's database accepts/.test(chkBad.out), /check_result=stop/.test(chkBad.out)], [1, true, true]);
  writeConf(TOKEN, 0o644);
  check("settings readable by other users: refuses to start", await once().then((r) => [r.code !== 0, /can be read by other users/.test(r.out)]), [true, true]);
  writeConf("short");
  check("no token set: refuses to start", await once().then((r) => [r.code !== 0, /AGENT_TOKEN/.test(r.out)]), [true, true]);
  writeConf();
  writeFileSync(f("etc/fleet-sso/box-pub.pem"), "not a key\n");
  const chkKey = await agent(["--check"]).done;
  check("--check fails when Fleet's public key is unreadable", [chkKey.code, /FAIL openssl can seal/.test(chkKey.out)], [1, true]);
  writeFileSync(f("etc/fleet-sso/box-pub.pem"), readFileSync(f("keys/box.pub")));
  gpClear();
  const r2 = await ask(); await once();
  check("with the key put back, a sign-in works again", [gpLog().length, (await take(r2)).state], [1, "ready"]);
  const r3 = await ask(); await once();
  const wrongKey = await collectSignIn(rpc, { ...KEYS, SSO_BOX_PRIVATE_KEY: readFileSync(f("keys/strangerbox.pem"), "utf8") }, whoIs(r3.who), r3.id);
  check("Fleet holding the wrong unsealing key opens nothing and sends no link", [wrongKey.status, wrongKey.body.state, wrongKey.body.reason, "url" in wrongKey.body], [502, "failed", "cannot-open", false]);

  console.log("When no server answers:");
  const quiet = await requestSignIn(rpc, KEYS, whoIs(user()), { serverId: SERVER, hostname: "quiet.example.com" });
  const quietWho = whoIs(user());
  check("while nothing has collected it, the person sees it is waiting", (await collectSignIn(rpc, KEYS, quietWho, quiet.body.id)).body, { state: "waiting", step: "asked" });
  await q("update sso_requests set expires_at = now() - interval '1 second' where id=$1", [quiet.body.id]);
  check("after its minute, the person is told the server never picked it up", (await collectSignIn(rpc, KEYS, quietWho, quiet.body.id)).body, { state: "expired", message: "The server did not pick the request up in time. Its sign-in service may be stopped." });
  check("an id that is not an id", (await collectSignIn(rpc, KEYS, quietWho, "1 or 1=1")).status, 404);
  check("switched off in Fleet: a new request is refused at once", [(await setSsoSwitch(rpc, ADMIN, false)).body.enabled, (await requestSignIn(rpc, KEYS, ADMIN, { serverId: SERVER, hostname: "example.com" })).body.message], [false, "One-click sign-in is switched off in Fleet."]);

  console.log("What never appears:");
  check("no link or link token in anything the service printed", /9c195f0a|https?:\/\/(?!127\.0\.0\.1)/.test(allOutput) || allOutput.includes(SECRET), false);
  check("no server token in anything the service printed", allOutput.includes(TOKEN), false);
  check("control: the service did print things", allOutput.split("\n").length > 30, true);
  const sent = calls.filter((c) => c.fn === "sso_agent_complete").map((c) => c.body).join("\n");
  check("no link in anything the service sent to the database", sent.includes(SECRET) || /9c195f0a/.test(sent), false);
  check("control: it sent sealed links", (sent.match(/p_sealed_link/g) || []).length > 5, true);
  check("no link in the sign-in record", Number(await val("select count(*) from sso_audit where coalesce(detail,'') ~ 'http|9c195f0a'")), 0);
} finally {
  web.close();
  rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
