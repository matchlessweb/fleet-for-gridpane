// Proves scripts/strip-build-secrets.mjs on made-up bundles, with a stand-in for wrangler.
// Touches no real build, Worker or key: every value is random and made at run time.
//
//   node scripts/test-strip-build-secrets.mjs              # the checks
//   node scripts/test-strip-build-secrets.mjs --controls   # broken copies of the script: each must fail a check
//
// STRIP_SCRIPT points the checks at another copy.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const real = resolve(here, "strip-build-secrets.mjs");
const work = mkdtempSync(join(tmpdir(), "strip-test-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

const rnd = (n = 24) => randomBytes(n).toString("hex");
const SERVICE = `sb_secret_${rnd()}`, GP = rnd(60), PUB_URL = "https://db.example.com", PUB_KEY = `public-${rnd(8)}`;
const SECRETS = [SERVICE, GP];

// The stand-in for wrangler: prints the names in WRANGLER_NAMES as wrangler does, or fails when WRANGLER_FAIL is set.
const wrangler = join(work, "wrangler-standin.mjs");
writeFileSync(wrangler, `const a = process.argv.slice(2);
if (a[0] !== "secret" || a[1] !== "list") { console.error("unexpected: " + a.join(" ")); process.exit(9); }
if (process.env.WRANGLER_FAIL) { console.error("not signed in"); process.exit(1); }
if (process.env.WRANGLER_BANNER) console.log(" a banner line wrangler sometimes prints");
console.log(JSON.stringify((process.env.WRANGLER_NAMES || "").split(",").filter(Boolean).map((name) => ({ name, type: "secret_text" })), null, 2));
`);

let n = 0;
function bundle({ env = {}, extra = {}, raw = null, config = null, noEnvFile = false } = {}) {
  const root = join(work, `case-${++n}`);
  mkdirSync(join(root, ".open-next/cloudflare"), { recursive: true });
  mkdirSync(join(root, ".open-next/assets/_next"), { recursive: true });
  writeFileSync(join(root, ".open-next/worker.js"), 'import "./cloudflare/init.js";\nexport default {};\n');
  writeFileSync(join(root, ".open-next/assets/_next/app.js"), `console.log(${JSON.stringify(PUB_URL)});\n`);
  if (!noEnvFile) writeFileSync(join(root, ".open-next/cloudflare/next-env.mjs"), raw ?? ["production", "development", "test"].map((m) => `export const ${m} = ${JSON.stringify(m === "test" ? {} : env)};`).join("\n") + "\n");
  for (const [p, text] of Object.entries(extra)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  if (config) writeFileSync(join(root, "wrangler.jsonc"), config);
  return root;
}
function run(script, root, { args = [], names = "", fail = false, banner = false } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, FLEET_DEPLOY_ROOT: root, FLEET_WRANGLER: `${process.execPath} ${wrangler}`, WRANGLER_NAMES: names, WRANGLER_FAIL: fail ? "1" : "", WRANGLER_BANNER: banner ? "1" : "" } });
  const out = (r.stdout || "") + (r.stderr || "");
  return { code: r.status, out, last: out.trim().split("\n").pop() };
}
const envOf = async (root) => { const m = await import(pathToFileURL(join(root, ".open-next/cloudflare/next-env.mjs")).href + `?${Math.random()}`); return { production: m.production, development: m.development, test: m.test }; };
const fileHas = (root, p, text) => readFileSync(join(root, p), "utf8").includes(text);
const FULL = { NEXT_PUBLIC_SUPABASE_URL: PUB_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: PUB_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE, GRIDPANE_API_TOKEN: GP };
const BOTH = "GRIDPANE_API_TOKEN,SUPABASE_SERVICE_ROLE_KEY";

