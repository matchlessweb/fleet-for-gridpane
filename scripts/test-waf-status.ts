/**
 * Checks for lib/waf-status.ts.   npm run wafstatus:test
 * Assertions are on values, and every "this is fine" has a control that must not be.
 */
import {
  dayCount,
  eightDayText,
  eightGapText,
  eightGMeta,
  matchesFilter,
  needsAttention,
  posture,
  reportStale,
  ruleName,
  rulesetsSwitchedOff,
  sampleKind,
  sevenDayText,
  sevenGMeta,
  sortForList,
  summaryText,
  wafSummary,
  type SiteWafRow,
} from "../lib/waf-status.ts";

let failed = 0;
let ran = 0;
function t(label: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
}

const ON = { "bad-bots": "on", "bad-methods": "on", "bad-query-string": "on", "bad-referer": "on", "bad-remote-host": "off", "bad-request": "on" };
const row = (over: Partial<SiteWafRow> = {}): SiteWafRow => ({
  server_id: 1, site: "a.example", reported_at: "2026-11-14T12:00:00Z", waf: "7G", rulesets: ON,
  g8_mode: "none", g8_loaded: false, g8_version: null, g8_log_bytes: null, g8_log_at: null, g7_day: null, g8_day: null, ...over,
});
const day8 = (total: number, already = 0, complete = true) => ({ total, already, complete, rules: [] });

console.log("7G");
t("GridPane's default-off ruleset is not a switched-off ruleset", rulesetsSwitchedOff(row()), []);
t("CONTROL a ruleset a person switched off is listed", rulesetsSwitchedOff(row({ rulesets: { ...ON, "bad-request": "off", "bad-bots": "off" } })), ["bad-bots", "bad-request"]);
t("7G with its defaults reads On", sevenGMeta(row()).label, "On");
t("CONTROL 7G with a ruleset off reads weakened and names it", [sevenGMeta(row({ rulesets: { ...ON, "bad-request": "off" } })).label, sevenGMeta(row({ rulesets: { ...ON, "bad-request": "off" } })).detail.startsWith("Bad request is switched off")], ["On, weakened", true]);
t("CONTROL the firewall switched off reads Off, in danger", [sevenGMeta(row({ waf: "off" })).label, sevenGMeta(row({ waf: "off" })).tone], ["Off", "danger"]);
t("CONTROL no setting at all is not called on", sevenGMeta(row({ waf: null })).label, "Off");
t("another firewall setting is named, not called 7G", sevenGMeta(row({ waf: "modsec" })).label, "modsec");

console.log("8G");
t("no files reads Not installed", eightGMeta(row()).label, "Not installed");
t("the watch file with rules loaded reads Observing", [eightGMeta(row({ g8_mode: "observe", g8_loaded: true })).label, eightGMeta(row({ g8_mode: "observe", g8_loaded: true })).tone], ["Observing", "ok"]);
t("CONTROL observing with no rules loaded is not called Observing", eightGMeta(row({ g8_mode: "observe", g8_loaded: false })).tone, "danger");
t("files with nothing using them read idle", eightGMeta(row({ g8_mode: "installed", g8_loaded: true })).label, "Installed, idle");
t("CONTROL a mode this app does not know is not guessed at", [eightGMeta(row({ g8_mode: "shadow" })).mode, eightGMeta(row({ g8_mode: "shadow" })).tone], [null, "warn"]);

console.log("posture");
t("7G alone", posture(row()).key, "7g");
t("7G with 8G observing", posture(row({ g8_mode: "observe", g8_loaded: true })).label, "7G, with 8G observing");
t("8G alone", posture(row({ waf: "off", g8_mode: "enforce", g8_loaded: true })).key, "8g-only");
t("both blocking is flagged", [posture(row({ g8_mode: "enforce", g8_loaded: true })).key, posture(row({ g8_mode: "enforce", g8_loaded: true })).tone], ["both", "warn"]);
t("CONTROL 7G off with 8G only observing is no firewall", posture(row({ waf: "off", g8_mode: "observe", g8_loaded: true })).key, "none");
t("CONTROL 7G off with 8G enforcing but no rules loaded is no firewall", posture(row({ waf: "off", g8_mode: "enforce", g8_loaded: false })).key, "none");

