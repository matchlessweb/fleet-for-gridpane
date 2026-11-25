#!/usr/bin/env node
// Proves scripts/doctor.mjs against stand-ins: a throwaway HTTP server on a
// random local port plays the Supabase REST and sign-in APIs and GridPane, and a
// made-up checkout, settings file, server list and ssh-add play this machine.
// Nothing real is asked: no Supabase project, no GridPane, no server, no key.
//
//   node scripts/test-doctor.mjs              # the checks
//   node scripts/test-doctor.mjs --controls   # also: break the doctor on purpose, each break must be caught
//   node scripts/test-doctor.mjs --show       # the checks, and what the doctor printed in every state
//
// The states: nothing configured; configured with an empty database; healthy;
// a table, a column, a function and a function argument missing; an agent that
// went quiet; GridPane refusing the token; sign-ups left on; a service that never
// answers; and the smaller ones beside them. In every state it also checks that no value from the
// made-up settings file reaches the doctor's output.
//
// The made-up secrets are random and made at run time, so this file holds
// nothing a scanner would flag, and a match in the output can only be a leak.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(HERE, "..");
const DOCTOR = process.env.FLEET_DOCTOR_UNDER_TEST || join(HERE, "doctor.mjs");
const QUIET = !!process.env.QUIET;
const T = mkdtempSync(join(tmpdir(), "fleet-doctor-test-"));
const servers = new Set(), children = new Set();
const cleanUp = () => { for (const c of children) try { c.kill("SIGKILL"); } catch { /* already gone */ } for (const s of servers) { try { s.closeAllConnections(); s.close(); } catch { /* already closed */ } } rmSync(T, { recursive: true, force: true }); };
process.on("exit", cleanUp);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

let PASS = 0, FAIL = 0;
const said = [];
const ok = (name, got, want) => { if (got === want) { PASS++; if (!QUIET) said.push(`  pass  ${name}`); } else { FAIL++; said.push(`  FAIL  ${name}: got '${got}', wanted '${want}'`); } };
const has = (name, text, part) => { if (String(text).includes(part)) { PASS++; if (!QUIET) said.push(`  pass  ${name}`); } else { FAIL++; said.push(`  FAIL  ${name}: '${part}' is not in the output`); } };
const hasnt = (name, text, part) => { if (!String(text).includes(part)) { PASS++; if (!QUIET) said.push(`  pass  ${name}`); } else { FAIL++; said.push(`  FAIL  ${name}: '${part}' is in the output`); } };
const section = (title) => { if (!QUIET) said.push(title); };

/* ── the made-up settings ────────────────────────────────────────────────── */
const random = (n) => randomBytes(n).toString("base64url");
const SECRETS = {
  NEXT_PUBLIC_SUPABASE_ANON_KEY: `anon.${random(40)}`,
  SUPABASE_SERVICE_ROLE_KEY: `service.${random(60)}`,
  GRIDPANE_API_TOKEN: randomBytes(24).toString("hex"),
  SSO_SIGN_PRIVATE_KEY: random(44),
  SSO_BOX_PRIVATE_KEY: random(44),
};
// An address nothing answers at: every run is pointed at the stand-in instead, and a run that
// forgot to be would fail to connect rather than reach anything real.
const NOWHERE = "https://fleet-doctor-test.invalid";
const envText = (over = {}) => {
  const v = { NEXT_PUBLIC_SUPABASE_URL: NOWHERE, ...SECRETS, CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "", SSO_ALLOWED_USER_IDS: "", ...over };
  return Object.entries(v).filter(([, val]) => val !== null).map(([k, val]) => `${k}=${val}`).join("\n") + "\n";
};
const KEY_LINE = (n) => `256 SHA${"256"}:${random(32).slice(0, 43)} key-${n} (ED25519)`;

/* ── made-up checkouts ───────────────────────────────────────────────────── */
const snapshot = JSON.parse(readFileSync(join(REPO, "supabase/schema.snapshot.json"), "utf8"));
const exampleConfig = readFileSync(join(REPO, "fleet.config.example.ts"), "utf8");
const ownConfig = exampleConfig.replace('hostname: "fleet.example.com"', 'hostname: "ops.example.org"');
if (ownConfig === exampleConfig) { console.log("The example config has no hostname line to change, so the test cannot make a config of its own."); console.log("doctor test: 0 checks, 1 failed"); process.exit(1); }
const roots = {};
const packageNames = (() => { const p = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")); return Object.keys({ ...p.dependencies, ...p.devDependencies }); })();
// packages: "all" (every package package.json names, as empty stand-ins), "none", or "one short".
function makeRoot(name, { config, packages = "all" }) {
  const root = join(T, "root-" + name);
  mkdirSync(join(root, "supabase"), { recursive: true });
  for (const f of ["package.json", ".env.example", "fleet.config.example.ts", "supabase/schema.snapshot.json"]) cpSync(join(REPO, f), join(root, f));
  cpSync(join(REPO, "supabase/migrations"), join(root, "supabase/migrations"), { recursive: true });
  // The real server list (scripts/servers.local) and anything left by another run stay behind.
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true, filter: (src) => !/servers\.local$|\/\.[^/]*$/.test(src) });
  cpSync(join(REPO, "lib"), join(root, "lib"), { recursive: true });
  if (config !== null) writeFileSync(join(root, "fleet.config.ts"), config);
  for (const dep of packages === "none" ? [] : packageNames.slice(packages === "one short" ? 1 : 0)) {
    mkdirSync(join(root, "node_modules", dep), { recursive: true });
    writeFileSync(join(root, "node_modules", dep, "package.json"), "{}\n");
  }
  roots[name] = root;
}
makeRoot("fresh", { config: exampleConfig, packages: "none" });
makeRoot("oneshort", { config: ownConfig, packages: "one short" });
makeRoot("ready", { config: ownConfig });
makeRoot("badprefix", { config: ownConfig.replace('prefix: "fleet"', 'prefix: "Bad-Prefix"') });
makeRoot("badshape", { config: ownConfig.replace(/^\s*shortName:.*\n/m, "") });
makeRoot("noconfig", { config: null });

// A stand-in for ssh-add: prints the lines of $FAKE_SSH_KEYS, or says the agent is empty.
const BIN = join(T, "bin"); mkdirSync(BIN);
writeFileSync(join(BIN, "ssh-add"), '#!/bin/bash\nif [ -s "${FAKE_SSH_KEYS:-}" ]; then cat "$FAKE_SSH_KEYS"; exit 0; fi\necho "The agent has no identities."; exit 1\n');
chmodSync(join(BIN, "ssh-add"), 0o755);

