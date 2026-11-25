/**
 * Checks for lib/opcache-status.ts.   npm run opcache:test
 * Assertions are on values, and every "this is fine" has a control that must not be.
 */
import {
  findings,
  flagLabel,
  healthyText,
  lifetimeHitRate,
  liveErrorText,
  mbText,
  pctText,
  recentHitRate,
  reportStale,
  rowForSite,
  serverSummary,
  siteCache,
  siteShares,
  sortVersions,
  usage,
  versionMeta,
  type OpcLive,
  type PhpOpcacheRow,
} from "../lib/opcache-status.ts";

let ran = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

const MB = 1024 * 1024;
const NOW = new Date("2026-11-14T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function live(over: Partial<OpcLive> = {}): OpcLive {
  return {
    enabled: true, full: false,
    mem: { used: 200 * MB, free: 300 * MB, wasted: 12 * MB },
    str: { size: 64 * MB, used: 30 * MB, free: 34 * MB, n: 400000 },
    scripts: 6000, keys: 9000, max_keys: 32531, hits: 9_990_000, misses: 10_000,
    oom: 0, hash: 0, manual: 0,
    cfg: { memory_mb: 512, interned_mb: 64, max_files: 20000, validate: 1, reval: 60, max_wasted: 5, jit: "0" },
    php: "8.3.14", start: ago(60 * 24 * 3), last_restart: null,
    by_site: [
      { site: "shop.example", scripts: 4000, bytes: 150 * MB },
      { site: "blog.example", scripts: 1500, bytes: 40 * MB },
      { site: "other", scripts: 500, bytes: 10 * MB },
    ],
    sites_cut: false,
    ...over,
  };
}
function row(over: Partial<PhpOpcacheRow> = {}): PhpOpcacheRow {
  return {
    server_id: 1, php_version: "8.3", reported_at: ago(3), pools: 3,
    sites: ["blog.example", "quiet.example", "shop.example"],
    ini: { enable: 1, memory_mb: 512, interned_mb: 64, max_files: 20000, validate: 1, reval: 60 },
    live: live(), live_error: null, prev: null,
    ...over,
  };
}
const keys = (r: PhpOpcacheRow) => findings(r, NOW).map((f) => `${f.key}:${f.tone}`);

console.log("a healthy cache, and the control for each thing that is not");
const healthy = row();
check("healthy: no findings", keys(healthy), []);
check("healthy: state", versionMeta(healthy, NOW), { tone: "ok", label: "Healthy" });
check("healthy: taken is used plus wasted", Math.round(usage(healthy.live!).takenPct * 10) / 10, 41.4);
check("healthy: sentence", healthyText(healthy, NOW), "Room to spare: 59% of the memory and 72% of the file slots are free.");

