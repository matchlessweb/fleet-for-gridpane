// The private config and the public example must have the same shape, or a fork (or the owner)
// meets a missing value at build time.   node --experimental-strip-types scripts/test-fleet-config.ts
import { fleetConfig as mine } from "../fleet.config.ts";
import { fleetConfig as example } from "../fleet.config.example.ts";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLOUDFLARE_ACTION, SKIPPED_FOLDERS, kindOfJail } from "../lib/fail2ban.ts";
import { IGNOREIP_PATH, buildFail2banIgnoreip } from "../lib/ip-allowlist.ts";
import { CONFIG_PATH, buildLogrotateConfig } from "../lib/logrotate-7g.ts";

type Shape = { [k: string]: Shape | string };
// A list is one value: the owner's may be long and the example's empty.
const shape = (v: unknown, path = ""): string[] =>
  Array.isArray(v)
    ? [`${path}:list`]
    : v !== null && typeof v === "object"
    ? Object.keys(v as Shape).sort().flatMap((k) => shape((v as Shape)[k], path ? `${path}.${k}` : k))
    : [`${path}:${typeof v}`];

let failed = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "pass" : "FAIL"}  ${what}${detail ? `  —  ${detail}` : ""}`);
};

const a = shape(mine), b = shape(example);
const onlyMine = a.filter((k) => !b.includes(k)), onlyExample = b.filter((k) => !a.includes(k));
check(onlyMine.length === 0 && onlyExample.length === 0, "the two config files have the same keys and types", `${a.length} keys; only in fleet.config.ts: [${onlyMine.join(", ")}]; only in the example: [${onlyExample.join(", ")}]`);

// Control: the comparison must be able to fail.
const broken = shape({ ...example, extra: "x" });
check(broken.filter((k) => !a.includes(k)).length === 1, "control: an extra key is noticed");

// The words that name this deployment, taken from its own config: nothing of the owner's is
// written in this test. Words every deployment shares are left out.
const SHARED = new Set(["fleet", "gridpane", "dashboard", "http", "https", "www", "com", "org", "net", "dev", "app", "github", "gitlab", "waf", "refresh"]);
const identity = (c: typeof mine | typeof example) => [c.name, c.shortName, c.wordmark, c.hostname, c.repoUrl, c.wafRefreshLabel, c.server.prefix, c.server.jailPrefix];
const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const ownWords = [...new Set(identity(mine).flatMap(words))].filter((w) => !SHARED.has(w) && !identity(example).flatMap(words).includes(w));
// A long word counts anywhere, even inside another; a short one only when it stands alone.
const leaksIn = (text: string) => ownWords.filter((w) => (w.length >= 4 ? text.toLowerCase().includes(w) : words(text).includes(w)));
const sameAsExample = JSON.stringify(mine) === JSON.stringify(example);
const leaks = leaksIn(JSON.stringify(example));
check(leaks.length === 0, "the example names no owner", sameAsExample ? "this config is the example, so there is no owner to look for" : `${ownWords.length} of this config's own words looked for, ${leaks.length} found`);
check(sameAsExample || leaksIn(JSON.stringify({ ...example, hostname: mine.hostname })).length > 0, "control: the example carrying this config's hostname is noticed");
check(/^#[0-9A-F]{6}$/i.test(example.themeColor.light) && /^#[0-9A-F]{6}$/i.test(mine.themeColor.dark), "theme colors are six-digit hex");
check(!/[/:\s]/.test(mine.hostname) && !/[/:\s]/.test(example.hostname), "hostname is a bare hostname");

// ── Names installed on servers ──────────────────────────────────────────────
const NAME = /^[a-z][a-z0-9]{1,14}$/;
check([mine.server.prefix, mine.server.jailPrefix, example.server.prefix, example.server.jailPrefix].every((p) => NAME.test(p)), "server prefixes are 2 to 15 lowercase letters and digits, starting with a letter, the rule the scripts hold them to", `${mine.server.prefix}, ${mine.server.jailPrefix}; ${example.server.prefix}, ${example.server.jailPrefix}`);
check(!NAME.test("Bad-Prefix") && !NAME.test("a") && !NAME.test("abcdefghijklmnop") && NAME.test("abcdefghijklmno") && !NAME.test("9lives") && !NAME.test("has space"), "control: a prefix with a capital, a hyphen, a space or a leading digit is refused");

const P = mine.server.prefix, J = mine.server.jailPrefix;
check(CLOUDFLARE_ACTION === `${P}-cloudflare` && IGNOREIP_PATH === `/etc/fail2ban/jail.d/${P}-allowlist.local` && CONFIG_PATH === `/etc/logrotate.d/${P}-7g-logs`, "the app builds its three server names from the prefix", `${CLOUDFLARE_ACTION}; ${IGNOREIP_PATH}; ${CONFIG_PATH}`);
check(kindOfJail(`${J}-abc-1a2b-h`) === "h" && kindOfJail(`${J}-abc-1a2b-x`) === "x" && kindOfJail(`not${J}-abc-1a2b-h`) === null && kindOfJail(`${J}x-abc-1a2b-h`) === null && kindOfJail("sshd") === null, "a jail is Fleet's only under the jail prefix", `${J}-abc-1a2b-h`);
const marker = `# Managed by ${mine.name} — `;
check(buildFail2banIgnoreip({ ips: ["203.0.113.9"] }).config.includes(marker) && buildLogrotateConfig({ cadence: "weekly", keep: 4, maxsizeMb: null, compress: true }).includes(marker), "generated files are marked with the product name", marker.trim());
check(Object.keys(SKIPPED_FOLDERS).length === mine.server.skippedFolders.length && mine.server.skippedFolders.every((f) => f.site === f.site.trim() && f.reason.length > 10), "skipped folders come from the config, each with a reason", `${mine.server.skippedFolders.length} in this config, ${example.server.skippedFolders.length} in the example`);

// The server scripts no longer spell these names out: they read them from fleet.config.ts through
// scripts/lib-fleet-names.sh, and the programs they send carry __FLEET_...__ markers the sender
// fills in. So two things must hold, or a name the app looks for and a script never installs would
// show a healthy server as broken: the shell reader reads what the app reads, and each script,
// filled with what the reader read, installs the names the app looks for.
const here = fileURLToPath(new URL(".", import.meta.url));
const readNames = (extra: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ["FLEET_PREFIX", "FLEET_JAIL_PREFIX", "FLEET_NAME", "FLEET_CONFIG_FILE"]) if (!(k in extra)) delete env[k];
  const r = spawnSync("bash", ["-c", '. "$1/lib-fleet-names.sh" && printf \'%s\\n\' "$FLEET_PREFIX" "$FLEET_JAIL_PREFIX" "$FLEET_NAME" "$FLEET_BRAND" "$FLEET_JAIL_SITE_CHARS"', "names", here], { env, encoding: "utf8" });
  const [prefix = "", jailPrefix = "", name = "", brand = "", siteChars = ""] = r.status === 0 ? r.stdout.split("\n") : [];
  return { ok: r.status === 0, prefix, jailPrefix, name, brand, siteChars, said: (r.stderr || "").trim().split("\n")[0] };
};
const shell = readNames();
check(shell.ok && shell.prefix === P && shell.name === mine.name, "the scripts read the same prefix and product name as the app", shell.ok ? `${shell.prefix}; ${shell.name}` : shell.said);
check(shell.ok && shell.jailPrefix === J, "the scripts read the same jail prefix as the app", shell.ok ? shell.jailPrefix : shell.said);
const forced = readNames({ FLEET_JAIL_PREFIX: `${J}x` });
check(forced.ok && forced.jailPrefix !== J && forced.prefix === P, "control: a script given a different jail prefix is noticed", `${forced.jailPrefix} is not ${J}`);
const empty = readNames({ FLEET_CONFIG_FILE: "/nonexistent/fleet.config.ts" });
check(!empty.ok && empty.said.startsWith("ABORT"), "control: with no config to read, the scripts stop instead of using a built-in name", empty.said.slice(0, 60));