/* ── the stand-in services ───────────────────────────────────────────────── */
const AGO = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const FLEET = [{ id: 10001, label: "web1" }, { id: 10002, label: "web2" }, { id: 10003, label: "shop1" }];
// What the migrations after the baseline leave behind, written out here and not worked out the way
// the doctor does: the test must know it independently. Add a line when a migration is added.
const LATER = [
  { file: "20261120000100_settings_row.sql", row: "app_settings" },
  { file: "20261121000000_strong_session.sql", fn: "session_is_strong" },
  { file: "20261122000000_authenticator_rule.sql", fn: "account_has_authenticator" }, // it also changes session_is_strong, which is the file before's to be known by
  { file: "20261123000000_site_caching.sql", columns: ["sites.nginx_caching_ttl", "sites.object_caching", "sites.object_cache_pro"] },
  { file: "20261124000000_sync_runs.sql", table: "sync_runs", tableColumns: ["id", "source", "status", "phase", "started_by", "started_at", "heartbeat_at", "finished_at", "servers_saved", "sites_total", "sites_done", "sites_read", "schedules", "errors", "message"] },
];
// The columns the later migrations add, by table: a healthy database has them on top of the snapshot's.
const LATER_COLUMNS = LATER.flatMap((m) => m.columns || []).map((c) => c.split("."));
const APP = { id: "11111111-1111-1111-1111-111111111111", factor_type: "totp", status: "verified" };
const HALF = { id: "22222222-2222-2222-2222-222222222222", factor_type: "totp", status: "unverified" };
const WITH_APP = { signedIn: true, factors: [APP] };
const MANY = Array.from({ length: 12 }, (_, i) => ({ id: 20001 + i, label: `srv${i + 1}` }));
const healthy = () => ({
  tables: {
    ...Object.fromEntries(snapshot.tables.map((t) => [t.name, [...t.columns.map((c) => c.name), ...LATER_COLUMNS.filter(([table]) => table === t.name).map(([, c]) => c)]])),
    ...Object.fromEntries(LATER.filter((m) => m.table).map((m) => [m.table, m.tableColumns])),
  },
  functions: { ...Object.fromEntries(snapshot.functions.map((f) => [f.name, f.args.split(",").map((a) => a.trim().split(/\s+/)[0]).filter(Boolean)])), ...Object.fromEntries(LATER.filter((m) => m.fn).map((m) => [m.fn, []])) },
  settingsRows: 1,   // a number, or "unread": the table will not be counted
  users: 3, servers: FLEET, sites: 41,
  signups: "off",   // off | on | unsaid (an answer without the setting) | error | hang
  agents: FLEET.map((s, i) => ({ server_id: s.id, last_used_at: AGO(2 + i) })),
  // The newest sync record first, as the doctor asks for it.
  syncRuns: [{ status: "complete", source: "app", phase: "done", started_at: AGO(80), heartbeat_at: AGO(60), finished_at: AGO(60), sites_total: 41, sites_done: 41, sites_read: 41, errors: 0, message: "Read all 41 sites." }],
  gridpane: 200, database: "up",   // database: up | hang | refuse     gridpane: a status, or "hang"
});
function startStub(world) {
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const path = url.pathname;
    log.push({ method: req.method, path });
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(req.method === "HEAD" || body === undefined ? undefined : JSON.stringify(body)); };
    if (path.startsWith("/gp/")) {
      if (world.gridpane === "hang") return;
      if (req.headers.authorization !== `Bearer ${SECRETS.GRIDPANE_API_TOKEN}`) return send(401, { message: "Unauthenticated." });
      if (world.gridpane !== 200) return send(world.gridpane, { message: world.gridpane === 429 ? "Beep, Beep, you're going too fast" : "Unauthenticated." });
      return send(200, { data: world.servers.slice(0, 1), meta: { last_page: world.servers.length } });
    }
    if (world.database === "hang") return;
    // The one address a signed-out browser may read: the sign-in service's public settings.
    if (path === "/auth/v1/settings") {
      if (world.signups === "hang") return;
      if (world.database === "refuse" || req.headers.apikey !== SECRETS.NEXT_PUBLIC_SUPABASE_ANON_KEY) return send(401, { message: "Invalid API key" });
      // A failure that still carries the field: the status decides, not a body that may be stale.
      if (world.signups === "error") return send(500, { message: "Internal Server Error", disable_signup: true });
      return send(200, { external: { email: true, phone: false }, ...(world.signups === "unsaid" ? {} : { disable_signup: world.signups === "off" }), mailer_autoconfirm: false });
    }
    const key = SECRETS.SUPABASE_SERVICE_ROLE_KEY;
    if (world.database === "refuse" || req.headers.apikey !== key || req.headers.authorization !== `Bearer ${key}`) return send(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
    if (path === "/rest/v1/") {
      const definitions = Object.fromEntries(Object.entries(world.tables).map(([name, cols]) => [name, { type: "object", properties: Object.fromEntries(cols.map((c) => [c, { type: "string" }])) }]));
      const paths = { "/": { get: {} } };
      for (const name of Object.keys(world.tables)) paths[`/${name}`] = { get: {} };
      for (const [name, fnArgs] of Object.entries(world.functions)) paths[`/rpc/${name}`] = { post: { parameters: [{ in: "body", name: "args", required: true, schema: { type: "object", properties: Object.fromEntries(fnArgs.map((a) => [a, { type: "string" }])) } }, { $ref: "#/parameters/preferParams" }] } };
      // A project with no tables has no "definitions" key at all (world.bare), as the real service answers.
      return send(200, { swagger: "2.0", info: { title: "standard public schema" }, paths, ...(world.bare ? {} : { definitions }) });
    }
    // Accounts: world.accounts when a state sets it, else world.users accounts that have each signed in and have a confirmed authenticator app.
    const accounts = world.accounts || Array.from({ length: world.users }, () => ({ signedIn: true, factors: [APP] }));
    const uid = (i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`;
    if (path === "/auth/v1/admin/users") {
      const per = Number(url.searchParams.get("per_page")) || 50;
      return send(200, { users: accounts.slice(0, per).map((a, i) => ({ id: uid(i), email: `someone${i + 1}@example.com`, last_sign_in_at: a.signedIn ? new Date(Date.now() - 86400000).toISOString() : null })), aud: "authenticated" }, world.total === "none" ? {} : { "x-total-count": String(world.total ?? accounts.length) });
    }
    const whose = /^\/auth\/v1\/admin\/users\/0{8}-0{4}-0{4}-0{4}-(\d{12})\/factors$/.exec(path);
    if (whose) {
      const a = accounts[Number(whose[1]) - 1];
      if (!a) return send(404, { message: "User not found" });
      if (a.factors === "hang") return;
      if (a.factors === "error") return send(500, { message: "Internal Server Error" });
      if (a.factors === "blank") return send(200, undefined); // a 200 with nothing in it is not a list
      return send(200, a.factors); // `null` for an account with none is sent as the word null, as the service may
    }
    const table = path.replace("/rest/v1/", "");
    if (!world.tables[table]) return send(404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
    if (table === "app_settings" && world.settingsRows === "unread") return send(500, { message: "Internal Server Error" });
    const rows = table === "app_settings" ? Array.from({ length: world.settingsRows }, (_, i) => ({ id: i + 1 })) : table === "servers" ? world.servers : table === "server_agent_secrets" ? world.agents : table === "sites" ? Array.from({ length: world.sites }, (_, i) => ({ id: i + 1 })) : table === "sync_runs" ? world.syncRuns : [];
    return send(200, rows, { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" });
  });
  servers.add(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}`, log, stop: () => { server.closeAllConnections(); server.close(); servers.delete(server); } })));
}

/* ── one run of the doctor ───────────────────────────────────────────────── */
let runs = 0;
async function doctor({ root = "ready", env = envText(), world = healthy(), list = null, keys = null, wantKey = "", args = [], extra = {}, stub = true, timeoutMs = 3000, program = DOCTOR } = {}) {
  const dir = join(T, `run-${++runs}`); mkdirSync(join(dir, "home"), { recursive: true });
  const svc = stub ? await startStub(world) : null;
  const e = { PATH: `${BIN}:${process.env.PATH}`, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "home/.config"), FLEET_DOCTOR_ROOT: roots[root] || root, FLEET_ENV_FILE: join(dir, "env.local"), FLEET_SERVERS_FILE: join(dir, "servers"), FLEET_DOCTOR_TIMEOUT_MS: String(timeoutMs), FLEET_GRIDPANE_API_URL: svc ? `${svc.url}/gp` : "http://127.0.0.1:1/gp", FAKE_SSH_KEYS: join(dir, "keys"), ...extra };
  if (svc) e.FLEET_SUPABASE_URL = svc.url;
  if (env !== null) writeFileSync(e.FLEET_ENV_FILE, env);
  if (list !== null) writeFileSync(e.FLEET_SERVERS_FILE, list);
  if (keys !== null) writeFileSync(e.FAKE_SSH_KEYS, keys);
  if (wantKey) e.FLEET_SSH_KEY_FP = wantKey;
  const json = join(dir, "doctor.json");
  const started = Date.now();
  const child = spawn(process.execPath, [program, "--json", json, ...args], { env: e, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  // A doctor that waits forever is a failure the test must be able to report, not share.
  const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
  const code = await new Promise((done) => child.on("close", (c, sig) => done(sig ? `killed (${sig})` : c)));
  clearTimeout(killer); children.delete(child);
  if (svc) svc.stop();
  return result({ out, code, log: svc ? svc.log : [], took: Date.now() - started, jsonText: existsSync(json) ? readFileSync(json, "utf8") : "" });
}
// What a run left behind, with the two ways the checks read it: a check's line and its status, from the JSON file.
function result(raw) {
  const lines = raw.out.trimEnd().split("\n");
  let report = null;
  try { report = JSON.parse(raw.jsonText); } catch { /* no file: the checks that need it say so */ }
  const line = (id) => { const c = report && report.checks.find((x) => x.id === id); return c ? `${c.status}: ${c.text}${c.next ? ` Next: ${c.next}` : ""}` : `(no ${id} line)`; };
  const status = (id) => { const c = report && report.checks.find((x) => x.id === id); return c ? c.status : "(none)"; };
  return { ...raw, raw, last: lines.at(-1), end: `${lines.at(-1)}/${raw.code}`, report, line, status };
}
const everything = [];   // every run's output, for the one check about secrets
const run = async (o) => { const r = await doctor(o); everything.push(r.out + r.jsonText); return r; };
// A local port that was open a moment ago and is closed now: a connection to it is refused at once.
const closedPort = () => new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });
const LIST = "203.0.113.10|10001|web1|golden\n203.0.113.11|10002|web2\n203.0.113.12|10003|shop1\n";
const KEYS = KEY_LINE(1) + "\n" + KEY_LINE(2) + "\n";

