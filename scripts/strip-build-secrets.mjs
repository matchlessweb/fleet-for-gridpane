#!/usr/bin/env node
// Takes every setting that is not public out of the Worker bundle, between the
// build and the deploy, and proves none of their values is left in it.
//
//   node scripts/strip-build-secrets.mjs                  # what `npm run deploy` runs after the build
//   node scripts/strip-build-secrets.mjs --no-worker-check   # do not ask the Worker which secrets it holds
//   node scripts/strip-build-secrets.mjs --dir <bundle folder>
//
// Why: the build copies every line of .env.local (and the other .env files)
// into <bundle>/cloudflare/next-env.mjs, which is uploaded as part of the
// Worker's code. A service-role key in a Worker's code can be read by any person,
// and any API token, that is allowed to read the account's Workers. Secrets belong in
// the Worker's own secret store (`npx wrangler secret put NAME`), which wins at
// run time anyway: the copied values only fill in what the Worker does not hold.
//
// What it does, in order:
//   1. reads next-env.mjs and keeps only the names that start NEXT_PUBLIC_
//   2. unless --no-worker-check: asks wrangler which secrets the Worker holds,
//      reads `vars` in wrangler.jsonc, and STOPS if a name it took out is in
//      neither. Deploying then would turn that setting off without a word.
//   3. looks through every file of the bundle for each value it took out
//
// It prints names and counts, never a value. The last line is always
// build_secrets=clean|found|missing|blind; exit 0 only for clean.
// FLEET_WRANGLER names another command to list the secrets with (the test's stand-in).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.FLEET_DEPLOY_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.indexOf(name) > -1 ? args[args.indexOf(name) + 1] : null);
const known = new Set(["--dir", "--no-worker-check"]);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) { console.log(`Unknown argument: ${args[i]}`); finish("blind", 2); }
  if (args[i] === "--dir") i++;
}
const bundle = resolve(root, value("--dir") || ".open-next");
const PUBLIC = /^NEXT_PUBLIC_/;
// A value shorter than this is too ordinary to search for ("true", "1", a port): it is taken out but not hunted.
const SEARCHABLE = 12;

function finish(verdict, code) { console.log(`build_secrets=${verdict}`); process.exit(code); }

const envFile = join(bundle, "cloudflare/next-env.mjs");
if (!existsSync(envFile)) {
  console.log(`No ${envFile.replace(root + "/", "")}. Build first (opennextjs-cloudflare build); nothing was checked.`);
  finish("blind", 3);
}

// The file is lines of `export const <mode> = {…json…};`. Anything else means the build tool changed its format.
const modes = [];
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const m = /^export const ([A-Za-z_$][\w$]*) = (\{.*\});?$/.exec(line.trim());
  let parsed = null;
  try { parsed = m && JSON.parse(m[2]); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.log("next-env.mjs is not in the form this script knows, so it was left as it is and nothing was checked.");
    console.log("Do not deploy until this is understood: the file may hold your keys.");
    finish("blind", 3);
  }
  modes.push({ mode: m[1], vars: parsed });
}
if (!modes.length) { console.log("next-env.mjs holds no settings block; nothing was checked."); finish("blind", 3); }

const removed = new Map(); // name -> Set of values
const empty = new Set();
let kept = 0;
const out = modes.map(({ mode, vars }) => {
  const keep = {};
  for (const [name, v] of Object.entries(vars)) {
    if (PUBLIC.test(name)) { keep[name] = v; kept++; continue; }
    // A setting left empty in .env.local (the optional ones) holds nothing to take out, and the
    // Worker is not asked to hold it: it stays as it is, so the app reads it empty as it always did.
    if (v === "" || v == null) { keep[name] = v; empty.add(name); continue; }
    if (!removed.has(name)) removed.set(name, new Set());
    if (typeof v === "string") removed.get(name).add(v);
  }
  return `export const ${mode} = ${JSON.stringify(keep)};`;
});
writeFileSync(envFile, out.join("\n") + "\n");
const names = [...removed.keys()].sort();
console.log(names.length
  ? `Took ${names.length} setting${names.length === 1 ? "" : "s"} out of the Worker's code: ${names.join(", ")}`
  : "The Worker's code held no setting besides the public ones.");