async function suite(script) {
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  const silent = (r) => SECRETS.every((s) => !r.out.includes(s));

  { // 1. the ordinary deploy
    const root = bundle({ env: FULL }); const r = run(script, root, { names: BOTH }); const e = await envOf(root);
    check("the two secrets are taken out of every mode", !("SUPABASE_SERVICE_ROLE_KEY" in e.production) && !("GRIDPANE_API_TOKEN" in e.production) && !("SUPABASE_SERVICE_ROLE_KEY" in e.development), JSON.stringify(Object.keys(e.production)));
    check("no secret value is left anywhere in the settings file", SECRETS.every((s) => !fileHas(root, ".open-next/cloudflare/next-env.mjs", s)));
    check("the public settings stay, with their values", e.production.NEXT_PUBLIC_SUPABASE_URL === PUB_URL && e.development.NEXT_PUBLIC_SUPABASE_ANON_KEY === PUB_KEY);
    check("the settings file still loads as a module with its three modes", e.production && e.development && e.test && Object.keys(e.test).length === 0);
    check("a clean bundle ends build_secrets=clean, exit 0", r.code === 0 && r.last === "build_secrets=clean", `${r.code} ${r.last}`);
    check("it names what it took out and never prints a value", r.out.includes("GRIDPANE_API_TOKEN, SUPABASE_SERVICE_ROLE_KEY") && silent(r));
    check("it says how many files it looked through", /Looked through 3 files for 2 values: none found/.test(r.out), r.out.split("\n").slice(-3).join(" | "));
    const again = run(script, root, { names: BOTH });
    check("a second run finds nothing to take out and is still clean", again.code === 0 && again.out.includes("held no setting besides the public ones"), again.last);
  }
  { // 2. a value somewhere else in the bundle
    const root = bundle({ env: FULL, extra: { ".open-next/server-functions/default/handler.mjs": `const k = "${SERVICE}";\n` } }); const r = run(script, root, { names: BOTH });
    check("a secret value in another bundle file stops the deploy: found, exit 1", r.code === 1 && r.last === "build_secrets=found", `${r.code} ${r.last}`);
    check("it names the file and the setting, never the value", r.out.includes("server-functions/default/handler.mjs: the value of SUPABASE_SERVICE_ROLE_KEY") && silent(r));
  }
  { // 3. the Worker does not hold one
    const root = bundle({ env: FULL }); const r = run(script, root, { names: "GRIDPANE_API_TOKEN" });
    check("a secret the Worker does not hold stops the deploy: missing, exit 1", r.code === 1 && r.last === "build_secrets=missing", `${r.code} ${r.last}`);
    check("it gives the command for the missing one only", r.out.includes("Next: npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY") && !r.out.includes("Next: npx wrangler secret put GRIDPANE_API_TOKEN") && silent(r));
  }
  { // 4. held as a var in wrangler.jsonc, comments and an address in it
    const config = `{\n  // a comment\n  "name": "example", /* another */\n  "vars": { "CF_ACCESS_TEAM_DOMAIN": "https://team.example.com", },\n}\n`;
    const root = bundle({ env: { ...FULL, CF_ACCESS_TEAM_DOMAIN: "https://team.example.com" }, config }); const r = run(script, root, { names: BOTH, banner: true });
    check("a name set under vars in wrangler.jsonc counts as held (comments, a trailing comma, a banner before the list)", r.code === 0 && r.last === "build_secrets=clean" && r.out.includes("3 checked"), `${r.code} ${r.last}`);
    const without = bundle({ env: { ...FULL, CF_ACCESS_TEAM_DOMAIN: "https://team.example.com" } }); const r2 = run(script, without, { names: BOTH });
    check("the same name with no var and no secret is missing", r2.code === 1 && r2.out.includes("Next: npx wrangler secret put CF_ACCESS_TEAM_DOMAIN"), `${r2.code} ${r2.last}`);
  }
  { // 5. wrangler cannot answer
    const root = bundle({ env: FULL }); const r = run(script, root, { fail: true });
    check("wrangler not answering is blind, exit 3, never a pass", r.code === 3 && r.last === "build_secrets=blind", `${r.code} ${r.last}`);
    check("the settings are stripped even then", SECRETS.every((s) => !fileHas(root, ".open-next/cloudflare/next-env.mjs", s)));
    const root2 = bundle({ env: FULL }); const r2 = run(script, root2, { fail: true, args: ["--no-worker-check"] });
    check("--no-worker-check goes on without asking, and says it did not ask", r2.code === 0 && r2.last === "build_secrets=clean" && r2.out.includes("Not asked"), `${r2.code} ${r2.last}`);
  }
  { // 6. nothing to read, or a form it does not know
    const r = run(script, bundle({ noEnvFile: true }), { names: BOTH });
    check("no settings file is blind, exit 3", r.code === 3 && r.last === "build_secrets=blind", `${r.code} ${r.last}`);
    const raw = `const production = ${JSON.stringify(FULL)};\nexport { production };\n`;
    const root = bundle({ raw }); const r2 = run(script, root, { names: BOTH });
    check("a settings file in another form is blind, exit 3, and left as it was", r2.code === 3 && r2.last === "build_secrets=blind" && readFileSync(join(root, ".open-next/cloudflare/next-env.mjs"), "utf8") === raw && silent(r2), `${r2.code} ${r2.last}`);
  }
  { // 6b. one line it knows and one it does not: the whole file is left alone
    const raw = `export const production = ${JSON.stringify({ NEXT_PUBLIC_SUPABASE_URL: PUB_URL })};\nexport const extra = new Map([["GRIDPANE_API_TOKEN", "${GP}"]]);\n`;
    const root = bundle({ raw }); const r = run(script, root, { names: BOTH });
    check("one line in a form it does not know makes the whole file blind, exit 3, and left as it was", r.code === 3 && r.last === "build_secrets=blind" && readFileSync(join(root, ".open-next/cloudflare/next-env.mjs"), "utf8") === raw && silent(r), `${r.code} ${r.last}`);
  }
  { // 7. only public settings; a short value; a wrong argument
    const r = run(script, bundle({ env: { NEXT_PUBLIC_SUPABASE_URL: PUB_URL } }), { fail: true });
    check("a bundle with only public settings is clean without asking wrangler", r.code === 0 && r.last === "build_secrets=clean", `${r.code} ${r.last}`);
    const root = bundle({ env: { ...FULL, FEATURE_FLAG: "true" }, extra: { ".open-next/x.js": "const on = true;\n" } }); const r2 = run(script, root, { names: BOTH + ",FEATURE_FLAG" }); const e = await envOf(root);
    check("a short value is taken out but not searched for, and it says so", r2.code === 0 && !("FEATURE_FLAG" in e.production) && r2.out.includes("Too short to search for: FEATURE_FLAG"), `${r2.code} ${r2.last}`);
    const r3 = run(script, bundle({ env: FULL }), { names: BOTH, args: ["--force"] });
    check("an unknown argument is refused, exit 2", r3.code === 2 && r3.last === "build_secrets=blind", `${r3.code} ${r3.last}`);
  }
  { // 8. the install the guide describes: the optional settings left empty, the Worker holding only the two keys
    const OPTIONAL = { CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "", SSO_ALLOWED_USER_IDS: "" };
    const root = bundle({ env: { ...FULL, ...OPTIONAL } }); const r = run(script, root, { names: BOTH }); const e = await envOf(root);
    check("settings left empty are not asked of the Worker: a later deploy is clean, exit 0", r.code === 0 && r.last === "build_secrets=clean", `${r.code} ${r.last}`);
    check("the empty settings stay as they were, and the two keys are still taken out", Object.keys(OPTIONAL).every((k) => e.production[k] === "") && !("SUPABASE_SERVICE_ROLE_KEY" in e.production) && !("GRIDPANE_API_TOKEN" in e.production));
    check("it says which settings it left empty, and does not count them as taken out", r.out.includes("Left 3 empty settings as they are: CF_ACCESS_AUD, CF_ACCESS_TEAM_DOMAIN, SSO_ALLOWED_USER_IDS") && r.out.includes("Took 2 settings out"), r.out.split("\n").slice(0, 3).join(" | "));
    const half = bundle({ raw: `export const production = ${JSON.stringify({ ...FULL, CF_ACCESS_AUD: "" })};\nexport const development = ${JSON.stringify({ ...FULL, CF_ACCESS_AUD: rnd(16) })};\nexport const test = {};\n` });
    const r2 = run(script, half, { names: BOTH });
    check("a setting empty in one mode and filled in another is still asked of the Worker", r2.code === 1 && r2.last === "build_secrets=missing" && r2.out.includes("Next: npx wrangler secret put CF_ACCESS_AUD"), `${r2.code} ${r2.last}`);
  }
  return results;
}

