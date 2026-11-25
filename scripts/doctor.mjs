#!/usr/bin/env node
// Fleet doctor: what is set up, what is missing, what is broken.
//
//   npm run doctor                          # look and say; nothing is changed
//   npm run doctor -- --json doctor.json    # also write the results to a file
//
// Run it after every setup step. It prints one line per check, in this order:
// tools, settings files, database, sign-in, GridPane, sync, server agents, and
// this machine's server list and SSH key. Each line is one of
//
//   ok                 it is there and it works
//   not yet            a step you have not done; the line says which
//   FAIL               it is there and it is wrong; the line says what to do
//   could not check    the doctor was not able to look; the line says why
//
// It never prints a secret: settings are named with their length, never their
// value. It reads and never writes: one GET to GridPane, eight reads of your own
// Supabase project plus one for each account (its sign-in factors; the first 50
// accounts), and nothing on your servers.
//
// Exit 0: nothing is broken (steps may remain: the summary says how many).
// 1: something is broken.  2: wrong usage.  3: it could not look.
// The last line is always `doctor=ok|incomplete|problems|blind`, and the line
// before it counts what was checked.
//
// What it reads, and how to point it elsewhere:
//   .env.local             $FLEET_ENV_FILE, else the one in this checkout, else the main
//                          checkout's when this is a worktree (as scripts/lib-fleet-project.sh does)
//   the database address   $FLEET_SUPABASE_URL, else NEXT_PUBLIC_SUPABASE_URL in .env.local
//   GridPane's API         $FLEET_GRIDPANE_API_URL, else GridPane's own address
//   the server list        $FLEET_SERVERS_FILE, else scripts/servers.local, else ~/.config/fleet/servers
//   FLEET_DOCTOR_TIMEOUT_MS      how long to wait for each answer (default 10000)
//   FLEET_DOCTOR_STALE_MINUTES   how old a server agent's last report may be (default 30;
//                                the agent reports every 10 minutes)
//   FLEET_DOCTOR_ROOT            the checkout to look at (default: the one this file is in)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.FLEET_DOCTOR_ROOT || join(HERE, ".."));
const GRIDPANE_API = (process.env.FLEET_GRIDPANE_API_URL || "https://my.gridpane.com/oauth/api/v1").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.FLEET_DOCTOR_TIMEOUT_MS) > 0 ? Number(process.env.FLEET_DOCTOR_TIMEOUT_MS) : 10000;
const STALE_MINUTES = Number(process.env.FLEET_DOCTOR_STALE_MINUTES) > 0 ? Number(process.env.FLEET_DOCTOR_STALE_MINUTES) : 30;
// Node runs the TypeScript scripts itself (--experimental-strip-types) from this version on.
const NODE_NEEDED = [22, 6];
const ACCOUNTS_MAX = 50; // how many accounts are asked for their sign-in factors