console.log(`Kept the public ones (${kept} across ${modes.length} modes).`);
const emptyOnly = [...empty].filter((n) => !removed.has(n)).sort();
if (emptyOnly.length) console.log(`Left ${emptyOnly.length} empty setting${emptyOnly.length === 1 ? "" : "s"} as ${emptyOnly.length === 1 ? "it is" : "they are"}: ${emptyOnly.join(", ")}`);

// 2. Does the Worker hold each one itself?
if (names.length && !flag("--no-worker-check")) {
  const held = new Set();
  const config = ["wrangler.jsonc", "wrangler.json"].map((f) => join(root, f)).find(existsSync);
  if (config) {
    try {
      // Comments out, strings left alone (an address holds "//").
      const text = readFileSync(config, "utf8").replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (all, str) => str || "").replace(/,(\s*[}\]])/g, "$1");
      for (const k of Object.keys(JSON.parse(text).vars || {})) held.add(k);
    } catch { console.log(`Could not read ${config.replace(root + "/", "")}; its vars were not counted.`); }
  }
  const [cmd, ...pre] = (process.env.FLEET_WRANGLER || "npx wrangler").split(" ");
  const res = spawnSync(cmd, [...pre, "secret", "list"], { cwd: root, encoding: "utf8", timeout: 60000 });
  let listed = null;
  try { listed = JSON.parse(res.stdout.slice(res.stdout.indexOf("["))); } catch { listed = null; }
  if (res.status !== 0 || !Array.isArray(listed)) {
    console.log("Could not ask the Worker which secrets it holds (is wrangler signed in, and does the Worker exist yet?).");
    console.log(`Next: store each one, then deploy again:  ${names.map((n) => `npx wrangler secret put ${n}`).join("  ;  ")}`);
    console.log("To deploy without this check (the very first deploy of a new Worker): add --no-worker-check.");
    finish("blind", 3);
  }
  for (const s of listed) if (s && typeof s.name === "string") held.add(s.name);
  const missing = names.filter((n) => !held.has(n));
  if (missing.length) {
    console.log(`STOP: the Worker does not hold ${missing.join(", ")}. Deployed now, ${missing.length === 1 ? "that setting" : "those settings"} would be empty.`);
    for (const n of missing) console.log(`Next: npx wrangler secret put ${n}`);
    finish("missing", 1);
  }
  console.log(`The Worker holds every one of them itself (${names.length} checked against its secrets and vars).`);
} else if (names.length) {
  console.log("Not asked: whether the Worker holds them. Store each with `npx wrangler secret put NAME` before the app is used.");
}

// 3. Is any value still in the bundle?
const hunt = [];
for (const [name, values] of removed) for (const v of values) if (v.length >= SEARCHABLE) hunt.push({ name, v });
const short = names.filter((n) => ![...removed.get(n)].some((v) => v.length >= SEARCHABLE));
let files = 0;
const hits = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry), s = statSync(p);
    if (s.isDirectory()) { walk(p); continue; }
    files++;
    if (!hunt.length) continue;
    const body = readFileSync(p).toString("latin1");
    for (const { name, v } of hunt) if (body.includes(Buffer.from(v, "utf8").toString("latin1"))) hits.push(`${p.replace(root + "/", "")}: the value of ${name}`);
  }
})(bundle);
if (files === 0) { console.log("The bundle folder holds no files; nothing was checked."); finish("blind", 3); }
if (hits.length) {
  console.log(`FOUND in the bundle after stripping (${hits.length}):`);
  for (const h of hits) console.log(`  ${h}`);
  console.log("Do not deploy. Something in the app's code carries the value itself.");
  finish("found", 1);
}
console.log(`Looked through ${files} files for ${hunt.length} value${hunt.length === 1 ? "" : "s"}: none found.${short.length ? `  Too short to search for: ${short.join(", ")}.` : ""}`);
finish("clean", 0);