/* ── the checks ──────────────────────────────────────────────────────────── */
async function checks() {
  const tableCount = snapshot.tables.length, fnCount = snapshot.functions.length;
  const spare = snapshot.tables.map((t) => t.name).filter((n) => !["servers", "sites", "server_agent_secrets"].includes(n)).at(-1);
  const withArgs = snapshot.functions.filter((f) => f.args.split(",").length > 2).at(-1);
  const lastArg = withArgs.args.split(",").at(-1).trim().split(/\s+/)[0];
  const colTable = snapshot.tables.find((t) => t.name === "sites"), lastCol = colTable.columns.at(-1).name;

  const states = {
    fresh: () => run({ root: "fresh", env: null }),
    empty: () => run({ world: { ...healthy(), tables: {}, functions: {}, users: 0, servers: [], agents: [], sites: 0 } }),
    emptyProject: () => run({ world: { ...healthy(), tables: {}, functions: {}, users: 0, servers: [], agents: [], sites: 0, bare: true } }),
    noAgents: () => run({ world: { ...healthy(), servers: MANY, agents: [] } }),
    someAgents: () => run({ world: { ...healthy(), agents: [{ server_id: 10001, last_used_at: AGO(3) }] } }),
    good: () => run({ list: LIST, keys: KEYS }),
    noTable: () => run({ world: (() => { const w = healthy(); delete w.tables[spare]; return w; })() }),
    older: () => run({ world: (() => { const w = healthy(); delete w.functions[snapshot.functions[0].name]; w.functions[withArgs.name] = w.functions[withArgs.name].filter((a) => a !== lastArg); w.tables.sites = w.tables.sites.filter((c) => c !== lastCol); return w; })() }),
    oneColumn: () => run({ world: (() => { const w = healthy(); w.tables.sites = w.tables.sites.filter((c) => c !== lastCol); return w; })() }),
    oneFunction: () => run({ world: (() => { const w = healthy(); delete w.functions[snapshot.functions[0].name]; return w; })() }),
    oneArgument: () => run({ world: (() => { const w = healthy(); w.functions[withArgs.name] = w.functions[withArgs.name].filter((a) => a !== lastArg); return w; })() }),
    quiet: () => run({ world: { ...healthy(), agents: [{ server_id: 10001, last_used_at: AGO(3) }, { server_id: 10002, last_used_at: AGO(190) }, { server_id: 10003, last_used_at: null }] } }),
    neverOnly: () => run({ world: { ...healthy(), agents: [{ server_id: 10001, last_used_at: AGO(3) }, { server_id: 10003, last_used_at: null }] } }),
    gp401: () => run({ world: { ...healthy(), gridpane: 401 } }),
    gp429: () => run({ world: { ...healthy(), gridpane: 429 } }),
    hang: () => run({ world: { ...healthy(), database: "hang", gridpane: "hang" }, timeoutMs: 400 }),
    gpHang: () => run({ world: { ...healthy(), gridpane: "hang" }, timeoutMs: 400 }),
    refused: () => run({ world: { ...healthy(), database: "refuse" } }),
    badPrefix: () => run({ root: "badprefix" }),
    badShape: () => run({ root: "badshape" }),
    noConfig: () => run({ root: "noconfig" }),
    unset: () => run({ env: envText({ GRIDPANE_API_TOKEN: "", SUPABASE_SERVICE_ROLE_KEY: null }) }),
    badUrl: () => run({ env: envText({ NEXT_PUBLIC_SUPABASE_URL: "db.example.com" }) }),
    accessNeither: () => run({}),
    accessBoth: () => run({ env: envText({ CF_ACCESS_TEAM_DOMAIN: "team.example.com", CF_ACCESS_AUD: "a".repeat(64) }) }),
    accessPasted: () => run({ env: envText({ CF_ACCESS_TEAM_DOMAIN: "https://Team.Example.com/", CF_ACCESS_AUD: "a".repeat(64) }) }),
    accessTagOnly: () => run({ env: envText({ CF_ACCESS_AUD: "a".repeat(64) }) }),
    accessTeamOnly: () => run({ env: envText({ CF_ACCESS_TEAM_DOMAIN: "team.example.com", CF_ACCESS_AUD: "   " }) }),
    accessBadTeam: () => run({ env: envText({ CF_ACCESS_TEAM_DOMAIN: "team.example.com/some/path", CF_ACCESS_AUD: "a".repeat(64) }) }),
    twoGolden: () => run({ list: LIST.replace("web2\n", "web2|golden\n"), keys: KEYS }),
    noGolden: () => run({ list: LIST.replace("|golden", ""), keys: KEYS }),
    badLine: () => run({ list: LIST + "not a server line\n", keys: KEYS }),
    noKeys: () => run({ list: LIST }),
    wrongKey: () => run({ list: LIST, keys: KEYS, wantKey: "SHA" + "256:" + random(32).slice(0, 43) }),
    rightKey: () => run({ list: LIST, keys: KEYS, wantKey: KEYS.split("\n")[1].split(" ")[1] }),
    unsynced: () => run({ world: { ...healthy(), servers: [], sites: 0, agents: [] } }),
    noStrong: () => run({ world: (() => { const w = healthy(); delete w.functions.session_is_strong; return w; })() }),
    noSettingsRow: () => run({ world: { ...healthy(), settingsRows: 0 } }),
    baselineOnly: () => run({ world: (() => { const w = healthy(); delete w.functions.session_is_strong; delete w.functions.account_has_authenticator; w.settingsRows = 0; w.tables.sites = w.tables.sites.filter((c) => !LATER_COLUMNS.some(([t, col]) => t === "sites" && col === c)); delete w.tables.sync_runs; return w; })() }),
    noAppRule: () => run({ world: (() => { const w = healthy(); delete w.functions.account_has_authenticator; return w; })() }),
    noCaching: () => run({ world: (() => { const w = healthy(); w.tables.sites = w.tables.sites.filter((c) => c !== "object_caching"); return w; })() }),
    rowsUnread: () => run({ world: { ...healthy(), settingsRows: "unread" } }),
    noSyncTable: () => run({ world: (() => { const w = healthy(); delete w.tables.sync_runs; return w; })() }),
    syncNone: () => run({ world: { ...healthy(), syncRuns: [] } }),
    syncRunning: () => run({ world: { ...healthy(), syncRuns: [{ status: "running", source: "app", phase: "details", started_at: AGO(5), heartbeat_at: AGO(1), finished_at: null, sites_total: 41, sites_done: 12, sites_read: 12, errors: 0, message: null }] } }),
    syncSilent: () => run({ world: { ...healthy(), syncRuns: [{ status: "running", source: "app", phase: "details", started_at: AGO(30), heartbeat_at: AGO(9), finished_at: null, sites_total: 41, sites_done: 12, sites_read: 12, errors: 0, message: null }] } }),
    syncPartial: () => run({ world: { ...healthy(), syncRuns: [{ status: "partial", source: "cli", phase: "done", started_at: AGO(30), heartbeat_at: AGO(5), finished_at: AGO(5), sites_total: 41, sites_done: 41, sites_read: 39, errors: 2, message: null }] } }),
    syncFailed: () => run({ world: { ...healthy(), syncRuns: [{ status: "failed", source: "cli", phase: "done", started_at: AGO(30), heartbeat_at: AGO(5), finished_at: AGO(5), sites_total: null, sites_done: 0, sites_read: 0, errors: 0, message: "GridPane refused [site] page 1 (HTTP 429: too many requests)." }] } }),
    signupsOn: () => run({ world: { ...healthy(), signups: "on" } }),
    signupsUnsaid: () => run({ world: { ...healthy(), signups: "unsaid" } }),
    signupsError: () => run({ world: { ...healthy(), signups: "error" } }),
    signupsHang: () => run({ world: { ...healthy(), signups: "hang" }, timeoutMs: 400 }),
    anonWrong: () => run({ env: envText({ NEXT_PUBLIC_SUPABASE_ANON_KEY: `anon.${random(40)}` }) }),
    anonUnset: () => run({ env: envText({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "" }) }),
    noApp: () => run({ world: { ...healthy(), accounts: [WITH_APP, { signedIn: true, factors: [] }, WITH_APP] } }),
    halfApp: () => run({ world: { ...healthy(), accounts: [WITH_APP, { signedIn: true, factors: [HALF, { factor_type: "phone", status: "verified" }] }] } }),
    neverIn: () => run({ world: { ...healthy(), accounts: [WITH_APP, { signedIn: false, factors: [] }, { signedIn: false, factors: [] }] } }),
    usedAndNew: () => run({ world: { ...healthy(), accounts: [{ signedIn: false, factors: [] }, { signedIn: true, factors: [] }] } }),
    factorsError: () => run({ world: { ...healthy(), accounts: [WITH_APP, { signedIn: true, factors: "error" }] } }),
    factorsBlank: () => run({ world: { ...healthy(), accounts: [WITH_APP, { signedIn: true, factors: "blank" }] } }),
    factorsHang: () => run({ world: { ...healthy(), accounts: [{ signedIn: true, factors: "hang" }] }, timeoutMs: 400 }),
    manyAccounts: () => run({ world: { ...healthy(), accounts: Array.from({ length: 50 }, () => WITH_APP), total: 53 } }),
    nullFactors: () => run({ world: { ...healthy(), accounts: [WITH_APP, { signedIn: true, factors: null }] } }),
    noCountFull: () => run({ world: { ...healthy(), accounts: Array.from({ length: 50 }, () => WITH_APP), total: "none" } }),
    noCountFew: () => run({ world: { ...healthy(), accounts: [WITH_APP, WITH_APP, WITH_APP], total: "none" } }),
    oddCount: () => run({ world: { ...healthy(), accounts: Array.from({ length: 50 }, () => WITH_APP), total: "many" } }),
    manyWrong: () => run({ world: { ...healthy(), accounts: [{ signedIn: true, factors: [] }, { signedIn: false, factors: [] }, { signedIn: true, factors: "error" }, ...Array.from({ length: 47 }, () => WITH_APP)], total: 53 } }),
    usage: () => doctor({ args: ["--fix"] }),
    usage2: () => doctor({ args: ["--json"] }),
    notCheckout: () => run({ root: join(T, "not-a-checkout") }),
    deaf: async () => { const port = await closedPort(); return run({ stub: false, env: envText({ NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}` }), extra: { FLEET_GRIDPANE_API_URL: `http://127.0.0.1:${port}/gp` } }); },
    onePackage: () => run({ root: "oneshort" }),
  };
  // A control names the states that must catch it. Only those are run again with the broken copy;
  // the others are read back from the run of the doctor as it is, which the controls made first.
  const only = process.env.FLEET_DOCTOR_TEST_STATES ? new Set(process.env.FLEET_DOCTOR_TEST_STATES.split(",")) : null;
  const saved = only ? JSON.parse(readFileSync(process.env.FLEET_DOCTOR_TEST_SAVED, "utf8")) : {};
  // A few at a time, not all at once: each run is given 10 seconds before it is killed, and fifty
  // doctors started together on a small machine (GitHub's Mac runner has three cores) outlast it.
  const entries = Object.entries(states), done = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < entries.length) {
      const i = next++, [name, start] = entries[i];
      done[i] = only && !only.has(name) ? result(saved[name]) : await start();
    }
  }));
  if (process.env.FLEET_DOCTOR_TEST_SAVE) writeFileSync(process.env.FLEET_DOCTOR_TEST_SAVE, JSON.stringify(Object.fromEntries(Object.keys(states).map((name, i) => [name, done[i].raw]))));
  const { fresh, empty, good, noTable, older, oneColumn, oneFunction, oneArgument, quiet, neverOnly, gp401, gp429, hang, gpHang, refused, badPrefix, badShape, noConfig, unset, badUrl, twoGolden, noGolden, badLine, noKeys, wrongKey, rightKey, unsynced, noStrong, noSettingsRow, baselineOnly, rowsUnread, noSyncTable, syncNone, syncRunning, syncSilent, syncPartial, syncFailed, signupsOn, signupsUnsaid, signupsError, signupsHang, anonWrong, anonUnset, noApp, halfApp, neverIn, usedAndNew, factorsError, factorsHang, manyAccounts, usage, usage2, notCheckout, deaf, onePackage } = Object.fromEntries(Object.keys(states).map((name, i) => [name, done[i]]));
  const { nullFactors, noCountFull, noCountFew, oddCount, manyWrong, factorsBlank, noAppRule, noCaching } = Object.fromEntries(Object.keys(states).map((name, i) => [name, done[i]]));
  const { emptyProject, noAgents, someAgents } = Object.fromEntries(Object.keys(states).map((name, i) => [name, done[i]]));
  const { accessNeither, accessBoth, accessPasted, accessTagOnly, accessTeamOnly, accessBadTeam } = Object.fromEntries(Object.keys(states).map((name, i) => [name, done[i]]));
  // --show prints what the doctor said in each state, for a person reading along.
  if (process.argv.includes("--show")) for (const name of Object.keys(states)) console.log(`──── ${name} (exit ${done[Object.keys(states).indexOf(name)].code}) ────\n${done[Object.keys(states).indexOf(name)].out}`);

  section("Nothing configured (a fresh copy: the example config, no packages, no settings file):");
  ok("ends incomplete, exit 0: nothing is broken, and it is not a crash", fresh.end, "doctor=incomplete/0");
  ok("Node is new enough", fresh.status("tools.node"), "ok");
  has("the packages are not installed, with the command", fresh.line("tools.packages"), "not_yet: The npm packages are not installed. Next: npm install");
  has("the config is still the example", fresh.line("settings.config"), "not_yet: fleet.config.ts is still the example (hostname fleet.example.com)");
  has("the settings file is missing, with the command", fresh.line("settings.env"), "Next: cp .env.example .env.local");
  has("and it names what to fill in, from .env.example", fresh.line("settings.env"), "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, GRIDPANE_API_TOKEN");
  hasnt("the optional settings are not asked for", fresh.line("settings.env"), "CF_ACCESS");
  ok("the database is not yet", fresh.status("database.reachable"), "not_yet");
  ok("sign-in is not yet", fresh.status("signin.users"), "not_yet");
  ok("GridPane is not yet", fresh.status("gridpane.token"), "not_yet");
  ok("sync is not yet", fresh.status("sync.rows"), "not_yet");
  ok("the agents are not yet", fresh.status("agents"), "not_yet");
  ok("the server list is not yet, not a failure", fresh.status("machine.servers"), "not_yet");
  ok("the SSH key is not yet, not a failure", fresh.status("machine.ssh"), "not_yet");
  ok("every line is ok or not yet", fresh.report ? fresh.report.checks.filter((c) => !["ok", "not_yet"].includes(c.status)).length : -1, 0);
  ok("nothing was asked of any service", fresh.log.length, 0);
  has("the summary counts what it looked at", fresh.out, "doctor: 11 checks: 1 ok, 10 not yet, 0 failed, 0 could not be looked at");
  has("and says what the state means", fresh.out, "Nothing is broken. 10 steps not done yet");

  section("Configured, with an empty database:");
  ok("ends incomplete, exit 0", empty.end, "doctor=incomplete/0");
  has("the packages are installed, counted from package.json", empty.line("tools.packages"), `ok: The npm packages are installed (all ${packageNames.length} that package.json names).`);
  has("the config passes its test, counted", empty.line("settings.config"), "ok: fleet.config.ts passes the config test (");
  has("the settings are named with their lengths", empty.line("settings.env"), `SUPABASE_SERVICE_ROLE_KEY (${SECRETS.SUPABASE_SERVICE_ROLE_KEY.length} characters)`);
  has("and the optional ones are counted, not required", empty.line("settings.env"), "Optional: 2 of 10 set (not set: CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, SSO_ALLOWED_USER_IDS, PATCHSTACK_MODE, PATCHSTACK_SITE_UUID, PATCHSTACK_WAF_TOKEN, PATCHSTACK_ENVIRONMENT, PATCHSTACK_API_KEY)");
  ok("the database answers", empty.status("database.reachable"), "ok");
  has("no tables reads as migrations not run, not as an old database", empty.line("database.schema"), `not_yet: The database has none of the ${tableCount} tables this code needs: the migrations have not been run yet.`);
  has("with where the migrations are", empty.line("database.schema"), "Next: apply the files in supabase/migrations/");
  has("no user yet, with how to make the first", empty.line("signin.users"), "not_yet: No user exists yet, so nobody can sign in. Next: npm run user:create -- <your email>");
  ok("GridPane accepts the token", empty.status("gridpane.token"), "ok");
  ok("sync waits for the tables", empty.status("sync.rows"), "not_yet");
  ok("the agents wait too", empty.status("agents"), "not_yet");

  section("A new project with no tables (its answer has no definitions key at all):");
  ok("the database answers", emptyProject.status("database.reachable"), "ok");
  has("no tables reads as migrations not run, not as unreadable", emptyProject.line("database.schema"), `not_yet: The database has none of the ${tableCount} tables this code needs: the migrations have not been run yet.`);
  ok("ends incomplete, exit 0", emptyProject.end, "doctor=incomplete/0");

  section("Healthy:");
  ok("ends ok, exit 0", good.end, "doctor=ok/0");
  has("the database has everything, counted from the snapshot", good.line("database.schema"), `ok: The database has everything this code needs: ${tableCount} tables, ${snapshot.tables.reduce((n, t) => n + t.columns.length, 0)} columns, ${fnCount} functions.`);
  has("the users are counted, never named", good.line("signin.users"), "ok: 3 users exist.");
  hasnt("no user's address is printed", good.out, "someone@");
  has("the rows are counted", good.line("sync.rows"), "ok: The database holds 3 servers and 41 sites.");
  hasnt("with a sync record, it does not say the time is unrecorded", good.line("sync.rows"), "does not record when a sync last ran");
  has("the last sync is read from its record", good.line("sync.last"), "ok: The last sync finished 60 minutes ago and read all 41 sites.");
  has("each agent has its own line", good.line("agents.10002"), "ok: web2: the agent reported 3 minutes ago.");
  ok("three agents, three lines", good.report ? good.report.checks.filter((c) => c.id.startsWith("agents.")).length : -1, 3);
  has("the server list parses, with its golden server", good.line("machine.servers"), "ok: The server list parses: 3 servers, one marked golden (web1).");
  has("the agent's keys are counted", good.line("machine.ssh"), "ok: The ssh-agent holds 2 keys.");
  has("row level security is said to be unreadable, with how to check it", good.line("database.rls"), "could_not_check: Row level security: the keys in .env.local cannot read whether it is on for every table. Next: npm run schema:dump   then   npm run schema:drift");
  ok("that is the only line not ok", good.report ? good.report.checks.filter((c) => c.status !== "ok").map((c) => c.id).join(",") : "", "database.rls");
  has("the summary counts it apart", good.out, "0 could not be looked at, 1 cannot be checked from here; looked at");
  has("and the closing sentence does not read as a clean bill: it sends the reader to that line", good.out, 'Everything checked is set up and working. 1 thing cannot be checked from here: read each "could not check" line above.');
  has("and says how much was looked at", good.out, `${tableCount} tables,`);
  ok("GridPane was asked exactly once", good.log.filter((r) => r.path.startsWith("/gp/")).length, 1);
  ok("the database was asked eleven times: eight reads (one is the last sync), and one for each of the 3 accounts", good.log.filter((r) => !r.path.startsWith("/gp/")).length, 11);
  ok("each account was asked for its factors once", good.log.filter((r) => /\/admin\/users\/[0-9a-f-]{36}\/factors$/.test(r.path)).length, 3);
  has("every account has an authenticator app", good.line("signin.factors"), "ok: Every account has an authenticator app (3 accounts), so none can be entered with a password alone.");
  has("sign-ups are off", good.line("signin.signups"), "ok: Sign-ups are off: an account can only be made by you.");
  ok("every request only reads (GET or HEAD)", good.log.filter((r) => !["GET", "HEAD"].includes(r.method)).length, 0);
  ok("the JSON file says the same as the last line", good.report ? `${good.report.doctor}/${good.report.exit}/${good.report.counts.checks}` : "(no file)", `ok/0/${good.report ? good.report.checks.length : 0}`);
  ok("one output line per check", good.out.split("\n").filter((l) => /^ {2}(ok|not yet|FAIL|could not check) /.test(l)).length, good.report ? good.report.checks.length : -1);

  section("A database older than the code:");
  ok("one missing table: ends problems, exit 1", noTable.end, "doctor=problems/1");
  has("it is named, and read as an old database", noTable.line("database.schema"), `fail: The database is older than this code. It has ${tableCount - 1} of the ${tableCount} tables and is missing 1 table (${spare}).`);
  has("with what to do", noTable.line("database.schema"), "Next: apply the newer files in supabase/migrations/");
  ok("a missing column alone: ends problems, exit 1", oneColumn.end, "doctor=problems/1");
  has("it is named, with the tables all counted as there", oneColumn.line("database.schema"), `It has ${tableCount} of the ${tableCount} tables and is missing 1 column (sites.${lastCol}).`);
  ok("a missing function alone: ends problems, exit 1", oneFunction.end, "doctor=problems/1");
  has("it is named", oneFunction.line("database.schema"), `is missing 1 function (${snapshot.functions[0].name}).`);
  ok("a function without its newest argument, alone: ends problems, exit 1", oneArgument.end, "doctor=problems/1");
  has("it is named", oneArgument.line("database.schema"), `is missing 1 function argument (${withArgs.name}(${lastArg})).`);
  ok("all three at once: ends problems, exit 1", older.end, "doctor=problems/1");
  has("the column is named", older.line("database.schema"), `1 column (sites.${lastCol})`);
  has("the function is named", older.line("database.schema"), `1 function (${snapshot.functions[0].name})`);
  has("the argument is named", older.line("database.schema"), `1 function argument (${withArgs.name}(${lastArg}))`);

  section("A migration after the baseline that was not applied (it adds no table, so the table list cannot show it):");
  ok("the migrations the test knows are the ones in the repository", readdirSync(join(REPO, "supabase/migrations")).filter((f) => !/_baseline\.sql$/.test(f)).sort().join(","), LATER.map((m) => m.file).join(","));
  has("healthy: what each one adds is there, named", good.line("database.migrations"), "ok: What the 5 migrations after the baseline add is there: a row in app_settings, the function session_is_strong, the function account_has_authenticator, the column sites.nginx_caching_ttl, the column sites.object_caching, the column sites.object_cache_pro, the table sync_runs.");
  ok("the authenticator rule's function missing: problems, exit 1", noAppRule.end, "doctor=problems/1");
  has("only that file is named: the function it merely changes is not held against it", noAppRule.line("database.migrations"), "fail: A migration has not been applied to the database: 20261122000000_authenticator_rule.sql (the function account_has_authenticator is not there).");
  has("and the command to apply it", noAppRule.line("database.migrations"), "Next: bash scripts/apply-sql.sh supabase/migrations/20261122000000_authenticator_rule.sql --dry-run   then the same without --dry-run.");
  ok("one column the caching migration adds missing: problems, exit 1", noCaching.end, "doctor=problems/1");
  has("that file is named, with the one column missing and not the two that are there", noCaching.line("database.migrations"), "fail: A migration has not been applied to the database: 20261123000000_site_caching.sql (the column sites.object_caching is not there).");
  ok("the second-factor rule's function missing: problems, exit 1", noStrong.end, "doctor=problems/1");
  has("the file is named, with why", noStrong.line("database.migrations"), "fail: A migration has not been applied to the database: 20261121000000_strong_session.sql (the function session_is_strong is not there).");
  has("and the command to apply it, tried first", noStrong.line("database.migrations"), "Next: bash scripts/apply-sql.sh supabase/migrations/20261121000000_strong_session.sql --dry-run   then the same without --dry-run.");
  ok("the tables themselves are still all there", noStrong.status("database.schema"), "ok");
  ok("the settings row missing: problems, exit 1", noSettingsRow.end, "doctor=problems/1");
  has("the file is named, with why", noSettingsRow.line("database.migrations"), "fail: A migration has not been applied to the database: 20261120000100_settings_row.sql (the table app_settings has no row).");
  ok("only the baseline applied: problems, exit 1", baselineOnly.end, "doctor=problems/1");
  has("both are named, oldest first", baselineOnly.line("database.migrations"), "fail: 5 migrations have not been applied to the database: 20261120000100_settings_row.sql (the table app_settings has no row); 20261121000000_strong_session.sql (the function session_is_strong is not there); 20261122000000_authenticator_rule.sql (the function account_has_authenticator is not there); 20261123000000_site_caching.sql (the column sites.nginx_caching_ttl is not there, the column sites.object_caching is not there, the column sites.object_cache_pro is not there); 20261124000000_sync_runs.sql (the table sync_runs is not there).");
  has("and the command starts with the oldest", baselineOnly.line("database.migrations"), "Next: bash scripts/apply-sql.sh supabase/migrations/20261120000100_settings_row.sql --dry-run   then the same without --dry-run, and the same for each of the others, oldest first.");
  ok("a table that will not be counted: could not look, exit 3, never a pass", `${rowsUnread.end}/${rowsUnread.status("database.migrations")}`, "doctor=blind/3/could_not_check");
  ok("with no tables at all there is no line about later migrations: the one above says to run them", empty.status("database.migrations"), "(none)");
  ok("nor when a table is missing", noTable.status("database.migrations"), "(none)");
  ok("the sync record's table missing: problems, exit 1", noSyncTable.end, "doctor=problems/1");
  has("that file is named, with why", noSyncTable.line("database.migrations"), "fail: A migration has not been applied to the database: 20261124000000_sync_runs.sql (the table sync_runs is not there).");
  has("and the sync line says the time is not recorded", noSyncTable.line("sync.rows"), "does not record when a sync last ran");
  ok("and there is no line about the last sync", noSyncTable.status("sync.last"), "(none)");

  section("The last sync, from its record:");
  has("none recorded yet: not yet, with the wait GridPane needs", syncNone.line("sync.last"), "not_yet: No sync is recorded yet");
  has("and the command", syncNone.line("sync.last"), "Next: npm run sync   (or Sync in the app). GridPane allows about 12 requests a minute, and this doctor spent one: wait a minute first.");
  has("running and reporting: ok, with its count", syncRunning.line("sync.last"), "ok: A sync is running now: started in the app 5 minutes ago, 12 of 41 sites so far.");
  has("and how to follow it", syncRunning.line("sync.last"), "npm run sync:status -- --watch");
  has("running but silent for nine minutes: not yet, never ok", syncSilent.line("sync.last"), "not_yet: The last sync, started in the app 30 minutes ago, stopped reporting 9 minutes ago (the tab that ran it was probably closed).");
  has("finished with sites not read: not yet, with the count", syncPartial.line("sync.last"), "not_yet: The last sync finished 5 minutes ago with 2 sites not read");
  has("failed: not yet, with the reason", syncFailed.line("sync.last"), "not_yet: The last sync failed 5 minutes ago: GridPane refused [site] page 1");

  section("Server agents:");
  ok("one agent quiet for three hours: ends problems, exit 1", quiet.end, "doctor=problems/1");
  has("it is named, with how long", quiet.line("agents.10002"), "fail: web2: the agent last reported 3 hours ago, more than 30 minutes.");
  has("and what to do on that server", quiet.line("agents.10002"), "Next: on that server, run /root/telemetry-agent.sh by hand");
  has("a fresh one beside it is ok", quiet.line("agents.10001"), "ok: web1: the agent reported 3 minutes ago.");
  has("one that never reported is listed by label, as not yet", quiet.line("agents.10003"), "not_yet: shop1: a token is registered, and the agent has never reported with it.");
  has("twelve servers with no agents share one line, with the count", noAgents.line("agents.no_token"), "not_yet: 12 servers (srv1, srv2, srv3, srv4, srv5, srv6, srv7, srv8 and 4 more): no agent token is registered for them");
  ok("and that is the only agents line", noAgents.report ? noAgents.report.checks.filter((c) => c.id.startsWith("agents")).length : -1, 1);
  has("two servers in the same state share a line", someAgents.line("agents.no_token"), "not_yet: 2 servers (web2, shop1): no agent token is registered for them");
  has("a server in another state keeps its own line", someAgents.line("agents.10001"), "ok: web1: the agent reported 3 minutes ago.");
  ok("one ok line and one shared line", someAgents.report ? someAgents.report.checks.filter((c) => c.id.startsWith("agents")).map((c) => c.id).join(",") : "", "agents.10001,agents.no_token");
  ok("agents that never reported, none quiet: incomplete, exit 0", neverOnly.end, "doctor=incomplete/0");
  has("a server with no token is listed by label", neverOnly.line("agents.10002"), "not_yet: web2: no agent token is registered for it");

  section("GridPane:");
  ok("the token refused: ends problems, exit 1", gp401.end, "doctor=problems/1");
  has("with where to make a new one", gp401.line("gridpane.token"), "fail: GridPane refused the API token (HTTP 401). Next: make a new token in GridPane");
  ok("asked once, not again after the refusal", gp401.log.filter((r) => r.path.startsWith("/gp/")).length, 1);
  ok("too many requests: could not look, exit 3", gp429.end, "doctor=blind/3");
  has("it says to wait, not to retry", gp429.line("gridpane.token"), "could_not_check: GridPane says too many requests (HTTP 429), so the token was not checked. Next: wait a full minute");
  ok("and it asked once", gp429.log.filter((r) => r.path.startsWith("/gp/")).length, 1);

  section("A service that never answers:");
  ok("ends blind, exit 3: could not look is not a pass", hang.end, "doctor=blind/3");
  has("the database line says it waited, and how long", hang.line("database.reachable"), "could_not_check: The database did not answer: no answer in 0.4 seconds.");
  has("GridPane the same", hang.line("gridpane.token"), "could_not_check: GridPane did not answer: no answer in 0.4 seconds.");
  ok("what depends on the database is could not check, not ok", [hang.status("signin.users"), hang.status("sync.rows"), hang.status("agents")].join(","), "could_not_check,could_not_check,could_not_check");
  ok("it gave up in good time", hang.took < 8000 ? "yes" : `no (${hang.took} ms)`, "yes");
  has("the summary counts what it could not look at", hang.out, "5 could not be looked at");
  ok("GridPane alone silent: still blind, exit 3", gpHang.end, "doctor=blind/3");
  ok("with the database lines ok", gpHang.status("database.schema"), "ok");
  ok("nothing listening at the database address: blind, exit 3", deaf.end, "doctor=blind/3");
  has("and it says the connection failed", deaf.line("database.reachable"), "could_not_check: The database did not answer: the connection failed (ECONNREFUSED).");

  section("The service-role key refused:");
  ok("ends problems, exit 1", refused.end, "doctor=problems/1");
  has("with where to copy it from", refused.line("database.reachable"), "fail: The database refused the service-role key (HTTP 401). Next: copy the service_role key again");
  ok("what depends on it is not yet, not could not check", [refused.status("signin.users"), refused.status("sync.rows"), refused.status("agents")].join(","), "not_yet,not_yet,not_yet");

  section("The settings files:");
  ok("a prefix the server scripts refuse: problems, exit 1", badPrefix.end, "doctor=problems/1");
  has("with the rule it broke", badPrefix.line("settings.config"), 'fail: fleet.config.ts does not pass the rules the server scripts hold it to: the server prefix (server.prefix, FLEET_PREFIX) is "Bad-Prefix". It must be 2 to 15 lowercase letters and digits');
  ok("a config with a key missing: problems, exit 1", badShape.end, "doctor=problems/1");
  has("the config test's own words", badShape.line("settings.config"), "fail: fleet.config.ts does not pass the config test: the two config files have the same keys and types");
  has("no config at all is not yet, with the command", noConfig.line("settings.config"), "not_yet: fleet.config.ts is not there. Next: cp fleet.config.example.ts fleet.config.ts");
  has("a setting left empty and one left out are both named", unset.line("settings.env"), "has 2 of the 4 required settings; not filled in: SUPABASE_SERVICE_ROLE_KEY, GRIDPANE_API_TOKEN.");
  ok("and that is not yet", unset.status("settings.env"), "not_yet");
  ok("so the database is not asked", unset.log.length, 0);
  has("an address that is not one is a failure, shown by length only", badUrl.line("settings.env"), "fail: In ");
  has("with its length", badUrl.line("settings.env"), "NEXT_PUBLIC_SUPABASE_URL is not an address (14 characters; it should start with https://)");
  section("The two Cloudflare Access settings in .env.local (they belong on the Worker; here they make a local run refuse every request):");
  ok("neither set: the doctor says nothing about them", accessNeither.status("settings.access"), "(none)");
  ok("both set: flagged, as something the doctor cannot check from here", accessBoth.status("settings.access"), "could_not_check");
  has("it says what a local run will do", accessBoth.line("settings.access"), "sets both Cloudflare Access settings, so a local run (npm run dev) refuses every request unless this machine's copy of the app sits behind Cloudflare Access.");
  has("and what to do, with where the settings do belong", accessBoth.line("settings.access"), "take CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD out of ");
  has("naming the script that stores them on the Worker", accessBoth.line("settings.access"), "The deployed Worker keeps its own copies: bash scripts/set-access-check.sh");
  has("and saying to copy them to the privacy list's own file first, so they are not lost from it", accessBoth.line("settings.access"), "Copy what you take out to ~/.config/fleet/privacy-extra first (the same lines), so npm run privacy:denylist still keeps it out of anything you publish");
  ok("that is not a failure and not a blind spot: the run ends as it would without them", `${accessBoth.end} ${accessBoth.report.counts.fail} ${accessBoth.report.counts.could_not_look}`, `${accessNeither.end} ${accessNeither.report.counts.fail} ${accessNeither.report.counts.could_not_look}`);
  ok("and it is counted among what cannot be checked from here", accessBoth.report.counts.cannot_be_checked_here, accessNeither.report.counts.cannot_be_checked_here + 1);
  ok("with one more line than without them", accessBoth.report.counts.checks, accessNeither.report.counts.checks + 1);
  has("the closing sentence counts it, so the last thing read is not 'all working'", accessBoth.out, `. ${accessNeither.report.counts.cannot_be_checked_here + 1} ${accessNeither.report.counts.cannot_be_checked_here ? "things" : "thing"} cannot be checked from here: read each "could not check" line above.`);
  ok("an address pasted with https:// and a slash is the same case, not a wrong address", accessPasted.status("settings.access"), "could_not_check");
  ok("only the tag set: a failure, exit 1", `${accessTagOnly.status("settings.access")} ${accessTagOnly.end}`, "fail doctor=problems/1");
  has("it names the one that is set and the one that is not", accessTagOnly.line("settings.access"), "sets CF_ACCESS_AUD and not CF_ACCESS_TEAM_DOMAIN. With only one of the two set, a local run (npm run dev) refuses every request, the login page included.");
  has("and says to take it out", accessTagOnly.line("settings.access"), "Next: take CF_ACCESS_AUD out of ");
  has("after copying it to the privacy list's own file", accessTagOnly.line("settings.access"), "Copy what you take out to ~/.config/fleet/privacy-extra first");
  has("only the address set (the tag is spaces): the same, the other way round", accessTeamOnly.line("settings.access"), "sets CF_ACCESS_TEAM_DOMAIN and not CF_ACCESS_AUD.");
  ok("which is a failure too", accessTeamOnly.status("settings.access"), "fail");
  ok("an address with a path in it: a failure, exit 1", `${accessBadTeam.status("settings.access")} ${accessBadTeam.end}`, "fail doctor=problems/1");
  has("shown by its length only", accessBadTeam.line("settings.access"), "CF_ACCESS_TEAM_DOMAIN is not a team address (26 characters; it should be the name alone, like yourteam.cloudflareaccess.com)");
  hasnt("the address itself is not repeated", accessBadTeam.out, "team.example.com/some/path");
  hasnt("and the tag is never shown", accessBoth.out + accessTagOnly.out + accessBadTeam.out, "a".repeat(64));
  has("the settings line still counts them as optional settings that are set", accessBoth.line("settings.env"), "Optional: 4 of 10 set (not set: SSO_ALLOWED_USER_IDS, PATCHSTACK_MODE, PATCHSTACK_SITE_UUID, PATCHSTACK_WAF_TOKEN, PATCHSTACK_ENVIRONMENT, PATCHSTACK_API_KEY)");
  has("one package missing is named, with the command", onePackage.line("tools.packages"), `not_yet: 1 of the ${packageNames.length} npm packages is not installed: ${packageNames[0]}. Next: npm install`);

  section("This machine:");
  ok("two servers marked golden: problems, exit 1", twoGolden.end, "doctor=problems/1");
  has("in the list reader's own words", twoGolden.line("machine.servers"), "marks more than one server golden");
  has("no golden mark is not yet, with what to add", noGolden.line("machine.servers"), "not_yet: The server list parses (3 servers) and no line is marked golden. Next: add |golden");
  has("a line that is not a server stops it", badLine.line("machine.servers"), "fail: The server list does not parse:");
  has("an empty agent is not yet, with the command", noKeys.line("machine.ssh"), "not_yet: No ssh-agent holds a key, so the server scripts cannot sign in to a server. Next: ssh-add");
  has("an agent without the named key is a failure", wrongKey.line("machine.ssh"), "fail: An ssh-agent holds 2 keys, and none is the one named in $FLEET_SSH_KEY_FP.");
  has("an agent with the named key is ok", rightKey.line("machine.ssh"), "ok: The ssh-agent holds 2 keys, the one named in $FLEET_SSH_KEY_FP among them.");
  hasnt("a key's fingerprint is never printed", wrongKey.out + rightKey.out + good.out, "SHA" + "256:");

  section("Tables there, nothing synced:");
  ok("ends incomplete, exit 0", unsynced.end, "doctor=incomplete/0");
  has("with the command", unsynced.line("sync.rows"), "not_yet: The servers table is empty: nothing has been synced from GridPane yet. Next: npm run sync");
  has("and no agents to look at", unsynced.line("agents"), "not_yet: No servers yet");

  section("Accounts that a password alone can enter:");
  ok("an account that has signed in and has no authenticator app: ends problems, exit 1", noApp.end, "doctor=problems/1");
  has("it says how many, which by the start of the id, and what that allows", noApp.line("signin.factors"), "fail: 1 account that has signed in before has no authenticator app (id 00000000…), so its password alone is enough to enter: whoever signs in can add an authenticator app or a passkey of their own.");
  has("and what to do", noApp.line("signin.factors"), "Next: sign in as that account and set up the authenticator app the login page asks for, or remove the account");
  hasnt("no address is printed for it", noApp.out, "@example.com");
  ok("an authenticator app never confirmed, and a confirmed factor of another kind, do not count", halfApp.status("signin.factors"), "fail");
  ok("accounts that have never signed in: a step still to do, exit 0", `${neverIn.end}/${neverIn.status("signin.factors")}`, "doctor=incomplete/0/not_yet");
  has("it says the password alone is enough until then", neverIn.line("signin.factors"), "not_yet: 2 accounts have never signed in and have no authenticator app yet (id 00000000…, 00000000…). Until it is set up, the password alone is enough to enter.");
  has("and what to do now", neverIn.line("signin.factors"), "Next: sign in as that account now and set up the authenticator app the login page asks for, or remove it in Supabase under Authentication > Users.");
  has("a used account without one is the failure, even beside a new one", usedAndNew.line("signin.factors"), "fail: 1 account that has signed in before has no authenticator app");
  ok("factors that could not be read: could not look, exit 3, never a pass", `${factorsError.end}/${factorsError.status("signin.factors")}`, "doctor=blind/3/could_not_check");
  ok("an empty 200 is not a list either: could not look, never 'no factors'", `${factorsBlank.end}/${factorsBlank.status("signin.factors")}`, "doctor=blind/3/could_not_check");
  ok("the service silent on an account's factors: could not look, exit 3", `${factorsHang.end}/${factorsHang.status("signin.factors")}`, "doctor=blind/3/could_not_check");
  has("more accounts than it asks about: it says how many were not looked at", manyAccounts.line("signin.factors"), "could_not_check: Only the first 50 accounts were looked at; the other 3 were not. The other 50 accounts that were looked at each have an authenticator app. Next: look at the rest in Supabase under Authentication > Users.");
  ok("it asked about 50 and no more", manyAccounts.log.filter((r) => /\/factors$/.test(r.path)).length, 50);
  ok("with no user yet there is no line about factors", empty.status("signin.factors"), "(none)");
  ok("an account whose factor list comes back as the word null has none: it is the failure, not a read that failed", `${nullFactors.end}/${nullFactors.status("signin.factors")}`, "doctor=problems/1/fail");
  has("and it is named like any other", nullFactors.line("signin.factors"), "fail: 1 account that has signed in before has no authenticator app (id 00000000…)");
  ok("a full page of accounts with no count from the service: not a pass, exit 3", `${noCountFull.end}/${noCountFull.status("signin.factors")}`, "doctor=blind/3/could_not_check");
  has("it says there may be more", noCountFull.line("signin.factors"), "could_not_check: Only the first 50 accounts were looked at: the sign-in service did not say how many there are, and there may be more.");
  has("and the line about users does not claim a total", noCountFull.line("signin.users"), "ok: At least 50 users exist (the sign-in service did not say how many there are).");
  ok("a count that is not a number is no count", oddCount.status("signin.factors"), "could_not_check");
  ok("a short page with no count is the whole list", `${noCountFew.status("signin.factors")}/${noCountFew.line("signin.users")}`, "ok/ok: 3 users exist.");
  ok("several things wrong at once: the worst decides, exit 1", `${manyWrong.end}/${manyWrong.status("signin.factors")}`, "doctor=problems/1/fail");
  for (const [what, text] of [["the used account with no app", "1 account that has signed in before has no authenticator app (id 00000000…)"], ["the account that never signed in", "1 account has never signed in and has no authenticator app yet (id 00000000…)"], ["the account whose factors could not be read", "did not list the sign-in factors of 1 account (id 00000000…)"], ["the accounts past the first 50", "Only the first 50 accounts were looked at; the other 3 were not."], ["how many were fine", "The other 47 accounts that were looked at each have an authenticator app."]])
    has(`and the one line names ${what}`, manyWrong.line("signin.factors"), text);
  has("with what to do about each", manyWrong.line("signin.factors"), "Next: sign in as that account and set up the authenticator app the login page asks for, or remove the account in Supabase under Authentication > Users (SECURITY.md says why). Then: run this again in a moment. Then: look at the rest in Supabase under Authentication > Users.");

  section("Sign-ups:");
  ok("sign-ups left on: ends problems, exit 1", signupsOn.end, "doctor=problems/1");
  has("it says what a stranger could do", signupsOn.line("signin.signups"), "fail: Sign-ups are on: anyone who has the public key can make an account");
  has("and where to turn them off", signupsOn.line("signin.signups"), 'Next: in your Supabase project, under Authentication, turn off "Allow new users to sign up"');
  ok("it was asked with the public key, once", signupsOn.log.filter((r) => r.path === "/auth/v1/settings").length, 1);
  ok("an answer that does not say: could not look, exit 3, never a pass", signupsUnsaid.end, "doctor=blind/3");
  has("it says so, with where to look by hand", signupsUnsaid.line("signin.signups"), "could_not_check: The sign-in service answered HTTP 200 without saying whether sign-ups are on.");
  ok("the service failing, whatever its answer carries: could not look, exit 3", `${signupsError.end}/${signupsError.status("signin.signups")}`, "doctor=blind/3/could_not_check");
  ok("the service silent: could not look, exit 3", `${signupsHang.end}/${signupsHang.status("signin.signups")}`, "doctor=blind/3/could_not_check");
  has("with how long it waited", signupsHang.line("signin.signups"), "no answer in 0.4 seconds");
  ok("a public key the service refuses: problems, exit 1", anonWrong.end, "doctor=problems/1");
  has("it names the setting to copy again", anonWrong.line("signin.signups"), "fail: The sign-in service refused the public (anon) key (HTTP 401)");
  has("no public key set: not yet, and it was not asked", `${anonUnset.status("signin.signups")}/${anonUnset.log.filter((r) => r.path === "/auth/v1/settings").length}`, "not_yet/0");
  ok("when the database is not set up, there is no sign-ups line of its own", fresh.status("signin.signups"), "(none)");

  section("When it cannot run:");
  ok("an unknown option: exit 2", usage.end, "doctor=blind/2");
  ok("--json with no file: exit 2", usage2.end, "doctor=blind/2");
  ok("a folder that is not a checkout: blind, exit 3", notCheckout.end, "doctor=blind/3");

  section("A copy of the doctor changed on purpose (the paths a healthy machine never takes):");
  const source = readFileSync(DOCTOR, "utf8");
  const variant = (name, from, to) => { const text = source.split(from).join(to); const file = join(T, `variant-${name}.mjs`); writeFileSync(file, text); return text === source ? null : file; };
  const leaky = variant("leaky", '"GridPane accepts the API token."', "`GridPane accepts the API token ${gpToken} with ${serviceKey}.`");
  const oldNode = variant("oldnode", "const NODE_NEEDED = [22, 6];", "const NODE_NEEDED = [99, 0];");
  ok("both changes applied", leaky && oldNode ? "yes" : "no", "yes");
  if (leaky && oldNode && (!only || only.has("variants"))) {
    const [l, o] = await Promise.all([doctor({ program: leaky }), doctor({ program: oldNode })]);
    has("a line that tries to carry two secrets prints neither", l.line("gridpane.token"), "ok: GridPane accepts the API token [hidden] with [hidden].");
    hasnt("the token is not in that run's output", l.out + l.jsonText, SECRETS.GRIDPANE_API_TOKEN);
    hasnt("nor the service-role key", l.out + l.jsonText, SECRETS.SUPABASE_SERVICE_ROLE_KEY);
    ok("a Node that is too old: problems, exit 1", o.end, "doctor=problems/1");
    has("with the version to install", o.line("tools.node"), "Next: install Node 99.0 or later");
  }

  section("No secret in any output:");
  const all = everything.join("\n");
  for (const [name, value] of Object.entries(SECRETS)) {
    hasnt(`${name} is in none of the ${everything.length} runs' output or JSON`, all, value);
    hasnt(`nor is a part of it (its last 16 characters)`, all, value.slice(-16));
    hasnt(`nor its middle`, all, value.slice(8, 24));
  }
  ok("the secrets were really in play (the stand-in accepted them)", good.status("database.reachable") + "," + good.status("gridpane.token"), "ok,ok");
  has("and their names are printed, so the check is not blind", all, "SUPABASE_SERVICE_ROLE_KEY (");
}