/* ── options ─────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
let jsonFile = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--json" && args[i + 1] && !args[i + 1].startsWith("--")) jsonFile = args[++i];
  else {
    console.error(args[i] === "--json" ? "--json needs a file name." : `Unknown option: ${args[i]}`);
    console.error("Use: npm run doctor   or   npm run doctor -- --json <file>");
    console.log("doctor=blind");
    process.exit(2);
  }
}

/* ── results ─────────────────────────────────────────────────────────────── */
const GROUPS = ["Tools", "Settings files", "Database", "Sign-in", "GridPane", "Sync", "Server agents", "This machine"];
const LABEL = { ok: "ok", not_yet: "not yet", fail: "FAIL", could_not_check: "could not check" };
const results = [];
const measured = {};
// Every value read from .env.local goes here, so no line can carry one out by accident.
const hidden = [];
const scrub = (text) => hidden.reduce((t, v) => t.split(v).join("[hidden]"), String(text));
// `blind` marks a "could not check" that means the doctor was unable to look (no answer, a file
// it cannot read). The one check that can never be made from here is not counted that way.
function add(group, id, status, text, next = "", blind = status === "could_not_check") {
  results.push({ group: GROUPS[group - 1], id, status, text: scrub(text), next: scrub(next), blind: status === "could_not_check" && blind });
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const list = (names, max = 8) => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

function finish() {
  let last = "";
  for (const r of results) {
    if (r.group !== last) { last = r.group; console.log(`${GROUPS.indexOf(r.group) + 1}. ${r.group}`); }
    console.log(`  ${LABEL[r.status].padEnd(16)}${r.text}${r.next ? `  Next: ${r.next}` : ""}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const blind = results.filter((r) => r.blind).length;
  const cannot = count("could_not_check") - blind;
  const state = count("fail") ? "problems" : blind ? "blind" : count("not_yet") ? "incomplete" : "ok";
  const code = { ok: 0, incomplete: 0, problems: 1, blind: 3 }[state];
  const looked = Object.entries(measured).map(([k, v]) => `${v} ${k}`).join(", ");
  // A closing sentence that reads as a clean bill is the only one some people read.
  const also = cannot ? ` ${plural(cannot, "thing")} cannot be checked from here: read each "could not check" line above.` : "";
  console.log("");
  console.log({
    ok: `Everything checked is set up and working.${also}`,
    incomplete: `Nothing is broken. ${plural(count("not_yet"), "step")} not done yet: each "not yet" line above says what to do next.${also}`,
    problems: `${plural(count("fail"), "thing is", "things are")} broken: each FAIL line above says what to do next.`,
    blind: `The doctor could not look at ${plural(blind, "thing")}, so this is not a pass. Each "could not check" line above says why.`,
  }[state]);
  console.log(`doctor: ${plural(results.length, "check")}: ${count("ok")} ok, ${count("not_yet")} not yet, ${count("fail")} failed, ${blind} could not be looked at${cannot ? `, ${cannot} cannot be checked from here` : ""}${looked ? `; looked at ${looked}` : ""}`);
  if (jsonFile) {
    const body = { doctor: state, exit: code, counts: { checks: results.length, ok: count("ok"), not_yet: count("not_yet"), fail: count("fail"), could_not_look: blind, cannot_be_checked_here: cannot }, measured, checks: results.map(({ blind: b, ...r }) => ({ ...r, could_not_look: b })) };
    try { writeFileSync(jsonFile, JSON.stringify(body, null, 2) + "\n"); } catch (e) { console.error(`Could not write ${jsonFile}: ${e.code || e.message}`); }
  }
  console.log(`doctor=${state}`);
  process.exit(code);
}

/* ── asking a service, with a time limit ─────────────────────────────────── */
async function ask(url, { method = "GET", headers = {} } = {}) {
  if (typeof fetch !== "function") return { answered: false, why: "this Node is too old to make the request" };
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, signal: stop.signal });
    const text = method === "HEAD" ? "" : await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON: the status says enough */ }
    return { answered: true, status: res.status, headers: res.headers, json, text };
  } catch (e) {
    if (stop.signal.aborted) return { answered: false, why: `no answer in ${TIMEOUT_MS / 1000} seconds` };
    return { answered: false, why: `the connection failed (${e?.cause?.code || e?.cause?.message || e?.code || e?.name || "unknown reason"})` };
  } finally {
    clearTimeout(timer);
  }
}
// How many rows a table holds, from the count PostgREST puts in its Content-Range header.
const rowsIn = (res) => { const m = String(res.headers.get("content-range") || "").match(/\/(\d+)$/); return m ? Number(m[1]) : NaN; };
// A running sync that has not reported for this long has stopped (lib/sync-runs.ts, SYNC_STALE_AFTER_MS).
const SYNC_SILENT_MINUTES = 6;
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute ago";
  if (m < 120) return `${plural(m, "minute")} ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} hours ago`;
  return `${Math.round(m / 1440)} days ago`;
};

async function main() {
  console.log("Fleet doctor: what is set up, what is missing, what is broken. Nothing is changed and no secret is printed.");
  console.log("");

  const pkg = readJson(join(ROOT, "package.json"));
  if (!pkg) {
    console.log(`There is no readable package.json in ${ROOT}, so this is not a Fleet checkout the doctor can look at.`);
    console.log("Run it from the checkout: npm run doctor");
    console.log("doctor: 0 checks");
    console.log("doctor=blind");
    process.exit(3);
  }

  /* ── 1. tools ──────────────────────────────────────────────────────────── */
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > NODE_NEEDED[0] || (major === NODE_NEEDED[0] && minor >= NODE_NEEDED[1]);
  if (nodeOk) add(1, "tools.node", "ok", `Node ${process.versions.node} can run the TypeScript scripts (${NODE_NEEDED.join(".")} or later is needed).`);
  else add(1, "tools.node", "fail", `Node ${process.versions.node} is too old to run the TypeScript scripts.`, `install Node ${NODE_NEEDED.join(".")} or later, then run this again.`);

  const wanted = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const absent = wanted.filter((name) => !existsSync(join(ROOT, "node_modules", name, "package.json")));
  measured["npm packages"] = wanted.length;
  if (absent.length === 0) add(1, "tools.packages", "ok", `The npm packages are installed (all ${wanted.length} that package.json names).`);
  else add(1, "tools.packages", "not_yet", absent.length === wanted.length ? "The npm packages are not installed." : `${absent.length} of the ${wanted.length} npm packages ${absent.length === 1 ? "is" : "are"} not installed: ${list(absent)}.`, "npm install");

  /* ── 2. settings files ─────────────────────────────────────────────────── */
  const configFile = join(ROOT, "fleet.config.ts");
  const configText = read(configFile);
  const oneValue = (text, key) => { const m = (text || "").match(new RegExp(`^\\s*${key}:\\s*"([^"\\\\]*)",?\\s*(//.*)?$`, "m")); return m ? m[1] : null; };
  if (configText === null) {
    add(2, "settings.config", "not_yet", "fleet.config.ts is not there.", "cp fleet.config.example.ts fleet.config.ts   then put your own name and hostname in it.");
  } else {
    // The same two things that hold the file to its rules everywhere else: the reader the server
    // scripts use (scripts/lib-fleet-names.sh stops on a value it will not accept) and `npm run config:test`.
    const env = { ...process.env };
    delete env.FLEET_CONFIG_FILE; // the self-tests' own switch: the doctor looks at this checkout's file
    const names = spawnSync("bash", ["-c", '. "$1" && printf "%s\\n" "$FLEET_PREFIX"', "names", join(ROOT, "scripts/lib-fleet-names.sh")], { env, encoding: "utf8", timeout: 20000 });
    const namesWhy = names.status === 0 ? "" : ((names.stderr || "").trim().split("\n")[0] || "scripts/lib-fleet-names.sh could not be run").replace(/^ABORT:\s*/, "");
    let testWhy = "", testCount = 0, testRan = false;
    if (nodeOk && !namesWhy) {
      const test = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "scripts/test-fleet-config.ts")], { env, encoding: "utf8", timeout: 60000 });
      const lines = (test.stdout || "").split("\n");
      testRan = true;
      testCount = lines.filter((l) => /^(pass|FAIL) /.test(l)).length;
      if (test.status !== 0) testWhy = (lines.find((l) => l.startsWith("FAIL")) || (test.stderr || "").trim().split("\n").find((l) => /error/i.test(l)) || "npm run config:test did not pass").replace(/^FAIL\s+/, "").slice(0, 240);
    }
    const exampleHost = oneValue(read(join(ROOT, "fleet.config.example.ts")), "hostname");
    if (testRan) measured["config rules"] = testCount;
    if (namesWhy) add(2, "settings.config", "fail", `fleet.config.ts does not pass the rules the server scripts hold it to: ${namesWhy}`, "correct that value in fleet.config.ts (fleet.config.example.ts shows the form), then: npm run config:test");
    else if (testWhy) add(2, "settings.config", "fail", `fleet.config.ts does not pass the config test: ${testWhy}`, "npm run config:test   shows every rule; correct fleet.config.ts until it passes.");
    else if (exampleHost !== null && oneValue(configText, "hostname") === exampleHost) add(2, "settings.config", "not_yet", `fleet.config.ts is still the example (hostname ${exampleHost}).`, "put your own name, hostname and repository address in fleet.config.ts, then: npm run config:test");
    else add(2, "settings.config", "ok", testRan ? `fleet.config.ts passes the config test (${plural(testCount, "rule")}) and the server scripts can read it.` : "The server scripts can read fleet.config.ts (the config test needs a newer Node, see above).");
  }

  // The names come from .env.example: a section whose heading says "(optional" is optional.
  const exampleEnv = read(join(ROOT, ".env.example"));
  const required = [], optional = [];
  let inOptional = false;
  for (const line of (exampleEnv || "").split("\n")) {
    if (/^#\s*──/.test(line)) inOptional = /\(optional/i.test(line);
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) (inOptional ? optional : required).push(m[1]);
  }
  let envFile = process.env.FLEET_ENV_FILE || join(ROOT, ".env.local");
  if (!process.env.FLEET_ENV_FILE && !existsSync(envFile)) {
    const tree = spawnSync("git", ["-C", ROOT, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 10000 });
    const main = tree.status === 0 ? (tree.stdout.split("\n")[0] || "").replace(/^worktree /, "") : "";
    if (main && resolve(main) !== ROOT && existsSync(join(main, ".env.local"))) envFile = join(main, ".env.local");
  }
  const envText = read(envFile);
  const settings = {};
  for (const line of (envText || "").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    settings[m[1]] = value;
    if (value.length >= 6) hidden.push(value);
  }
  hidden.sort((a, b) => b.length - a.length);
  const where = envFile === join(ROOT, ".env.local") ? ".env.local" : envFile;
  const sized = (names) => names.map((n) => `${n} (${plural(settings[n].length, "character")})`).join(", ");
  const unset = required.filter((n) => !settings[n]);
  const notAddress = Object.keys(settings).filter((n) => /_URL$/.test(n) && settings[n] && !/^https?:\/\/[^\s/]+/.test(settings[n]));
  const optionalNote = optional.length ? ` Optional: ${optional.filter((n) => settings[n]).length} of ${optional.length} set${optional.some((n) => !settings[n]) ? ` (not set: ${list(optional.filter((n) => !settings[n]))})` : ""}.` : "";
  measured["setting names"] = required.length + optional.length;
  if (exampleEnv === null || required.length === 0) add(2, "settings.env", "could_not_check", ".env.example cannot be read, so the doctor does not know which settings are needed.", "restore .env.example from the repository.");
  else if (envText === null) add(2, "settings.env", "not_yet", `${where} is not there.`, `cp .env.example .env.local   then fill in ${list(required)}.`);
  else if (unset.length) add(2, "settings.env", "not_yet", `${where} has ${required.length - unset.length} of the ${required.length} required settings; not filled in: ${list(unset)}.`, "fill those in (.env.example says where each one comes from).");
  else if (notAddress.length) add(2, "settings.env", "fail", `In ${where}, ${list(notAddress)} is not an address (${plural(settings[notAddress[0]].length, "character")}; it should start with https://).`, "put the project's address there, as .env.example describes.");
  else add(2, "settings.env", "ok", `${where} has the ${required.length} required settings: ${sized(required)}.${optionalNote}`);

  // The two Cloudflare Access settings belong on the deployed Worker. In this file they make a LOCAL run check every
  // request for a token that nothing in front of a local run puts there (lib/access-gate.ts), so every page is
  // refused. An older .env.example listed them here, when they affected two routes only. Said only when one is set.
  const accessHere = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"].filter((n) => settings[n]);   // values are already trimmed: one that is only spaces reads as not set
  const onWorker = "The deployed Worker keeps its own copies: bash scripts/set-access-check.sh. Copy what you take out to ~/.config/fleet/privacy-extra first (the same lines), so npm run privacy:denylist still keeps it out of anything you publish";
  if (envText !== null && accessHere.length === 1) {
    const other = accessHere[0] === "CF_ACCESS_AUD" ? "CF_ACCESS_TEAM_DOMAIN" : "CF_ACCESS_AUD";
    add(2, "settings.access", "fail", `${where} sets ${accessHere[0]} and not ${other}. With only one of the two set, a local run (npm run dev) refuses every request, the login page included.`, `take ${accessHere[0]} out of ${where}. ${onWorker}`);
  } else if (envText !== null && accessHere.length === 2) {
    // The address as the app reads it (lib/sso/access-jwt.ts): lowercase, https:// in front and a / at the end taken off.
    const team = settings.CF_ACCESS_TEAM_DOMAIN.toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(team)) add(2, "settings.access", "fail", `In ${where}, CF_ACCESS_TEAM_DOMAIN is not a team address (${plural(settings.CF_ACCESS_TEAM_DOMAIN.length, "character")}; it should be the name alone, like yourteam.cloudflareaccess.com). A local run (npm run dev) refuses every request while it is set like this.`, `take CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD out of ${where}. ${onWorker}`);
    else add(2, "settings.access", "could_not_check", `${where} sets both Cloudflare Access settings, so a local run (npm run dev) refuses every request unless this machine's copy of the app sits behind Cloudflare Access. The doctor cannot tell whether it does.`, `if a local run answers "This request did not come through Cloudflare Access", take CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD out of ${where}. ${onWorker}`, false);
  }

  /* ── 3. database ───────────────────────────────────────────────────────── */
  const dbUrl = (process.env.FLEET_SUPABASE_URL || settings.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = settings.SUPABASE_SERVICE_ROLE_KEY || "";
  const asService = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const needsSettings = "it needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see 2).";
  const snapshot = readJson(join(ROOT, "supabase/schema.snapshot.json"));
  // "reachable" is the gate for everything below that reads the database.
  let db = "unset"; // unset | silent | refused | up
  let haveTables = new Set();
  if (dbUrl && serviceKey) {
    const spec = await ask(`${dbUrl}/rest/v1/`, { headers: { ...asService, Accept: "application/openapi+json, application/json" } });
    if (!spec.answered) {
      db = "silent";
      add(3, "database.reachable", "could_not_check", `The database did not answer: ${spec.why}.`, "check the address in NEXT_PUBLIC_SUPABASE_URL and your connection, then run this again.");
    } else if (spec.status === 401 || spec.status === 403) {
      db = "refused";
      add(3, "database.reachable", "fail", `The database refused the service-role key (HTTP ${spec.status}).`, "copy the service_role key again from Supabase > Project Settings > API into SUPABASE_SERVICE_ROLE_KEY.");
    } else if (spec.status !== 200 || !spec.json || typeof spec.json.paths !== "object" || (spec.json.definitions !== undefined && typeof spec.json.definitions !== "object")) {
      db = "silent";
      add(3, "database.reachable", "could_not_check", `The database answered HTTP ${spec.status} without the list of its tables.`, "check that NEXT_PUBLIC_SUPABASE_URL is the project's own address (https://<project id>.supabase.co) and that the project is not paused.");
    } else {
      db = "up";
      add(3, "database.reachable", "ok", "The database answers with the service-role key.");
      if (!snapshot || !Array.isArray(snapshot.tables) || snapshot.tables.length === 0) {
        add(3, "database.schema", "could_not_check", "supabase/schema.snapshot.json cannot be read, so the doctor does not know which tables this code needs.", "restore that file from the repository.");
      } else {
        // What this code needs is whatever the snapshot lists: nothing is spelled out here.
        // A schema with no tables has no "definitions" key at all.
        const tables = spec.json.definitions || {}, paths = spec.json.paths;
        haveTables = new Set(Object.keys(tables));
        const noTable = snapshot.tables.filter((t) => !tables[t.name]).map((t) => t.name);
        // A table or function the answer lists without its columns or arguments is not compared: absent detail is not a missing column.
        const noColumn = snapshot.tables.filter((t) => tables[t.name] && tables[t.name].properties).flatMap((t) => (t.columns || []).filter((c) => !(tables[t.name].properties || {})[c.name]).map((c) => `${t.name}.${c.name}`));
        const fns = snapshot.functions || [];
        const argsOf = (path) => Object.keys((((path.post || {}).parameters || []).find((p) => p.in === "body") || {}).schema?.properties || {});
        const noFunction = fns.filter((f) => !paths[`/rpc/${f.name}`]).map((f) => f.name);
        const noArg = fns.filter((f) => paths[`/rpc/${f.name}`]).flatMap((f) => {
          const have = argsOf(paths[`/rpc/${f.name}`]);
          if (have.length === 0) return [];
          return String(f.args || "").split(",").map((a) => a.trim().split(/\s+/)[0]).filter((a) => a && !have.includes(a)).map((a) => `${f.name}(${a})`);
        });
        const columns = snapshot.tables.reduce((n, t) => n + (t.columns || []).length, 0);
        measured.tables = snapshot.tables.length; measured.columns = columns; measured.functions = fns.length;
        const migrations = "apply the files in supabase/migrations/ to the database, oldest first (bash scripts/apply-sql.sh <file> --dry-run   tries one without changing anything).";
        if (noTable.length === snapshot.tables.length) {
          add(3, "database.schema", "not_yet", `The database has none of the ${snapshot.tables.length} tables this code needs: the migrations have not been run yet.`, migrations);
        } else if (noTable.length || noFunction.length || noColumn.length || noArg.length) {
          const parts = [];
          if (noTable.length) parts.push(`${plural(noTable.length, "table")} (${list(noTable)})`);
          if (noColumn.length) parts.push(`${plural(noColumn.length, "column")} (${list(noColumn)})`);
          if (noFunction.length) parts.push(`${plural(noFunction.length, "function")} (${list(noFunction)})`);
          if (noArg.length) parts.push(`${plural(noArg.length, "function argument")} (${list(noArg)})`);
          add(3, "database.schema", "fail", `The database is older than this code. It has ${snapshot.tables.length - noTable.length} of the ${snapshot.tables.length} tables and is missing ${parts.join("; ")}.`, migrations.replace("apply the files", "apply the newer files"));
        } else {
          add(3, "database.schema", "ok", `The database has everything this code needs: ${plural(snapshot.tables.length, "table")}, ${plural(columns, "column")}, ${plural(fns.length, "function")}.`);

          // The snapshot is what the baseline builds. A migration after it may add no table at all, so
          // the comparison above cannot show whether it was run. What each one leaves behind is read
          // from its own text: a function it creates, a table it puts a row in. (An INSERT that starts a
          // line inside a function's body would be read as such a row; scripts/test-doctor.mjs lists
          // what each migration leaves and fails when a new one is added, so that is seen then.)
          const dir = join(ROOT, "supabase/migrations");
          let later = [];
          try { later = readdirSync(dir).filter((f) => /\.sql$/.test(f) && !/_baseline\.sql$/.test(f)).sort(); } catch { /* no folder: nothing later to look for */ }
          const named = (sql, pattern) => [...new Set([...sql.matchAll(pattern)].map((m) => m[1]))];
          const there = [], notRun = [], unread = [];
          // A function is the evidence of the first file that makes it: a later file that only changes it leaves nothing new to look for.
          const made = new Set(snapshot.functions.map((f) => f.name));
          for (const file of later) {
            const sql = read(join(dir, file)) || "";
            const makes = named(sql, /^\s*create\s+(?:or\s+replace\s+)?function\s+public\."?([a-z_][a-z0-9_]*)"?\s*\(/gim).filter((f) => !made.has(f));
            for (const f of makes) made.add(f);
            const fills = named(sql, /^\s*insert\s+into\s+public\."?([a-z_][a-z0-9_]*)"?/gim);
            const absent = makes.filter((f) => !paths[`/rpc/${f}`]).map((f) => `the function ${f} is not there`);
            // A column it adds is evidence too, read from the same answer as the columns above. A table
            // listed without its columns says nothing either way, so its columns are not counted.
            const addsColumn = /^\s*alter\s+table\s+(?:only\s+)?public\."?([a-z_][a-z0-9_]*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gim;
            // A table it creates is evidence too: the same answer lists every table.
            for (const table of named(sql, /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?public\."?([a-z_][a-z0-9_]*)"?/gim)) {
              if (tables[table]) there.push(`the table ${table}`); else absent.push(`the table ${table} is not there`);
            }
            for (const [table, column] of new Map([...sql.matchAll(addsColumn)].map((m) => [`${m[1]}.${m[2]}`, [m[1], m[2]]])).values()) {
              const props = tables[table] && tables[table].properties;
              if (!props) continue;
              if (props[column]) there.push(`the column ${table}.${column}`); else absent.push(`the column ${table}.${column} is not there`);
            }
            for (const table of fills) {
              const rows = await ask(`${dbUrl}/rest/v1/${table}?select=*`, { method: "HEAD", headers: { ...asService, Prefer: "count=exact" } });
              const n = rows.answered && rows.status >= 200 && rows.status < 300 ? rowsIn(rows) : NaN;
              if (!Number.isFinite(n)) unread.push(`${table} (${rows.answered ? `HTTP ${rows.status}` : rows.why})`);
              else if (n === 0) absent.push(`the table ${table} has no row`);
              else there.push(`a row in ${table}`);
            }
            there.push(...makes.filter((f) => paths[`/rpc/${f}`]).map((f) => `the function ${f}`));
            if (absent.length) notRun.push({ file, why: absent.join(", ") });
          }
          measured["later migrations"] = later.length;
          if (notRun.length) add(3, "database.migrations", "fail", `${notRun.length === 1 ? "A migration has" : `${notRun.length} migrations have`} not been applied to the database: ${notRun.map((m) => `${m.file} (${m.why})`).join("; ")}.`, `bash scripts/apply-sql.sh supabase/migrations/${notRun[0].file} --dry-run   then the same without --dry-run${notRun.length > 1 ? ", and the same for each of the others, oldest first" : ""}.`);
          else if (unread.length) add(3, "database.migrations", "could_not_check", `The database did not say whether the later migrations were applied: it would not count the rows of ${unread.join(", ")}.`, "run this again in a moment.");
          else if (later.length) add(3, "database.migrations", "ok", `What the ${plural(later.length, "migration")} after the baseline ${later.length === 1 ? "adds" : "add"} is there: ${there.join(", ") || "nothing the doctor can look for"}.`);
        }
      }
      // PostgREST and the keys in .env.local do not report whether a table's access rules are switched on.
      add(3, "database.rls", "could_not_check", "Row level security: the keys in .env.local cannot read whether it is on for every table.", "npm run schema:dump   then   npm run schema:drift   (a person runs the first: it uses your Supabase login).", false);
    }
  } else {
    add(3, "database.reachable", "not_yet", `The database was not asked: ${needsSettings}`);
  }
  // One sentence for every later check that needs a database it could not read.
  const dbBlocked = () => db === "unset" ? ["not_yet", `Not looked at: ${needsSettings}`, "", false] : db === "refused" ? ["not_yet", "Not looked at: the database refused the service-role key (see 3).", "", false] : ["could_not_check", "Not looked at: the database did not answer (see 3).", "", true];
  const tableMissing = (name) => db === "up" && haveTables.size > 0 && !haveTables.has(name);
  const tablesAbsent = db === "up" && snapshot && Array.isArray(snapshot.tables) && snapshot.tables.every((t) => !haveTables.has(t.name));

  /* ── 4. sign-in ────────────────────────────────────────────────────────── */
  if (db !== "up") {
    const [s, t, n, b] = dbBlocked(); add(4, "signin.users", s, t, n, b);
  } else {
    const users = await ask(`${dbUrl}/auth/v1/admin/users?page=1&per_page=${ACCOUNTS_MAX}`, { headers: asService });
    const counted = users.answered && users.headers.get("x-total-count") !== null && /^\d+$/.test(users.headers.get("x-total-count").trim());
    const total = counted ? Number(users.headers.get("x-total-count")) : NaN;
    const listed = users.answered && users.json && Array.isArray(users.json.users) ? users.json.users.length : NaN;
    const count = counted ? total : listed;
    // With no count from the service, a full page may not be the whole list: more accounts may follow it.
    const mayBeMore = !counted && listed >= ACCOUNTS_MAX;
    if (!users.answered) add(4, "signin.users", "could_not_check", `The sign-in service did not answer: ${users.why}.`, "run this again in a moment.");
    else if (users.status !== 200 || !Number.isFinite(count)) add(4, "signin.users", "could_not_check", `The sign-in service answered HTTP ${users.status} without a list of users.`, "check SUPABASE_SERVICE_ROLE_KEY, then run this again.");
    else if (count === 0) add(4, "signin.users", "not_yet", "No user exists yet, so nobody can sign in.", "npm run user:create -- <your email>   (it asks for a password and does not show it), then sign in and set up the authenticator app the login page asks for.");
    else add(4, "signin.users", "ok", `${counted ? plural(count, "user exists", "users exist") : mayBeMore ? `At least ${plural(count, "user exists", "users exist")} (the sign-in service did not say how many there are)` : plural(count, "user exists", "users exist")}.`);
    if (Number.isFinite(count)) measured.users = count;

    // An account with no confirmed authenticator app can be entered with its password alone: the
    // sign-in service lets such a session add an authenticator app or a passkey of its own
    // (lib/auth-assurance.ts, SECURITY.md). The list of users does not carry their factors, so
    // each account is asked for its own. Accounts are named by the start of their id, never by address.
    if (users.answered && users.status === 200 && Number.isFinite(count) && count > 0) {
      const accounts = Array.isArray(users.json?.users) ? users.json.users.filter((u) => u && typeof u.id === "string") : [];
      const used = [], never = [], unread = [];
      // Asked ten at a time: fifty one after another is fifty waits.
      for (let i = 0; i < accounts.length; i += 10) {
        const batch = accounts.slice(i, i + 10);
        const answers = await Promise.all(batch.map((u) => ask(`${dbUrl}/auth/v1/admin/users/${encodeURIComponent(u.id)}/factors`, { headers: asService })));
        batch.forEach((u, k) => {
          const f = answers[k];
          // An account with no factor at all may be answered with `null` instead of an empty list: both mean none.
          const none = f.answered && f.status === 200 && f.json === null && String(f.text || "").trim() === "null";
          if (!f.answered || f.status !== 200 || !(Array.isArray(f.json) || none)) { unread.push(u.id); return; }
          if (!none && f.json.some((x) => x && x.factor_type === "totp" && x.status === "verified")) return;
          (u.last_sign_in_at ? used : never).push(u.id);
        });
      }
      const ids = (all) => list(all.map((id) => `${id.slice(0, 8)}…`), 5);
      const beyond = mayBeMore ? Infinity : count - accounts.length;
      const setUp = "sign in as that account and set up the authenticator app the login page asks for, or remove the account in Supabase under Authentication > Users (SECURITY.md says why).";
      // Everything found is said in the one line, worst first: fixing one must not be how the next is discovered.
      const found = [], next = [];
      if (used.length) { found.push(`${plural(used.length, "account that has signed in before has", "accounts that have signed in before have")} no authenticator app (id ${ids(used)}), so its password alone is enough to enter: whoever signs in can add an authenticator app or a passkey of their own.`); next.push(setUp); }
      if (never.length) { found.push(`${plural(never.length, "account has", "accounts have")} never signed in and ${never.length === 1 ? "has" : "have"} no authenticator app yet (id ${ids(never)}). Until it is set up, the password alone is enough to enter.`); if (!used.length) next.push("sign in as that account now and set up the authenticator app the login page asks for, or remove it in Supabase under Authentication > Users."); }
      if (unread.length) { found.push(`The sign-in service did not list the sign-in factors of ${plural(unread.length, "account")} (id ${ids(unread)}), so whether each has an authenticator app is not known.`); next.push("run this again in a moment."); }
      if (beyond > 0) { found.push(mayBeMore ? `Only the first ${plural(accounts.length, "account was", "accounts were")} looked at: the sign-in service did not say how many there are, and there may be more.` : `Only the first ${plural(accounts.length, "account was", "accounts were")} looked at; the other ${beyond} were not.`); next.push("look at the rest in Supabase under Authentication > Users."); }
      const clean = accounts.length - used.length - never.length - unread.length;
      if (found.length && clean > 0) found.push(`The other ${plural(clean, "account that was looked at has", "accounts that were looked at each have")} an authenticator app.`);
      const worst = used.length ? "fail" : never.length ? "not_yet" : "could_not_check";
      if (found.length) add(4, "signin.factors", worst, found.join(" "), next.join(" Then: "));
      else add(4, "signin.factors", "ok", `Every account has an authenticator app (${plural(accounts.length, "account")}), so none can be entered with a password alone.`);
      measured["accounts asked for their factors"] = accounts.length - unread.length;
    }

    // The sign-in service's public settings say whether a visitor can make an account. It is asked
    // with the public key, as a browser would: with sign-ups on, that key is all a stranger needs.
    const anonKey = settings.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    const signupsOff = 'in your Supabase project, under Authentication, turn off "Allow new users to sign up" (SECURITY.md says why), then run this again.';
    if (!anonKey) add(4, "signin.signups", "not_yet", "Sign-ups were not looked at: it needs NEXT_PUBLIC_SUPABASE_ANON_KEY (see 2).");
    else {
      const open = await ask(`${dbUrl}/auth/v1/settings`, { headers: { apikey: anonKey } });
      if (!open.answered) add(4, "signin.signups", "could_not_check", `The sign-in service did not say whether sign-ups are on: ${open.why}.`, "run this again in a moment.");
      else if (open.status === 401 || open.status === 403) add(4, "signin.signups", "fail", `The sign-in service refused the public (anon) key (HTTP ${open.status}), so the app cannot sign anyone in with it.`, "copy the anon (public) key again from Supabase > Project Settings > API into NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      else if (open.status !== 200 || !open.json || typeof open.json.disable_signup !== "boolean") add(4, "signin.signups", "could_not_check", `The sign-in service answered HTTP ${open.status} without saying whether sign-ups are on.`, 'look in your Supabase project, under Authentication: "Allow new users to sign up" must be off.');
      else if (open.json.disable_signup) add(4, "signin.signups", "ok", "Sign-ups are off: an account can only be made by you.");
      else add(4, "signin.signups", "fail", "Sign-ups are on: anyone who has the public key can make an account, add an authenticator of their own and read the database.", signupsOff);
    }
  }

  /* ── 5. GridPane ───────────────────────────────────────────────────────── */
  const gpToken = settings.GRIDPANE_API_TOKEN || "";
  if (!gpToken) {
    add(5, "gridpane.token", "not_yet", "GridPane was not asked: it needs GRIDPANE_API_TOKEN (see 2).");
  } else {
    // ONE request. GridPane allows 12 a minute on a route, and asking again after a refusal makes the wait longer.
    const gp = await ask(`${GRIDPANE_API}/server?per_page=1&page=1`, { headers: { Authorization: `Bearer ${gpToken}`, Accept: "application/json" } });
    if (!gp.answered) add(5, "gridpane.token", "could_not_check", `GridPane did not answer: ${gp.why}.`, "run this again in a minute.");
    else if (gp.status === 200) add(5, "gridpane.token", "ok", "GridPane accepts the API token.");
    else if (gp.status === 401 || gp.status === 403) add(5, "gridpane.token", "fail", `GridPane refused the API token (HTTP ${gp.status}).`, "make a new token in GridPane (Settings > GridPane API) and put it in GRIDPANE_API_TOKEN.");
    else if (gp.status === 429) add(5, "gridpane.token", "could_not_check", "GridPane says too many requests (HTTP 429), so the token was not checked.", "wait a full minute before running this again: asking sooner makes the wait longer.");
    else add(5, "gridpane.token", "could_not_check", `GridPane answered HTTP ${gp.status}, which says nothing about the token.`, "run this again in a minute.");
  }

  /* ── 6. sync ───────────────────────────────────────────────────────────── */
  let servers = null;
  if (db !== "up") {
    const [s, t, n, b] = dbBlocked(); add(6, "sync.rows", s, t, n, b);
  } else if (tablesAbsent || tableMissing("servers") || tableMissing("sites")) {
    add(6, "sync.rows", "not_yet", "Not looked at: the servers and sites tables are not both there (see 3).");
  } else {
    const [srv, sites] = await Promise.all([
      ask(`${dbUrl}/rest/v1/servers?select=id,label&order=label`, { headers: { ...asService, Prefer: "count=exact" } }),
      ask(`${dbUrl}/rest/v1/sites?select=id`, { method: "HEAD", headers: { ...asService, Prefer: "count=exact" } }),
    ]);
    const nServers = srv.answered ? rowsIn(srv) : NaN, nSites = sites.answered ? rowsIn(sites) : NaN;
    if (!srv.answered || !sites.answered) add(6, "sync.rows", "could_not_check", `The database did not answer: ${(srv.answered ? sites : srv).why}.`, "run this again in a moment.");
    else if (!Number.isFinite(nServers) || !Number.isFinite(nSites) || !Array.isArray(srv.json)) add(6, "sync.rows", "could_not_check", `The database did not count the rows (HTTP ${srv.status} for servers, ${sites.status} for sites).`, "run this again in a moment.");
    else {
      servers = srv.json;
      measured.servers = nServers; measured.sites = nSites;
      // The counts are the evidence of what was synced; the sync record (sync_runs, a later migration) says when.
      const recorded = haveTables.has("sync_runs");
      if (nServers === 0) add(6, "sync.rows", "not_yet", "The servers table is empty: nothing has been synced from GridPane yet.", "npm run sync");
      else if (nSites === 0) add(6, "sync.rows", "not_yet", `The database holds ${plural(nServers, "server")} and no sites.`, "npm run sync   (if GridPane lists no sites yet, this stays as it is).");
      else add(6, "sync.rows", "ok", `The database holds ${plural(nServers, "server")} and ${plural(nSites, "site")}.${recorded ? "" : " (It does not record when a sync last ran.)"}`);
      if (recorded) await lastSync();
    }
  }

  // The newest sync record: running, or how the last one ended. One request.
  async function lastSync() {
    const r = await ask(`${dbUrl}/rest/v1/sync_runs?select=status,source,phase,started_at,heartbeat_at,finished_at,sites_total,sites_done,sites_read,errors,message&order=started_at.desc&limit=1`, { headers: asService });
    if (!r.answered) return add(6, "sync.last", "could_not_check", `The sync record was not read: ${r.why}.`, "run this again in a moment.");
    if (r.status !== 200 || !Array.isArray(r.json)) return add(6, "sync.last", "could_not_check", `The sync record was not read (HTTP ${r.status}).`, "run this again in a moment.");
    const run = r.json[0];
    const again = "npm run sync   (or Sync in the app). GridPane allows about 12 requests a minute, and this doctor spent one: wait a minute first.";
    if (!run) return add(6, "sync.last", "not_yet", "No sync is recorded yet: the record started with the sync_runs migration.", again);
    const t = (iso) => { const v = Date.parse(iso || ""); return Number.isFinite(v) ? ago(Math.max(0, Date.now() - v)) : "at an unknown time"; };
    const from = run.source === "cli" ? "from the command line" : "in the app";
    const total = Number.isFinite(run.sites_total) ? run.sites_total : null;
    if (run.status === "running") {
      const beat = Date.parse(run.heartbeat_at || "");
      if (!Number.isFinite(beat) || Date.now() - beat > SYNC_SILENT_MINUTES * 60000) {
        return add(6, "sync.last", "not_yet", `The last sync, started ${from} ${t(run.started_at)}, stopped reporting ${t(run.heartbeat_at)}${run.source === "app" ? " (the tab that ran it was probably closed)" : ""}. What it saved stays saved.`, again);
      }
      return add(6, "sync.last", "ok", `A sync is running now: started ${from} ${t(run.started_at)}${total ? `, ${run.sites_done} of ${total} sites so far` : ""}.`, "npm run sync:status -- --watch   follows it to the end.");
    }
    if (run.status === "complete") return add(6, "sync.last", "ok", `The last sync finished ${t(run.finished_at)} and read ${total === null ? "every site" : `all ${plural(total, "site")}`}.`);
    if (run.status === "partial") {
      const unread = total === null ? null : Math.max(0, total - (run.sites_read || 0));
      return add(6, "sync.last", "not_yet", `The last sync finished ${t(run.finished_at)} with ${unread === null ? "some sites" : plural(unread, "site")} not read (GridPane refused them or did not answer).`, again);
    }
    return add(6, "sync.last", "not_yet", `The last sync ${run.status === "failed" ? "failed" : "stopped"} ${t(run.finished_at || run.heartbeat_at)}: ${(run.message || "no reason was recorded").slice(0, 200)}`, again);
  }

  /* ── 7. server agents ──────────────────────────────────────────────────── */
  // Every report an agent makes passes verify_agent(), which stamps server_agent_secrets.last_used_at
  // with the database's own clock: one row per server, read with one request.
  if (db !== "up") {
    const [s, t, n, b] = dbBlocked(); add(7, "agents", s, t, n, b);
  } else if (servers === null) {
    add(7, "agents", results.at(-1).status === "could_not_check" ? "could_not_check" : "not_yet", "Not looked at: the list of servers could not be read (see 6).");
  } else if (servers.length === 0) {
    add(7, "agents", "not_yet", "No servers yet, so there are no agents to look at (see 6).");
  } else if (tableMissing("server_agent_secrets")) {
    add(7, "agents", "not_yet", "Not looked at: the server_agent_secrets table is not there (see 3).");
  } else {
    const seen = await ask(`${dbUrl}/rest/v1/server_agent_secrets?select=server_id,last_used_at`, { headers: asService });
    if (!seen.answered) add(7, "agents", "could_not_check", `The database did not answer: ${seen.why}.`, "run this again in a moment.");
    else if (seen.status !== 200 || !Array.isArray(seen.json)) add(7, "agents", "could_not_check", `The database answered HTTP ${seen.status} for the agents' last reports.`, "run this again in a moment.");
    else {
      // The database's clock, not this machine's: the times being compared were written by it.
      const stamp = Date.parse(seen.headers.get("date") || "");
      const now = Number.isFinite(stamp) && Math.abs(stamp - Date.now()) < 24 * 3600 * 1000 ? Math.max(stamp, Date.now() - 5000) : Date.now();
      const byServer = new Map(seen.json.map((r) => [String(r.server_id), r]));
      const install = "bash scripts/fix-telemetry-crontabs.sh   shows each server's agent and cron line; bash scripts/provision-agent-tokens.sh   shows its token.";
      // Servers in the same not-yet state share one line: with 18 servers and no agents, 18 near-identical lines hide the page.
      // A state with one server keeps its own line, named by server id like the ok and FAIL lines.
      const waiting = { none: [], silent: [] };
      for (const s of servers) {
        const row = byServer.get(String(s.id));
        const name = s.label || `server ${s.id}`;
        const at = row && row.last_used_at ? Date.parse(row.last_used_at) : NaN;
        if (!row) waiting.none.push({ s, name });
        else if (!Number.isFinite(at)) waiting.silent.push({ s, name });
        else if (now - at > STALE_MINUTES * 60000) add(7, `agents.${s.id}`, "fail", `${name}: the agent last reported ${ago(now - at)}, more than ${STALE_MINUTES} minutes.`, `on that server, run /root/telemetry-agent.sh by hand and read what it says. ${install}`);
        else add(7, `agents.${s.id}`, "ok", `${name}: the agent reported ${ago(now - at)}.`);
      }
      const waitingLine = (rows, id, one, many) => {
        if (rows.length === 1) add(7, `agents.${rows[0].s.id}`, "not_yet", `${rows[0].name}: ${one}`, install);
        else if (rows.length > 1) add(7, id, "not_yet", `${plural(rows.length, "server")} (${list(rows.map((r) => r.name))}): ${many}`, install);
      };
      waitingLine(waiting.none, "agents.no_token", "no agent token is registered for it, so its agent has never reported.", "no agent token is registered for them, so their agents have never reported.");
      waitingLine(waiting.silent, "agents.never_reported", "a token is registered, and the agent has never reported with it.", "a token is registered for each, and the agents have never reported with them.");
      measured["agents asked about"] = servers.length;
    }
  }

  /* ── 8. this machine ───────────────────────────────────────────────────── */
  // Only for whoever runs the server scripts from here. The list's own reader decides whether it parses.
  const lib = join(ROOT, "scripts/lib-fleet-servers.sh");
  const sh = (program) => spawnSync("bash", ["-c", program, "servers", lib], { encoding: "utf8", timeout: 20000 });
  const listFile = (sh('. "$1" && fleet_servers_file').stdout || "").trim();
  if (!listFile || !existsSync(listFile)) {
    add(8, "machine.servers", "not_yet", "No server list on this machine. It is needed only to run the server scripts from here.", "npm run servers:export   (after a sync), then add |golden to one line.");
    add(8, "machine.ssh", "not_yet", "The SSH key was not looked at: the server scripts are not set up here yet.");
  } else {
    const loaded = sh('. "$1" && fleet_servers_load && printf "%s\\n" "$(printf "%s\\n" "$SERVERS" | grep -c .)" "$FLEET_GOLDEN_LABEL"');
    const [n = "", golden = ""] = (loaded.stdout || "").split("\n");
    if (loaded.status !== 0) add(8, "machine.servers", "fail", `The server list does not parse: ${((loaded.stderr || "").trim().split("\n")[0] || "its reader stopped").replace(/^ABORT:\s*/, "")}`, "each line is <ip>|<GridPane server id>|<label>, with |golden on exactly one (scripts/servers.example).");
    else if (!golden) add(8, "machine.servers", "not_yet", `The server list parses (${plural(Number(n), "server")}) and no line is marked golden.`, `add |golden to the line of the one server the install scripts copy from, in ${listFile}.`);
    else add(8, "machine.servers", "ok", `The server list parses: ${plural(Number(n), "server")}, one marked golden (${golden}).`);
    if (loaded.status === 0) measured["server list lines"] = Number(n);

    // The same test the server scripts make: the system agent first, then the 1Password agent's socket.
    const fpFile = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fleet/ssh-key-fingerprint");
    const wantedKey = (process.env.FLEET_SSH_KEY_FP || read(fpFile) || "").trim();
    const namedIn = process.env.FLEET_SSH_KEY_FP ? "$FLEET_SSH_KEY_FP" : fpFile;
    const keysIn = (sock) => {
      const r = spawnSync("ssh-add", ["-l"], { encoding: "utf8", timeout: 8000, env: sock ? { ...process.env, SSH_AUTH_SOCK: sock } : process.env });
      if (r.error) return { missing: r.error.code === "ENOENT", n: 0, has: false };
      const lines = r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
      return { n: lines.length, has: lines.some((l) => !wantedKey || l.includes(wantedKey)) };
    };
    const own = keysIn("");
    const opSock = join(homedir(), "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock");
    const op = !own.has && existsSync(opSock) ? keysIn(opSock) : { n: 0, has: false };
    const which = wantedKey ? `, the one named in ${namedIn} among them` : "";
    if (own.missing) add(8, "machine.ssh", "could_not_check", "ssh-add is not installed here, so the doctor cannot see whether an agent holds your key.", "install OpenSSH, then run this again.");
    else if (own.has) add(8, "machine.ssh", "ok", `The ssh-agent holds ${plural(own.n, "key")}${which}.`);
    else if (op.has) add(8, "machine.ssh", "ok", `The 1Password SSH agent holds ${plural(op.n, "key")}${which}; the server scripts use it when the system agent has none.`);
    else if (wantedKey && own.n + op.n > 0) add(8, "machine.ssh", "fail", `An ssh-agent holds ${plural(own.n + op.n, "key")}, and none is the one named in ${namedIn}.`, "ssh-add that key, or correct the fingerprint there (ssh-add -l prints the ones the agent holds).");
    else add(8, "machine.ssh", "not_yet", "No ssh-agent holds a key, so the server scripts cannot sign in to a server.", "ssh-add <your key file>   (or switch on your password manager's SSH agent).");
  }

  finish();
}

main().catch((e) => {
  // Not a crash and never a pass: say so in the same form as every other ending.
  console.log(`The doctor stopped before it finished: ${scrub(e?.message || e)}`);
  console.log(`doctor: ${results.length} checks before it stopped`);
  console.log("doctor=blind");
  process.exit(3);
});