console.log("memory");
const full = row({ ini: { ...healthy.ini!, memory_mb: 128, interned_mb: 8 }, live: live({ full: true, mem: { used: 126 * MB, free: 0, wasted: 2 * MB }, cfg: { ...live().cfg, memory_mb: 128, interned_mb: 8 }, str: { size: 8 * MB, used: 4 * MB, free: 4 * MB, n: 1 }, oom: 2 }) });
check("full: danger, and no separate 'ran out before' line", keys(full), ["memory:danger"]);
check("full: state", versionMeta(full, NOW), { tone: "danger", label: "Full" });
check("full, 2 of 3 sites fitted: scaled to all three (126 MB x 3/2 = 189), so 256 MB, and says it is a guess", [findings(full, NOW)[0].commands, /Only 2 of the 3 sites have code in the cache; the rest did not fit\. Raise it to 256 MB, a guess/.test(findings(full, NOW)[0].detail)], [["gp stack php 8.3 -opcache-memory 256"], true]);
const crowded = row({ sites: ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example", "g.example", "h.example", "i.example"], live: live({ full: true, mem: { used: 127 * MB, free: 0, wasted: 1 * MB }, cfg: { ...live().cfg, memory_mb: 128 }, by_site: [{ site: "a.example", scripts: 1700, bytes: 59 * MB }, { site: "b.example", scripts: 1900, bytes: 52 * MB }, { site: "c.example", scripts: 33, bytes: 0.9 * MB }] }), ini: { ...healthy.ini!, memory_mb: 128 } });
check("full with 2 of 9 sites fitted (as on a real server): 127 MB x 9/2 = 572, so 768 MB", findings(crowded, NOW)[0].commands, ["gp stack php 8.3 -opcache-memory 768"]);
const allFit = row({ sites: ["shop.example", "blog.example"], live: live({ full: true, mem: { used: 126 * MB, free: 0, wasted: 2 * MB }, cfg: { ...live().cfg, memory_mb: 128 } }), ini: { ...healthy.ini!, memory_mb: 128 } });
check("full with every site fitted: 60% rule, plain wording (control)", [findings(allFit, NOW)[0].commands, /a guess/.test(findings(allFit, NOW)[0].detail)], [["gp stack php 8.3 -opcache-memory 256"], false]);
check("full: says how often it was emptied", /emptied the cache 2 times/.test(findings(full, NOW)[0].detail), true);
check("full: names every site sharing it", /All 3 sites on PHP 8\.3 are affected/.test(findings(full, NOW)[0].detail), true);
const fullBig = row({ live: live({ full: false, mem: { used: 500 * MB, free: 4 * MB, wasted: 8 * MB } }) });
check("99% taken without the full flag: still danger, scaled for the one site left out (500 MB x 3/2)", findings(fullBig, NOW)[0].commands, ["gp stack php 8.3 -opcache-memory 768"]);
const nearly = row({ live: live({ mem: { used: 440 * MB, free: 62 * MB, wasted: 10 * MB } }) });
check("88% taken: warn, next step up", [keys(nearly), findings(nearly, NOW)[0].commands], [["memory:warn"], ["gp stack php 8.3 -opcache-memory 768"]]);
check("88% taken: state", versionMeta(nearly, NOW), { tone: "warn", label: "Nearly full" });
check("84% taken: nothing (control)", keys(row({ live: live({ mem: { used: 420 * MB, free: 82 * MB, wasted: 10 * MB } }) })), []);
const oomOnly = row({ live: live({ oom: 1 }) });
check("room now, but emptied once before: warn with the command", [keys(oomOnly), findings(oomOnly, NOW)[0].commands], [["oom:warn"], ["gp stack php 8.3 -opcache-memory 768"]]);

console.log("file limit");
const filesFull = row({ live: live({ keys: 30000, max_keys: 32531 }) });
check("92% of slots: danger", keys(filesFull), ["files:danger"]);
check("92% of slots: recommends a limit 1.5 times the files in use", findings(filesFull, NOW)[0].commands, ["gp stack php 8.3 -opcache-max-accel-files 60000"]);
check("78% of slots: warn", keys(row({ live: live({ keys: 25400, max_keys: 32531 }) })), ["files:warn"]);
check("74% of slots: nothing (control)", keys(row({ live: live({ keys: 24000, max_keys: 32531 }) })), []);
check("slots ran out before: warn", keys(row({ live: live({ hash: 3 }) })), ["hash:warn"]);

console.log("text buffer");
const strFull = row({ live: live({ str: { size: 8 * MB, used: 8 * MB - 1000, free: 1000, n: 1 }, cfg: { ...live().cfg, interned_mb: 8 } }), ini: { ...healthy.ini!, interned_mb: 8 } });
check("full: danger", keys(strFull), ["interned:danger"]);
check("full: the hand edit, then a reload that changes nothing else", findings(strFull, NOW)[0].commands, [
  'grep -n "interned_strings_buffer" /etc/php/8.3/fpm/php.ini',
  "sed -i 's/^opcache.interned_strings_buffer=.*/opcache.interned_strings_buffer=16/' /etc/php/8.3/fpm/php.ini",
  "gp stack php 8.3 -opcache-memory 512   # same value as now: this reloads PHP 8.3",
]);
check("88%: warn", keys(row({ live: live({ str: { size: 64 * MB, used: 56.5 * MB, free: 7.5 * MB, n: 1 } }) })), ["interned:warn"]);
check("80%: nothing (control)", keys(row({ live: live({ str: { size: 64 * MB, used: 51 * MB, free: 13 * MB, n: 1 } }) })), []);

console.log("wasted space, staging, settings that disagree");
check("20% wasted: warn", keys(row({ live: live({ mem: { used: 200 * MB, free: 210 * MB, wasted: 102 * MB } }) })), ["wasted:warn"]);
check("10% wasted: nothing (control)", keys(row({ live: live({ mem: { used: 200 * MB, free: 261 * MB, wasted: 51 * MB } }) })), []);
const stagingBy = [{ site: "shop.example", scripts: 4000, bytes: 150 * MB }, { site: "staging.shop.example", scripts: 4000, bytes: 150 * MB }];
const staging = row({ sites: ["shop.example", "staging.shop.example"], live: live({ mem: { used: 380 * MB, free: 122 * MB, wasted: 10 * MB }, by_site: stagingBy }) });
check("staging holds half of a 76% full cache: warn, named", [keys(staging), /staging\.shop\.example holds 50%/.test(findings(staging, NOW)[0].detail)], [["staging:warn"], true]);
check("staging holds half of a 41% full cache: nothing (control)", keys(row({ sites: ["shop.example", "staging.shop.example"], live: live({ by_site: stagingBy }) })), []);
const disagree = row({ ini: { ...healthy.ini!, memory_mb: 1024 } });
check("file says 1024 MB, PHP runs 512 MB: warn", [keys(disagree), /memory 1024 MB in the file, 512 MB running/.test(findings(disagree, NOW)[0].detail)], [["not-reloaded:warn"], true]);

console.log("hit rate");
check("lifetime 99.9%", Math.round((lifetimeHitRate(live()) ?? 0) * 10) / 10, 99.9);
check("no requests yet: no rate, not 0%", lifetimeHitRate(live({ hits: 0, misses: 0 })), null);
const slow = row({ prev: { hits: 9_988_000, misses: 9_000, at: ago(13) } });
check("last 10 minutes: 2,000 hits and 1,000 misses is 67%", recentHitRate(slow) && { rate: Math.round(recentHitRate(slow)!.rate), requests: recentHitRate(slow)!.requests, minutes: recentHitRate(slow)!.minutes }, { rate: 67, requests: 3000, minutes: 10 });
check("67% recently: warn, even with a 99.9% lifetime rate", keys(slow), ["hit-rate:warn"]);
check("99.5% recently: nothing (control)", keys(row({ prev: { hits: 9_980_050, misses: 9_950, at: ago(13) } })), []);
check("too few requests to judge: no rate", recentHitRate(row({ prev: { hits: 9_989_900, misses: 9_950, at: ago(13) } })), null);
check("counters went backwards (PHP restarted): no rate", recentHitRate(row({ prev: { hits: 99_999_999, misses: 1, at: ago(13) } })), null);
const fresh = row({ live: live({ start: ago(8), hits: 800, misses: 700 }), prev: { hits: 100, misses: 100, at: ago(13) } });
check("PHP reloaded 8 minutes ago: a poor hit rate is not a finding", keys(fresh), []);
check("PHP reloaded 8 minutes ago: state and sentence", [versionMeta(fresh, NOW), healthyText(fresh, NOW)], [{ tone: "neutral", label: "Settling" }, "PHP 8.3 reloaded 8 minutes ago, so the cache is still filling and the hit rate means little yet."]);
check("PHP reloaded 8 minutes ago and already full: still danger", versionMeta(row({ live: live({ start: ago(8), full: true }) }), NOW), { tone: "danger", label: "Full" });
check("poor lifetime rate with no earlier report: warn", keys(row({ live: live({ hits: 70_000, misses: 30_000 }) })), ["hit-rate:warn"]);

console.log("when the live numbers are missing");
const blocked = row({ live: null, live_error: "blocked: Unable to open primary script (Operation not permitted)" });
check("blocked: warn, 'Cannot see', never healthy", [keys(blocked), versionMeta(blocked, NOW)], [["unseen:warn"], { tone: "warn", label: "Cannot see" }]);
check("blocked: the server's own reason is passed on", /Unable to open primary script/.test(liveErrorText(blocked.live_error)), true);
check("cache off: danger", [keys(row({ live: null, live_error: "off" })), versionMeta(row({ live: null, live_error: "off" }), NOW)], [["off:danger"], { tone: "danger", label: "Off" }]);
check("answered but disabled: danger", keys(row({ live: live({ enabled: false }) })), ["off:danger"]);
const unused = row({ live: null, live_error: "no_pool", sites: [], pools: 0 });
check("a PHP version no site runs on: no finding, 'Not in use'", [keys(unused), versionMeta(unused, NOW)], [[], { tone: "neutral", label: "Not in use" }]);
check("an unknown reason still reads as a sentence", liveErrorText("something new"), "The live numbers could not be read.");

console.log("sites sharing a cache");
const shares = siteShares(healthy);
check("largest first, with a pool-only site at zero", shares.map((s) => [s.site, Math.round(s.sharePct), s.hasPool]), [["shop.example", 75, true], ["blog.example", 20, true], ["other", 5, false], ["quiet.example", 0, true]]);
check("shares add up to 100", Math.round(shares.reduce((a, s) => a + s.sharePct, 0)), 100);
const shop = siteCache([unused, healthy], "Shop.Example ")!;
check("site line", [shop.headline, shop.detail], ["Shares a 512 MB cache with 2 other sites on PHP 8.3, 41% full", "This site's code holds 150 MB of it (75% of the cached code, 4,000 files)."]);
check("site with nothing cached says so", siteCache([healthy], "quiet.example")!.detail, "None of this site's code is in the cache right now: it has had no PHP requests since PHP last started.");
check("site left out of a full cache: says what that costs", siteCache([crowded], "i.example")!.detail, "The cache is full and none of this site's code is in it, so its PHP is compiled again on every request.");
const stock = row({ php_version: "8.2", pools: 3, sites: [], live: live({ mem: { used: 15 * MB, free: 113 * MB, wasted: 0 }, hits: 5, misses: 900, by_site: [{ site: "abc123.gridpanevps.com", scripts: 283, bytes: 6.5 * MB }, { site: "other", scripts: 3, bytes: 1000 }] }) });
check("GridPane's own pools only (phpMyAdmin): 'Not in use', no findings, even with a poor hit rate", [versionMeta(stock, NOW), findings(stock, NOW).length, healthyText(stock, NOW)], [{ tone: "neutral", label: "Not in use" }, 0, "No site runs on this PHP version. GridPane keeps it running for its own tools."]);
check("a real site's code in a version with no pool listed: in use (control)", versionMeta(row({ sites: [], live: live({ hits: 70_000, misses: 30_000 }) }), NOW).label, "Worth a look");
check("alone on its PHP version", siteCache([row({ sites: ["shop.example"] })], "shop.example")!.headline, "Shares a 512 MB cache with no other site on PHP 8.3, 41% full");
check("live numbers missing: the size comes from the settings file", siteCache([blocked], "shop.example")!.headline, "Shares a 512 MB cache with 2 other sites on PHP 8.3");
check("a site the report does not list: no line (control)", siteCache([healthy], "elsewhere.example"), null);
check("found by cached code when it has no pool listed", rowForSite([row({ sites: [] })], "blog.example")?.php_version, "8.3");

console.log("server at a glance, order, staleness, words");
const old = row({ php_version: "7.4", live: null, live_error: "no_pool", sites: [], pools: 0 });
const set = [healthy, { ...full, php_version: "8.1" }, { ...nearly, php_version: "8.2" }, old];
check("summary counts", (({ versions, inUse, danger, warn, tone }) => ({ versions, inUse, danger, warn, tone }))(serverSummary(set, NOW)), { versions: 4, inUse: 3, danger: 1, warn: 1, tone: "danger" });
check("summary names the versions", serverSummary(set, NOW).text, "PHP 8.1 full, PHP 8.2 nearly full.");
check("summary words for a version that cannot be read", serverSummary([blocked], NOW).text, "PHP 8.3 not readable.");
const both = row({ live: live({ full: true, mem: { used: 126 * MB, free: 0, wasted: 2 * MB }, cfg: { ...live().cfg, memory_mb: 128, interned_mb: 8 }, str: { size: 8 * MB, used: 8 * MB - 1000, free: 1000, n: 1 } }), ini: { ...healthy.ini!, memory_mb: 128, interned_mb: 8 } });
check("memory and text buffer both full: the reload line is the memory change, not the old value", findings(both, NOW).find((f) => f.key === "interned")!.commands![2], "gp stack php 8.3 -opcache-memory 256   # the memory change above: it also reloads PHP 8.3");
check("all fine", [serverSummary([healthy, old], NOW).tone, serverSummary([healthy, old], NOW).text], ["ok", "The one PHP version in use has room in the code cache."]);
check("nothing reported is not 'ok'", serverSummary([], NOW).tone, "neutral");
check("order: full, nearly full, healthy, unused", sortVersions(set, NOW).map((r) => r.php_version), ["8.1", "8.2", "8.3", "7.4"]);
check("newest PHP first among equals", sortVersions([{ ...healthy, php_version: "8.2" }, { ...healthy, php_version: "8.10" }, { ...healthy, php_version: "8.4" }], NOW).map((r) => r.php_version), ["8.10", "8.4", "8.2"]);
check("list flags are three words at most", ["Full", "Nearly full", "Off", "Cannot see", "Needs a change", "Worth a look"].map((label) => flagLabel({ tone: "warn", label })), ["Cache full", "Cache nearly full", "Cache off", "Cache not readable", "Cache limit reached", "Check code cache"]);
check("a report 25 minutes old is stale; 15 is not", [reportStale(ago(25), NOW), reportStale(ago(15), NOW), reportStale(null, NOW)], [true, false, true]);
check("sizes", [mbText(133_169_152), mbText(0.4 * MB), mbText(0)], ["127 MB", "0.4 MB", "0 MB"]);
check("percentages never round a nearly-full cache to 100 or a trace to 0", [pctText(99.6), pctText(0.2), pctText(100), pctText(0), pctText(41.4)], ["over 99%", "under 1%", "100%", "0%", "41%"]);

console.log(`\n${failed === 0 ? `${ran} checks passed` : `${failed} of ${ran} checks FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