/* ── controls: each broken copy of the doctor must fail at least one check ─ */
// [what is broken, the text to find in the doctor, what to put there, the state that must catch it]
const CONTROLS = [
  ["a missing table is reported as there", "const noTable = snapshot.tables.filter((t) => !tables[t.name]).map((t) => t.name);", "const noTable = [];", "noTable"],
  ["an empty database is reported as complete", "if (noTable.length === snapshot.tables.length) {", "if (false) {", "empty"],
  ["an old database is reported as not migrated", "if (noTable.length === snapshot.tables.length) {", "if (noTable.length) {", "noTable"],
  ["missing columns are not looked for", "(tables[t.name].properties || {})[c.name]).map((c) => `${t.name}.${c.name}`));", "(tables[t.name].properties || {})[c.name]).map((c) => `${t.name}.${c.name}`)).slice(0, 0);", "oneColumn"],
  ["missing functions are not looked for", "const noFunction = fns.filter((f) => !paths[`/rpc/${f.name}`]).map((f) => f.name);", "const noFunction = [];", "oneFunction"],
  ["missing function arguments are not looked for", "if (have.length === 0) return [];", "if (have.length >= 0) return [];", "oneArgument"],
  ["a missing column is ignored", "} else if (noTable.length || noFunction.length || noColumn.length || noArg.length) {", "} else if (noTable.length || noFunction.length || noArg.length) {", "oneColumn"],
  ["a missing function is ignored", "} else if (noTable.length || noFunction.length || noColumn.length || noArg.length) {", "} else if (noTable.length || noColumn.length || noArg.length) {", "oneFunction"],
  ["a missing function argument is ignored", "} else if (noTable.length || noFunction.length || noColumn.length || noArg.length) {", "} else if (noTable.length || noFunction.length || noColumn.length) {", "oneArgument"],
  ["the expected tables are not taken from the snapshot", 'const snapshot = readJson(join(ROOT, "supabase/schema.snapshot.json"));', 'const snapshot = { tables: [{ name: "servers", columns: [] }, { name: "sites", columns: [] }], functions: [] };', "good"],
  ["a function a later file only changes is held against that file too", ".filter((f) => !made.has(f));\n            for (const f of makes) made.add(f);", ";", "good,noStrong"],
  ["a function a later migration makes is not looked for", "const absent = makes.filter((f) => !paths[`/rpc/${f}`]).map((f) => `the function ${f} is not there`);", "const absent = [];", "noStrong"],
  ["a row a later migration adds is not looked for", "else if (n === 0) absent.push(`the table ${table} has no row`);", "else if (n === 0) there.push(`a row in ${table}`);", "noSettingsRow"],
  ["a migration not applied is a step for later, not a failure", 'if (notRun.length) add(3, "database.migrations", "fail",', 'if (notRun.length) add(3, "database.migrations", "not_yet",', "noStrong"],
  ["a column a migration adds is not looked for", "if (props[column]) there.push(", "if (true) there.push(", "noCaching"],
  ["only the newest unapplied migration is named", "if (absent.length) notRun.push({ file, why: absent.join(\", \") });", "if (absent.length) { notRun.length = 0; notRun.push({ file, why: absent.join(\", \") }); }", "baselineOnly"],
  ["a sync that stopped reporting is called running", "if (!Number.isFinite(beat) || Date.now() - beat > SYNC_SILENT_MINUTES * 60000) {", "if (false) {", "syncSilent"],
  ["a sync that left sites unread is called ok", 'return add(6, "sync.last", "not_yet", `The last sync finished ${t(run.finished_at)} with', 'return add(6, "sync.last", "ok", `The last sync finished ${t(run.finished_at)} with', "syncPartial"],
  ["a migration's new table is not looked for", "if (tables[table]) there.push(`the table ${table}`); else absent.push(`the table ${table} is not there`);", "there.push(`the table ${table}`);", "noSyncTable"],
  ["a table that will not be counted is read as holding its row", "if (!Number.isFinite(n)) unread.push(", "if (!Number.isFinite(n)) there.push(", "rowsUnread"],
  ["the baseline is taken for a later migration", "&& !/_baseline\\.sql$/.test(f)).sort(); } catch { /* no folder", "&& true).sort(); } catch { /* no folder", "good"],
  ["a quiet agent is reported as reporting", "else if (now - at > STALE_MINUTES * 60000)", "else if (false)", "quiet"],
  ["an agent that never reported is reported as reporting", "else if (!Number.isFinite(at)) waiting.silent.push(", "else if (false) waiting.silent.push(", "quiet"],
  ["a server with no token is skipped", "if (!row) waiting.none.push(", "if (!row) continue; else if (false) waiting.none.push(", "neverOnly"],
  ["a project with no tables is called unreadable", '|| (spec.json.definitions !== undefined && typeof spec.json.definitions !== "object")', '|| typeof spec.json.definitions !== "object"', "emptyProject"],
  ["servers in the same not-yet state are not put on one line", "else if (rows.length > 1) add(7, id,", "else if (false) add(7, id,", "noAgents,someAgents"],
  ["a shared line names only the count", "${plural(rows.length, \"server\")} (${list(rows.map((r) => r.name))}): ${many}", "${plural(rows.length, \"server\")}: ${many}", "noAgents,someAgents"],
  ["GridPane refusing the token is reported as accepting it", "else if (gp.status === 200) add(5,", "else if (gp.status === 200 || gp.status === 401) add(5,", "gp401"],
  ["too many requests is reported as accepted", "else if (gp.status === 200) add(5,", "else if (gp.status === 200 || gp.status === 429) add(5,", "gp429"],
  ["GridPane is asked twice", "const gp = await ask(`${GRIDPANE_API}/server?per_page=1&page=1`,", "await ask(`${GRIDPANE_API}/server?per_page=1&page=1`, { headers: { Authorization: `Bearer ${gpToken}` } }); const gp = await ask(`${GRIDPANE_API}/server?per_page=1&page=1`,", "good"],
  ["a request that writes", 'ask(`${dbUrl}/rest/v1/sites?select=id`, { method: "HEAD",', 'ask(`${dbUrl}/rest/v1/sites?select=id`, { method: "DELETE",', "good"],
  ["no time limit on a request", "const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);", "const timer = setTimeout(() => {}, TIMEOUT_MS);", "hang"],
  ["a database that did not answer is reported as answering", "if (!spec.answered) {", "if (!spec.answered) { db = \"unset\"; add(3, \"database.reachable\", \"ok\", \"The database answers with the service-role key.\"); } else if (false) {", "hang"],
  ["could not look ends as a pass", 'const state = count("fail") ? "problems" : blind ? "blind" :', 'const state = count("fail") ? "problems" : false ? "blind" :', "hang"],
  ["a refused service-role key is reported as accepted", "} else if (spec.status === 401 || spec.status === 403) {", "} else if (false) {", "refused"],
  ["no user is reported as a user", "else if (count === 0) add(4,", "else if (false) add(4,", "empty"],
  ["an account with no authenticator app is reported as having one", '(u.last_sign_in_at ? used : never).push(u.id);', "", "noApp"],
  ["an authenticator app never confirmed counts", 'x.factor_type === "totp" && x.status === "verified")) return;', 'x.factor_type === "totp")) return;', "halfApp"],
  ["any confirmed factor counts as an authenticator app", 'x.factor_type === "totp" && x.status === "verified")) return;', 'x.status === "verified")) return;', "halfApp"],
  ["a used account with no app is only a step for later", '(u.last_sign_in_at ? used : never).push(u.id);', "never.push(u.id);", "noApp"],
  ["factors that could not be read count as an authenticator app", "{ unread.push(u.id); return; }", "{ return; }", "factorsError,factorsHang"],
  ["an account's address is printed", "const ids = (all) => list(all.map((id) => `${id.slice(0, 8)}…`), 5);", "const ids = (all) => list(all.map((id) => accounts.find((u) => u.id === id).email), 5);", "noApp"],
  ["accounts beyond the first 50 are passed over in silence", "if (beyond > 0) { found.push(", "if (false) { found.push(", "manyAccounts"],
  ["a factor list that is the word null is a read that failed", 'const none = f.answered && f.status === 200 && f.json === null && String(f.text || "").trim() === "null";', "const none = false;", "nullFactors"],
  ["any answer with no list in it counts as no factors", '&& f.json === null && String(f.text || "").trim() === "null";', "&& f.json === null;", "factorsBlank"],
  ["a full page with no count is taken for every account", "const mayBeMore = !counted && listed >= ACCOUNTS_MAX;", "const mayBeMore = false;", "noCountFull,oddCount"],
  ["a count that is not a number is read as one", 'const counted = users.answered && users.headers.get("x-total-count") !== null && /^\\d+$/.test(users.headers.get("x-total-count").trim());', 'const counted = users.answered && users.headers.get("x-total-count") !== null;', "oddCount"],
  ["only the first thing wrong is reported: accounts that never signed in", "if (never.length) { found.push(", "if (never.length && !found.length) { found.push(", "manyWrong"],
  ["only the first thing wrong is reported: factors that could not be read", "if (unread.length) { found.push(", "if (unread.length && !found.length) { found.push(", "manyWrong"],
  ["only the first thing wrong is reported: accounts past the first 50", "if (beyond > 0) { found.push(", "if (beyond > 0 && !found.length) { found.push(", "manyWrong"],
  ["a used account with no app is outranked by one that could not be read", 'const worst = used.length ? "fail" : never.length ? "not_yet" : "could_not_check";', 'const worst = unread.length ? "could_not_check" : used.length ? "fail" : "not_yet";', "manyWrong"],
  ["no account is asked for its factors", "for (let i = 0; i < accounts.length; i += 10) {", "for (let i = 0; i < 0; i += 10) {", "noApp,good"],
  ["sign-ups left on are reported as off", 'else if (open.json.disable_signup) add(4, "signin.signups", "ok",', 'else if (true) add(4, "signin.signups", "ok",', "signupsOn"],
  ["sign-ups left on are a step for later, not a failure", 'else add(4, "signin.signups", "fail", "Sign-ups are on:', 'else add(4, "signin.signups", "not_yet", "Sign-ups are on:', "signupsOn"],
  ["an answer that does not say is read as off", '|| typeof open.json.disable_signup !== "boolean") add(4,', '|| false) add(4,', "signupsUnsaid"],
  ["a failing sign-in service is read as sign-ups off", 'else if (open.status !== 200 || !open.json ||', 'else if (!open.json ||', "signupsError"],
  ["a silent sign-in service is skipped", 'if (!open.answered) add(4, "signin.signups", "could_not_check",', 'if (!open.answered) add(4, "signin.signups", "ok",', "signupsHang"],
  ["a refused public key is not noticed", 'else if (open.status === 401 || open.status === 403) add(4, "signin.signups", "fail",', 'else if (false) add(4, "signin.signups", "fail",', "anonWrong"],
  ["sign-ups are asked about with the service-role key", "{ headers: { apikey: anonKey } });", "{ headers: asService });", "good"],
  ["an empty servers table is reported as synced", "if (nServers === 0) add(6,", "if (false) add(6,", "unsynced"],
  ["a failure exits 0", "const code = { ok: 0, incomplete: 0, problems: 1, blind: 3 }[state];", "const code = { ok: 0, incomplete: 0, problems: 0, blind: 3 }[state];", "noTable"],
  ["the last line always says ok", "console.log(`doctor=${state}`);", "console.log(`doctor=ok`);", "fresh"],
  ["a step not done ends as ok", ': count("not_yet") ? "incomplete" : "ok";', ': "ok";', "fresh"],
  ["secrets are not hidden, and a line carries one", "const scrub = (text) => hidden.reduce((t, v) => t.split(v).join(\"[hidden]\"), String(text));", "const scrub = (text) => String(text);", "variants"],
  ["the end of a setting's value is printed beside its length", "const sized = (names) => names.map((n) => `${n} (${plural(settings[n].length, \"character\")})`).join(\", \");", "const sized = (names) => names.map((n) => `${n} (${plural(settings[n].length, \"character\")}, ends ${settings[n].slice(-16)})`).join(\", \");", "good"],
  ["a config the server scripts refuse is accepted", 'const namesWhy = names.status === 0 ? "" :', 'const namesWhy = true ? "" :', "badPrefix"],
  ["a failing config test is ignored", "if (test.status !== 0) testWhy =", "if (false) testWhy =", "badShape"],
  ["the example config is reported as your own", "else if (exampleHost !== null && oneValue(configText, \"hostname\") === exampleHost) add(2,", "else if (false) add(2,", "fresh"],
  ["a missing required setting is reported as set", "const unset = required.filter((n) => !settings[n]);", "const unset = [];", "unset"],
  ["the closing sentence leaves out what could not be checked", 'const also = cannot ? ` ${plural(cannot, "thing")} cannot be checked from here: read each "could not check" line above.` : "";', 'const also = "";', "accessBoth"],
  ["optional settings are required", "if (m) (inOptional ? optional : required).push(m[1]);", "if (m) required.push(m[1]);", "fresh"],
  ["an address that is not one is accepted", "else if (notAddress.length) add(2,", "else if (false) add(2,", "badUrl"],
  ["the Access settings in .env.local are not flagged", "} else if (envText !== null && accessHere.length === 2) {", "} else if (false) {", "accessBoth"],
  ["both Access settings in .env.local count as a failure", 'else add(2, "settings.access", "could_not_check",', 'else add(2, "settings.access", "fail",', "accessBoth"],
  ["one Access setting alone in .env.local is not flagged", "if (envText !== null && accessHere.length === 1) {", "if (false) {", "accessTagOnly"],
  ["a team address with a path in it is not flagged", "if (!/^[a-z0-9-]+(\\.[a-z0-9-]+)+$/.test(team)) add(2,", "if (false) add(2,", "accessBadTeam"],
  ["a pasted https:// address is called a wrong address", '.replace(/^https:\\/\\//, "").replace(/\\/+$/, "");\n    if (!', '.replace(/\\/+$/, "");\n    if (!', "accessPasted"],
  ["the wrong team address is printed", "CF_ACCESS_TEAM_DOMAIN is not a team address (${plural(settings.CF_ACCESS_TEAM_DOMAIN.length, \"character\")};", "CF_ACCESS_TEAM_DOMAIN is not a team address (${settings.CF_ACCESS_TEAM_DOMAIN};", "accessBadTeam"],
  ["taking the Access settings out is advised without a word about the privacy list", ". Copy what you take out to ~/.config/fleet/privacy-extra first (the same lines), so npm run privacy:denylist still keeps it out of anything you publish\";", "\";", "accessBoth"],
  ["the flag is counted as a blind spot", "take CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD out of ${where}. ${onWorker}`, false);", "take CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD out of ${where}. ${onWorker}`);", "accessBoth"],
  ["missing packages are reported as installed", "const absent = wanted.filter((name) => !existsSync(join(ROOT, \"node_modules\", name, \"package.json\")));", "const absent = [];", "fresh"],
  ["a server list that does not parse is accepted", 'if (loaded.status !== 0) add(8, "machine.servers", "fail",', 'if (false) add(8, "machine.servers", "fail",', "twoGolden"],
  ["no golden mark is reported as one", 'else if (!golden) add(8, "machine.servers", "not_yet",', 'else if (false) add(8, "machine.servers", "not_yet",', "noGolden"],
  ["an empty ssh-agent is reported as holding a key", "return { n: lines.length, has: lines.some((l) => !wantedKey || l.includes(wantedKey)) };", "return { n: lines.length, has: true };", "noKeys"],
  ["any key counts as the named key", "has: lines.some((l) => !wantedKey || l.includes(wantedKey)) };", "has: lines.length > 0 };", "wrongKey"],
  ["a missing server list is a failure", 'add(8, "machine.servers", "not_yet", "No server list on this machine.', 'add(8, "machine.servers", "fail", "No server list on this machine.', "fresh"],
  ["the JSON file is not written", "try { writeFileSync(jsonFile, JSON.stringify(body, null, 2) + \"\\n\"); }", "try { }", "good"],
  ["a user's address is printed", ': plural(count, "user exists", "users exist")}.`);', ': `${count} users, the first is ${users.json.users[0].email}`}.`);', "noCountFew"],
];