const script = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
// A script as it runs: every marker and every shell variable replaced by what the shell reader read.
const filled = (f: string, n = shell) => {
  const values: Record<string, string> = { PREFIX: n.prefix, JAIL_PREFIX: n.jailPrefix, NAME: n.name, BRAND: n.brand, JAIL_SITE_CHARS: n.siteChars, JAIL_UPPER: n.jailPrefix.toUpperCase() };
  return script(f).replace(/__FLEET_([A-Z_]+?)__|\$\{?FLEET_([A-Z_]+)\}?/g, (all, a, b) => values[a ?? b] ?? all);
};
const inStep: [string, string, string][] = [
  ["fleet-fail2ban-apply.remote.sh", `action.d/${CLOUDFLARE_ACTION}.conf`, "the Cloudflare action"],
  ["telemetry-agent.sh", `jail.d/${CLOUDFLARE_ACTION}.local`, "the action name the agent reports on"],
  ["install-operator-allowlist.sh", `CONFIG_PATH="${IGNOREIP_PATH}"`, "the allowlist file"],
  ["install-operator-allowlist.sh", `${marker}operator allowlist.`, "the allowlist marker"],
  ["install-7g-logrotate.sh", `CONFIG_PATH="${CONFIG_PATH}"`, "the logrotate file"],
  ["install-7g-logrotate.sh", `${marker}7G WAF log rotation.`, "the logrotate marker"],
  ["fleet-fail2ban-apply.remote.sh", `printf '${J}-%s-%s'`, "the jail name the apply builds"],
  ["fleet-fail2ban-apply.remote.sh", `rm -f /etc/fail2ban/filter.d/${J}-*.conf`, "the filters an undo removes"],
  ["telemetry-agent.sh", `re.compile(r"^${J}-[a-z0-9]*-[0-9a-f]{4}-[hsx]$")`, "the jails the agent reports as Fleet's"],
  ["telemetry-agent.sh", `return "${J}-%s-%s" %`, "the jail name the agent expects for a site"],
  ["fleet-server-snapshot.remote.sh", `grep -c '^${J}-'`, "the jails a snapshot counts as Fleet's"],
];
const out = inStep.filter(([f, text]) => !filled(f).includes(text));
check(out.length === 0, "the server scripts install what the app looks for", `${inStep.length} names in ${new Set(inStep.map((x) => x[0])).size} scripts${out.length ? "; missing: " + out.map(([f, , what]) => `${what} in ${f}`).join(", ") : ""}`);
check(inStep.filter(([f, text]) => !filled(f, forced).includes(text)).length === 5, "control: scripts filled with a different jail prefix do not match the app", "the 5 jail names stop matching");
check(!filled("install-7g-logrotate.sh").includes(`/etc/logrotate.d/${P}x-7g-logs`), "control: a name spelled differently is not found");

// No script may go back to spelling a jail name out: it would keep working for one owner and
// install the wrong jails for everyone else.
const jailScripts = ["fleet-fail2ban-apply.remote.sh", "telemetry-agent.sh", "fleet-server-snapshot.remote.sh"];
const spelled = (text: string) => (text.match(/(?:filter\.d\/|printf '|return "|\^)[a-z][a-z0-9]{1,15}-(?:%s|\*|base-|\[a-z0-9\])/g) ?? []).filter((m) => !/(?:wordpress|gridpane|nginx)-/.test(m));
const stray = jailScripts.flatMap((f) => spelled(script(f)).map((m) => `${m} in ${f}`));
check(stray.length === 0, "no script spells a jail prefix out", stray.length ? stray.slice(0, 3).join("; ") : `${jailScripts.length} scripts read`);
check(spelled(filled("fleet-fail2ban-apply.remote.sh")).length > 0, "control: a spelled-out jail prefix is noticed");

console.log(failed ? `${failed} failing` : "all passed");
process.exit(failed ? 1 : 0);