console.log("rule names");
t("an 8G bot rule", ruleName("bad_bot_7"), { family: "Bad bot", id: "7" });
t("7G and 8G spell the query string rule differently; both are named", [ruleName("bad_query_string_4").family, ruleName("bad_querystring_12").family], ["Bad query string", "Bad query string"]);
t("an unknown rule keeps its raw name", ruleName("something_new_3"), { family: "something_new_3", id: null });
t("samples are labeled by what they are", [sampleKind("bad_bot_7"), sampleKind("bad_request_31"), sampleKind("bad_cookie_1")], ["User agents", "Paths", null]);

console.log("the last 24 hours");
t("a whole day is a plain number", dayCount({ total: 6567, complete: true }), "6,567");
t("CONTROL a day cut short says at least", dayCount({ total: 6567, complete: false }), "at least 6,567");
t("observing: would have blocked", eightDayText(day8(12), "observe"), "8G would have blocked 12 requests in the last 24 hours.");
t("one request is singular", eightDayText(day8(1), "observe"), "8G would have blocked 1 request in the last 24 hours.");
t("CONTROL blocking mode does not say would have", eightDayText(day8(12), "enforce"), "8G matched 12 requests in the last 24 hours.");
t("no log while observing says so", eightDayText(null, "observe"), "8G is observing, but it has not written a log yet.");
t("all got through", eightGapText(day8(12, 0)), "All 12 got through: 7G refused none of them.");
t("some refused anyway", eightGapText(day8(12, 3)), "9 got through; 3 were refused anyway, by 7G or the site.");
t("all refused anyway", eightGapText(day8(2, 2)), "All 2 were refused anyway, by 7G or the site.");
t("nothing flagged says nothing more", eightGapText(day8(0)), null);
t("7G blocks", sevenDayText({ total: 145, complete: true, rules: [] }), "7G blocked 145 requests in the last 24 hours.");
t("no 7G log is not zero", sevenDayText(null), "No 7G log on the server for this site.");

console.log("summary, filters, order");
{
  const rows = [
    row({ site: "plain.example" }),
    row({ site: "watch.example", g8_mode: "observe", g8_loaded: true, g8_day: day8(40, 0, false), g7_day: { total: 5, complete: true, rules: [] } }),
    row({ site: "busy.example", g8_mode: "observe", g8_loaded: true, g8_day: day8(900) }),
    row({ site: "weak.example", rulesets: { ...ON, "bad-request": "off" } }),
    row({ site: "open.example", waf: "off" }),
    row({ site: "idle.example", g8_mode: "installed", g8_loaded: true }),
  ];
  const s = wafSummary(rows);
  t("counts", [s.sites, s.sevenOn, s.weakened, s.noFirewall, s.observing, s.enforcing, s.idle, s.wouldBlock, s.blocked7], [6, 5, 1, 1, 2, 0, 1, 940, 5]);
  t("CONTROL one cut-short day makes the total incomplete", s.wouldBlockComplete, false);
  t("summary sentence", summaryText(s), "5 of 6 sites on 7G, 2 with 8G observing, 1 with 8G installed but idle.");
  t("observing filter", rows.filter((r) => matchesFilter(r, "observing")).map((r) => r.site), ["watch.example", "busy.example"]);
  t("weakened filter", rows.filter((r) => matchesFilter(r, "weakened")).map((r) => r.site), ["weak.example"]);
  t("attention: weakened, no firewall and idle; not the healthy ones", rows.filter(needsAttention).map((r) => r.site), ["weak.example", "open.example", "idle.example"]);
  t("order: attention first, then most 8G activity, then name", sortForList(rows).map((r) => r.site), ["idle.example", "open.example", "weak.example", "busy.example", "watch.example", "plain.example"]);
}
t("a report 5 minutes old is fresh", reportStale("2026-11-14T12:00:00Z", new Date("2026-11-14T12:05:00Z")), false);
t("CONTROL a report 25 minutes old is stale", reportStale("2026-11-14T12:00:00Z", new Date("2026-11-14T12:25:00Z")), true);
t("CONTROL no report is stale", reportStale(null, new Date()), true);

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
