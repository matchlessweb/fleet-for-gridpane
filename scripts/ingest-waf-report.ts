/**
 * Load a WAF inventory run into Supabase.
 *
 *   npm run waf:ingest -- <run directory>            # the folder holding report.json
 *   npm run waf:ingest -- <run directory> --dry-run  # validate and report, write nothing
 *   npm run waf:ingest -- --latest                   # newest run in your output folder
 *
 * The run directory is what scripts/waf-inventory.py wrote with --out: it holds
 * report.json (the data) and, if you gave the inventory a page template,
 * index.html (a page built from the same data). This script reads report.json
 * ONLY. It never parses the page and never calls Cloudflare, so it needs no
 * Cloudflare token of any kind.
 *
 * The output folder is where scripts/waf-refresh.sh keeps its runs:
 * FLEET_OUTPUT_DIR, or the full path on one line in ~/.config/fleet/output-dir,
 * else ~/.local/state/fleet (under $XDG_STATE_HOME when that is set).
 *
 * Idempotent: the database function compares the file's SHA-256 with the
 * latest run and writes nothing when they match. Running it twice changes
 * nothing the second time.
 *
 * Refuses to load:
 *   - a report where a long opaque value survived masking (a possible secret),
 *   - a report whose expr_masked flags disagree with its expressions,
 *   - a report older than the one already loaded (unless --allow-older),
 *   - a report that lost more than half the zones of the previous run
 *     (unless --allow-shrink) — that is a failed inventory, not a fleet change.
 *
 * Flags: --dry-run, --latest, --allow-older, --allow-shrink, --unattended,
 *        --generated <ISO time> (override the file's modified time)
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unattendedHolds, validateReport, type ReportZone } from "../lib/cloudflare-waf.ts";

// The output folder, found the same way as fleet_output_dir in
// scripts/lib-fleet-output.sh: the environment, then the settings file, then
// the default. Change one, change both: scripts/test-waf-inventory.py runs the
// two side by side on the same made-up settings and fails if they disagree.
function outputDirFile(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fleet", "output-dir");
}
function outputDirFromFile(): string {
  try {
    return readFileSync(outputDirFile(), "utf8").replace(/\n+$/, "");
  } catch {
    return ""; // no settings file
  }
}
function outputDir(): string {
  return (
    process.env.FLEET_OUTPUT_DIR ||
    outputDirFromFile() ||
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "fleet")
  );
}
const BACKUPS = outputDir();

function fail(msg: string): never {
  console.error(`\nNOT INGESTED: ${msg}`);
  process.exit(1);
}

function findReport(dir: string): string | null {
  for (const p of [join(dir, "report.json"), join(dir, "waf-inventory", "report.json")]) {
    if (existsSync(p)) return p;
  }
  return null;
}

// --latest found nothing. That does not mean no inventory was ever taken:
// earlier runs may be kept in another folder. Say where this looked, which of
// the three places that folder came from, and how to point at another one.
function noRunFound(): never {
  const from = process.env.FLEET_OUTPUT_DIR
    ? "set in FLEET_OUTPUT_DIR"
    : outputDirFromFile()
      ? `set in ${outputDirFile()}`
      : "the default: no other folder is set";
  fail(
    [
      "no inventory run found.",
      `       Folder searched: ${BACKUPS}`,
      `       (${from})`,
      "       If earlier runs, audits or snapshots are kept in another folder, point at it:",
      `       set FLEET_OUTPUT_DIR, or put its full path on one line in ${outputDirFile()}.`,
      "       Or give one run's folder in place of --latest.",
      "       To take a new inventory: bash scripts/waf-refresh.sh",
    ].join("\n"),
  );
}

function latestRunReport(): string {
  if (!existsSync(BACKUPS)) noRunFound();
  const found = readdirSync(BACKUPS)
    .map((d) => findReport(join(BACKUPS, d)))
    .filter((p): p is string => p !== null)
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (found.length === 0) noRunFound();
  return found[0].p;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--generated");

const dryRun = flag("--dry-run");
let reportPath: string;
if (flag("--latest")) {
  reportPath = latestRunReport();
} else if (positional.length === 1) {
  const given = resolve(positional[0]);
  const found = given.endsWith(".json") && existsSync(given) ? given : findReport(given);
  if (!found) fail(`no report.json in ${given}`);
  reportPath = found;
} else {
  fail("give one run directory, or --latest. See the header of this file.");
}

// ── read + validate ─────────────────────────────────────────────────────────
const raw = readFileSync(reportPath);
const sha256 = createHash("sha256").update(raw).digest("hex");
let report: Record<string, ReportZone>;
try {
  report = JSON.parse(raw.toString("utf8"));
} catch (e) {
  fail(`report.json is not valid JSON (${(e as Error).message})`);
}

const problems = validateReport(report);
if (problems.length > 0) {
  console.error(`report.json failed ${problems.length} check(s):`);
  for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
  if (problems.length > 20) console.error(`  … and ${problems.length - 20} more`);
  fail("fix the inventory run, do not edit report.json by hand");
}

// The generator writes no date inside report.json, so the run date is the
// file's modified time. Run folders are named by date (YYYY-MM-DD-…); when the
// folder's date and the file's disagree, something was copied or re-dated, and
// a guessed date on a security page is worse than a refusal.
const generatedArg = valueOf("--generated");
const generatedAt = generatedArg ? new Date(generatedArg) : statSync(reportPath).mtime;
if (Number.isNaN(generatedAt.getTime())) fail(`--generated is not a date: ${generatedArg}`);
if (generatedAt.getTime() > Date.now() + 5 * 60_000) fail("the report is dated in the future");

const runDirAbs = dirname(reportPath);
const runDir = runDirAbs.startsWith(BACKUPS + "/") ? runDirAbs.slice(BACKUPS.length + 1) : runDirAbs;
const folderDate = (runDir.match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1];
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
if (!generatedArg && folderDate && folderDate !== localDate(generatedAt)) {
  fail(
    `the run folder is dated ${folderDate} but report.json was last written ${localDate(generatedAt)}. ` +
      `Pass --generated <ISO time> to say which is right.`
  );
}

const zones = Object.entries(report)
  .map(([name, z]) => ({ ...z, name: name.toLowerCase() }))
  .sort((a, b) => a.name.localeCompare(b.name));
const ruleCount = zones.reduce((n, z) => n + z.rules.length, 0);
const maskedCount = zones.reduce((n, z) => n + z.rules.filter((r) => r.expr_masked).length, 0);
const by = (key: (z: ReportZone) => string) => {
  const out: Record<string, number> = {};
  for (const z of zones) out[key(z)] = (out[key(z)] ?? 0) + 1;
  return Object.entries(out)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
};

console.log(`report      ${reportPath}`);
console.log(`run         ${runDir}`);
console.log(`generated   ${generatedAt.toISOString()}${generatedArg ? "  (from --generated)" : "  (file modified time)"}`);
console.log(`sha256      ${sha256.slice(0, 16)}…`);
console.log(`zones       ${zones.length}   (${by((z) => z.klass)})`);
console.log(`profiles    ${by((z) => String(z.profile ?? "none"))}`);
console.log(`rules       ${ruleCount}, ${maskedCount} with a masked value`);
console.log(`findings    ${zones.filter((z) => z.findings.length > 0).length} zones`);
console.log(`validation  passed: ${zones.length} zones and ${ruleCount} expressions checked for unmasked values`);

if (dryRun) {
  console.log("\ndry run: nothing written.");
  process.exit(0);
}

// ── write ───────────────────────────────────────────────────────────────────
// Resolve .env.local from the repo, not the shell's folder, so the command
// works from anywhere (the same reason cron-sync.sh resolves its own path).
// fileURLToPath, not URL.pathname: the latter keeps a space as %20, and this
// repository lives in a folder with a space in its name.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(repoRoot, ".env.local"), quiet: true });
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  fail(".env.local needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const before = await supabase.from("cloudflare_zones").select("name", { count: "exact", head: true });
if (before.error) {
  fail(
    `cannot read cloudflare_zones (${before.error.message}). ` +
      `If the tables do not exist yet, apply the database migrations first (SETUP.md, step 4).`
  );
}
const previous = before.count ?? 0;
if (previous > 0 && zones.length < previous / 2 && !flag("--allow-shrink")) {
  fail(
    `this report has ${zones.length} zones and the database has ${previous}. ` +
      `A drop that large is usually a failed inventory run. Pass --allow-shrink if it is real.`
  );
}

// The daily job passes --unattended: see unattendedHolds in lib/cloudflare-waf.ts.
if (flag("--unattended") && previous > 0) {
  const prior = await supabase.from("cloudflare_zones").select("name,nrules");
  if (prior.error) fail(`cannot read the current zones (${prior.error.message})`);
  const holds = unattendedHolds(prior.data ?? [], zones.map((z) => ({ name: z.name, nrules: z.nrules })));
  if (holds.length > 0) {
    fail(
      `held, nothing written. An unattended run does not accept these on its own:\n  - ${holds.join("\n  - ")}\n` +
        `If they are real, run the ingest by hand on this run folder (without --unattended).`
    );
  }
}

const { data, error } = await supabase.rpc("ingest_cloudflare_waf", {
  p_report_sha256: sha256,
  p_run_dir: runDir,
  p_generated_at: generatedAt.toISOString(),
  p_zones: zones,
  p_allow_older: flag("--allow-older"),
});
if (error) fail(error.message);

const result = data as { changed: boolean; confirmed?: boolean; run_id: number; removed?: string[] };
if (!result.changed && result.confirmed) {
  console.log(
    `\nno rule changed: this report is identical to the latest run (run ${result.run_id}). ` +
      `Its date moved forward to this run; no zone was touched.`
  );
  const run = await supabase.from("cloudflare_waf_runs").select("generated_at").eq("id", result.run_id).single();
  if (run.error || new Date(run.data.generated_at).getTime() !== generatedAt.getTime()) {
    fail(`the run's date did not read back as ${generatedAt.toISOString()}`);
  }
  console.log(`run date now ${generatedAt.toISOString()} (read back).`);
  process.exit(0);
} else if (!result.changed) {
  console.log(`\nno change: this exact report is already the latest run (run ${result.run_id}). Nothing written.`);
  process.exit(0);
}

// Read it back rather than trusting the return value.
const after = await supabase
  .from("cloudflare_zones")
  .select("name,nrules,run_id", { count: "exact" })
  .eq("run_id", result.run_id);
if (after.error) fail(`ingested, but the read-back failed: ${after.error.message}`);
const storedRules = (after.data ?? []).reduce((n, z) => n + (z.nrules ?? 0), 0);
if (after.count !== zones.length || storedRules !== ruleCount) {
  fail(
    `read-back mismatch: stored ${after.count} zones / ${storedRules} rules, expected ${zones.length} / ${ruleCount}`
  );
}

console.log(`\ningested as run ${result.run_id}: ${after.count} zones, ${storedRules} rules (read back and counted).`);
if (result.removed && result.removed.length > 0) {
  console.log(`removed ${result.removed.length} zone(s) no longer in the inventory: ${result.removed.join(", ")}`);
}
if (existsSync(join(runDirAbs, "index.html"))) {
  console.log(
    `\nThe inventory's own page is built from the same report: ${basename(runDirAbs)}/index.html. ` +
      `If you publish that page anywhere, publish it again so the two show the same run.`
  );
}