// Every package.json command that sends a build to Cloudflare must strip it first.
export function sendsUnstripped(packageText) {
  const bad = [];
  for (const [name, cmd] of Object.entries(JSON.parse(packageText).scripts || {})) {
    const steps = String(cmd).split("&&").map((x) => x.trim());
    const send = steps.findIndex((x) => /^opennextjs-cloudflare (deploy|upload)\b/.test(x));
    if (send === -1) continue;
    const build = steps.findIndex((x) => /^opennextjs-cloudflare build\b/.test(x));
    const strip = steps.findIndex((x) => /^node scripts\/strip-build-secrets\.mjs\b/.test(x));
    if (!(build > -1 && build < strip && strip < send)) bad.push(name);
  }
  return bad;
}
const packageText = readFileSync(resolve(here, "../package.json"), "utf8");
const senders = Object.entries(JSON.parse(packageText).scripts).filter(([, c]) => /opennextjs-cloudflare (deploy|upload)\b/.test(c)).map(([n]) => n);

if (!process.argv.includes("--controls")) {
  const results = await suite(process.env.STRIP_SCRIPT ? resolve(process.env.STRIP_SCRIPT) : real);
  const bad = sendsUnstripped(packageText);
  results.push({ name: `each of the ${senders.length} package.json commands that send a build to Cloudflare builds, strips, then sends (${senders.join(", ")})`, ok: senders.length >= 3 && bad.length === 0, detail: bad.join(", ") });
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : "\n       " + r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`build secrets: ${results.length} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// Broken copies: each changes one thing the script must do, and at least one check has to notice.
const source = readFileSync(real, "utf8");
const CONTROLS = [
  ["every setting counts as public", 'const PUBLIC = /^NEXT_PUBLIC_/;', "const PUBLIC = /./;"],
  ["the stripped file is never written", 'writeFileSync(envFile, out.join("\\n") + "\\n");', ""],
  ["the bundle is not searched", "if (!hunt.length) continue;", "continue;"],
  ["nothing is long enough to search for", "const SEARCHABLE = 12;", "const SEARCHABLE = 100000;"],
  ["a value found still exits 0", 'finish("found", 1);', 'finish("found", 0);'],
  ["a found value is printed", "the value of ${name}`", "${v}`"],
  ["a secret the Worker lacks is let through", "const missing = names.filter((n) => !held.has(n));", "const missing = [];"],
  ["wrangler not answering counts as an empty list", "if (res.status !== 0 || !Array.isArray(listed)) {", "listed = listed || []; if (false) {"],
  ["vars in wrangler.jsonc are not counted", "for (const k of Object.keys(JSON.parse(text).vars || {})) held.add(k);", ""],
  ["an unknown form is treated as no settings", 'console.log("Do not deploy until this is understood: the file may hold your keys.");\n    finish("blind", 3);', "continue;"],
  ["--no-worker-check is ignored", 'if (names.length && !flag("--no-worker-check")) {', "if (names.length) {"],
  ["an unknown argument is let through", 'if (!known.has(args[i])) { console.log(`Unknown argument: ${args[i]}`); finish("blind", 2); }', ""],
  ["an empty setting is asked of the Worker", 'if (v === "" || v == null) { keep[name] = v; empty.add(name); continue; }', ""],
  ["a setting empty in one mode is never asked of the Worker", "const names = [...removed.keys()].sort();", "const names = [...removed.keys()].filter((n) => !empty.has(n)).sort();"],
];
let caught = 0;
for (const [name, from, to] of CONTROLS) {
  if (!source.includes(from)) { console.log(`  MISSED  ${name}  (the line to break was not found: fix the control)`); continue; }
  const copy = join(work, `broken-${caught}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(copy, source.replace(from, to));
  const failing = (await suite(copy)).filter((r) => !r.ok).length;
  if (failing) caught++;
  console.log(`  ${failing ? "caught" : "MISSED"}  ${name}  (${failing} failing)`);
}
// And package.json commands that skip the strip: the package check must name each.
const PACKAGE_CONTROLS = [
  ["upload sends the build without stripping it", (j) => { j.scripts.upload = "opennextjs-cloudflare build && opennextjs-cloudflare upload"; }, "upload"],
  ["deploy strips after it has sent", (j) => { j.scripts.deploy = "opennextjs-cloudflare build && opennextjs-cloudflare deploy && node scripts/strip-build-secrets.mjs"; }, "deploy"],
  ["a new command deploys with no build step of its own", (j) => { j.scripts.ship = "opennextjs-cloudflare deploy"; }, "ship"],
];
let caughtPackage = 0;
for (const [name, breakIt, expect] of PACKAGE_CONTROLS) {
  const j = JSON.parse(packageText); breakIt(j);
  const bad = sendsUnstripped(JSON.stringify(j));
  const ok = bad.length === 1 && bad[0] === expect;
  if (ok) caughtPackage++;
  console.log(`  ${ok ? "caught" : "MISSED"}  ${name}  (named: ${bad.join(", ") || "nothing"})`);
}
const all = CONTROLS.length + PACKAGE_CONTROLS.length;
console.log(`${all} broken copies: ${caught + caughtPackage} caught, ${all - caught - caughtPackage} missed`);
process.exit(caught + caughtPackage === all ? 0 : 1);
