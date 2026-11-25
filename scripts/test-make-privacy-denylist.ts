/**
 * Checks for scripts/make-privacy-denylist.ts, the program that writes the
 * privacy gate's denylist.   npm run privacy:denylist:test
 *
 *   (no option)  each case beside the one that must not pass
 *   --controls   break a copy of the program one way at a time; each break must be caught
 *
 * Why it matters: the two Cloudflare Access values are private, and the advice
 * everywhere is to take them out of .env.local. The list must not lose them
 * without a word when someone does: it reads them from your own list too
 * (privacy-extra), and says so when neither place has them.
 *
 * DENYLIST_MAKER points the checks at another copy (the controls use it).
 * Touches nothing real: the "database" is a file of made-up rows, and the
 * settings, your own list and the list it writes all live in a temporary
 * folder. No network. Every value is made up, and built here from pieces.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const MAKER = process.env.DENYLIST_MAKER || here("./make-privacy-denylist.ts");

type Break = [name: string, edit: (s: string) => string];
const swap = (from: string, to: string) => (s: string) => {
  const out = s.replace(from, to);
  if (out === s) throw new Error(`a control found nothing to change: ${from.slice(0, 60)}`);
  return out;
};
const BREAKS: Break[] = [
  ["the two lines in your own list are not read", swap("if (setting) addSetting(setting[1], setting[2]);", "if (setting) { /* not read */ }")],
  ["nothing is said when the Access values are missing", swap('const note = absent.length === 0 ? "" :', 'const note = true ? "" :')],
  ["the note is given even when both values are there", swap(".filter(([name]) => !given.has(name));", ".filter(() => true);")],
  ["only the team address is asked about, not the audience tag", swap(', ["CF_ACCESS_AUD", "audience tag"]].filter', "].filter")],
  ["a line with no value counts as a value", swap("  if (!value) return;\n  given.add(name);", "  given.add(name);\n  if (!value) return;")],
  ["the settings in .env.local are no longer read", swap("for (const name of SETTINGS) addSetting(name, process.env[name]);\n", "")],
  ["the team is listed as typed, without its own name", swap('if (name === "CF_ACCESS_TEAM_DOMAIN") addHost(value, "the Cloudflare Access team");', 'if (name === "CF_ACCESS_TEAM_DOMAIN") add(value, "the Cloudflare Access team");')],
  ["quotes around a value are kept as part of it", swap('.replace(/^(["\'])(.*)\\1$/, "$2")', "")],
  ["a value is printed as it is read", swap("  given.add(name);\n", "  given.add(name); console.log(value);\n")],
  ["a line that is commented out is read as a term", swap('if (!t || t.startsWith("#")) continue;', "if (!t) continue;")],
  ["--check writes the list", swap("  process.exit(0);\n}\nmkdirSync(dirname(target)", "}\nmkdirSync(dirname(target)")],
  ["made-up rows are accepted outside the temporary folder", swap("if (!temp.some((t) => config.startsWith(t + sep))) {", "if (false) {")],
];

