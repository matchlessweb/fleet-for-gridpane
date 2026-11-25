/**
 * Checks for lib/fail2ban.ts.   npm run f2b:test
 *
 * Each status is reached with a planted fact, and "working" is shown to turn
 * into something else when any one check is broken: a status function that has
 * never said "broken" proves nothing. Addresses are documentation ranges only.
 */
import { fleetConfig } from "../fleet.config.ts";
import {
  banEnds,
  CLOUDFLARE_ACTION,
  SKIPPED_FOLDERS,
  serverSummary,
  siteStatus,
  untilText,
  ageText,
  zoneForHost,
  type F2bJail,
  type ServerF2bRow,
  type SiteF2bRow,
} from "../lib/fail2ban.ts";

// Jail names carry the configured prefix: `<jailPrefix>-<site>-<four hex>-<kind>`.
const JP = fleetConfig.server.jailPrefix;

let failed = 0;
let ran = 0;
function t(label: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
}

// The leftover-folder skip list comes from fleet.config.ts, which differs from one deployment to the next.
// Register one here so this test does not depend on whose config it runs with.
SKIPPED_FOLDERS["lapsed.example.org"] = "A lapsed domain's leftover folder (test fixture).";

const NOW = new Date("2026-11-13T18:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const Z1 = "000000000000000000000000000000a1";
const Z2 = "000000000000000000000000000000b2";
const ZONES = [
  { zone_id: Z1, name: "example.com" },
  { zone_id: Z2, name: "academy.example.net" },
  { zone_id: "a".repeat(32), name: "safety.example.org" },
];

const jail = (kind: "h" | "s" | "x", over: Partial<F2bJail> = {}): F2bJail => ({
  name: `${JP}-examplecom-abcd-${kind}`,
  kind,
  configured: true,
  running: true,
  cfzone: Z1,
  actions: [CLOUDFLARE_ACTION, "iptables-allports"],
  reads_auth_log: true,
  failed_now: 0,
  failed_total: 0,
  banned_now: 0,
  banned_total: 0,
  ...over,
});
const site = (over: Partial<SiteF2bRow> = {}): SiteF2bRow => ({
  server_id: 1,
  site: "example.com",
  reported_at: ago(4),
  plugin: "mu",
  mu_plugin: "ok",
  plugin_dir: true,
  configs: true,
  included: true,
  jails: [jail("h"), jail("s"), jail("x")],
  bans: [],
  log_lines: [],
  log_24h: 0,
  ...over,
});
const server = (over: Partial<ServerF2bRow> = {}): ServerF2bRow => ({
  server_id: 1,
  reported_at: ago(4),
  fail2ban_present: true,
  fail2ban_running: true,
  fail2ban_version: "0.11.2",
  token_file_present: true,
  gpcloudflare_conf: false,
  auth_log_readable: true,
  server_jails: [
    { name: "wordpress-hard", running: true, actions: ["iptables-allports"], reads_auth_log: true, failed_now: 0, failed_total: 0, banned_now: 0, banned_total: 0, bans: [] },
  ],
  orphan_jails: [],
  ...over,
});
const key = (s: SiteF2bRow | null, v: ServerF2bRow | null = server(), at = NOW) => siteStatus(s, v, ZONES, at).key;
const failedChecks = (s: SiteF2bRow, v: ServerF2bRow = server()) =>
  siteStatus(s, v, ZONES, NOW).checks.filter((c) => c.state === "fail").map((c) => c.key);

console.log("working, and each way it stops being working:");
t("every check passes -> working", key(site()), "working");
t("working names its zone", siteStatus(site(), server(), ZONES, NOW).zone?.name, "example.com");
t("a quiet site (plugin on, nothing in the log) is still working", key(site({ log_24h: 0, log_lines: [] })), "working");
t("installed as an ordinary plugin is still working", key(site({ plugin: "plugin", mu_plugin: "absent" })), "working");
t("plugin off, jails fine -> plugin off (jails waiting)", key(site({ plugin: "off", mu_plugin: "absent", configs: false })), "plugin-off");
t("plugin off does not count the include as failed", failedChecks(site({ plugin: "off", configs: false, included: true })), []);
t("plugin link dangling -> broken, plugin named", failedChecks(site({ plugin: "broken", mu_plugin: "dangling" })), ["plugin"]);
t("include line missing -> broken, include named", failedChecks(site({ included: false })), ["include"]);
t("settings file missing while on -> broken", key(site({ configs: false })), "broken");
t("one jail not running -> broken, jails named", failedChecks(site({ jails: [jail("h"), jail("s", { running: false, actions: [], reads_auth_log: false }), jail("x")] })), ["jails"]);
t("one jail missing -> broken", failedChecks(site({ jails: [jail("h"), jail("x")] })), ["jails"]);
t("Cloudflare action missing on one jail -> broken, actions named", failedChecks(site({ jails: [jail("h"), jail("s", { actions: ["iptables-allports"] }), jail("x")] })), ["actions"]);
t("local firewall action missing -> broken", failedChecks(site({ jails: [jail("h", { actions: [CLOUDFLARE_ACTION] }), jail("s"), jail("x")] })), ["actions"]);
t("a jail reading the journal instead of auth.log -> broken, logpath named", failedChecks(site({ jails: [jail("h"), jail("s"), jail("x", { reads_auth_log: false })] })), ["logpath"]);
t("auth.log unreadable on the server -> broken", failedChecks(site(), server({ auth_log_readable: false })), ["logpath"]);
t("token file missing -> broken, token named", failedChecks(site(), server({ token_file_present: false })), ["token"]);
t("jails ban in a zone the inventory does not list -> broken, zone named", failedChecks(site({ jails: [jail("h", { cfzone: "9".repeat(32) }), jail("s", { cfzone: "9".repeat(32) }), jail("x", { cfzone: "9".repeat(32) })] })), ["zone"]);
t("jails ban in a zone that does not cover the hostname -> broken", failedChecks(site({ jails: [jail("h", { cfzone: Z2 }), jail("s", { cfzone: Z2 }), jail("x", { cfzone: Z2 })] })), ["zone"]);
t("jails split across two zones -> broken", failedChecks(site({ jails: [jail("h"), jail("s", { cfzone: Z2 }), jail("x")] })), ["zone"]);
t("Fail2Ban not running -> broken", key(site(), server({ fail2ban_running: false })), "broken");
t("broken says which check failed, in words", siteStatus(site(), server({ token_file_present: false }), ZONES, NOW).reason.startsWith("Server's Cloudflare token file exists: The token file is missing"), true);
t("two failures are counted in the reason", /\(2 checks failed\)$/.test(siteStatus(site({ included: false }), server({ token_file_present: false }), ZONES, NOW).reason), true);

console.log("zones:");
t("a subdomain in its parent's zone is working (training.academy.example.net)", key(site({ site: "training.academy.example.net", jails: [jail("h", { cfzone: Z2 }), jail("s", { cfzone: Z2 }), jail("x", { cfzone: Z2 })] })), "working");
t("no jails of its own -> local firewall only", key(site({ site: "staging.safety.example.org", jails: [] })), "local-only");
t("local-only does not claim a zone, even when the name looks like one", siteStatus(site({ site: "staging.safety.example.org", jails: [] }), server(), ZONES, NOW).zone, null);
t("local-only says the name falls inside a zone no jail bans in", siteStatus(site({ site: "staging.safety.example.org", jails: [] }), server(), ZONES, NOW).checks.find((c) => c.key === "zone")?.detail.includes("falls inside the zone safety.example.org"), true);
t("local-only has no failed checks", failedChecks(site({ site: "staging.safety.example.org", jails: [] })), []);
t("lookalike is not a suffix match", zoneForHost(`not${ZONES[0].name}`, ZONES), null);
t("www. is the same site", zoneForHost("www.example.com", ZONES)?.name, "example.com");

console.log("not reported:");
t("no row at all -> not reported", key(null), "not-reported");
t("no server row -> not reported", key(site(), null), "not-reported");
t("19 minutes old is still trusted", key(site({ reported_at: ago(19) })), "working");
t("21 minutes old -> not reported, not green", key(site({ reported_at: ago(21) })), "not-reported");
t("the same healthy row goes stale as the clock moves", key(site(), server(), new Date(NOW.getTime() + 30 * 60_000)), "not-reported");
t("a stale broken site is not reported, not broken", key(site({ reported_at: ago(90), included: false })), "not-reported");

console.log("server summary:");
const rows = [
  site({ site: "a-working.example.com" }),
  site({ site: "b-banned.example.com", bans: [{ ip: "203.0.113.45", jail: `${JP}-examplecom-abcd-h`, at: ago(2), until: null }] }),
  site({ site: "c-broken.example.com", included: false }),
  site({ site: "d-off.example.com", plugin: "off", configs: false }),
  site({ site: "staging.safety.example.org", jails: [] }),
  site({ site: "lapsed.example.org", plugin: "off", configs: false, jails: [] }),
];
const sum = serverSummary(rows, server({ server_jails: [{ name: "wordpress-hard", running: true, actions: [], reads_auth_log: true, failed_now: 0, failed_total: 0, banned_now: 1, banned_total: 1, bans: [{ ip: "198.51.100.20", jail: "wordpress-hard", at: null, until: null }] }] }), ZONES, NOW);
t("the leftover folder is skipped, not counted", [sum.total, sum.skipped.map((s) => s.site)], [5, ["lapsed.example.org"]]);
t("sites with active blocks first, then trouble, then the rest", sum.entries.map((e) => e.row.site), ["b-banned.example.com", "c-broken.example.com", "d-off.example.com", "staging.safety.example.org", "a-working.example.com"]);
t("working / total", [sum.working, sum.total], [2, 5]);
t("counts by status", sum.counts, { working: 2, "plugin-off": 1, "local-only": 1, broken: 1, "not-reported": 0 });
t("a GridPane jail's ban is the server's, never a site's", [sum.activeBlocks, sum.serverBlocks], [1, 1]);
const old = serverSummary(rows.map((r) => ({ ...r, reported_at: ago(45) })), server({ reported_at: ago(45) }), ZONES, NOW);
t("a silent server: every site not reported, no blocks claimed", [old.counts["not-reported"], old.working, old.activeBlocks, old.stale], [5, 0, 0, true]);

console.log("bans and words:");
t("the server's own end time wins", banEnds({ ip: "203.0.113.45", jail: `${JP}-examplecom-abcd-h`, at: ago(2), until: "2026-11-13T18:08:00Z" }), { iso: "2026-11-13T18:08:00Z", source: "server" });
t("hard = 10 minutes from the start", banEnds({ ip: "203.0.113.45", jail: `${JP}-examplecom-abcd-h`, at: "2026-11-13T17:58:00Z", until: null }).iso, "2026-11-13T18:08:00.000Z");
t("soft = 1 hour", banEnds({ ip: "203.0.113.45", jail: `${JP}-examplecom-abcd-s`, at: "2026-11-13T17:58:00Z", until: null }).iso, "2026-11-13T18:58:00.000Z");
t("extra = 24 hours", banEnds({ ip: "203.0.113.45", jail: `${JP}-examplecom-abcd-x`, at: "2026-11-13T17:58:00Z", until: null }).iso, "2026-11-14T17:58:00.000Z");
t("no start time -> unknown, never guessed", banEnds({ ip: "203.0.113.45", jail: `${JP}-examplecom-abcd-h`, at: null, until: null }), { iso: null, source: "unknown" });
t("a GridPane jail's length is not guessed", banEnds({ ip: "198.51.100.20", jail: "wordpress-hard", at: ago(2), until: null }).source, "unknown");
t("until, in words", [untilText("2026-11-13T18:06:00Z", NOW), untilText("2026-11-13T20:00:00Z", NOW), untilText("2026-11-13T17:59:00Z", NOW)], ["in 6 minutes", "in 2 hours", "any moment"]);
t("age, in words", [ageText(ago(0), NOW), ageText(ago(1), NOW), ageText(ago(125), NOW)], ["just now", "1 minute ago", "2 hours ago"]);

console.log(`\n${ran - failed}/${ran} passed`);
if (failed > 0) process.exit(1);
