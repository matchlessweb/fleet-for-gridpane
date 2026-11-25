/**
 * Checks for lib/cloudflare-waf.ts.   npm run waf:test
 *
 * Every refusal the ingest relies on is exercised here with a planted defect,
 * because a validator that has never said no proves nothing. Assertions are on
 * values, not on "it ran".
 */
import {
  fleetSection,
  hostProxy,
  maskedValueCount,
  normalizeHost,
  sitesByZone,
  staleness,
  tie,
  unattendedHolds,
  unmaskedLongTokens,
  validateReport,
  zoneNameForHost,
  type ReportZone,
} from "../lib/cloudflare-waf.ts";

let failed = 0;
let ran = 0;
function t(label: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
}

const ZONES = [
  "clinic.example.com",
  "clinic-group.example.com",
  "team.example.com",
  "labs.example.net",
  "labs.example.org",
  "store.example.org",
  "example.co",
];

console.log("zone ↔ site match");
t("apex", zoneNameForHost("team.example.com", ZONES), "team.example.com");
t("www", zoneNameForHost("www.team.example.com", ZONES), "team.example.com");
t("subdomain", zoneNameForHost("promo.team.example.com", ZONES), "team.example.com");
t("staging host", zoneNameForHost("staging.team.example.com", ZONES), "team.example.com");
t("deep subdomain", zoneNameForHost("a.b.shop.store.example.org", ZONES), "store.example.org");
t("scheme, path, port and case are ignored", zoneNameForHost("HTTPS://Shop.Store.Example.org:443/cart?x=1", ZONES), "store.example.org");
t("lookalike pair: the longer name goes to its own zone", zoneNameForHost("clinic-group.example.com", ZONES), "clinic-group.example.com");
t("lookalike pair: the shorter name goes to its own zone", zoneNameForHost("www.clinic.example.com", ZONES), "clinic.example.com");
t("two TLDs of one name stay apart", zoneNameForHost("etch.labs.example.net", ZONES), "labs.example.net");
t("CONTROL a name that merely ends with a zone's letters does not match", zoneNameForHost("notteam.example.com", ZONES), null);
t("CONTROL a zone name used as a prefix does not match", zoneNameForHost("example.co.evil.example", ZONES), null);
t("CONTROL example.com is not in zone example.co", zoneNameForHost("example.com", ZONES), null);
t("CONTROL an unknown site has no zone", zoneNameForHost("unlisted.example.com", ZONES), null);
t("empty input", zoneNameForHost("", ZONES), null);
t("normalizeHost strips a trailing dot", normalizeHost("Example.com."), "example.com");
{
  const { byZone, unmatchedSites } = sitesByZone(
    [
      { id: 1, url: "team.example.com" },
      { id: 2, url: "promo.team.example.com" },
      { id: 3, url: "unlisted.example.com" },
    ],
    ZONES
  );
  t("one zone can hold several sites", byZone.get("team.example.com")?.map((s) => s.id), [2, 1]);
  t("a site with no zone is kept, not dropped", unmatchedSites.map((s) => s.id), [3]);
}

console.log("masking");
const MARK = "<40-char value redacted>";
t("marker is counted", maskedValueCount(`(a eq "${MARK}") or (b eq "${MARK}")`), 2);
t("a clean expression has none", maskedValueCount('(http.user_agent contains "bot")'), 0);
t("a redaction marker is not itself reported as a leak", unmaskedLongTokens(`(x eq "${MARK}")`), []);
t("CONTROL a planted 40-character token is found", unmaskedLongTokens(`(x eq "${"k".repeat(40)}")`).map((s) => s.length), [40]);
t("field names with dots are not tokens", unmaskedLongTokens("cf.verified_bot_category in {} and http.request.uri.path.extension"), []);
t("all-digit runs are ignored", unmaskedLongTokens("12345678901234567890123"), []);

const rule = (over: Record<string, unknown> = {}) => ({
  desc: "Good Bots Allow",
  action: "skip",
  enabled: true,
  role: "skip",
  chars: 15,
  expr: "(cf.client.bot)",
  expr_masked: false,
  clauses: ["(cf.client.bot)"],
  ...over,
});
const zone = (over: Record<string, unknown> = {}) =>
  ({
    zone_id: "000000000000000000000000000000a1",
    plan: "Free Website",
    acct: "Test",
    paused: false,
    nrules: 1,
    ratelimit_rules: 0,
    version: "1",
    updated: "2026-01-01",
    klass: "standard",
    core_fp: "abcd1234",
    order_matches: true,
    findings: [],
    reach: { reach: "proxied", grey: [{ name: "x", type: "A", front: false, cls: "ours", origin: 1 }] },
    rules: [rule()],
    ...over,
  }) as unknown as ReportZone;
const count = (r: unknown, needle: RegExp) => validateReport(r).filter((p) => needle.test(p)).length;