if (process.argv.includes("--controls")) {
  const dir = mkdtempSync(join(tmpdir(), "privacy-denylist-controls-"));
  let caught = 0;
  try {
    // A copy in a temp folder cannot find the packages the program imports: give that folder the same ones.
    symlinkSync(realpathSync(here("../node_modules")), join(dir, "node_modules"));
    const source = readFileSync(MAKER, "utf8");
    if (/from "\.\.?\//.test(source)) throw new Error("the program now imports a neighbor: a copy in a temp folder would not load, and a copy that will not load is not a catch");
    const base = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { env: { ...process.env, DENYLIST_MAKER: MAKER }, encoding: "utf8" });
    if (!/ 0 failed\s*$/.test(base.stdout || "")) { console.log("The checks do not pass on the program as it is, so a control would prove nothing. Fix that first."); process.exit(1); }
    for (const [name, edit] of BREAKS) {
      writeFileSync(join(dir, "maker.ts"), edit(source));
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { env: { ...process.env, DENYLIST_MAKER: join(dir, "maker.ts") }, encoding: "utf8" });
      const m = /(\d+) checks, (\d+) failed/.exec(r.stdout || "");
      // A run that fell over is not a catch, and neither is a copy that fails every check: it broke before the checks.
      const ok = !!m && Number(m[2]) > 0 && Number(m[2]) < Number(m[1]);
      if (ok) caught++;
      console.log(`  ${ok ? "caught" : "MISSED"}  ${name}  (${m ? `${m[2]} of ${m[1]} failing` : "the run did not finish: " + (r.stderr || "").trim().split("\n").pop()})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(`\n${BREAKS.length} broken copies: ${caught} caught, ${BREAKS.length - caught} missed`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

let ran = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

// Made-up values, built from pieces so this file holds nothing the gate would flag.
const TEAM_NAME = "yourteam", TEAM = `${TEAM_NAME}.cloudflareaccess.com`;
const AUD = "c".repeat(64);
const USER_ID = ["11111111", "2222", "3333", "4444", "555555555555"].join("-");
const BASE_ENV = ["NEXT_PUBLIC_SUPABASE_URL=http://localhost:9", "SUPABASE_SERVICE_ROLE_KEY=not-a-real-key"];
const ROWS = {
  servers: [{ id: 12345, ip: ["203", "0", "113", "7"].join("."), label: "example-box", subdomain: "box.example.com" }],
  sites: [{ id: 67890, url: "shop.example.com", cloudflare_dns_name: null }],
};

const root = mkdtempSync(join(tmpdir(), "privacy-denylist-test-"));
let n = 0;
/** One run of the program in a folder of its own: its settings, your own list, and what came out. */
function run(o: { env?: string[]; own?: string; args?: string[]; outsideTemp?: boolean } = {}) {
  const dir = join(root, `case-${++n}`), work = join(dir, "work"), config = join(dir, "config");
  mkdirSync(work, { recursive: true }); mkdirSync(join(config, "fleet"), { recursive: true }); mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(work, ".env.local"), [...BASE_ENV, ...(o.env ?? [])].join("\n") + "\n");
  writeFileSync(join(dir, "rows.json"), JSON.stringify(ROWS));
  const ownFile = join(config, "fleet", "privacy-extra"), listFile = join(config, "fleet", "privacy-denylist");
  if (o.own !== undefined) writeFileSync(ownFile, o.own);
  // "Outside the temporary folder": the program is told the temporary folder is somewhere else, so this one is not under it.
  const temp = o.outsideTemp ? join(dir, "another-temp") : tmpdir();
  mkdirSync(temp, { recursive: true });
  // Nothing of this machine's own settings reaches the program: only what the case gives it.
  const env = { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), XDG_CONFIG_HOME: config, TMPDIR: temp, FLEET_PRIVACY_TEST_ROWS: join(dir, "rows.json") } as unknown as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", MAKER, ...(o.args ?? [])], { cwd: work, env, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const list = existsSync(listFile) ? readFileSync(listFile, "utf8").split("\n").filter((l) => l && !l.startsWith("# ")) : null;
  return { code: r.status, out, list, ownFile, has: (term: string) => !!list && list.includes(term), noted: /\nNote: /.test(out), printed: (value: string) => out.includes(value) };
}
const NOTE_BOTH = "Note: this list has no Cloudflare Access team address and no audience tag.";
const ACCESS = [`CF_ACCESS_TEAM_DOMAIN=${TEAM}`, `CF_ACCESS_AUD=${AUD}`];

try {
  console.log("The two Access values in .env.local, as an older setup has them");
  const inEnv = run({ env: ACCESS });
  {
    check("it writes the list", [inEnv.code, inEnv.list !== null], [0, true]);
    check("the team address, the team's own name and the audience tag are all on it", [inEnv.has(TEAM), inEnv.has(TEAM_NAME), inEnv.has(AUD)], [true, true, true]);
    check("the made-up server and site are on it too", [inEnv.has("example-box"), inEnv.has("shop.example.com")], [true, true]);
    check("nothing is missing, so there is no note", inEnv.noted, false);
    check("no value is printed: only counts", [inEnv.printed(AUD), inEnv.printed(TEAM_NAME)], [false, false]);
    check("it says the rows were made up", inEnv.out.includes("TEST ROWS: the servers and sites came from a file, not the database."), true);
  }

  console.log("The two values taken out of .env.local, as the advice says, and nowhere else");
  const takenOut = run();
  {
    check("the list is still written", [takenOut.code, takenOut.list !== null], [0, true]);
    check("control: neither value is on it any more (this is what used to happen without a word)", [takenOut.has(TEAM), takenOut.has(TEAM_NAME), takenOut.has(AUD)], [false, false, false]);
    check("and it says so plainly", takenOut.out.includes(NOTE_BOTH), true);
    check("it says where it looked, and names your own list by its full name", takenOut.out.includes(`Neither is in .env.local, .dev.vars or ${takenOut.ownFile}`), true);
    check("and gives the two lines to add", [takenOut.out.includes("\n  CF_ACCESS_TEAM_DOMAIN="), takenOut.out.includes("\n  CF_ACCESS_AUD=")], [true, true]);
  }

  console.log("The two lines copied into your own list first");
  const moved = run({ own: ["# what no database knows", "", "Example Business Name", ...ACCESS, ""].join("\n") });
  {
    check("the team address, the team's own name and the audience tag are on the list again", [moved.has(TEAM), moved.has(TEAM_NAME), moved.has(AUD)], [true, true, true]);
    check("an ordinary line in your own list still works as before", moved.has("example business name"), true);
    check("nothing is missing, so there is no note", moved.noted, false);
    const said = /, (\d+) from /.exec(moved.out.split("this checkout's settings")[1] || "");
    check("it says how many terms came from your own list, and the count is right", said ? Number(said[1]) : "no count", (moved.list?.length ?? 0) - (takenOut.list?.length ?? 0));
    check("and still prints no value", [moved.printed(AUD), moved.printed(TEAM_NAME), moved.printed("Example Business Name")], [false, false, false]);
    check("the lines themselves are not kept as terms", moved.list?.some((l) => l.includes("cf_access")) ?? true, false);
  }

  console.log("One value in each place, and one value alone");
  {
    const split = run({ env: [ACCESS[0]], own: `${ACCESS[1]}\n` });
    check("the team in .env.local and the tag in your own list: both on the list, no note", [split.has(TEAM), split.has(AUD), split.noted], [true, true, false]);
    const teamOnly = run({ own: `${ACCESS[0]}\n` });
    check("only the team given: the note asks for the audience tag", teamOnly.out.includes("Note: this list has no Cloudflare Access audience tag. It is not in"), true);
    check("and for that line alone", [teamOnly.out.includes("\n  CF_ACCESS_AUD="), teamOnly.out.includes("\n  CF_ACCESS_TEAM_DOMAIN=")], [true, false]);
    check("the team it was given is on the list", [teamOnly.has(TEAM), teamOnly.has(AUD)], [true, false]);
    const tagOnly = run({ own: `${ACCESS[1]}\n` });
    check("only the tag given: the note asks for the team address, and that line alone", [tagOnly.out.includes("Note: this list has no Cloudflare Access team address. It is not in"), tagOnly.out.includes("\n  CF_ACCESS_TEAM_DOMAIN="), tagOnly.out.includes("\n  CF_ACCESS_AUD=")], [true, true, false]);
  }

  console.log("How the two lines may be written");
  {
    const pasted = run({ own: [`CF_ACCESS_TEAM_DOMAIN = "https://${TEAM}/"`, `CF_ACCESS_AUD='${AUD}'   # the application's tag`, ""].join("\n") });
    check("quotes, spaces round the =, a pasted https:// and a comment after the value are all read", [pasted.has(TEAM), pasted.has(TEAM_NAME), pasted.has(AUD), pasted.noted], [true, true, true, false]);
    const empty = run({ own: ["CF_ACCESS_TEAM_DOMAIN=", 'CF_ACCESS_AUD=""', ""].join("\n") });
    check("control: a line with no value is not a value: the note is given", empty.out.includes(NOTE_BOTH), true);
    const commented = run({ own: [`# CF_ACCESS_TEAM_DOMAIN=${TEAM}`, `#CF_ACCESS_AUD=${AUD}`, ""].join("\n") });
    check("control: a line that is commented out is not read: the note is given, and neither value is on the list", [commented.out.includes(NOTE_BOTH), commented.has(TEAM), commented.has(AUD)], [true, false, false]);
    check("and no commented line became a term", commented.list?.some((l) => l.startsWith("#")) ?? true, false);
    const ids = run({ env: ACCESS, own: `SSO_ALLOWED_USER_IDS=${USER_ID}\n` });
    check("the allowed user ids are read from your own list the same way", ids.has(USER_ID), true);
    const other = run({ env: ACCESS, own: "SOMETHING_ELSE=example-value\n~anywhere-term\n" });
    check("control: any other NAME=value line is a term as written, and a ~ term is kept as written", [other.has("something_else=example-value"), other.has("~anywhere-term")], [true, true]);
  }

  console.log("--check, and the made-up rows");
  {
    const looked = run({ args: ["--check"] });
    check("--check writes nothing, and still gives the note", [looked.code, looked.list, looked.out.includes("Nothing was written."), looked.out.includes(NOTE_BOTH)], [0, null, true, true]);
    const outside = run({ env: ACCESS, outsideTemp: true });
    check("made-up rows are refused when the list would be written outside the temporary folder, and nothing is written", [outside.code, outside.list, outside.out.includes("FLEET_PRIVACY_TEST_ROWS is for the self-test")], [1, null, true]);
  }
} finally { rmSync(root, { recursive: true, force: true }); }

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