async function controls() {
  console.log("Controls: each broken copy of the doctor must fail at least one check.");
  const savedFile = join(T, "as-it-is.json");
  const base = await selfRun(DOCTOR, { FLEET_DOCTOR_TEST_SAVE: savedFile });
  if (!/ 0 failed$/.test(base)) { console.log(`The checks do not pass on the doctor as it is (${base}), so a control would prove nothing. Fix that first.`); process.exit(1); }
  const source = readFileSync(DOCTOR, "utf8");
  let caught = 0, missed = 0;
  const one = async ([name, from, to, state], i) => {
    const text = source.split(from).join(to);
    if (text === source) { missed++; console.log(`  MISSED  ${name} (the control itself did not apply)`); return; }
    const copy = join(T, `broken-${i}.mjs`); writeFileSync(copy, text);
    const out = await selfRun(copy, { FLEET_DOCTOR_TEST_STATES: state, FLEET_DOCTOR_TEST_SAVED: savedFile });
    if (/ 0 failed$/.test(out)) { missed++; console.log(`  MISSED  ${name}`); } else { caught++; console.log(`  caught  ${name}`); }
  };
  // A few at a time. Each one runs its state again with the broken copy, then every check.
  const queue = CONTROLS.map((c, i) => () => one(c, i));
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await queue.shift()(); }));
  console.log(`controls: ${caught} caught, ${missed} missed, of ${caught + missed}`);
  process.exit(missed ? 1 : 0);
}
function selfRun(program, more = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, FLEET_DOCTOR_UNDER_TEST: program, QUIET: "1", ...more }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => { children.delete(child); done(out.trimEnd().split("\n").at(-1) || ""); });
  });
}

if (process.argv.includes("--controls")) await controls();
else {
  await checks();
  console.log(said.join("\n"));
  console.log(`doctor test: ${PASS + FAIL} checks, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