console.log("report validation");
t("a well-formed report passes", validateReport({ "a.example.com": zone() }), []);
t("CONTROL an unmasked long value is refused", count({ "a.example.com": zone({ rules: [rule({ expr: `(x eq "${"S".repeat(32)}")` })] }) }, /unmasked long value/), 1);
t("CONTROL … and so is one hiding only in a clause", count({ "a.example.com": zone({ rules: [rule({ clauses: [`(x eq "${"S".repeat(32)}")`] })] }) }, /unmasked long value/), 1);
{
  const msg = validateReport({ "a.example.com": zone({ rules: [rule({ expr: `(x eq "${"S".repeat(32)}")` })] }) }).join(" ");
  t("the refusal never repeats the value", msg.includes("S".repeat(32)), false);
}
t("CONTROL masked flag true with no marker is refused", count({ "a.example.com": zone({ rules: [rule({ expr_masked: true })] }) }, /expr_masked is true/), 1);
t("CONTROL marker present with flag false is refused", count({ "a.example.com": zone({ rules: [rule({ expr: `(x eq "${MARK}")` })] }) }, /expr_masked is false/), 1);
t("a masked rule with its flag set passes", validateReport({ "a.example.com": zone({ rules: [rule({ expr: `(x eq "${MARK}")`, expr_masked: true })] }) }), []);
t("CONTROL an origin address in reach is refused", count({ "a.example.com": zone({ reach: { reach: "bypass", grey: [{ origin: "198.51.100.7" }] } }) }, /IPv4/), 1);
t("CONTROL nrules disagreeing with the rule list is refused", count({ "a.example.com": zone({ nrules: 5 }) }, /nrules says 5/), 1);
t("CONTROL a duplicated zone id is refused", count({ "a.example.com": zone(), "b.example.com": zone() }, /appears twice/), 1);
t("CONTROL an unknown klass is refused", count({ "a.example.com": zone({ klass: "pristine" }) }, /unknown klass/), 1);
t("CONTROL the page's wrapped shape is not a report", validateReport({ generated: "2026-11-11", zones: {}, counts: {} }).length > 0, true);
t("CONTROL an empty report is refused", count({}, /no zones/), 1);
t("CONTROL an array is refused", validateReport([]).length, 1);

console.log("staleness");
const NOW = new Date("2026-11-11T18:00:00Z");
t("same day", [staleness("2026-11-11T16:22:34Z", NOW).days, staleness("2026-11-11T16:22:34Z", NOW).tone], [0, "ok"]);
t("7 days is still current", staleness("2026-11-04T17:00:00Z", NOW).tone, "ok");
t("8 days warns", [staleness("2026-11-03T17:00:00Z", NOW).tone, staleness("2026-11-03T17:00:00Z", NOW).age], ["warn", "8 days old"]);
t("three weeks is out of date", staleness("2026-10-21T17:00:00Z", NOW).tone, "danger");
t("stale data always carries advice", staleness("2026-10-21T17:00:00Z", NOW).advice !== null, true);
t("fresh data carries none", staleness("2026-11-11T16:22:34Z", NOW).advice, null);

console.log("typography");
t("tie binds only the last two words", tie("Every clause matches the profile."), "Every clause matches the\u00a0profile.");
t("tie leaves a single word alone", tie("None."), "None.");
t("tie does not touch an expression's inner spaces", tie("a b c").split("\u00a0").length, 2);

console.log("fleet sections");
t("findings come first whatever the klass", fleetSection({ klass: "custom", findings: ["x"] }), "findings");
t("own rules with nothing listed", fleetSection({ klass: "custom", findings: [] }), "custom");
t("no rules", fleetSection({ klass: "none", findings: [] }), "none");
t("reordered counts as on standard", fleetSection({ klass: "standard-reordered", findings: [] }), "standard");
t("a variant never lands in the standard section", fleetSection({ klass: "variant", findings: [] }), "findings");

console.log("unattended holds");
{
  const prev = [{ name: "a.example.com", nrules: 5 }, { name: "b.example.com", nrules: 0 }, { name: "c.example.com", nrules: 3 }];
  t("an unchanged fleet is not held", unattendedHolds(prev, prev), []);
  t("a rule count that changes but stays above zero is not held", unattendedHolds(prev, [{ name: "a.example.com", nrules: 4 }, prev[1], prev[2]]), []);
  t("a new zone is not held", unattendedHolds(prev, [...prev, { name: "d.example.com", nrules: 0 }]), []);
  t("a zone that never had rules staying empty is not held", unattendedHolds([prev[1]], [prev[1]]), []);
  t("CONTROL a zone losing every rule is held", unattendedHolds(prev, [{ name: "a.example.com", nrules: 0 }, prev[1], prev[2]]), ["a.example.com had 5 rules and now has none"]);
  t("CONTROL a zone missing from the report is held", unattendedHolds(prev, [prev[0], prev[1]]), ["c.example.com is no longer in the report"]);
}

{
  const z = { name: "ex.example.com", reach: { reach: "proxied", proxied_names: ["ex.example.com", "www.ex.example.com"], grey: [{ name: "shop.ex.example.com", type: "A", front: false, cls: "ours", origin: 1 }] } };
  t("a hostname with a proxied record reads as proxied", hostProxy("https://EX.Example.com/", z).state, "proxied");
  t("CONTROL a DNS-only hostname is never called proxied", hostProxy("shop.ex.example.com", z).state, "dns-only");
  t("CONTROL a hostname in neither list is not called proxied", hostProxy("staging.ex.example.com", z).state, "no-record");
  t("CONTROL an old inventory without the proxied list is not called proxied", hostProxy("ex.example.com", { name: "ex.example.com", reach: { reach: "proxied", grey: [] } }).state, "not-checked");
  t("a DNS-only hostname is still caught on an old inventory", hostProxy("shop.ex.example.com", { name: "ex.example.com", reach: { grey: z.reach.grey } }).state, "dns-only");
  t("CONTROL no zone is not called proxied", hostProxy("ex.example.com", null).state, "no-zone");
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
